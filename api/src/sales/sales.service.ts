import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectModel, InjectConnection } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { Sale, SaleDocument } from './schemas/sale.schema';
import {
  SaleOperation,
  SaleOperationDocument,
} from './schemas/sale-operation.schema';
import { CreateSaleDto } from './dto/create-sale.dto';
import { SALE_ERROR_CODES } from './sale-error-codes';
import {
  NormalizedSaleInput,
  computeSaleRequestHash,
  isSaleOperationDuplicateKeyError,
  normalizeCreateSale,
  resolveOccurredAt,
} from './sale-idempotency';
import { UpdateSaleDto } from './dto/update-sale.dto';
import { ProductsService } from '../products/products.service';
import { EventsGateway } from '../events/events.gateway';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { subscriptionInactiveException } from '../subscriptions/subscription-access';
import { PushOutboxService } from '../push/push-outbox.service';
import { stockAlertFor } from '../products/stock-level';
import {
  decodeSalesHistoryCursor,
  encodeSalesHistoryCursor,
} from './sale-history';
import {
  ProductBatchesService,
  type BatchCreditResult,
  type BatchEntry,
  type BatchSaleResult,
  type BatchStockChange,
  type SaleBatchSnapshot,
} from '../products/batches/product-batches.service';
import { batchError } from '../products/batches/product-batch-errors';
import { businessDate } from '../products/batches/business-date';
import { CancelSaleDto } from '../products/batches/dto/product-batch.dto';
import {
  SaleRegularizationRequest,
  SaleRegularizationRequestDocument,
  SaleRegularizationStatus,
} from './schemas/sale-regularization-request.schema';
import { SALE_REGULARIZATION_REQUEST_INDEX_KEY } from './schemas/sale-regularization-request.schema';

/** Approbation d'une demande de régularisation (dans la transaction). */
interface RegularizationApproval {
  requestId: Types.ObjectId;
  approverId: string;
  reason: string;
  receivedAt: Date;
}

function isRequestDuplicateKeyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, keyPattern } = error as {
    code?: unknown;
    keyPattern?: unknown;
  };
  if (code !== 11000 || typeof keyPattern !== 'object' || !keyPattern) {
    return false;
  }
  const actual = Object.keys(keyPattern);
  const expected = Object.keys(SALE_REGULARIZATION_REQUEST_INDEX_KEY);
  return (
    actual.length === expected.length &&
    expected.every((key, i) => actual[i] === key)
  );
}
import type { ProductDocument } from '../products/schemas/product.schema';

type MongooseSession = Awaited<ReturnType<Connection['startSession']>>;

interface RestitutionLog {
  batchId: Types.ObjectId;
  reference: string;
  quantity: number;
  historical: boolean;
}

function sumOf(entries: readonly { quantity: number }[]): number {
  return entries.reduce((s, e) => s + e.quantity, 0);
}

/** Somme des lots = quantité vendue, exactement (400 sinon). */
function assertAllocationSum(
  entries: readonly BatchEntry[],
  quantity: number,
): void {
  if (sumOf(entries) !== quantity) {
    throw new BadRequestException(
      batchError(
        'BATCH_ALLOCATION_MISMATCH',
        'La somme des lots doit être exactement égale à la quantité vendue.',
      ),
    );
  }
}

function assertRestitutionReason(reason: string | undefined): void {
  if (!reason || reason.trim().length < 3) {
    throw new BadRequestException(
      batchError(
        'SALE_BATCH_RESTITUTION_REQUIRED',
        'Indiquez le motif de la restitution.',
      ),
    );
  }
}

function hasBatchCorrectionFields(dto: UpdateSaleDto): boolean {
  return Boolean(
    dto.batchReturns?.length ||
    dto.batchAllocations?.length ||
    dto.restitutions?.length ||
    dto.historicalRestitution,
  );
}

/** Copie simple d'une affectation (sous-document Mongoose → objet). */
function plainAllocation(a: SaleBatchSnapshot): SaleBatchSnapshot {
  return {
    batchId: new Types.ObjectId(String(a.batchId)),
    reference: a.reference,
    expiryDate: a.expiryDate ?? null,
    manufacturerLot: a.manufacturerLot ?? null,
    quantity: a.quantity,
  };
}

/** Affectation courante − retours + ajouts (par lot, jamais négative). */
function mergeAllocations(
  current: readonly SaleBatchSnapshot[],
  returned: readonly SaleBatchSnapshot[],
  added: readonly SaleBatchSnapshot[],
): SaleBatchSnapshot[] {
  const byId = new Map<string, SaleBatchSnapshot>();
  for (const a of current) byId.set(a.batchId.toHexString(), { ...a });
  for (const r of returned) {
    const entry = byId.get(r.batchId.toHexString());
    if (entry) entry.quantity -= r.quantity;
  }
  for (const a of added) {
    const entry = byId.get(a.batchId.toHexString());
    if (entry) entry.quantity += a.quantity;
    else byId.set(a.batchId.toHexString(), { ...a });
  }
  return [...byId.values()].filter((a) => a.quantity > 0);
}

function allocationSummary(
  allocations: readonly SaleBatchSnapshot[],
): { batchId: Types.ObjectId; reference: string; quantity: number }[] {
  return allocations.map((a) => ({
    batchId: a.batchId,
    reference: a.reference,
    quantity: a.quantity,
  }));
}

function restitutionEntries(credit: BatchCreditResult): RestitutionLog[] {
  return [
    ...credit.credited.map((c) => ({
      batchId: c.batchId,
      reference: c.reference,
      quantity: c.quantity,
      historical: false,
    })),
    ...(credit.historicalBatch
      ? [
          {
            batchId: credit.historicalBatch.batchId,
            reference: credit.historicalBatch.reference,
            quantity: credit.historicalBatch.quantity,
            historical: true,
          },
        ]
      : []),
  ];
}

@Injectable()
export class SalesService {
  private readonly logger = new Logger(SalesService.name);

  constructor(
    @InjectModel(Sale.name) private saleModel: Model<SaleDocument>,
    @InjectModel(SaleOperation.name)
    private saleOperationModel: Model<SaleOperationDocument>,
    @InjectConnection() private connection: Connection,
    private productsService: ProductsService,
    private eventsGateway: EventsGateway,
    private auditService: AuditService,
    // 1-16A : optionnel (tests unitaires construits sans module push).
    @Optional() private pushOutbox?: PushOutboxService,
    // Lot B : optionnel (tests unitaires construits sans lots).
    @Optional() private batches?: ProductBatchesService,
    @Optional()
    @InjectModel(SaleRegularizationRequest.name)
    private regularizationModel?: Model<SaleRegularizationRequestDocument>,
  ) {}

