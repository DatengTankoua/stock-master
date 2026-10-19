"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "next-i18next/client";
import { useFormat } from "@/i18n/use-format";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  changeBatchStatus,
  correctBatchLoss,
  fetchProductLosses,
  getApiErrorCode,
  getApiErrorMessage,
  recordBatchLoss,
  type ApiLossReason,
  type ApiProductBatch,
  type ApiProductBatches,
  type ApiStockLoss,
} from "@/lib/api";

// Lot C — opérations de stock sur un lot (EN LIGNE uniquement) : mise à
// l'écart du lot ENTIER, remise à disposition, perte (sortie définitive),
// correction d'une perte par contre-mouvement. Chaque opération est
// confirmée explicitement ; l'API revérifie droits, quantités et états.

const LOSS_ERROR_KEYS: Record<string, string> = {
  BATCH_INSUFFICIENT: "insufficient",
  BATCH_STATUS_UNCHANGED: "statusUnchanged",
  LOSS_COMMENT_REQUIRED: "commentRequired",
  LOSS_CORRECTION_EXCEEDS: "correctionExceeds",
  PRODUCT_BATCHES_DISABLED: "unavailable",
};

function describe(error: unknown, t: (k: string) => string): string {
  const code = getApiErrorCode(error);
  if (code && LOSS_ERROR_KEYS[code]) {
    return t(`batches.ops.errors.${LOSS_ERROR_KEYS[code]}`);
  }
  return getApiErrorMessage(error);
}

/** Clé d'idempotence stable tant que la saisie ne change pas. */
function useOperationKey() {
  const last = useRef<{ body: string; key: string } | null>(null);
  return useCallback((body: unknown) => {
    const serialized = JSON.stringify(body);
    if (last.current?.body !== serialized) {
      last.current = { body: serialized, key: crypto.randomUUID() };
    }
    return last.current.key;
  }, []);
}

