"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "next-i18next/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LanguageSwitcher } from "@/components/i18n/language-switcher";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import {
  AdminError,
  OtpInput,
  RecoveryCodes,
  TotpProvisioningForm,
} from "@/components/admin/admin-ui";
import {
  AdminApiError,
  adminRequest,
  type AdminChallenge,
  type AdminProvisioning,
  type AdminStatus,
} from "@/lib/admin/admin-api";

// Administration de la plateforme — connexion en étapes : mot de passe,
// puis enrôlement (premier accès) ou second facteur. Aucun secret, code ni
// jeton n'est conservé dans le navigateur (état React seulement).

type Step =
  | { name: "checking" }
  | { name: "password" }
  | { name: "verify"; challenge: AdminChallenge | null }
  | { name: "enroll"; provisioning: AdminProvisioning | null }
  | { name: "codes"; codes: string[] };

type Notice = "expired" | "out" | null;

export default function AdminLoginPage() {
  const { t } = useT("admin");
  const router = useRouter();
  const [step, setStep] = useState<Step>({ name: "checking" });
  const [notice, setNotice] = useState<Notice>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);

  useEffect(() => {
    const marker = new URLSearchParams(window.location.search).get("session");
    let cancelled = false;
    adminRequest<AdminStatus>("GET", "auth/status").then(
      (status) => {
        if (cancelled) return;
        if (status.stage === "ready") router.replace("/admin");
        else if (status.stage === "enroll")
          setStep({ name: "enroll", provisioning: null });
        else setStep({ name: "verify", challenge: null });
      },
      (err: unknown) => {
        if (cancelled) return;
        setNotice(
          marker === "expired" ? "expired" : marker === "out" ? "out" : null,
        );
        if (err instanceof AdminApiError && err.status === 503) setError(err);
        setStep({ name: "password" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [router]);

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err);
      if (
        err instanceof AdminApiError &&
        err.code === "PLATFORM_ADMIN_SESSION_EXPIRED"
      ) {
        setNotice("expired");
        setStep({ name: "password" });
      }
    } finally {
      setBusy(false);
    }
  };

  const submitPassword = () =>
    run(async () => {
      const result = await adminRequest<{
        stage: "enroll" | "verify";
        challenge?: AdminChallenge;
      }>("POST", "auth/login", { email, password });
      setPassword("");
      setNotice(null);
      setStep(
        result.stage === "enroll"
          ? { name: "enroll", provisioning: null }
          : { name: "verify", challenge: result.challenge ?? null },
      );
    });

  const newChallenge = () =>
    run(async () => {
      const { challenge } = await adminRequest<{ challenge: AdminChallenge }>(
        "POST",
        "mfa/challenge",
      );
      setStep({ name: "verify", challenge });
    });

  const submitVerify = (challenge: AdminChallenge) =>
    run(async () => {
      await adminRequest("POST", "mfa/verify", {
        challengeToken: challenge.token,
        ...(useRecovery ? { recoveryCode } : { code }),
      });
      setCode("");
      setRecoveryCode("");
      router.replace("/admin");
    });

  const startEnrollment = () =>
    run(async () => {
      const provisioning = await adminRequest<AdminProvisioning>(
        "POST",
        "mfa/enrollment/start",
      );
      setStep({ name: "enroll", provisioning });
    });

  const confirmEnrollment = (provisioning: AdminProvisioning, first: string) =>
    run(async () => {
      const { recoveryCodes } = await adminRequest<{ recoveryCodes: string[] }>(
        "POST",
        "mfa/enrollment/confirm",
        { challengeToken: provisioning.challenge.token, code: first },
      );
      setStep({ name: "codes", codes: recoveryCodes });
    });

  return (
    <div className="flex min-h-dvh flex-1 flex-col bg-background">
      <div className="flex justify-end gap-1 px-3 pt-3">
        <LanguageSwitcher />
        <ThemeToggle />
      </div>
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-8">
        <header>
          <h1 className="text-xl font-semibold">{t("login.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("login.subtitle")}
          </p>
        </header>

        {notice && (
          <p
            role="status"
            className="rounded-lg border border-border bg-muted p-3 text-sm"
          >
            {notice === "expired" ? t("login.expired") : t("login.loggedOut")}
          </p>
        )}
        {error !== null && <AdminError error={error} />}

        {step.name === "checking" && (
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        )}

        {step.name === "password" && (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submitPassword();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="admin-email">{t("login.email")}</Label>
              <Input
                id="admin-email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="admin-password">{t("login.password")}</Label>
              <Input
                id="admin-password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            <Button type="submit" disabled={busy}>
              {busy ? t("login.submitting") : t("login.submit")}
            </Button>
          </form>
        )}

        {step.name === "verify" && (
          <section className="flex flex-col gap-3">
            <h2 className="text-base font-semibold">{t("verify.title")}</h2>
            {step.challenge ? (
              <form
                className="flex flex-col gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitVerify(step.challenge!);
                }}
              >
                {useRecovery ? (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="admin-recovery">
                      {t("verify.recoveryCode")}
                    </Label>
                    <Input
                      id="admin-recovery"
                      autoComplete="off"
                      spellCheck={false}
                      value={recoveryCode}
                      onChange={(event) => setRecoveryCode(event.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("verify.recoveryHint")}
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    <p className="text-sm">{t("verify.text")}</p>
                    <Label htmlFor="admin-code">{t("verify.code")}</Label>
                    <OtpInput id="admin-code" value={code} onChange={setCode} />
                  </div>
                )}
                <Button type="submit" disabled={busy}>
                  {busy ? t("verify.submitting") : t("verify.submit")}
                </Button>
                <Button
                  type="button"
                  variant="link"
                  onClick={() => {
                    setUseRecovery((v) => !v);
                    setError(null);
                  }}
                >
                  {useRecovery ? t("verify.useCode") : t("verify.useRecovery")}
                </Button>
              </form>
            ) : null}
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void newChallenge()}
            >
              {t("verify.newChallenge")}
            </Button>
          </section>
        )}

        {step.name === "enroll" && (
          <section className="flex flex-col gap-3">
            <h2 className="text-base font-semibold">{t("enroll.title")}</h2>
            {step.provisioning ? (
              <TotpProvisioningForm
                uri={step.provisioning.uri}
                manualKey={step.provisioning.manualKey}
                busy={busy}
                onSubmit={(first) =>
                  void confirmEnrollment(step.provisioning!, first)
                }
              />
            ) : (
              <>
                <p className="text-sm">{t("enroll.intro")}</p>
                <Button disabled={busy} onClick={() => void startEnrollment()}>
                  {busy ? t("enroll.starting") : t("enroll.start")}
                </Button>
              </>
            )}
          </section>
        )}

        {step.name === "codes" && (
          <RecoveryCodes
            codes={step.codes}
            onDone={() => {
              setStep({ name: "checking" });
              router.replace("/admin");
            }}
          />
        )}
      </main>
    </div>
  );
}
