"use client";

import { useEffect, useRef, useState } from "react";
import { useT } from "next-i18next/client";
import { Button } from "@/components/ui/button";
import {
  AdminEmpty,
  AdminError,
  AdminLoading,
  Pager,
  useAdminData,
} from "@/components/admin/admin-ui";
import {
  AdminNotificationRow,
  useMarkAllRead,
} from "@/components/admin/admin-notifications";
import {
  ADMIN_NOTIFICATIONS_CHANGED,
  type AdminNotificationFilter,
  type AdminNotificationPage,
} from "@/lib/admin/admin-api";

// Notifications internes de l'administration : liste paginée, filtres
// Toutes / Non lues, lecture individuelle ou globale. L'état de lecture est
// propre à l'administrateur connecté.
export default function AdminNotificationsPage() {
  const { t } = useT("admin");
  const [filter, setFilter] = useState<AdminNotificationFilter>("all");
  const [page, setPage] = useState(1);
  const query = `notifications?status=${filter}&page=${page}`;
  const current = useAdminData<AdminNotificationPage>(query);
  const { error, loading, retry } = current;
  // Relecture après une lecture : la liste affichée reste en place (pas de
  // clignotement, le focus clavier n'est pas perdu).
  const [shown, setShown] = useState<{
    query: string;
    data: AdminNotificationPage;
  } | null>(null);
  if (current.data && shown?.data !== current.data) {
    setShown({ query, data: current.data });
  }
  const data =
    current.data ?? (shown?.query === query ? shown.data : undefined);
  const markAll = useMarkAllRead(() => undefined);

  // Toute lecture (ligne, cloche, « tout marquer ») signale un changement :
  // liste relue.
  const retryRef = useRef(retry);
  useEffect(() => {
    retryRef.current = retry;
  });
  useEffect(() => {
    const onChanged = () => retryRef.current();
    window.addEventListener(ADMIN_NOTIFICATIONS_CHANGED, onChanged);
    return () =>
      window.removeEventListener(ADMIN_NOTIFICATIONS_CHANGED, onChanged);
  }, []);

  const choose = (next: AdminNotificationFilter) => {
    setFilter(next);
    setPage(1);
  };

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">{t("notifications.title")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("notifications.intro")}
        </p>
      </header>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          role="group"
          aria-label={t("notifications.filters.label")}
          className="flex gap-1"
        >
          {(["all", "unread"] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={filter === value ? "default" : "outline"}
              aria-pressed={filter === value}
              onClick={() => choose(value)}
            >
              {t(`notifications.filters.${value}`)}
              {value === "unread" && data && data.unread > 0
                ? ` (${data.unread > 99 ? "99+" : data.unread})`
                : ""}
            </Button>
          ))}
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={markAll.busy || !data || data.unread === 0}
          onClick={() => void markAll.run()}
        >
          {markAll.busy
            ? t("notifications.markingAll")
            : t("notifications.markAllRead")}
        </Button>
      </div>
      {markAll.error !== undefined && <AdminError error={markAll.error} />}
      {markAll.remaining && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("notifications.remaining")}
        </p>
      )}
      {loading && !data ? (
        <AdminLoading />
      ) : error ? (
        <AdminError error={error} onRetry={retry} />
      ) : data ? (
        data.items.length === 0 ? (
          <AdminEmpty>
            {filter === "unread"
              ? t("notifications.emptyUnread")
              : t("notifications.empty")}
          </AdminEmpty>
        ) : (
          <>
            <ul className="flex flex-col gap-2">
              {data.items.map((n) => (
                <AdminNotificationRow key={n.id} notification={n} />
              ))}
            </ul>
            <Pager
              page={data.page}
              pageSize={data.pageSize}
              total={data.total}
              onPage={setPage}
            />
          </>
        )
      ) : null}
    </div>
  );
}
