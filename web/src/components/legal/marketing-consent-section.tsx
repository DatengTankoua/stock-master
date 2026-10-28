"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useT } from "next-i18next/client";
import { getApiErrorCode, getApiErrorMessage } from "@/lib/api";
import { useFormat } from "@/i18n/use-format";
import { useLocale } from "@/i18n/locale-provider";
import {
  fetchMarketingConsent,
  marketingConsentErrorKey,
  updateMarketingConsent,
  type MarketingConsentState,
} from "@/lib/marketing-consent";

// Réglage PERSONNEL : accord aux e-mails promotionnels du compte connecté,
// accepté ou retiré d'un clic (sans mot de passe ni MFA). Indépendant des
// notifications push et des préférences ci-dessus, qui ne valent jamais
// accord. Un retrait prend effet immédiatement côté serveur.
// Affiché aussi hors des pages métier (session limitée, abonnement expiré,
// commerce suspendu) : le choix reste toujours accessible au compte.
export function MarketingConsentSection({ token }: { token?: string } = {}) {
  const { t } = useT("legal");
  const { locale } = useLocale();
  const format = useFormat();
  const [state, setState] = useState<MarketingConsentState | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchMarketingConsent(token)
      .then(setState)
      .catch(() => setFailed(true));
  }, [token]);

  const change = async (granted: boolean) => {
    if (!state || busy) return;
    setBusy(true);
    try {
      setState(await updateMarketingConsent(granted, locale, token));
      toast.success(
        granted
          ? t("marketing.settings.granted")
          : t("marketing.settings.withdrawn"),
      );
    } catch (error) {
      const key = marketingConsentErrorKey(getApiErrorCode(error));
      toast.error(key ? t(key) : getApiErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="max-w-md space-y-3">
      <div>
        <h2 className="text-lg font-semibold">
          {t("marketing.settings.title")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("marketing.settings.text")}
        </p>
      </div>
      {failed ? (
        <p className="text-sm text-muted-foreground">
          {t("marketing.settings.unavailable")}
        </p>
      ) : !state ? (
        <p className="text-sm text-muted-foreground">
          {t("marketing.settings.loading")}
        </p>
      ) : (
        <div className="space-y-2">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-5 shrink-0 accent-primary"
              checked={state.granted}
              disabled={busy}
              onChange={(e) => void change(e.target.checked)}
            />
            <span>{t("marketing.label")}</span>
          </label>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {state.granted && state.changedAt
              ? t("marketing.settings.grantedSince", {
                  date: format.dateTime(state.changedAt),
                })
              : t("marketing.settings.notGranted")}
          </p>
          {state.grantedForPreviousAddress && (
            <p className="text-xs text-muted-foreground">
              {t("marketing.settings.previousAddress")}
            </p>
          )}
          {state.granted && !state.emailVerified && (
            <p className="text-xs text-muted-foreground">
              {t("marketing.settings.unverified")}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
