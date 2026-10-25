"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangleIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
} from "lucide-react";
import { toast } from "sonner";
import { useT } from "next-i18next/client";
import { useFormat } from "@/i18n/use-format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { SaleFormDialog } from "@/components/products/record-sale-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { hasPermission } from "@/lib/organization-permissions";
import {
  fetchSaleRegularizations,
  getApiErrorCode,
  getApiErrorMessage,
  requestSaleRegularization,
} from "@/lib/api";
import { useOrganizationShell } from "@/contexts/organization-shell-context";
import {
  OFFLINE_SALES_PANEL_ID,
  OFFLINE_SALES_PANEL_OPEN_EVENT,
  useOfflineSales,
} from "@/contexts/offline-sales-context";
import {
  BATCH_BUSINESS_CODES,
  allowedOperationActions,
  describeOperationError,
  isUnfinalized,
} from "@/lib/offline-sales-policy";

// Lot B : une vente en conflit pour un motif de lot se corrige avec le
// choix des lots (jamais réaffectée automatiquement).
const BATCH_CODES = new Set<string>(BATCH_BUSINESS_CODES);
function isBatchOperation(op: OutboxOperation): boolean {
  return (
    Boolean(op.payload.batchAllocations?.length) ||
    BATCH_CODES.has(op.lastError?.code ?? "")
  );
}
import type { OutboxOperation } from "@/lib/offline-sales-outbox-db";

// 1-16G : libellés de statut dans `sales` (`outbox.status.*`).
const STATUS_VARIANT = {
  pending: "secondary",
  syncing: "secondary",
  synced: "default",
  conflict: "destructive",
  abandoned: "outline",
} as const;

