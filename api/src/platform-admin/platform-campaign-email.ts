import { escapeHtml } from '../email-verification/verification-email';

/**
 * E-mail d'une campagne promotionnelle. Fonction PURE : mêmes entrées →
 * même sujet, même texte, même HTML (condition de l'idempotence du
 * prestataire : une reprise avec la même clé doit être identique, lien de
 * désabonnement compris).
 *
 * Sujet et texte saisis par l'administrateur : texte simple, échappé en
 * HTML, jamais interprété ; aucun lien, image ni pixel de suivi ajouté.
 * Habillage et lien de désabonnement VISIBLE dans la langue du destinataire.
 */
export interface CampaignEmailInput {
  subject: string;
  body: string;
  locale: 'fr' | 'en';
  unsubscribeUrl: string;
}

export interface CampaignEmailContent {
  subject: string;
  text: string;
  html: string;
}

const WRAPPER = {
  fr: {
    why: 'Vous recevez cet e-mail parce que vous avez accepté de recevoir les offres et promotions de Stock Master.',
    unsubscribe: 'Se désabonner',
    unsubscribeText: (url: string) =>
      `Pour ne plus recevoir ces e-mails, ouvrez ce lien : ${url}`,
    service:
      'Les e-mails liés à votre compte (sécurité, invitations, messages de service) ne sont pas concernés.',
  },
  en: {
    why: 'You are receiving this email because you agreed to receive Stock Master offers and promotions.',
    unsubscribe: 'Unsubscribe',
    unsubscribeText: (url: string) =>
      `To stop receiving these emails, open this link: ${url}`,
    service:
      'Emails related to your account (security, invitations, service messages) are not affected.',
  },
} as const;

function singleLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').trim();
}

export function buildCampaignEmail(
  input: CampaignEmailInput,
): CampaignEmailContent {
  const w = WRAPPER[input.locale === 'en' ? 'en' : 'fr'];
  const subject = singleLine(input.subject);
  const text = [
    input.body,
    '',
    '—',
    w.why,
    w.unsubscribeText(input.unsubscribeUrl),
    w.service,
  ].join('\n');
  const url = escapeHtml(input.unsubscribeUrl);
  const html = `<!doctype html>
<html lang="${input.locale === 'en' ? 'en' : 'fr'}">
  <body style="font-family: Arial, sans-serif; color: #111827; line-height: 1.5;">
    <div style="white-space: pre-wrap;">${escapeHtml(input.body)}</div>
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;">
    <p style="color:#6b7280;font-size:13px;">${escapeHtml(w.why)}</p>
    <p style="font-size:13px;"><a href="${url}" style="color:#062B5C;">${escapeHtml(w.unsubscribe)}</a></p>
    <p style="color:#6b7280;font-size:13px;">${escapeHtml(w.service)}</p>
  </body>
</html>`;
  return { subject, text, html };
}
