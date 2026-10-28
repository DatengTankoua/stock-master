# Administration de la plateforme — commandes opérateur (Railway)

Commandes prêtes à copier pour gérer l'accès à l'administration de la
plateforme et ses capacités, depuis un terminal ouvert **dans le service API**
sur Railway. Elles utilisent l'environnement de ce service : il ne faut ni
copier `MONGODB_URI`, ni saisir de secret.

> Les valeurs ci-dessous sont des exemples. Remplacez
> `REMPLACER_PAR_MON_IDENTIFIANT` par l'identifiant du compte concerné
> (24 caractères hexadécimaux, en minuscules). N'écrivez jamais de mot de
> passe ou de secret dans ces commandes.

Vérifié contre le code : `api/src/migrations/platform-admin-cli.ts`
(analyse des options) et `api/src/platform-admin/platform-admin-capabilities.ts`
(catalogue des capacités).

## 1. Préparer le terminal

À coller une seule fois, au début de chaque session de terminal :

```sh
export PATH="/mise/installs/node/22.23.3/bin:$PATH"
ADMIN_USER_ID="REMPLACER_PAR_MON_IDENTIFIANT"
ADMIN_OPERATOR="Emery"
ADMIN_CLI="$(find / -path '*/dist/migrations/platform-admin-cli.js' -not -path '*/node_modules/*' 2>/dev/null | head -n 1)"
echo "Node : $(node --version)  |  Commande : $ADMIN_CLI"
```

La dernière ligne doit afficher une version de Node et un chemin se
terminant par `dist/migrations/platform-admin-cli.js`.

- `ADMIN_OPERATOR` : votre nom, inscrit au journal d'audit (2 à 100
  caractères : lettres, chiffres, espace, `.`, `_`, `@`, `-`).
