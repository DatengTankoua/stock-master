"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "next-i18next/client";
import qrcode from "qrcode-generator";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  adminErrorKey,
  adminRequest,
  needsSignIn,
} from "@/lib/admin/admin-api";

// Administration de la plateforme — éléments partagés des pages /admin.

/** Lecture GET d'une ressource ; session expirée → retour à la connexion. */
export function useAdminData<T>(path: string | null) {
  const router = useRouter();
  const [reload, setReload] = useState(0);
  const key = path === null ? null : `${path}#${reload}`;
  const [state, setState] = useState<{
    key: string | null;
    data?: T;
    error?: unknown;
  }>({ key: null });
  useEffect(() => {
    if (path === null || key === null) return;
    let cancelled = false;
    adminRequest<T>("GET", path).then(
      (data) => {
        if (!cancelled) setState({ key, data });
      },
      (error: unknown) => {
        if (cancelled) return;
        if (needsSignIn(error)) {
          router.replace("/admin/login?session=expired");
          return;
        }
        setState({ key, error });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [path, key, router]);
  const current = state.key === key;
  return {
    data: current ? state.data : undefined,
    error: current ? state.error : undefined,
    loading: key !== null && !current,
    retry: () => setReload((n) => n + 1),
  };
}

export function AdminError({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  const { t } = useT("admin");
  const { key, seconds } = adminErrorKey(error);
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
    >
      <p>{t(key, { seconds })}</p>
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          {t("retry")}
        </Button>
      )}
    </div>
  );
}

export function AdminLoading() {
  const { t } = useT("admin");
  return (
    <p role="status" className="py-6 text-sm text-muted-foreground">
      {t("loading")}
    </p>
  );
}

export function AdminEmpty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

export function AdminSection({
  title,
  children,
  className = "",
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-xl bg-card p-4 text-card-foreground ring-1 ring-foreground/10 ${className}`}
    >
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function Pager({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const { t } = useT("admin");
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
      <span className="text-muted-foreground">
        {t("results", { count: total })} · {t("pageOf", { page, pages })}
      </span>
      <span className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          {t("previous")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={page >= pages || page >= 500}
          onClick={() => onPage(page + 1)}
        >
          {t("next")}
        </Button>
      </span>
    </nav>
  );
}

export const selectClass =
  "h-8 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground dark:bg-input/30";

/** QR code dessiné localement (aucun service externe, aucune image distante). */
export function TotpQrCode({ uri, label }: { uri: string; label: string }) {
  const qr = qrcode(0, "M");
  qr.addData(uri);
  qr.make();
  const count = qr.getModuleCount();
  const cells: string[] = [];
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) cells.push(`M${col + 4},${row + 4}h1v1h-1z`);
    }
  }
  const size = count + 8;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      className="size-52 rounded-lg bg-white"
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="#ffffff" />
      <path d={cells.join("")} fill="#000000" />
    </svg>
  );
}

/** Codes de récupération affichés une seule fois (jamais conservés ici). */
export function RecoveryCodes({
  codes,
  onDone,
}: {
  codes: string[];
  onDone: () => void;
}) {
  const { t } = useT("admin");
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">{t("recovery.title")}</h2>
      <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
        {t("recovery.warning")}
      </p>
      <ul className="grid grid-cols-1 gap-2 font-mono text-sm sm:grid-cols-2">
        {codes.map((code) => (
          <li
            key={code}
            className="rounded-md border border-border px-3 py-2 text-center tracking-wider"
          >
            {code}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(codes.join("\n"))
              .then(() => setCopied(true))
              .catch(() => undefined);
          }}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? t("recovery.copied") : t("recovery.copy")}
        </Button>
        <Button onClick={onDone}>{t("recovery.confirm")}</Button>
      </div>
    </div>
  );
}

/** Formulaire de premier code (enrôlement ou nouveau facteur). */
export function TotpProvisioningForm({
  uri,
  manualKey,
  busy,
  onSubmit,
}: {
  uri: string;
  manualKey: string;
  busy: boolean;
  onSubmit: (code: string) => void;
}) {
  const { t } = useT("admin");
  const [code, setCode] = useState("");
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (/^\d{6}$/.test(code)) onSubmit(code);
      }}
    >
      <p className="text-sm">{t("enroll.step1")}</p>
      <div className="flex justify-center">
        <TotpQrCode uri={uri} label={t("enroll.qrLabel")} />
      </div>
      <p className="text-sm text-muted-foreground">{t("enroll.manualKey")}</p>
      <code className="break-all rounded-md bg-muted px-3 py-2 text-center font-mono text-sm tracking-wider select-all">
        {manualKey}
      </code>
      <label className="text-sm" htmlFor="admin-first-code">
        {t("enroll.step2")}
      </label>
      <OtpInput id="admin-first-code" value={code} onChange={setCode} />
      <p className="text-xs text-muted-foreground">{t("enroll.expiresHint")}</p>
      <Button type="submit" disabled={busy || !/^\d{6}$/.test(code)}>
        {t("enroll.submit")}
      </Button>
    </form>
  );
}

export function OtpInput({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <input
      id={id}
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="\d{6}"
      maxLength={6}
      value={value}
      onChange={(event) => onChange(event.target.value.replace(/\D/g, ""))}
      className="h-10 w-full rounded-lg border border-input bg-background px-3 text-center font-mono text-lg tracking-[0.4em] text-foreground dark:bg-input/30"
    />
  );
}
