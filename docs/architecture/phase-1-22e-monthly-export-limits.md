# Lot 1-22E — Export mensuel : maîtrise des ressources

État : **piste 7 de l'audit 1-22A reproduite puis corrigée.**

- Une demande est admise avant toute requête coûteuse.
- Un mois volumineux est refusé avant la lecture des ventes.
- La capacité globale se mesure en coût, ajusté aux lignes réellement chargées.

Rien n'est commité, poussé ni déployé. Aucun service réel, aucune base réelle. Les paiements ne
sont pas modifiés.

## 1. Référence

| Élément | Valeur |
|---|---|
| Base | `origin/main` (`675e1b3`), même contenu que `fix/phase-1-22d3-…` (`c60c43c`) + fusions #45/#46 ; arbre propre au départ |
| Branche | `security/phase-1-22e-monthly-export-limits`, sans stash, reset ni nettoyage |
| Variables, migrations | Aucune |

Le stash (`stash@{0}`) est conservé. La mesure « avant » du scénario 3 × Excel 20 000 (§ 3.2) a
été faite dans un worktree temporaire de `origin/main`, supprimé ensuite.

## 2. Chemin réel et cause

`GET /reports/monthly/:month/:format` (`xlsx` ou `pdf`), réservé au propriétaire et à
l'administrateur (`analytics.read` + `sales.view_all`) :

1. Le limiteur 1-16D admet la génération : quota de 20 par compte et commerce sur 10 min,
   au plus 3 générations simultanées au total et 2 par commerce.
2. `MonthlyHistoryService.build` lit **toutes** les ventes du mois sans limite, plus les trois
   agrégations de l'Analyse et **toutes** les corrections et annulations du journal d'audit.
3. Le rendu `renderMonthlyHistoryXlsx` / `renderMonthlyHistoryPdf` est **synchrone** et se fait
   en mémoire, sur la boucle d'événements : XML ou mise en page PDF, puis `deflate*Sync`.
4. Le `Buffer` complet est renvoyé.

**Cause.** Le volume n'était borné nulle part. La borne globale comptait les exports sans tenir
compte de leur taille. Comme le rendu bloque la boucle, chaque requête du processus (tous les
commerces) attendait la fin du rendu. Trois gros exports admis ensemble se succédaient sur la
boucle.

Profil local du rendu seul (banc hors HTTP, par ligne de vente) : PDF ≈ 0,2 ms, dominé par la
mise en page (zlib ≈ 6 %). Excel ≈ 0,04 ms, dont ≈ 70 % pour le `deflateRawSync` niveau 9.

## 3. Mesures

**Toutes les durées sont des mesures locales, sur un seul poste. Ce ne sont pas des maxima
garantis** : elles varient avec le CPU, la charge de MongoDB et le contenu des ventes.

Conditions :
- sonde `api/test/load/monthly-export-probe.ts` ;
- MongoDB éphémère, données synthétiques (200 produits, 6 vendeurs, données acheteur) ;
- API complète en processus, tas borné (`--max-old-space-size=512`) ;
- poste Windows 11, Node 22.17.1.

Pendant chaque export, un commerce **différent** appelle `GET /reports/monthly` en boucle.

Colonnes :
- **Boucle** : retard maximal mesuré de la boucle d'événements ;
- **Autre commerce** : attente maximale mesurée de cette requête légère (seule, elle répond en
  13 à 20 ms médian et moins de 90 ms au pire).

### 3.1 Exports isolés

| Scénario | Avant : statut / durée / boucle / RSS / autre commerce | Après |
|---|---|---|
| Excel 5 000 ventes | 200 / 565 ms / 277 ms / 286 Mo / 562 ms | 200 / 516 / 259 / 301 / 515 ms |
| PDF 5 000 | 200 / 1 397 / 1 111 / 305 / 1 388 ms | 200 / 1 228 / 988 / 320 / 1 222 ms |
| Excel 20 000 | 200 / 1 815 / 1 107 / 342 / 1 814 ms | 200 / 1 642 / 963 / 323 / 1 641 ms |
| PDF 20 000 | 200 / 4 987 / **4 224** / 417 / **4 980 ms** | **422** / 49 / 18 / — / 50 ms |
| Excel 50 000 | 200 / 4 686 / 2 816 / 455 / 4 682 ms | **422** / 93 / 19 / — / 93 ms |
| PDF 50 000 | 200 / 14 705 / **12 902** / 659 / **14 683 ms** | **422** / 95 / 20 / — / 95 ms |

