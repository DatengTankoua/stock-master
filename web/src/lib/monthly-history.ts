import axios from "axios";
import type { TFunction } from "i18next";
import { currentLocale } from "@/i18n/client-t";
import { apiClient, isCommercialRefusalCode } from "@/lib/api";
import type { ApiAuthContext } from "@/lib/api";

// 1-16D — historique mensuel exportable (Excel, PDF), généré par l'API.
// Les contrôles d'accès sont faits côté serveur à chaque requête ; ce
// module ne fait que masquer l'interface quand elle serait refusée.

export type MonthlyHistoryFormat = "xlsx" | "pdf";

export interface MonthlyHistoryMonths {
  timeZone: string;
  currentMonth: string;
  filenamePrefix: string;
  months: Array<{ month: string; salesCount: number }>;
  /** 1-22E : lignes admises par export (absent d'une API antérieure). */
  maxRows?: Record<MonthlyHistoryFormat, number>;
}

/**
 * 1-22E — format refusé d'avance pour ce nombre de ventes. Indication
 * seulement : le serveur compte aussi corrections et annulations, et
 * reste seul juge (422 `REPORT_TOO_LARGE`).
 */
export function exceedsMonthlyHistoryLimit(
  months: MonthlyHistoryMonths,
  salesCount: number,
  format: MonthlyHistoryFormat,
): boolean {
  const max = months.maxRows?.[format];
  return max !== undefined && salesCount > max;
}

/** Même règle que le serveur : propriétaire ou administrateur, avec les droits. */
export function canDownloadMonthlyHistory(
  context: ApiAuthContext | null,
): boolean {
  if (!context) return false;
  if (context.role !== "owner" && context.role !== "admin") return false;
  const effective = new Set(context.effectivePermissions ?? []);
  return effective.has("analytics.read") && effective.has("sales.view_all");
}

export async function fetchMonthlyHistoryMonths(): Promise<MonthlyHistoryMonths> {
  const { data } =
    await apiClient.get<MonthlyHistoryMonths>("/reports/monthly");
  return data;
}

/** Télécharge le fichier et le propose à l'enregistrement. */
export async function downloadMonthlyHistory(
  month: string,
  format: MonthlyHistoryFormat,
  filenamePrefix: string,
): Promise<void> {
  // 1-16G : libellés du fichier dans la langue de l'interface (mêmes
  // ventes, mêmes chiffres, mêmes noms ; devise et fuseau inchangés).
  const { data } = await apiClient.get<Blob>(
    `/reports/monthly/${month}/${format}`,
    { responseType: "blob", params: { lang: currentLocale() } },
  );
  const url = URL.createObjectURL(data);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${filenamePrefix}-${month}.${format}`;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Délai : certains navigateurs mobiles lisent l'URL après le clic.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

type AnalyticsT = TFunction<"analytics">;
/** Clé traduite au rendu, ou message déjà traduit par l'API. */
export type MonthlyHistoryMessage = string | ((t: AnalyticsT) => string);

/**
 * Message compréhensible pour un échec (le corps d'erreur est un Blob).
 * 1-16G : traduit dans la langue courante ; un message propre au serveur
 * (caractères PDF, limitation) arrive déjà dans la langue de la requête.
 */
export async function describeMonthlyHistoryError(
  error: unknown,
): Promise<MonthlyHistoryMessage> {
  return (await describeMonthlyHistoryFailure(error)).message;
}

/** Échec décrit, et s'il faut proposer l'assistance (1-22E). */
export async function describeMonthlyHistoryFailure(
  error: unknown,
): Promise<{ message: MonthlyHistoryMessage; suggestSupport: boolean }> {
  const message = await describeFailure(error);
  return {
    message: typeof message === "object" ? message.message : message,
    suggestSupport: typeof message === "object",
  };
}

/** Un objet `{ message }` signale qu'il faut proposer l'assistance. */
async function describeFailure(
  error: unknown,
): Promise<MonthlyHistoryMessage | { message: MonthlyHistoryMessage }> {
  if (!axios.isAxiosError(error)) {
    return (t) => t("monthly.errors.generic");
  }
  if (!error.response) {
    return (t) => t("monthly.errors.network");
  }
  let code: unknown;
  let serverMessage: unknown;
  let parsed: Record<string, unknown> | null = null;
  const body = error.response.data as unknown;
  try {
    parsed = body instanceof Blob ? JSON.parse(await body.text()) : body;
    code = parsed?.code;
    serverMessage = parsed?.message;
  } catch {
    code = undefined;
  }
  const status = error.response.status;
  if (isCommercialRefusalCode(code)) {
    return (t) => t("monthly.errors.subscription");
  }
  if (status === 403) {
    return (t) => t("monthly.errors.forbidden");
  }
  if (code === "REPORT_MONTH_INVALID") {
    return (t) => t("monthly.errors.monthInvalid");
  }
  // 1-16D : PDF refusé plutôt qu'altéré ; le message du serveur cite les
  // caractères concernés et propose l'Excel, qui les conserve exactement.
  if (code === "REPORT_PDF_UNSUPPORTED_CHARACTERS") {
    return typeof serverMessage === "string"
      ? serverMessage
      : (t) => t("monthly.errors.pdfCharacters");
  }
  // 1-22E : quota des demandes (comptage compris) ou des générations.
  if (code === "REPORT_RATE_LIMITED" || code === "REPORT_REQUESTS_LIMITED") {
    return typeof serverMessage === "string"
      ? serverMessage
      : (t) => t("monthly.errors.rateLimited");
  }
  // 1-22E : mois trop volumineux pour ce format ; aucun fichier créé.
  // Action réelle : l'Excel si seul le PDF dépasse, sinon l'assistance.
  if (code === "REPORT_TOO_LARGE") {
    const rows = Number(parsed?.rows);
    const max = Number(parsed?.maxRows);
    const format = parsed?.format === "pdf" ? "PDF" : "Excel";
    const n = (value: number) =>
      new Intl.NumberFormat(currentLocale()).format(value);
    if (!Number.isFinite(rows) || !Number.isFinite(max)) {
      return { message: (t) => t("monthly.errors.tooLargeGeneric") };
    }
    if (parsed?.alternative === "xlsx") {
      return (t) =>
        t("monthly.errors.tooLargePdf", { rows: n(rows), max: n(max) });
    }
    return {
      message: (t) =>
        t("monthly.errors.tooLarge", { rows: n(rows), max: n(max), format }),
    };
  }
  if (code === "REPORT_GENERATION_BUSY") {
    return (t) => t("monthly.errors.busy");
  }
  if (code === "REPORT_DATA_CHANGED") {
    return (t) => t("monthly.errors.dataChanged");
  }
  if (status >= 500) {
    return (t) => t("monthly.errors.server");
  }
  return (t) => t("monthly.errors.generic");
}
