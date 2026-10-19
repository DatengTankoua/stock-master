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
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {options.map((permission) => (
          <label key={permission} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={allGranted || value.includes(permission)}
              onChange={() => toggle(permission)}
              disabled={disabled || allGranted}
              className="h-4 w-4 rounded border-input"
            />
            {t(`permissions.${permission}`)}
          </label>
        ))}
      </div>
    </div>
  );
}
