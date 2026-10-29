"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useT } from "next-i18next/client";
import { BellIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useFormat } from "@/i18n/use-format";
import {
  ADMIN_NOTIFICATIONS_CHANGED,
  adminBadgeLabel,
  adminNotificationHref,
  adminRequest,
  needsSignIn,
  signalAdminNotificationsChanged,
  type AdminNotification,
  type AdminNotificationPage,
} from "@/lib/admin/admin-api";
import { AdminError } from "@/components/admin/admin-ui";

// Notifications INTERNES de l'administration (événements de la plateforme),
// distinctes du centre de notifications des commerces. Textes composés ici
// depuis le type et des paramètres contrôlés par l'API (React échappe tout,
// aucun HTML). Ouvrir la cloche ne marque rien comme lu : seule l'ouverture
// d'une notification ou « Tout marquer comme lu ».

/** Actualisation du compteur, seulement quand l'onglet est visible. */
export const ADMIN_NOTIFICATIONS_POLL_MS = 60_000;
const RECENT = 5;

/**
 * Compteur des non lues : lu à l'ouverture, toutes les minutes tant que
 * l'onglet est visible, au retour sur l'onglet et après une lecture.
 * Arrêté au démontage (déconnexion), quand `active` passe à faux et dès
 * que la session n'est plus valable (retour à la connexion).
 */
export function useAdminUnreadCount(active: boolean) {
  const router = useRouter();
  const [count, setCount] = useState<number | null>(null);
  const stopped = useRef(false);
  const sequence = useRef(0);

  const refresh = useCallback(async () => {
    if (stopped.current || document.visibilityState !== "visible") return;
    const ticket = ++sequence.current;
    try {
      const { unread } = await adminRequest<{ unread: number }>(
        "GET",
        "notifications/unread-count",
      );
      if (!stopped.current && ticket === sequence.current) setCount(unread);
    } catch (error) {
      if (needsSignIn(error)) {
        stopped.current = true;
        router.replace("/admin/login?session=expired");
      }
      // Autre erreur : dernière valeur conservée, nouvel essai plus tard.
    }
  }, [router]);

  useEffect(() => {
    if (!active) return;
    stopped.current = false;
    void refresh();
    const timer = window.setInterval(
      () => void refresh(),
      ADMIN_NOTIFICATIONS_POLL_MS,
    );
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const onChanged = () => void refresh();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(ADMIN_NOTIFICATIONS_CHANGED, onChanged);
    return () => {
      stopped.current = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(ADMIN_NOTIFICATIONS_CHANGED, onChanged);
    };
  }, [active, refresh]);

  return { count, refresh };
}

/** Marque une notification comme lue (idempotent), puis signale le changement. */
export async function markAdminNotificationRead(id: string): Promise<void> {
  await adminRequest("POST", `notifications/${id}/read`);
  signalAdminNotificationsChanged();
}