  /**
   * Création d'une vente — TRANSACTION ATOMIQUE (phase 0B.7B).
   *
   * Les trois écritures déterminant l'état métier (décrémentation du stock,
   * création de la vente, journal d'audit `SOLD`) sont groupées dans UNE
   * seule transaction MongoDB : elles sont soit toutes validées (commit),
   * soit toutes annulées (rollback). La même instance `ClientSession` est
   * transmise explicitement à chaque lecture/écriture.
   *
   * Garanties :
   * - aucune vente sans stock décrémenté, aucun stock décrémenté sans vente ;
   * - stock jamais négatif (garde `remainingQuantity >= quantity` atomique) ;
   * - aucun audit `SOLD` orphelin (annulée avec la vente) ;
   * - l'événement Socket.IO `sale:created` part UNIQUEMENT après le commit.
   *
   * Aucune opération parallèle (Promise.all) à l'intérieur : l'audit référence
   * le `saleId` de la vente créée et Mongoose exige la session explicite sur
   * chaque opération.
   *
   * 1-4C.1 — TENANT : `organizationId` (celle du vendeur, branchée par
   * `OrganizationGuard` sur `request`) est le 1er argument OBLIGATOIRE. Ce
   * tenant est écrit dans la vente, passé à la décrémentation ATOMIQUE du
   * stock ET à l'audit `SOLD` — les trois écritures de la transaction. Le
   * DTO ne le porte jamais et ne le détermine pas.
   *
   * 1-11C.1 — IDEMPOTENCE : avec `clientOperationId`, une trace
   * `SaleOperation` (index unique `{organizationId, clientOperationId}`) est
   * la première écriture de la même transaction. Tout rejeu (séquentiel ou
   * concurrent) renvoie la même vente sans stock, audit ni événement
   * (`replay`). Sans clé : flux historique.
   */
  async create(
    organizationId: string,
    dto: CreateSaleDto,
    sellerId: string,
    options: { newWritesAllowed: boolean } = { newWritesAllowed: true },
  ): Promise<SaleDocument> {
    const input = normalizeCreateSale(dto);
    // 1-14C.1 — abonnement inactif : AUCUNE nouvelle écriture. Seule une clé
    // déjà appliquée est confirmée par le MÊME `replay` (mêmes contrôles
    // vendeur / payload canonique / vente supprimée, aucun stock, audit ni
    // événement). Clé absente ou inconnue → 403 avant toute écriture.
    // `occurredAt` client n'intervient que dans la comparaison canonique.
    if (!options.newWritesAllowed) {
      if (dto.clientOperationId === undefined) {
        throw subscriptionInactiveException();
      }
      const applied = await this.saleOperationModel
        .findOne({
          organizationId: new Types.ObjectId(organizationId),
          clientOperationId: dto.clientOperationId,
        })
        .read('primary')
        .exec();
      if (!applied) throw subscriptionInactiveException();
      return this.replay(
        organizationId,
        applied,
        sellerId,
        computeSaleRequestHash(input),
      );
    }
    if (dto.clientOperationId === undefined) {
      // Flux historique : aucune déduplication.
      return this.createFresh(
        organizationId,
        input,
        sellerId,
        resolveOccurredAt(input.occurredAt),
      );
    }

    // 1-11C.1 — flux idempotent.
    const clientOperationId = dto.clientOperationId;
    const requestHash = computeSaleRequestHash(input);
    const key = {
      organizationId: new Types.ObjectId(organizationId),
      clientOperationId,
    };

    // Chemin rapide : clé déjà appliquée → réponse rejouée, AVANT toute
    // validation de plage de date (un rejeu tardif d'une vente appliquée
    // doit toujours aboutir au même résultat).
    const existing = await this.saleOperationModel.findOne(key).exec();
    if (existing) {
      return this.replay(organizationId, existing, sellerId, requestHash);
    }

    const occurredAt = resolveOccurredAt(input.occurredAt);
    try {
      return await this.createFresh(
        organizationId,
        input,
        sellerId,
        occurredAt,
        { clientOperationId, requestHash },
      );
    } catch (error) {
      // Rejeu concurrent : l'autre requête a commité la même clé. Seul
      // l'E11000 de l'index idempotent est absorbé ; tout autre est relancé.
      if (!isSaleOperationDuplicateKeyError(error)) throw error;
      const winner = await this.saleOperationModel
        .findOne(key)
        .read('primary')
        .exec();
      if (!winner) throw error;
      return this.replay(organizationId, winner, sellerId, requestHash);
    }
  }

  /**
   * Rejeu d'une clé déjà appliquée : AUCUNE écriture, AUCUN stock, AUCUN
   * audit, AUCUN événement. Contrôles dans cet ordre :
   * 1. autre vendeur → 409 `IDEMPOTENCY_KEY_CONFLICT`, sans aucune donnée ;
   * 2. payload différent → 409 `IDEMPOTENCY_KEY_REUSED` ;
   * 3. vente supprimée depuis → 409 `SALE_OPERATION_ALREADY_APPLIED` ;
   * 4. sinon → la vente (même `_id`), dans sa représentation COURANTE
   *    (modifications PATCH ultérieures incluses), vendeur peuplé comme la
   *    réponse initiale. Statut HTTP 201 inchangé.
   */
  private async replay(
    organizationId: string,
    operation: SaleOperationDocument,
    sellerId: string,
    requestHash: string,
  ): Promise<SaleDocument> {
    if (operation.sellerId.toString() !== sellerId) {
      throw new ConflictException({
        code: SALE_ERROR_CODES.IDEMPOTENCY_KEY_CONFLICT,
        message: "Clé d'opération déjà utilisée.",
      });
    }
    if (operation.requestHash !== requestHash) {
      throw new ConflictException({
        code: SALE_ERROR_CODES.IDEMPOTENCY_KEY_REUSED,
        message: "Clé d'opération déjà utilisée pour une autre vente.",
      });
    }
    const sale = await this.saleModel
      .findOne({
        _id: operation.saleId,
        organizationId: new Types.ObjectId(organizationId),
      })
      .populate('sellerId', 'name email')
      .exec();
    if (!sale) {
      throw new ConflictException({
        code: SALE_ERROR_CODES.SALE_OPERATION_ALREADY_APPLIED,
        message: 'Vente déjà enregistrée puis supprimée.',
      });
    }
    return sale;
  }

