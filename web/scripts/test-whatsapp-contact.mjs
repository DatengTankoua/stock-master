// Contact WhatsApp — tests déterministes côté web : numéro centralisé,
// liens `wa.me` / `tel:` / `mailto:` et encodage du texte prérempli
// (accents, retours à la ligne, caractères réservés), plus garde-fous
// statiques (numéro jamais recopié, aucun stockage du navigateur, aucun
// SDK ni requête vers WhatsApp, montage sur les pages publiques).
//
// Aucun message réel n'est envoyé : seules les URL sont construites.
//
// Exécution : `pnpm --filter web test:whatsapp-contact` (ou `node
// scripts/test-whatsapp-contact.mjs` depuis `web/`). Runner `node:test`,
// modules transpilés en mémoire, aucune dépendance ajoutée.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "..", "src");
const nodeRequire = createRequire(import.meta.url);
const ts = nodeRequire("typescript");

const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file);
  const source = readFileSync(path.join(SRC, "lib", file), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  });
  const loaded = { exports: {} };
  cache.set(file, loaded.exports);
  const localRequire = (name) => {
    if (name.startsWith("./")) return load(`${name.slice(2)}.ts`);
    throw new Error(`module non prévu : ${name}`);
  };
  new Function("module", "exports", "require", outputText)(
    loaded,
    loaded.exports,
    localRequire,
  );
  return loaded.exports;
}

const { WHATSAPP, CONTACT_EMAILS } = load("legal/site-identity.ts");
const { composeContactText, whatsappHref, mailtoHref, WHATSAPP_TOPICS } = load(
  "whatsapp-contact.ts",
);

/** Texte décodé tel que WhatsApp le recevra. */
const decodedText = (href) => new URL(href).searchParams.get("text");

test("numéro professionnel centralisé et cohérent", () => {
  assert.equal(WHATSAPP.display, "+237 651 563 665");
  assert.equal(WHATSAPP.url, "https://wa.me/237651563665");
  assert.equal(WHATSAPP.tel, "tel:+237651563665");
  assert.equal(WHATSAPP.digits, WHATSAPP.display.replace(/\D/g, ""));
  assert.equal(WHATSAPP.e164, `+${WHATSAPP.digits}`);
  assert.equal(WHATSAPP.url, `https://wa.me/${WHATSAPP.digits}`);
});

test("lien sans texte : numéro seul", () => {
  assert.equal(whatsappHref(""), WHATSAPP.url);
  assert.equal(whatsappHref("  \n \r\n "), WHATSAPP.url);
});

test("accents, retours à la ligne et caractères réservés encodés", () => {
  const text = composeContactText({
    subjectLine: "Sujet : Aide technique",
    message:
      "Bonjour,\r\nJ'ai un problème : « réçu » & stock #2 ?\n50 % + 1 = é😀",
  });
  const href = whatsappHref(text);
  assert.ok(href.startsWith(`${WHATSAPP.url}?text=`));
  const query = href.slice(href.indexOf("?") + 1);
  // Une seule variable, aucun séparateur ni espace laissé en clair.
  assert.match(query, /^text=[A-Za-z0-9%\-_.!~*'()]+$/);
  assert.ok(query.includes("%0A%0A"), "ligne vide après le sujet");
  assert.ok(!query.includes("%0D"), "retours chariot normalisés");
  assert.ok(query.includes("%C3%A9"), "é en UTF-8");
  assert.equal(
    decodedText(href),
    "Sujet : Aide technique\n\nBonjour,\nJ'ai un problème : « réçu » & stock #2 ?\n50 % + 1 = é😀",
  );
});

test("sujet facultatif : message seul, ou sujet seul", () => {
  assert.equal(composeContactText({ message: "  Bonjour  " }), "Bonjour");
  assert.equal(
    composeContactText({ subjectLine: "Subject: Other", message: " " }),
    "Subject: Other",
  );
  assert.equal(composeContactText({ message: "" }), "");
});

test("le texte transmis est exactement celui saisi (aucun ajout)", () => {
  const message = "Ma question";
  const href = whatsappHref(composeContactText({ message }));
  assert.equal(decodedText(href), message);
  assert.equal(new URL(href).searchParams.size, 1);
});

test("mailto : sujet et corps encodés (espaces en %20)", () => {
  assert.equal(
    mailtoHref(CONTACT_EMAILS.contact),
    "mailto:contact@stock-master.app",
  );
  const href = mailtoHref(CONTACT_EMAILS.support, {
    subject: "Aide technique : question",
    body: "Ligne 1\r\nLigne 2 & é",
  });
  assert.equal(
    href,
    "mailto:support@stock-master.app?subject=Aide%20technique%20%3A%20question&body=Ligne%201%0ALigne%202%20%26%20%C3%A9",
  );
  assert.ok(!href.includes("+"));
});

test("sujets publics proposés", () => {
  assert.deepEqual(
    [...WHATSAPP_TOPICS],
    ["discovery", "subscription", "technical", "other"],
  );
});

// ─── Garde-fous statiques ────────────────────────────────────────────────────

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}
const rel = (file) => path.relative(SRC, file).replaceAll("\\", "/");
const read = (file) => readFileSync(path.join(SRC, file), "utf8");

test("numéro jamais recopié hors de site-identity.ts", () => {
  const offenders = sources(SRC)
    .filter((file) => rel(file) !== "lib/legal/site-identity.ts")
    .filter((file) =>
      /651\s?563\s?665|237651563665|\/\/wa\.me/.test(
        readFileSync(file, "utf8"),
      ),
    )
    .map(rel);
  assert.deepEqual(offenders, []);
});

const WHATSAPP_FILES = [
  "lib/whatsapp-contact.ts",
  "components/contact/whatsapp-continue.tsx",
  "components/contact/whatsapp-icon.tsx",
  "components/public/whatsapp-widget.tsx",
  "components/organization/whatsapp-support-card.tsx",
];

test("aucun stockage, aucune requête, aucun SDK tiers", () => {
  for (const file of WHATSAPP_FILES) {
    const code = read(file);
    assert.doesNotMatch(
      code,
      /localStorage|sessionStorage|indexedDB|document\.cookie|fetch\(|axios|apiClient|<script|<iframe|facebook|connect\.facebook|graph\.facebook/,
      file,
    );
  }
});

test("le parcours WhatsApp n'utilise pas l'envoi d'assistance", () => {
  for (const file of WHATSAPP_FILES) {
    assert.doesNotMatch(
      read(file),
      /submitSupportRequest|fetchSupportContext|@\/lib\/support/,
      file,
    );
  }
});

test("bouton flottant monté sur les pages publiques, jamais ouvert d'office", () => {
  const footer = read("components/public/public-footer.tsx");
  assert.match(footer, /<WhatsAppWidget \/>/);
  const widget = read("components/public/whatsapp-widget.tsx");
  assert.doesNotMatch(widget, /defaultOpen|open=\{true\}/);
  // Pages publiques : accueil et gabarit des pages d'aide/juridiques.
  assert.match(read("app/page.tsx"), /<PublicFooter /);
  assert.match(read("components/legal/document-page.tsx"), /<PublicFooter /);
});

test("WhatsApp présenté avant le formulaire e-mail de l'Assistance", () => {
  const page = read("app/app/organization/support/page.tsx");
  const card = page.indexOf("<WhatsAppSupportCard");
  const form = page.indexOf("<form");
  assert.ok(card > 0 && form > card);
  // Parcours e-mail conservé.
  assert.match(page, /submitSupportRequest\(/);
});
