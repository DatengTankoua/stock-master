import { createHash } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { Product, ProductDocument } from '../schemas/product.schema';
import {
  ProductBatch,
  ProductBatchDocument,
  ProductBatchOrigin,
  ProductBatchStatus,
} from './schemas/product-batch.schema';
import {
  PRODUCT_BATCH_OPERATION_INDEX_KEY,
  ProductBatchOperation,
  ProductBatchOperationDocument,
  ProductBatchOperationKind,
} from './schemas/product-batch-operation.schema';
import {
  BatchIdentityFields,
  EnableBatchTrackingDto,
  ReceiveExistingBatchDto,
  ReceiveNewBatchDto,
  UpdateBatchDto,
} from './dto/product-batch.dto';
import {
  PRODUCT_BATCH_ERROR_CODES as CODES,
  batchError,
} from './product-batch-errors';
import {
  businessDate,
  expiryState,
  saleExpiryCheck,
  type ExpiryState,
} from './business-date';
import { describeProductBatchGuardProblem } from './product-batch-guard';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../audit/schemas/audit-log.schema';
import { processTimeZone } from '../../analytics/month-range';
import type { ProductVisibility } from '../product-projection';
import { ProductsService } from '../products.service';
import { compareFefo } from './batch-order';
import {
  StockLoss,
  StockLossDocument,
  StockLossKind,
  StockLossReason,
} from './schemas/stock-loss.schema';
import type {
  BatchStatusChangeDto,
  CorrectLossDto,
  RecordLossDto,
} from './dto/product-batch.dto';
import { nextExpiryAlertOn } from '../expiry/expiry-alerts';
import { productBatchesEnabledFor } from './product-batches-config';

export { compareFefo };

type MongooseSession = Awaited<ReturnType<Connection['startSession']>>;

/** Lot projeté : quantité présente seulement avec `products.view_stock_details`. */
export interface ProductBatchView {
  _id: string;
  reference: string;
  manufacturerLot: string | null;
  receivedOn: string | null;
  expiryDate: string | null;
  expiryState: ExpiryState;
  status: ProductBatchStatus;
  origin: ProductBatchOrigin;
  createdAt?: Date;
  remainingQuantity?: number;
  /**
   * Lot B — vendable aujourd'hui : disponible, non vide, date non dépassée
   * (jour du commerce). Un lot dépassé garde son stock physique.
   */
  sellable: boolean;
  /** Lot C — dernier changement de statut (motif, date). */
  statusChange?: { from: string; to: string; reason: string; at: Date };
}

export interface ProductBatchesView {
  productId: string;
  productName: string;
  stockTracking: 'none' | 'batches';
  /** Jour civil du commerce (règle commune, jamais celui de l'appareil). */
  businessDate: string;
  timeZone: string;
  /** Plus proche date connue parmi les lots disponibles non vides. */
  nextExpiryDate: string | null;
  /** Des unités disponibles n'ont pas de date de péremption connue. */
  hasUnknownExpiry: boolean;
  /** Date de la fiche avant la reprise (information conservée). */
  legacyExpiryDate: string | null;
  batches: ProductBatchView[];
  totalQuantity?: number;
  /** Lot B — unités vendables aujourd'hui (stock détaillé). */
  sellableQuantity?: number;
  /** Lot B — unités physiques de lots dépassés (disponibles), non vendables. */
  expiredQuantity?: number;
  /** Lot C — unités physiques mises à l'écart (toute date). */
  quarantinedQuantity?: number;
  /** Lot C — unités physiques de lots retirés (restitutions). */
  withdrawnQuantity?: number;
  /** Lot C — pertes nettes de leurs corrections (unités). */
  lostQuantity?: number;
}

export interface BatchOperationResult extends ProductBatchesView {
  batchId?: string;
  /** Clé déjà appliquée : état courant renvoyé, aucune écriture. */
  replayed: boolean;
  /** Cette requête a écrit (faux pour un rejeu ou une modification sans effet). */
  changed: boolean;
}

interface NormalizedIdentity {
  quantity: number;
  manufacturerLot: string | null;
  expiryDate: string | null;
  receivedOn: string | null;
}

/** Lot B — unités d'un lot désigné par le client. */
export interface BatchEntry {
  batchId: string;
  quantity: number;
}

/** Instantané d'un lot figé sur une vente (jamais recalculé). */
export interface SaleBatchSnapshot {
  batchId: Types.ObjectId;
  reference: string;
  expiryDate: string | null;
  manufacturerLot: string | null;
  quantity: number;
}

/** Variation de stock d'une écriture (seuils, notifications). */
export interface BatchStockChange {
  initialQuantity: number;
  remainingBefore: number;
  remainingAfter: number;
  lowStockThreshold: number | null;
}

export interface BatchSaleResult {
  product: ProductDocument;
  allocations: SaleBatchSnapshot[];
  stock: BatchStockChange;
  /** Lots dépassés à la réception, vendus avant (régularisation). */
  regularizedReferences: string[];
}

export interface BatchCreditResult {
  product: ProductDocument;
  credited: SaleBatchSnapshot[];
  /**
   * Lot C — lots crédités NON vendables (mis à l'écart, retirés ou
   * dépassés) : les unités y reviennent physiquement sans redevenir
   * vendables (aucun changement de statut).
   */
  nonSellable: { reference: string; status: string; expired: boolean }[];
  historicalBatch: SaleBatchSnapshot | null;
  stock: BatchStockChange;
}

export interface SaleBatchOption {
  _id: string;
  reference: string;
  manufacturerLot: string | null;
  receivedOn: string | null;
  expiryDate: string | null;
  /** Dernier jour de vente possible (jour du commerce). */
  expiresToday: boolean;
  /** Seulement avec `products.view_stock_details`. */
  remainingQuantity?: number;
}

export interface SaleBatchOptionsView {
  productId: string;
  businessDate: string;
  timeZone: string;
  quantity: number;
  /** Lots datés non dépassés, ordre FEFO. */
  dated: SaleBatchOption[];
  /** Lots sans date : choix explicite après avertissement. */
  undated: SaleBatchOption[];
  excludedExpiredBatches: number;
  /** Suggestion FEFO (lots datés seulement), plafonnée à `quantity`. */
  suggestion: BatchEntry[];
  uncovered: number;
}

function isSellable(batch: ProductBatchDocument, today: string): boolean {
  return (
    batch.status === ProductBatchStatus.AVAILABLE &&
    batch.remainingQuantity > 0 &&
    expiryState(batch.expiryDate ?? null, today) !== 'expired'
  );
}

function snapshotOf(
  batch: ProductBatchDocument,
  quantity: number,
): SaleBatchSnapshot {
  return {
    batchId: batch._id,
    reference: batch.reference,
    expiryDate: batch.expiryDate ?? null,
    manufacturerLot: batch.manufacturerLot ?? null,
    quantity,
  };
}

function stockChange(
  before: ProductDocument,
  after: ProductDocument,
): BatchStockChange {
  return {
    initialQuantity: after.initialQuantity,
    remainingBefore: before.remainingQuantity,
    remainingAfter: after.remainingQuantity,
    lowStockThreshold: after.lowStockThreshold ?? null,
  };
}

function referenceFor(sequence: number): string {
  return `L-${String(sequence).padStart(3, '0')}`;
}

function normalizeIdentity(fields: BatchIdentityFields): NormalizedIdentity {
  return {
    quantity: fields.quantity,
    manufacturerLot: fields.manufacturerLot ?? null,
    expiryDate: fields.expiryDate ?? null,
    receivedOn: fields.receivedOn ?? null,
  };
}

function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isOperationDuplicateKeyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, keyPattern } = error as {
    code?: unknown;
    keyPattern?: unknown;
  };
  if (code !== 11000 || typeof keyPattern !== 'object' || !keyPattern) {
    return false;
  }
  const actual = Object.keys(keyPattern);
  const expected = Object.keys(PRODUCT_BATCH_OPERATION_INDEX_KEY);
  return (
    actual.length === expected.length &&
    expected.every((key, i) => actual[i] === key)
  );
}

/** Tri : péremption la plus proche d'abord (sans date en dernier). */
function compareBatches(a: ProductBatchDocument, b: ProductBatchDocument) {
  const ae = a.expiryDate ?? '9999-12-31';
  const be = b.expiryDate ?? '9999-12-31';
  if (ae !== be) return ae < be ? -1 : 1;
  return a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : 0;
}

