"use client";

import Link from "next/link";
import { useT } from "next-i18next/client";
import { ArrowLeftIcon } from "lucide-react";
import { CampaignEditor } from "@/components/admin/campaigns";

export default function AdminNewCampaignPage() {
  const { t } = useT("admin");
  return (
    <div className="flex flex-col gap-4">
      <Link
        href="/admin/campaigns"
        className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon className="size-4" aria-hidden />
        {t("campaigns.back")}
      </Link>
      <h1 className="text-xl font-semibold">{t("campaigns.create")}</h1>
      <CampaignEditor />
    </div>
  );
}