- `ADMIN_CLI` : emplacement de la commande dans l'image déployée, trouvé
  automatiquement (il dépend de la façon dont l'image est construite).

### Si `node` est introuvable

Le chemin `/mise/installs/node/22.23.3/bin` a été observé dans le terminal
Railway de ce service. Il **dépend de l'image déployée** et peut changer
après une mise à jour de Node ou du mode de construction.

1. Chercher l'exécutable :
   ```sh
   ls -d /mise/installs/node/*/bin 2>/dev/null; command -v node
   ```
2. Remplacer le chemin de la ligne `export PATH=…` par celui trouvé, puis
   recoller le bloc de préparation.
3. Si `ADMIN_CLI` est vide, l'image ne contient pas la version compilée de
   l'API : vérifier le dernier déploiement du service API avant d'aller plus
   loin.

## 2. À savoir avant d'agir

- **Capacité plateforme ≠ permission d'un membre.** Les capacités
  `platform.*` ne concernent que l'administration de Stock Master. Elles ne
  donnent aucun droit dans un commerce, et aucun rôle de commerce ne les
  donne.
- **Une capacité n'active aucune fonction technique.** Les drapeaux du
  serveur (par exemple `MARKETING_EMAILS_ENABLED`, `PRODUCT_BATCHES_ENABLED`)
  restent tels qu'ils sont configurés.
- **Accorder le droit d'envoi ne lance aucune campagne.** Chaque lancement
  reste une action volontaire, confirmée par mot de passe et second facteur.
- **Archiver n'annule pas un envoi.** Un message ou une campagne archivé est
  seulement rangé hors de la liste principale.
- **Réactiver les envois peut reprendre des envois en attente.** Repasser
  `MARKETING_EMAILS_ENABLED` à `true` fait partir les e-mails de campagne
  restés en attente.
- **Sans `--apply`, rien n'est modifié.** La commande décrit ce qu'elle
  ferait (`dry-run:…`). Avec `--apply`, elle écrit et l'action est inscrite au
  journal d'audit.
- **Le motif** (`--reason`) est obligatoire pour toute écriture : 10 à 300
  caractères.
- Les commandes `grant`, `capability-add` et `capability-remove` exigent que
  les index de l'administration existent (pré-déploiement).

## 3. Consulter le statut

Lecture seule, sans risque :

```sh
node "$ADMIN_CLI" status --user-id="$ADMIN_USER_ID"
```

Résultat : `access` (`none`, `active`, `revoked`), `mfa` (`not_enrolled`,
`active`…), `activeSessions`, `capabilities`.

## 4. Accorder l'accès à l'administration

L'accès commence en consultation seule (`platform.read`). Le compte doit
avoir une adresse e-mail confirmée.

**Étape 1 — prévisualiser** (n'écrit rien) :

```sh
node "$ADMIN_CLI" grant --user-id="$ADMIN_USER_ID" --reason="Accès à l'administration de la plateforme" --operator="$ADMIN_OPERATOR"
```

Résultat attendu : `dry-run:grant` (ou `already-active`).

**Étape 2 — appliquer**, seulement après lecture de l'étape 1 :

```sh
node "$ADMIN_CLI" grant --user-id="$ADMIN_USER_ID" --reason="Accès à l'administration de la plateforme" --operator="$ADMIN_OPERATOR" --apply
```

Résultat attendu : `granted`.

**Étape 3 — contrôler** :

```sh
node "$ADMIN_CLI" status --user-id="$ADMIN_USER_ID"
```

À la première connexion, l'administrateur configure son second facteur.

## 5. Capacités reconnues

| Capacité | Rôle |
|---|---|
| `platform.read` | **Consultation** — Consulter l'administration : vue d'ensemble, commerces, paiements, audit, historique des messages et des campagnes. Accordée automatiquement avec l'accès. |
| `platform.organizations.suspend` | **Suspension et réactivation** — Suspendre un commerce et le réactiver. |
| `platform.subscriptions.extend` | **Prolongation offerte** — Offrir une prolongation d'abonnement à un commerce. |
| `platform.communications.notify` | **Messages par notification** — Envoyer (ou renvoyer) un message de service aux membres d'un commerce, par notification dans l'application. |
| `platform.communications.email` | **Messages par e-mail** — Envoyer (ou renvoyer) un message de service aux membres d'un commerce, par e-mail. |
| `platform.communications.archive` | **Archivage des messages** — Archiver ou restaurer des messages de service dans l'historique d'un commerce. |
| `platform.campaigns.manage` | **Gestion des campagnes** — Créer et modifier des brouillons de campagne, archiver et restaurer des campagnes. N'envoie rien. |
| `platform.campaigns.send` | **Envoi des campagnes** — Lancer une campagne (mot de passe et second facteur demandés à chaque lancement). |

Aucune autre valeur n'est acceptée : la commande refuse un nom inconnu et
affiche la liste ci-dessus.

## 6. Ajouter une capacité

L'accès doit être actif (§ 4). Une capacité à la fois.

### 6.1 Consultation — `platform.read`

Prévisualiser (n'écrit rien ; attendu : `dry-run:capability-add` ou
`already-present`) :

```sh
node "$ADMIN_CLI" capability-add --user-id="$ADMIN_USER_ID" --capability=platform.read --reason="Consultation de l'administration de la plateforme" --operator="$ADMIN_OPERATOR"
```

Appliquer, après lecture de la prévisualisation (attendu :
`capability-added`) :

```sh
node "$ADMIN_CLI" capability-add --user-id="$ADMIN_USER_ID" --capability=platform.read --reason="Consultation de l'administration de la plateforme" --operator="$ADMIN_OPERATOR" --apply
```

Contrôler :

```sh
node "$ADMIN_CLI" status --user-id="$ADMIN_USER_ID"
```

### 6.2 Suspension et réactivation — `platform.organizations.suspend`

Prévisualiser (n'écrit rien ; attendu : `dry-run:capability-add` ou
`already-present`) :

```sh
node "$ADMIN_CLI" capability-add --user-id="$ADMIN_USER_ID" --capability=platform.organizations.suspend --reason="Suspension et réactivation des commerces" --operator="$ADMIN_OPERATOR"
```

Appliquer, après lecture de la prévisualisation (attendu :
`capability-added`) :

```sh
node "$ADMIN_CLI" capability-add --user-id="$ADMIN_USER_ID" --capability=platform.organizations.suspend --reason="Suspension et réactivation des commerces" --operator="$ADMIN_OPERATOR" --apply
```

Contrôler :

```sh
node "$ADMIN_CLI" status --user-id="$ADMIN_USER_ID"
```

### 6.3 Prolongation offerte — `platform.subscriptions.extend`

Prévisualiser (n'écrit rien ; attendu : `dry-run:capability-add` ou
`already-present`) :

```sh
node "$ADMIN_CLI" capability-add --user-id="$ADMIN_USER_ID" --capability=platform.subscriptions.extend --reason="Prolongations offertes aux commerces" --operator="$ADMIN_OPERATOR"
```

Appliquer, après lecture de la prévisualisation (attendu :
`capability-added`) :

```sh
node "$ADMIN_CLI" capability-add --user-id="$ADMIN_USER_ID" --capability=platform.subscriptions.extend --reason="Prolongations offertes aux commerces" --operator="$ADMIN_OPERATOR" --apply
```

Contrôler :

```sh
node "$ADMIN_CLI" status --user-id="$ADMIN_USER_ID"
```

### 6.4 Messages par notification — `platform.communications.notify`

Prévisualiser (n'écrit rien ; attendu : `dry-run:capability-add` ou
`already-present`) :

```sh
node "$ADMIN_CLI" capability-add --user-id="$ADMIN_USER_ID" --capability=platform.communications.notify --reason="Messages de service par notification" --operator="$ADMIN_OPERATOR"
```

Appliquer, après lecture de la prévisualisation (attendu :
`capability-added`) :

```sh
node "$ADMIN_CLI" capability-add --user-id="$ADMIN_USER_ID" --capability=platform.communications.notify --reason="Messages de service par notification" --operator="$ADMIN_OPERATOR" --apply
```

Contrôler :

```sh
node "$ADMIN_CLI" status --user-id="$ADMIN_USER_ID"
```

### 6.5 Messages par e-mail — `platform.communications.email`

Prévisualiser (n'écrit rien ; attendu : `dry-run:capability-add` ou
`already-present`) :

```sh
node "$ADMIN_CLI" capability-add --user-id="$ADMIN_USER_ID" --capability=platform.communications.email --reason="Messages de service par e-mail" --operator="$ADMIN_OPERATOR"
```

Appliquer, après lecture de la prévisualisation (attendu :
`capability-added`) :

```sh
node "$ADMIN_CLI" capability-add --user-id="$ADMIN_USER_ID" --capability=platform.communications.email --reason="Messages de service par e-mail" --operator="$ADMIN_OPERATOR" --apply
```

Contrôler :

```sh
node "$ADMIN_CLI" status --user-id="$ADMIN_USER_ID"
```

### 6.6 Archivage des messages — `platform.communications.archive`

Prévisualiser (n'écrit rien ; attendu : `dry-run:capability-add` ou
`already-present`) :

```sh
node "$ADMIN_CLI" capability-add --user-id="$ADMIN_USER_ID" --capability=platform.communications.archive --reason="Archivage des messages de service" --operator="$ADMIN_OPERATOR"
```

Appliquer, après lecture de la prévisualisation (attendu :
`capability-added`) :

```sh
node "$ADMIN_CLI" capability-add --user-id="$ADMIN_USER_ID" --capability=platform.communications.archive --reason="Archivage des messages de service" --operator="$ADMIN_OPERATOR" --apply
```

Contrôler :

```sh
node "$ADMIN_CLI" status --user-id="$ADMIN_USER_ID"
```

### 6.7 Gestion des campagnes — `platform.campaigns.manage`

Prévisualiser (n'écrit rien ; attendu : `dry-run:capability-add` ou
`already-present`) :

```sh
node "$ADMIN_CLI" capability-add --user-id="$ADMIN_USER_ID" --capability=platform.campaigns.manage --reason="Gestion des campagnes e-mail" --operator="$ADMIN_OPERATOR"
```

Appliquer, après lecture de la prévisualisation (attendu :
`capability-added`) :

```sh
node "$ADMIN_CLI" capability-add --user-id="$ADMIN_USER_ID" --capability=platform.campaigns.manage --reason="Gestion des campagnes e-mail" --operator="$ADMIN_OPERATOR" --apply
```

Contrôler :

```sh
node "$ADMIN_CLI" status --user-id="$ADMIN_USER_ID"
```

### 6.8 Envoi des campagnes — `platform.campaigns.send`

Prévisualiser (n'écrit rien ; attendu : `dry-run:capability-add` ou
`already-present`) :

```sh
node "$ADMIN_CLI" capability-add --user-id="$ADMIN_USER_ID" --capability=platform.campaigns.send --reason="Lancement des campagnes e-mail" --operator="$ADMIN_OPERATOR"
```

Appliquer, après lecture de la prévisualisation (attendu :
`capability-added`) :

```sh
node "$ADMIN_CLI" capability-add --user-id="$ADMIN_USER_ID" --capability=platform.campaigns.send --reason="Lancement des campagnes e-mail" --operator="$ADMIN_OPERATOR" --apply
```

Contrôler :

```sh
node "$ADMIN_CLI" status --user-id="$ADMIN_USER_ID"
```

## 7. Retirer une capacité

Le retrait prend effet dès la requête suivante de l'administrateur.
Retirer `platform.read` lui retire aussi la consultation.

### 7.1 Consultation — `platform.read`

Prévisualiser (attendu : `dry-run:capability-remove` ou `not-present`) :

```sh
node "$ADMIN_CLI" capability-remove --user-id="$ADMIN_USER_ID" --capability=platform.read --reason="Retrait de la consultation de l'administration" --operator="$ADMIN_OPERATOR"
```

Appliquer (attendu : `capability-removed`) :

```sh
node "$ADMIN_CLI" capability-remove --user-id="$ADMIN_USER_ID" --capability=platform.read --reason="Retrait de la consultation de l'administration" --operator="$ADMIN_OPERATOR" --apply
```

Contrôler :

```sh
node "$ADMIN_CLI" status --user-id="$ADMIN_USER_ID"
```

### 7.2 Suspension et réactivation — `platform.organizations.suspend`

Prévisualiser (attendu : `dry-run:capability-remove` ou `not-present`) :

```sh
node "$ADMIN_CLI" capability-remove --user-id="$ADMIN_USER_ID" --capability=platform.organizations.suspend --reason="Retrait de la suspension et de la réactivation" --operator="$ADMIN_OPERATOR"
```

Appliquer (attendu : `capability-removed`) :

```sh
node "$ADMIN_CLI" capability-remove --user-id="$ADMIN_USER_ID" --capability=platform.organizations.suspend --reason="Retrait de la suspension et de la réactivation" --operator="$ADMIN_OPERATOR" --apply
```

Contrôler :

```sh
node "$ADMIN_CLI" status --user-id="$ADMIN_USER_ID"
```

### 7.3 Prolongation offerte — `platform.subscriptions.extend`

Prévisualiser (attendu : `dry-run:capability-remove` ou `not-present`) :

```sh
node "$ADMIN_CLI" capability-remove --user-id="$ADMIN_USER_ID" --capability=platform.subscriptions.extend --reason="Retrait des prolongations offertes" --operator="$ADMIN_OPERATOR"
```

Appliquer (attendu : `capability-removed`) :

```sh
node "$ADMIN_CLI" capability-remove --user-id="$ADMIN_USER_ID" --capability=platform.subscriptions.extend --reason="Retrait des prolongations offertes" --operator="$ADMIN_OPERATOR" --apply
```

Contrôler :

```sh
node "$ADMIN_CLI" status --user-id="$ADMIN_USER_ID"
```

### 7.4 Messages par notification — `platform.communications.notify`

Prévisualiser (attendu : `dry-run:capability-remove` ou `not-present`) :

```sh
node "$ADMIN_CLI" capability-remove --user-id="$ADMIN_USER_ID" --capability=platform.communications.notify --reason="Retrait des messages par notification" --operator="$ADMIN_OPERATOR"
```

Appliquer (attendu : `capability-removed`) :

```sh
node "$ADMIN_CLI" capability-remove --user-id="$ADMIN_USER_ID" --capability=platform.communications.notify --reason="Retrait des messages par notification" --operator="$ADMIN_OPERATOR" --apply
```

Contrôler :

```sh
node "$ADMIN_CLI" status --user-id="$ADMIN_USER_ID"
```

### 7.5 Messages par e-mail — `platform.communications.email`

Prévisualiser (attendu : `dry-run:capability-remove` ou `not-present`) :

```sh
node "$ADMIN_CLI" capability-remove --user-id="$ADMIN_USER_ID" --capability=platform.communications.email --reason="Retrait des messages par e-mail" --operator="$ADMIN_OPERATOR"
```

Appliquer (attendu : `capability-removed`) :

```sh
node "$ADMIN_CLI" capability-remove --user-id="$ADMIN_USER_ID" --capability=platform.communications.email --reason="Retrait des messages par e-mail" --operator="$ADMIN_OPERATOR" --apply
```

Contrôler :

```sh
node "$ADMIN_CLI" status --user-id="$ADMIN_USER_ID"
```

### 7.6 Archivage des messages — `platform.communications.archive`

Prévisualiser (attendu : `dry-run:capability-remove` ou `not-present`) :

```sh
node "$ADMIN_CLI" capability-remove --user-id="$ADMIN_USER_ID" --capability=platform.communications.archive --reason="Retrait de l'archivage des messages" --operator="$ADMIN_OPERATOR"
```

Appliquer (attendu : `capability-removed`) :

```sh
node "$ADMIN_CLI" capability-remove --user-id="$ADMIN_USER_ID" --capability=platform.communications.archive --reason="Retrait de l'archivage des messages" --operator="$ADMIN_OPERATOR" --apply
```

Contrôler :

```sh
node "$ADMIN_CLI" status --user-id="$ADMIN_USER_ID"
```

### 7.7 Gestion des campagnes — `platform.campaigns.manage`

Prévisualiser (attendu : `dry-run:capability-remove` ou `not-present`) :

```sh
node "$ADMIN_CLI" capability-remove --user-id="$ADMIN_USER_ID" --capability=platform.campaigns.manage --reason="Retrait de la gestion des campagnes" --operator="$ADMIN_OPERATOR"
```

Appliquer (attendu : `capability-removed`) :

```sh
node "$ADMIN_CLI" capability-remove --user-id="$ADMIN_USER_ID" --capability=platform.campaigns.manage --reason="Retrait de la gestion des campagnes" --operator="$ADMIN_OPERATOR" --apply
```

Contrôler :

```sh
node "$ADMIN_CLI" status --user-id="$ADMIN_USER_ID"
```

### 7.8 Envoi des campagnes — `platform.campaigns.send`

Prévisualiser (attendu : `dry-run:capability-remove` ou `not-present`) :

```sh
node "$ADMIN_CLI" capability-remove --user-id="$ADMIN_USER_ID" --capability=platform.campaigns.send --reason="Retrait du lancement des campagnes" --operator="$ADMIN_OPERATOR"
```

Appliquer (attendu : `capability-removed`) :

```sh
node "$ADMIN_CLI" capability-remove --user-id="$ADMIN_USER_ID" --capability=platform.campaigns.send --reason="Retrait du lancement des campagnes" --operator="$ADMIN_OPERATOR" --apply
```

Contrôler :

```sh
node "$ADMIN_CLI" status --user-id="$ADMIN_USER_ID"
```

## 8. Révoquer l'accès à l'administration

Révoque l'accès **et toutes les sessions** administratives du compte. Un
nouvel accès (§ 4) repartira en consultation seule.

Prévisualiser (attendu : `dry-run:revoke` ou `not-active`) :

```sh
node "$ADMIN_CLI" revoke --user-id="$ADMIN_USER_ID" --reason="Fin de l'accès à l'administration de la plateforme" --operator="$ADMIN_OPERATOR"
```

Appliquer (attendu : `revoked`) :

```sh
node "$ADMIN_CLI" revoke --user-id="$ADMIN_USER_ID" --reason="Fin de l'accès à l'administration de la plateforme" --operator="$ADMIN_OPERATOR" --apply
```

Contrôler (attendu : `"access":"revoked"`, `"activeSessions":0`) :

```sh
node "$ADMIN_CLI" status --user-id="$ADMIN_USER_ID"
```

## 9. Récupération du second facteur (MFA)

À utiliser quand l'administrateur a perdu son second facteur **et** ses codes
de récupération.

1. **Vérifier l'identité hors ligne** : de vive voix ou par visioconférence
   avec la personne, jamais sur la seule foi d'un e-mail ou d'un message.
2. **Noter une référence** de cette vérification (date, moyen, par exemple
   `2026-10-28 appel vidéo avec Emery`) : elle est obligatoire (3 à 200
   caractères) et inscrite au journal d'audit.
3. Prévisualiser (attendu : `dry-run:reset-mfa`, ou `nothing-to-reset` s'il
   n'y a ni facteur ni session) :

   ```sh
   node "$ADMIN_CLI" reset-mfa --user-id="$ADMIN_USER_ID" --reason="Perte du second facteur et des codes de récupération" --identity-check="REMPLACER_PAR_LA_REFERENCE_DE_VERIFICATION" --operator="$ADMIN_OPERATOR"
   ```

4. Appliquer (attendu : `mfa-reset`) :

   ```sh
   node "$ADMIN_CLI" reset-mfa --user-id="$ADMIN_USER_ID" --reason="Perte du second facteur et des codes de récupération" --identity-check="REMPLACER_PAR_LA_REFERENCE_DE_VERIFICATION" --operator="$ADMIN_OPERATOR" --apply
   ```

5. Contrôler (attendu : `"mfa":"not_enrolled"`, `"activeSessions":0`) :

   ```sh
   node "$ADMIN_CLI" status --user-id="$ADMIN_USER_ID"
   ```

Conséquences : toutes les sessions administratives du compte sont fermées ;
le second facteur et les codes de récupération sont supprimés ; à la
prochaine connexion, l'administrateur doit configurer un nouveau second
facteur. L'accès et les capacités sont conservés.

## 10. Messages d'erreur fréquents

| Message | Cause | Que faire |
|---|---|---|
| `option --… requise` / `option … inattendue` | Option manquante ou en trop | Recopier le bloc complet |
| `--user-id : identifiant de 24 caractères…` | Identifiant incomplet ou en majuscules | Vérifier `ADMIN_USER_ID` |
| `--reason : 10 à 300 caractères` | Motif trop court ou trop long | Ajuster le texte entre guillemets |
| `utilisateur introuvable` | Identifiant inconnu | Vérifier l'identifiant du compte |
| `adresse non vérifiée : accès refusé` | Adresse du compte non confirmée | Confirmer l'adresse, puis recommencer |
| `autorisation plateforme non active` | Capacité demandée sans accès actif | Accorder l'accès (§ 4) |
| `autorisation modifiée entre-temps : relancer` | Modification simultanée | Relancer la même commande |
| `MONGODB_URI requis.` | Commande lancée hors du service API | Ouvrir le terminal dans le service API |

## 11. Autre commande

`rotate-key` rechiffre les seconds facteurs après un changement de clé
(`PLATFORM_ADMIN_MFA_KEYS`, `PLATFORM_ADMIN_MFA_ACTIVE_KEY`). Elle ne
concerne pas les capacités. Prévisualiser d'abord :
`node "$ADMIN_CLI" rotate-key --operator="$ADMIN_OPERATOR"`, puis ajouter
`--apply` seulement si le résultat correspond à l'attendu.
