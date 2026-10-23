import type { AppLocale } from './locale';

/**
 * 1-16G — Traduction des messages d'erreur renvoyés par l'API, selon la
 * langue de la REQUÊTE. Les codes (`code`), statuts HTTP et champs annexes
 * ne changent jamais : seul le texte `message` est traduit, au moment de la
 * réponse (filtre global), sans toucher aux services.
 *
 * Clé = message tel qu'il est lancé dans le code (relevé statique :
 * `error-message-scan.ts`), `${…}` marquant une valeur variable. Valeurs :
 * `{0}`, `{1}`… reprennent les valeurs variables dans l'ordre. Un message
 * déjà dans la langue demandée est renvoyé tel quel. Un message absent du
 * catalogue est renvoyé tel quel (même protection qu'avant : le filtre ne
 * fabrique jamais de texte à partir d'une erreur technique).
 *
 * Les messages anglais historiques reçoivent aussi une version française.
 */
type Translations = { fr?: string; en?: string };

export const ERROR_MESSAGE_TRANSLATIONS: Readonly<
  Record<string, Translations>
> = Object.freeze({
  // ─── Authentification, session, comptes ───────────────────────────────
  "L'inscription est actuellement désactivée.": {
    en: 'Sign-up is currently disabled.',
  },
  'Email ou mot de passe incorrect!': {
    en: 'Incorrect email or password.',
  },
  'Si un compte correspond à cette adresse, vous recevrez un lien pour réinitialiser votre mot de passe.':
    {
      en: 'If an account matches this address, you will receive a link to reset your password.',
    },
  "Si un compte non vérifié correspond à cette adresse, un nouveau lien de confirmation vient d'être envoyé.":
    {
      en: 'If an unverified account matches this address, a new confirmation link has just been sent.',
    },
  'Confirmez votre adresse email pour accéder à votre compte.': {
    en: 'Confirm your email address to access your account.',
  },
  'Ce lien de confirmation est invalide ou a expiré.': {
    en: 'This confirmation link is invalid or has expired.',
  },
  'Ce lien de réinitialisation est invalide ou a expiré.': {
    en: 'This reset link is invalid or has expired.',
  },
  "L'envoi d'emails est momentanément indisponible. Réessayez plus tard.": {
    en: 'Sending emails is temporarily unavailable. Try again later.',
  },
  'Le mot de passe doit contenir entre 6 et 100 caractères.': {
    en: 'The password must be between 6 and 100 characters.',
  },
  'Votre session a expiré. Veuillez vous reconnecter.': {
    en: 'Your session has expired. Please log in again.',
  },
  'Cet échange exige une session limitée.': {
    en: 'This exchange requires a limited session.',
  },
  'Aucun paramètre attendu.': {
    en: 'No parameters expected.',
  },
  'Trop de tentatives de connexion. Réessayez plus tard.': {
    en: 'Too many login attempts. Try again later.',
  },
  'Trop de demandes. Réessayez plus tard.': {
    en: 'Too many requests. Try again later.',
  },
  'Le nom doit contenir entre 1 et ${…} caractères.': {
    en: 'The name must be between 1 and {0} characters.',
  },
  "Le nom de l'organisation doit contenir entre 1 et ${…} caractères.": {
    en: 'The organisation name must be between 1 and {0} characters.',
  },
  'Invalid id: ${…}': {
    fr: 'Identifiant invalide : {0}',
  },

  // ─── Organisation, membres, invitations, droits ──────────────────────
  "Accès à l'organisation refusé.": {
    en: 'Access to the organisation denied.',
  },
  'Permission insuffisante.': {
    en: 'Insufficient permission.',
  },
  'Insufficient permissions': {
    fr: 'Permissions insuffisantes.',
    en: 'Insufficient permissions.',
  },
  "Trop de créations d'invitations. Réessayez plus tard.": {
    en: 'Too many invitations created. Try again later.',
  },
  "Le lien d'invitation ne peut pas être généré : configuration du serveur incomplète.":
    {
      en: 'The invitation link cannot be generated: server configuration incomplete.',
    },
  'Cet email appartient déjà à un membre actif de cette organisation.': {
    en: 'This email already belongs to an active member of this organisation.',
  },
  'Une invitation est déjà en attente pour cet email.': {
    en: 'An invitation is already pending for this email.',
  },
  // 1-18E : réponse neutre de l'inscription publique.
  "Si cette adresse peut être utilisée, un e-mail de confirmation vient d'y être envoyé. Si vous avez déjà un compte, connectez-vous ou réinitialisez votre mot de passe.":
    {
      en: 'If this address can be used, a confirmation email has just been sent to it. If you already have an account, log in or reset your password.',
    },
  // 1-18C : récupération d'accès après plafond par compte.
  'Trop de tentatives pour ce compte. Validez la vérification anti-robot pour réessayer.':
    {
      en: 'Too many attempts for this account. Complete the anti-bot check to try again.',
    },
  // 1-18C : vérification anti-robot de l'inscription.
  'Validez la vérification anti-robot, puis réessayez.': {
    en: 'Complete the anti-bot check, then try again.',
  },
  'La vérification anti-robot a échoué ou a expiré. Recommencez-la, puis réessayez.':
    {
      en: 'The anti-bot check failed or expired. Complete it again, then try again.',
    },
  'La vérification anti-robot est momentanément indisponible. Réessayez plus tard.':
    {
      en: 'The anti-bot check is temporarily unavailable. Try again later.',
    },
  // 1-18B : acceptation des invitations.
  "Cette invitation est destinée à un autre compte. Connectez-vous avec l'adresse invitée.":
    {
      en: 'This invitation is for another account. Sign in with the invited address.',
    },
  "Un compte existe déjà pour cette adresse. Connectez-vous, puis ouvrez de nouveau le lien d'invitation.":
    {
      en: 'An account already exists for this address. Sign in, then open the invitation link again.',
    },
  "Si l'adresse invitée n'a pas encore de compte, un lien pour le créer vient d'y être envoyé.":
    {
      en: 'If the invited address does not have an account yet, a link to create one has just been sent to it.',
    },
  'Ce compte appartient déjà à cette organisation.': {
    en: 'This account already belongs to this organisation.',
  },
  'Au moins un champ (role, permissions, status) est requis.': {
    en: 'At least one field (role, permissions, status) is required.',
  },
  'Un membre ne peut pas modifier sa propre membership.': {
    en: 'A member cannot change their own membership.',
  },
  'Le propriétaire ne peut pas être modifié par cette route.': {
    en: 'The owner cannot be changed through this route.',
  },
  'La cible est déjà propriétaire de cette organisation.': {
    en: 'The target is already the owner of this organisation.',
  },
  'La cible du transfert doit avoir une membership active.': {
    en: 'The transfer target must have an active membership.',
  },
  'Cette invitation est invalide ou a expiré.': {
    en: 'This invitation is invalid or has expired.',
  },
  'Au moins un champ (name, brandColor, logo) est requis.': {
    en: 'At least one field (name, brandColor, logo) is required.',
  },
  'Le logo doit être une image PNG ou WebP statique valide.': {
    en: 'The logo must be a valid static PNG or WebP image.',
  },
  'Requête multipart invalide.': {
    en: 'Invalid multipart request.',
  },
  'permissions : les doublons ne sont pas autorisés': {
    en: 'permissions: duplicates are not allowed',
  },
  'permissions : seules les permissions délégables connues sont autorisées': {
    en: 'permissions: only known delegable permissions are allowed',
  },

  // ─── Conditions ───────────────────────────────────────────────────────
  "L'acceptation des conditions est requise.": {
    en: 'Acceptance of the terms is required.',
  },
  'Les documents indiqués ne correspondent pas à ce parcours.': {
    en: 'The documents given do not match this process.',
  },
  "L'enregistrement de l'acceptation est momentanément indisponible.": {
    en: 'Recording the acceptance is temporarily unavailable.',
  },
  "Ces conditions n'existent pas dans cette langue.": {
    en: 'These terms do not exist in this language.',
  },
  'Les conditions ont été mises à jour : recharge la page pour lire la version en vigueur.':
    {
      en: 'The terms have been updated: reload the page to read the version in force.',
    },

  // ─── Catalogue, produits, ventes ──────────────────────────────────────
  // 1-20D à 1-20F : relectures ciblées et pages (entrées manquantes).
  'ids must be a comma-separated list': {
    fr: 'ids doit être une liste séparée par des virgules.',
    en: 'ids must be a comma-separated list.',
  },
  'ids must contain 1 to ${…} product ids': {
    fr: 'ids doit contenir de 1 à ${…} identifiants de produit.',
    en: 'ids must contain 1 to ${…} product ids.',
  },
  'ids and limit are exclusive': {
    fr: 'ids et limit ne peuvent pas être utilisés ensemble.',
    en: 'ids and limit are exclusive.',
  },
  'sectionId must be a product section id': {
    fr: 'sectionId doit être un identifiant de section.',
    en: 'sectionId must be a product section id.',
  },
  'Invalid sales cursor': {
    fr: 'Curseur de l’historique des ventes invalide.',
    en: 'Invalid sales cursor.',
  },
  'Image file is required': {
    fr: 'La photo est obligatoire.',
    en: 'Image file is required.',
  },
  'Only image files are allowed': {
    fr: 'Seules les images sont acceptées.',
    en: 'Only image files are allowed.',
  },
  'La photo doit être une image JPEG, PNG ou WebP.': {
    en: 'The photo must be a JPEG, PNG or WebP image.',
  },
  'La photo ne doit pas dépasser 5 Mo.': {
    en: 'The photo must not exceed 5 MB.',
  },
  'La photo ne doit pas dépasser 6000 pixels de côté ni 24 mégapixels.': {
    en: 'The photo must not exceed 6000 pixels per side or 24 megapixels.',
  },
  'Photo vide, corrompue, animée ou illisible.': {
    en: 'Empty, corrupted, animated or unreadable photo.',
  },
  'La photo de ce produit vient d’être modifiée. Rechargez puis réessayez.': {
    en: "This product's photo has just been changed. Reload and try again.",
  },

  // ─── Stockage (1-17B) ─────────────────────────────────────────────────
  "Espace de stockage insuffisant : cet envoi dépasserait le quota de l'organisation.":
    {
      en: "Not enough storage space: this upload would exceed the organisation's quota.",
    },
  // ─── Capacité incluse (1-21D) ─────────────────────────────────────────
  'Capacité incluse atteinte : nombre maximal de fiches produit conservées, corbeille comprise. Aucune nouvelle fiche ne peut être créée ; les ventes, consultations et modifications restent possibles.':
    {
      en: 'Included capacity reached: maximum number of product records kept, trash included. No new record can be created; sales, viewing and editing remain available.',
    },
  'Organisation introuvable.': {
    en: 'Organisation not found.',
  },
  "L'envoi du fichier a été interrompu. Réessayez.": {
    en: 'The file upload was interrupted. Try again.',
  },
  'Le logo vient d’être modifié. Rechargez la page puis réessayez.': {
    en: 'The logo has just been changed. Reload the page and try again.',
  },
  'Cette fonctionnalité a été retirée.': {
    en: 'This feature has been removed.',
  },
  'Product ${…} not found': {
    fr: 'Produit {0} introuvable.',
    en: 'Product {0} not found.',
  },
  'Section ${…} not found': {
    fr: 'Section {0} introuvable.',
    en: 'Section {0} not found.',
  },
  'Sale ${…} not found': {
    fr: 'Vente {0} introuvable.',
    en: 'Sale {0} not found.',
  },
  // Lot B : demande de régularisation.
  'Request ${…} not found': {
    fr: 'Demande {0} introuvable.',
    en: 'Request {0} not found.',
  },
  'Object with id ${…} not found': {
    fr: 'Élément {0} introuvable.',
    en: 'Object with id {0} not found.',
  },
  'Insufficient stock. Available: ${…}': {
    fr: 'Stock insuffisant. Disponible : {0}',
  },
  'Not enough stock. Available: ${…}': {
    fr: 'Stock insuffisant. Disponible : {0}',
  },
  'name must contain a non-whitespace character': {
    fr: 'Le nom doit contenir au moins un caractère visible.',
    en: 'The name must contain a non-whitespace character.',
  },
  'La date de vente est hors de la plage autorisée.': {
    en: 'The sale date is outside the allowed range.',
  },
  "Clé d'opération déjà utilisée.": {
    en: 'Operation key already used.',
  },
  "Clé d'opération déjà utilisée pour une autre vente.": {
    en: 'Operation key already used for another sale.',
  },
  'Vente déjà enregistrée puis supprimée.': {
    en: 'Sale already recorded, then deleted.',
  },

  // ─── Lots de produits (lot A) ─────────────────────────────────────────
  "Ce produit est suivi par lots : cette opération n'est pas encore disponible pour lui.":
    {
      en: 'This product is tracked by batches: this operation is not available for it yet.',
    },
  "Le suivi par lots n'est pas disponible.": {
    en: 'Batch tracking is not available.',
  },
  "Le suivi par lots n'est pas disponible pour le moment. Réessayez plus tard.":
    {
      en: 'Batch tracking is not available at the moment. Try again later.',
    },
  "Le suivi par lots n'est pas activé pour ce produit.": {
    en: 'Batch tracking is not enabled for this product.',
  },
  'Le suivi par lots est déjà activé pour ce produit.': {
    en: 'Batch tracking is already enabled for this product.',
  },
  'La somme des lots doit être exactement égale au stock restant.': {
    en: 'The batches must add up exactly to the remaining stock.',
  },
  "Le stock de ce produit n'est pas un nombre entier d'unités : répartition impossible.":
    {
      en: 'This product’s stock is not a whole number of units: it cannot be split into batches.',
    },
  'Le stock a changé depuis l’affichage. Actualisez puis répartissez à nouveau.':
    {
      en: 'The stock has changed since it was displayed. Refresh, then split it again.',
    },
  'Lot introuvable pour ce produit.': {
    en: 'Batch not found for this product.',
  },
  'La date de réception ne peut pas être dans le futur.': {
    en: 'The receipt date cannot be in the future.',
  },
  "La date de réception d'un lot reçu ne peut pas être retirée.": {
    en: 'The receipt date of a received batch cannot be removed.',
  },
  "Clé d'opération déjà utilisée pour une autre opération.": {
    en: 'Operation key already used for another operation.',
  },
  // Lot B : ventes, corrections et annulations par lots.
  "Ce produit est suivi par lots : mettez à jour l'application puis choisissez les lots vendus.":
    {
      en: 'This product is tracked by batches: update the app, then choose the batches sold.',
    },
  "Chaque lot ne peut apparaître qu'une fois.": {
    en: 'Each batch can only appear once.',
  },
  "Un lot choisi n'est plus disponible. Actualisez les lots.": {
    en: 'A chosen batch is no longer available. Refresh the batches.',
  },
  'Un lot choisi n’a pas de date de péremption connue : confirmez ce choix.': {
    en: 'A chosen batch has no known expiry date: confirm this choice.',
  },
  'Un lot choisi a dépassé sa date de péremption : il ne peut pas être vendu.':
    {
      en: 'A chosen batch is past its expiry date: it cannot be sold.',
    },
  'Vente saisie avant la péremption du lot mais reçue après : une régularisation autorisée est nécessaire.':
    {
      en: 'Sale entered before the batch expired but received after: an authorised regularisation is required.',
    },
  "Un lot choisi n'a plus assez d'unités. Actualisez les lots.": {
    en: 'A chosen batch no longer has enough units. Refresh the batches.',
  },
  'Le stock a changé. Actualisez les lots.': {
    en: 'The stock has changed. Refresh the batches.',
  },
  'Le produit a été supprimé définitivement : aucune restitution de stock possible.':
    {
      en: 'The product was permanently deleted: no stock can be returned.',
    },
  'La somme des lots doit être exactement égale à la quantité vendue.': {
    en: 'The batches must add up exactly to the quantity sold.',
  },
  'Indiquez le motif de la restitution.': {
    en: 'Give the reason for returning the units.',
  },
  "Un lot rendu ne correspond pas aux lots d'origine de la vente.": {
    en: 'A returned batch does not match the batches of the sale.',
  },
  "Les unités restituées dépassent celles dont le lot d'origine est inconnu.": {
    en: 'The returned units exceed those whose original batch is unknown.',
  },
  'Cette vente est antérieure au suivi par lots : indiquez dans quels lots restituer les unités, avec un motif.':
    {
      en: 'This sale predates batch tracking: say which batches the units go back to, with a reason.',
    },
  'Ce produit est suivi par lots : précisez les lots concernés par la correction.':
    {
      en: 'This product is tracked by batches: specify the batches affected by the correction.',
    },
  'Les lots indiqués ne correspondent pas à la nouvelle quantité.': {
    en: 'The batches given do not match the new quantity.',
  },
  "Cette vente n'a pas besoin de régularisation : renvoyez-la normalement.": {
    en: 'This sale does not need regularising: send it normally.',
  },
  'Cette vente est déjà enregistrée : aucune régularisation à demander.': {
    en: 'This sale is already recorded: there is nothing to regularise.',
  },
  'Cette demande a déjà été traitée.': {
    en: 'This request has already been handled.',
  },
  'La demande doit reprendre la vente en attente telle quelle (opération, heure et lots).':
    {
      en: 'The request must carry the pending sale as is (operation, time and batches).',
    },
  // Lot C : mise à l'écart, pertes, alertes.
  "Ce lot est déjà dans cet état ou ne peut pas changer d'état ainsi.": {
    en: 'This batch is already in this state or cannot change state this way.',
  },
  'Précisez la cause de la perte dans le commentaire.': {
    en: 'Give the cause of the loss in the comment.',
  },
  'La correction dépasse les unités perdues non encore corrigées.': {
    en: 'The correction exceeds the lost units not yet corrected.',
  },
  'Perte introuvable pour ce produit.': {
    en: 'Loss not found for this product.',
  },
  "Ce lot est mis à l'écart ou retiré : il ne reçoit plus d'unités.": {
    en: 'This batch is set aside or withdrawn: it no longer receives units.',
  },
  'Les alertes de péremption ne sont pas disponibles.': {
    en: 'Expiry alerts are not available.',
  },
  'La quantité vendue doit rester au moins égale à 1.': {
    en: 'The quantity sold must stay at least 1.',
  },
  "Les unités restituées doivent correspondre exactement à celles dont le lot d'origine est inconnu.":
    {
      en: 'The returned units must exactly match those whose original batch is unknown.',
    },

  // ─── Analyse, rapports, notifications ─────────────────────────────────
  'Mois invalide.': { en: 'Invalid month.' },
  'Liste demandée invalide.': { en: 'Invalid list requested.' },
  'Format invalide.': { en: 'Invalid format.' },
  'Des ventes ont changé pendant la préparation du rapport. Réessayez.': {
    en: 'Some sales changed while the report was being prepared. Try again.',
  },
  'Certains noms de ce mois contiennent des caractères que le PDF ne peut pas reproduire fidèlement (${…}${…}). Téléchargez la version Excel, qui les conserve exactement.':
    {
      en: 'Some names for this month contain characters that the PDF cannot reproduce faithfully ({0}{1}). Download the Excel version, which keeps them exactly.',
    },
  "Trop de téléchargements d'historique en peu de temps. Réessayez dans ${…} min.":
    {
      en: 'Too many history downloads in a short time. Try again in {0} min.',
    },
  "D'autres rapports sont en cours de préparation. Réessayez dans quelques secondes.":
    {
      en: 'Other reports are being prepared. Try again in a few seconds.',
    },
  'Curseur invalide.': { en: 'Invalid cursor.' },
  'Notification introuvable.': { en: 'Notification not found.' },
  'Notifications indisponibles.': { en: 'Notifications unavailable.' },
  'Abonnement aux notifications refusé.': {
    en: 'Notification subscription refused.',
  },
  'Notifications non activées sur cet appareil.': {
    en: 'Notifications not turned on for this device.',
  },
  'Trop de notifications. Réessayez plus tard.': {
    en: 'Too many notifications. Try again later.',
  },

  // ─── Abonnement et paiements ──────────────────────────────────────────
  "L'abonnement de ce commerce n'est pas actif.": {
    en: "This shop's subscription is not active.",
  },
  'Session limitée : accès au commerce indisponible.': {
    en: 'Limited session: access to the shop unavailable.',
  },
  "Impossible de vérifier l'abonnement pour le moment. Réessayez.": {
    en: 'The subscription cannot be checked at the moment. Try again.',
  },
  'Le paiement est momentanément indisponible.': {
    en: 'Payment is temporarily unavailable.',
  },
  'Impossible de vérifier ce paiement pour le moment. Réessayez plus tard.': {
    en: 'This payment cannot be checked at the moment. Try again later.',
  },
  'Paiement en cours de confirmation. Vérifiez de nouveau dans un instant.': {
    en: 'Payment being confirmed. Check again in a moment.',
  },
  'Un paiement est déjà en cours pour ce commerce.': {
    en: 'A payment is already in progress for this shop.',
  },
  'Cette opération a déjà été utilisée pour une autre demande.': {
    en: 'This operation has already been used for another request.',
  },
  'Paiement introuvable.': { en: 'Payment not found.' },
  // 1-21E : changement de forfait sans page hébergée ; reçu non encaissé.
  'Ce paiement ne peut pas être remplacé pour le moment.': {
    en: 'This payment cannot be replaced at the moment.',
  },
  "Aucun reçu : ce paiement n'a pas été encaissé.": {
    en: 'No receipt: this payment was not collected.',
  },
  'Numéro Mobile Money camerounais invalide.': {
    en: 'Invalid Cameroonian Mobile Money number.',
  },
  'Trop de demandes de paiement. Réessayez plus tard.': {
    en: 'Too many payment requests. Try again later.',
  },
  'amount doit être un entier.': { en: 'amount must be an integer.' },
  'sequence doit être un entier.': { en: 'sequence must be an integer.' },
  'endsAt doit être postérieur à startsAt.': {
    en: 'endsAt must be after startsAt.',
  },
  'source incohérente avec kind.': { en: 'source inconsistent with kind.' },
  "term requis pour un abonnement, interdit pour l'essai.": {
    en: 'term required for a subscription, forbidden for the trial.',
  },

  // ─── Assistance ───────────────────────────────────────────────────────
  "Trop de demandes d'assistance. Réessayez plus tard.": {
    en: 'Too many support requests. Try again later.',
  },
  'Le sujet et le message sont obligatoires.': {
    en: 'The subject and the message are required.',
  },
  'Identifiant de demande déjà utilisé.': {
    en: 'Request identifier already used.',
  },
  'Cette demande a déjà été envoyée avec un autre contenu.': {
    en: 'This request has already been sent with different content.',
  },
  'Cette demande est en cours d’envoi.': {
    en: 'This request is being sent.',
  },
  'Le résultat de l’envoi est inconnu et ne peut plus être vérifié sans risque de doublon.':
    {
      en: 'The result of the sending is unknown and can no longer be checked without risking a duplicate.',
    },
  'Le message n’a pas pu être transmis pour le moment.': {
    en: 'The message could not be sent at the moment.',
  }, // Administration de la plateforme.
  "L'administration de la plateforme n'est pas disponible.": {
    en: 'Platform administration is not available.',
  },
  'Accès refusé.': {
    en: 'Access denied.',
  },
  "Ce compte n'a pas accès à l'administration de la plateforme.": {
    en: 'This account has no access to platform administration.',
  },
  'Session administrative expirée. Reconnectez-vous.': {
    en: 'Administration session expired. Sign in again.',
  },
  'Validez la double authentification.': {
    en: 'Complete two-factor authentication.',
  },
  'Configurez la double authentification.': {
    en: 'Set up two-factor authentication.',
  },
  'La double authentification est déjà configurée.': {
    en: 'Two-factor authentication is already set up.',
  },
  'Vérification expirée ou déjà utilisée. Recommencez.': {
    en: 'Verification expired or already used. Start again.',
  },
  'Code incorrect.': {
    en: 'Incorrect code.',
  },
  'Confirmez votre mot de passe et votre second facteur.': {
    en: 'Confirm your password and your second factor.',
  },
  'Trop de tentatives. Réessayez plus tard.': {
    en: 'Too many attempts. Try again later.',
  },
  'Introuvable.': {
    en: 'Not found.',
  },
});

