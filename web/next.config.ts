import path from "node:path";
import type { NextConfig } from "next";
import { STATIC_SECURITY_HEADERS } from "./src/lib/security-headers";

// Standalone uniquement pour l'image Docker (DOCKER_BUILD=true, défini dans le
// stage de build de web/Dockerfile) ; les builds Vercel restent inchangés.
// La racine de traçage est celle du workspace pnpm (lockfile racine).
const isDockerBuild = process.env.DOCKER_BUILD === "true";

const NOINDEX_PATHS = [
  "/app",
  "/app/:path*",
  "/auth/:path*",
  "/access",
  "/offline",
];

const nextConfig: NextConfig = {
  ...(isDockerBuild
    ? {
        output: "standalone" as const,
        outputFileTracingRoot: path.join(__dirname, ".."),
      }
    : {}),
  // 1-13A : page de confirmation d'email (token en query string) — aucun
  // référent transmis, aucun stockage en cache.
  async headers() {
    return [
      // 1-22F : en-têtes fixes sur toutes les réponses (la CSP, à nonce,
      // est posée par proxy.ts). En PREMIER : une règle plus loin qui
      // redéfinit la même clé l'emporte (Referrer-Policy des liens à jeton).
      { source: "/:path*", headers: [...STATIC_SECURITY_HEADERS] },
      // Référencement : espaces privés et pages techniques jamais indexés.
      // Leur exploration n'est PAS bloquée dans robots.txt (un robot doit
      // pouvoir lire cette directive) ; l'accès reste contrôlé par
      // l'authentification, jamais par robots.txt.
      ...NOINDEX_PATHS.map((source) => ({
        source,
        headers: [{ key: "X-Robots-Tag", value: "noindex" }],
      })),
      {
        source: "/auth/verify-email",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
          { key: "X-Robots-Tag", value: "noindex" },
        ],
      },
      // 1-13B : lien de réinitialisation du mot de passe (même règle).
      {
        source: "/auth/reset-password",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
          { key: "X-Robots-Tag", value: "noindex" },
        ],
      },
    ];
  },
  images: {
    remotePatterns: [
      { protocol: "http", hostname: "localhost", port: "9000" },
      { protocol: "https", hostname: process.env.S3_HOSTNAME ?? "localhost" },
    ],
  },
};

export default nextConfig;
