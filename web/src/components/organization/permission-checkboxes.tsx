"use client";

import { useT } from "next-i18next/client";
import {
  SUPPLEMENTARY_PERMISSIONS,
  isPermissionOffered,
  type DelegablePermission,
} from "@/lib/organization-permissions";
import { useOrganizationShell } from "@/contexts/organization-shell-context";

interface PermissionCheckboxesProps {
  value: DelegablePermission[];
  onChange: (value: DelegablePermission[]) => void;
  // Anti-escalade côté UX : n'offre jamais plus que les permissions
  // effectives de l'acteur courant (le backend refuse de toute façon tout
  // dépassement, ceci évite juste une action vouée à échouer).
  assignable: readonly DelegablePermission[];
  disabled?: boolean;
  // 1-12H : rôle accordant déjà TOUTES les permissions (administrateur) —
  // cases affichées cochées et non modifiables, conformes aux droits réels.
  allGranted?: boolean;
}

// 1-12H : les droits standard (Enregistrer des ventes, Voir ses propres
// ventes) ne sont jamais proposés — accordés à tout membre par le serveur.
export function PermissionCheckboxes({
  value,
  onChange,
  assignable,
  disabled,
  allGranted = false,
}: PermissionCheckboxesProps) {
  const { t } = useT("organization");
  // Une permission d'une fonctionnalité non annoncée par l'API (suivi par
  // lots désactivé) n'est jamais proposée.
  const { authContext } = useOrganizationShell();
  const options = SUPPLEMENTARY_PERMISSIONS.filter(
    (p) =>
      assignable.includes(p) && isPermissionOffered(p, authContext?.features),
  );

  const toggle = (permission: DelegablePermission) => {
    if (value.includes(permission)) {
      onChange(value.filter((p) => p !== permission));
    } else {
      onChange([...value, permission]);
    }
  };

  if (options.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {t("permissionsField.none")}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {allGranted && (
        <p className="text-xs text-muted-foreground">
          {t("permissionsField.adminAll")}
        </p>
      )}
      {/* Ligne entière cliquable (≥ 44 px), libellés longs à la ligne. */}
      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
        {options.map((permission) => (
          <label
            key={permission}
            className="flex min-h-11 min-w-0 cursor-pointer items-start gap-3 rounded-md px-2 py-2.5 text-sm hover:bg-muted has-disabled:cursor-default has-disabled:hover:bg-transparent"
          >
            <input
              type="checkbox"
              checked={allGranted || value.includes(permission)}
              onChange={() => toggle(permission)}
              disabled={disabled || allGranted}
              className="mt-px size-5 shrink-0 rounded border-input accent-primary"
            />
            <span className="min-w-0 leading-snug break-words">
              {t(`permissions.${permission}`)}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
