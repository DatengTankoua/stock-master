"use client";

import { useState } from "react";
import { useT } from "next-i18next/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useFormat } from "@/i18n/use-format";
import { useAdminStatus } from "@/components/admin/admin-shell";
import {
  AdminError,
  AdminSection,
  RecoveryCodes,
  TotpProvisioningForm,
} from "@/components/admin/admin-ui";
import { adminRequest, type AdminProvisioning } from "@/lib/admin/admin-api";

// Sécurité du compte administrateur : vérification renforcée (mot de passe
// + second facteur, 5 min, une opération), puis renouvellement des codes ou
// changement d'application. Les autres sessions administratives sont
// fermées par l'API après chaque opération.

type Mode =
  | { name: "idle" }
  | { name: "ready"; stepUpToken: string }
  | { name: "replace"; provisioning: AdminProvisioning }
  | { name: "codes"; codes: string[]; replaced: boolean };

export default function AdminSecurityPage() {
  const { t } = useT("admin");
  const format = useFormat();
  const { status, refresh } = useAdminStatus();
  const [mode, setMode] = useState<Mode>({ name: "idle" });
  const [password, setPassword] = useState("");
  const [factor, setFactor] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const stepUp = () =>
    run(async () => {
      const compact = factor.replace(/\s/g, "");
      const { stepUpToken } = await adminRequest<{ stepUpToken: string }>(
        "POST",
        "security/step-up",
        /^\d{6}$/.test(compact)
          ? { password, code: compact }
          : { password, recoveryCode: factor },
      );
      setPassword("");
      setFactor("");
      setMode({ name: "ready", stepUpToken });
    });

  const regenerate = (stepUpToken: string) =>
    run(async () => {
      const { recoveryCodes } = await adminRequest<{ recoveryCodes: string[] }>(
        "POST",
        "security/recovery-codes",
        { stepUpToken },
      );
      setMode({ name: "codes", codes: recoveryCodes, replaced: false });
    });

  const startReplace = (stepUpToken: string) =>
    run(async () => {
      const provisioning = await adminRequest<AdminProvisioning>(
        "POST",
        "security/factor/start",
        { stepUpToken },
      );
      setMode({ name: "replace", provisioning });
    });

  const confirmReplace = (provisioning: AdminProvisioning, code: string) =>
    run(async () => {
      const { recoveryCodes } = await adminRequest<{ recoveryCodes: string[] }>(
        "POST",
        "security/factor/confirm",
        { challengeToken: provisioning.challenge.token, code },
      );
      setMode({ name: "codes", codes: recoveryCodes, replaced: true });
    });

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <h1 className="text-xl font-semibold">{t("security.title")}</h1>
      <AdminSection title={t("security.session")}>
        <ul className="flex flex-col gap-1 text-sm">
          <li>{status.user.email}</li>
          <li className="text-muted-foreground">
            {t("security.idleExpires", {
              time: format.dateTime(status.session.idleExpiresAt),
            })}
          </li>
          <li className="text-muted-foreground">
            {t("security.absoluteExpires", {
              time: format.dateTime(status.session.absoluteExpiresAt),
            })}
          </li>
          <li>
            {t("security.codesRemaining", {
              count: status.recoveryCodesRemaining ?? 0,
            })}
          </li>
        </ul>
      </AdminSection>

      {error !== null && <AdminError error={error} />}

      <AdminSection title={t("security.stepUpTitle")}>
        {mode.name === "idle" && (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void stepUp();
            }}
          >
            <p className="text-sm text-muted-foreground">
              {t("security.stepUpText")}
            </p>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="step-up-password">{t("security.password")}</Label>
              <Input
                id="step-up-password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="step-up-factor">{t("security.code")}</Label>
              <Input
                id="step-up-factor"
                autoComplete="one-time-code"
                spellCheck={false}
                required
                value={factor}
                onChange={(event) => setFactor(event.target.value)}
              />
            </div>
            <Button type="submit" disabled={busy}>
              {t("security.stepUpSubmit")}
            </Button>
          </form>
        )}

        {mode.name === "ready" && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              {t("security.stepUpDone")}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={busy}
                onClick={() => void regenerate(mode.stepUpToken)}
              >
                {t("security.regenerate")}
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void startReplace(mode.stepUpToken)}
              >
                {t("security.replace")}
              </Button>
            </div>
          </div>
        )}

        {mode.name === "replace" && (
          <TotpProvisioningForm
            uri={mode.provisioning.uri}
            manualKey={mode.provisioning.manualKey}
            busy={busy}
            onSubmit={(code) => void confirmReplace(mode.provisioning, code)}
          />
        )}

        {mode.name === "codes" && (
          <div className="flex flex-col gap-3">
            {mode.replaced && (
              <p role="status" className="text-sm font-medium">
                {t("security.replaceDone")}
              </p>
            )}
            <RecoveryCodes
              codes={mode.codes}
              onDone={() => {
                setMode({ name: "idle" });
                refresh();
              }}
            />
          </div>
        )}
      </AdminSection>
    </div>
  );
}
