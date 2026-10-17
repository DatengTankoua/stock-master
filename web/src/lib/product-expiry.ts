// Date de péremption : date CIVILE `AAAA-MM-JJ` (aucune heure, aucun fuseau),
// stockée telle quelle par l'API. Jamais convertie en `Date` locale pour
// l'affichage : elle ne recule ni n'avance d'un jour selon l'appareil.

const CIVIL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Date civile du jour sur l'appareil (`AAAA-MM-JJ`). */
export function todayCivilDate(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Date dépassée : strictement antérieure au jour (le jour même ne l'est pas). */
export function isExpiryPast(
  expiryDate: string | null | undefined,
  today: string = todayCivilDate(),
): boolean {
  return typeof expiryDate === "string" && CIVIL_DATE.test(expiryDate)
    ? expiryDate < today
    : false;
}

/** Affichage localisé, calculé en UTC sur la date civile (aucun décalage). */
export function formatCivilDate(value: string, intlLocale: string): string {
  const match = CIVIL_DATE.exec(value);
  if (!match) return value;
  const [year, month, day] = match.slice(1).map(Number);
  return new Intl.DateTimeFormat(intlLocale, {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}
