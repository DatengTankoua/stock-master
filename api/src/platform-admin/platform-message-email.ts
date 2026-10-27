import { escapeHtml } from '../email-verification/verification-email';
import type { AppLocale } from '../common/i18n/locale';

/**
 * E-mail d'un message de service de Stock Master. Fonction PURE : mêmes
 * entrées → même sujet, même texte, même HTML (condition de l'idempotence
 * du prestataire : un renvoi avec la même clé doit être identique).
 *
 * Habillage dans la langue du DESTINATAIRE ; titre et texte saisis par
 * l'administrateur conservés tels quels (aucune traduction), échappés en
 * HTML, jamais interprétés. Aucun lien fourni par l'administrateur.
 */
export interface PlatformMessageEmailInput {
  title: string;
  body: string;
  organizationName: string;
  supportAddress: string;
  locale: AppLocale;
}

export interface PlatformMessageEmailContent {
  subject: string;
  text: string;
  html: string;
}

function singleLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').trim();
}

const WRAPPER = {
  fr: {
    subject: (title: string) => `${title} – Stock Master`,
    label: 'Message de Stock Master',
    intro: (org: string) =>
      `Vous recevez ce message de l’équipe Stock Master en tant que membre de « ${org} ».`,
    reply: (support: string) =>
      `Pour répondre, répondez simplement à cet e-mail : votre réponse parviendra à l’assistance Stock Master (${support}).`,
    footer:
      'Message de service lié à votre compte Stock Master. Ce n’est pas une communication commerciale.',
  },
  en: {
    subject: (title: string) => `${title} – Stock Master`,
    label: 'Message from Stock Master',
    intro: (org: string) =>
      `You are receiving this message from the Stock Master team as a member of “${org}”.`,
    reply: (support: string) =>
      `To reply, simply answer this email: your reply will reach Stock Master support (${support}).`,
    footer:
      'Service message about your Stock Master account. This is not a marketing communication.',
  },
} as const;

export function buildPlatformMessageEmail(
  input: PlatformMessageEmailInput,
): PlatformMessageEmailContent {
  const w = WRAPPER[input.locale === 'en' ? 'en' : 'fr'];
  const title = singleLine(input.title);
  const organization = singleLine(input.organizationName);
  const subject = singleLine(w.subject(title));

  const text = [
    w.label,
    '',
    w.intro(organization),
    '',
    title,
    '',
    input.body,
    '',
    '—',
    w.reply(input.supportAddress),
    w.footer,
  ].join('\n');

  const html = `<!doctype html>
<html lang="${input.locale === 'en' ? 'en' : 'fr'}">
  <body style="font-family: Arial, sans-serif; color: #111827; line-height: 1.5;">
    <p style="color:#062B5C;font-weight:bold;">${escapeHtml(w.label)}</p>
    <p>${escapeHtml(w.intro(organization))}</p>
    <h1 style="font-size:18px;margin:16px 0 8px;">${escapeHtml(title)}</h1>
    <div style="white-space: pre-wrap; border-left: 3px solid #062B5C; padding-left: 12px;">${escapeHtml(input.body)}</div>
    <p style="margin-top:24px;color:#6b7280;font-size:13px;">${escapeHtml(w.reply(input.supportAddress))}</p>
    <p style="color:#6b7280;font-size:13px;">${escapeHtml(w.footer)}</p>
  </body>
</html>`;

  return { subject, text, html };
}
