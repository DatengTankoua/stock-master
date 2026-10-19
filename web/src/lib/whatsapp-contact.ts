import { WHATSAPP } from "./legal/site-identity";

// Contact WhatsApp — liens `wa.me` et `mailto:` préremplis avec le texte
// que l'utilisateur voit et modifie. Aucune API WhatsApp, aucun envoi :
// le lien ouvre WhatsApp (ou le client e-mail) et c'est l'utilisateur qui
// envoie. Aucune donnée du compte, du commerce ou de la session n'est
// ajoutée ici ; rien n'est conservé dans un stockage du navigateur.

/** Sujets proposés sur les pages publiques (choix facultatif). */
export const WHATSAPP_TOPICS = [
  "discovery",
  "subscription",
  "technical",
  "other",
] as const;

export type WhatsAppTopic = (typeof WHATSAPP_TOPICS)[number];

/** Limite du message : garde le lien `wa.me` de taille raisonnable. */
export const WHATSAPP_MESSAGE_MAX_LENGTH = 1000;

/** Limite du sujet libre (Assistance). */
export const WHATSAPP_SUBJECT_MAX_LENGTH = 120;

function normalize(text: string): string {
  // Retours à la ligne uniformes (`\n`, encodés `%0A`), espaces de bord
  // retirés ; le contenu lui-même n'est jamais modifié.
  return text.replace(/\r\n?/g, "\n").trim();
}

/**
 * Texte transmis : ligne de sujet facultative (déjà traduite, ex.
 * « Sujet : Abonnement »), ligne vide, puis le message. Chaîne vide si
 * rien n'a été saisi.
 */
export function composeContactText({
  subjectLine,
  message,
}: {
  subjectLine?: string;
  message: string;
}): string {
  return [subjectLine, message]
    .map((part) => normalize(part ?? ""))
    .filter((part) => part.length > 0)
    .join("\n\n");
}

/** Lien `wa.me` vers le numéro professionnel, texte prérempli s'il existe. */
export function whatsappHref(text: string): string {
  const body = normalize(text);
  return body
    ? `${WHATSAPP.url}?text=${encodeURIComponent(body)}`
    : WHATSAPP.url;
}

/**
 * Lien `mailto:` avec sujet et corps facultatifs. `encodeURIComponent`
 * (espaces en `%20`, jamais `+`) : forme comprise par les clients e-mail.
 */
export function mailtoHref(
  address: string,
  { subject, body }: { subject?: string; body?: string } = {},
): string {
  const params = [
    ["subject", normalize(subject ?? "")],
    ["body", normalize(body ?? "")],
  ]
    .filter(([, value]) => value.length > 0)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`);
  return params.length
    ? `mailto:${address}?${params.join("&")}`
    : `mailto:${address}`;
}
