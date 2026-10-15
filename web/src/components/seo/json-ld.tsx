import { headers } from "next/headers";

// Référencement — données structurées schema.org (JSON-LD). Bloc de
// données, jamais exécuté ; il porte tout de même le nonce de la CSP de la
// requête. `<` est échappé pour qu'aucune valeur ne puisse fermer la balise.
export async function JsonLd({ data }: { data: object }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <script
      type="application/ld+json"
      nonce={nonce}
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(data).replace(/</g, "\\u003c"),
      }}
    />
  );
}
