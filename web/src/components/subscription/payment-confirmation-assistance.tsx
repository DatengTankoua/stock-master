"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { CheckIcon, CopyIcon, MailIcon } from "lucide-react";
import { useT } from "next-i18next/client";
import { WhatsAppIcon } from "@/components/contact/whatsapp-icon";
import { Button, buttonVariants } from "@/components/ui/button";
import { CONTACT_EMAILS, WHATSAPP } from "@/lib/legal/site-identity";
import { mailtoHref } from "@/lib/whatsapp-contact";

// Paiement SasPay toujours en cours de confirmation après 24 heures : la
// vérification passe par l'assistance (SasPay demande alors un ticket avec
// la référence). Référence existante, copiable ; canaux existants
// (WhatsApp, e-mail d'assistance, page Assistance hors session limitée).
// Aucune promesse d'activation ni de remboursement ; rien n'affirme que le
// client a été débité. Le lien WhatsApp ne transmet rien d'autre que ce que
// le client écrira lui-même.
export function PaymentConfirmationAssistance({
  reference,
  restricted,
  variant = "confirmation",
}: {
  reference: string;
  /**
   * `confirmation` : transaction engagée non confirmée ; `creation` :
   * création de la session SasPay non confirmée (session inconnue).
   */
  variant?: "confirmation" | "creation";
  /** Session limitée (écran de blocage) : page Assistance non proposée. */
  restricted: boolean;
}) {
  const { t } = useT("subscription");
  const id = useId();
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");

  const copyReference = () => {
    const done = navigator.clipboard?.writeText(reference);
    if (!done) {
      setCopy("failed");
      return;
    }
    done.then(
      () => setCopy("copied"),
      () => setCopy("failed"),
    );
  };

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="space-y-3 rounded-lg border border-(--brand-orange) p-3 text-sm"
      data-testid="payment-confirmation-assistance"
    >
      <h4 id={`${id}-title`} className="font-semibold">
        {t(`payment.${variant}.delayedTitle`)}
      </h4>
      <p>{t(`payment.${variant}.delayedDetail`)}</p>
      <div className="space-y-1">
        <p id={`${id}-reference`} className="text-muted-foreground">
          {t("payment.confirmation.referenceLabel")}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <code
            aria-labelledby={`${id}-reference`}
            className="break-all rounded-md border bg-muted/40 px-2 py-1 font-mono text-xs select-all"
            data-testid="payment-confirmation-reference"
          >
            {reference}
          </code>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={copyReference}
          >
            {copy === "copied" ? (
              <CheckIcon className="h-4 w-4" aria-hidden />
            ) : (
              <CopyIcon className="h-4 w-4" aria-hidden />
            )}
            {t("payment.confirmation.copy")}
          </Button>
        </div>
        <p role="status" className="text-xs text-muted-foreground">
          {copy === "copied"
            ? t("payment.confirmation.copied")
            : copy === "failed"
              ? t("payment.confirmation.copyFailed")
              : ""}
        </p>
      </div>
      <p className="text-muted-foreground">
        {t("payment.confirmation.noPromise")}
      </p>
      <div className="space-y-2">
        <p className="font-medium">{t("payment.confirmation.channels")}</p>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <a
            href={WHATSAPP.url}
            target="_blank"
            rel="noopener noreferrer"
            className={`${buttonVariants({ variant: "outline" })} h-11 px-4`}
          >
            <WhatsAppIcon className="size-4" />
            {t("payment.confirmation.whatsapp", { number: WHATSAPP.display })}
          </a>
          <a
            href={mailtoHref(CONTACT_EMAILS.support, {
              subject: t("payment.confirmation.emailSubject", { reference }),
            })}
            className={`${buttonVariants({ variant: "outline" })} h-11 px-4`}
          >
            <MailIcon className="h-4 w-4" aria-hidden />
            {CONTACT_EMAILS.support}
          </a>
          {!restricted && (
            <Link
              href="/app/organization/support"
              className={`${buttonVariants({ variant: "outline" })} h-11 px-4`}
            >
              {t("payment.confirmation.supportPage")}
            </Link>
          )}
        </div>
      </div>
    </section>
  );
}