### 3.2 Exports simultanés (3 commerces + 1 export de trop)

| Scénario | Avant | Après |
|---|---|---|
| 3 × Excel 50 000 + 1 | 200, 200, 200, 503 ; autre commerce **12,6 s** ; boucle 5,5 s ; RSS **723 Mo** | 4 × 422 ; 128 ms ; RSS 301 Mo |
| 3 × Excel 20 000 + 1 (taille maximale admise) | 200, 200, 200, 503 ; autre commerce **4,5 s** ; boucle 1,9 s ; RSS 470 Mo | 200, 503, 503, 503 (`Retry-After: 10`) ; **2,0 s** ; boucle 1,2 s ; RSS 356 Mo |

Avec 1 000 ventes, un PDF bloquait déjà la boucle 267 ms. Sans borne, l'attente imposée aux
autres commerces croissait linéairement avec le volume.

### 3.3 Demandes répétées d'un mois trop volumineux (complément)

Scénario : un même compte envoie 100 demandes simultanées du PDF d'un mois de 50 000 ventes
(`PROBE_REPEAT=100 PROBE_ONLY=repeat`).

| | Avant admission | Après admission |
|---|---|---|
| Réponses | 100 × 422 : **100 comptages** | 3 × 422, 97 × 503 : **3 comptages** |
| Durée totale / autre commerce | 2 204 ms / **2 205 ms** | 926 ms / **928 ms** |
| Boucle | 271 ms | 285 ms |

Le comptage n'est pas gratuit. Aucun index ne couvre `occurredAt`, donc le filtre du mois lit
**toutes** les ventes du commerce, pas seulement celles du mois. Le reste de l'attente après
correction vient de 100 requêtes traversant les gardes globales (session, organisation,
abonnement), communes à toute l'API et hors du périmètre de ce lot.

## 4. Correction

Quatre mécanismes en mémoire, sans worker ni file :

1. **Admission de la demande, avant le comptage.** Avant `countRows`, seules les gardes globales
   s'appliquent. Le `ThrottlerModule` ne couvre pas cette route, et le quota de génération ne
   voyait pas les 422. `admitRequest` ajoute deux bornes :
   - un quota de **demandes** par compte et commerce, qui compte aussi les 422 et les 503 (429
     `REPORT_REQUESTS_LIMITED`) ;
   - un nombre borné de **comptages** simultanés, global et par commerce (503
     `REPORT_GENERATION_BUSY`).

   Ce quota est distinct du **quota de génération**. Un 422 consomme une demande, jamais une
   génération. Une demande refusée ne consomme rien. La place de comptage est rendue dès que la
   génération est admise ou refusée.
