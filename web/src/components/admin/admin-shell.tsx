"use client";

import { createContext, useContext, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useT } from "next-i18next/client";
import {
  BuildingIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  ReceiptIcon,
  ScrollTextIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { LanguageSwitcher } from "@/components/i18n/language-switcher";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import {
  adminRequest,
  endAdminSessionQuietly,
  needsSignIn,
  retryPendingAdminLogout,
  type AdminStatus,
} from "@/lib/admin/admin-api";
import { AdminError, AdminLoading } from "@/components/admin/admin-ui";

// Administration de la plateforme — cadre des pages connectées. Aucune
// donnée avant une session complète (mot de passe + second facteur) : le
// statut est relu à l'ouverture et à chaque changement de page.

const AdminStatusContext = createContext<{
  status: AdminStatus;
  refresh: () => void;
} | null>(null);

export function useAdminStatus() {
  const value = useContext(AdminStatusContext);
  if (!value) throw new Error("useAdminStatus hors de AdminShell");
  return value;
}

const NAV = [
  { href: "/admin", key: "overview", icon: LayoutDashboardIcon },
  { href: "/admin/organizations", key: "organizations", icon: BuildingIcon },
  { href: "/admin/payments", key: "payments", icon: ReceiptIcon },
  { href: "/admin/audit", key: "audit", icon: ScrollTextIcon },
  { href: "/admin/security", key: "security", icon: ShieldCheckIcon },
] as const;

export function AdminShell({ children }: { children: React.ReactNode }) {
  const { t } = useT("admin");
  const router = useRouter();
  const pathname = usePathname();
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<{
    key: string;
    status?: AdminStatus;
    error?: unknown;
  } | null>(null);
  const [leaving, setLeaving] = useState(false);
  const key = `${pathname}#${reload}`;

  useEffect(() => {
    let cancelled = false;
    // Déconnexion en attente : rejouée AVANT de lire la session (jamais de
    // console ouverte sur une session que l'utilisateur a voulu fermer).
    retryPendingAdminLogout()
      .then(() => adminRequest<AdminStatus>("GET", "auth/status"))
      .then(
        (status) => {
          if (cancelled) return;
          if (status.stage !== "ready") {
            router.replace("/admin/login");
            return;
          }
          setState({ key, status });
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
  }, [key, router]);

  const logout = async () => {
    setLeaving(true);
    await endAdminSessionQuietly();
    router.replace("/admin/login?session=out");
  };

  const status = state?.status;
  const isActive = (href: string) =>
    href === "/admin" ? pathname === "/admin" : pathname.startsWith(href);

  return (
    <div className="flex min-h-dvh flex-1 flex-col bg-background md:flex-row">
      <aside className="border-b border-border md:sticky md:top-0 md:flex md:h-dvh md:w-60 md:flex-col md:border-r md:border-b-0">
        <div className="flex items-center justify-between gap-2 px-4 py-3">
          <p className="text-sm font-semibold leading-tight">{t("brand")}</p>
          <div className="flex gap-1 md:hidden">
            <LanguageSwitcher />
            <ThemeToggle />
          </div>
        </div>
        <nav
          aria-label={t("nav.label")}
          className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:overflow-visible md:pb-0"
        >
          {NAV.map(({ href, key: navKey, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              aria-current={isActive(href) ? "page" : undefined}
              className="flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm whitespace-nowrap text-muted-foreground hover:bg-muted hover:text-foreground aria-[current=page]:bg-muted aria-[current=page]:font-medium aria-[current=page]:text-foreground"
            >
              <Icon className="size-4" aria-hidden />
              {t(`nav.${navKey}`)}
            </Link>
          ))}
        </nav>
        <div className="mt-auto hidden flex-col gap-2 border-t border-border p-3 md:flex">
          {status && (
            <p className="truncate text-xs text-muted-foreground">
              {status.user.email}
            </p>
          )}
          <div className="flex gap-1">
            <LanguageSwitcher />
            <ThemeToggle />
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={logout}
            disabled={leaving}
          >
            <LogOutIcon />
            {leaving ? t("nav.loggingOut") : t("nav.logout")}
          </Button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-4 md:px-8 md:py-6">
        {!state ? (
          <AdminLoading />
        ) : state.error ? (
          <AdminError
            error={state.error}
            onRetry={() => setReload((n) => n + 1)}
          />
        ) : status ? (
          <AdminStatusContext.Provider
            value={{ status, refresh: () => setReload((n) => n + 1) }}
          >
            {children}
          </AdminStatusContext.Provider>
        ) : null}
        <div className="mt-8 flex justify-end md:hidden">
          <Button
            variant="outline"
            size="sm"
            onClick={logout}
            disabled={leaving}
          >
            <LogOutIcon />
            {leaving ? t("nav.loggingOut") : t("nav.logout")}
          </Button>
        </div>
      </main>
    </div>
  );
}