/**
 * Lots d'une fiche produit (lot A : structure, réceptions, reprise).
 *
 * Source de vérité : les lots (`productbatches`). La fiche conserve
 * `remainingQuantity` (compatibilité : catalogue, Analyse, alertes), égal à
 * `batchTracking.totalQuantity`, et `initialQuantity` (sens inchangé : stock
 * initial + entrées). Toute écriture de quantité passe par ce service, dans
 * UNE transaction qui met à jour lots, fiche, trace idempotente et journal.
 * Le validateur MongoDB (`product-batch-guard.ts`) refuse toute autre
 * écriture du stock d'un produit suivi par lots.
 */
@Injectable()
export class ProductBatchesService {
  private readonly logger = new Logger(ProductBatchesService.name);

  constructor(
    @InjectModel(Product.name) private productModel: Model<ProductDocument>,
    @InjectModel(ProductBatch.name)
    private batchModel: Model<ProductBatchDocument>,
    @InjectModel(ProductBatchOperation.name)
    private operationModel: Model<ProductBatchOperationDocument>,
    @InjectModel(StockLoss.name)
    private lossModel: Model<StockLossDocument>,
    @InjectConnection() private connection: Connection,
    private auditService: AuditService,
    private productsService: ProductsService,
  ) {}

  private async inTransaction<T>(
    work: (session: MongooseSession) => Promise<T>,
  ): Promise<T> {
    const session = await this.connection.startSession();
    try {
      let result: T | undefined;
      await session.withTransaction(async () => {
        result = await work(session);
      });
      return result as T;
    } finally {
      await session.endSession();
    }
  }

  private productFilter(organizationId: string, productId: string) {
    return {
      _id: new Types.ObjectId(productId),
      organizationId: new Types.ObjectId(organizationId),
    };
  }

  private toView(
    batch: ProductBatchDocument,
    today: string,
    visibility: ProductVisibility,
  ): ProductBatchView {
    const view: ProductBatchView = {
      _id: batch._id.toHexString(),
      reference: batch.reference,
      manufacturerLot: batch.manufacturerLot ?? null,
      receivedOn: batch.receivedOn ?? null,
      expiryDate: batch.expiryDate ?? null,
      expiryState: expiryState(batch.expiryDate ?? null, today),
      status: batch.status,
      origin: batch.origin,
      createdAt: (batch as unknown as { createdAt?: Date }).createdAt,
      sellable: isSellable(batch, today),
      ...(batch.statusChange
        ? {
            statusChange: {
              from: batch.statusChange.from,
              to: batch.statusChange.to,
              reason: batch.statusChange.reason,
              at: batch.statusChange.at,
            },
          }
        : {}),
    };
    if (visibility.stockDetails) {
      view.remainingQuantity = batch.remainingQuantity;
    }
    return view;
  }

  // ─── Lecture ──────────────────────────────────────────────────────────

  async list(
    organizationId: string,
    productId: string,
    visibility: ProductVisibility,
  ): Promise<ProductBatchesView> {
    const product = await this.productModel
      .findOne(this.productFilter(organizationId, productId))
      .exec();
    if (!product) throw new NotFoundException(`Product ${productId} not found`);
    const batches = await this.batchModel
      .find({
        organizationId: new Types.ObjectId(organizationId),
        productId: product._id,
      })
      .exec();
    batches.sort(compareBatches);
    const today = businessDate();
    const stocked = batches.filter(
      (b) =>
        b.status === ProductBatchStatus.AVAILABLE && b.remainingQuantity > 0,
    );
    const dated = stocked
      .map((b) => b.expiryDate)
      .filter((d): d is string => typeof d === 'string')
      .sort();
    const view: ProductBatchesView = {
      productId: product._id.toHexString(),
      productName: product.name,
      stockTracking: product.stockTracking === 'batches' ? 'batches' : 'none',
      businessDate: today,
      timeZone: processTimeZone(),
      nextExpiryDate: dated[0] ?? null,
      hasUnknownExpiry: stocked.some((b) => !b.expiryDate),
      legacyExpiryDate: product.batchTracking?.legacyExpiryDate ?? null,
      batches: batches.map((b) => this.toView(b, today, visibility)),
    };
    if (visibility.stockDetails && product.stockTracking === 'batches') {
      view.totalQuantity = batches.reduce(
        (sum, b) => sum + b.remainingQuantity,
        0,
      );
      view.sellableQuantity = batches
        .filter((b) => isSellable(b, today))
        .reduce((sum, b) => sum + b.remainingQuantity, 0);
      // Lot C : partition SANS double comptage du stock physique :
      // vendable | dépassé (disponible) | mis à l'écart (toute date) |
      // retiré (unités restituées à un lot fermé).
      const sumOf = (pick: (b: ProductBatchDocument) => boolean) =>
        batches.filter(pick).reduce((sum, b) => sum + b.remainingQuantity, 0);
      view.expiredQuantity = sumOf(
        (b) =>
          b.status === ProductBatchStatus.AVAILABLE &&
          expiryState(b.expiryDate ?? null, today) === 'expired',
      );
      view.quarantinedQuantity = sumOf(
        (b) => b.status === ProductBatchStatus.QUARANTINED,
      );
      view.withdrawnQuantity = sumOf(
        (b) => b.status === ProductBatchStatus.WITHDRAWN,
      );
      view.lostQuantity = product.lossTracking?.netQuantity ?? 0;
    }
    return view;
  }

  // ─── Idempotence ──────────────────────────────────────────────────────

  private async findOperation(
    organizationId: string,
    clientOperationId: string,
    primary = false,
  ): Promise<ProductBatchOperationDocument | null> {
    const query = this.operationModel.findOne({
      organizationId: new Types.ObjectId(organizationId),
      clientOperationId,
    });
    if (primary) query.read('primary');
    return query.exec();
  }

  /**
   * Rejeu d'une clé déjà appliquée : aucune écriture. Autre auteur → 409
   * `IDEMPOTENCY_KEY_CONFLICT` (sans donnée) ; autre requête → 409
   * `IDEMPOTENCY_KEY_REUSED` ; sinon l'état COURANT des lots.
   */
  private async replay(
    organizationId: string,
    operation: ProductBatchOperationDocument,
    actorId: string,
    hash: string,
    visibility: ProductVisibility,
  ): Promise<BatchOperationResult> {
    if (operation.actorId.toHexString() !== actorId) {
      throw new ConflictException({
        code: CODES.IDEMPOTENCY_KEY_CONFLICT,
        message: "Clé d'opération déjà utilisée.",
      });
    }
    if (operation.requestHash !== hash) {
      throw new ConflictException({
        code: CODES.IDEMPOTENCY_KEY_REUSED,
        message: "Clé d'opération déjà utilisée pour une autre opération.",
      });
    }
    const view = await this.list(
      organizationId,
      operation.productId.toHexString(),
      visibility,
    );
    return {
      ...view,
      ...(operation.batchId
        ? { batchId: operation.batchId.toHexString() }
        : {}),
      replayed: true,
      changed: false,
    };
  }

  /** Exécution idempotente commune : rejeu, puis écriture, puis rejeu concurrent. */
  private async idempotent(
    organizationId: string,
    clientOperationId: string,
    actorId: string,
    hash: string,
    visibility: ProductVisibility,
    run: () => Promise<string | undefined>,
  ): Promise<BatchOperationResult> {
    const existing = await this.findOperation(
      organizationId,
      clientOperationId,
    );
    if (existing) {
      return this.replay(organizationId, existing, actorId, hash, visibility);
    }
    try {
      const batchId = await run();
      return {
        ...(batchId ? { batchId } : {}),
        replayed: false,
      } as BatchOperationResult;
    } catch (error) {
      if (!isOperationDuplicateKeyError(error)) throw error;
      const winner = await this.findOperation(
        organizationId,
        clientOperationId,
        true,
      );
      if (!winner) throw error;
      return this.replay(organizationId, winner, actorId, hash, visibility);
    }
  }

