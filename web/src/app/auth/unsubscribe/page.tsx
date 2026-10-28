"use client";

import { useEffect, useRef, useState } from "react";
import { useT } from "next-i18next/client";
import { Button } from "@/components/ui/button";
import { Wordmark } from "@/components/brand/wordmark";
import { isNetworkError } from "@/lib/api";
import { confirmUnsubscribe } from "@/lib/marketing-consent";

type Step = "loading" | "ready" | "submitting" | "done" | "invalid" | "retry";

// Désabonnement des e-mails promotionnels SANS connexion (lien visible des
// e-mails de campagne). Comme la confirmation d'adresse : le jeton est lu
// une fois après montage, retiré de l'URL, gardé en mémoire seulement ; le
// simple chargement ne retire RIEN (analyseurs de liens) : il faut cliquer.
// Les e-mails de service et l'abonnement du commerce ne sont pas concernés.
export default function UnsubscribePage() {
  const { t } = useT("legal");
  const tokenRef = useRef<string | null>(null);
  const started = useRef(false);
  const [step, setStep] = useState<Step>("loading");

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    tokenRef.current = new URLSearchParams(window.location.search).get("token");
    if (window.location.search || window.location.hash) {
      window.history.replaceState(null, "", window.location.pathname);
    }
    setStep(tokenRef.current ? "ready" : "invalid");
  }, []);

  const confirm = async () => {
    const token = tokenRef.current;
    if (!token || step === "submitting") return;
    setStep("submitting");
    try {
      await confirmUnsubscribe(token);
      tokenRef.current = null;
      setStep("done");
    } catch (err) {
      setStep(isNetworkError(err) ? "retry" : "invalid");
    }
  };

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-12 pb-[max(3rem,env(safe-area-inset-bottom))]">
      <div className="w-full max-w-sm space-y-6 text-center">
        <Wordmark className="mx-auto" size="large" />
        {step === "loading" && (
          <p role="status" className="text-sm text-muted-foreground">
            {t("unsubscribe.loading")}
          </p>
        )}
        {(step === "ready" || step === "submitting" || step === "retry") && (
          <div className="space-y-4">
            <div className="space-y-1">
              <h1 className="text-lg font-semibold">
                {t("unsubscribe.title")}
              </h1>
              <p className="text-sm text-muted-foreground">
                {t("unsubscribe.text")}
              </p>
            </div>
            {step === "retry" && (
              <p role="alert" className="text-sm text-destructive">
                {t("unsubscribe.network")}
              </p>
            )}
            <Button
              type="button"
              className="w-full"
              disabled={step === "submitting"}
              onClick={() => void confirm()}
            >
              {step === "submitting"
                ? t("unsubscribe.submitting")
                : t("unsubscribe.confirm")}
            </Button>
            <p className="text-xs text-muted-foreground">
              {t("unsubscribe.service")}
            </p>
          </div>
        )}
        {step === "done" && (
          <div role="status" className="space-y-1">
            <h1 className="text-lg font-semibold">
              {t("unsubscribe.doneTitle")}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t("unsubscribe.doneText")}
            </p>
          </div>
        )}
        {step === "invalid" && (
          <div role="alert" className="space-y-1">
            <h1 className="text-lg font-semibold">
              {t("unsubscribe.invalidTitle")}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t("unsubscribe.invalidText")}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