export function BatchStatusDialog({
  productId,
  batch,
  action,
  onClose,
  onDone,
}: {
  productId: string;
  batch: ApiProductBatch;
  action: "quarantine" | "release";
  onClose: () => void;
  onDone: (result: ApiProductBatches) => void;
}) {
  const { t } = useT("catalog");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const tr = t as unknown as (k: string, o?: object) => string;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (reason.trim().length < 3) {
      setError(tr("batches.ops.errors.reason"));
      return;
    }
    if (!confirmed) {
      setError(tr("batches.ops.errors.confirm"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      onDone(
        await changeBatchStatus(productId, batch._id, action, reason.trim()),
      );
    } catch (err) {
      setError(describe(err, tr));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open onOpenChange={(v) => !v && !saving && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {tr(
              action === "quarantine"
                ? "batches.ops.quarantineTitle"
                : "batches.ops.releaseTitle",
              { reference: batch.reference },
            )}
          </DialogTitle>
          <DialogDescription>
            {tr(
              action === "quarantine"
                ? "batches.ops.quarantineText"
                : batch.expiryState === "expired"
                  ? "batches.ops.releaseExpiredText"
                  : "batches.ops.releaseText",
            )}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3" noValidate>
          <div className="space-y-1">
            <Label htmlFor="bs-reason">{tr("batches.ops.reason")}</Label>
            <Input
              id="bs-reason"
              maxLength={200}
              value={reason}
              disabled={saving}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={confirmed}
              disabled={saving}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            {tr(
              action === "quarantine"
                ? "batches.ops.quarantineConfirm"
                : "batches.ops.releaseConfirm",
            )}
          </label>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={saving}>
            {tr(
              action === "quarantine"
                ? "batches.ops.quarantine"
                : "batches.ops.release",
            )}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function BatchLossDialog({
  productId,
  batch,
  onClose,
  onDone,
}: {
  productId: string;
  batch: ApiProductBatch;
  onClose: () => void;
  onDone: (result: ApiProductBatches) => void;
}) {
  const { t } = useT("catalog");
  const tr = t as unknown as (k: string, o?: object) => string;
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState<ApiLossReason>(
    batch.expiryState === "expired" ? "expired" : "damaged",
  );
  const [comment, setComment] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const operationKey = useOperationKey();
  const max = batch.remainingQuantity;
  const q = /^\d+$/.test(quantity.trim()) ? Number(quantity) : 0;
  const closes = max !== undefined && q === max;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (q < 1 || (max !== undefined && q > max)) {
      setError(tr("batches.ops.errors.quantity"));
      return;
    }
    if (reason === "other" && comment.trim().length < 3) {
      setError(tr("batches.ops.errors.commentRequired"));
      return;
    }
    if (!confirmed) {
      setError(tr("batches.ops.errors.confirm"));
      return;
    }
    const body = {
      quantity: q,
      reason,
      ...(comment.trim() ? { comment: comment.trim() } : {}),
    };
    setSaving(true);
    setError(null);
    try {
      onDone(
        await recordBatchLoss(productId, batch._id, {
          clientOperationId: operationKey(body),
          ...body,
        }),
      );
    } catch (err) {
      setError(describe(err, tr));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open onOpenChange={(v) => !v && !saving && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {tr("batches.ops.lossTitle", { reference: batch.reference })}
          </DialogTitle>
          <DialogDescription>{tr("batches.ops.lossText")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3" noValidate>
          <div className="space-y-1">
            <Label htmlFor="bl-qty">{tr("batches.ops.lossQuantity")}</Label>
            <Input
              id="bl-qty"
              type="number"
              inputMode="numeric"
              min="1"
              max={max}
              step="1"
              value={quantity}
              disabled={saving}
              onChange={(e) => setQuantity(e.target.value)}
            />
            {max !== undefined && (
              <p className="text-xs text-muted-foreground">
                {tr("batches.ops.physical", { count: max })}
              </p>
            )}
          </div>
          <fieldset className="space-y-1" disabled={saving}>
            <legend className="text-sm font-medium">
              {tr("batches.ops.lossReason")}
            </legend>
            {(["expired", "damaged", "other"] as const).map((r) => (
              <label key={r} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="loss-reason"
                  checked={reason === r}
                  onChange={() => setReason(r)}
                />
                {tr(`batches.ops.reasons.${r}`)}
              </label>
            ))}
          </fieldset>
          <div className="space-y-1">
            <Label htmlFor="bl-comment">
              {tr(
                reason === "other"
                  ? "batches.ops.commentRequired"
                  : "batches.ops.commentOptional",
              )}
            </Label>
            <Input
              id="bl-comment"
              maxLength={200}
              value={comment}
              disabled={saving}
              onChange={(e) => setComment(e.target.value)}
            />
          </div>
          {closes && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              {tr("batches.ops.closesBatch")}
            </p>
          )}
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={confirmed}
              disabled={saving}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            {tr("batches.ops.lossConfirm")}
          </label>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button
            type="submit"
            variant="destructive"
            className="w-full"
            disabled={saving}
          >
            {tr("batches.ops.lossSubmit")}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Historique des pertes (détail du stock) et correction d'une perte saisie
 * par erreur : contre-mouvement lié, au plus les unités non encore
 * corrigées ; le lot garde son statut.
 */
export function BatchLossHistory({
  productId,
  canCorrect,
  online,
  refreshKey,
  onChanged,
}: {
  productId: string;
  canCorrect: boolean;
  online: boolean;
  refreshKey: unknown;
  onChanged: (result: ApiProductBatches) => void;
}) {
  const { t } = useT("catalog");
  const tr = t as unknown as (k: string, o?: object) => string;
  const format = useFormat();
  const [losses, setLosses] = useState<ApiStockLoss[] | null>(null);
  const [correcting, setCorrecting] = useState<ApiStockLoss | null>(null);
  useEffect(() => {
    fetchProductLosses(productId)
      .then(setLosses)
      .catch(() => setLosses([]));
  }, [productId, refreshKey]);
  if (!losses || losses.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium">{tr("batches.ops.historyTitle")}</p>
      <ul className="divide-y rounded-md border text-xs">
        {losses.map((l) => {
          const open = l.kind === "loss" ? l.quantity - l.correctedQuantity : 0;
          return (
            <li key={l._id} className="space-y-0.5 p-2">
              <p className="font-medium">
                {l.kind === "loss"
                  ? tr("batches.ops.historyLoss", {
                      reference: l.batchReference,
                      count: l.quantity,
                      reason: tr(`batches.ops.reasons.${l.reason ?? "other"}`),
                    })
                  : tr("batches.ops.historyCorrection", {
                      reference: l.batchReference,
                      count: l.quantity,
                    })}
              </p>
              <p className="text-muted-foreground">
                {format.dateWith(l.createdAt, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
                {typeof l.actorId === "object" ? ` · ${l.actorId.name}` : ""}
                {l.comment ? ` · ${l.comment}` : ""}
                {l.valueAtCost !== undefined
                  ? ` · ${tr("batches.ops.valueAtCost", { amount: format.fcfa(l.valueAtCost) })}`
                  : ""}
              </p>
              {l.kind === "loss" && l.correctedQuantity > 0 && (
                <p className="text-muted-foreground">
                  {tr("batches.ops.corrected", { count: l.correctedQuantity })}
                </p>
              )}
              {canCorrect && open > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!online}
                  onClick={() => setCorrecting(l)}
                >
                  {tr("batches.ops.correct")}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {correcting && (
        <CorrectLossDialog
          productId={productId}
          loss={correcting}
          onClose={() => setCorrecting(null)}
          onDone={(result) => {
            setCorrecting(null);
            onChanged(result);
          }}
        />
      )}
    </div>
  );
}

function CorrectLossDialog({
  productId,
  loss,
  onClose,
  onDone,
}: {
  productId: string;
  loss: ApiStockLoss;
  onClose: () => void;
  onDone: (result: ApiProductBatches) => void;
}) {
  const { t } = useT("catalog");
  const tr = t as unknown as (k: string, o?: object) => string;
  const open = loss.quantity - loss.correctedQuantity;
  const [quantity, setQuantity] = useState(String(open));
  const [comment, setComment] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const operationKey = useOperationKey();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = /^\d+$/.test(quantity.trim()) ? Number(quantity) : 0;
    if (q < 1 || q > open) {
      setError(tr("batches.ops.errors.correctionExceeds"));
      return;
    }
    if (comment.trim().length < 3) {
      setError(tr("batches.ops.errors.reason"));
      return;
    }
    if (!confirmed) {
      setError(tr("batches.ops.errors.confirm"));
      return;
    }
    const body = { quantity: q, comment: comment.trim() };
    setSaving(true);
    setError(null);
    try {
      onDone(
        await correctBatchLoss(productId, loss._id, {
          clientOperationId: operationKey(body),
          ...body,
        }),
      );
    } catch (err) {
      setError(describe(err, tr));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open onOpenChange={(v) => !v && !saving && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {tr("batches.ops.correctTitle", { reference: loss.batchReference })}
          </DialogTitle>
          <DialogDescription>
            {tr("batches.ops.correctText", { count: open })}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3" noValidate>
          <div className="space-y-1">
            <Label htmlFor="cl-qty">{tr("batches.ops.correctQuantity")}</Label>
            <Input
              id="cl-qty"
              type="number"
              inputMode="numeric"
              min="1"
              max={open}
              step="1"
              value={quantity}
              disabled={saving}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="cl-comment">
              {tr("batches.ops.correctComment")}
            </Label>
            <Input
              id="cl-comment"
              maxLength={200}
              value={comment}
              disabled={saving}
              onChange={(e) => setComment(e.target.value)}
            />
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={confirmed}
              disabled={saving}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            {tr("batches.ops.correctConfirm")}
          </label>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={saving}>
            {tr("batches.ops.correctSubmit")}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