  private async recordOperation(
    session: MongooseSession,
    input: {
      organizationId: string;
      clientOperationId: string;
      kind: ProductBatchOperationKind;
      actorId: string;
      productId: string;
      batchId: Types.ObjectId | null;
      requestHash: string;
    },
  ): Promise<void> {
    await this.operationModel.create(
      [
        {
          organizationId: new Types.ObjectId(input.organizationId),
          clientOperationId: input.clientOperationId,
          kind: input.kind,
          actorId: new Types.ObjectId(input.actorId),
          productId: new Types.ObjectId(input.productId),
          batchId: input.batchId,
          requestHash: input.requestHash,
        },
      ],
      { session },
    );
  }

  private assertNotInFuture(date: string | null, today: string): void {
    if (date !== null && date > today) {
      throw new BadRequestException({
        code: CODES.BATCH_DATE_IN_FUTURE,
        message: 'La date de réception ne peut pas être dans le futur.',
      });
    }
  }

  /** Produit actif suivi par lots, lu dans la session ; refus explicites sinon. */
  private async trackedProduct(
    organizationId: string,
    productId: string,
    session: MongooseSession,
  ): Promise<ProductDocument> {
    const product = await this.productModel
      .findOne(this.productFilter(organizationId, productId), null, { session })
      .exec();
    if (!product || product.deletedAt) {
      throw new NotFoundException(`Product ${productId} not found`);
    }
    if (product.stockTracking !== 'batches') {
      throw new ConflictException({
        code: CODES.BATCH_TRACKING_NOT_ENABLED,
        message: "Le suivi par lots n'est pas activé pour ce produit.",
      });
    }
    return product;
  }

  /** Mêmes quantités sur la fiche (compatibilité) et le total des lots. */
  private async incrementTrackedStock(
    organizationId: string,
    productId: string,
    quantity: number,
    newBatch: boolean,
    session: MongooseSession,
  ): Promise<ProductDocument> {
    const updated = await this.productModel
      .findOneAndUpdate(
        {
          ...this.productFilter(organizationId, productId),
          deletedAt: null,
          stockTracking: 'batches',
        },
        {
          $inc: {
            remainingQuantity: quantity,
            // Sens historique conservé : une réception est une ENTRÉE de
            // stock, comme `additionalStock` (règle par défaut du stock
            // faible, unités vendues).
            initialQuantity: quantity,
            'batchTracking.totalQuantity': quantity,
            ...(newBatch ? { 'batchTracking.sequence': 1 } : {}),
          },
        },
        { session, returnDocument: 'after' },
      )
      .exec();
    if (!updated) {
      // Relu dans la même session : refus explicite (404 ou non suivi).
      await this.trackedProduct(organizationId, productId, session);
      throw new NotFoundException(`Product ${productId} not found`);
    }
    return updated;
  }

  // ─── Reprise du stock existant ───────────────────────────────────────

  async enableTracking(
    organizationId: string,
    productId: string,
    dto: EnableBatchTrackingDto,
    actorId: string,
    visibility: ProductVisibility,
  ): Promise<BatchOperationResult> {
    const problem = await describeProductBatchGuardProblem(this.connection);
    if (problem) {
      this.logger.error(`Activation des lots refusée : ${problem}.`);
      throw new ServiceUnavailableException({
        code: CODES.PRODUCT_BATCH_GUARD_MISSING,
        message:
          "Le suivi par lots n'est pas disponible pour le moment. Réessayez plus tard.",
      });
    }
    const today = businessDate();
    const lead = await this.productsService.expiryLeadDays(organizationId);
    const batches = dto.batches.map(normalizeIdentity);
    for (const batch of batches)
      this.assertNotInFuture(batch.receivedOn, today);
    const total = batches.reduce((sum, b) => sum + b.quantity, 0);
    if (total !== dto.expectedRemainingQuantity) {
      throw new BadRequestException({
        code: CODES.BATCH_ALLOCATION_MISMATCH,
        message:
          'La somme des lots doit être exactement égale au stock restant.',
        expected: dto.expectedRemainingQuantity,
        allocated: total,
      });
    }
    const hash = requestHash([
      ProductBatchOperationKind.ENABLE_TRACKING,
      productId.toLowerCase(),
      dto.expectedRemainingQuantity,
      batches,
    ]);
    const result = await this.idempotent(
      organizationId,
      dto.clientOperationId,
      actorId,
      hash,
      visibility,
      () =>
        this.inTransaction(async (session) => {
          await this.recordOperation(session, {
            organizationId,
            clientOperationId: dto.clientOperationId,
            kind: ProductBatchOperationKind.ENABLE_TRACKING,
            actorId,
            productId,
            batchId: null,
            requestHash: hash,
          });
          const product = await this.productModel
            .findOne(this.productFilter(organizationId, productId), null, {
              session,
            })
            .exec();
          if (!product || product.deletedAt) {
            throw new NotFoundException(`Product ${productId} not found`);
          }
          if (product.stockTracking === 'batches') {
            throw new ConflictException({
              code: CODES.BATCH_TRACKING_ALREADY_ENABLED,
              message: 'Le suivi par lots est déjà activé pour ce produit.',
            });
          }
          if (!Number.isInteger(product.remainingQuantity)) {
            throw new BadRequestException({
              code: CODES.BATCH_ALLOCATION_MISMATCH,
              message:
                "Le stock de ce produit n'est pas un nombre entier d'unités : répartition impossible.",
            });
          }
          if (product.remainingQuantity !== dto.expectedRemainingQuantity) {
            throw new ConflictException({
              code: CODES.BATCH_STOCK_CHANGED,
              message:
                'Le stock a changé depuis l’affichage. Actualisez puis répartissez à nouveau.',
            });
          }
          const legacyExpiryDate = product.expiryDate ?? null;
          // Écriture conditionnelle (stock et mode inchangés) : une vente
          // concurrente validée entre-temps est détectée (aucune ligne, ou
          // conflit d'écriture rejoué par le pilote).
          const written = await this.productModel
            .updateOne(
              {
                ...this.productFilter(organizationId, productId),
                deletedAt: null,
                stockTracking: null,
                remainingQuantity: dto.expectedRemainingQuantity,
              },
              {
                $set: {
                  stockTracking: 'batches',
                  batchTracking: {
                    totalQuantity: total,
                    sequence: batches.length,
                    enabledAt: new Date(),
                    enabledBy: new Types.ObjectId(actorId),
                    operationId: dto.clientOperationId,
                    legacyExpiryDate,
                  },
                },
                // Après la reprise, les dates des lots font foi : la date de
                // la fiche est conservée dans `legacyExpiryDate` et le
                // journal, jamais appliquée à tout le stock.
                // Lot C : la date de la fiche cesse de produire des alertes
                // (aucun double envoi produit + lots pendant la transition).
                $unset: { expiryDate: 1, expiryAlertNextOn: 1 },
              },
              { session },
            )
            .exec();
          if (written.matchedCount !== 1) {
            throw new ConflictException({
              code: CODES.BATCH_STOCK_CHANGED,
              message:
                'Le stock a changé depuis l’affichage. Actualisez puis répartissez à nouveau.',
            });
          }
          const created = batches.length
            ? await this.batchModel.create(
                batches.map((b, index) => ({
                  organizationId: new Types.ObjectId(organizationId),
                  productId: product._id,
                  reference: referenceFor(index + 1),
                  manufacturerLot: b.manufacturerLot,
                  receivedOn: b.receivedOn,
                  expiryDate: b.expiryDate,
                  expiryAlertNextOn: nextExpiryAlertOn(
                    b.expiryDate,
                    lead,
                    null,
                  ),
                  remainingQuantity: b.quantity,
                  status: ProductBatchStatus.AVAILABLE,
                  origin: ProductBatchOrigin.OPENING,
                  createdBy: new Types.ObjectId(actorId),
                })),
                { session, ordered: true },
              )
            : [];
          await this.auditService.log(
            organizationId,
            productId,
            AuditAction.BATCH_TRACKING_ENABLED,
            actorId,
            {
              clientOperationId: dto.clientOperationId,
              legacyExpiryDate,
              batches: created.map((b) => ({
                batchId: b._id,
                reference: b.reference,
                expiryDate: b.expiryDate,
                receivedOn: b.receivedOn,
                manufacturerLot: b.manufacturerLot,
              })),
              // Quantités : `products.view_stock_details` (projection).
              allocations: created.map((b) => ({
                reference: b.reference,
                quantity: b.remainingQuantity,
              })),
              totalQuantity: total,
            },
            session,
          );
          return undefined;
        }),
    );
    return this.finish(organizationId, productId, result, visibility);
  }

  // ─── Réceptions ───────────────────────────────────────────────────────

