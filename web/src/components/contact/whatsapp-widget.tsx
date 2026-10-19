"use client";

import { useId, useState } from "react";
import Link from "next/link";
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
import { rich } from "@/i18n/rich";
import { CONTACT_EMAILS } from "@/lib/legal/site-identity";
import {
  WHATSAPP_APP_TOPICS,
  WHATSAPP_MESSAGE_MAX_LENGTH,
  WHATSAPP_TOPICS,
  composeContactText,
  mailtoHref,
} from "@/lib/whatsapp-contact";
import { cn } from "@/lib/utils";

// Contact WhatsApp — bouton flottant et petite fenêtre pour préparer un
// message, puis lien `wa.me` prérempli. Pas un chatbot : aucune IA, aucune
// API WhatsApp, aucune réponse automatique, aucune conversation simulée.
// Ouvert seulement au clic. Le brouillon vit dans l'état de ce composant
// (conservé à la fermeture de la fenêtre) : aucun stockage local.
//
// - `public` : monté par `PublicFooter` (accueil, aide, guides, textes
//   juridiques, FR/EN). Coin bas droit ; relevé sous `lg` tant que le
//   bandeau de langue (`data-language-hint`) est affiché. Alternative
//   e-mail : `mailto:` prérempli.
// - `app` : monté par le shell `/app` (droit `support.contact` requis,
//   hors page Assistance qui a sa propre carte). Au-dessus de la barre de
//   navigation mobile (`raised` : barre agrandie hors connexion). Sujets
//   = catégories de l'Assistance ; alternative e-mail = formulaire
//   d'Assistance existant. Aucune donnée du compte ni du commerce ajoutée.
export function WhatsAppWidget({
  variant = "public",
  raised = false,
}: {
  variant?: "public" | "app";
  /** `app` : barre de navigation mobile plus haute (hors connexion). */
  raised?: boolean;
}) {
  const { t } = useT("public");
  const { t: tc } = useT("common");
  const { t: to } = useT("organization");
  const id = useId();
  const [open, setOpen] = useState(false);
  const [topic, setTopic] = useState("");
  const [message, setMessage] = useState("");
  const inApp = variant === "app";

  const topics: readonly string[] = inApp
    ? WHATSAPP_APP_TOPICS
    : WHATSAPP_TOPICS;
  const labelOf = (value: string) =>
    inApp
      ? to(
          `support.categories.${value as (typeof WHATSAPP_APP_TOPICS)[number]}`,
        )
      : t(`whatsapp.topics.${value as (typeof WHATSAPP_TOPICS)[number]}`);
  const topicLabel = topic ? labelOf(topic) : "";
  const text = composeContactText({
    subjectLine: topicLabel
      ? tc("whatsapp.subjectLine", { subject: topicLabel })
      : undefined,
    message,
  });

  const emailAlternative = inApp ? (
    <p>
      {rich(to("support.whatsapp.widgetEmail"), {
        form: (chunk) => (
          <Link
            href="/app/organization/support"
            onClick={() => setOpen(false)}
            className="font-medium text-foreground underline underline-offset-4"
          >
            {chunk}
          </Link>
        ),
      })}
    </p>
  ) : (
    <PublicEmailAlternative
      topic={topic}
      topicLabel={topicLabel}
      message={message}
    />
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        aria-label={t("whatsapp.open")}
        title={inApp ? t("whatsapp.open") : undefined}
        data-testid="whatsapp-widget"
        className={cn(
          "fixed right-4 z-40 inline-flex items-center justify-center gap-2 rounded-full bg-[#0b6b4a] font-semibold text-white shadow-lg ring-2 ring-white/70 transition-colors hover:bg-[#095a3e] focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-(--brand-ink) dark:ring-background print:hidden",
          inApp
            ? cn(
                "z-30 min-h-12 min-w-12 md:right-6 md:bottom-6",
                raised
                  ? "bottom-[calc(6.5rem+env(safe-area-inset-bottom))]"
                  : "bottom-[calc(5rem+env(safe-area-inset-bottom))]",
              )
            : "bottom-[calc(1rem+env(safe-area-inset-bottom))] min-h-14 min-w-14 px-4 max-lg:[body:has([data-language-hint])_&]:bottom-[calc(8rem+env(safe-area-inset-bottom))] sm:right-6",
        )}
      >
        <WhatsAppIcon className="size-6" />
        {!inApp && (
          <span className="hidden sm:inline">{t("whatsapp.short")}</span>
        )}
      </DialogTrigger>
      <DialogContent className="top-auto bottom-[calc(1rem+env(safe-area-inset-bottom))] max-h-[calc(100dvh-2rem)] translate-y-0 overflow-y-auto sm:top-auto sm:right-6 sm:bottom-24 sm:left-auto sm:max-w-sm sm:translate-x-0">
        <DialogHeader className="pr-8">
          <DialogTitle className="flex items-center gap-2 text-lg font-semibold">
            <WhatsAppIcon className="size-5 text-[#0b6b4a] dark:text-emerald-400" />
            {t("whatsapp.title")}
          </DialogTitle>
          <DialogDescription>{t("whatsapp.greeting")}</DialogDescription>
          {inApp && (
            <p className="text-xs text-muted-foreground">
              {to("support.whatsapp.notSynced")}
            </p>
          )}
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor={`${id}-topic`}>{t("whatsapp.topic")}</Label>
          <select
            id={`${id}-topic`}
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            className="h-11 w-full rounded-md border bg-background px-3 text-base sm:text-sm"
          >
            <option value="">{t("whatsapp.noTopic")}</option>
            {topics.map((value) => (
              <option key={value} value={value}>
                {labelOf(value)}
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

        <WhatsAppContinue text={text} emailAlternative={emailAlternative} />
      </DialogContent>
    </Dialog>
  );
}

/** Pages publiques : `mailto:` prérempli (assistance pour l'aide technique). */
function PublicEmailAlternative({
  topic,
  topicLabel,
  message,
}: {
  topic: string;
  topicLabel: string;
  message: string;
}) {
  const { t } = useT("public");
  const email =
    topic === "technical" ? CONTACT_EMAILS.support : CONTACT_EMAILS.contact;
  const href = mailtoHref(email, {
    subject: topicLabel
      ? t("whatsapp.emailSubjectTopic", { topic: topicLabel })
      : t("whatsapp.emailSubject"),
    body: message,
  });
  return (
    <p>
      {t("whatsapp.emailLead")}{" "}
      <a
        href={href}
        translate="no"
        className="font-medium break-all text-foreground underline underline-offset-4"
      >
        {email}
      </a>
    </p>
  );
}
