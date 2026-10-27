"use client";

import { useState } from "react";
import { useT } from "next-i18next/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { useAdminStatus } from "@/components/admin/admin-shell";
import {
  AdminEmpty,
  AdminError,
  AdminLoading,
  AdminSection,
  Pager,
  useAdminData,
} from "@/components/admin/admin-ui";
import { OrganizationMessageDialog } from "@/components/admin/organization-message-dialog";
import {
  AdminApiError,
  adminRequest,
  type AdminMessage,
  type AdminMessageDelivery,
  type AdminMessageOutcome,
  type AdminOrganizationDetail,
  type AdminPage,
  type MessageChannel,
  type MessageDeliveryStatus,
} from "@/lib/admin/admin-api";

// Fiche organisation — messages de service : bouton d'envoi (selon les
// capacités de la session, affichage seulement : l'API décide), historique
// paginé et résultat par destinataire et canal. « Accepté » = pris en charge
// par le prestataire d'e-mail, jamais une réception ou une lecture.

const STATUS_VARIANT: Record<
  MessageDeliveryStatus,
  "default" | "secondary" | "outline" | "destructive"
> = {
  pending: "outline",
  sending: "outline",
  created: "secondary",
  accepted: "secondary",
  skipped: "outline",
  failed: "destructive",
  uncertain: "destructive",
};

const KNOWN_REASONS = new Set([
  "membership_inactive",
  "account_missing",
  "account_inactive",
  "organization_missing",
  "preference_off",
  "email_not_configured",
  "retry_window_expired",
  "timeout",
  "network",
  "internal_error",
  "message_missing",
  "unexpected",
]);

type ReasonKey =
  | "membership_inactive"
  | "account_missing"
  | "account_inactive"
  | "organization_missing"
  | "preference_off"
  | "email_not_configured"
  | "retry_window_expired"
  | "timeout"
  | "network"
  | "internal_error"
  | "message_missing"
  | "unexpected";

function useReason() {
  const { t } = useT("admin");
  return (reason: string | null): string | null => {
    if (!reason) return null;
    const rejected = /^rejected(?:_(\d{3}))?$/.exec(reason);
    if (rejected) {
      return t("messages.reasons.rejected", { status: rejected[1] ?? "—" });
    }
    return KNOWN_REASONS.has(reason)
      ? t(`messages.reasons.${reason as ReasonKey}`)
      : reason;
  };
}

