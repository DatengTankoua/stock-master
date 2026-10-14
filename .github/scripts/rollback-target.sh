#!/usr/bin/env bash
# 1-22G — Validation des cibles du retour arrière manuel (rollback.yml).
#
# Aucune cible implicite : l'opérateur nomme la version à restaurer, ce
# script la vérifie. Les entrées arrivent par variables d'environnement
# (jamais interpolées dans le shell par le workflow).
#
#   SERVICE              web | api | both
#   WEB_DEPLOYMENT       déploiement Vercel à restaurer : identifiant dpl_…
#                        ou URL https sans chemin (web, both)
#   TARGET_SHA           commit complet (40 hexadécimaux) déjà présent dans
#                        l'historique de la branche de production (api, both)
#   PAYMENTS_CHECKED     true : procédure SasPay appliquée (api, both)
#   PRODUCTION_REF       référence de production (défaut : origin/main)
#
# Sortie : lignes `clé=valeur` sur stdout (GITHUB_OUTPUT) ; code 1 et message
# d'erreur sur stderr si une entrée est absente ou invalide.
set -euo pipefail

fail() {
  echo "::error::$1" >&2
  exit 1
}

service="${SERVICE:-}"
production_ref="${PRODUCTION_REF:-origin/main}"

case "$service" in
  web | api | both) ;;
  *) fail "Service invalide : attendu web, api ou both." ;;
esac

if [[ "$service" == "web" || "$service" == "both" ]]; then
  deployment="${WEB_DEPLOYMENT:-}"
  if [[ -z "$deployment" ]]; then
    fail "web_deployment est obligatoire : sans argument, « vercel rollback » n'effectue aucun retour arrière (il affiche seulement l'état)."
  fi
  if [[ ! "$deployment" =~ ^dpl_[A-Za-z0-9]{8,64}$ && ! "$deployment" =~ ^https://[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$ ]]; then
    fail "web_deployment invalide : identifiant dpl_… ou URL https://<hôte> sans chemin."
  fi
  echo "web_deployment=$deployment"
fi

if [[ "$service" == "api" || "$service" == "both" ]]; then
  sha="${TARGET_SHA:-}"
  if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    fail "target_sha est obligatoire pour l'API : SHA complet de 40 caractères hexadécimaux (minuscules)."
  fi
  if [[ "${PAYMENTS_CHECKED:-false}" != "true" ]]; then
    fail "Retour arrière de l'API refusé : appliquer d'abord la procédure des paiements SasPay (1-21B § 11, 1-21E § 10.1), puis cocher payments_checked."
  fi
  if ! git cat-file -e "${sha}^{commit}" 2>/dev/null; then
    fail "target_sha introuvable dans le dépôt."
  fi
  if ! git merge-base --is-ancestor "$sha" "$production_ref"; then
    fail "target_sha n'appartient pas à l'historique de ${production_ref} : seule une version déjà fusionnée en production peut être restaurée."
  fi
  echo "target_sha=$sha"
fi
