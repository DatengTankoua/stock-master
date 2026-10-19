# Contact WhatsApp — canal prioritaire (pages publiques et Assistance)

Branche `feature/whatsapp-contact`, créée depuis `origin/dev` (`fc3032c`).
L'arbre de travail était propre : rien à préserver, aucun stash ni reset.
Aucun commit, push ou déploiement. Aucun message réel envoyé pendant les
tests : seules des URL sont construites.

Numéro WhatsApp Business : **+237 651 563 665**
(`https://wa.me/237651563665`, `tel:+237651563665`).

## 1. Fonctionnement

**Simple lien `wa.me`.** Ce n'est pas un chatbot : pas d'IA, pas d'API
WhatsApp, pas de réponse automatique, pas de conversation simulée, pas de
widget tiers ni de SDK Meta. Le site ne contacte jamais WhatsApp : le
navigateur ne suit le lien qu'au clic de l'utilisateur, et c'est
l'utilisateur qui envoie le message depuis WhatsApp. Rien n'est jamais
marqué comme « envoyé » par le site.

**Texte prérempli.** `composeContactText` ajoute une ligne de sujet
facultative (« Sujet : … » / « Subject: … »), puis une ligne vide, puis le
message. Les retours chariot sont normalisés (`\r\n` → `\n`) et les espaces
de début et de fin retirés. Le tout est encodé avec `encodeURIComponent`
(UTF-8, `%0A` pour les retours à la ligne, `%20` pour les espaces). Le texte
exact est affiché avant le bouton (« Texte prérempli dans WhatsApp ») et
reste modifiable dans WhatsApp. Aucune donnée du compte, du commerce, du
stock, d'un paiement, d'un jeton ni aucun fichier n'est ajouté.