// 1-11C.3 — Ventes locales de la partition COURANTE : compteurs, statut,
// dernière erreur (message générique) et actions de résolution.
// 1-16D : l'export local JSON/CSV est retiré ; l'historique des ventes
// synchronisées se télécharge depuis Analyses.
// Aucune erreur brute, aucun token ni empreinte affichés.
export function PendingSalesPanel() {
  const { t } = useT("sales");
  const format = useFormat();
  const {
    status,
    operations,
    blocked,
    online,
    syncNow,
    act,
    recordSale,
    markRegularization,
  } = useOfflineSales();
  const { authContext } = useOrganizationShell();
  // Régularisation : `stock.adjust`, revérifié par l'API (403 sinon).
  const canRegularize = hasPermission(authContext, "stock.adjust");
  const [editing, setEditing] = useState<OutboxOperation | null>(null);
  const [regularizing, setRegularizing] = useState<OutboxOperation | null>(
    null,
  );
  const [requesting, setRequesting] = useState<OutboxOperation | null>(null);

  // Lot B : décisions des responsables pour les demandes en attente (relues
  // en ligne, au montage puis toutes les 20 s).
  const awaiting = operations
    .filter(
      (op) =>
        op.status === "conflict" && op.regularization?.status === "requested",
    )
    .map((op) => op.clientOperationId);
  const awaitingKey = awaiting.join(",");
  useEffect(() => {
    if (!online || awaitingKey === "") return;
    let cancelled = false;
    const check = async () => {
      try {
        const requests = await fetchSaleRegularizations({
          clientOperationIds: awaitingKey.split(","),
        });
        if (cancelled) return;
        for (const r of requests) {
          if (r.status === "pending") continue;
          await markRegularization(r.clientOperationId, {
            status: r.status,
            requestId: r._id,
            reason: r.decisionReason,
          });
        }
      } catch {
        // Réseau ou droits : nouvel essai au prochain tour.
      }
    };
    void check();
    const timer = setInterval(() => void check(), 20_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [online, awaitingKey, markRegularization]);

  const sendRegularizationRequest = (op: OutboxOperation) =>
    run(async () => {
      try {
        const request = await requestSaleRegularization({
          ...op.payload,
          clientOperationId: op.clientOperationId,
        });
        await markRegularization(op.clientOperationId, {
          status:
            request.status === "pending"
              ? "requested"
              : request.status === "approved"
                ? "approved"
                : "rejected",
          requestId: request._id,
          reason: request.decisionReason,
        });
        toast.success(t("outbox.regularize.requested"));
      } catch (err) {
        // Vente déjà enregistrée sous cette clé : renvoi de la même
        // opération (le serveur rejoue la vente existante).
        if (getApiErrorCode(err) === "SALE_REGULARIZATION_ALREADY_APPLIED") {
          await markRegularization(op.clientOperationId, {
            status: "approved",
            requestId: "",
          });
        } else {
          toast.error(getApiErrorMessage(err));
        }
      } finally {
        setRequesting(null);
      }
    });
  const [confirm, setConfirm] = useState<{
    op: OutboxOperation;
    action: "abandon" | "remove-corrupted";
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const counts = {
    pending: operations.filter((op) => op.status === "pending").length,
    syncing: operations.filter((op) => op.status === "syncing").length,
    conflict: operations.filter((op) => op.status === "conflict").length,
  };
  const unfinalized = operations.filter((op) => isUnfinalized(op.status));
  const synced = operations.filter((op) => op.status === "synced");

  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  if (status === "idle" || status === "loading") {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t("outbox.loading")}
      </p>
    );
  }
  if (status === "error" || status === "unavailable") {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t("outbox.unreadable")}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-3 gap-2 text-center">
        {(
          [
            [t("outbox.counts.pending"), counts.pending],
            [t("outbox.counts.syncing"), counts.syncing],
            [t("outbox.counts.conflict"), counts.conflict],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="rounded-md border p-2">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="text-lg font-semibold">{value}</dd>
          </div>
        ))}
      </dl>

      {blocked && (
        <div
          role="alert"
          className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
        >
          <ShieldAlertIcon
            className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
            aria-hidden
          />
          <p>
            {blocked.reason === "subscription"
              ? t("outbox.blocked.subscription")
              : blocked.reason === "suspended"
                ? t("outbox.blocked.suspended")
                : blocked.reason === "access_denied"
                  ? t("outbox.blocked.accessDenied")
                  : t("outbox.blocked.corruption")}
          </p>
        </div>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        {counts.pending > 0 && !blocked && (
          <Button
            type="button"
            size="sm"
            disabled={!online || busy}
            onClick={() => void run(syncNow)}
          >
            <RefreshCwIcon className="mr-1 h-3.5 w-3.5" aria-hidden />
            {t("syncNow")}
          </Button>
        )}
      </div>
      {!online && counts.pending > 0 && (
        <p className="text-xs text-muted-foreground">
          {t("outbox.resumeOnline")}
        </p>
      )}

      {unfinalized.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("outbox.empty")}</p>
      ) : (
        <ul className="space-y-2" aria-label={t("outbox.listLabel")}>
          {unfinalized.map((op) => (
            <OperationItem
              key={op.clientOperationId}
              op={op}
              busy={busy}
              onEdit={() => setEditing(op)}
              canRegularize={canRegularize}
              online={online}
              onRegularize={() => setRegularizing(op)}
              onRequestRegularization={() => setRequesting(op)}
              onRetry={() =>
                void run(async () => {
                  if (!(await act(op.clientOperationId, "retry"))) {
                    toast.error(t("outbox.actionFailed"));
                  }
                })
              }
              onAbandon={() => setConfirm({ op, action: "abandon" })}
              onRemoveCorrupted={() =>
                setConfirm({ op, action: "remove-corrupted" })
              }
            />
          ))}
        </ul>
      )}

      {synced.length > 0 && (
        <details className="rounded-md border p-3 text-sm">
          <summary className="cursor-pointer font-medium">
            {t("outbox.recentlySynced", { count: synced.length })}
          </summary>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("outbox.syncedRetention")}
          </p>
          <ul className="mt-2 space-y-1">
            {synced.map((op) => (
              <li
                key={op.clientOperationId}
                className="flex justify-between gap-2 text-xs"
              >
                <span className="min-w-0 truncate">
                  {op.display.productName} — {op.payload.quantity} ×{" "}
                  {format.fcfa(op.payload.salePrice)}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {op.lastError?.code === "SALE_OPERATION_ALREADY_APPLIED"
                    ? t("outbox.cancelledLater")
                    : t("outbox.confirmed")}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {editing && (
        <SaleFormDialog
          key={editing.clientOperationId}
          open
          onOpenChange={(v) => !v && setEditing(null)}
          productId={editing.payload.productId}
          productName={editing.display.productName}
          targetPrice={editing.display.unitPriceHint}
          initial={{
            quantity: editing.payload.quantity,
            salePrice: editing.payload.salePrice,
            buyerName: editing.payload.buyerName,
            buyerContact: editing.payload.buyerContact,
            batchAllocations: editing.payload.batchAllocations,
            unknownExpiryConfirmed: editing.payload.unknownExpiryConfirmed,
          }}
          replaces={editing.clientOperationId}
          batchTracked={isBatchOperation(editing)}
        />
      )}

      {requesting && (
        <Dialog open onOpenChange={(v) => !v && !busy && setRequesting(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("outbox.regularize.requestTitle")}</DialogTitle>
              <DialogDescription>
                {t("outbox.regularize.requestText", {
                  date: format.dateTime(requesting.payload.occurredAt),
                })}
              </DialogDescription>
            </DialogHeader>
            <Button
              type="button"
              className="w-full"
              disabled={busy}
              onClick={() => void sendRegularizationRequest(requesting)}
            >
              {t("outbox.regularize.requestConfirm")}
            </Button>
          </DialogContent>
        </Dialog>
      )}

      {regularizing && (
        <RegularizeDialog
          op={regularizing}
          onClose={() => setRegularizing(null)}
          onConfirm={(reason) =>
            run(async () => {
              const op = regularizing;
              // Même vente, même heure réelle, mêmes lots : seule la
              // régularisation explicite (motif) est ajoutée.
              const result = await recordSale(
                {
                  productId: op.payload.productId,
                  productName: op.display.productName,
                  unitPriceHint: op.display.unitPriceHint,
                  quantity: op.payload.quantity,
                  salePrice: op.payload.salePrice,
                  buyerName: op.payload.buyerName,
                  buyerContact: op.payload.buyerContact,
                  batchAllocations: op.payload.batchAllocations,
                  unknownExpiryConfirmed: op.payload.unknownExpiryConfirmed,
                  expiredBatchRegularization: { reason },
                  batchLabels: op.display.batchLabels,
                },
                { replaces: op.clientOperationId, keepOccurredAt: true },
              );
              setRegularizing(null);
              if (result.kind === "synced") toast.success(t("form.recorded"));
              else if (result.kind === "refused" || result.kind === "conflict")
                toast.error(t("outbox.actionFailed"));
              else toast.info(t("form.pending"));
            })
          }
        />
      )}

      <AlertDialog
        open={confirm !== null}
        onOpenChange={(v) => !v && setConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.action === "remove-corrupted"
                ? t("outbox.confirm.removeTitle")
                : t("outbox.confirm.abandonTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm && allowedOperationActions(confirm.op).mayBeRecorded
                ? t("outbox.confirm.mayBeRecorded")
                : t("outbox.confirm.neverSent")}{" "}
              {t("outbox.confirm.staysVisible")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const target = confirm;
                setConfirm(null);
                if (!target) return;
                void run(async () => {
                  if (
                    !(await act(target.op.clientOperationId, target.action))
                  ) {
                    toast.error(t("outbox.actionFailed"));
                  }
                });
              }}
            >
              {confirm?.action === "remove-corrupted"
                ? t("outbox.actions.remove")
                : t("outbox.actions.abandon")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function OperationItem({
  op,
  busy,
  onEdit,
  onRetry,
  onAbandon,
  onRemoveCorrupted,
  canRegularize,
  online,
  onRegularize,
  onRequestRegularization,
}: {
  op: OutboxOperation;
  busy: boolean;
  canRegularize: boolean;
  online: boolean;
  onRegularize: () => void;
  onRequestRegularization: () => void;
  onEdit: () => void;
  onRetry: () => void;
  onAbandon: () => void;
  onRemoveCorrupted: () => void;
}) {
  const { t } = useT("sales");
  const format = useFormat();
  const allowed = allowedOperationActions(op);
  const errorKey = describeOperationError(op.lastError);
  const message = errorKey ? t(`outbox.errors.${errorKey}`) : null;
  return (
    <li>
      <Card>
        <CardContent className="space-y-2 py-3 text-sm">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate font-semibold">{op.display.productName}</p>
              <p className="text-xs text-muted-foreground">
                {format.dateTime(op.payload.occurredAt)}
              </p>
            </div>
            <Badge variant={STATUS_VARIANT[op.status]} className="shrink-0">
              {t(`outbox.status.${op.status}`)}
            </Badge>
          </div>
          <p>
            {op.payload.quantity} × {format.fcfa(op.payload.salePrice)} ={" "}
            <strong>
              {format.fcfa(op.payload.quantity * op.payload.salePrice)}
            </strong>
          </p>
          {(op.payload.buyerName || op.payload.buyerContact) && (
            <p className="wrap-break-word text-xs text-muted-foreground">
              {t("buyer")} {op.payload.buyerName ?? "—"}
              {op.payload.buyerContact ? ` — ${op.payload.buyerContact}` : ""}
            </p>
          )}
          {(message || op.attempts > 0) && (
            <p className="flex items-start gap-1 text-xs text-muted-foreground">
              {op.status === "conflict" && (
                <AlertTriangleIcon
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive"
                  aria-hidden
                />
              )}
              <span>
                {message}
                {op.attempts > 0
                  ? ` ${t("outbox.attempts", { count: op.attempts })}`
                  : ""}
              </span>
            </p>
          )}
          {op.display.batchLabels?.length ? (
            <p className="text-xs text-muted-foreground">
              {t("batches.saleLots", {
                list: op.display.batchLabels.join(", "),
              })}
            </p>
          ) : null}
          {op.regularization?.status === "requested" && (
            <p
              role="status"
              className="text-xs text-amber-700 dark:text-amber-400"
            >
              {t("outbox.regularize.awaiting", {
                date: format.dateTime(op.regularization.checkedAt),
              })}
            </p>
          )}
          {op.regularization?.status === "rejected" && (
            <p className="text-xs text-destructive">
              {t("outbox.regularize.rejected", {
                reason: op.regularization.reason ?? "—",
              })}
            </p>
          )}
          {op.lastError?.code === "BATCH_EXPIRED_AT_SYNC" &&
            !canRegularize &&
            !op.regularization && (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">
                  {t("outbox.regularize.noRight")}
                </p>
                <Button
                  type="button"
                  size="sm"
                  onClick={onRequestRegularization}
                  disabled={busy || !online}
                >
                  {t("outbox.actions.requestRegularization")}
                </Button>
              </div>
            )}
          {(allowed.edit ||
            allowed.retry ||
            allowed.abandon ||
            allowed.removeCorrupted) && (
            <div className="flex flex-wrap gap-2 pt-1">
              {allowed.edit &&
                canRegularize &&
                op.lastError?.code === "BATCH_EXPIRED_AT_SYNC" && (
                  <Button
                    type="button"
                    size="sm"
                    onClick={onRegularize}
                    disabled={busy}
                  >
                    {t("outbox.actions.regularize")}
                  </Button>
                )}
              {allowed.edit && (
                <Button
                  type="button"
                  size="sm"
                  variant={
                    op.lastError?.code === "BATCH_EXPIRED_AT_SYNC"
                      ? "outline"
                      : "default"
                  }
                  onClick={onEdit}
                  disabled={busy}
                >
                  {t("outbox.actions.edit")}
                </Button>
              )}
              {allowed.retry && (
                <Button
                  type="button"
                  size="sm"
                  onClick={onRetry}
                  disabled={busy}
                >
                  {t("outbox.actions.retry")}
                </Button>
              )}
              {allowed.abandon && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  onClick={onAbandon}
                  disabled={busy}
                >
                  {t("outbox.actions.abandon")}
                </Button>
              )}
              {allowed.removeCorrupted && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  onClick={onRemoveCorrupted}
                  disabled={busy}
                >
                  {t("outbox.actions.removeFromQueue")}
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </li>
  );
}

// Shell sans organisation active (accès révoqué) : les ventes locales
// restent consultables avant déconnexion. Rien si la file
// est vide.
export function PendingSalesIfAny() {
  const { t } = useT("sales");
  const { unfinalizedCount } = useOfflineSales();
  if (unfinalizedCount === 0) return null;
  return (
    <section
      aria-label={t("pendingOnDevice")}
      className="w-full space-y-3 text-left"
    >
      <h2 className="text-base font-semibold">{t("pendingOnDevice")}</h2>
      <PendingSalesPanel />
    </section>
  );
}

/**
 * Panneau intégré à `/app/catalog` hors ligne (seule route /app servie par le
 * service worker). Ancre `#offline-sales-panel` : ouvert, rendu visible et
 * focalisé au chargement avec ce fragment, sur `hashchange` ou sur
 * l'événement émis par le lien « ventes en attente ».
 */
export function OfflineSalesPanelSection({ count }: { count: number }) {
  const { t } = useT("sales");
  const [open, setOpen] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const reveal = () => {
      if (window.location.hash !== `#${OFFLINE_SALES_PANEL_ID}`) return;
      setOpen(true);
      requestAnimationFrame(() => {
        sectionRef.current?.scrollIntoView({ block: "start" });
        sectionRef.current?.focus({ preventScroll: true });
      });
    };
    const onRequest = () => {
      // Le fragment peut être déjà présent : ouverture explicite.
      setTimeout(reveal, 0);
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    window.addEventListener(OFFLINE_SALES_PANEL_OPEN_EVENT, onRequest);
    return () => {
      window.removeEventListener("hashchange", reveal);
      window.removeEventListener(OFFLINE_SALES_PANEL_OPEN_EVENT, onRequest);
    };
  }, []);

  return (
    <section
      id={OFFLINE_SALES_PANEL_ID}
      ref={sectionRef}
      tabIndex={-1}
      aria-label={t("pendingOnDevice")}
      className="scroll-mt-24 rounded-md border p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <details
        open={open}
        onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      >
        <summary className="cursor-pointer text-sm font-medium">
          {t("pendingOnDeviceCount", { count })}
        </summary>
        <div className="mt-3">
          <PendingSalesPanel />
        </div>
      </details>
    </section>
  );
}

// Lot B — régularisation explicite d'une vente hors ligne saisie avant la
// péremption d'un lot et reçue après : motif obligatoire, heure réelle et
// lots conservés. Jamais une autorisation de vendre ce lot aujourd'hui.
function RegularizeDialog({
  op,
  onClose,
  onConfirm,
}: {
  op: OutboxOperation;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const { t } = useT("sales");
  const format = useFormat();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  return (
    <Dialog open onOpenChange={(v) => !v && !saving && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("outbox.regularize.title")}</DialogTitle>
          <DialogDescription>
            {t("outbox.regularize.text", {
              date: format.dateTime(op.payload.occurredAt),
            })}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            if (reason.trim().length < 3) {
              setError(t("outbox.regularize.reasonTooShort"));
              return;
            }
            setSaving(true);
            try {
              await onConfirm(reason.trim());
            } finally {
              setSaving(false);
            }
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="reg-reason">{t("outbox.regularize.reason")}</Label>
            <Input
              id="reg-reason"
              maxLength={200}
              value={reason}
              placeholder={t("outbox.regularize.reasonPlaceholder")}
              onChange={(e) => setReason(e.target.value)}
              disabled={saving}
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={saving}>
            {t("outbox.regularize.confirm")}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