  private async createFresh(
    organizationId: string,
    input: NormalizedSaleInput,
    sellerId: string,
    occurredAt: Date,
    idempotency?: { clientOperationId: string; requestHash: string },
    approval?: RegularizationApproval,
  ): Promise<SaleDocument> {
    const orgOid = new Types.ObjectId(organizationId);
    if (input.batchAllocations !== null) {
      this.requireBatches().assertEnabled(organizationId);
      assertAllocationSum(input.batchAllocations, input.quantity);
    }
    // `_id` connu AVANT la transaction : la trace idempotente le référence
    // dès sa première écriture.
    const saleId = new Types.ObjectId();
    const session = await this.connection.startSession();
    let created: SaleDocument | undefined;

    try {
      await session.withTransaction(async () => {
        // 0. (1-11C.1) Trace idempotente en PREMIÈRE écriture : un rejeu
        //    concurrent de la même clé bute sur l'index unique (conflit
        //    d'écriture puis E11000). Annulée avec le reste sur rollback.
        if (idempotency) {
          await this.saleOperationModel.create(
            [
              {
                organizationId: orgOid,
                clientOperationId: idempotency.clientOperationId,
                sellerId: new Types.ObjectId(sellerId),
                saleId,
                requestHash: idempotency.requestHash,
              },
            ],
            { session },
          );
        }

        // 1. Décrémentation ATOMIQUE et conditionnelle du stock tenant. Lève
        //    404 (produit absent/étranger/corbeillé) ou 400 (stock
        //    insuffisant) : la transaction est alors annulée, rien n'est
        //    persisté. Lot B : produit suivi par lots → lots désignés
        //    décrémentés avec la fiche (jamais substitués) ; sans
        //    affectation → 409 `SALE_BATCH_ALLOCATION_REQUIRED`.
        let product: ProductDocument;
        let stock: BatchStockChange;
        let batchSale: BatchSaleResult | null = null;
        if (input.batchAllocations !== null) {
          batchSale = await this.requireBatches().consumeForSale(session, {
            organizationId,
            productId: input.productId,
            entries: input.batchAllocations,
            unknownExpiryConfirmed: input.unknownExpiryConfirmed,
            occurredAt,
            regularize: input.regularizationReason !== null,
          });
          product = batchSale.product;
          stock = batchSale.stock;
        } else {
          product = await this.productsService.decrementStock(
            organizationId,
            input.productId,
            input.quantity,
            session,
          );
          stock = {
            initialQuantity: product.initialQuantity,
            remainingBefore: product.remainingQuantity + input.quantity,
            remainingAfter: product.remainingQuantity,
            lowStockThreshold: product.lowStockThreshold ?? null,
          };
        }
        // 1-16A / 1-16A.1 — seuils de stock franchis par CETTE décrémentation
        // atomique (valeurs avant / après exactes) : événement enregistré
        // dans la transaction (annulé avec elle ; clé stable `sale:<id>`
        // d'une tentative à l'autre). Rupture prioritaire : jamais deux
        // alertes de stock pour la même opération. Aucun envoi ici.
        await this.recordStockThresholds(
          session,
          organizationId,
          input.productId,
          stock,
          `sale:${saleId.toHexString()}`,
        );
        const regularization =
          batchSale && (batchSale.regularizedReferences.length > 0 || approval)
            ? {
                reason: input.regularizationReason!,
                // Approbation : le responsable ; sinon le vendeur autorisé.
                actorId: new Types.ObjectId(approval?.approverId ?? sellerId),
                at: new Date(),
                businessDate: businessDate(),
                references: batchSale.regularizedReferences,
                ...(approval
                  ? {
                      requestId: approval.requestId,
                      requestedBy: new Types.ObjectId(sellerId),
                      declaredOccurredAt: occurredAt,
                      receivedAt: approval.receivedAt,
                    }
                  : {}),
              }
            : null;

        // 2. Création de la vente, MÊME session. L'org SERVEUR est écrite
        //    dans le document (jamais issue du DTO). Sur échec, le rollback
        //    annule la décrémentation du stock (point 1).
        const [sale] = await this.saleModel.create(
          [
            {
              ...(idempotency ? { _id: saleId } : {}),
              organizationId: orgOid,
              productId: new Types.ObjectId(input.productId),
              quantity: input.quantity,
              salePrice: input.salePrice,
              sellerId: new Types.ObjectId(sellerId),
              productName: product.name,
              occurredAt,
              ...(input.buyerName !== null
                ? { buyerName: input.buyerName }
                : {}),
              ...(input.buyerContact !== null
                ? { buyerContact: input.buyerContact }
                : {}),
              ...(batchSale
                ? {
                    batchAllocations: batchSale.allocations,
                    originalBatchAllocations: batchSale.allocations,
                  }
                : {}),
              ...(regularization
                ? { expiredBatchRegularization: regularization }
                : {}),
            },
          ],
          { session },
        );

        // 3. Journal d'audit `SOLD` référençant la VENTE créée dans cette
        //    même tentative — MÊME session, MÊME org : si la vente est
        //    annulée, l'audit ne subsiste pas.
        await this.auditService.log(
          organizationId,
          input.productId,
          AuditAction.SOLD,
          sellerId,
          {
            saleId: sale._id,
            quantity: input.quantity,
            salePrice: input.salePrice,
            buyerName: input.buyerName ?? undefined,
            ...(idempotency
              ? { clientOperationId: idempotency.clientOperationId }
              : {}),
            ...(batchSale
              ? { batches: allocationSummary(batchSale.allocations) }
              : {}),
            ...(regularization
              ? {
                  expiredBatchRegularization: {
                    reason: regularization.reason,
                    references: regularization.references,
                    ...(approval
                      ? {
                          requestId: approval.requestId,
                          approvedBy: new Types.ObjectId(approval.approverId),
                          declaredOccurredAt: occurredAt,
                          receivedAt: approval.receivedAt,
                        }
                      : {}),
                  },
                }
              : {}),
          },
          session,
        );

        // Lot B : décision de la demande DANS la même transaction que la
        // vente (conditionnée à `pending`) — une approbation concurrente
        // ou un rejet simultané annule tout.
        if (approval) {
          await this.decideRegularizationInSession(session, {
            organizationId,
            approval,
            saleId: sale._id,
            sellerId,
            occurredAt,
            references: regularization?.references ?? [],
          });
        }

        // 1-16A.1 — nouvelle vente VALIDÉE : événement durable dans la même
        // transaction (aucun après rollback ; un rejeu idempotent ne passe
        // jamais par ici).
        await this.pushOutbox?.saleCreatedInSession(session, {
          organizationId,
          productId: input.productId,
          saleId: String(sale._id),
          sellerId,
        });

        created = sale;
      });
    } finally {
      // Session fermée dans TOUS les cas (succès ou erreur) — pas de fuite.
      await session.endSession();
    }

    // APRÈS le commit uniquement : peupler le vendeur puis émettre l'événement
    // temps réel. Un rollback ne produit donc AUCUN événement Socket.IO.
    if (!created) {
      throw new Error('Sale transaction completed without creating a sale');
    }
    // Détache explicitement le document de la session (déjà fermée) avant tout
    // usage ultérieur (populate, sérialisation) — plus aucune opération liée
    // à la session close.
    created.$session(null);
    const populated = await created.populate('sellerId', 'name email');
    // Best effort, UNE fois dans le flux normal : la vente est déjà commitée,
    // un échec d'émission ne doit pas la transformer en erreur (un rejeu
    // n'émettrait de toute façon plus rien). Aucune garantie « exactement
    // une émission » en cas de crash entre le commit et cette ligne.
    try {
      // 1-12H — diffusion commune à toute l'organisation : identifiants
      // seuls, jamais la vente d'un collègue (prix, vendeur, acheteur,
      // coordonnées). Un client intéressé recharge via l'API autorisée.
      this.eventsGateway.emitToOrganization(organizationId, 'sale:created', {
        _id: String(populated._id),
        productId: String(populated.productId),
      });
    } catch {
      this.logger.warn('sale:created non émis (best effort).');
    }
    return populated;
  }

