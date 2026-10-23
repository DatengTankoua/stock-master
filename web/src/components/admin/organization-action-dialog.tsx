"use client";

import { useEffect, useMemo, useState } from "react";
import { useT } from "next-i18next/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useFormat } from "@/i18n/use-format";
import { AdminError } from "@/components/admin/admin-ui";
import {
  AdminApiError,
  adminRequest,
  type AdminActionOutcome,
  type AdminExtensionPreview,
  type AdminOrganizationDetail,
} from "@/lib/admin/admin-api";

// Administration de la plateforme — action sur un commerce : formulaire,
// récapitulatif, vérification renforcée liée au contenu exact, résultat.
//
// Identifiant d'opération : un par CONTENU. Réessayer le même contenu (réponse
// réseau perdue) réutilise le même identifiant : l'API renvoie le résultat
// existant sans second effet. Modifier le contenu en crée un nouveau (et
// impose une nouvelle confirmation : l'empreinte change).

export type OrganizationActionKind = "suspend" | "reactivate" | "extend";

const REASON_MIN = 10;
const REASON_MAX = 500;
const DAYS_MIN = 1;
const DAYS_MAX = 90;

const ACTION: Record<
  OrganizationActionKind,
  "organization_suspend" | "organization_reactivate" | "subscription_extend"
> = {
  suspend: "organization_suspend",
  reactivate: "organization_reactivate",
  extend: "subscription_extend",
};

type Step = "form" | "review" | "done";

const validText = (value: string) => {
  const length = value.trim().length;
  return length >= REASON_MIN && length <= REASON_MAX;
};

