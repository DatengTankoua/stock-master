"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useT } from "next-i18next/client";
import { useFormat } from "@/i18n/use-format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  decideSaleRegularization,
  fetchSaleRegularizations,
  getApiErrorMessage,
  type ApiSaleRegularization,
} from "@/lib/api";

// Lot B — demandes de régularisation transmises par les vendeurs (ventes
// hors ligne saisies avant la péremption d'un lot, reçues après). Réservé
// aux responsables (`stock.adjust` + `sales.view_all`, revérifiés par
// l'API). Approuver crée la vente au nom du vendeur d'origine ; rejeter la
// conserve avec son motif. Rien n'est effacé.

const nameOf = (v: ApiSaleRegularization["sellerId"] | null) =>
  v && typeof v === "object" ? v.name : "—";

export function RegularizationRequestsCard({
  onDecided,
}: {
  onDecided?: () => void;
}) {
  const { t } = useT("sales");
  const format = useFormat();
  const [requests, setRequests] = useState<ApiSaleRegularization[] | null>(
    null,
  );
  const [deciding, setDeciding] = useState<{
    request: ApiSaleRegularization;
    decision: "approve" | "reject";
  } | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setRequests(await fetchSaleRegularizations({}));
    } catch {
      setRequests([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (!requests || requests.length === 0) return null;
  const pending = requests.filter((r) => r.status === "pending");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!deciding) return;
    if (reason.trim().length < 3) {
      setError(t("outbox.regularize.reasonTooShort"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await decideSaleRegularization(
        deciding.request._id,
        deciding.decision,
        reason.trim(),
      );
      toast.success(
        t(
          deciding.decision === "approve"
            ? "regularizations.approved"
            : "regularizations.rejectedDone",
        ),
      );
      setDeciding(null);
      setReason("");
      await load();
      onDecided?.();
    } catch (err) {
      setError(getApiErrorMessage(err));
      await load();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {t("regularizations.title", { count: pending.length })}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">
          {t("regularizations.intro")}
        </p>
        <ul className="divide-y rounded-md border">
          {requests.slice(0, 20).map((r) => (
            <li key={r._id} className="space-y-1 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold">{r.productName}</span>
                <Badge
                  variant={
                    r.status === "pending"
                      ? "secondary"
                      : r.status === "approved"
                        ? "default"
                        : "outline"
                  }
                >
                  {t(`regularizations.status.${r.status}`)}
                </Badge>
              </div>
              <p>
                {r.quantity} × {format.fcfa(r.salePrice)} ·{" "}
                {r.batchAllocations
                  .map((b) => `${b.reference} × ${b.quantity}`)
                  .join(", ")}
              </p>
              <dl className="grid grid-cols-1 gap-0.5 text-xs text-muted-foreground">
                <div>
                  <dt className="inline">{t("regularizations.seller")}</dt>{" "}
                  <dd className="inline text-foreground">
                    {nameOf(r.sellerId)}
                  </dd>
                </div>
                <div>
                  <dt className="inline">{t("regularizations.declared")}</dt>{" "}
                  <dd className="inline text-foreground">
                    {format.dateTime(r.declaredOccurredAt)}
                  </dd>
                </div>
                <div>
                  <dt className="inline">{t("regularizations.received")}</dt>{" "}
                  <dd className="inline text-foreground">
                    {format.dateTime(r.createdAt)}
                  </dd>
                </div>
                <div>
                  <dt className="inline">{t("regularizations.expired")}</dt>{" "}
                  <dd className="inline text-foreground">
                    {r.expiredReferences.join(", ")}
                  </dd>
                </div>
                {r.status !== "pending" && (
                  <div>
                    <dt className="inline">{t("regularizations.decision")}</dt>{" "}
                    <dd className="inline text-foreground">
                      {t("regularizations.decisionBy", {
                        name: nameOf(r.decidedBy),
                        date: r.decidedAt ? format.dateTime(r.decidedAt) : "—",
                        reason: r.decisionReason ?? "—",
                      })}
                    </dd>
                  </div>
                )}
              </dl>
              {r.status === "pending" && (
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button
                    size="sm"
                    onClick={() => {
                      setError(null);
                      setReason("");
                      setDeciding({ request: r, decision: "approve" });
                    }}
                  >
                    {t("regularizations.approve")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setError(null);
                      setReason("");
                      setDeciding({ request: r, decision: "reject" });
                    }}
                  >
                    {t("regularizations.reject")}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </CardContent>

      {deciding && (
        <Dialog open onOpenChange={(v) => !v && !saving && setDeciding(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {deciding.decision === "approve"
                  ? t("regularizations.approveTitle")
                  : t("regularizations.rejectTitle")}
              </DialogTitle>
              <DialogDescription>
                {deciding.decision === "approve"
                  ? t("regularizations.approveText", {
                      seller: nameOf(deciding.request.sellerId),
                      date: format.dateTime(
                        deciding.request.declaredOccurredAt,
                      ),
                    })
                  : t("regularizations.rejectText")}
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={submit} className="space-y-3" noValidate>
              <div className="space-y-1">
                <Label htmlFor="rg-reason">
                  {t("outbox.regularize.reason")}
                </Label>
                <Input
                  id="rg-reason"
                  maxLength={200}
                  value={reason}
                  disabled={saving}
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <Button
                type="submit"
                className="w-full"
                variant={
                  deciding.decision === "approve" ? "default" : "destructive"
                }
                disabled={saving}
              >
                {deciding.decision === "approve"
                  ? t("regularizations.approve")
                  : t("regularizations.reject")}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </Card>
  );
}
