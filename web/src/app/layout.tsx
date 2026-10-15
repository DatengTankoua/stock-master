import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { AuthProvider } from "@/contexts/auth-context";
import { PwaRegister } from "@/components/layout/pwa-register";
import { OfflineCopyNotice } from "@/components/layout/offline-copy-notice";
import { PushNavigationBridge } from "@/components/layout/push-navigation-bridge";
import { ThemeSync } from "@/components/theme/use-theme";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import { LocaleProvider } from "@/i18n/locale-provider";
import { getRequestLocale, getServerT } from "@/i18n/server";
import { SITE } from "@/lib/legal/site-identity";
import { CANONICAL_ORIGIN } from "@/lib/seo/public-routes";
import { shareImage } from "@/lib/seo/metadata";
import { EnglishVersionHint } from "@/components/i18n/english-version-hint";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// 1-16G : description dans la langue de la requête.
// Référencement : `metadataBase` résout les URL relatives (canonical,
// hreflang, images de partage) sur l'origine canonique. Les pages publiques
// définissent leurs propres métadonnées (`lib/seo/metadata.ts`) ; celles-ci
// valent pour les autres pages (connexion, application…), non indexées.
export async function generateMetadata(): Promise<Metadata> {
  const { t, lng } = await getServerT("common");
  const description = t("meta.appDescription");
  const image = shareImage(lng, t("meta.shareImageAlt"));
  return {
    metadataBase: new URL(CANONICAL_ORIGIN),
    title: "Stock Master",
    description,
    applicationName: "Stock Master",
    appleWebApp: {
      capable: true,
      title: "Stock Master",
      statusBarStyle: "default",
    },
    // Icônes officielles Stock Master (1-11A) — générées depuis
    // stock-master-icon.png, jamais l'ancien visuel RoyalVibe.
    icons: {
      icon: [
        { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
        { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      ],
      apple: [
        {
          url: "/icons/apple-touch-icon.png",
          sizes: "180x180",
          type: "image/png",
        },
      ],
    },
    openGraph: {
      type: "website",
      siteName: SITE.name,
      title: "Stock Master",
      description,
      images: [image],
    },
    twitter: {
      card: "summary_large_image",
      title: "Stock Master",
      description,
      images: [image],
    },
    // Balises de vérification Search Console / Bing Webmaster Tools :
    // jetons fournis par les comptes propriétaires, jamais inventés.
    // Absentes tant que la variable n'est pas définie (la vérification DNS
    // du domaine reste la méthode recommandée).
    verification: siteVerification(),
  };
}

function siteVerification(): Metadata["verification"] {
  const google = process.env.GOOGLE_SITE_VERIFICATION?.trim();
  const bing = process.env.BING_SITE_VERIFICATION?.trim();
  if (!google && !bing) return undefined;
  return {
    ...(google ? { google } : {}),
    ...(bing ? { other: { "msvalidate.01": bing } } : {}),
  };
}

export const viewport: Viewport = {
  themeColor: "#062B5C",
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // 1-16G : langue de CETTE requête (proxy : cookie, sinon navigateur,
  // sinon français). `lang` est corrigé côté client lors d'un changement.
  const locale = await getRequestLocale();
  // 1-22F : nonce de la CSP de cette requête (posé par le proxy).
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html
      lang={locale}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        {/* 1-16F : thème posé avant le premier rendu (aucun flash) ; la
            classe/le style ajoutés sur <html> sont couverts par
            suppressHydrationWarning. Script statique, sans donnée. */}
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }}
        />
      </head>
      <body className="min-h-full flex flex-col">
        <LocaleProvider initialLocale={locale}>
          <AuthProvider>
            {/* 1-22C.1 : copie enregistrée servie hors connexion. */}
            <OfflineCopyNotice />
            <EnglishVersionHint />
            <main className="flex-1 flex flex-col">{children}</main>
            <Toaster />
          </AuthProvider>
          <PwaRegister />
          <PushNavigationBridge />
          <ThemeSync />
        </LocaleProvider>
      </body>
    </html>
  );
}