2. **Volume borné avant la lecture.** `countRows` compte les ventes du mois (même filtre que
   l'Analyse) et les corrections et annulations. Au-delà du plafond du format, la réponse est
   **422 `REPORT_TOO_LARGE`** : rien n'est chargé et le quota de génération n'est pas consommé.
   Les lectures de `build` sont limitées à `maxRows + 1`. Si le volume a dépassé le plafond
   depuis le comptage, la réponse est le même 422, jamais un fichier partiel.
3. **Capacité globale en coût.** Le coût d'un export vaut lignes × coût du format (PDF 4,
   Excel 1, d'après le profil du § 2). Le coût cumulé des générations en cours est plafonné, en
   plus des bornes existantes (3 au total, 2 par commerce). Les rendus admis ensemble se
   succèdent sur la boucle : ce plafond borne donc leur temps de rendu cumulé, quel que soit le
   nombre de commerces.
4. **Coût ajusté aux lignes réellement chargées (complément).** Le comptage peut sous-estimer :
   des ventes ou des mouvements peuvent arriver avant la lecture, tout en restant sous le
   plafond. `build` appelle donc `admitRows` dès que ventes, corrections et annulations sont
   chargées, avant les autres lectures et avant le rendu. Le contrôleur y remplace la
   réservation par `resize`. Le remplacement est atomique : il est synchrone, et aucune autre
   admission ne peut s'intercaler. S'il ferait dépasser le budget, la réponse est **503** avec
   `Retry-After`, sans fichier, et place et coût sont libérés. Le budget n'est donc jamais
   dépassé en silence.

| Seuil (`REPORT_GENERATION_LIMITS`) | Valeur | Justification |
|---|---|---|
| `maxRequestsPerWindow` | 40 / 10 min (compte et commerce) | Deux demandes par génération admise (20) : quelques refus n'empêchent pas un usage normal |
| `maxCountingGlobal` / `PerOrganization` | 4 / 2 | Un comptage dure ≈ 90 ms localement pour 50 000 ventes ; 2 par commerce couvrent Excel et PDF |
| `maxRows.xlsx` | 20 000 lignes | ≈ 1 s de boucle mesurée localement ; ≈ 670 ventes par jour |
| `maxRows.pdf` | 5 000 lignes | ≈ 1 s de boucle mesurée localement (PDF ≈ 4 × Excel) ; ≈ 2 000 pages A4 au-delà, peu lisible |
| `rowCost` | Excel 1, PDF 4 | Rapport des temps de rendu mesurés |
| `maxActiveCost` | 30 000 | Un export au plafond + 10 000 de marge ; un gros export n'attend pas que tout se vide |
| Quota et simultanéité de génération | inchangés (20 / 10 min ; 3 ; 2) | — |

**Pas de timeout.** Il rendrait la main sans arrêter le calcul. Une génération dont le client
s'est déconnecté va à son terme mais **garde sa place** : elle reste comptée dans la capacité.

**Pas de worker.** Il supprimerait le blocage résiduel du rendu, au prix d'un pool, d'une
sérialisation et d'une gestion d'arrêt. Ce blocage est désormais borné par le volume et le
budget, et l'opération est rare (quotas). À reconsidérer si les plafonds doivent monter
nettement.

## 5. Comportement utilisateur

- **Aucun fichier tronqué.** Tous les refus (422, 429, 503) sont du JSON sans
  `Content-Disposition`.
- **Message FR/EN** côté serveur et côté interface. Il donne le nombre de lignes, le plafond et
  l'action réellement disponible :
  - si seul le PDF dépasse : « Téléchargez la version Excel » (l'Excel est complet et accepté) ;
  - sinon : l'utilisateur peut **demander de l'aide** à l'assistance.

  **Aucune procédure ni aucun outil ne produit aujourd'hui un export au-delà de 20 000 lignes.**
  L'assistance (`/app/organization/support`, `support@stock-master.app`) reçoit la demande, mais
  rien n'est promis : les messages disent « Vous pouvez contacter l'assistance si vous avez
  besoin d'aide ». L'interface ne permet pas de période plus courte qu'un mois, donc aucune
  n'est proposée.
- **Avant le clic.** `GET /reports/monthly` renvoie `maxRows`. Pour un mois dont le nombre de
  ventes dépasse le plafond, le bouton du format refusé est désactivé et une note l'explique.
  Le lien vers l'assistance n'apparaît que pour un compte qui a `support.contact`. Le serveur
  reste seul juge, car il compte aussi corrections et annulations.
- **Quotas.** `REPORT_REQUESTS_LIMITED` est affiché comme le quota de génération (« Trop de
  téléchargements… »), avec le délai. Les messages 429 et 503 sont lancés en français et
  traduits par le filtre global selon la langue de la requête (catalogue
  `ERROR_MESSAGE_TRANSLATIONS`, entrées déjà présentes). *Correction : une première version de
  ce lot les composait en anglais dans le contrôleur, ce qui était inutile et faisait échouer
  `common/i18n/i18n.spec.ts` (message lancé absent du catalogue). Elle est revenue au message
  français ; l'ancienne remarque « autrefois toujours en français » était inexacte.*
- **Exports normaux inchangés** : mêmes requêtes, mêmes contrôles de cohérence avec l'Analyse,
  même rendu. Les permissions et les règles historiques (1-15D) ne changent pas.
- **Isolation.** Les **données** sont isolées : comptage et lectures sont filtrés par
  l'`organizationId` du contexte. Les **plafonds individuels** aussi : le volume d'un commerce
  ne compte jamais pour un autre. En revanche, la **capacité globale reste partagée** (comptages
  et coût des générations) : les exports d'un commerce peuvent valoir un 503 temporaire à un
  autre.

## 6. Tests

| Test | Couvre |
|---|---|
| `report-generation-limiter.spec.ts` (+4) | Plafonds cohérents (PDF < Excel, un export au plafond admissible seul). Budget de coût entre commerces. **Admission des demandes** : comptages bornés (global, par commerce), quota de demandes avec délai exact, indépendant du quota de génération. **`resize`** : hausse admise si le budget le permet, refusée sinon (réservation inchangée), baisse toujours admise, rien après libération. Coût rendu après succès et après erreur |
| `monthly-history-limits.e2e-spec.ts` (+5) | Deux PDF au plafond de deux commerces : le second reçoit 503 (coût). Plafond **atteint** : 200 ; **dépassé** : 422 FR/EN sans fichier, `build` jamais appelé, Excel proposé puis servi ; Excel dépassé : 422 avec aide, sans promesse. Course qui dépasse le plafond : 422 et place rendue. **Demandes répétées** : 8 × 422 puis 429 sans 9e comptage, aucune génération ; comptage simultané du même commerce : 503, un autre commerce passe. **Volume accru sous le plafond** (1 vente comptée, 3 ventes + 1 annulation chargées) : réservation pendant le rendu = 4, pas 1. **Ajustement impossible** : 503 sans fichier, place et coût d'E libérés, puis export entier une fois le budget libre |
| `monthly-history-export.e2e-spec.ts`, `analytics-insights.e2e-spec.ts`, `multitenant-isolation.e2e-spec.ts` | Contenu exact des exports, cohérence avec l'Analyse, isolation : inchangés |

Résultats :
- unitaires `src/reports` : 20/20 ;
- e2e : 44/44 sur les quatre suites ci-dessus ;
- typage : API (`tsconfig.build.json` complet ; `tsconfig.json` sans erreur sur les fichiers
  modifiés, les erreurs restantes sont antérieures et sans rapport) et web ;
- `eslint` des fichiers modifiés et `test:i18n` : OK.

`monthly-boundaries-douala.e2e-spec.ts` **n'a pas pu s'exécuter** sur ce poste : Node ignore
`TZ` sous Windows et la suite s'ignore elle-même. Elle n'est pas touchée par ce lot.

Commande de la sonde : en tête de `monthly-export-probe.ts` (`PROBE_REPEAT`, `PROBE_ONLY=repeat`
pour § 3.3).

## 7. Limites

- **Portée par processus.** Quotas, comptages, simultanéité et coût sont tenus en mémoire, comme
  les autres limitations du projet. Avec N réplicas, la capacité totale est N fois celle-ci, mais
  chaque processus reste protégé, ce qui est l'objectif. Les quotas d'un compte se multiplient
  aussi par N si le répartiteur alterne les instances. Le nombre de réplicas Railway n'est pas
  vérifié (audit 1-22A § 4).
- **Mesures locales.** Sur un CPU plus lent ou une base chargée, les durées croissent. Les seuils
  sont des choix appuyés sur ces mesures, pas des garanties. Les valeurs sont centralisées dans
  `REPORT_GENERATION_LIMITS`.
- **Blocage résiduel.** Un export au plafond bloque encore la boucle pendant son rendu (≈ 1 s
  sur le poste de mesure). Le budget borne le cumul, pas la durée de chaque rendu.
- **Comptage.** Le compte est un majorant : une correction sans effet est comptée mais pas
  listée. Sans index sur `occurredAt`, il lit toutes les ventes du commerce. Il est désormais
  borné en nombre (quota de demandes) et en simultanéité.
- **Gardes globales.** Elles s'exécutent avant toute admission et relisent session,
  appartenance et abonnement en base. Une rafale reste donc coûteuse (§ 3.3) ; c'est un sujet
  commun à toute l'API, hors de ce lot.
- **Course qui dépasse le plafond (rare).** Le 422 survient après l'admission : une génération
  du quota est consommée.
- **Attente d'un gros export.** Un export au plafond peut recevoir 503 tant que d'autres exports
  occupent plus de 10 000 unités de coût. Réessayer après `Retry-After`.
- **Au-delà de 20 000 lignes**, aucun export n'est possible avec les outils actuels (§ 5).

## 8. Déploiement

- Aucune variable, aucune migration, aucun nouvel index.
- Déployer l'API et le web ensemble :
  - **web ancien + API nouvelle** : un 422 ou un `REPORT_REQUESTS_LIMITED` affiche un message
    générique ;
  - **web nouveau + API ancienne** : `maxRows` est absent, aucune pré-indication n'est affichée,
    comportement antérieur.
- Après déploiement :
  - télécharger un mois normal en Excel et en PDF ;
  - vérifier qu'un mois au-delà de 5 000 lignes renvoie 422 en PDF et propose l'Excel.