  async receiveNew(
    organizationId: string,
    productId: string,
    dto: ReceiveNewBatchDto,
    actorId: string,
    visibility: ProductVisibility,
  ): Promise<BatchOperationResult> {
    const today = businessDate();
    const identity = normalizeIdentity(dto);
    const receivedOn = identity.receivedOn ?? today;
    this.assertNotInFuture(receivedOn, today);
    // `receivedOn` absent : jour du commerce, fixé dans le hash (un rejeu le
    // lendemain avec la même clé reste le même payload).
    const hash = requestHash([
      ProductBatchOperationKind.RECEIVE_NEW,
      productId.toLowerCase(),
      { ...identity, receivedOn: identity.receivedOn },
    ]);
    const batchId = new Types.ObjectId();
    const lead = await this.productsService.expiryLeadDays(organizationId);
    const result = await this.idempotent(
      organizationId,
      dto.clientOperationId,
      actorId,
      hash,
      visibility,
      () =>
        this.inTransaction(async (session) => {
          await this.recordOperation(session, {
            organizationId,
            clientOperationId: dto.clientOperationId,
            kind: ProductBatchOperationKind.RECEIVE_NEW,
            actorId,
            productId,
            batchId,
            requestHash: hash,
          });
          const product = await this.incrementTrackedStock(
            organizationId,
            productId,
            identity.quantity,
            true,
            session,
          );
          const reference = referenceFor(product.batchTracking!.sequence);
          await this.batchModel.create(
            [
              {
                _id: batchId,
                organizationId: new Types.ObjectId(organizationId),
                productId: product._id,
                reference,
                manufacturerLot: identity.manufacturerLot,
                receivedOn,
                expiryDate: identity.expiryDate,
                expiryAlertNextOn: nextExpiryAlertOn(
                  identity.expiryDate,
                  lead,
                  null,
                ),
                remainingQuantity: identity.quantity,
                status: ProductBatchStatus.AVAILABLE,
                origin: ProductBatchOrigin.RECEPTION,
                createdBy: new Types.ObjectId(actorId),
              },
            ],
            { session },
          );
          await this.auditService.log(
            organizationId,
            productId,
            AuditAction.BATCH_RECEIVED,
            actorId,
            {
              clientOperationId: dto.clientOperationId,
              batchId,
              reference,
              newBatch: true,
              receivedOn,
              expiryDate: identity.expiryDate,
              manufacturerLot: identity.manufacturerLot,
              // Quantité : `products.view_stock_details` (projection).
              added: identity.quantity,
            },
            session,
          );
          return batchId.toHexString();
        }),
    );
    return this.finish(organizationId, productId, result, visibility);
  }

  async receiveExisting(
    organizationId: string,
    productId: string,
    batchId: string,
    dto: ReceiveExistingBatchDto,
    actorId: string,
    visibility: ProductVisibility,
  ): Promise<BatchOperationResult> {
    const hash = requestHash([
      ProductBatchOperationKind.RECEIVE_EXISTING,
      productId.toLowerCase(),
      batchId.toLowerCase(),
      dto.quantity,
    ]);
    const batchOid = new Types.ObjectId(batchId);
    const result = await this.idempotent(
      organizationId,
      dto.clientOperationId,
      actorId,
      hash,
      visibility,
      () =>
        this.inTransaction(async (session) => {
          await this.recordOperation(session, {
            organizationId,
            clientOperationId: dto.clientOperationId,
            kind: ProductBatchOperationKind.RECEIVE_EXISTING,
            actorId,
            productId,
            batchId: batchOid,
            requestHash: hash,
          });
          await this.trackedProduct(organizationId, productId, session);
          // Quantité seule : date et numéro fabricant JAMAIS remplacés.
          const batch = await this.batchModel
            .findOneAndUpdate(
              {
                _id: batchOid,
                organizationId: new Types.ObjectId(organizationId),
                productId: new Types.ObjectId(productId),
                status: ProductBatchStatus.AVAILABLE,
              },
              { $inc: { remainingQuantity: dto.quantity } },
              { session, returnDocument: 'after' },
            )
            .exec();
          if (!batch) {
            // Lot C : un lot mis à l'écart ou retiré est fermé aux
            // réceptions ordinaires (refus explicite, rien n'est écrit).
            const closed = await this.batchModel
              .exists({
                _id: batchOid,
                organizationId: new Types.ObjectId(organizationId),
                productId: new Types.ObjectId(productId),
              })
              .session(session)
              .exec();
            if (closed) {
              throw new ConflictException(
                batchError(
                  'BATCH_UNAVAILABLE',
                  "Ce lot est mis à l'écart ou retiré : il ne reçoit plus d'unités.",
                ),
              );
            }
            throw new NotFoundException({
              code: CODES.BATCH_NOT_FOUND,
              message: 'Lot introuvable pour ce produit.',
            });
          }
          await this.incrementTrackedStock(
            organizationId,
            productId,
            dto.quantity,
            false,
            session,
          );
          await this.auditService.log(
            organizationId,
            productId,
            AuditAction.BATCH_RECEIVED,
            actorId,
            {
              clientOperationId: dto.clientOperationId,
              batchId: batch._id,
              reference: batch.reference,
              newBatch: false,
              added: dto.quantity,
            },
            session,
          );
          return batch._id.toHexString();
        }),
    );
    return this.finish(organizationId, productId, result, visibility);
  }

  // ─── Identité ─────────────────────────────────────────────────────────

  async updateBatch(
    organizationId: string,
    productId: string,
    batchId: string,
    dto: UpdateBatchDto,
    actorId: string,
    visibility: ProductVisibility,
  ): Promise<BatchOperationResult> {
    this.assertNotInFuture(dto.receivedOn ?? null, businessDate());
    const changed = await this.inTransaction(async (session) => {
      await this.trackedProduct(organizationId, productId, session);
      const filter = {
        _id: new Types.ObjectId(batchId),
        organizationId: new Types.ObjectId(organizationId),
        productId: new Types.ObjectId(productId),
      };
      const batch = await this.batchModel
        .findOne(filter, null, { session })
        .exec();
      if (!batch) {
        throw new NotFoundException({
          code: CODES.BATCH_NOT_FOUND,
          message: 'Lot introuvable pour ce produit.',
        });
      }
      if (
        dto.receivedOn === null &&
        batch.origin === ProductBatchOrigin.RECEPTION
      ) {
        throw new BadRequestException({
          code: CODES.BATCH_RECEIVED_ON_REQUIRED,
          message:
            "La date de réception d'un lot reçu ne peut pas être retirée.",
        });
      }
      const changes: Record<
        string,
        { from: string | null; to: string | null }
      > = {};
      const $set: Record<string, string | null> = {};
      for (const field of [
        'manufacturerLot',
        'receivedOn',
        'expiryDate',
      ] as const) {
        if (dto[field] === undefined) continue;
        const from = batch[field] ?? null;
        const to = dto[field] ?? null;
        if (from === to) continue;
        changes[field] = { from, to };
        $set[field] = to;
      }
      if (Object.keys($set).length === 0) return false;
      // Lot C : nouvelle échéance → étapes replanifiées ; une échéance déjà
      // annoncée ne l'est jamais deux fois (marques conservées).
      if ('expiryDate' in $set) {
        $set.expiryAlertNextOn = nextExpiryAlertOn(
          $set.expiryDate,
          await this.productsService.expiryLeadDays(organizationId),
          batch.expiryAlerts,
        );
      }
      // Aucune quantité modifiée : une correction d'identité n'est jamais
      // une réception.
      await this.batchModel.updateOne(filter, { $set }, { session }).exec();
      await this.auditService.log(
        organizationId,
        productId,
        AuditAction.BATCH_UPDATED,
        actorId,
        { batchId: batch._id, reference: batch.reference, changes },
        session,
      );
      return true;
    });
    return this.finish(
      organizationId,
      productId,
      { batchId, replayed: false } as BatchOperationResult,
      visibility,
      changed,
    );
  }

  // ─── Lot B : ventes ───────────────────────────────────────────────────

