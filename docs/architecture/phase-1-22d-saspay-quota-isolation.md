# Lot 1-22D — Protection du quota SasPay entre organisations

État : **piste 3 de l'audit 1-22A confirmée puis corrigée.** Rien n'est commité, poussé ni
déployé. Aucun appel réel à SasPay, aucun accès à la production.

## 1. Référence

| Élément | Valeur |
|---|---|
| Base | `origin/main` `38ce06a` (fusion #44 : 1-22B, 1-22C, 1-22C1) |
| Branche | `security/phase-1-22d-saspay-quota-isolation` |
| Variables, migrations | Aucune |

Le stash existant (`stash@{0}`) et les fichiers locaux sont conservés.

## 2. Cause

Un seul compteur d'appels sortants SasPay par processus (120 / min, fenêtre glissante), sans
répartition :

- toutes les organisations et toutes les confirmations (webhook, rapprochement) le partagent ;
- les limites des routes sont distinctes pour la création, la vérification et l'abandon
  (10 / min chacune), donc leur alternance les additionne ;
- une vérification coûte 2 ou 3 appels (jusqu'à 8 avec la recherche par référence marchand), un
  abandon jusqu'à 7 ;
- compteur vide → la création d'une autre organisation est enregistrée puis fermée
  `failed / provider_unavailable`, et sa reprise avec la même intention renvoie ce paiement
  échoué.

### Appels SasPay recensés

| Origine | Appels maximaux | Voie (après correction) |
|---|---|---|
| Création (`POST /payments`) | 1 | propriétaire |
| Vérification (`/refresh`) | 3 ; 8 sans référence SasPay | propriétaire ; 0 si `succeeded` ou `review` |
| Changement de forfait (`/abandon`) | vérification + 1 fermeture + 3 | propriétaire |
| Webhook | 3 par paiement ; au plus 3 candidats | confirmation |
| Rapprochement périodique | une passe toutes les 5 min, au plus 10 paiements : 20 à 30 appels, jusqu'à 80 si tous sont sans référence SasPay | confirmation |
| Suspension des tentatives remplacées | vérification + fermeture + vérification | celle de l'action qui l'a déclenchée |
| CLI de rapprochement | 3 par paiement inspecté | confirmation, **processus distinct** |

### Limites locales et contrat réel

- Contrat SasPay documenté : 300 appels / min **par compte marchand**, toutes origines. Réponse
  `429` au-delà. Le transport n'expose pas `Retry-After`.
- Limites locales : uniquement dans la mémoire du processus. Elles ne protègent pas le quota du
  compte contre d'autres instances, le CLI ou d'autres usages du compte.

## 3. Reproduction (SasPay simulé, base éphémère, horloge contrôlée)

Scénario 1-22A : deux propriétaires enchaînent 10 créations/abandons puis 10 vérifications, en
respectant les limites des routes. Une organisation B crée ensuite un paiement. Le paiement
d'une organisation C, payé pendant ce temps, passe au rapprochement.

| Mesure | Avant | Après |
|---|---|---|
| Appels SasPay des deux attaquants | **120** (budget entier) | **38** (≤ 2 × 20) |
| Réponses aux attaquants | 201, 409, 503 | 201, 409, **429 + `Retry-After`** |
| Création de B | **503**, 0 appel, paiement enregistré **`failed / provider_unavailable`** | **201** `pending`, 1 appel |
| Vérification de B | 503 | 200 |
| Rapprochement du paiement payé de C | `failed: 1`, reste `pending` | `failed: 0`, **`succeeded`**, 1 période |
| Paiement fermé à cause du quota | 1 (B) | 0 |

Reproductible : `api/test/saspay-quota-isolation.e2e-spec.ts`, cas 0 (ligne `MESURE`).

## 4. Correction

Réutilisée telle quelle : vérifications regroupées par paiement, rapprochement par réservation
de `lastCheckedAt`, codes `PAYMENT_RATE_LIMITED` / `PAYMENT_*_UNAVAILABLE`, `Retry-After`
posé par le filtre global, minuteur `Retry-After` du web.

1. **`PaymentCallBudget`** (`payments/payment-call-budget.ts`) remplace le compteur de
   l'adaptateur SasPay. Une seule fenêtre de 60 s, mais trois plafonds : global, par voie et par
   organisation.
2. **Admission avant tout effet.** Création, vérification et abandon réservent leur coût maximal
   avant toute écriture et tout appel. Le refus survient avant l'insertion du paiement. Les appels
   réels consomment la réservation, le reste est rendu à la fin. L'organisation vient du contexte
   serveur (`OrganizationGuard`) ou du paiement trouvé dans cette organisation, jamais du corps.
   Le contexte d'appel passe par `AsyncLocalStorage`.
3. **Compteur unique par organisation** pour les trois actions. L'alternance ne contourne rien.
4. **Voies réservées.** Tout appel hors action propriétaire (webhook, rapprochement, CLI) relève de
   la voie des confirmations. Elle n'est jamais imputée au quota d'une organisation. Un succès
   tardif reste donc confirmé même si son organisation a épuisé son quota.
5. **Webhooks.**
   - La vérification démarre *après* la réception (`confirmPaymentFresh`). Une lecture en cours,
     antérieure au changement notifié, ne fait plus perdre ce changement.
   - Les notifications simultanées partagent une seule relecture suivante.
   - Une notification identique (même événement, même transaction) déjà accusée n'est pas
     revérifiée pendant 20 s : la répétition reçoit l'accusé, sans appel. Un 503 n'est pas
     mémorisé : la reprise reste immédiate. Ses répétitions sont bornées par la limite de la route
     webhook (60 / min) et par la voie des confirmations.
   - Au plus 500 entrées mémorisées.
6. **Rapprochement.** Une passe s'arrête avant de réserver un paiement si la voie des
   confirmations ne peut plus lire un statut complet. Le paiement reste candidat. La passe
   suivante, ou un redémarrage, le reprend : l'état est en base.
7. **`429` de SasPay** : plus aucun appel pendant 15 s, toutes voies. Les créations suivantes sont
   refusées localement, avant toute ligne.

Aucune file ni attente ajoutée, aucun nouvel essai automatique. La seule attente est celle d'une
vérification déjà en cours (bornée par son budget de 15 à 20 s).

## 5. Seuils

| Seuil | Valeur | Justification |
|---|---|---|
| Global | 120 / min / processus | Inchangé. Laisse 180 / min du compte au CLI, au tableau de bord SasPay et à une 2ᵉ instance. |
| Voie propriétaire | 80 | Laisse au moins 40 aux confirmations : ≈ 13 vérifications de webhook (3 appels), ou une passe de rapprochement ordinaire (10 × 3 = 30 appels). Une passe au pire cas (80 appels) s'interrompt quand il reste moins de 8 appels, puis reprend à la passe suivante, 5 min plus tard. |
| Voie confirmations | 100 | Laisse au moins 20 aux propriétaires pendant une rafale de notifications. |
| Par organisation | 20 / min | Parcours normal ≤ 18 : création 1, retour et deux vérifications 9, changement de forfait 7, nouvelle création 1. Saturer la voie propriétaire exige au moins 4 organisations. |
| Pause après `429` | 15 s | Quota documenté par minute ; pause courte pour ne pas prolonger l'indisponibilité. |
| `Retry-After` de capacité | 30 s, fixe | Ne dépend pas de l'activité des autres organisations. |
| Répétition d'un webhook accusé | 20 s, 500 entrées | SasPay ne renvoie qu'après 30 s ; mémoire bornée. |

**Portée.** Un processus. Avec N instances, chaque plafond est multiplié par N. Le CLI a son
propre budget. Seul SasPay borne la somme : au-delà, `429`, puis la pause locale. Un déploiement
horizontal exigera un compteur partagé.

## 6. Réponses et interface

| Situation | Réponse |
|---|---|
| Quota de l'organisation | `429 PAYMENT_RATE_LIMITED`, `Retry-After` calculé sur ses seuls appels (1 à 60 s) |
| Capacité (voie, plafond global, pause) | `503 PAYMENT_SERVICE_UNAVAILABLE` (création) ou `PAYMENT_STATUS_UNAVAILABLE`, `Retry-After: 30` |
| Panne ou réponse ambiguë de SasPay | Inchangé : 503 sans `Retry-After`, état conservé |

Web :
- les deux 503 transmettent `Retry-After` ; les boutons sont désactivés jusque-là ;
- l'intention de paiement (UUID + durée) reste verrouillée et rejouée, jamais recréée ;
- messages FR/EN : « Rien n'est perdu… sans créer de nouveau paiement » et « Il est conservé ».

Aucune réponse ne contient de donnée sur les autres organisations.

## 7. Garanties conservées

- Tarifs, prestataire et parcours inchangés. Aucune session créée pour contourner un refus.
- Un refus local n'écrit rien : aucun paiement créé, fermé ni marqué échoué.
- `PAYMENT_PROVIDER_ACTIVE=none` : confirmations par l'adaptateur de confirmation, sur son
  budget. Le quota d'organisation s'applique aussi à la vérification manuelle.
- Paiements `failed` (tentative close ou remplacée) toujours relus. La suggestion de 1-22A,
  « aucune relecture d'un échec définitif », n'est pas appliquée : `failed` n'est pas définitif
  chez SasPay. Ces relectures sont imputées au quota de l'organisation.
- Attribution unique, conflits de renouvellement, remboursements et reçus : code inchangé.
- Webhook non traité : 503, SasPay le renvoie. Un accusé suit toujours une vérification démarrée
  après la réception de cet événement, ou de son double identique accusé moins de 20 s plus tôt.

## 8. Tests

Exécutés en local : MongoDB éphémère, SasPay simulé (transport de l'adaptateur réel), horloges
monotone et murale contrôlées. Ces exécutions ont été lancées depuis `api/test` : c'était un contournement provisoire du § 10. Il est remplacé en 1-22D.1, et les suites 1-22D y ont été relancées avec les commandes normales depuis `api/` et la racine.

| Ensemble | Résultat |
|---|---|
| Nouveau `test/saspay-quota-isolation.e2e-spec.ts` (12 cas : reproduction, alternance, intention rejouée, voie saturée, épuisement global et reprise, doublons de vérification et de webhook, changement pendant une vérification, `429` en lecture et en création, timeout et réponse ambiguë, succès tardif sous quota épuisé, paiement remboursé) | 12 / 12 |
| `test/saspay-confirmation-only.e2e-spec.ts` (+1 cas : nouveaux paiements désactivés) | 6 / 6 |
| Nouveau `payment-call-budget.spec.ts` | 5 / 5 |
| Unitaires `src/subscriptions/payments`, `src/common` | 406 / 406 |
| E2E paiements : `saspay-checkout`, `payment-reconciliation`, `payment-reconciliation-cli-process`, `subscription-payments`, `subscription-payment-foundation`, `realtime-subscription-payments`, `subscription-payments-default-provider` | 1ʳᵉ exécution : 161 / 162. Échec : `saspay-checkout` cas 13, un webhook renvoyé aussitôt après une panne recevait le 503 mémorisé. Corrigé : seuls les accusés sont mémorisés. Ensuite `saspay-checkout` + suites 1-22D : 65 / 65. |
| `tsc` (`tsconfig.build.json`, API ; web) | 0 erreur |
| ESLint (fichiers modifiés), `check-i18n` | 0 erreur, 0 problème |

## 9. Limites restantes

- **Compteurs locaux** : sans effet entre instances et sur le CLI (§ 5).
- **Organisations multiples** : 4 organisations ou plus, actives en même temps, peuvent occuper la
  voie propriétaire. Les autres reçoivent alors 503 + `Retry-After`. Les confirmations restent
  servies. Barrière en amont : inscription avec Turnstile et e-mail vérifié.
- **`429` de SasPay à la création.** Il peut venir d'un quota consommé ailleurs.
  - *Version initiale de ce lot :* la tentative était fermée `failed / provider_unavailable`
    (classement de 1-21B), comme le vérifiait le cas 7 bis du § 8.
  - *Constat 1-22D.1 :* aucune source n'établit qu'un `429` exclut la création. La
    documentation consignée (1-21A § 3) liste seulement `429` parmi les erreurs et donne la limite
    de 300 / min.
  - *Corrigé en 1-22D.2 :* la tentative reste incertaine et ouverte, puis elle est retrouvée par
    sa référence marchand. Le cas 7 bis est remplacé (`phase-1-22d2-saspay-ambiguous-create.md`).
    La pause de 15 s est conservée.
- **Délai résiduel** : un succès lu pendant une saturation des confirmations est rattrapé par le
  renvoi SasPay (30 s, 5 min, 30 min, 2 h) ou la passe suivante du rapprochement (5 min).
- **Limites des routes** : inchangées (10 / min par route et par compte). Elles sont désormais
  dominées par le quota d'appels.

## 10. Constat hors périmètre : e2e et `api/.env` (régression 1-22C)

`ConfigModule.forRoot({ validate })`, ajouté en 1-22C :

- fige `api/.env` + `process.env` au moment de l'import d'`AppModule` ;
- `ConfigService.get` préfère ensuite cette copie à `process.env`.

Les e2e fixent `MONGODB_URI` dans `beforeAll`, donc après l'import. Lancés depuis `api/`, ils
utilisent alors le `MONGODB_URI` de `api/.env` (`mongodb://localhost:27017`). C'est la base de
développement que la garde 0B.2 interdit : la garde valide l'URI éphémère, mais l'application ne
l'utilise pas.

- Ici, la connexion a échoué (aucun mongod local) ; aucune donnée n'a été touchée.
- Corrigé en 1-22D.1 (`phase-1-22d1-test-config-isolation.md`). Le lancement depuis `api/test`
  n'est **pas** une solution : il ne protège ni d'une URI héritée de l'environnement ni d'une
  configuration figée avant l'installation de l'URI temporaire.

## 11. Déploiement

Aucune variable, aucune migration, aucun index.

1. Revue, puis fusion API et web dans le même déploiement. Le web accepte aussi l'ancienne API :
   `Retry-After` est facultatif.
2. Vérifier que Railway exécute **une seule** instance d'API. Sinon, les seuils sont multipliés
   par le nombre d'instances (§ 5).
3. Après déploiement, sans trafic d'essai : surveiller les 429 `PAYMENT_RATE_LIMITED` et les 503
   des routes de paiement, et le journal « Rapprochement : … à reprendre ».
4. Rollback : redéploiement du commit précédent. Aucun état persistant n'est ajouté.
