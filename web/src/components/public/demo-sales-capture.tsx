import Image from "next/image";
import { getServerT } from "@/i18n/server";
import { rich } from "@/i18n/rich";

// Guides pratiques — capture RÉELLE de l'écran Ventes, celle de l'accueil
// (`landing/product-preview.tsx`) : boutique, vendeur et ventes FICTIFS,
// aucun contenu client. Une capture par langue d'interface.
const CAPTURES = {
  fr: "/marketing/capture-ventes-mobile-fr.png",
  en: "/marketing/capture-sales-mobile-en.png",
} as const;

// Dimensions réelles des captures (390 × 844 px affichés, échelle 2).
const WIDTH = 780;
const HEIGHT = 1688;

export async function DemoSalesCapture() {
  const { t, lng } = await getServerT("public");
  return (
    <figure className="mt-6">
      <div className="w-52 overflow-hidden rounded-[1.75rem] border-[6px] border-[#021a3a] bg-white shadow-[0_18px_36px_-16px_rgba(2,26,58,0.45)] sm:w-60">
        <Image
          src={CAPTURES[lng]}
          alt={t("preview.salesAlt")}
          width={WIDTH}
          height={HEIGHT}
          sizes="(min-width: 640px) 240px, 208px"
          className="block h-auto w-full"
        />
      </div>
      <figcaption className="mt-3 text-sm text-(--public-muted)">
        {rich(t("preview.salesCaption"), {
          demo: (chunk) => (
            <span className="mr-1.5 inline-block rounded-full bg-(--brand-orange)/15 px-2.5 py-0.5 text-xs font-semibold text-(--brand-ink)">
              {chunk}
            </span>
          ),
        })}
      </figcaption>
    </figure>
  );
}
