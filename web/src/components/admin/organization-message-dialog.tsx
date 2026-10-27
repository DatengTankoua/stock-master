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
import { AdminError, AdminLoading } from "@/components/admin/admin-ui";
import {
  AdminApiError,
  MESSAGE_BODY_MAX,
  MESSAGE_TITLE_MAX,
  adminRequest,
  type AdminMessageOutcome,
  type AdminMessageRecipients,
  type AdminOrganizationDetail,
  type MessageChannel,
} from "@/lib/admin/admin-api";

// Administration de la plateforme — message de service aux membres d'UN
// commerce : sélection (un, plusieurs, tous les membres actifs FIGÉS à la
// préparation), canaux, texte brut, aperçu, récapitulatif, vérification
// renforcée liée au contenu exact, résultat.
//
// Identifiant d'opération : un par CONTENU (destinataires, canaux, titre,
// texte). Réessayer après une réponse perdue réutilise le même : l'API
// renvoie le résultat existant, sans nouvel envoi.

type Mode = "one" | "several" | "all";
type Step = "form" | "review" | "done";

const CHANNELS: MessageChannel[] = ["in_app", "email"];

export function OrganizationMessageDialog({
  organization,
  open,
  onOpenChange,
  onSent,
}: {
  organization: AdminOrganizationDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSent: () => void;
}) {
  const { t } = useT("admin");
  const [prepared, setPrepared] = useState<{
    data?: AdminMessageRecipients;
    error?: unknown;
  } | null>(null);
  const [reload, setReload] = useState(0);
  const [step, setStep] = useState<Step>("form");
  const [mode, setMode] = useState<Mode>("one");
  const [picked, setPicked] = useState<string[]>([]);
  const [channels, setChannels] = useState<MessageChannel[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [password, setPassword] = useState("");
  const [factor, setFactor] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [networkLost, setNetworkLost] = useState(false);
  const [outcome, setOutcome] = useState<AdminMessageOutcome | null>(null);
  const [stepUpToken, setStepUpToken] = useState<string | null>(null);

  // Préparation : membres actifs et limites (relue à chaque ouverture).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    adminRequest<AdminMessageRecipients>(
      "GET",
      `organizations/${organization.id}/message-recipients`,
    ).then(
      (data) => {
        if (cancelled) return;
        setPrepared({ data });
        setChannels((current) =>
          current.length > 0
            ? current.filter((c) => data.channels.includes(c))
            : data.channels.slice(0, 1),
        );
      },
      (err: unknown) => {
        if (!cancelled) setPrepared({ error: err });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, organization.id, reload]);

  const data = prepared?.data;
  const eligible = useMemo(
    () => data?.members.filter((m) => m.eligible) ?? [],
    [data],
  );
  // « Tous » : la liste lue à la préparation, jamais les futurs membres.
  const recipientIds = useMemo(() => {
    const allowed = new Set(eligible.map((m) => m.userId));
    const ids =
      mode === "all" ? [...allowed] : picked.filter((id) => allowed.has(id));
    return [...new Set(ids)].sort();
  }, [mode, picked, eligible]);
  const recipients = eligible.filter((m) => recipientIds.includes(m.userId));
  const sortedChannels = CHANNELS.filter((c) => channels.includes(c));

  const content = useMemo(
    () => ({
      channels: sortedChannels,
      recipientUserIds: recipientIds,
      title: title.trim(),
      body: body.replace(/\r\n?/g, "\n").trim(),
    }),
    [sortedChannels, recipientIds, title, body],
  );
  const contentKey = JSON.stringify(content);
  const [operation, setOperation] = useState({ key: "", id: "" });
  const operationId = operation.key === contentKey ? operation.id : null;

  const limits = data?.limits;
  const tooMany = limits ? recipientIds.length > limits.maxRecipients : false;
  const titleValid =
    content.title.length > 0 &&
    content.title.length <= MESSAGE_TITLE_MAX &&
    !/[\n\t]/.test(content.title);
  const bodyValid =
    content.body.length > 0 && content.body.length <= MESSAGE_BODY_MAX;
  const formValid =
    Boolean(data) &&
    recipientIds.length > 0 &&
    !tooMany &&
    sortedChannels.length > 0 &&
    titleValid &&
    bodyValid;

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
      if (outcome) onSent();
      reset();
      setMode("one");
      setPicked([]);
      setChannels([]);
      setTitle("");
      setBody("");
      setPrepared(null);
      setOperation({ key: "", id: "" });
    }
    onOpenChange(next);
  };

  const goReview = () => {
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
              action: "organization_message",
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
      const sent = await adminRequest<AdminMessageOutcome>(
        "POST",
        `organizations/${organization.id}/messages`,
        { operationId, stepUpToken: token, ...content },
      );
      setOutcome(sent);
      setStep("done");
    } catch (err) {
      if (err instanceof AdminApiError && err.code === "NETWORK") {
        setNetworkLost(true);
      } else {
        if (
          err instanceof AdminApiError &&
          (err.code === "PLATFORM_ADMIN_STEP_UP_REQUIRED" ||
            err.code === "PLATFORM_ADMIN_CODE_INVALID")
        ) {
          setStepUpToken(null);
        }
        if (
          err instanceof AdminApiError &&
          err.code === "PLATFORM_ADMIN_MESSAGE_RECIPIENTS_CHANGED"
        ) {
          // Membres relus : la sélection devra être confirmée à nouveau.
          setReload((n) => n + 1);
        }
        setError(err);
      }
    } finally {
      setBusy(false);
    }
  };

  const toggle = (userId: string) => {
    if (mode === "one") {
      setPicked([userId]);
      return;
    }
    setPicked((current) =>
      current.includes(userId)
        ? current.filter((id) => id !== userId)
        : [...current, userId],
    );
  };

  const toggleChannel = (channel: MessageChannel) =>
    setChannels((current) =>
      current.includes(channel)
        ? current.filter((c) => c !== channel)
        : [...current, channel],
    );

  const suspended =
    (data?.organization.status ?? organization.status) === "suspended";

  const preview = (
    <article className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
      <p className="text-xs font-medium text-primary">
        {t("messages.categoryLabel")}
      </p>
      <h4 className="mt-1 font-semibold break-words">{content.title}</h4>
      {/* Texte brut : React échappe tout, aucun HTML n'est interprété. */}
      <p className="mt-2 whitespace-pre-wrap break-words">{content.body}</p>
    </article>
  );

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent layout="form">
        <DialogHeader>
          <DialogTitle>{t("messages.send")}</DialogTitle>
          <DialogDescription>{organization.name}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {suspended && (
            <p
              role="note"
              className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
            >
              {t("messages.suspendedNotice")}
            </p>
          )}

          {!prepared && <AdminLoading />}
          {prepared?.error !== undefined && (
            <AdminError
              error={prepared.error}
              onRetry={() => setReload((n) => n + 1)}
            />
          )}

          {step === "form" && data && (
            <>
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-sm font-medium">
                  {t("messages.recipients")}
                </legend>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {(["one", "several", "all"] as const).map((value) => (
                    <label
                      key={value}
                      className="flex min-h-11 cursor-pointer items-center gap-2 text-sm"
                    >
                      <input
                        type="radio"
                        name="message-mode"
                        checked={mode === value}
                        onChange={() => {
                          setMode(value);
                          if (value === "one") setPicked(picked.slice(0, 1));
                        }}
                        className="size-5 accent-primary"
                      />
                      {t(`messages.modes.${value}`)}
                    </label>
                  ))}
                </div>
                {mode === "all" && (
                  <p className="text-xs text-muted-foreground">
                    {t("messages.allFrozen", { count: eligible.length })}
                  </p>
                )}
                <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-lg border border-border p-1">
                  {data.members.length === 0 && (
                    <li className="p-2 text-sm text-muted-foreground">
                      {t("messages.noMembers")}
                    </li>
                  )}
                  {data.members.map((m) => (
                    <li key={m.userId}>
                      <label className="flex min-h-11 min-w-0 cursor-pointer items-start gap-3 rounded-md px-2 py-2 text-sm hover:bg-muted has-disabled:cursor-default has-disabled:opacity-60 has-disabled:hover:bg-transparent">
                        <input
                          type={mode === "one" ? "radio" : "checkbox"}
                          name="message-recipient"
                          checked={
                            m.eligible &&
                            (mode === "all" || picked.includes(m.userId))
                          }
                          disabled={!m.eligible || mode === "all"}
                          onChange={() => toggle(m.userId)}
                          className="mt-px size-5 shrink-0 accent-primary"
                        />
                        <span className="min-w-0 break-words">
                          <span className="font-medium">{m.name}</span>
                          <span className="block text-xs text-muted-foreground">
                            {m.email} · {t(`organization.roles.${m.role}`)}
                            {!m.eligible && ` · ${t("messages.notReachable")}`}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
                {tooMany && limits && (
                  <p role="alert" className="text-sm text-destructive">
                    {t("errors.messageRecipientLimit")} (
                    {t("messages.maxRecipients", { max: limits.maxRecipients })}
                    )
                  </p>
                )}
              </fieldset>

              <fieldset className="flex flex-col gap-1">
                <legend className="mb-1 text-sm font-medium">
                  {t("messages.channels")}
                </legend>
                {CHANNELS.map((channel) => {
                  const allowed = data.channels.includes(channel);
                  return (
                    <label
                      key={channel}
                      className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md px-2 py-2 text-sm hover:bg-muted has-disabled:cursor-default has-disabled:opacity-60 has-disabled:hover:bg-transparent"
                    >
                      <input
                        type="checkbox"
                        checked={allowed && channels.includes(channel)}
                        disabled={!allowed}
                        onChange={() => toggleChannel(channel)}
                        className="mt-px size-5 shrink-0 accent-primary"
                      />
                      <span className="min-w-0 break-words">
                        {t(`messages.channelNames.${channel}`)}
                        <span className="block text-xs text-muted-foreground">
                          {allowed
                            ? t(`messages.channelHints.${channel}`)
                            : t("messages.channelNotAllowed")}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </fieldset>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="message-title">{t("messages.title")}</Label>
                <Input
                  id="message-title"
                  maxLength={MESSAGE_TITLE_MAX}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {t("messages.counter", {
                    count: title.trim().length,
                    max: MESSAGE_TITLE_MAX,
                  })}
                </p>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="message-body">{t("messages.body")}</Label>
                <Textarea
                  id="message-body"
                  rows={8}
                  maxLength={MESSAGE_BODY_MAX}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {t("messages.counter", {
                    count: content.body.length,
                    max: MESSAGE_BODY_MAX,
                  })}
                  {" · "}
                  {t("messages.plainText")}
                </p>
              </div>
              {limits && (
                <p className="text-xs text-muted-foreground">
                  {t("messages.limits", {
                    max: limits.maxRecipients,
                    used: limits.organization.used,
                    orgMax: limits.organization.max,
                    hours: limits.organization.windowHours,
                  })}
                </p>
              )}
            </>
          )}

          {step === "review" && (
            <>
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">{t("messages.preview")}</h3>
                {preview}
              </section>
              <section className="flex flex-col gap-2 text-sm">
                <h3 className="font-medium">{t("actions.review")}</h3>
                <p>
                  {t("messages.reviewChannels")} ·{" "}
                  {sortedChannels
                    .map((c) => t(`messages.channelNames.${c}`))
                    .join(" + ")}
                </p>
                <p>
                  {t("messages.reviewRecipients", { count: recipients.length })}
                </p>
                <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
                  {recipients.map((m) => (
                    <li key={m.userId} className="break-words">
                      {m.name} · {m.email}
                    </li>
                  ))}
                </ul>
                <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                  {sortedChannels.includes("in_app") && (
                    <li>{t("messages.reviewInApp")}</li>
                  )}
                  {sortedChannels.includes("email") && (
                    <li>{t("messages.reviewEmail")}</li>
                  )}
                  <li>{t("messages.reviewNoReactivation")}</li>
                </ul>
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
                    <Label htmlFor="message-password">
                      {t("actions.password")}
                    </Label>
                    <Input
                      id="message-password"
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="message-factor">{t("actions.code")}</Label>
                    <Input
                      id="message-factor"
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
                  {t("messages.networkLost")}
                </p>
              )}
              {error !== null && <AdminError error={error} />}
            </>
          )}

          {step === "done" && outcome && (
            <section role="status" className="flex flex-col gap-2 text-sm">
              <p className="font-medium">{t("messages.done")}</p>
              {outcome.replayed && (
                <p className="text-muted-foreground">
                  {t("messages.replayed")}
                </p>
              )}
              <p>
                {t("messages.doneDetail", {
                  count: Number(outcome.result.deliveries ?? 0),
                })}
              </p>
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
                  ? t("messages.sending")
                  : networkLost
                    ? t("actions.retry")
                    : t("messages.confirm")}
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
