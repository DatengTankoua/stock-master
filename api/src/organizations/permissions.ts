/**
 * Phase 1-1A — socle multi-tenant : rôles, statuts et permissions.
 *
 * Ce module est la source unique des enums/constantes de permissions :
 * les schémas Organization et OrganizationMembership en importent des
 * valeurs (aucune dépendance circulaire). Aucune garde ni fonction
 * d'autorisation n'est créée ici : le calcul de l'autorisation effective
 * (permissions du rôle ∪ permissions supplémentaires) viendra en 1-7.
 */

export enum OrganizationRole {
  OWNER = 'owner',
  ADMIN = 'admin',
  SELLER = 'seller',
}

export enum MembershipStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  REVOKED = 'revoked',
}

export enum OrganizationStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
}

/**
 * Cycle de vie d'une invitation (1-6B.1).
 *
 * 1-19A : une invitation acceptée ou révoquée est SUPPRIMÉE de la collection
 * (aucune corbeille) ; seules `pending` et `expired` y restent. `accepted` et
 * `revoked` ne désignent plus que d'anciens documents, purgés par
 * `migrate:purge-terminated-invitations`.
 */
export enum InvitationStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  REVOKED = 'revoked',
  EXPIRED = 'expired',
}

/** Devises initiales. `XAF` (CFA franc, Cameroun) est la valeur par défaut. */
export enum OrganizationCurrency {
  XAF = 'XAF',
  EUR = 'EUR',
}

/**
 * Permissions délégables. La liste est figée par la phase 1-1A ;
 * `membership.permissions` ne représente QUE des valeurs de cette liste
 * (permissions supplémentaires explicitement accordées).
 * Gelée à l'exécution (`Object.freeze`).
 */
export const DELEGABLE_PERMISSIONS = Object.freeze([
  'catalog.manage',
  'products.manage',
  'stock.adjust',
  'sales.record',
  'sales.view_own',
  'sales.view_all',
  // 1-12H : visibilité des informations produit au-delà du standard (prix
  // de vente cible, stock restant). N'accordent AUCUN droit de modification,
  // ni `sales.view_all`, ni `analytics.read`.
  'products.view_stock_details',
  'products.view_financials',
  'analytics.read',
  'audit.read',
  'trash.manage',
  'branding.manage',
  'members.invite',
  'members.manage',
  // 1-16C.1 : écrire au service client depuis l'organisation. Accordée par
  // défaut au propriétaire et à l'administrateur (toutes les délégables),
  // jamais au vendeur sans ajout explicite. Aucune migration : les
  // permissions déjà enregistrées ne sont pas modifiées.
  'support.contact',
  // 1-19A : RECEVOIR les notifications de nouvelles ventes (centre et push).
  // Distincte de `sales.record` (créer) et de `sales.view_all` (consulter) :
  // montant et quantité restent réservés à `sales.view_all`. Accordée par
  // défaut au propriétaire et à l'administrateur, jamais au vendeur sans
  // ajout explicite. Aucune migration.
  'sales.notifications',
  // Date de péremption et seuil de stock faible : droits de MODIFICATION de
  // ces seuls champs. Ils COMPLÈTENT `products.manage` (création ou
  // modification de la fiche), sans jamais le remplacer, et n'ouvrent aucun
  // autre champ (stock, prix…). La lecture suit la projection standard ;
  // les destinataires des alertes de stock ne changent pas. Accordés par
  // défaut au propriétaire et à l'administrateur (toutes les délégables),
  // jamais au vendeur sans ajout explicite (refus par défaut). Aucune
  // migration.
  'products.manage_expiry',
  'stock.manage_thresholds',
  // Suivi par lots (lot A) : ACTIVER le suivi d'une fiche et RÉPARTIR son
  // stock existant entre lots (reprise). Opération structurante, distincte
  // de `stock.adjust` (réceptions) et de `products.manage` (identité des
  // lots), qu'elle ne remplace jamais. Accordée par défaut au propriétaire
  // et à l'administrateur, jamais au vendeur sans ajout explicite. Aucune
  // migration.
  'stock.manage_batches',
  // Lot C (lots) : METTRE À L'ÉCART un lot entier et le REMETTRE à
  // disposition. Aucun mouvement de quantité. Distincte des dates
  // (`products.manage_expiry`) et des pertes.
  'stock.quarantine_batches',
  // Lot C (lots) : ENREGISTRER une perte (sortie définitive de stock) et la
  // CORRIGER par contre-mouvement. Le droit de modifier une date ne donne
  // jamais celui-ci.
  'stock.record_losses',
  // Lot C : CONFIGURER le délai d'anticipation des alertes de péremption
  // du commerce (réception des alertes : `products.view_stock_details`).
  'products.manage_expiry_alerts',
] as const);

export type DelegablePermission = (typeof DELEGABLE_PERMISSIONS)[number];

/** Permissions ajoutées après le catalogue 2 (web antérieur à ce lot). */
const PRODUCT_FIELD_PERMISSIONS: readonly DelegablePermission[] = [
  'products.manage_expiry',
  'stock.manage_thresholds',
];