  /**
   * Options de vente (`GET /products/:id/batches/sale-options`). Projection
   * MINIMALE pour choisir les lots : identité, dates, état de date, et une
   * suggestion FEFO plafonnée à la quantité demandée. Quantités par lot
   * seulement avec `products.view_stock_details`.
   *
   * - FEFO : lots datés non dépassés, péremption la plus proche d'abord ;
   *   égalité → réception la plus ancienne (inconnue en dernier), puis
   *   référence, puis identifiant (ordre total, déterministe).
   * - Lots sans date : listés À PART, jamais suggérés (choix explicite
   *   après avertissement, `unknownExpiryConfirmed`).
   * - Lots dépassés, vides ou non disponibles : exclus.
   * Une suggestion ne réserve rien : la confirmation revalide tout.
   */
  async saleOptions(
    organizationId: string,
    productId: string,
    quantity: number,
    visibility: ProductVisibility,
  ): Promise<SaleBatchOptionsView> {
    const product = await this.productModel
      .findOne({ ...this.productFilter(organizationId, productId) })
      .exec();
    if (!product || product.deletedAt) {
      throw new NotFoundException(`Product ${productId} not found`);
    }
    if (product.stockTracking !== 'batches') {
      throw new ConflictException(
        batchError(
          'BATCH_TRACKING_NOT_ENABLED',
          "Le suivi par lots n'est pas activé pour ce produit.",
        ),
      );
    }
    const today = businessDate();
    const stocked = await this.batchModel
      .find({
        organizationId: new Types.ObjectId(organizationId),
        productId: product._id,
        status: ProductBatchStatus.AVAILABLE,
        remainingQuantity: { $gt: 0 },
      })
      .exec();
    const dated = stocked
      .filter((b) => b.expiryDate && b.expiryDate >= today)
      .sort(compareFefo);
    const undated = stocked.filter((b) => !b.expiryDate).sort(compareFefo);
    const excludedExpired = stocked.filter(
      (b) => b.expiryDate && b.expiryDate < today,
    ).length;
    let need = quantity;
    const suggestion: { batchId: string; quantity: number }[] = [];
    for (const batch of dated) {
      if (need <= 0) break;
      const take = Math.min(need, batch.remainingQuantity);
      suggestion.push({ batchId: batch._id.toHexString(), quantity: take });
      need -= take;
    }
    const option = (b: ProductBatchDocument): SaleBatchOption => ({
      _id: b._id.toHexString(),
      reference: b.reference,
      manufacturerLot: b.manufacturerLot ?? null,
      receivedOn: b.receivedOn ?? null,
      expiryDate: b.expiryDate ?? null,
      expiresToday: b.expiryDate === today,
      ...(visibility.stockDetails
        ? { remainingQuantity: b.remainingQuantity }
        : {}),
    });
    return {
      productId: product._id.toHexString(),
      businessDate: today,
      timeZone: processTimeZone(),
      quantity,
      dated: dated.map(option),
      undated: undated.map(option),
      excludedExpiredBatches: excludedExpired,
      suggestion,
      // Unités non couvertes par les lots datés (jamais compensées par un
      // lot sans date sans choix explicite).
      uncovered: need,
    };
  }

  /** Mode de suivi du produit d'une vente, lu dans la session. */
  async trackingOf(
    session: MongooseSession,
    organizationId: string,
    productId: string,
  ): Promise<'batches' | 'none' | 'purged'> {
    const product = await this.productModel
      .findOne(this.productFilter(organizationId, productId), null, { session })
      .select({ stockTracking: 1 })
      .exec();
    if (!product) return 'purged';
    return product.stockTracking === 'batches' ? 'batches' : 'none';
  }

  /**
   * Fonctionnalité désactivée : aucune vente ni correction par lots. 409
   * (refus métier) et non 403 : l'outbox hors ligne traite un 403 comme un
   * accès révoqué et bloquerait TOUTES les ventes en attente.
   */
  assertEnabled(organizationId: string): void {
    if (!productBatchesEnabledFor(organizationId)) {
      throw new ConflictException(
        batchError(
          'PRODUCT_BATCHES_DISABLED',
          "Le suivi par lots n'est pas disponible.",
        ),
      );
    }
  }

  /** Produit actif suivi par lots, lu dans la session (vente / ajout). */
  private async sellableProduct(
    organizationId: string,
    productId: string,
    session?: MongooseSession,
  ): Promise<ProductDocument> {
    const product = await this.productModel
      .findOne(this.productFilter(organizationId, productId), null, { session })
      .exec();
    if (!product || product.deletedAt) {
      throw new NotFoundException({
        code: 'PRODUCT_NOT_FOUND',
        message: `Product ${productId} not found`,
      });
    }
    if (product.stockTracking !== 'batches') {
      throw new ConflictException(
        batchError(
          'BATCH_TRACKING_NOT_ENABLED',
          "Le suivi par lots n'est pas activé pour ce produit.",
        ),
      );
    }
    return product;
  }

