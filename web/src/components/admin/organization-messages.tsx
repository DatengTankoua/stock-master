"use client";

import { useEffect, useState } from "react";
import { useT } from "next-i18next/client";
import { toast } from "sonner";
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
  MESSAGE_ARCHIVE_BATCH_MAX,
  adminRequest,
  type AdminMessage,
  type AdminMessageArchiveOutcome,
  type AdminMessageDelivery,
  type AdminMessageOutcome,
  type AdminMessagePage,
  type AdminOrganizationDetail,
  type MessageArchiveFilter,
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
  // Archivage : capacité dédiée (l'API la revérifie ; `platform.read` ne
  // permet que la consultation).
  const canArchive = capabilities.has("platform.communications.archive");
  const [filter, setFilter] = useState<MessageArchiveFilter>("active");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirm, setConfirm] = useState<{
    messages: AdminMessage[];
    archived: boolean;
  } | null>(null);
  const { data, error, loading, retry } = useAdminData<AdminMessagePage>(
    `organizations/${organization.id}/messages?page=${page}&archived=${filter}`,
  );

  // Sélection limitée à la page affichée : vidée à chaque changement.
  const items = data?.items;
  useEffect(() => {
    setSelected(new Set());
  }, [items]);
  // Page devenue vide après un archivage (dernière page) : page précédente.
  useEffect(() => {
    if (data && data.items.length === 0 && page > 1) setPage(page - 1);
  }, [data, page]);

  const chooseFilter = (next: MessageArchiveFilter) => {
    setFilter(next);
    setPage(1);
  };
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < MESSAGE_ARCHIVE_BATCH_MAX) next.add(id);
      return next;
    });
  const chosen = (data?.items ?? []).filter((m) => selected.has(m.id));
  const toArchive = chosen.filter((m) => !m.archivedAt);
  const toRestore = chosen.filter((m) => m.archivedAt);
  const allOnPage =
    !!data && data.items.length > 0 && chosen.length === data.items.length;
  const counts = data?.counts;

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
        <div
          role="group"
          aria-label={t("messages.archive.filterLabel")}
          className="flex flex-wrap gap-2"
        >
          {(["active", "archived", "all"] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={filter === value ? "default" : "outline"}
              aria-pressed={filter === value}
              onClick={() => chooseFilter(value)}
            >
              {t(`messages.archive.filters.${value}`, {
                count: counts
                  ? value === "all"
                    ? counts.active + counts.archived
                    : counts[value]
                  : 0,
              })}
            </Button>
          ))}
        </div>
        {canArchive && (
          <p className="text-xs text-muted-foreground">
            {t("messages.archive.notice")}
          </p>
        )}
        {loading && <AdminLoading />}
        {error !== undefined && <AdminError error={error} onRetry={retry} />}
        {data && data.items.length === 0 && (
          <AdminEmpty>
            {filter === "archived"
              ? t("messages.archive.emptyArchived")
              : t("messages.empty")}
          </AdminEmpty>
        )}
        {data && data.items.length > 0 && canArchive && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-2 text-sm">
            <label className="flex min-h-9 items-center gap-2">
              <input
                type="checkbox"
                checked={allOnPage}
                onChange={() =>
                  setSelected(
                    allOnPage
                      ? new Set()
                      : new Set(
                          data.items
                            .slice(0, MESSAGE_ARCHIVE_BATCH_MAX)
                            .map((m) => m.id),
                        ),
                  )
                }
                className="size-5 shrink-0 accent-primary"
              />
              <span>{t("messages.archive.selectPage")}</span>
            </label>
            <span className="text-xs text-muted-foreground">
              {t("messages.archive.selected", { count: chosen.length })}
            </span>
            <span className="flex flex-wrap gap-2 sm:ml-auto">
              {toArchive.length > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setConfirm({ messages: toArchive, archived: true })
                  }
                >
                  {t("messages.archive.archiveSelected", {
                    count: toArchive.length,
                  })}
                </Button>
              )}
              {toRestore.length > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setConfirm({ messages: toRestore, archived: false })
                  }
                >
                  {t("messages.archive.restoreSelected", {
                    count: toRestore.length,
                  })}
                </Button>
              )}
            </span>
          </div>
        )}
        {data && data.items.length > 0 && (
          <ul className="flex flex-col gap-3">
            {data.items.map((message) => (
              <MessageEntry
                key={message.id}
                organization={organization}
                message={message}
                canRetry={{ in_app: canNotify, email: canEmail }}
                archiving={
                  canArchive
                    ? {
                        selected: selected.has(message.id),
                        onToggle: () => toggle(message.id),
                        onArchive: (archived) =>
                          setConfirm({ messages: [message], archived }),
                      }
                    : null
                }
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
      {confirm && (
        <MessageArchiveDialog
          organization={organization}
          messages={confirm.messages}
          archived={confirm.archived}
          onClose={(changed) => {
            setConfirm(null);
            if (changed) retry();
          }}
        />
      )}
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
  archiving,
  onChanged,
}: {
  organization: AdminOrganizationDetail;
  message: AdminMessage;
  canRetry: Record<MessageChannel, boolean>;
  /** `null` : session sans la capacité d'archivage. */
  archiving: {
    selected: boolean;
    onToggle: () => void;
    onArchive: (archived: boolean) => void;
  } | null;
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
        <div className="flex min-w-0 items-start gap-2">
          {archiving && (
            <input
              type="checkbox"
              checked={archiving.selected}
              onChange={archiving.onToggle}
              aria-label={t("messages.archive.selectOne", {
                title: message.title,
              })}
              className="mt-0.5 size-5 shrink-0 accent-primary"
            />
          )}
          <h3 className="min-w-0 font-medium break-words">{message.title}</h3>
          {message.archivedAt && (
            <Badge variant="outline">{t("messages.archive.badge")}</Badge>
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          {format.dateTime(message.at)}
        </span>
      </div>
      {message.archivedAt && (
        <p className="text-xs text-muted-foreground">
          {t("messages.archive.archivedBy", {
            date: format.dateTime(message.archivedAt),
            actor: message.archivedBy ?? t("none"),
          })}
        </p>
      )}
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
        {archiving && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => archiving.onArchive(!message.archivedAt)}
          >
            {message.archivedAt
              ? t("messages.archive.restoreOne")
              : t("messages.archive.archiveOne")}
          </Button>
        )}
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

/**
 * Archivage ou restauration après une confirmation simple (action
 * réversible, sans preuve renforcée). Aucune livraison n'est touchée.
 */
function MessageArchiveDialog({
  organization,
  messages,
  archived,
  onClose,
}: {
  organization: AdminOrganizationDetail;
  messages: AdminMessage[];
  archived: boolean;
  onClose: (changed: boolean) => void;
}) {
  const { t } = useT("admin");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await adminRequest<AdminMessageArchiveOutcome>(
        "POST",
        `organizations/${organization.id}/${archived ? "message-archive" : "message-restore"}`,
        { messageIds: messages.map((m) => m.id) },
      );
      toast.success(
        outcome.changed === 0
          ? t("messages.archive.unchanged")
          : archived
            ? t("messages.archive.archiveDone", { count: outcome.changed })
            : t("messages.archive.restoreDone", { count: outcome.changed }),
      );
      onClose(true);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => !next && !busy && onClose(false)}>
      <DialogContent layout="form">
        <DialogHeader>
          <DialogTitle>
            {archived
              ? t("messages.archive.archiveTitle", { count: messages.length })
              : t("messages.archive.restoreTitle", { count: messages.length })}
          </DialogTitle>
          <DialogDescription>
            {archived
              ? t("messages.archive.archiveText")
              : t("messages.archive.restoreText")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <ul className="list-disc pl-5 text-sm">
            {messages.map((m) => (
              <li key={m.id} className="break-words">
                {m.title}
              </li>
            ))}
          </ul>
          {archived && (
            <p className="text-xs text-muted-foreground">
              {t("messages.archive.notice")}
            </p>
          )}
          {error !== null && <AdminError error={error} />}
        </DialogBody>
        <DialogFooter className="sm:flex-row sm:justify-end">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => onClose(false)}
          >
            {t("actions.close")}
          </Button>
          <Button disabled={busy} onClick={() => void submit()}>
            {busy
              ? t("messages.archive.saving")
              : archived
                ? t("messages.archive.archiveConfirm")
                : t("messages.archive.restoreConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
