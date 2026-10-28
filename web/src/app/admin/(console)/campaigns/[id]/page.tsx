"use client";

import { useParams } from "next/navigation";
import { CampaignDetail } from "@/components/admin/campaigns";

export default function AdminCampaignPage() {
  const { id } = useParams<{ id: string }>();
  return <CampaignDetail id={id} />;
}
