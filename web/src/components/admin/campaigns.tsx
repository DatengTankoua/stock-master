"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useT } from "next-i18next/client";
import { toast } from "sonner";
import { ArrowLeftIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
import { useAdminStatus } from "@/components/admin/admin-shell";
import {
  AdminEmpty,
  AdminError,
  AdminLoading,
  AdminSection,
  Pager,
  useAdminData,
} from "@/components/admin/admin-ui";
import {
  AdminApiError,
  CAMPAIGN_BODY_MAX,
  CAMPAIGN_MAX_ORGANIZATIONS,
  CAMPAIGN_SUBJECT_MAX,
  adminRequest,
  type AdminCampaign,
  type AdminCampaignDelivery,
  type AdminCampaignPage,
  type AdminCampaignPreview,
  type AdminOrganizationRow,
  type AdminPage,
  type CampaignDeliveryStatus,
  type CampaignTargeting,
  type MessageArchiveFilter,
} from "@/lib/admin/admin-api";

// Campagnes promotionnelles : espace distinct des messages de service.
// Les capacités ne servent qu'à l'affichage ; l'API décide toujours.

const STATUS_VARIANT: Record<
  CampaignDeliveryStatus,
  "default" | "secondary" | "outline" | "destructive"
> = {
  pending: "outline",
  sending: "outline",
  accepted: "secondary",
  skipped: "outline",
  failed: "destructive",
  uncertain: "destructive",
};
const STATUSES = Object.keys(STATUS_VARIANT) as CampaignDeliveryStatus[];

const KNOWN_REASONS = [
  "no_consent",
  "address_changed",
  "email_unverified",
  "no_active_membership",
  "account_missing",
  "not_targeted",
  "campaign_missing",
  "retry_window_expired",
  "unsubscribe_key_changed",
  "paused",
  "timeout",
  "network",
  "internal_error",
  "unexpected",
  "email_not_configured",
] as const;
type ReasonKey = (typeof KNOWN_REASONS)[number];

function useCapabilities() {
  const { status } = useAdminStatus();
  const capabilities = new Set(status.capabilities ?? []);
  return {
    canManage: capabilities.has("platform.campaigns.manage"),
    canSend: capabilities.has("platform.campaigns.send"),
  };
}

function useReason() {
  const { t } = useT("admin");
  return (reason: string | null): string | null => {
    if (!reason) return null;
    const rejected = /^rejected(?:_(\d{3}))?$/.exec(reason);
    if (rejected) {
      return t("campaigns.reasons.rejected", { status: rejected[1] ?? "—" });
    }
    return (KNOWN_REASONS as readonly string[]).includes(reason)
      ? t(`campaigns.reasons.${reason as ReasonKey}`)
      : reason;
  };
}

// ─── Liste ──────────────────────────────────────────────────────────────────

export function CampaignList() {
  const { t } = useT("admin");
  const format = useFormat();
  const { canManage } = useCapabilities();
  const [filter, setFilter] = useState<MessageArchiveFilter>("active");
  const [page, setPage] = useState(1);
  const { data, error, loading, retry } = useAdminData<AdminCampaignPage>(
    `campaigns?page=${page}&archived=${filter}`,
  );
  const counts = data?.counts;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">{t("campaigns.title")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("campaigns.intro")}
          </p>
        </div>
        {canManage ? (
          <Link
            href="/admin/campaigns/new"
            className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground"
          >
            {t("campaigns.create")}
          </Link>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("campaigns.noManage")}
          </p>
        )}
      </div>
      <div
        role="group"
        aria-label={t("campaigns.filterLabel")}
        className="flex flex-wrap gap-2"
      >
        {(["active", "archived", "all"] as const).map((value) => (
          <Button
            key={value}
            size="sm"
            variant={filter === value ? "default" : "outline"}
            aria-pressed={filter === value}
            onClick={() => {
              setFilter(value);
              setPage(1);
            }}
          >
            {t(`campaigns.filters.${value}`, {
              count: counts
                ? value === "all"
                  ? counts.active + counts.archived
                  : counts[value]
                : 0,
            })}
          </Button>
        ))}
      </div>
      {loading && <AdminLoading />}
      {error !== undefined && <AdminError error={error} onRetry={retry} />}
      {data && data.items.length === 0 && (
        <AdminEmpty>{t("campaigns.empty")}</AdminEmpty>
      )}
      {data && data.items.length > 0 && (
        <ul className="flex flex-col gap-3">
          {data.items.map((c) => (
            <li key={c.id}>
              <Link
                href={`/admin/campaigns/${c.id}`}
                className="block rounded-lg border border-border p-3 text-sm hover:bg-muted"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 font-medium break-words">
                    {c.subject}
                  </span>
                  <Badge
                    variant={c.status === "draft" ? "outline" : "secondary"}
                  >
                    {t(`campaigns.status.${c.status}`)}
                  </Badge>
                  {c.archivedAt && (
                    <Badge variant="outline">
                      {t("campaigns.archivedBadge")}
                    </Badge>
                  )}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {targetingLabel(t, c.targeting)} ·{" "}
                  {c.launchedAt
                    ? t("campaigns.launched", {
                        date: format.dateTime(c.launchedAt),
                      })
                    : t("campaigns.created", {
                        date: format.dateTime(c.createdAt),
                      })}
                </span>
                {c.status === "launched" && (
                  <span className="mt-1 flex flex-wrap gap-2 text-xs">
                    {STATUSES.filter((s) => c.results[s] > 0).map((s) => (
                      <span key={s}>
                        {t(`campaigns.results.statuses.${s}`)} : {c.results[s]}
                      </span>
                    ))}
                  </span>
                )}
              </Link>
            </li>
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
  );
}

function targetingLabel(
  t: ReturnType<typeof useT<"admin">>["t"],
  targeting: CampaignTargeting,
) {
  return targeting.mode === "all"
    ? t("campaigns.targetingAll")
    : t("campaigns.targetingSelected", {
        count: targeting.organizationIds.length,
      });
}

// ─── Brouillon ──────────────────────────────────────────────────────────────

/** Création (`campaign` absent) ou modification d'un brouillon. */
export function CampaignEditor({
  campaign,
  onSaved,
}: {
  campaign?: AdminCampaign;
  onSaved?: (saved: AdminCampaign) => void;
}) {
  const { t } = useT("admin");
  const router = useRouter();
  const [subject, setSubject] = useState(campaign?.subject ?? "");
  const [body, setBody] = useState(campaign?.body ?? "");
  const [mode, setMode] = useState<"all" | "selected">(
    campaign?.targeting.mode ?? "all",
  );
  const [selected, setSelected] = useState<Array<{ id: string; name: string }>>(
    campaign?.organizations.map((o) => ({ id: o.id, name: o.name })) ?? [],
  );
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const search = useAdminData<AdminPage<AdminOrganizationRow>>(
    mode === "selected" && query.trim().length >= 2
      ? `organizations?q=${encodeURIComponent(query.trim())}`
      : null,
  );

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const content = {
      subject,
      body,
      targeting:
        mode === "all"
          ? { mode: "all" }
          : { mode: "selected", organizationIds: selected.map((o) => o.id) },
    };
    try {
      const saved = await adminRequest<AdminCampaign>(
        "POST",
        campaign ? `campaigns/${campaign.id}` : "campaigns",
        campaign ? { ...content, revision: campaign.revision } : content,
      );
      toast.success(t("campaigns.editor.saved"));
      if (campaign) onSaved?.(saved);
      else router.replace(`/admin/campaigns/${saved.id}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const valid =
    subject.trim().length > 0 &&
    subject.length <= CAMPAIGN_SUBJECT_MAX &&
    body.trim().length > 0 &&
    body.length <= CAMPAIGN_BODY_MAX &&
    (mode === "all" || selected.length > 0);

  return (
    <AdminSection
      title={campaign ? t("campaigns.status.draft") : t("campaigns.create")}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="campaign-subject">
            {t("campaigns.editor.subject")}
          </Label>
          <Input
            id="campaign-subject"
            value={subject}
            maxLength={CAMPAIGN_SUBJECT_MAX}
            onChange={(e) => setSubject(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {t("campaigns.editor.counter", {
              count: subject.length,
              max: CAMPAIGN_SUBJECT_MAX,
            })}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="campaign-body">{t("campaigns.editor.body")}</Label>
          <Textarea
            id="campaign-body"
            rows={10}
            value={body}
            maxLength={CAMPAIGN_BODY_MAX}
            onChange={(e) => setBody(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {t("campaigns.editor.counter", {
              count: body.length,
              max: CAMPAIGN_BODY_MAX,
            })}{" "}
            · {t("campaigns.editor.plainText")}
          </p>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">
            {t("campaigns.editor.targeting")}
          </legend>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="campaign-targeting"
              checked={mode === "all"}
              onChange={() => setMode("all")}
              className="mt-1 size-4 accent-primary"
            />
            <span>
              {t("campaigns.editor.all")}
              <span className="block text-xs text-muted-foreground">
                {t("campaigns.editor.allHint")}
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="campaign-targeting"
              checked={mode === "selected"}
              onChange={() => setMode("selected")}
              className="mt-1 size-4 accent-primary"
            />
            <span>{t("campaigns.editor.selected")}</span>
          </label>
          {mode === "selected" && (
            <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
              <Label htmlFor="campaign-org-search">
                {t("campaigns.editor.search")}
              </Label>
              <Input
                id="campaign-org-search"
                value={query}
                placeholder={t("campaigns.editor.searchPlaceholder")}
                onChange={(e) => setQuery(e.target.value)}
              />
              {search.data && search.data.items.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  {t("campaigns.editor.noResult")}
                </p>
              )}
              <ul className="flex flex-col gap-1">
                {search.data?.items
                  .filter((o) => !selected.some((s) => s.id === o.id))
                  .map((o) => (
                    <li
                      key={o.id}
                      className="flex items-center justify-between gap-2 text-sm"
                    >
                      <span className="min-w-0 break-words">{o.name}</span>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={selected.length >= CAMPAIGN_MAX_ORGANIZATIONS}
                        onClick={() =>
                          setSelected((s) => [...s, { id: o.id, name: o.name }])
                        }
                      >
                        {t("campaigns.editor.add")}
                      </Button>
                    </li>
                  ))}
              </ul>
              <p className="text-xs font-medium">
                {t("campaigns.editor.selection", { count: selected.length })}
              </p>
              <ul className="flex flex-col gap-1">
                {selected.map((o) => (
                  <li
                    key={o.id}
                    className="flex items-center justify-between gap-2 text-sm"
                  >
                    <span className="min-w-0 break-words">{o.name}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setSelected((s) => s.filter((x) => x.id !== o.id))
                      }
                    >
                      {t("campaigns.editor.remove")}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {t("campaigns.editor.noFreeAddress")}
          </p>
        </fieldset>
        {error !== null && <AdminError error={error} />}
        <div>
          <Button disabled={busy || !valid} onClick={() => void save()}>
            {busy ? t("campaigns.editor.saving") : t("campaigns.editor.save")}
          </Button>
        </div>
      </div>
    </AdminSection>
  );
}

// ─── Détail ─────────────────────────────────────────────────────────────────

export function CampaignDetail({ id }: { id: string }) {
  const { t } = useT("admin");
  const format = useFormat();
  const { canManage, canSend } = useCapabilities();
  const { data, error, loading, retry } = useAdminData<AdminCampaign>(
    `campaigns/${id}`,
  );
  const [launching, setLaunching] = useState(false);
  const [archiving, setArchiving] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <Link
        href="/admin/campaigns"
        className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon className="size-4" aria-hidden />
        {t("campaigns.back")}
      </Link>
      {loading && <AdminLoading />}
      {error !== undefined && <AdminError error={error} onRetry={retry} />}
      {data && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="min-w-0 text-xl font-semibold break-words">
              {data.subject}
            </h1>
            <Badge variant={data.status === "draft" ? "outline" : "secondary"}>
              {t(`campaigns.status.${data.status}`)}
            </Badge>
            {data.archivedAt && (
              <Badge variant="outline">{t("campaigns.archivedBadge")}</Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {targetingLabel(t, data.targeting)}
            {data.organizations.length > 0 &&
              ` : ${data.organizations.map((o) => o.name).join(", ")}`}
            {data.launchedAt &&
              ` · ${t("campaigns.launched", { date: format.dateTime(data.launchedAt) })}`}
          </p>
          {data.status === "draft" && canManage ? (
            <CampaignEditor
              key={data.revision}
              campaign={data}
              onSaved={retry}
            />
          ) : data.status === "launched" ? (
            <p className="text-sm text-muted-foreground">
              {t("campaigns.editor.locked")}
            </p>
          ) : null}
          <CampaignPreview key={data.revision} id={id} />
          {data.status === "draft" && <CampaignEstimate id={id} />}
          {data.status === "draft" &&
            (canSend ? (
              <div>
                <Button onClick={() => setLaunching(true)}>
                  {t("campaigns.launch.open")}
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("campaigns.launch.noCapability")}
              </p>
            ))}
          {data.status === "launched" && (
            <CampaignResults campaign={data} onRefresh={retry} />
          )}
          {canManage && (
            <div>
              <Button variant="outline" onClick={() => setArchiving(true)}>
                {data.archivedAt
                  ? t("campaigns.archive.restore")
                  : t("campaigns.archive.archive")}
              </Button>
            </div>
          )}
          {launching && (
            <LaunchDialog
              campaign={data}
              onClose={(changed) => {
                setLaunching(false);
                if (changed) retry();
              }}
            />
          )}
          {archiving && (
            <ArchiveDialog
              campaign={data}
              onClose={(changed) => {
                setArchiving(false);
                if (changed) retry();
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

function CampaignPreview({ id }: { id: string }) {
  const { t } = useT("admin");
  const [locale, setLocale] = useState<"fr" | "en">("fr");
  const { data, error, loading, retry } = useAdminData<AdminCampaignPreview>(
    `campaigns/${id}/preview?locale=${locale}`,
  );
  return (
    <AdminSection title={t("campaigns.preview.title")}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>{t("campaigns.preview.locale")}</span>
          {(["fr", "en"] as const).map((l) => (
            <Button
              key={l}
              size="sm"
              variant={locale === l ? "default" : "outline"}
              aria-pressed={locale === l}
              onClick={() => setLocale(l)}
            >
              {l.toUpperCase()}
            </Button>
          ))}
        </div>
        {loading && <AdminLoading />}
        {error !== undefined && <AdminError error={error} onRetry={retry} />}
        {data && (
          <div className="rounded-lg border border-border p-3 text-sm">
            <p className="text-xs text-muted-foreground">
              {t("campaigns.preview.subject")}
            </p>
            <p className="mb-3 font-medium break-words">{data.subject}</p>
            {/* Version texte exacte de l'e-mail (le HTML en est l'équivalent échappé). */}
            <p className="whitespace-pre-wrap break-words">{data.text}</p>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          {t("campaigns.preview.linkNote")}
        </p>
      </div>
    </AdminSection>
  );
}

function CampaignEstimate({ id }: { id: string }) {
  const { t } = useT("admin");
  const format = useFormat();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    estimated: number;
    at: string;
  } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await adminRequest("GET", `campaigns/${id}/estimate`));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AdminSection title={t("campaigns.estimate.title")}>
      <div className="flex flex-col gap-2 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void run()}
          >
            {busy
              ? t("campaigns.estimate.running")
              : t("campaigns.estimate.run")}
          </Button>
          {result && (
            <span className="font-medium">
              {t("campaigns.estimate.result", {
                count: result.estimated,
                time: format.dateTime(result.at),
              })}
            </span>
          )}
        </div>
        {error !== null && <AdminError error={error} />}
        <p className="text-xs text-muted-foreground">
          {t("campaigns.estimate.notAuthorization")}
        </p>
      </div>
    </AdminSection>
  );
}

function CampaignResults({
  campaign,
  onRefresh,
}: {
  campaign: AdminCampaign;
  onRefresh: () => void;
}) {
  const { t } = useT("admin");
  const format = useFormat();
  const reason = useReason();
  const [page, setPage] = useState(1);
  const { data, error, loading, retry } = useAdminData<
    AdminPage<AdminCampaignDelivery>
  >(`campaigns/${campaign.id}/results?page=${page}`);
  return (
    <AdminSection title={t("campaigns.results.title")}>
      <div className="flex flex-col gap-3 text-sm">
        <p>
          {campaign.audience.status === "ready"
            ? t("campaigns.results.audience", {
                count: campaign.audience.total,
              })
            : t("campaigns.results.preparing")}
        </p>
        {campaign.audience.status === "ready" &&
          campaign.audience.incomplete && (
            <p className="text-xs text-muted-foreground">
              {t("campaigns.results.incomplete")}
            </p>
          )}
        <ul className="flex flex-wrap gap-2">
          {STATUSES.map((s) => (
            <li key={s} className="flex items-center gap-1">
              <Badge variant={STATUS_VARIANT[s]}>
                {t(`campaigns.results.statuses.${s}`)}
              </Badge>
              <span>{campaign.results[s]}</span>
            </li>
          ))}
        </ul>
        {!campaign.sending.enabled && (
          <p className="text-xs text-muted-foreground">
            {t("campaigns.launch.switchOff")}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {t("campaigns.results.notice")}
        </p>
        <div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              retry();
              onRefresh();
            }}
          >
            {t("campaigns.results.refresh")}
          </Button>
        </div>
        {loading && <AdminLoading />}
        {error !== undefined && <AdminError error={error} onRetry={retry} />}
        {data && data.items.length === 0 && (
          <AdminEmpty>{t("campaigns.results.empty")}</AdminEmpty>
        )}
        {data && data.items.length > 0 && (
          <ul className="flex flex-col divide-y divide-border">
            {data.items.map((d) => {
              const why = reason(d.reason);
              return (
                <li
                  key={d.id}
                  className="flex flex-wrap items-center gap-2 py-2 text-xs"
                >
                  <Badge variant={STATUS_VARIANT[d.status]}>
                    {t(`campaigns.results.statuses.${d.status}`)}
                  </Badge>
                  {why && (
                    <span className="text-muted-foreground">({why})</span>
                  )}
                  <span className="text-muted-foreground">
                    {t("campaigns.results.attempts", { count: d.attempts })} ·{" "}
                    {format.dateTime(d.updatedAt)}
                  </span>
                </li>
              );
            })}
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
    </AdminSection>
  );
}

/** Lancement : contenu et ciblage exacts, puis preuve renforcée liée. */
function LaunchDialog({
  campaign,
  onClose,
}: {
  campaign: AdminCampaign;
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
  const [outcome, setOutcome] = useState<{ replayed: boolean } | null>(null);
  // Une tentative a eu lieu : la fiche est rechargée à la fermeture (la
  // campagne a pu être lancée même si la réponse s'est perdue).
  const [attempted, setAttempted] = useState(false);
  const content = {
    revision: campaign.revision,
    subject: campaign.subject,
    body: campaign.body,
    targeting: campaign.targeting,
  };

  const submit = async () => {
    if (busy) return;
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
              action: "campaign_launch",
              campaignId: campaign.id,
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
      setAttempted(true);
      setOutcome(
        await adminRequest<{ replayed: boolean }>(
          "POST",
          `campaigns/${campaign.id}/launch`,
          { operationId, stepUpToken: token, ...content },
        ),
      );
    } catch (err) {
      // Réponse perdue (réseau, ou BFF sans réponse de l'API à temps) : le
      // lancement a pu aboutir. Même identifiant d'opération au nouvel
      // essai : résultat existant, jamais une seconde campagne.
      if (
        err instanceof AdminApiError &&
        (err.code === "NETWORK" ||
          err.code === "PLATFORM_ADMIN_UNAVAILABLE" ||
          err.status === 504)
      ) {
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
    <Dialog
      open
      onOpenChange={(next) =>
        !next && !busy && onClose(outcome !== null || attempted)
      }
    >
      <DialogContent layout="form">
        <DialogHeader>
          <DialogTitle>{t("campaigns.launch.title")}</DialogTitle>
          <DialogDescription>{t("campaigns.launch.review")}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {outcome ? (
            <section role="status" className="flex flex-col gap-2 text-sm">
              <p className="font-medium">{t("campaigns.launch.done")}</p>
              {outcome.replayed && (
                <p className="text-muted-foreground">
                  {t("campaigns.launch.replayed")}
                </p>
              )}
            </section>
          ) : (
            <>
              <div className="rounded-lg border border-border p-3 text-sm">
                <p className="font-medium break-words">{campaign.subject}</p>
                <p className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words">
                  {campaign.body}
                </p>
              </div>
              <p className="text-sm">
                {targetingLabel(t, campaign.targeting)}
                {campaign.organizations.length > 0 &&
                  ` : ${campaign.organizations.map((o) => o.name).join(", ")}`}
              </p>
              <CampaignEstimate id={campaign.id} />
              <p className="text-xs text-muted-foreground">
                {t("campaigns.launch.recheck")}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("campaigns.launch.frozen")}
              </p>
              {!campaign.sending.enabled && (
                <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
                  {t("campaigns.launch.switchOff")}
                </p>
              )}
              {!campaign.sending.configured && (
                <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
                  {t("campaigns.launch.notConfigured")}
                </p>
              )}
              {!stepUpToken && (
                <section className="flex flex-col gap-3">
                  <p className="text-sm text-muted-foreground">
                    {t("actions.stepUp")}
                  </p>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="launch-password">
                      {t("actions.password")}
                    </Label>
                    <Input
                      id="launch-password"
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="launch-factor">{t("actions.code")}</Label>
                    <Input
                      id="launch-factor"
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
                  {t("campaigns.launch.networkLost")}
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
                onClick={() => onClose(attempted)}
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
                  ? t("campaigns.launch.sending")
                  : networkLost
                    ? t("actions.retry")
                    : t("campaigns.launch.confirm")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ArchiveDialog({
  campaign,
  onClose,
}: {
  campaign: AdminCampaign;
  onClose: (changed: boolean) => void;
}) {
  const { t } = useT("admin");
  const archive = !campaign.archivedAt;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await adminRequest(
        "POST",
        `campaigns/${campaign.id}/${archive ? "archive" : "restore"}`,
      );
      toast.success(
        archive ? t("campaigns.archive.done") : t("campaigns.archive.restored"),
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
            {archive
              ? t("campaigns.archive.archiveTitle")
              : t("campaigns.archive.restoreTitle")}
          </DialogTitle>
          <DialogDescription>
            {archive
              ? t("campaigns.archive.archiveText")
              : t("campaigns.archive.restoreText")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm font-medium break-words">{campaign.subject}</p>
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
            {archive
              ? t("campaigns.archive.archive")
              : t("campaigns.archive.restore")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
