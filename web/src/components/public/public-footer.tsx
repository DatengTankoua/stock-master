import Link from "next/link";
import { Wordmark } from "@/components/brand/wordmark";
import { LocaleLinks } from "@/components/i18n/locale-links";
import { LANDING_NAV } from "@/components/landing/landing-nav";
import { SocialLinks } from "@/components/contact/social-links";
import { WhatsAppIcon } from "@/components/contact/whatsapp-icon";
import { WhatsAppWidget } from "@/components/contact/whatsapp-widget";
import {
  HELP_PAGES,
  LEGAL_DOCUMENTS,
  PRACTICAL_GUIDES,
  SITE,
  WHATSAPP,
} from "@/lib/legal/site-identity";
import { localizedHref, localizedPath } from "@/lib/seo/public-routes";
import { getServerT } from "@/i18n/server";

// 1-16C — Pied de page commun à l'accueil et aux pages publiques. Les
// ancres de l'accueil sont préfixées par « / » hors de l'accueil. Le lien
// d'inscription suit le même flag d'affichage que le reste du site.
// Référencement : liens vers les pages publiques dans la langue affichée
// (`/en/...` en anglais) et liens réciproques vers la même page dans
// chaque langue (`path`), lisibles sans JavaScript.
// Contact WhatsApp : coordonnées (lien `wa.me`, lisible sans JavaScript) et
// bouton flottant monté ici, donc présent sur toutes les pages publiques.
// La dernière bande réserve en bas l'espace du bouton (rien n'est masqué).
const linkClass =
  "inline-flex min-h-11 items-center rounded-sm text-sm text-(--public-muted) hover:text-(--brand-ink) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand-ink)";

function Column({
  title,
  id,
  children,
}: {
  title: string;
  id: string;
  children: React.ReactNode;
}) {
  return (
    <nav aria-labelledby={id}>
      <h2 id={id} className="text-sm font-bold text-(--brand-ink)">
        {title}
      </h2>
      <ul className="mt-2 flex flex-col">{children}</ul>
    </nav>
  );
}

export async function PublicFooter({
  onHome = false,
  path,
}: {
  onHome?: boolean;
  /** Page affichée, sans préfixe de langue (liens vers ses versions FR/EN). */
  path?: string;
}) {
  const { t, lng } = await getServerT("public");
  const { t: tl } = await getServerT("legal");
  const registrationEnabled =
    process.env.NEXT_PUBLIC_REGISTRATION_ENABLED === "true";
  const home = localizedPath("/", lng);
  const anchor = (href: string) => (onHome ? href : `${home}${href}`);
  const href = (target: string) => localizedHref(target, lng);

  return (
    <>
      <footer className="border-t border-(--brand-ink)/10 bg-(--public-bg)">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:grid-cols-2 lg:grid-cols-[1.2fr_1fr_1fr_1.3fr]">
          <div>
            <Wordmark size="small" />
            <p className="mt-3 max-w-xs text-sm leading-relaxed text-(--public-muted)">
              {t("footer.tagline")}
            </p>
            <p className="mt-4 text-sm font-medium text-(--brand-ink)">
              {t("whatsapp.lead")}
            </p>
            <a
              href={WHATSAPP.url}
              target="_blank"
              rel="noopener noreferrer"
              className={`${linkClass} gap-2 font-medium text-(--brand-ink)`}
            >
              <WhatsAppIcon className="size-4 shrink-0" />
              <span translate="no">
                {t("whatsapp.linkLabel", { number: WHATSAPP.display })}
              </span>
            </a>
            <SocialLinks
              headingId="pied-reseaux"
              className="mt-4"
              headingClassName="text-sm font-bold text-(--brand-ink)"
              linkClassName="text-(--public-muted) hover:text-(--brand-ink)"
            />
          </div>
          <Column title="Stock Master" id="pied-produit">
            {LANDING_NAV.map((item) => (
              <li key={item.href}>
                <a href={anchor(item.href)} className={linkClass}>
                  {t(`nav.${item.key}`)}
                </a>
              </li>
            ))}
          </Column>
          <Column title={t("footer.help")} id="pied-aide">
            {[...HELP_PAGES, ...PRACTICAL_GUIDES].map((page) => (
              <li key={page.href}>
                <Link href={href(page.href)} className={linkClass}>
                  {t(`footer.pages.${page.key}`)}
                </Link>
              </li>
            ))}
            <li>
              <Link href="/auth/login" className={linkClass}>
                {t("footer.login")}
              </Link>
            </li>
            {registrationEnabled && (
              <li>
                <Link href="/auth/register" className={linkClass}>
                  {t("footer.register")}
                </Link>
              </li>
            )}
          </Column>
          <Column title={t("footer.legal")} id="pied-legal">
            {LEGAL_DOCUMENTS.map((doc) => (
              <li key={doc.href}>
                <Link href={href(doc.href)} className={linkClass}>
                  {tl(`documents.${doc.id}.short`)}
                </Link>
              </li>
            ))}
          </Column>
        </div>
        {/* 1-21D : mention commune à toutes les pages publiques (FR/EN). */}
        <div className="border-t border-(--brand-ink)/10">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-1 px-4 pt-2 pb-24">
            <p
              className="py-2 text-xs text-(--public-muted)"
              data-testid="public-copyright"
            >
              {t("footer.copyright", {
                year: SITE.copyrightYear,
                name: SITE.name,
              })}
            </p>
            {path && (
              <LocaleLinks
                path={path}
                label={t("footer.languages")}
                className={`${linkClass} text-xs aria-[current=page]:font-semibold aria-[current=page]:text-(--brand-ink)`}
              />
            )}
          </div>
        </div>
      </footer>
      <WhatsAppWidget />
    </>
  );
}
