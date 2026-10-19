"use client";

import { useId, useState } from "react";
import { useT } from "next-i18next/client";
import { WhatsAppContinue } from "@/components/contact/whatsapp-continue";
import { WhatsAppIcon } from "@/components/contact/whatsapp-icon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CONTACT_EMAILS } from "@/lib/legal/site-identity";
import {
  WHATSAPP_MESSAGE_MAX_LENGTH,
  WHATSAPP_TOPICS,
  composeContactText,
  mailtoHref,
  type WhatsAppTopic,
} from "@/lib/whatsapp-contact";

// Contact WhatsApp — bouton flottant des pages publiques (accueil et pages
// d'aide, juridiques et guides, FR/EN), monté par `PublicFooter`. Ouvert
// seulement au clic : petite fenêtre pour préparer un message, puis lien
// `wa.me` prérempli. Pas un chatbot : aucune IA, aucune API WhatsApp, aucune
// réponse automatique, aucune conversation simulée.
// Le brouillon vit dans l'état de ce composant (conservé à la fermeture de
// la fenêtre, perdu au changement de page) : aucun stockage local.
// Position : coin bas droit, au-dessus de la zone sûre ; relevé sous `lg`
// tant que le bandeau de langue (`data-language-hint`) est affiché, pour
// ne jamais le masquer. Le pied de page réserve l'espace en bas de page.
export function WhatsAppWidget() {
  const { t } = useT("public");
  const { t: tc } = useT("common");
  const id = useId();
  const [topic, setTopic] = useState<WhatsAppTopic | "">("");
  const [message, setMessage] = useState("");

  const topicLabel = topic ? t(`whatsapp.topics.${topic}`) : "";
  const text = composeContactText({
    subjectLine: topicLabel
      ? tc("whatsapp.subjectLine", { subject: topicLabel })
      : undefined,
    message,
  });
  // Aide technique : adresse de l'assistance ; sinon adresse générale.
  const email =
    topic === "technical" ? CONTACT_EMAILS.support : CONTACT_EMAILS.contact;
  const emailHref = mailtoHref(email, {
    subject: topicLabel
      ? t("whatsapp.emailSubjectTopic", { topic: topicLabel })
      : t("whatsapp.emailSubject"),
    body: message,
  });

  return (
    <Dialog>
      <DialogTrigger
        aria-label={t("whatsapp.open")}
        data-testid="whatsapp-widget"
        className="fixed right-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-40 inline-flex min-h-14 min-w-14 items-center justify-center gap-2 rounded-full bg-[#0b6b4a] px-4 font-semibold text-white shadow-lg ring-2 ring-white/70 transition-colors hover:bg-[#095a3e] focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-(--brand-ink) max-lg:[body:has([data-language-hint])_&]:bottom-[calc(8rem+env(safe-area-inset-bottom))] sm:right-6 dark:ring-(--public-bg) print:hidden"
      >
        <WhatsAppIcon className="size-6" />
        <span className="hidden sm:inline">{t("whatsapp.short")}</span>
      </DialogTrigger>
      <DialogContent className="top-auto bottom-[calc(1rem+env(safe-area-inset-bottom))] max-h-[calc(100dvh-2rem)] -translate-y-0 overflow-y-auto sm:top-auto sm:right-6 sm:bottom-24 sm:left-auto sm:max-w-sm sm:translate-x-0">
        <DialogHeader className="pr-8">
          <DialogTitle className="flex items-center gap-2 text-lg font-semibold">
            <WhatsAppIcon className="size-5 text-[#0b6b4a] dark:text-emerald-400" />
            {t("whatsapp.title")}
          </DialogTitle>
          <DialogDescription>{t("whatsapp.greeting")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor={`${id}-topic`}>{t("whatsapp.topic")}</Label>
          <select
            id={`${id}-topic`}
            value={topic}
            onChange={(e) => setTopic(e.target.value as WhatsAppTopic | "")}
            className="h-11 w-full rounded-md border bg-background px-3 text-base sm:text-sm"
          >
            <option value="">{t("whatsapp.noTopic")}</option>
            {WHATSAPP_TOPICS.map((value) => (
              <option key={value} value={value}>
                {t(`whatsapp.topics.${value}`)}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          <Label htmlFor={`${id}-message`}>{t("whatsapp.message")}</Label>
          <Textarea
            id={`${id}-message`}
            value={message}
            rows={4}
            maxLength={WHATSAPP_MESSAGE_MAX_LENGTH}
            onChange={(e) => setMessage(e.target.value)}
            aria-describedby={`${id}-message-count`}
            className="text-base sm:text-sm"
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
              {t("whatsapp.emailLead")}{" "}
              <a
                href={emailHref}
                translate="no"
                className="font-medium break-all text-foreground underline underline-offset-4"
              >
                {email}
              </a>
            </p>
          }
        />
      </DialogContent>
    </Dialog>
  );
}