export function OrganizationMessages({
  organization,
}: {
  organization: AdminOrganizationDetail;
}) {
  const { t } = useT("admin");
  const { status } = useAdminStatus();
  const capabilities = new Set(status.capabilities ?? []);
  const canNotify = capabilities.has("platform.communications.notify");
  const canEmail = capabilities.has("platform.communications.email");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const { data, error, loading, retry } = useAdminData<AdminPage<AdminMessage>>(
    `organizations/${organization.id}/messages?page=${page}`,
  );

  return (
    <AdminSection title={t("messages.section")}>
      <div className="flex flex-col gap-3">
        {canNotify || canEmail ? (
          <div>
            <Button onClick={() => setOpen(true)}>{t("messages.send")}</Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("messages.noCapability")}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {t("messages.acceptedNotice")}
        </p>
        {loading && <AdminLoading />}
        {error !== undefined && <AdminError error={error} onRetry={retry} />}
        {data && data.items.length === 0 && (
          <AdminEmpty>{t("messages.empty")}</AdminEmpty>
        )}
        {data && data.items.length > 0 && (
          <ul className="flex flex-col gap-3">
            {data.items.map((message) => (
              <MessageEntry
                key={message.id}
                organization={organization}
                message={message}
                canRetry={{ in_app: canNotify, email: canEmail }}
                onChanged={retry}
              />
            ))}
          </ul>
        )}
        {data && data.total > data.pageSize && (
          <Pager
            page={page}
            pageSize={data.pageSize}
            total={data.total}
            onPage={setPage}
          />
        )}
      </div>
      {open && (
        <OrganizationMessageDialog
          organization={organization}
          open
          onOpenChange={(next) => {
            if (!next) setOpen(false);
          }}
          onSent={() => {
            setPage(1);
            retry();
          }}
        />
      )}
    </AdminSection>
  );
}

function MessageEntry({
  organization,
  message,
  canRetry,
  onChanged,
}: {
  organization: AdminOrganizationDetail;
  message: AdminMessage;
  canRetry: Record<MessageChannel, boolean>;
  onChanged: () => void;
}) {
  const { t } = useT("admin");
  const format = useFormat();
  const reason = useReason();
  const [retrying, setRetrying] = useState<{
    channel: MessageChannel;
    deliveries: AdminMessageDelivery[];
  } | null>(null);
  const byRecipient = (userId: string, channel: MessageChannel) =>
    message.deliveries.find(
      (d) => d.userId === userId && d.channel === channel,
    );

  return (
    <li className="rounded-lg border border-border p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="min-w-0 font-medium break-words">{message.title}</h3>
        <span className="text-xs text-muted-foreground">
          {format.dateTime(message.at)}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {message.actor ?? t("none")} ·{" "}
        {message.channels
          .map((c) => t(`messages.channelNames.${c}`))
          .join(" + ")}
      </p>
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-primary">
          {t("messages.showBody")}
        </summary>
        {/* Texte brut, échappé par React. */}
        <p className="mt-2 whitespace-pre-wrap break-words">{message.body}</p>
      </details>
      <ul className="mt-3 flex flex-col divide-y divide-border">
        {message.recipients.map((r) => (
          <li key={r.userId} className="flex flex-col gap-1 py-2">
            <span className="min-w-0 break-words">
              {r.name ?? t("none")}
              <span className="block text-xs text-muted-foreground">
                {r.email ?? t("none")}
              </span>
            </span>
            <span className="flex flex-wrap gap-2">
              {message.channels.map((channel) => {
                const d = byRecipient(r.userId, channel);
                if (!d) return null;
                const why = reason(d.reason);
                return (
                  <span
                    key={channel}
                    className="flex flex-wrap items-center gap-1 text-xs"
                  >
                    <span className="text-muted-foreground">
                      {t(`messages.channelNames.${channel}`)}
                    </span>
                    <Badge variant={STATUS_VARIANT[d.status]}>
                      {t(`messages.statuses.${d.status}`)}
                    </Badge>
                    {why && (
                      <span className="text-muted-foreground">({why})</span>
                    )}
                  </span>
                );
              })}
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex flex-wrap gap-2">
        {message.channels.map((channel) => {
          const retryable = message.deliveries.filter(
            (d) => d.channel === channel && d.retryable,
          );
          if (retryable.length === 0 || !canRetry[channel]) return null;
          return (
            <Button
              key={channel}
              size="sm"
              variant="outline"
              onClick={() => setRetrying({ channel, deliveries: retryable })}
            >
              {t("messages.retryChannel", {
                channel: t(`messages.channelNames.${channel}`),
                count: retryable.length,
              })}
            </Button>
          );
        })}
      </div>
      {message.deliveries.some((d) => d.retryWindowExpired) && (
        <p className="mt-2 text-xs text-muted-foreground">
          {t("messages.windowExpiredNotice")}
        </p>
      )}
      {retrying && (
        <MessageRetryDialog
          organization={organization}
          message={message}
          channel={retrying.channel}
          deliveries={retrying.deliveries}
          onClose={(changed) => {
            setRetrying(null);
            if (changed) onChanged();
          }}
        />
      )}
    </li>
  );
}

/** Relance des seules livraisons désignées, après preuve renforcée liée. */
function MessageRetryDialog({
  organization,
  message,
  channel,
  deliveries,
  onClose,
}: {
  organization: AdminOrganizationDetail;
  message: AdminMessage;
  channel: MessageChannel;
  deliveries: AdminMessageDelivery[];
  onClose: (changed: boolean) => void;
}) {
  const { t } = useT("admin");
  const [operationId] = useState(() => crypto.randomUUID());
  const [password, setPassword] = useState("");
  const [factor, setFactor] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [networkLost, setNetworkLost] = useState(false);
  const [stepUpToken, setStepUpToken] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<AdminMessageOutcome | null>(null);
  const deliveryIds = deliveries.map((d) => d.id).sort();
  const names = deliveries.map(
    (d) =>
      message.recipients.find((r) => r.userId === d.userId)?.email ?? d.userId,
  );

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNetworkLost(false);
    const content = { messageId: message.id, channel, deliveryIds };
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
              action: "organization_message_retry",
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
      setOutcome(
        await adminRequest<AdminMessageOutcome>(
          "POST",
          `organizations/${organization.id}/message-retry`,
          { operationId, stepUpToken: token, ...content },
        ),
      );
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
        setError(err);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose(outcome !== null)}>
      <DialogContent layout="form">
        <DialogHeader>
          <DialogTitle>{t("messages.retryTitle")}</DialogTitle>
          <DialogDescription>{message.title}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {outcome ? (
            <section role="status" className="flex flex-col gap-2 text-sm">
              <p className="font-medium">{t("messages.retryDone")}</p>
              {outcome.replayed && (
                <p className="text-muted-foreground">
                  {t("messages.replayed")}
                </p>
              )}
            </section>
          ) : (
            <>
              <p className="text-sm">
                {t("messages.retryText", {
                  channel: t(`messages.channelNames.${channel}`),
                  count: deliveries.length,
                })}
              </p>
              <ul className="list-disc pl-5 text-sm text-muted-foreground">
                {names.map((name) => (
                  <li key={name} className="break-words">
                    {name}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                {t("messages.retryOnly")}
              </p>
              {!stepUpToken && (
                <section className="flex flex-col gap-3">
                  <p className="text-sm text-muted-foreground">
                    {t("actions.stepUp")}
                  </p>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="retry-password">
                      {t("actions.password")}
                    </Label>
                    <Input
                      id="retry-password"
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="retry-factor">{t("actions.code")}</Label>
                    <Input
                      id="retry-factor"
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
        </DialogBody>
        <DialogFooter className="sm:flex-row sm:justify-end">
          {outcome ? (
            <Button onClick={() => onClose(true)}>{t("actions.close")}</Button>
          ) : (
            <>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => onClose(false)}
              >
                {t("actions.close")}
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
                    : t("messages.retryConfirm")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