const VARIABLE = '${…}';

interface CompiledEntry {
  pattern: RegExp;
  translations: Translations;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const EXACT = new Map<string, Translations>();
const TEMPLATES: CompiledEntry[] = [];
for (const [source, translations] of Object.entries(
  ERROR_MESSAGE_TRANSLATIONS,
)) {
  if (source.includes(VARIABLE)) {
    const pattern = new RegExp(
      `^${source.split(VARIABLE).map(escapeRegExp).join('([\\s\\S]*?)')}$`,
    );
    TEMPLATES.push({ pattern, translations });
  } else {
    EXACT.set(source, translations);
  }
}

function fill(text: string, values: string[]): string {
  return text.replace(/\{(\d+)\}/g, (match, index: string) =>
    values[Number(index)] !== undefined ? values[Number(index)] : match,
  );
}

/** Un message traduit dans `locale`, ou le message d'origine. */
export function translateErrorMessage(
  message: string,
  locale: AppLocale,
): string {
  const exact = EXACT.get(message);
  if (exact) return exact[locale] ?? message;
  for (const entry of TEMPLATES) {
    const match = entry.pattern.exec(message);
    if (match) {
      const target = entry.translations[locale];
      return target ? fill(target, match.slice(1)) : message;
    }
  }
  return message;
}

/** `message` d'un corps d'erreur (chaîne ou liste de validation). */
export function translateErrorBodyMessage(
  message: unknown,
  locale: AppLocale,
): unknown {
  if (typeof message === 'string') {
    return translateErrorMessage(message, locale);
  }
  if (Array.isArray(message)) {
    return message.map((item) =>
      typeof item === 'string' ? translateErrorMessage(item, locale) : item,
    );
  }
  return message;
}