/** Permission ajoutée après le catalogue 3 (suivi par lots). */
const BATCH_PERMISSIONS: readonly DelegablePermission[] = [
  'stock.manage_batches',
];

/** Lot C : opérations sur les lots (mise à l'écart, pertes). */
const BATCH_OPERATION_PERMISSIONS: readonly DelegablePermission[] = [
  'stock.quarantine_batches',
  'stock.record_losses',
];

/** Lot C : réglage des alertes de péremption. */
const EXPIRY_ALERT_PERMISSIONS: readonly DelegablePermission[] = [
  'products.manage_expiry_alerts',
];

const LOT_C_PERMISSIONS: readonly DelegablePermission[] = [
  ...BATCH_OPERATION_PERMISSIONS,
  ...EXPIRY_ALERT_PERMISSIONS,
];

/**
 * 1-19A — Catalogues de permissions CONNUS d'un client (formulaire de
 * modification d'un membre). Un formulaire envoie la liste COMPLÈTE des
 * permissions supplémentaires qu'il affiche : une permission qu'il ne
 * connaît pas en serait retirée silencieusement. Le client déclare donc le
 * catalogue qu'il connaît (`?permissionsCatalog=<n>`, paramètre ignoré par
 * une API antérieure) ; sans déclaration, c'est le catalogue 1 (web
 * antérieur à 1-19A) et les permissions hors catalogue sont conservées.
 * Catalogue 3 : dates de péremption et seuils de stock.
 * Catalogue 4 : suivi par lots. Un web qui n'AFFICHE pas cette permission
 * (fonctionnalité désactivée) déclare le catalogue 3 : elle est conservée.
 * Lot C : un catalogue par COMBINAISON de fonctionnalités affichées (les
 * activations sont indépendantes) — 5 : catalogue 3 + alertes de
 * péremption ; 6 : catalogue 3 + lots (suivi, mise à l'écart, pertes) ;
 * 7 : tout. Une permission non affichée est toujours conservée.
 */
export const PERMISSION_CATALOGS: Readonly<
  Record<number, readonly DelegablePermission[]>
> = Object.freeze({
  1: Object.freeze(
    DELEGABLE_PERMISSIONS.filter(
      (p) =>
        p !== 'sales.notifications' &&
        !PRODUCT_FIELD_PERMISSIONS.includes(p) &&
        !BATCH_PERMISSIONS.includes(p) &&
        !LOT_C_PERMISSIONS.includes(p),
    ),
  ),
  2: Object.freeze(
    DELEGABLE_PERMISSIONS.filter(
      (p) =>
        !PRODUCT_FIELD_PERMISSIONS.includes(p) &&
        !BATCH_PERMISSIONS.includes(p) &&
        !LOT_C_PERMISSIONS.includes(p),
    ),
  ),
  3: Object.freeze(
    DELEGABLE_PERMISSIONS.filter(
      (p) => !BATCH_PERMISSIONS.includes(p) && !LOT_C_PERMISSIONS.includes(p),
    ),
  ),
  4: Object.freeze(
    DELEGABLE_PERMISSIONS.filter((p) => !LOT_C_PERMISSIONS.includes(p)),
  ),
  5: Object.freeze(
    DELEGABLE_PERMISSIONS.filter(
      (p) =>
        !BATCH_PERMISSIONS.includes(p) &&
        !BATCH_OPERATION_PERMISSIONS.includes(p),
    ),
  ),
  6: Object.freeze(
    DELEGABLE_PERMISSIONS.filter((p) => !EXPIRY_ALERT_PERMISSIONS.includes(p)),
  ),
  7: DELEGABLE_PERMISSIONS,
});

export const CURRENT_PERMISSION_CATALOG = 7;

/** Version déclarée valide, sinon catalogue 1 (client le plus ancien). */
export function parsePermissionCatalog(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(n) && PERMISSION_CATALOGS[n] ? n : 1;
}

/**
 * Permissions demandées par un client de catalogue `catalog`, complétées des
 * permissions déjà accordées qu'il ne connaît pas (jamais retirées à son
 * insu). Aucun ajout possible : seules des permissions DÉJÀ présentes sont
 * conservées.
 */
export function mergeUnknownPermissions(
  requested: readonly DelegablePermission[],
  stored: readonly DelegablePermission[],
  catalog: number,
): DelegablePermission[] {
  const known = new Set(PERMISSION_CATALOGS[catalog] ?? PERMISSION_CATALOGS[1]);
  const kept = stored.filter((p) => !known.has(p) && !requested.includes(p));
  return [...requested, ...kept];
}

/**
 * Référence identique à `DELEGABLE_PERMISSIONS` (pas de copie divergente) :
 * la liste complète des permissions délégables.
 */
export const ALL_DELEGABLE_PERMISSIONS = DELEGABLE_PERMISSIONS;

