"use client";

import { useSyncExternalStore } from "react";
import { HistoryIcon } from "lucide-react";
import { useT } from "next-i18next/client";
import { useFormat } from "@/i18n/use-format";
import { useOnlineStatus } from "@/hooks/use-online-status";

// 1-22C.1 — Page publique servie depuis la copie enregistrée par le service
// worker (`<html data-offline-copy="<date>">`, posé UNIQUEMENT par
// public/sw.js quand le réseau a échoué) : la date d'enregistrement est
// indiquée, aucune information n'est présentée comme actuelle.
function readOfflineCopy(): string | null {
  return document.documentElement.dataset.offlineCopy ?? null;
}

const noSubscription = () => () => {};

export function OfflineCopyNotice() {
  const { t } = useT("common");
  const { dateTime } = useFormat();
  const online = useOnlineStatus();
  const savedAt = useSyncExternalStore(
    noSubscription,
    readOfflineCopy,
    () => null,
  );
  if (savedAt === null) return null;
  const date = Number.isFinite(Date.parse(savedAt)) ? dateTime(savedAt) : null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b bg-muted px-4 py-2 text-center text-xs text-muted-foreground"
    >
      <HistoryIcon className="size-4 shrink-0" aria-hidden />
      <p>
        {date && <>{t("offlineCopy.savedAt", { date })} </>}
        {t("offlineCopy.text")}
      </p>
      {online && (
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="font-medium underline underline-offset-4"
        >
          {t("offlineCopy.refresh")}
        </button>
      )}
    </div>
  );
}