**Brouillon.** Il est gardé dans l'état React du composant, jamais dans
`localStorage`, `sessionStorage`, IndexedDB ou un cookie. Il est conservé
après le clic (au cas où WhatsApp ne s'ouvre pas) et quand on ferme puis
rouvre la fenêtre. Il est perdu au changement de page.

**Hors connexion.** Un message explique que WhatsApp comme l'e-mail
nécessitent Internet, que le texte reste à l'écran et que rien ne sera
envoyé automatiquement. Le lien reste cliquable, car `navigator.onLine`
peut se tromper.

### Pages publiques (FR et EN)

- **Coordonnées.** Le pied de page commun affiche « Écrivez-nous sur
  WhatsApp à toute heure. » (EN : « Message us on WhatsApp at any time. »)
  et le lien vers le numéro. La page Contact s'ouvre sur une section
  « WhatsApp » avec le lien WhatsApp, le lien téléphone et la mise en garde
  sur le mot de passe. La formulation dit seulement « nous répondons dès que
  possible » : aucune réponse immédiate ni présence humaine permanente n'est
  promise. Les données structurées de l'accueil (`Organization`) reçoivent
  `telephone`.
- **Bouton flottant.** Il est monté par `PublicFooter`, donc présent sur
  l'accueil, les pages d'aide, les guides et les textes juridiques, en
  FR et en EN. Il n'apparaît pas dans `/app` ni `/auth`. Il ne s'ouvre
  jamais tout seul. Au clic, il ouvre une fenêtre (`Dialog` Base UI
  existant) qui contient :
  - un message d'accueil ;
  - un sujet facultatif : découverte, abonnement, aide technique, autre ;
  - le champ de la question (1 000 caractères au plus) ;
  - l'aperçu du texte transmis ;
  - « WhatsApp s'ouvrira. Envoyez votre message pour démarrer la
    conversation. » ;
  - le bouton « Continuer sur WhatsApp » ;
  - l'alternative e-mail, toujours affichée : `mailto:` prérempli vers
    `support@` pour l'aide technique, `contact@` sinon.

  Après le clic, un message rappelle que Stock Master n'envoie rien et que
  le texte est toujours là.
- **Placement.** Le bouton est dans le coin bas droit, au-dessus de la zone
  sûre iOS. Sous `lg`, il remonte tant que le bandeau de langue
  (`data-language-hint`) est affiché. La dernière bande du pied de page
  réserve l'espace du bouton, pour ne masquer ni les liens de langue ni un
  appel à l'action. Le site n'a pas de bandeau de consentement aux cookies.

### Pages de l'application (`/app`)

- **Bouton flottant.** C'est le même composant, en variante `app`. Il est
  monté par le shell `/app/layout.tsx`.
- **Conditions d'affichage.** Il n'apparaît que si toutes ces conditions
  sont remplies :
  - session applicative avec un contexte à jour ;
  - aucun blocage commercial ;
  - droit `support.contact`, comme pour l'Assistance ;
  - page autre que l'Assistance, qui a déjà sa propre carte.
- **Placement.** Sur mobile, le bouton (48 px, icône seule) se place
  au-dessus de la barre de navigation fixe, et plus haut quand cette barre
  s'agrandit hors connexion. Sur ordinateur, il est dans le coin bas droit.
  La marge basse du `<main>` est agrandie (`pb-36`, `pb-40` hors connexion,
  `md:pb-24`) pour que le bouton ne masque jamais la fin d'une page.
- **Contenu de la fenêtre.** Les sujets sont les catégories de l'Assistance
  (utilisation, abonnement, problème technique, autre). Une ligne rappelle
  que la conversation n'est pas synchronisée et qu'aucune information du
  compte n'est ajoutée. L'alternative e-mail renvoie vers le formulaire
  d'Assistance existant et ferme la fenêtre.

### Organisation → Assistance

- **Ordre.** La carte « Sur WhatsApp (recommandé) » vient en premier, puis
  la section « Par e-mail ».
- **Explication.** La carte dit que la conversation se poursuit dans
  WhatsApp, que ses messages et réponses ne sont ni enregistrés ni
  synchronisés dans Stock Master, qu'ils ne créent pas de demande
  d'assistance et qu'aucune information du compte n'est ajoutée.
- **Champs propres.** La carte a son propre sujet libre et son propre
  message, réutilisant `Input`, `Textarea` et `Label`. Elle n'impose ni la
  catégorie ni les règles de validation du formulaire e-mail, et ne partage
  aucun état avec lui : aucun envoi simultané sur les deux canaux.
- **Formulaire e-mail inchangé.** Il garde ses champs, sa validation, son
  idempotence (`requestId`), son contexte joint, ses erreurs et sa
  confirmation. Seuls changent son enveloppe (titre `h3` « Par e-mail »,
  ancre de l'alternative) et le titre du bloc de contexte, passé de `h3` à
  `h4` pour la hiérarchie des titres. Ce formulaire n'a pas de pièces
  jointes, ni dans le web ni dans l'API `support` : il n'y avait donc rien à
  conserver de ce côté.
- **Accès.** La carte n'apparaît que dans la branche autorisée
  (`support.contact`). La vue « droit refusé » est inchangée et renvoie
  toujours vers la page Contact, qui est publique.

## 2. Fichiers principaux

| Fichier | Rôle |
|---|---|
| `web/src/lib/legal/site-identity.ts` | `WHATSAPP` : source unique du numéro (affichage, chiffres, E.164, `wa.me`, `tel:`) |
| `web/src/lib/whatsapp-contact.ts` | Sujets publics, limites, `composeContactText`, `whatsappHref`, `mailtoHref` |
| `web/src/components/contact/whatsapp-continue.tsx` | Fin commune : aperçu, avertissement, hors ligne, lien, après-clic, alternative e-mail |
| `web/src/components/contact/whatsapp-icon.tsx` | Pictogramme local (tracés lucide), aucune ressource Meta |
| `web/src/components/contact/whatsapp-widget.tsx` | Bouton flottant et fenêtre, variantes `public` et `app` |
| `web/src/app/app/layout.tsx` | Montage dans l'application (conditions d'accès), marge basse |
| `web/src/components/public/public-footer.tsx` | Coordonnées WhatsApp, montage du bouton, espace réservé |
| `web/src/components/organization/whatsapp-support-card.tsx` | Carte WhatsApp de l'Assistance |
| `web/src/app/app/organization/support/page.tsx` | WhatsApp en premier, formulaire e-mail inchangé |
| `web/src/i18n/documents/contact/{fr,en}.tsx` | Section « WhatsApp » de la page Contact |
| `web/src/i18n/resources/{fr,en}/{common,public,organization}.ts` | Textes FR et EN (`whatsapp.*`, `support.whatsapp.*`, `support.channels`, `support.emailTitle`) |
| `web/src/components/i18n/english-version-hint.tsx` | Repère `data-language-hint` (évitement du bandeau) |
| `web/scripts/test-whatsapp-contact.mjs` | Tests (`pnpm --filter web test:whatsapp-contact`) |

## 3. Contrôles effectués

| Contrôle | Résultat |
|---|---|
| `test:whatsapp-contact` (nouveau, 14 tests) | 14/14. Côté application : sujets identiques aux catégories de l'Assistance ; bouton réservé au droit `support.contact`, hors blocage commercial et hors page Assistance. Couvre le numéro, les liens, l'encodage (accents, `«»`, `&`, `#`, `?`, `+`, `%`, emoji, CRLF → `%0A`, ligne vide après le sujet), le texte transmis sans ajout et le `mailto` en `%20`. Garde-fous statiques : numéro jamais recopié hors de `site-identity.ts` ; aucun stockage, `fetch`, axios, script, iframe ou Meta ; aucun appel à l'envoi d'assistance ; bouton monté sur les pages publiques et jamais ouvert d'office ; WhatsApp avant le formulaire e-mail |
| `tsc --noEmit` | OK |
| ESLint (fichiers modifiés) | OK |
| `check-i18n` | OK, 0 problème (mêmes clés, variables et balises FR/EN) |
| `i18n-coverage --fail` | 0 texte en dur sur 220 fichiers |
| `next build` | OK |
| `legal-archive check` | OK, aucun texte juridique archivé modifié |
| Tests web existants (en-têtes de sécurité, marque, push, ventes par lot) | 7/7, 41/41, 7/7, 8/8 |
| HTML servi par `next start` (`/`, `/en`, `/contact`, `/en/contact`, `/guide`, `/mentions-legales`) | Bouton présent partout, textes dans la bonne langue, `tel:` sur Contact, `telephone` en JSON-LD. `wa.me` n'apparaît que dans des `<a>` : aucune requête avant le clic, aucun script tiers |
| Règle CSS d'évitement du bandeau de langue | Présente dans la feuille compilée |

## 4. Limites et points ouverts

- **Pas de contrôle visuel automatisé.** Aucun navigateur piloté n'était
  disponible. L'affichage mobile et ordinateur, les thèmes clair et sombre
  et le parcours clavier (focus piégé, Échap, retour du focus, libellés)
  s'appuient sur le `Dialog` Base UI existant et sur les jetons de thème
  (`popover`, `--public-*`), mais **n'ont pas été vérifiés à l'écran**. À
  contrôler en recette, sur téléphone réel, avec et sans l'application
  WhatsApp installée.
- **Ouverture de WhatsApp.** Le lien s'ouvre dans un nouvel onglet ou dans
  l'application. Le site ne peut pas savoir si WhatsApp s'est ouvert : il
  n'essaie pas de le détecter et affiche toujours l'alternative e-mail.
- **Longueur.** Le message est limité à 1 000 caractères pour garder une
  URL de taille raisonnable.
- **Mentions légales.** Le numéro n'apparaît pas dans ce texte archivé :
  l'y ajouter (`OPERATOR.phone`) exige une nouvelle version et son
  archivage.
- **Conversations non synchronisées.** Aucune conversation n'est reliée à
  Stock Master. Une demande traitée sur WhatsApp n'a pas de référence
  d'assistance.
- **Écran de blocage commercial.** Quand l'abonnement est expiré,
  l'application affiche un écran de blocage, sans le bouton WhatsApp. Ces
  utilisateurs passent par la page Contact publique. L'ajouter à cet écran
  reste une décision produit.
- **Notifications temporaires.** Sur ordinateur, les notifications
  temporaires (Sonner, en bas à droite) peuvent recouvrir le bouton quelques
  secondes.
- **Copie hors ligne.** La copie hors ligne des pages publiques
  (`public/sw.js`) contiendra le bouton. Ouvert hors ligne, il affiche le
  message « nécessite une connexion ».