/**
 * Permissions par défaut de chaque rôle (immuable).
 * `owner` et `admin` reçoivent l'intégralité des permissions délégables ;
 * `seller` ne reçoit que `sales.record` et `sales.view_own`.
 */
export const DEFAULT_PERMISSIONS_BY_ROLE: Readonly<
  Record<OrganizationRole, readonly DelegablePermission[]>
> = Object.freeze({
  [OrganizationRole.OWNER]: Object.freeze([...DELEGABLE_PERMISSIONS]),
  [OrganizationRole.ADMIN]: Object.freeze([...DELEGABLE_PERMISSIONS]),
  [OrganizationRole.SELLER]: Object.freeze([
    'sales.record',
    'sales.view_own',
  ] as const),
});

/**
 * 1-12H — droits STANDARD de tout membre actif, quel que soit son rôle :
 * ajoutés par le calcul central (`effectivePermissions`), jamais retirables
 * par `membership.permissions` ni par une requête client, sans migration
 * (s'applique aux memberships existantes comme nouvelles). Ne contournent
 * jamais l'authentification, les statuts (user/organisation/membership,
 * vérifiés en amont par la résolution du contexte) ni l'isolation.
 */
export const STANDARD_MEMBER_PERMISSIONS: readonly DelegablePermission[] =
  Object.freeze(['sales.record', 'sales.view_own'] as const);

/**
 * Opérations EXCLUSIVES de l'opérateur `owner` (contrainte 4 du cahier des
 * charges 1A) : elles ne sont AUCUNE permission délégable. Elles seront
 * contrôlées ultérieurement directement par le rôle `owner` (phase 1-7),
 * jamais par `membership.permissions`.
 */
export const OWNER_ONLY_OPERATIONS = Object.freeze([
  'ownership.transfer',
  'organization.delete',
  'billing.identity',
  // 1-14D.2B : demandes et confirmation des paiements d'abonnement.
  'billing.payment',
  'owner.attribution',
] as const);

export type OwnerOnlyOperation = (typeof OWNER_ONLY_OPERATIONS)[number];

/**
 * 1-7C — ensemble des permissions effectives (standard 1-12H ∪ rôle ∪
 * permissions supplémentaires). Base commune à `hasPermission` et aux contrôles
 * anti-escalade de gestion des membres.
 */
export function effectivePermissions(
  role: OrganizationRole,
  permissions: readonly DelegablePermission[],
): Set<DelegablePermission> {
  // `?? []` : défensif contre un rôle invalide/futur non couvert par la
  // table (jamais un TypeError → jamais 500).
  return new Set([
    ...STANDARD_MEMBER_PERMISSIONS,
    ...(DEFAULT_PERMISSIONS_BY_ROLE[role] ?? []),
    ...permissions,
  ]);
}

/**
 * 1-7B — calcule si les permissions effectives (rôle ∪ permissions
 * supplémentaires) couvrent `permission`. Type structurel (pas
 * `ResolvedOrganizationContext`) pour éviter un import circulaire avec
 * `organizations.service.ts`. Utilisé par les contrôleurs métier pour les
 * décisions de scope (own/all) que `PermissionGuard` ne peut pas exprimer
 * en un simple ET de métadonnées.
 */
export function hasPermission(
  context: {
    role: OrganizationRole;
    permissions: readonly DelegablePermission[];
  },
  permission: DelegablePermission,
): boolean {
  return effectivePermissions(context.role, context.permissions).has(
    permission,
  );
}

/** 1-7C — `subset` ⊆ `superset` (anti-escalade gestion des membres). */
export function isPermissionSubset(
  subset: ReadonlySet<DelegablePermission>,
  superset: ReadonlySet<DelegablePermission>,
): boolean {
  for (const permission of subset) {
    if (!superset.has(permission)) return false;
  }
  return true;
}

/**
 * 1-22B — une adhésion `inviter` peut-elle accorder `granted` (rôle +
 * permissions d'une invitation) ? Règle UNIQUE, appliquée à la création de
 * l'invitation ET à son acceptation : adhésion active ; owner sans borne ;
 * sinon `members.invite` et permissions accordées incluses dans les siennes.
 */
export function canGrantInvitation(
  inviter: {
    role: OrganizationRole;
    status: MembershipStatus;
    permissions: readonly DelegablePermission[];
  } | null,
  granted: {
    role: OrganizationRole;
    permissions: readonly DelegablePermission[];
  },
): boolean {
  if (!inviter || inviter.status !== MembershipStatus.ACTIVE) return false;
  if (inviter.role === OrganizationRole.OWNER) return true;
  const inviterEffective = effectivePermissions(
    inviter.role,
    inviter.permissions,
  );
  return (
    inviterEffective.has('members.invite') &&
    isPermissionSubset(
      effectivePermissions(granted.role, granted.permissions),
      inviterEffective,
    )
  );
}

/** Corps 403 UNIFORME (même contrat que `PermissionGuard`, 1-7A). */
export const PERMISSION_DENIED_RESPONSE = Object.freeze({
  code: 'PERMISSION_DENIED',
  message: 'Permission insuffisante.',
});