function Effects({ items }: { items: string[] }) {
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

export function OrganizationActionDialog({
  kind,
  organization,
  open,
  onOpenChange,
  onApplied,
}: {
  kind: OrganizationActionKind;
  organization: AdminOrganizationDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApplied: () => void;
}) {
  const { t } = useT("admin");
  const format = useFormat();
  const [step, setStep] = useState<Step>("form");
  const [internalReason, setInternalReason] = useState("");
  const [clientMessage, setClientMessage] = useState("");
  const [reason, setReason] = useState("");
  const [days, setDays] = useState("7");
  const [password, setPassword] = useState("");
  const [factor, setFactor] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [networkLost, setNetworkLost] = useState(false);
  const [outcome, setOutcome] = useState<AdminActionOutcome | null>(null);
  const [preview, setPreview] = useState<{
    days: number;
    data?: AdminExtensionPreview;
    error?: unknown;
  } | null>(null);
  // Preuve renforcée déjà obtenue pour CE contenu (réessai après perte).
  const [stepUpToken, setStepUpToken] = useState<string | null>(null);

  const dayCount = Number(days);
  const daysValid =
    Number.isInteger(dayCount) && dayCount >= DAYS_MIN && dayCount <= DAYS_MAX;

  // Aperçu des dates (lecture seule) pour la durée saisie.
  useEffect(() => {
    if (!open || kind !== "extend" || !daysValid) return;
    let cancelled = false;
    adminRequest<AdminExtensionPreview>(
      "GET",
      `organizations/${organization.id}/extension-preview?days=${dayCount}`,
    ).then(
      (data) => {
        if (!cancelled) setPreview({ days: dayCount, data });
      },
      (err: unknown) => {
        if (!cancelled) setPreview({ days: dayCount, error: err });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, kind, organization.id, dayCount, daysValid]);

  const currentPreview = preview && preview.days === dayCount ? preview : null;
  const plan = currentPreview?.data?.plan;

  // Contenu exact confirmé (même forme que l'API, avant normalisation).
  const content = useMemo(() => {
    if (kind === "suspend") {
      return {
        internalReason: internalReason.trim(),
        clientMessage: clientMessage.trim(),
      };
    }
    if (kind === "reactivate") return { reason: reason.trim() };
    return {
      days: dayCount,
      reason: reason.trim(),
      expectedCoverageEndsAt:
        plan && plan.ok ? plan.previousCoverageEndsAt : null,
    };
  }, [kind, internalReason, clientMessage, reason, dayCount, plan]);
  const contentKey = JSON.stringify(content);
  const [operation, setOperation] = useState<{ key: string; id: string }>({
    key: "",
    id: "",
  });
  const operationId = operation.key === contentKey ? operation.id : null;

  const formValid =
    kind === "suspend"
      ? validText(internalReason) && validText(clientMessage)
      : kind === "reactivate"
        ? validText(reason)
        : daysValid && validText(reason) && Boolean(plan?.ok);

  const reset = () => {
    setStep("form");
    setPassword("");
    setFactor("");
    setError(null);
    setNetworkLost(false);
    setOutcome(null);
    setStepUpToken(null);
  };

  const close = (next: boolean) => {
    if (!next) {
      if (outcome) onApplied();
      reset();
      setInternalReason("");
      setClientMessage("");
      setReason("");
      setDays("7");
      setPreview(null);
      setOperation({ key: "", id: "" });
    }
    onOpenChange(next);
  };

  const goReview = () => {
    // Nouveau contenu → nouvel identifiant et nouvelle confirmation.
    if (operation.key !== contentKey) {
      setOperation({ key: contentKey, id: crypto.randomUUID() });
      setStepUpToken(null);
    }
    setError(null);
    setNetworkLost(false);
    setStep("review");
  };

  const submit = async () => {
    if (busy || !operationId) return;
    setBusy(true);
    setError(null);
    setNetworkLost(false);
    try {
      let token = stepUpToken;
      if (!token) {
        const compact = factor.replace(/\s/g, "");
        const proof = /^\d{6}$/.test(compact)
          ? { code: compact }
          : { recoveryCode: factor };
        const result = await adminRequest<{ stepUpToken: string }>(
          "POST",
          "security/step-up",
          {
            password,
            ...proof,
            intent: {
              action: ACTION[kind],
              organizationId: organization.id,
              operationId,
              ...content,
            },
          },
        );
        token = result.stepUpToken;
        setStepUpToken(token);
        setPassword("");
        setFactor("");
      }
      const applied = await adminRequest<AdminActionOutcome>(
        "POST",
        `organizations/${organization.id}/${kind}`,
        { operationId, stepUpToken: token, ...content },
      );
      setOutcome(applied);
      setStep("done");
    } catch (err) {
      if (err instanceof AdminApiError && err.code === "NETWORK") {
        // Sort inconnu : réessayer le MÊME contenu, même identifiant.
        setNetworkLost(true);
      } else {
        // Preuve refusée ou expirée : nouvelle confirmation au prochain essai.
        if (
          err instanceof AdminApiError &&
          (err.code === "PLATFORM_ADMIN_STEP_UP_REQUIRED" ||
            err.code === "PLATFORM_ADMIN_CODE_INVALID")
        ) {
          setStepUpToken(null);
        }
        setError(err);
      }
    } finally {
      setBusy(false);
    }
  };

  const suspended = organization.status === "suspended";
  const title = t(`actions.${kind}`);
  const date = (value: unknown) =>
    typeof value === "string" ? format.dateTime(value) : t("none");

  const effects =
    kind === "suspend"
      ? [
          t("actions.suspendEffects.access"),
          t("actions.suspendEffects.realtime"),
          t("actions.suspendEffects.owner"),
          t("actions.suspendEffects.kept"),
          t("actions.suspendEffects.offline"),
        ]
      : kind === "reactivate"
        ? [
            t("actions.reactivateEffects.only"),
            t("actions.reactivateEffects.unchanged"),
          ]
        : [
            t("actions.extendEffects.noPayment"),
            t("actions.extendEffects.noSuspension"),
          ];

  const currentState = (
    <p className="text-sm">
      <span className="text-muted-foreground">{t("actions.current")} · </span>
      <span className="font-medium">
        {suspended ? t("actions.statusSuspended") : t("actions.statusActive")}
      </span>
      {" · "}
      {t(`classes.${organization.subscription.class}`)}
    </p>
  );

  const extensionSummary =
    kind === "extend" && plan?.ok ? (
      <div className="rounded-lg border border-border p-3 text-sm">
        <p>
          {plan.previousCoverageEndsAt
            ? t("actions.previewUntil", {
                date: date(plan.previousCoverageEndsAt),
              })
            : t("actions.previewNone")}
        </p>
        <p className="text-muted-foreground">
          {plan.basis === "start-now"
            ? t("actions.previewStartNow")
            : t("actions.previewExtendCoverage")}
        </p>
        <p className="mt-1 font-medium">
          {t("actions.previewResult", {
            start: date(plan.startsAt),
            end: date(plan.endsAt),
          })}
        </p>
        {plan.scheduledPeriods > 0 && (
          <p className="text-muted-foreground">
            {t("actions.previewScheduled", { count: plan.scheduledPeriods })}
          </p>
        )}
      </div>
    ) : null;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent layout="form">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{organization.name}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {currentState}

          {step === "form" && (
            <>
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">
                  {t("actions.consequences")}
                </h3>
                <Effects items={effects} />
              </section>

              {kind === "suspend" && (
                <>
                  <div className="flex flex-col gap-1.5 rounded-lg border border-dashed border-border p-3">
                    <Label htmlFor="action-internal">
                      {t("actions.internalReason")}
                    </Label>
                    <Textarea
                      id="action-internal"
                      maxLength={REASON_MAX}
                      value={internalReason}
                      onChange={(e) => setInternalReason(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("actions.internalReasonHint")}
                    </p>
                  </div>
                  <div className="flex flex-col gap-1.5 rounded-lg border border-primary/40 bg-primary/5 p-3">
                    <Label htmlFor="action-client">
                      {t("actions.clientMessage")}
                    </Label>
                    <Textarea
                      id="action-client"
                      maxLength={REASON_MAX}
                      value={clientMessage}
                      onChange={(e) => setClientMessage(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("actions.clientMessageHint")}
                    </p>
                  </div>
                </>
              )}

              {kind === "extend" && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="action-days">{t("actions.days")}</Label>
                  <Input
                    id="action-days"
                    type="number"
                    inputMode="numeric"
                    min={DAYS_MIN}
                    max={DAYS_MAX}
                    value={days}
                    onChange={(e) => setDays(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("actions.daysHint", { min: DAYS_MIN, max: DAYS_MAX })}
                  </p>
                  {daysValid && !currentPreview && (
                    <p className="text-sm text-muted-foreground">
                      {t("actions.previewLoading")}
                    </p>
                  )}
                  {currentPreview?.error !== undefined && (
                    <AdminError error={currentPreview.error} />
                  )}
                  {plan && !plan.ok && (
                    <p
                      role="alert"
                      className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
                    >
                      {t(`actions.refusals.${plan.refusal}`)}
                    </p>
                  )}
                  {extensionSummary}
                </div>
              )}

              {kind !== "suspend" && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="action-reason">{t("actions.reason")}</Label>
                  <Textarea
                    id="action-reason"
                    maxLength={REASON_MAX}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("actions.reasonHint", {
                      min: REASON_MIN,
                      max: REASON_MAX,
                    })}
                  </p>
                </div>
              )}
              {kind === "suspend" && (
                <p className="text-xs text-muted-foreground">
                  {t("actions.reasonHint", {
                    min: REASON_MIN,
                    max: REASON_MAX,
                  })}
                </p>
              )}
            </>
          )}

          {step === "review" && (
            <>
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">{t("actions.review")}</h3>
                <Effects items={effects} />
                {kind === "suspend" && (
                  <dl className="grid gap-2 text-sm">
                    <div className="rounded-lg border border-dashed border-border p-3">
                      <dt className="text-xs text-muted-foreground">
                        {t("actions.internalReason")}
                      </dt>
                      <dd className="whitespace-pre-wrap">
                        {internalReason.trim()}
                      </dd>
                    </div>
                    <div className="rounded-lg border border-primary/40 bg-primary/5 p-3">
                      <dt className="text-xs text-muted-foreground">
                        {t("actions.clientMessage")}
                      </dt>
                      <dd className="whitespace-pre-wrap">
                        {clientMessage.trim()}
                      </dd>
                    </div>
                  </dl>
                )}
                {kind !== "suspend" && (
                  <div className="rounded-lg border border-border p-3 text-sm">
                    <p className="text-xs text-muted-foreground">
                      {t("actions.reason")}
                    </p>
                    <p className="whitespace-pre-wrap">{reason.trim()}</p>
                  </div>
                )}
                {extensionSummary}
                <p className="font-mono text-xs text-muted-foreground">
                  {t("actions.operation")} · {operationId}
                </p>
              </section>

              {!stepUpToken && (
                <section className="flex flex-col gap-3">
                  <p className="text-sm text-muted-foreground">
                    {t("actions.stepUp")}
                  </p>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="action-password">
                      {t("actions.password")}
                    </Label>
                    <Input
                      id="action-password"
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="action-factor">{t("actions.code")}</Label>
                    <Input
                      id="action-factor"
                      autoComplete="one-time-code"
                      spellCheck={false}
                      value={factor}
                      onChange={(e) => setFactor(e.target.value)}
                    />
                  </div>
                </section>
              )}

              {networkLost && (
                <p
                  role="alert"
                  className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
                >
                  {t("actions.networkLost")}
                </p>
              )}
              {error !== null && <AdminError error={error} />}
            </>
          )}

          {step === "done" && outcome && (
            <section role="status" className="flex flex-col gap-2 text-sm">
              <p className="font-medium">{t("actions.done")}</p>
              {outcome.replayed && (
                <p className="text-muted-foreground">{t("actions.replayed")}</p>
              )}
              {outcome.action === "organization_suspend" && (
                <p>
                  {t("actions.resultSuspended", {
                    date: date(outcome.result.suspendedAt),
                  })}
                </p>
              )}
              {outcome.action === "organization_reactivate" && (
                <p>
                  {t("actions.resultActive", {
                    date: date(outcome.result.reactivatedAt),
                  })}
                </p>
              )}
              {outcome.action === "subscription_extend" && (
                <p>
                  {t("actions.resultExtended", {
                    start: date(outcome.result.startsAt),
                    end: date(outcome.result.endsAt),
                  })}
                </p>
              )}
              <p className="font-mono text-xs text-muted-foreground">
                {t("actions.operation")} · {outcome.operationId}
              </p>
            </section>
          )}
        </DialogBody>
        <DialogFooter className="sm:flex-row sm:justify-end">
          {step === "form" && (
            <Button disabled={!formValid} onClick={goReview}>
              {t("actions.next")}
            </Button>
          )}
          {step === "review" && (
            <>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setStep("form")}
              >
                {t("actions.edit")}
              </Button>
              <Button
                disabled={
                  busy || (!stepUpToken && (!password || !factor.trim()))
                }
                onClick={() => void submit()}
              >
                {busy
                  ? t("actions.confirming")
                  : networkLost
                    ? t("actions.retry")
                    : t("actions.confirm")}
              </Button>
            </>
          )}
          {step === "done" && (
            <Button onClick={() => close(false)}>{t("actions.close")}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