  private assertDistinct(entries: readonly BatchEntry[]): void {
    const ids = entries.map((e) => e.batchId.toLowerCase());
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException(
        batchError(
          'BATCH_ALLOCATION_MISMATCH',
          "Chaque lot ne peut apparaître qu'une fois.",
        ),
      );
    }
  }

  /** Lots désignés, lus dans la session, du MÊME commerce et produit. */
  private async batchesFor(
    organizationId: string,
    productId: string,
    entries: readonly BatchEntry[],
    session?: MongooseSession,
  ): Promise<Map<string, ProductBatchDocument>> {
    const batches = await this.batchModel
      .find(
        {
          _id: { $in: entries.map((e) => new Types.ObjectId(e.batchId)) },
          organizationId: new Types.ObjectId(organizationId),
          productId: new Types.ObjectId(productId),
        },
        null,
        { session },
      )
      .exec();
    const byId = new Map(batches.map((b) => [b._id.toHexString(), b]));
    const missing = entries.filter((e) => !byId.has(e.batchId.toLowerCase()));
    if (missing.length > 0) {
      // Lot d'un autre produit ou commerce : indistinguable d'un absent.
      throw new ConflictException(
        batchError(
          'BATCH_UNAVAILABLE',
          "Un lot choisi n'est plus disponible. Actualisez les lots.",
        ),
      );
    }
    return byId;
  }

  /**
   * Lot B — éligibilité d'une demande de régularisation (lecture seule) :
   * produit actif suivi, lots du même commerce et produit, disponibles,
   * dates confirmées ; au moins un lot `expired_at_sync` et aucun lot
   * dépassé au jour DÉCLARÉ. Les quantités sont revalidées à l'approbation
   * (rien n'est réservé par une demande).
   */
  async regularizationEligibility(input: {
    organizationId: string;
    productId: string;
    entries: readonly BatchEntry[];
    unknownExpiryConfirmed: boolean;
    occurredAt: Date;
  }): Promise<{
    product: ProductDocument;
    lines: SaleBatchSnapshot[];
    expiredReferences: string[];
  }> {
    this.assertDistinct(input.entries);
    const product = await this.sellableProduct(
      input.organizationId,
      input.productId,
    );
    const byId = await this.batchesFor(
      input.organizationId,
      input.productId,
      input.entries,
    );
    const today = businessDate();
    const saleDay = businessDate(input.occurredAt);
    const expiredReferences: string[] = [];
    for (const entry of input.entries) {
      const batch = byId.get(entry.batchId.toLowerCase())!;
      const ref = { references: [batch.reference] };
      if (batch.status !== ProductBatchStatus.AVAILABLE) {
        throw new ConflictException(
          batchError(
            'BATCH_UNAVAILABLE',
            "Un lot choisi n'est plus disponible. Actualisez les lots.",
            ref,
          ),
        );
      }
      if (!batch.expiryDate) {
        if (!input.unknownExpiryConfirmed) {
          throw new ConflictException(
            batchError(
              'BATCH_EXPIRY_UNCONFIRMED',
              'Un lot choisi n’a pas de date de péremption connue : confirmez ce choix.',
              ref,
            ),
          );
        }
        continue;
      }
      const check = saleExpiryCheck(batch.expiryDate, today, saleDay);
      if (check === 'expired') {
        throw new ConflictException(
          batchError(
            'BATCH_EXPIRED',
            'Un lot choisi a dépassé sa date de péremption : il ne peut pas être vendu.',
            ref,
          ),
        );
      }
      if (check === 'expired_at_sync') expiredReferences.push(batch.reference);
    }
    if (expiredReferences.length === 0) {
      throw new ConflictException(
        batchError(
          'SALE_REGULARIZATION_NOT_NEEDED',
          "Cette vente n'a pas besoin de régularisation : renvoyez-la normalement.",
        ),
      );
    }
    return {
      product,
      lines: input.entries
        .map((e) => byId.get(e.batchId.toLowerCase())!)
        .sort(compareFefo)
        .map((b) =>
          snapshotOf(
            b,
            input.entries.find(
              (e) => e.batchId.toLowerCase() === b._id.toHexString(),
            )!.quantity,
          ),
        ),
      expiredReferences,
    };
  }

  /**
   * Décrémente les lots désignés ET la fiche, dans la session appelante
   * (vente ou ajout d'une correction). Aucun lot n'est jamais substitué.
   * Écritures conditionnelles (`remainingQuantity ≥ q`, statut disponible) :
   * une vente concurrente ne produit ni quantité négative ni double
   * décrément ; un échec annule toute la transaction (aucune vente
   * partielle).
   */
  async consumeForSale(
    session: MongooseSession,
    input: {
      organizationId: string;
      productId: string;
      entries: readonly BatchEntry[];
      unknownExpiryConfirmed: boolean;
      /** Instant de la vente retenu par le serveur. */
      occurredAt: Date;
      /** Régularisation explicite autorisée (`BATCH_EXPIRED_AT_SYNC`). */
      regularize: boolean;
    },
  ): Promise<BatchSaleResult> {
    this.assertDistinct(input.entries);
    const product = await this.sellableProduct(
      input.organizationId,
      input.productId,
      session,
    );
    const byId = await this.batchesFor(
      input.organizationId,
      input.productId,
      input.entries,
      session,
    );
    const today = businessDate();
    const saleDay = businessDate(input.occurredAt);
    const regularized: string[] = [];
    for (const entry of input.entries) {
      const batch = byId.get(entry.batchId.toLowerCase())!;
      const ref = { references: [batch.reference] };
      if (batch.status !== ProductBatchStatus.AVAILABLE) {
        throw new ConflictException(
          batchError(
            'BATCH_UNAVAILABLE',
            "Un lot choisi n'est plus disponible. Actualisez les lots.",
            ref,
          ),
        );
      }
      if (!batch.expiryDate) {
        if (!input.unknownExpiryConfirmed) {
          throw new ConflictException(
            batchError(
              'BATCH_EXPIRY_UNCONFIRMED',
              'Un lot choisi n’a pas de date de péremption connue : confirmez ce choix.',
              ref,
            ),
          );
        }
        continue;
      }
      const check = saleExpiryCheck(batch.expiryDate, today, saleDay);
      if (check === 'expired') {
        throw new ConflictException(
          batchError(
            'BATCH_EXPIRED',
            'Un lot choisi a dépassé sa date de péremption : il ne peut pas être vendu.',
            ref,
          ),
        );
      }
      if (check === 'expired_at_sync') {
        if (!input.regularize) {
          throw new ConflictException(
            batchError(
              'BATCH_EXPIRED_AT_SYNC',
              'Vente saisie avant la péremption du lot mais reçue après : une régularisation autorisée est nécessaire.',
              ref,
            ),
          );
        }
        regularized.push(batch.reference);
      }
    }
    const total = input.entries.reduce((s, e) => s + e.quantity, 0);
    for (const entry of input.entries) {
      const batch = byId.get(entry.batchId.toLowerCase())!;
      const written = await this.batchModel
        .updateOne(
          {
            _id: batch._id,
            organizationId: batch.organizationId,
            productId: batch.productId,
            status: ProductBatchStatus.AVAILABLE,
            remainingQuantity: { $gte: entry.quantity },
          },
          { $inc: { remainingQuantity: -entry.quantity } },
          { session },
        )
        .exec();
      if (written.matchedCount !== 1) {
        throw new ConflictException(
          batchError(
            'BATCH_INSUFFICIENT',
            "Un lot choisi n'a plus assez d'unités. Actualisez les lots.",
            { references: [batch.reference] },
          ),
        );
      }
    }
    const after = await this.productModel
      .findOneAndUpdate(
        {
          ...this.productFilter(input.organizationId, input.productId),
          deletedAt: null,
          stockTracking: 'batches',
          remainingQuantity: { $gte: total },
        },
        {
          $inc: {
            remainingQuantity: -total,
            'batchTracking.totalQuantity': -total,
          },
        },
        { session, returnDocument: 'after' },
      )
      .exec();
    if (!after) {
      throw new ConflictException(
        batchError(
          'BATCH_INSUFFICIENT',
          'Le stock a changé. Actualisez les lots.',
        ),
      );
    }
    return {
      product: after,
      // Ordre FEFO stable, indépendant de l'ordre envoyé.
      allocations: input.entries
        .map((e) => byId.get(e.batchId.toLowerCase())!)
        .sort(compareFefo)
        .map((b) =>
          snapshotOf(
            b,
            input.entries.find(
              (e) => e.batchId.toLowerCase() === b._id.toHexString(),
            )!.quantity,
          ),
        ),
      stock: stockChange(product, after),
      regularizedReferences: regularized,
    };
  }

  /**
   * Crédite des lots EXISTANTS du produit (retour aux lots d'origine d'une
   * vente, ou restitution vers une destination choisie) et la fiche, dans
   * la session appelante. Jamais une réception : `initialQuantity`
   * inchangée. Un lot dépassé retrouve ses unités physiques sans redevenir
   * vendable (la date reste dépassée). `destinations` : lot retiré refusé.
   * Produit purgé : 409 `SALE_PRODUCT_PURGED` (aucune restitution dans un
   * produit inexistant).
   */
  async creditBatches(
    session: MongooseSession,
    input: {
      organizationId: string;
      productId: string;
      entries: readonly BatchEntry[];
      /** Restitution vers une destination (et non retour à l'origine). */
      destinations: boolean;
      /** Lot historique « date inconnue » à créer (restitution). */
      historical?: { quantity: number; actorId: string } | null;
    },
  ): Promise<BatchCreditResult> {
    this.assertDistinct(input.entries);
    const product = await this.productModel
      .findOne(
        this.productFilter(input.organizationId, input.productId),
        null,
        { session },
      )
      .exec();
    if (!product) {
      throw new ConflictException(
        batchError(
          'SALE_PRODUCT_PURGED',
          'Le produit a été supprimé définitivement : aucune restitution de stock possible.',
        ),
      );
    }
    if (product.stockTracking !== 'batches') {
      throw new ConflictException(
        batchError(
          'BATCH_TRACKING_NOT_ENABLED',
          "Le suivi par lots n'est pas activé pour ce produit.",
        ),
      );
    }
    const byId = input.entries.length
      ? await this.batchesFor(
          input.organizationId,
          input.productId,
          input.entries,
          session,
        )
      : new Map<string, ProductBatchDocument>();
    const credited: SaleBatchSnapshot[] = [];
    const nonSellable: BatchCreditResult['nonSellable'] = [];
    const today = businessDate();
    for (const entry of input.entries) {
      const batch = byId.get(entry.batchId.toLowerCase())!;
      if (input.destinations && batch.status === ProductBatchStatus.WITHDRAWN) {
        throw new ConflictException(
          batchError(
            'BATCH_UNAVAILABLE',
            "Un lot choisi n'est plus disponible. Actualisez les lots.",
            { references: [batch.reference] },
          ),
        );
      }
      await this.batchModel
        .updateOne(
          { _id: batch._id, organizationId: batch.organizationId },
          { $inc: { remainingQuantity: entry.quantity } },
          { session },
        )
        .exec();
      credited.push(snapshotOf(batch, entry.quantity));
      const expired =
        expiryState(batch.expiryDate ?? null, today) === 'expired';
      if (batch.status !== ProductBatchStatus.AVAILABLE || expired) {
        nonSellable.push({
          reference: batch.reference,
          status: batch.status,
          expired,
        });
      }
    }
    const historicalQty = input.historical?.quantity ?? 0;
    const total =
      input.entries.reduce((s, e) => s + e.quantity, 0) + historicalQty;
    const after = await this.productModel
      .findOneAndUpdate(
        {
          ...this.productFilter(input.organizationId, input.productId),
          stockTracking: 'batches',
        },
        {
          $inc: {
            remainingQuantity: total,
            'batchTracking.totalQuantity': total,
            ...(historicalQty > 0 ? { 'batchTracking.sequence': 1 } : {}),
          },
        },
        { session, returnDocument: 'after' },
      )
      .exec();
    if (!after) {
      throw new ConflictException(
        batchError(
          'SALE_PRODUCT_PURGED',
          'Le produit a été supprimé définitivement : aucune restitution de stock possible.',
        ),
      );
    }
    let historicalBatch: SaleBatchSnapshot | null = null;
    if (input.historical && historicalQty > 0) {
      const [created] = await this.batchModel.create(
        [
          {
            organizationId: new Types.ObjectId(input.organizationId),
            productId: after._id,
            reference: referenceFor(after.batchTracking!.sequence),
            manufacturerLot: null,
            receivedOn: null,
            expiryDate: null,
            remainingQuantity: historicalQty,
            status: ProductBatchStatus.AVAILABLE,
            origin: ProductBatchOrigin.RESTITUTION,
            createdBy: new Types.ObjectId(input.historical.actorId),
          },
        ],
        { session },
      );
      historicalBatch = snapshotOf(created, historicalQty);
    }
    return {
      product: after,
      credited,
      nonSellable,
      historicalBatch,
      stock: stockChange(product, after),
    };
  }

  // ─── Lot C : mise à l'écart ───────────────────────────────────────────

  /**
   * Mise à l'écart d'un lot ENTIER (`available` → `quarantined`) ou remise
   * à disposition (`quarantined` / `withdrawn` → `available`), motif
   * obligatoire. Aucun mouvement de quantité : le stock physique est
   * inchangé ; le lot sort (ou revient dans) la quantité vendable. Une date
   * dépassée continue d'interdire la vente. Écriture conditionnée au statut
   * lu (deux demandes concurrentes : une seule s'applique).
   */
  async changeStatus(
    organizationId: string,
    productId: string,
    batchId: string,
    action: 'quarantine' | 'release',
    dto: BatchStatusChangeDto,
    actorId: string,
    visibility: ProductVisibility,
  ): Promise<BatchOperationResult> {
    const from =
      action === 'quarantine'
        ? [ProductBatchStatus.AVAILABLE]
        : [ProductBatchStatus.QUARANTINED, ProductBatchStatus.WITHDRAWN];
    const to =
      action === 'quarantine'
        ? ProductBatchStatus.QUARANTINED
        : ProductBatchStatus.AVAILABLE;
    await this.inTransaction(async (session) => {
      await this.trackedProduct(organizationId, productId, session);
      const filter = {
        _id: new Types.ObjectId(batchId),
        organizationId: new Types.ObjectId(organizationId),
        productId: new Types.ObjectId(productId),
      };
      const batch = await this.batchModel
        .findOne(filter, null, { session })
        .exec();
      if (!batch) {
        throw new NotFoundException(
          batchError('BATCH_NOT_FOUND', 'Lot introuvable pour ce produit.'),
        );
      }
      if (!from.includes(batch.status)) {
        throw new ConflictException(
          batchError(
            'BATCH_STATUS_UNCHANGED',
            "Ce lot est déjà dans cet état ou ne peut pas changer d'état ainsi.",
          ),
        );
      }
      const at = new Date();
      const written = await this.batchModel
        .updateOne(
          { ...filter, status: batch.status },
          {
            $set: {
              status: to,
              statusChange: {
                from: batch.status,
                to,
                reason: dto.reason.trim(),
                by: new Types.ObjectId(actorId),
                at,
              },
            },
          },
          { session },
        )
        .exec();
      if (written.matchedCount !== 1) {
        throw new ConflictException(
          batchError(
            'BATCH_STATUS_UNCHANGED',
            "Ce lot est déjà dans cet état ou ne peut pas changer d'état ainsi.",
          ),
        );
      }
      await this.auditService.log(
        organizationId,
        productId,
        AuditAction.BATCH_STATUS_CHANGED,
        actorId,
        {
          batchId: batch._id,
          reference: batch.reference,
          status: { from: batch.status, to },
          reason: dto.reason.trim(),
          // Stock physique inchangé (quantité : détail du stock).
          remainingQuantity: batch.remainingQuantity,
        },
        session,
      );
    });
    return this.finish(
      organizationId,
      productId,
      { batchId, replayed: false } as BatchOperationResult,
      visibility,
    );
  }

  // ─── Lot C : pertes ───────────────────────────────────────────────────

  /**
   * Perte (sortie définitive) d'unités d'un lot, idempotente
   * (`clientOperationId`). Une transaction : trace, lot, fiche
   * (`remainingQuantity`, `batchTracking.totalQuantity`,
   * `lossTracking`), mouvement, journal, alerte de stock éventuelle.
   * Jamais une vente : `initialQuantity`, ventes et chiffre d'affaires
   * inchangés. Écritures conditionnelles : une vente concurrente ne peut
   * jamais rendre une quantité négative (refus 409, rien n'est écrit).
   * Une perte de TOUT le stock restant ferme le lot (`withdrawn`).
   */
  async recordLoss(
    organizationId: string,
    productId: string,
    batchId: string,
    dto: RecordLossDto,
    actorId: string,
    visibility: ProductVisibility,
  ): Promise<BatchOperationResult & { lossId?: string }> {
    const comment = dto.comment?.trim() || null;
    if (dto.reason === 'other' && (!comment || comment.length < 3)) {
      throw new BadRequestException(
        batchError(
          'LOSS_COMMENT_REQUIRED',
          'Précisez la cause de la perte dans le commentaire.',
        ),
      );
    }
    const hash = requestHash([
      ProductBatchOperationKind.LOSS,
      productId.toLowerCase(),
      batchId.toLowerCase(),
      dto.quantity,
      dto.reason,
      comment,
    ]);
    const lossId = new Types.ObjectId();
    const result = await this.idempotent(
      organizationId,
      dto.clientOperationId,
      actorId,
      hash,
      visibility,
      () =>
        this.inTransaction(async (session) => {
          await this.recordOperation(session, {
            organizationId,
            clientOperationId: dto.clientOperationId,
            kind: ProductBatchOperationKind.LOSS,
            actorId,
            productId,
            batchId: new Types.ObjectId(batchId),
            requestHash: hash,
          });
          const before = await this.trackedProduct(
            organizationId,
            productId,
            session,
          );
          if (before.deletedAt) {
            throw new NotFoundException(`Product ${productId} not found`);
          }
          const filter = {
            _id: new Types.ObjectId(batchId),
            organizationId: new Types.ObjectId(organizationId),
            productId: new Types.ObjectId(productId),
          };
          const batch = await this.batchModel
            .findOne(filter, null, { session })
            .exec();
          if (!batch) {
            throw new NotFoundException(
              batchError('BATCH_NOT_FOUND', 'Lot introuvable pour ce produit.'),
            );
          }
          if (dto.quantity > batch.remainingQuantity) {
            throw new ConflictException(
              batchError(
                'BATCH_INSUFFICIENT',
                "Un lot choisi n'a plus assez d'unités. Actualisez les lots.",
                { references: [batch.reference] },
              ),
            );
          }
          const closes = dto.quantity === batch.remainingQuantity;
          const statusAfter = closes
            ? ProductBatchStatus.WITHDRAWN
            : batch.status;
          const at = new Date();
          const written = await this.batchModel
            .updateOne(
              {
                ...filter,
                // Fermeture : exactement le stock lu ; sinon ≥ quantité.
                remainingQuantity: closes
                  ? batch.remainingQuantity
                  : { $gte: dto.quantity },
              },
              {
                $inc: { remainingQuantity: -dto.quantity },
                ...(closes && batch.status !== ProductBatchStatus.WITHDRAWN
                  ? {
                      $set: {
                        status: ProductBatchStatus.WITHDRAWN,
                        statusChange: {
                          from: batch.status,
                          to: ProductBatchStatus.WITHDRAWN,
                          reason: 'loss',
                          by: new Types.ObjectId(actorId),
                          at,
                        },
                      },
                    }
                  : {}),
              },
              { session },
            )
            .exec();
          if (written.matchedCount !== 1) {
            throw new ConflictException(
              batchError(
                'BATCH_INSUFFICIENT',
                "Un lot choisi n'a plus assez d'unités. Actualisez les lots.",
                { references: [batch.reference] },
              ),
            );
          }
          const unitCost = before.purchasePrice;
          const after = await this.productModel
            .findOneAndUpdate(
              {
                ...this.productFilter(organizationId, productId),
                stockTracking: 'batches',
                remainingQuantity: { $gte: dto.quantity },
              },
              {
                $inc: {
                  remainingQuantity: -dto.quantity,
                  'batchTracking.totalQuantity': -dto.quantity,
                  'lossTracking.netQuantity': dto.quantity,
                  'lossTracking.netValueAtCost': dto.quantity * unitCost,
                },
              },
              { session, returnDocument: 'after' },
            )
            .exec();
          if (!after) {
            throw new ConflictException(
              batchError(
                'BATCH_INSUFFICIENT',
                'Le stock a changé. Actualisez les lots.',
              ),
            );
          }
          await this.lossModel.create(
            [
              {
                _id: lossId,
                organizationId: new Types.ObjectId(organizationId),
                productId: before._id,
                batchId: batch._id,
                batchReference: batch.reference,
                kind: StockLossKind.LOSS,
                quantity: dto.quantity,
                reason: dto.reason as StockLossReason,
                comment,
                actorId: new Types.ObjectId(actorId),
                unitCostAtMovement: unitCost,
                correctsLossId: null,
                correctedQuantity: 0,
                statusBefore: batch.status,
                statusAfter,
                clientOperationId: dto.clientOperationId,
              },
            ],
            { session },
          );
          await this.auditService.log(
            organizationId,
            productId,
            AuditAction.BATCH_LOSS_RECORDED,
            actorId,
            {
              lossId,
              batchId: batch._id,
              reference: batch.reference,
              reason: dto.reason,
              comment,
              lostQuantity: dto.quantity,
              valueAtCost: dto.quantity * unitCost,
              status: { from: batch.status, to: statusAfter },
            },
            session,
          );
          // Base du seuil : stock physique (une perte peut le franchir,
          // sans jamais compter comme une vente).
          await this.productsService.recordStockAlert(
            session,
            organizationId,
            productId,
            before,
            after,
            `loss:${lossId.toHexString()}`,
          );
          return batch._id.toHexString();
        }),
    );
    const done = await this.finish(
      organizationId,
      productId,
      result,
      visibility,
    );
    return {
      ...done,
      ...(result.replayed ? {} : { lossId: lossId.toHexString() }),
    };
  }

  /**
   * Correction d'une perte saisie par erreur : contre-mouvement LIÉ à la
   * perte d'origine, jamais une suppression. Unités rendues au même lot,
   * sans changer son statut (un lot fermé, mis à l'écart ou dépassé reste
   * non vendable) ; `initialQuantity` inchangée. `correctedQuantity` de la
   * perte est augmenté conditionnellement : jamais plus que la quantité
   * perdue (aucune double restitution, même concurrente).
   */
  async correctLoss(
    organizationId: string,
    productId: string,
    lossId: string,
    dto: CorrectLossDto,
    actorId: string,
    visibility: ProductVisibility,
  ): Promise<BatchOperationResult> {
    const hash = requestHash([
      ProductBatchOperationKind.LOSS_CORRECTION,
      productId.toLowerCase(),
      lossId.toLowerCase(),
      dto.quantity,
      dto.comment.trim(),
    ]);
    const result = await this.idempotent(
      organizationId,
      dto.clientOperationId,
      actorId,
      hash,
      visibility,
      () =>
        this.inTransaction(async (session) => {
          const original = await this.lossModel
            .findOneAndUpdate(
              {
                _id: new Types.ObjectId(lossId),
                organizationId: new Types.ObjectId(organizationId),
                productId: new Types.ObjectId(productId),
                kind: StockLossKind.LOSS,
                $expr: {
                  $lte: [
                    { $add: ['$correctedQuantity', dto.quantity] },
                    '$quantity',
                  ],
                },
              },
              { $inc: { correctedQuantity: dto.quantity } },
              { session, returnDocument: 'before' },
            )
            .exec();
          if (!original) {
            const exists = await this.lossModel
              .exists({
                _id: new Types.ObjectId(lossId),
                organizationId: new Types.ObjectId(organizationId),
                productId: new Types.ObjectId(productId),
                kind: StockLossKind.LOSS,
              })
              .session(session)
              .exec();
            throw exists
              ? new ConflictException(
                  batchError(
                    'LOSS_CORRECTION_EXCEEDS',
                    'La correction dépasse les unités perdues non encore corrigées.',
                  ),
                )
              : new NotFoundException(
                  batchError(
                    'LOSS_NOT_FOUND',
                    'Perte introuvable pour ce produit.',
                  ),
                );
          }
          await this.recordOperation(session, {
            organizationId,
            clientOperationId: dto.clientOperationId,
            kind: ProductBatchOperationKind.LOSS_CORRECTION,
            actorId,
            productId,
            batchId: original.batchId,
            requestHash: hash,
          });
          const product = await this.trackedProduct(
            organizationId,
            productId,
            session,
          );
          const batch = await this.batchModel
            .findOneAndUpdate(
              {
                _id: original.batchId,
                organizationId: new Types.ObjectId(organizationId),
              },
              // Statut INCHANGÉ : jamais de remise à disposition implicite.
              { $inc: { remainingQuantity: dto.quantity } },
              { session, returnDocument: 'after' },
            )
            .exec();
          if (!batch) {
            throw new NotFoundException(
              batchError('BATCH_NOT_FOUND', 'Lot introuvable pour ce produit.'),
            );
          }
          const value = dto.quantity * original.unitCostAtMovement;
          await this.productModel
            .updateOne(
              { _id: product._id, stockTracking: 'batches' },
              {
                $inc: {
                  remainingQuantity: dto.quantity,
                  'batchTracking.totalQuantity': dto.quantity,
                  'lossTracking.netQuantity': -dto.quantity,
                  'lossTracking.netValueAtCost': -value,
                },
              },
              { session },
            )
            .exec();
          const correctionId = new Types.ObjectId();
          await this.lossModel.create(
            [
              {
                _id: correctionId,
                organizationId: new Types.ObjectId(organizationId),
                productId: product._id,
                batchId: original.batchId,
                batchReference: original.batchReference,
                kind: StockLossKind.CORRECTION,
                quantity: dto.quantity,
                reason: null,
                comment: dto.comment.trim(),
                actorId: new Types.ObjectId(actorId),
                unitCostAtMovement: original.unitCostAtMovement,
                correctsLossId: original._id,
                correctedQuantity: 0,
                statusBefore: batch.status,
                statusAfter: batch.status,
                clientOperationId: dto.clientOperationId,
              },
            ],
            { session },
          );
          await this.auditService.log(
            organizationId,
            productId,
            AuditAction.BATCH_LOSS_CORRECTED,
            actorId,
            {
              lossId: original._id,
              correctionId,
              reference: original.batchReference,
              restoredQuantity: dto.quantity,
              valueAtCost: value,
              comment: dto.comment.trim(),
              status: batch.status,
            },
            session,
          );
          return original.batchId.toHexString();
        }),
    );
    return this.finish(organizationId, productId, result, visibility);
  }

  /**
   * Historique des pertes d'un produit (détail du stock exigé par le
   * contrôleur) ; valeurs estimées seulement avec `products.view_financials`.
   */
  async listLosses(
    organizationId: string,
    productId: string,
    visibility: ProductVisibility,
  ): Promise<unknown[]> {
    const rows = await this.lossModel
      .find({
        organizationId: new Types.ObjectId(organizationId),
        productId: new Types.ObjectId(productId),
      })
      .sort({ createdAt: -1, _id: -1 })
      .limit(200)
      .populate('actorId', 'name')
      .lean()
      .exec();
    return rows.map((r) => {
      const { unitCostAtMovement, ...rest } = r;
      return {
        ...rest,
        ...(visibility.financials
          ? { unitCostAtMovement, valueAtCost: unitCostAtMovement * r.quantity }
          : {}),
      };
    });
  }

  /** État courant renvoyé ; diffusion seulement si cette requête a écrit. */
  private async finish(
    organizationId: string,
    productId: string,
    result: BatchOperationResult,
    visibility: ProductVisibility,
    wrote = !result.replayed,
  ): Promise<BatchOperationResult> {
    if (wrote) {
      await this.productsService.broadcastUpdated(organizationId, productId);
    }
    const view = await this.list(organizationId, productId, visibility);
    return {
      ...view,
      ...(result.batchId ? { batchId: result.batchId } : {}),
      replayed: result.replayed,
      changed: wrote,
    };
  }
}