  async findAll(
    organizationId: string,
    productId?: string,
    scopeSellerId?: string,
  ): Promise<SaleDocument[]> {
    const filter: Record<string, Types.ObjectId> = {
      organizationId: new Types.ObjectId(organizationId),
    };
    if (productId) filter.productId = new Types.ObjectId(productId);
    // 1-7B — scope `sales.view_own` : restreint au vendeur courant.
    if (scopeSellerId) filter.sellerId = new Types.ObjectId(scopeSellerId);
    return this.saleModel
      .find(filter)
      .populate('sellerId', 'name email')
      .populate('productId', 'name')
      .sort({ createdAt: -1 })
      .exec();
  }

  /**
   * 1-20E — Une page de l'historique (`GET /sales/history`). Organisation,
   * restriction `view_own` et filtre produit appliqués AVANT la pagination ;
   * total compté sur tout le périmètre filtré autorisé (jamais la page) ;
   * tri `createdAt` puis `_id` décroissants ; `limit + 1` documents lus au
   * plus (jamais tout l'historique en mémoire). Une vente annulée est
   * supprimée : absente des pages comme du total (règle inchangée).
   */
  async findHistoryPage(
    organizationId: string,
    options: { limit: number; cursor?: string; productId?: string },
    scopeSellerId?: string,
  ): Promise<{
    items: SaleDocument[];
    total: number;
    nextCursor: string | null;
  }> {
    const filter: Record<string, unknown> = {
      organizationId: new Types.ObjectId(organizationId),
    };
    if (options.productId)
      filter.productId = new Types.ObjectId(options.productId);
    if (scopeSellerId) filter.sellerId = new Types.ObjectId(scopeSellerId);
    const page: Record<string, unknown> = { ...filter };
    if (options.cursor) {
      const at = decodeSalesHistoryCursor(options.cursor);
      // `createdAt <= curseur` : borne d'index (le parcours commence au
      // curseur, coût indépendant de la profondeur) ; `$or` : départage
      // exact par `_id` à date égale (équivalent logique).
      page.createdAt = { $lte: at.createdAt };
      page.$or = [
        { createdAt: { $lt: at.createdAt } },
        { _id: { $lt: at.id } },
      ];
    }
    const [total, rows] = await Promise.all([
      this.saleModel.countDocuments(filter).exec(),
      this.saleModel
        .find(page)
        .sort({ createdAt: -1, _id: -1 })
        .limit(options.limit + 1)
        .populate('sellerId', 'name email')
        .populate('productId', 'name')
        .exec(),
    ]);
    const items = rows.slice(0, options.limit);
    // `timestamps.createdAt` : posé par Mongoose, absent du type `Sale`.
    const last = items[items.length - 1] as unknown as
      { createdAt: Date; _id: Types.ObjectId } | undefined;
    return {
      items,
      total,
      nextCursor:
        rows.length > options.limit && last
          ? encodeSalesHistoryCursor(last)
          : null,
    };
  }

  async update(
    organizationId: string,
    id: string,
    dto: UpdateSaleDto,
    actorId: string,
    scopeSellerId?: string,
  ): Promise<SaleDocument> {
    const session = await this.connection.startSession();
    let saved: SaleDocument | undefined;
    // 1-16A : clé stable de CETTE modification (réutilisée si le driver
    // rejoue le callback transactionnel).
    const operationId = new Types.ObjectId().toHexString();
    try {
      await session.withTransaction(async () => {
        const filter: Record<string, Types.ObjectId> = {
          _id: new Types.ObjectId(id),
          organizationId: new Types.ObjectId(organizationId),
        };
        // 1-7B — sans `sales.view_all` : une vente d'un autre vendeur est
        // indistinguable d'une vente absente (même 404, aucune fuite).
        if (scopeSellerId) filter.sellerId = new Types.ObjectId(scopeSellerId);
        const sale = await this.saleModel
          .findOne(filter, null, { session })
          .exec();
        if (!sale) throw new NotFoundException(`Sale ${id} not found`);

        const changes: Record<string, unknown> = {};
        const productId = sale.productId.toString();
        const tracking = await this.trackingOf(
          session,
          organizationId,
          productId,
        );
        if (tracking === 'batches' || sale.batchAllocations?.length) {
          // Lot B : correction d'une vente d'un produit suivi par lots.
          await this.correctBatchSale(session, {
            organizationId,
            sale,
            dto,
            actorId,
            tracking,
            operationId,
            changes,
          });
        } else if (hasBatchCorrectionFields(dto)) {
          throw new ConflictException(
            batchError(
              'BATCH_TRACKING_NOT_ENABLED',
              "Le suivi par lots n'est pas activé pour ce produit.",
            ),
          );
        } else if (
          dto.quantity !== undefined &&
          dto.quantity !== sale.quantity
        ) {
          const delta = sale.quantity - dto.quantity;
          const adjustment = await this.productsService.adjustStock(
            organizationId,
            productId,
            delta,
            session,
          );
          // 1-16A / 1-16A.1 — correction de quantité : seuils franchis
          // (une baisse de la quantité vendue ne franchit rien et réarme).
          if (adjustment) {
            await this.recordStockThresholds(
              session,
              organizationId,
              productId,
              adjustment,
              `sale-update:${operationId}`,
            );
          }
          changes.quantity = { from: sale.quantity, to: dto.quantity };
          sale.quantity = dto.quantity;
        }
        if (dto.salePrice !== undefined && dto.salePrice !== sale.salePrice) {
          changes.salePrice = { from: sale.salePrice, to: dto.salePrice };
          sale.salePrice = dto.salePrice;
        }

        saved = await sale.save({ session });
        await this.auditService.log(
          organizationId,
          sale.productId.toString(),
          AuditAction.SALE_UPDATED,
          actorId,
          { saleId: id, ...changes },
          session,
        );
      });
    } finally {
      await session.endSession();
    }

    if (!saved) {
      throw new Error('Sale transaction completed without updating a sale');
    }
    saved.$session(null);
    // 1-12H (correctif) — APRÈS le commit : invalidation minimale pour
    // rafraîchir stock et agrégats chez les autres membres (rechargement via
    // l'API, qui applique leurs permissions).
    this.emitSaleInvalidation(organizationId, 'sale:updated', {
      _id: id,
      productId: String(saved.productId),
    });
    return saved.populate('sellerId', 'name email');
  }

