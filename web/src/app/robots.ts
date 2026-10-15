import type { MetadataRoute } from "next";
import { CANONICAL_ORIGIN } from "@/lib/seo/public-routes";

// Référencement — exploration autorisée partout, y compris les ressources
// de rendu (/_next, images, polices). Les espaces privés et pages
// techniques ne sont pas bloqués ici : ils portent `X-Robots-Tag: noindex`
// (next.config.ts), que les robots doivent pouvoir lire. robots.txt n'est
// jamais une protection : l'accès aux données reste contrôlé par l'API.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/" }],
    sitemap: `${CANONICAL_ORIGIN}/sitemap.xml`,
  };
}
