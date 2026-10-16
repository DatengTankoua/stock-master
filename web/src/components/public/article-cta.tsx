import Link from "next/link";

// Guides pratiques — appel final vers Stock Master, mêmes couleurs et
// boutons que l'appel final de l'accueil. Textes et liens fournis par le
// contenu de la page, dans sa langue (aucun texte écrit ici).
interface CtaLink {
  href: string;
  label: string;
}

const primaryClass =
  "inline-flex min-h-12 items-center justify-center rounded-lg bg-(--brand-orange) px-6 text-base font-semibold text-(--brand-navy) hover:bg-[#ff8533] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";
const secondaryClass =
  "inline-flex min-h-12 items-center justify-center rounded-lg border border-white/40 px-6 text-base font-semibold text-white hover:border-white hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";

export function ArticleCta({
  id,
  title,
  text,
  primary,
  secondary,
  note,
}: {
  id: string;
  title: string;
  text: React.ReactNode;
  primary: CtaLink;
  secondary?: CtaLink;
  note?: React.ReactNode;
}) {
  return (
    <section
      aria-labelledby={`${id}-titre`}
      className="mt-10 rounded-2xl bg-(--brand-navy) px-5 py-8 text-white sm:px-8 dark:ring-1 dark:ring-white/20"
    >
      <h2
        id={`${id}-titre`}
        className="text-2xl font-extrabold tracking-tight text-balance"
      >
        {title}
      </h2>
      <div className="mt-3 leading-relaxed text-pretty text-white/85">
        {text}
      </div>
      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
        <Link href={primary.href} className={primaryClass}>
          {primary.label}
        </Link>
        {secondary && (
          <Link href={secondary.href} className={secondaryClass}>
            {secondary.label}
          </Link>
        )}
      </div>
      {note && (
        <div className="mt-5 text-sm leading-relaxed text-white/80 [&_a]:rounded-sm [&_a]:font-medium [&_a]:text-white [&_a]:underline [&_a]:underline-offset-4 [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-offset-2 [&_a:focus-visible]:outline-white">
          {note}
        </div>
      )}
    </section>
  );
}