  // ─── Lot B : régularisation par un responsable ───────────────────────

  private requireRegularizations(): Model<SaleRegularizationRequestDocument> {
    if (!this.regularizationModel) {
      throw new Error('Demandes de régularisation indisponibles');
    }
    return this.regularizationModel;
  }

  /**
   * Demande de régularisation transmise EXPLICITEMENT par le vendeur d'une
   * vente hors ligne refusée `BATCH_EXPIRED_AT_SYNC` (même payload, même
   * `clientOperationId` que l'opération de son outbox). Idempotente par
   * opération ; refusée si une vente existe déjà pour cette opération ou si
   * la vente n'est pas éligible. Rien n'est réservé.
   */
  async requestRegularization(
    organizationId: string,
    dto: CreateSaleDto,
    sellerId: string,
  ): Promise<SaleRegularizationRequestDocument> {
    const model = this.requireRegularizations();
    const batches = this.requireBatches();
    batches.assertEnabled(organizationId);
    if (
      dto.clientOperationId === undefined ||
      dto.occurredAt === undefined ||
      !dto.batchAllocations?.length ||
      dto.expiredBatchRegularization !== undefined
    ) {
      throw new BadRequestException(
        batchError(
          'BATCH_ALLOCATION_MISMATCH',
          'La demande doit reprendre la vente en attente telle quelle (opération, heure et lots).',
        ),
      );
    }
    const input = normalizeCreateSale(dto);
    assertAllocationSum(input.batchAllocations!, input.quantity);
    const declaredOccurredAt = resolveOccurredAt(input.occurredAt);
    const requestHash = computeSaleRequestHash(input);
    const orgOid = new Types.ObjectId(organizationId);
    const key = {
      organizationId: orgOid,
      clientOperationId: dto.clientOperationId,
    };
    if (await this.saleOperationModel.exists(key).exec()) {
      throw new ConflictException(
        batchError(
          'SALE_REGULARIZATION_ALREADY_APPLIED',
          'Cette vente est déjà enregistrée : aucune régularisation à demander.',
        ),
      );
    }
    const existing = await model.findOne(key).exec();
    if (existing) return this.sameRequest(existing, sellerId, requestHash);
    const eligibility = await batches.regularizationEligibility({
      organizationId,
      productId: input.productId,
      entries: input.batchAllocations!,
      unknownExpiryConfirmed: input.unknownExpiryConfirmed,
      occurredAt: declaredOccurredAt,
    });
    const session = await this.connection.startSession();
    let created: SaleRegularizationRequestDocument | undefined;
    try {
      await session.withTransaction(async () => {
        const [doc] = await model.create(
          [
            {
              organizationId: orgOid,
              clientOperationId: dto.clientOperationId,
              sellerId: new Types.ObjectId(sellerId),
              productId: new Types.ObjectId(input.productId),
              productName: eligibility.product.name,
              quantity: input.quantity,
              salePrice: input.salePrice,
              buyerName: input.buyerName,
              buyerContact: input.buyerContact,
              declaredOccurredAt,
              batchAllocations: eligibility.lines,
              unknownExpiryConfirmed: input.unknownExpiryConfirmed,
              expiredReferences: eligibility.expiredReferences,
              requestHash,
              status: SaleRegularizationStatus.PENDING,
            },
          ],
          { session },
        );
        await this.auditService.log(
          organizationId,
          input.productId,
          AuditAction.SALE_REGULARIZATION_REQUESTED,
          sellerId,
          {
            requestId: doc._id,
            clientOperationId: dto.clientOperationId,
            quantity: input.quantity,
            batches: allocationSummary(eligibility.lines),
            expiredReferences: eligibility.expiredReferences,
            // Heure déclarée par l'appareil, non vérifiée ; la réception
            // est l'horodatage serveur de cette entrée.
            declaredOccurredAt,
          },
          session,
        );
        // Lot C : responsables prévenus (centre et push), une fois par
        // demande ; annulé avec la transaction.
        await this.pushOutbox?.regularizationRequestedInSession(session, {
          organizationId,
          productId: input.productId,
          requestId: doc._id.toHexString(),
        });
        created = doc;
      });
    } catch (error) {
      if (!isRequestDuplicateKeyError(error)) throw error;
      const winner = await model.findOne(key).read('primary').exec();
      if (!winner) throw error;
      return this.sameRequest(winner, sellerId, requestHash);
    } finally {
      await session.endSession();
    }
    return created!;
  }

  private sameRequest(
    request: SaleRegularizationRequestDocument,
    sellerId: string,
    requestHash: string,
  ): SaleRegularizationRequestDocument {
    if (request.sellerId.toHexString() !== sellerId) {
      throw new ConflictException({
        code: SALE_ERROR_CODES.IDEMPOTENCY_KEY_CONFLICT,
        message: "Clé d'opération déjà utilisée.",
      });
    }
    if (request.requestHash !== requestHash) {
      throw new ConflictException({
        code: SALE_ERROR_CODES.IDEMPOTENCY_KEY_REUSED,
        message: "Clé d'opération déjà utilisée pour une autre vente.",
      });
    }
    return request;
  }

  /** Demandes visibles : tout le commerce (responsable) ou les siennes. */
  async listRegularizations(
    organizationId: string,
    options: {
      scopeSellerId?: string;
      clientOperationIds?: string[];
      status?: SaleRegularizationStatus;
    },
  ): Promise<SaleRegularizationRequestDocument[]> {
    const filter: Record<string, unknown> = {
      organizationId: new Types.ObjectId(organizationId),
    };
    if (options.scopeSellerId) {
      filter.sellerId = new Types.ObjectId(options.scopeSellerId);
    }
    if (options.clientOperationIds?.length) {
      filter.clientOperationId = { $in: options.clientOperationIds };
    }
    if (options.status) filter.status = options.status;
    return this.requireRegularizations()
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(100)
      .populate('sellerId', 'name email')
      .populate('decidedBy', 'name email')
      .exec();
  }