function useNotificationText() {
  const { t } = useT("admin");
  const format = useFormat();
  return (n: AdminNotification): { title: string; summary: string } => {
    const p = n.params;
    const name = p.organizationName || t("notifications.unknownOrganization");
    const amount =
      typeof p.amount === "number"
        ? `${format.number(p.amount)} ${p.currency ?? ""}`.trim()
        : t("none");
    const title = t(`notifications.types.${n.type}.title`);
    switch (n.type) {
      case "organization_created":
        return {
          title,
          summary: t("notifications.types.organization_created.summary", {
            name,
          }),
        };
      case "payment_confirmed":
        return {
          title,
          summary: t("notifications.types.payment_confirmed.summary", {
            name,
            amount,
            duration: p.term
              ? t(`terms.${p.term as "monthly"}`, { defaultValue: t("none") })
              : t("none"),
          }),
        };
      case "payment_review":
        return {
          title,
          summary: t("notifications.types.payment_review.summary", {
            name,
            amount,
            reason: t(
              `notifications.incidents.${(p.incidentCode ?? "none") as "none"}`,
              { defaultValue: t("notifications.incidents.none") },
            ),
          }),
        };
      case "payment_confirmation_delayed":
        return {
          title,
          summary: t(
            p.transactionReference
              ? "notifications.types.payment_confirmation_delayed.summary"
              : p.incidentCode === "initiation_uncertain"
                ? "notifications.types.payment_confirmation_delayed.summaryCreationUnconfirmed"
                : "notifications.types.payment_confirmation_delayed.summaryNoTransaction",
            {
              name,
              amount,
              reference: p.reference || t("none"),
              transaction: p.transactionReference ?? "",
              since: p.startedAt ? format.dateTime(p.startedAt) : t("none"),
            },
          ),
        };
      case "support_request":
        return {
          title,
          summary: t("notifications.types.support_request.summary", {
            name,
            reference: p.reference ?? t("none"),
            category: t(
              `notifications.supportCategories.${(p.supportCategory ?? "other") as "other"}`,
              { defaultValue: t("notifications.supportCategories.other") },
            ),
          }),
        };
      case "campaign_audience_partial":
        return {
          title,
          summary: t("notifications.types.campaign_audience_partial.summary", {
            total: format.number(p.audienceTotal ?? 0),
          }),
        };
      case "campaign_completed": {
        const r = p.results ?? {
          accepted: 0,
          skipped: 0,
          failed: 0,
          uncertain: 0,
        };
        return {
          title,
          summary: t("notifications.types.campaign_completed.summary", {
            accepted: format.number(r.accepted),
            skipped: format.number(r.skipped),
            failed: format.number(r.failed),
            uncertain: format.number(r.uncertain),
          }),
        };
      }
    }
  };
}

/**
 * Une notification : distinction lu / non lu (pastille, graisse, texte
 * masqué pour les lecteurs d'écran), date, lien vers la cible ou
 * « Élément indisponible ». `onOpen` : avant la navigation (fermeture).
 */
export function AdminNotificationRow({
  notification: n,
  compact = false,
  onOpen,
  onChanged,
}: {
  notification: AdminNotification;
  compact?: boolean;
  onOpen?: () => void;
  onChanged?: () => void;
}) {
  const { t } = useT("admin");
  const format = useFormat();
  const text = useNotificationText()(n);
  const href = adminNotificationHref(n);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const markRead = async () => {
    if (n.read) return;
    setBusy(true);
    setFailed(false);
    try {
      await markAdminNotificationRead(n.id);
      onChanged?.();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      data-testid="admin-notification"
      data-read={n.read ? "true" : "false"}
      className={`flex gap-3 rounded-lg border p-3 text-sm ${
        n.read ? "border-border" : "border-primary/40 bg-muted/50"
      }`}
    >
      <span
        aria-hidden="true"
        className={`mt-1.5 size-2 shrink-0 rounded-full ${
          n.read ? "bg-transparent ring-1 ring-border" : "bg-red-600"
        }`}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className={n.read ? "" : "font-semibold"}>
          {text.title}
          <span className="sr-only">
            {" "}
            ·{" "}
            {n.read
              ? t("notifications.readMark")
              : t("notifications.unreadMark")}
          </span>
        </p>
        <p className="break-words text-muted-foreground">{text.summary}</p>
        <p className="text-xs text-muted-foreground">
          <time dateTime={n.createdAt}>{format.dateTime(n.createdAt)}</time>
        </p>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {href ? (
            <Link
              href={href}
              prefetch={false}
              onClick={() => {
                // Navigation interne : la lecture continue en arrière-plan.
                void markRead();
                onOpen?.();
              }}
              className="inline-flex min-h-8 items-center rounded-md px-2 font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
            >
              {t(`notifications.open.${n.target.kind}`)}
            </Link>
          ) : (
            <span className="text-xs text-muted-foreground italic">
              {t("notifications.unavailable")}
            </span>
          )}
          {!n.read && !compact && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void markRead()}
            >
              {t("notifications.markRead")}
            </Button>
          )}
          {!n.read && compact && !href && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void markRead()}
            >
              {t("notifications.markRead")}
            </Button>
          )}
        </div>
        {n.type === "support_request" && !compact && (
          <p className="text-xs text-muted-foreground">
            {t("notifications.supportMailbox")}
          </p>
        )}
        {n.type === "payment_confirmation_delayed" && !compact && (
          <p className="text-xs text-muted-foreground">
            {t("notifications.delayedProcedure")}
          </p>
        )}
        {failed && (
          <p role="alert" className="text-xs text-destructive">
            {t("notifications.markFailed")}
          </p>
        )}
      </div>
    </li>
  );
}

