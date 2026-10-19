// Miroir de `api/src/organizations/permissions.ts` (DELEGABLE_PERMISSIONS) —
// aucun endpoint n'expose ce catalogue complet, seulement les permissions
// accordées/effectives (GET /auth/context). Garder cette liste synchronisée
// avec le backend, jamais inventer de nouvelle permission ici.
export const DELEGABLE_PERMISSIONS = [
  "catalog.manage",
  "products.manage",
  "stock.adjust",
  "sales.record",
  "sales.view_own",
  "sales.view_all",
  "products.view_stock_details",
  "products.view_financials",
  "analytics.read",
  "audit.read",
  "trash.manage",
  "branding.manage",
  "members.invite",
  "members.manage",
  // 1-16C.1 : accordée par défaut au propriétaire et à l'administrateur.
  "support.contact",
  // 1-19A : recevoir les notifications de ventes (distincte de les consulter).
  "sales.notifications",
  // Modifier la date de péremption / le seuil de stock faible d'une fiche :
  // complètent `products.manage`, n'ouvrent aucun autre champ.
  "products.manage_expiry",
  "stock.manage_thresholds",
  // Suivi par lots : activer le suivi d'une fiche et répartir son stock
  // existant. Proposée seulement si l'API annonce la fonctionnalité.
  "stock.manage_batches",
  // Lot C : mise à l'écart d'un lot, pertes, délai des alertes de péremption.
  "stock.quarantine_batches",
  "stock.record_losses",
  "products.manage_expiry_alerts",
] as const;

export type DelegablePermission = (typeof DELEGABLE_PERMISSIONS)[number];

// 1-19A — version du catalogue ci-dessus (miroir de
// CURRENT_PERMISSION_CATALOG côté API), déclarée à chaque modification de
// membre : le serveur conserve les permissions que ce web ne connaît pas.
// 3 : dates de péremption et seuils de stock. 4 : suivi par lots.
// Lot C : un catalogue par combinaison affichée — 5 : alertes de
// péremption ; 6 : lots (suivi, mise à l'écart, pertes) ; 7 : tout.
export const PERMISSION_CATALOG = 7;

// Permissions propres à une fonctionnalité que l'API peut ne pas annoncer :
// jamais proposées tant qu'elle est désactivée.
const FEATURE_PERMISSIONS: Partial<
  Record<DelegablePermission, "productBatches" | "expiryAlerts">
> = {
  "stock.manage_batches": "productBatches",
  "stock.quarantine_batches": "productBatches",
  "stock.record_losses": "productBatches",
  "products.manage_expiry_alerts": "expiryAlerts",
};

export interface PermissionFeatures {
  productBatches?: boolean;
  expiryAlerts?: boolean;
}

/** Permission proposable selon les fonctionnalités annoncées par l'API. */
export function isPermissionOffered(
  permission: DelegablePermission,
  features: PermissionFeatures | undefined,
): boolean {
  const feature = FEATURE_PERMISSIONS[permission];
  return !feature || features?.[feature] === true;
}

/**
 * Catalogue DÉCLARÉ par un formulaire : celui des permissions qu'il affiche
 * réellement. Sans le suivi par lots, le catalogue 3 : une permission de
 * lots déjà accordée est conservée, jamais retirée à l'insu de l'auteur.
 */
export function permissionCatalogFor(
  features: PermissionFeatures | undefined,
): number {
  const batches = features?.productBatches === true;
  const alerts = features?.expiryAlerts === true;
  if (batches && alerts) return PERMISSION_CATALOG;
  if (batches) return 6;
  if (alerts) return 5;
  return 3;
}

// 1-12H — miroir de STANDARD_MEMBER_PERMISSIONS (backend) : droits de tout
// membre actif, ajoutés par le calcul serveur, jamais proposés ni retirables
// dans les « Permissions supplémentaires ».
export const STANDARD_MEMBER_PERMISSIONS: readonly DelegablePermission[] = [
  "sales.record",
  "sales.view_own",
];

// Cases « Permissions supplémentaires » : délégables hors droits standard.
export const SUPPLEMENTARY_PERMISSIONS: readonly DelegablePermission[] =
  DELEGABLE_PERMISSIONS.filter((p) => !STANDARD_MEMBER_PERMISSIONS.includes(p));

// Retire les droits standard d'une liste stockée (memberships historiques) :
// ils restent accordés par le serveur quoi qu'il arrive.
export function supplementaryOnly(
  permissions: readonly DelegablePermission[],
): DelegablePermission[] {
  return permissions.filter((p) => SUPPLEMENTARY_PERMISSIONS.includes(p));
}

// Structural type (pas d'import d'ApiAuthContext ici, éviterait un cycle
// avec lib/api.ts) : toute décision UI passe par `effectivePermissions`,
// jamais par `User.role`/`ApiUser.role` ni un décodage JWT (1-9D).
export function hasPermission(
  authContext:
    { effectivePermissions: DelegablePermission[] } | null | undefined,
  permission: DelegablePermission,
): boolean {
  return authContext?.effectivePermissions.includes(permission) ?? false;
}

// 1-16G : libellés des permissions et des rôles dans `organization`
// (`permissions.*`, `roles.*`) ; les codes internes ne sont jamais traduits.

export type OrganizationRole = "owner" | "admin" | "seller";

// Rôles attribuables via PATCH /organizations/members/:id — jamais `owner`
// (transfert de propriété dédié : POST .../:id/transfer-ownership).
export const ASSIGNABLE_MEMBER_ROLES = ["admin", "seller"] as const;

// Rôles invitables via POST /organizations/invitations — jamais `owner`.
export const INVITABLE_ROLES = ["admin", "seller"] as const;

// 1-12H — un administrateur reçoit TOUTES les permissions délégables par
// défaut (backend : DEFAULT_PERMISSIONS_BY_ROLE.admin, union non réductible).
// Ses cases supplémentaires sont donc toutes cochées et non modifiables.
export function roleGrantsAllPermissions(role: OrganizationRole): boolean {
  return role === "owner" || role === "admin";
}

export function isOrganizationRole(value: unknown): value is OrganizationRole {
  return value === "owner" || value === "admin" || value === "seller";
}

/**
 * 1-17B — droits qui créent ou libèrent des fichiers : l'un d'eux suffit
 * pour consulter l'occupation du stockage (même liste que l'API).
 */
export const STORAGE_USAGE_PERMISSIONS: readonly DelegablePermission[] = [
  "products.manage",
  "branding.manage",
  "trash.manage",
];