  /**
   * Approbation par un responsable (droits vérifiés par le contrôleur) :
   * la vente est créée au nom du VENDEUR D'ORIGINE, sous la clé de son
   * opération, avec revalidation complète (quantités, dates, éligibilité).
   * Idempotente : une demande déjà approuvée est renvoyée telle quelle ;
   * deux approbations concurrentes ne créent qu'une vente.
   */
  async approveRegularization(
    organizationId: string,
    requestId: string,
    approverId: string,
    reason: string,
  ): Promise<SaleRegularizationRequestDocument> {
    const model = this.requireRegularizations();
    this.requireBatches().assertEnabled(organizationId);
    const filter = {
      _id: new Types.ObjectId(requestId),
      organizationId: new Types.ObjectId(organizationId),
    };
    const request = await model.findOne(filter).exec();
    if (!request) throw new NotFoundException(`Request ${requestId} not found`);
    if (request.status === SaleRegularizationStatus.APPROVED) return request;
    if (request.status === SaleRegularizationStatus.REJECTED) {
      throw new ConflictException(
        batchError(
          'SALE_REGULARIZATION_DECIDED',
          'Cette demande a déjà été traitée.',
        ),
      );
    }
    const input: NormalizedSaleInput = {
      productId: request.productId.toHexString(),
      quantity: request.quantity,
      salePrice: request.salePrice,
      buyerName: request.buyerName ?? null,
      buyerContact: request.buyerContact ?? null,
      occurredAt: request.declaredOccurredAt.toISOString(),
      batchAllocations: request.batchAllocations.map((l) => ({
        batchId: l.batchId.toHexString(),
        quantity: l.quantity,
      })),
      unknownExpiryConfirmed: request.unknownExpiryConfirmed,
      regularizationReason: reason.trim(),
    };
    try {
      await this.createFresh(
        organizationId,
        input,
        request.sellerId.toHexString(),
        request.declaredOccurredAt,
        {
          clientOperationId: request.clientOperationId,
          // Hash de l'opération D'ORIGINE : le rejeu de l'outbox du vendeur
          // retrouve cette vente.
          requestHash: request.requestHash,
        },
        {
          requestId: request._id,
          approverId,
          reason: reason.trim(),
          receivedAt: (request as unknown as { createdAt: Date }).createdAt,
        },
      );
    } catch (error) {
      // Approbation concurrente : l'autre a créé la vente sous la même clé.
      const current = await model.findOne(filter).read('primary').exec();
      if (current?.status === SaleRegularizationStatus.APPROVED) return current;
      throw error;
    }
    return (await model.findOne(filter).read('primary').exec())!;
  }

  /** Rejet motivé : la demande reste consultable, aucune vente créée. */
  async rejectRegularization(
    organizationId: string,
    requestId: string,
    approverId: string,
    reason: string,
  ): Promise<SaleRegularizationRequestDocument> {
    const model = this.requireRegularizations();
    const filter = {
      _id: new Types.ObjectId(requestId),
      organizationId: new Types.ObjectId(organizationId),
    };
    const session = await this.connection.startSession();
    let decided: SaleRegularizationRequestDocument | null = null;
    try {
      await session.withTransaction(async () => {
        decided = await model
          .findOneAndUpdate(
            { ...filter, status: SaleRegularizationStatus.PENDING },
            {
              $set: {
                status: SaleRegularizationStatus.REJECTED,
                decidedBy: new Types.ObjectId(approverId),
                decidedAt: new Date(),
                decisionReason: reason.trim(),
              },
            },
            { session, returnDocument: 'after' },
          )
          .exec();
        if (!decided) return;
        await this.auditService.log(
          organizationId,
          decided.productId.toHexString(),
          AuditAction.SALE_REGULARIZATION_REJECTED,
          approverId,
          {
            requestId: decided._id,
            sellerId: decided.sellerId,
            reason: reason.trim(),
            declaredOccurredAt: decided.declaredOccurredAt,
          },
          session,
        );
      });
    } finally {
      await session.endSession();
    }
    if (decided) return decided;
    const current = await model.findOne(filter).exec();
    if (!current) throw new NotFoundException(`Request ${requestId} not found`);
    throw new ConflictException(
      batchError(
        'SALE_REGULARIZATION_DECIDED',
        'Cette demande a déjà été traitée.',
      ),
    );
  }

  private async decideRegularizationInSession(
    session: MongooseSession,
    input: {
      organizationId: string;
      approval: RegularizationApproval;
      saleId: Types.ObjectId;
      sellerId: string;
      occurredAt: Date;
      references: string[];
    },
  ): Promise<void> {
    const decided = await this.requireRegularizations()
      .findOneAndUpdate(
        {
          _id: input.approval.requestId,
          organizationId: new Types.ObjectId(input.organizationId),
          status: SaleRegularizationStatus.PENDING,
        },
        {
          $set: {
            status: SaleRegularizationStatus.APPROVED,
            decidedBy: new Types.ObjectId(input.approval.approverId),
            decidedAt: new Date(),
            decisionReason: input.approval.reason,
            saleId: input.saleId,
          },
        },
        { session, returnDocument: 'after' },
      )
      .exec();
    if (!decided) {
      throw new ConflictException(
        batchError(
          'SALE_REGULARIZATION_DECIDED',
          'Cette demande a déjà été traitée.',
        ),
      );
    }
    await this.auditService.log(
      input.organizationId,
      decided.productId.toHexString(),
      AuditAction.SALE_REGULARIZATION_APPROVED,
      input.approval.approverId,
      {
        requestId: decided._id,
        saleId: input.saleId,
        // Vendeur d'origine ≠ approbateur (acteur de cette entrée).
        sellerId: new Types.ObjectId(input.sellerId),
        reason: input.approval.reason,
        references: input.references,
        declaredOccurredAt: input.occurredAt,
        receivedAt: input.approval.receivedAt,
      },
      session,
    );
  }

  // ─── Lot B : lots des ventes ──────────────────────────────────────────

  private requireBatches(): ProductBatchesService {
    if (!this.batches) {
      throw new Error('ProductBatchesService indisponible');
    }
    return this.batches;
  }

  private trackingOf(
    session: MongooseSession,
    organizationId: string,
    productId: string,
  ): Promise<'batches' | 'none' | 'purged'> {
    // Sans service de lots (tests unitaires) : aucun produit suivi.
    if (!this.batches) return Promise.resolve('none');
    return this.batches.trackingOf(session, organizationId, productId);
  }