/** Tout marquer comme lu (borne serveur) ; `remaining` si plafond atteint. */
export function useMarkAllRead(onDone: () => void) {
  const [state, setState] = useState<{
    busy: boolean;
    error?: unknown;
    remaining?: boolean;
  }>({ busy: false });
  const run = async () => {
    setState({ busy: true });
    try {
      const result = await adminRequest<{ marked: number; remaining: boolean }>(
        "POST",
        "notifications/read-all",
      );
      setState({ busy: false, remaining: result.remaining });
      signalAdminNotificationsChanged();
      onDone();
    } catch (error) {
      setState({ busy: false, error });
    }
  };
  return { ...state, run };
}

/**
 * Cloche de la navigation commune : compteur borné (99+), fenêtre des
 * notifications récentes (composant de dialogue adapté au mobile : zone
 * visible, défilement interne, fermeture au clavier) et lien vers la page.
 */
export function AdminNotificationBell({ active }: { active: boolean }) {
  const { t } = useT("admin");
  const router = useRouter();
  const { count, refresh } = useAdminUnreadCount(active);
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<{
    items?: AdminNotification[];
    error?: unknown;
  } | null>(null);

  const load = useCallback(async () => {
    try {
      const page = await adminRequest<AdminNotificationPage>(
        "GET",
        "notifications?page=1",
      );
      setRecent({ items: page.items.slice(0, RECENT) });
    } catch (error) {
      if (needsSignIn(error)) {
        router.replace("/admin/login?session=expired");
        return;
      }
      setRecent({ error });
    }
  }, [router]);

  const markAll = useMarkAllRead(() => void load());

  const unread = count ?? 0;
  const label =
    unread === 0
      ? t("notifications.bell.none")
      : unread > 99
        ? t("notifications.bell.moreThan99")
        : t("notifications.bell.unread", { count: unread });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setRecent(null);
          void load();
          void refresh();
        }
      }}
    >
      <DialogTrigger
        aria-label={label}
        data-testid="admin-notification-bell"
        className="relative rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <BellIcon className="size-4" aria-hidden />
        {unread > 0 && (
          <span
            data-testid="admin-notification-badge"
            aria-hidden="true"
            className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-red-600 px-1 text-center text-[10px] leading-4 font-semibold text-white"
          >
            {adminBadgeLabel(unread)}
          </span>
        )}
      </DialogTrigger>
      <DialogContent layout="form">
        <DialogHeader>
          <DialogTitle>{t("notifications.recent")}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {!recent ? (
            <p role="status" className="text-sm text-muted-foreground">
              {t("loading")}
            </p>
          ) : recent.error ? (
            <AdminError error={recent.error} onRetry={() => void load()} />
          ) : recent.items!.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("notifications.empty")}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {recent.items!.map((n) => (
                <AdminNotificationRow
                  key={n.id}
                  notification={n}
                  compact
                  onOpen={() => setOpen(false)}
                  onChanged={() => void load()}
                />
              ))}
            </ul>
          )}
          {markAll.error !== undefined && <AdminError error={markAll.error} />}
        </DialogBody>
        <DialogFooter>
          {unread > 0 && (
            <Button
              variant="outline"
              disabled={markAll.busy}
              onClick={() => void markAll.run()}
            >
              {markAll.busy
                ? t("notifications.markingAll")
                : t("notifications.markAllRead")}
            </Button>
          )}
          <Link
            href="/admin/notifications"
            prefetch={false}
            onClick={() => setOpen(false)}
            className="inline-flex min-h-8 items-center justify-center rounded-lg px-3 text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          >
            {t("notifications.seeAll")}
          </Link>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
