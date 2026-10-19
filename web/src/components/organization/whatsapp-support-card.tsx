"use client";

import { useId, useState } from "react";
import { useT } from "next-i18next/client";
import { WhatsAppContinue } from "@/components/contact/whatsapp-continue";
import { WhatsAppIcon } from "@/components/contact/whatsapp-icon";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { rich } from "@/i18n/rich";
import {
  WHATSAPP_MESSAGE_MAX_LENGTH,
  WHATSAPP_SUBJECT_MAX_LENGTH,
  composeContactText,
} from "@/lib/whatsapp-contact";

// Contact WhatsApp — Organisation → Assistance, présenté avant le
// formulaire e-mail (inchangé). Sujet et message propres à ce parcours,
// indépendants du formulaire : aucun envoi simultané sur les deux canaux,
// aucune demande d'assistance créée ni marquée comme envoyée. Seul le texte
// saisi (visible et modifiable) part dans le lien : aucune donnée du
// compte, du commerce, du stock, d'un paiement, d'un jeton ni aucun
// fichier. Brouillon en mémoire de la page uniquement.
export function WhatsAppSupportCard({ emailAnchor }: { emailAnchor: string }) {
  const { t } = useT("organization");
  const { t: tc } = useT("common");
  const id = useId();
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");

  const subjectText = subject.trim();
  const text = composeContactText({
    subjectLine: subjectText
      ? tc("whatsapp.subjectLine", { subject: subjectText })
      : undefined,
    message,
  });

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="space-y-4 rounded-xl border border-emerald-700/25 bg-emerald-50/50 p-4 sm:p-5 dark:border-emerald-400/20 dark:bg-emerald-500/5"
      data-testid="support-whatsapp"
    >
      <div className="space-y-1">
        <h3
          id={`${id}-title`}
          className="flex items-center gap-2 text-base font-semibold"
        >
          <WhatsAppIcon className="size-5 text-[#0b6b4a] dark:text-emerald-400" />
          {t("support.whatsapp.title")}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t("support.whatsapp.intro")}
        </p>
        <p className="text-sm text-muted-foreground">
          {t("support.whatsapp.notSynced")}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${id}-subject`}>{t("support.whatsapp.subject")}</Label>
        <Input
          id={`${id}-subject`}
          value={subject}
          maxLength={WHATSAPP_SUBJECT_MAX_LENGTH}
          autoComplete="off"
          onChange={(e) => setSubject(e.target.value)}
          className="h-11 bg-background text-base sm:text-sm"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${id}-message`}>{t("support.whatsapp.message")}</Label>
        <Textarea
          id={`${id}-message`}
          value={message}
          rows={5}
          maxLength={WHATSAPP_MESSAGE_MAX_LENGTH}
          onChange={(e) => setMessage(e.target.value)}
          aria-describedby={`${id}-message-count`}
          className="bg-background text-base sm:text-sm"
        />
        <p
          id={`${id}-message-count`}
          className="text-xs text-muted-foreground tabular-nums"
        >
          {tc("whatsapp.charCount", {
            count: WHATSAPP_MESSAGE_MAX_LENGTH,
            length: message.length,
          })}
        </p>
      </div>

      <WhatsAppContinue
        text={text}
        emailAlternative={
          <p>
            {rich(t("support.whatsapp.emailAlternative"), {
              form: (chunk) => (
                <a
                  href={`#${emailAnchor}`}
                  className="font-medium text-foreground underline underline-offset-4"
                >
                  {chunk}
                </a>
              ),
            })}
          </p>
        }
      />
    </section>
  );
}