  /**
   * Correction d'une vente d'un produit suivi par lots (même transaction
   * que la vente). Nouvelle quantité = quantité − retours aux lots
   * d'origine − restitutions (unités d'origine inconnue) + ajouts. Aucune
   * variation de quantité sans préciser les lots ; une correction du prix
   * seul ne touche pas au stock. L'affectation d'origine et chaque
   * correction (avant / après) restent sur la vente.
   */
  private async correctBatchSale(
    session: MongooseSession,
    input: {
      organizationId: string;
      sale: SaleDocument;
      dto: UpdateSaleDto;
      actorId: string;
      tracking: 'batches' | 'none' | 'purged';
      operationId: string;
      changes: Record<string, unknown>;
    },
  ): Promise<void> {
    const { organizationId, sale, dto, actorId } = input;
    const productId = sale.productId.toString();
    const target = dto.quantity ?? sale.quantity;
    const returns = dto.batchReturns ?? [];
    const additions = dto.batchAllocations ?? [];
    const restitutions = dto.restitutions ?? [];
    const historical = dto.historicalRestitution?.quantity ?? 0;
    const stockTouched =
      returns.length + additions.length + restitutions.length > 0 ||
      historical > 0;
    if (!stockTouched && target === sale.quantity) return;
    const batches = this.requireBatches();
    batches.assertEnabled(organizationId);
    if (input.tracking === 'purged') {
      throw new ConflictException(
        batchError(
          'SALE_PRODUCT_PURGED',
          'Le produit a été supprimé définitivement : aucune restitution de stock possible.',
        ),
      );
    }
    const current = (sale.batchAllocations ?? []).map(plainAllocation);
    const allocatedTotal = sumOf(current);
    const unknownOrigin = sale.quantity - allocatedTotal;
    // Retours : seulement vers les lots d'origine de CETTE vente, dans la
    // limite de leurs unités.
    const byBatch = new Map(current.map((a) => [a.batchId.toHexString(), a]));
    for (const r of returns) {
      const origin = byBatch.get(r.batchId.toLowerCase());
      if (!origin || r.quantity > origin.quantity) {
        throw new BadRequestException(
          batchError(
            'BATCH_ALLOCATION_MISMATCH',
            "Un lot rendu ne correspond pas aux lots d'origine de la vente.",
          ),
        );
      }
    }
    const restituted = sumOf(restitutions) + historical;
    if (restituted > 0) {
      if (restituted > unknownOrigin) {
        throw new BadRequestException(
          batchError(
            'BATCH_ALLOCATION_MISMATCH',
            "Les unités restituées dépassent celles dont le lot d'origine est inconnu.",
          ),
        );
      }
      assertRestitutionReason(dto.restitutionReason);
    }
    const computed =
      sale.quantity - sumOf(returns) - restituted + sumOf(additions);
    if (computed !== target) {
      if (!stockTouched) {
        // Ancien client : quantité seule.
        throw new ConflictException(
          target < sale.quantity && unknownOrigin > 0 && allocatedTotal === 0
            ? batchError(
                'SALE_BATCH_RESTITUTION_REQUIRED',
                'Cette vente est antérieure au suivi par lots : indiquez dans quels lots restituer les unités, avec un motif.',
              )
            : batchError(
                'SALE_BATCH_CORRECTION_REQUIRED',
                'Ce produit est suivi par lots : précisez les lots concernés par la correction.',
              ),
        );
      }
      throw new BadRequestException(
        batchError(
          'BATCH_ALLOCATION_MISMATCH',
          'Les lots indiqués ne correspondent pas à la nouvelle quantité.',
        ),
      );
    }
    if (target < 1) {
      throw new BadRequestException(
        batchError(
          'BATCH_ALLOCATION_MISMATCH',
          'La quantité vendue doit rester au moins égale à 1.',
        ),
      );
    }
    // Écritures : crédits d'abord (retours, restitutions), puis ajouts.
    let before: number | null = null;
    let last: BatchStockChange | null = null;
    const track = (stock: BatchStockChange) => {
      if (before === null) before = stock.remainingBefore;
      last = stock;
    };
    let returned: SaleBatchSnapshot[] = [];
    let nonSellableReturns: BatchCreditResult['nonSellable'] = [];
    if (returns.length) {
      const credit = await batches.creditBatches(session, {
        organizationId,
        productId,
        entries: returns,
        destinations: false,
      });
      track(credit.stock);
      returned = credit.credited;
      nonSellableReturns = credit.nonSellable;
    }
    const restitutionLog: RestitutionLog[] = [];
    if (restituted > 0) {
      const credit = await batches.creditBatches(session, {
        organizationId,
        productId,
        entries: restitutions,
        destinations: true,
        historical: historical > 0 ? { quantity: historical, actorId } : null,
      });
      track(credit.stock);
      restitutionLog.push(...restitutionEntries(credit));
    }
    let added: SaleBatchSnapshot[] = [];
    if (additions.length) {
      const consumed = await batches.consumeForSale(session, {
        organizationId,
        productId,
        entries: additions,
        unknownExpiryConfirmed: dto.unknownExpiryConfirmed === true,
        // Unités ajoutées AUJOURD'HUI : règle du jour, jamais régularisée.
        occurredAt: new Date(),
        regularize: false,
      });
      track(consumed.stock);
      added = consumed.allocations;
    }
    if (before !== null && last) {
      const final: BatchStockChange = last;
      await this.recordStockThresholds(
        session,
        organizationId,
        productId,
        { ...final, remainingBefore: before },
        `sale-update:${input.operationId}`,
      );
    }
    const next = mergeAllocations(current, returned, added);
    sale.batchHistory = [
      ...(sale.batchHistory ?? []).map((h) => h),
      {
        at: new Date(),
        actorId: new Types.ObjectId(actorId),
        quantityBefore: sale.quantity,
        quantityAfter: target,
        allocationsBefore: current,
        allocationsAfter: next,
        returned,
        added,
        restitutions: restitutionLog,
        reason: restituted > 0 ? dto.restitutionReason!.trim() : null,
      },
    ];
    sale.batchAllocations = next;
    if (target !== sale.quantity) {
      input.changes.quantity = { from: sale.quantity, to: target };
      sale.quantity = target;
    }
    input.changes.batches = {
      returned: allocationSummary(returned),
      added: allocationSummary(added),
      // Lot C : unités rendues à un lot non vendable (statut inchangé).
      ...(nonSellableReturns.length ? { nonSellable: nonSellableReturns } : {}),
      ...(restitutionLog.length
        ? {
            restitutions: restitutionLog.map((r) => ({
              reference: r.reference,
              quantity: r.quantity,
              historical: r.historical,
            })),
            reason: dto.restitutionReason!.trim(),
            originUnknown: true,
          }
        : {}),
    };
  }

  /**
   * Annulation d'une vente d'un produit suivi par lots : unités rendues
   * EXACTEMENT aux lots d'origine enregistrés ; unités d'origine inconnue
   * (vente antérieure à l'activation) restituées seulement vers des
   * destinations explicites, avec motif. Produit purgé : vente annulée sans
   * restitution de stock, comme pour un produit ordinaire.
   */
  private async restoreBatchSale(
    session: MongooseSession,
    input: {
      organizationId: string;
      sale: SaleDocument;
      dto: CancelSaleDto;
      actorId: string;
      tracking: 'batches' | 'none' | 'purged';
    },
  ): Promise<Record<string, unknown>> {
    const { organizationId, sale, dto, actorId } = input;
    const productId = sale.productId.toString();
    const batches = this.requireBatches();
    batches.assertEnabled(organizationId);
    if (input.tracking === 'purged') {
      return { batches: { stockRestored: false, reason: 'product_purged' } };
    }
    const current = (sale.batchAllocations ?? []).map(plainAllocation);
    const unknownOrigin = sale.quantity - sumOf(current);
    const restitutions = dto.restitutions ?? [];
    const historical = dto.historicalRestitution?.quantity ?? 0;
    const restituted = sumOf(restitutions) + historical;
    if (restituted !== unknownOrigin) {
      throw new ConflictException(
        restituted === 0
          ? batchError(
              'SALE_BATCH_RESTITUTION_REQUIRED',
              'Cette vente est antérieure au suivi par lots : indiquez dans quels lots restituer les unités, avec un motif.',
              { unknownOriginQuantity: unknownOrigin },
            )
          : batchError(
              'BATCH_ALLOCATION_MISMATCH',
              "Les unités restituées doivent correspondre exactement à celles dont le lot d'origine est inconnu.",
              { unknownOriginQuantity: unknownOrigin },
            ),
      );
    }
    if (restituted > 0) assertRestitutionReason(dto.restitutionReason);
    let returned: SaleBatchSnapshot[] = [];
    let nonSellable: BatchCreditResult['nonSellable'] = [];
    if (current.length) {
      const credit = await batches.creditBatches(session, {
        organizationId,
        productId,
        entries: current.map((a) => ({
          batchId: a.batchId.toHexString(),
          quantity: a.quantity,
        })),
        destinations: false,
      });
      returned = credit.credited;
      nonSellable = credit.nonSellable;
    }
    const restitutionLog: RestitutionLog[] = [];
    if (restituted > 0) {
      const credit = await batches.creditBatches(session, {
        organizationId,
        productId,
        entries: restitutions,
        destinations: true,
        historical: historical > 0 ? { quantity: historical, actorId } : null,
      });
      restitutionLog.push(...restitutionEntries(credit));
    }
    return {
      batches: {
        returned: allocationSummary(returned),
        ...(nonSellable.length ? { nonSellable } : {}),
        ...(restitutionLog.length
          ? {
              restitutions: restitutionLog.map((r) => ({
                reference: r.reference,
                quantity: r.quantity,
                historical: r.historical,
              })),
              reason: dto.restitutionReason!.trim(),
              originUnknown: true,
            }
          : {}),
      },
    };
  }

  /**
   * 1-16A / 1-16A.1 — événements de stock d'UNE écriture : rupture (passage
   * réel d'un stock positif à zéro) OU, sinon, entrée dans l'état de stock
   * faible (seuil personnalisé du produit, sinon 80 % consommé). Règle
   * centrale `stockAlertFor`. Enregistrés dans la session de la transaction
   * appelante.
   */
  private async recordStockThresholds(
    session: Parameters<PushOutboxService['stockDepletedInSession']>[0],
    organizationId: string,
    productId: string,
    stock: {
      initialQuantity: number;
      remainingBefore: number;
      remainingAfter: number;
      lowStockThreshold: number | null;
    },
    trigger: string,
  ): Promise<void> {
    if (!this.pushOutbox) return;
    const input = { organizationId, productId, trigger };
    const level = {
      initialQuantity: stock.initialQuantity,
      lowStockThreshold: stock.lowStockThreshold,
    };
    const alert = stockAlertFor(
      { ...level, remainingQuantity: stock.remainingBefore },
      { ...level, remainingQuantity: stock.remainingAfter },
    );
    if (alert === 'depleted') {
      await this.pushOutbox.stockDepletedInSession(session, input);
    } else if (alert === 'low') {
      await this.pushOutbox.stockLowInSession(session, input);
    }
  }

  /**
   * 1-12H — diffusion commune à toute l'organisation : identifiants seuls,
   * jamais le prix, le vendeur, l'acheteur ni ses coordonnées. Best effort :
   * une panne d'émission ne transforme jamais une mutation commitée en
   * erreur.
   */
  private emitSaleInvalidation(
    organizationId: string,
    event: 'sale:updated' | 'sale:deleted',
    payload: { _id: string; productId: string },
  ): void {
    try {
      this.eventsGateway.emitToOrganization(organizationId, event, payload);
    } catch {
      this.logger.warn(`${event} non émis (best effort).`);
    }
  }

  async remove(
    organizationId: string,
    id: string,
    actorId: string,
    scopeSellerId?: string,
    cancel: CancelSaleDto = {},
  ): Promise<{ productName: string | null }> {
    const session = await this.connection.startSession();
    let removedProductId: string | undefined;
    // 1-19A : nom figé pour l'activité annoncée au propriétaire.
    let productName: string | null = null;
    try {
      await session.withTransaction(async () => {
        const filter: Record<string, Types.ObjectId> = {
          _id: new Types.ObjectId(id),
          organizationId: new Types.ObjectId(organizationId),
        };
        if (scopeSellerId) filter.sellerId = new Types.ObjectId(scopeSellerId);
        const sale = await this.saleModel
          .findOne(filter, null, { session })
          .exec();
        if (!sale) throw new NotFoundException(`Sale ${id} not found`);

        const productId = sale.productId.toString();
        removedProductId = productId;
        productName = sale.productName ?? sale.lastKnownProductName ?? null;
        const { quantity, salePrice } = sale;
        const tracking = await this.trackingOf(
          session,
          organizationId,
          productId,
        );
        let batchDetails: Record<string, unknown> = {};
        if (tracking === 'batches' || sale.batchAllocations?.length) {
          batchDetails = await this.restoreBatchSale(session, {
            organizationId,
            sale,
            dto: cancel,
            actorId,
            tracking,
          });
        } else {
          await this.productsService.adjustStock(
            organizationId,
            productId,
            quantity,
            session,
          );
        }
        await sale.deleteOne({ session });
        await this.auditService.log(
          organizationId,
          productId,
          AuditAction.SALE_CANCELLED,
          actorId,
          { saleId: id, quantity, salePrice, ...batchDetails },
          session,
        );
      });
    } finally {
      await session.endSession();
    }
    // Après le commit uniquement (un rollback lève avant d'arriver ici).
    if (removedProductId) {
      this.emitSaleInvalidation(organizationId, 'sale:deleted', {
        _id: id,
        productId: removedProductId,
      });
    }
    return { productName };
  }
}
