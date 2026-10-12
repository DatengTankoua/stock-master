import Link from "next/link";
import { MailLink } from "@/components/legal/mail-link";
import { SITE } from "@/lib/legal/site-identity";
import {
  SUBSCRIPTION_OFFERS,
  TRIAL_DAYS,
  formatFcfa,
  monthlyEquivalentXaf,
} from "@/lib/subscription-offers";

// 1-16C — Conditions d'abonnement. Tarifs et essai lus dans
// `lib/subscription-offers.ts` (1-21D : calculés depuis
// `api/src/subscriptions/subscription-pricing.ts`, et `TRIAL_DURATION_MS`),
// jamais recopiés. 1-21D (0.5) : paiement en ligne par SasPay, frais pris en
// charge par Stock Master (réglage marchand « Déduits » vérifié en LIVE).
import type { DocumentContent } from "@/i18n/documents/types";
import { formatNumber } from "@/i18n/format";
import { PRODUCT_CAPACITY } from "@/lib/product-capacity";
import subscriptionFr from "@/i18n/resources/fr/subscription";

const TERM_LABELS = subscriptionFr.offers.term;

// 1-16G : texte français déplacé tel quel depuis la page (le texte
// affiché, archivé et accepté ne change pas).
const content: DocumentContent = {
  metaTitle: "Conditions d'abonnement",
  metaDescription:
    "Essai gratuit, durées et prix en FCFA, activation, expiration, renouvellement et réclamations pour l'abonnement Stock Master.",
  title: "Conditions d'abonnement",
  intro: (
    <p>
      Ces conditions décrivent l&apos;essai gratuit et l&apos;abonnement payant
      à {SITE.name} : ce qu&apos;ils comprennent, leur durée, leur prix et ce
      qui se passe à leur échéance. Elles complètent les{" "}
      <Link href="/conditions-utilisation">conditions d&apos;utilisation</Link>.
    </p>
  ),
  sections: [
    {
      id: "offre",
      title: "Ce que comprend l'abonnement",
      content: (
        <>
          <p>
            Il existe une seule offre, avec toutes les fonctions de {SITE.name}.
            L&apos;abonnement est pris pour un commerce, et non pour une
            personne :
          </p>
          <ul>
            <li>
              tous les membres du commerce sont inclus, sans supplément par
              vendeur ;
            </li>
            <li>
              chaque membre accède aux fonctions selon les droits que le
              commerce lui a donnés ;
            </li>
            <li>
              l&apos;abonnement est géré par le propriétaire du commerce, dans
              Organisation, puis Abonnement.
            </li>
          </ul>
          {/* 1-21D : plafond injecté depuis la source unique (API). Le
              catalogue n'a pas de variantes : chaque produit est une fiche. */}
          <p>
            <strong>Capacité incluse.</strong> Chaque organisation peut
            conserver jusqu&apos;à {formatNumber(PRODUCT_CAPACITY, "fr")} fiches
            produit, y compris celles placées dans la corbeille ; chaque produit
            du catalogue constitue une fiche. Les quantités en stock
            n&apos;entrent pas dans ce décompte, pas plus que les ventes et leur
            historique. Cette capacité est la même pour toutes les durées.
            Lorsqu&apos;elle est atteinte, seule la création de nouvelles fiches
            est refusée.
          </p>
        </>
      ),
    },
    {
      id: "essai",
      title: "Essai gratuit",
      content: (
        <ul>
          <li>
            Un essai gratuit de {TRIAL_DAYS} jours démarre automatiquement à la
            création du commerce.
          </li>
          <li>Aucun moyen de paiement n&apos;est demandé pour l&apos;essai.</li>
          <li>Un commerce ne bénéficie que d&apos;un seul essai.</li>
          <li>
            Si les notifications « Fin d&apos;essai ou d&apos;abonnement » sont
            activées, un rappel est envoyé dans les 24 heures qui précèdent la
            fin.
          </li>
          <li>
            À la fin de l&apos;essai, l&apos;accès au commerce est limité comme
            décrit à la section « Expiration ».
          </li>
        </ul>
      ),
    },
    {
      id: "prix",
      title: "Durées et prix",
      content: (
        <>
          <p>
            Le montant indiqué est le total payé en une fois pour toute la durée
            choisie, en francs CFA (XAF). Il n&apos;est pas prélevé chaque mois
            : l&apos;équivalent mensuel n&apos;est donné qu&apos;à titre de
            comparaison.
          </p>
          <table>
            <caption className="sr-only">
              Durées et prix de l&apos;abonnement
            </caption>
            <thead>
              <tr>
                <th scope="col">Durée</th>
                <th scope="col">Total payé en une fois</th>
                <th scope="col">Équivalent mensuel et économie</th>
              </tr>
            </thead>
            <tbody>
              {SUBSCRIPTION_OFFERS.map((offer) => (
                <tr key={offer.term}>
                  <td>{TERM_LABELS[offer.term]}</td>
                  <td className="whitespace-nowrap tabular-nums">
                    {formatFcfa(offer.totalXaf, "fr")}
                  </td>
                  <td className="tabular-nums">
                    {offer.months > 1
                      ? `environ ${formatFcfa(monthlyEquivalentXaf(offer), "fr")} par mois ; ${formatFcfa(offer.savingXaf, "fr")} d'économie par rapport au paiement mensuel${offer.freeMonths > 0 ? ` (${offer.freeMonths} mois offert${offer.freeMonths > 1 ? "s" : ""})` : ""}`
                      : "Un mois"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* À COMPLÉTER : régime fiscal et mention « toutes taxes
              comprises » ou montant des taxes (loi 2010/021, art. 31). */}
          <p>
            Les frais du prestataire de paiement SasPay sont pris en charge par{" "}
            {SITE.name} : ils ne s&apos;ajoutent pas au prix. Le montant à payer
            est affiché sur la page de paiement avant votre validation.
          </p>
          <p>
            Le prix applicable est celui en vigueur au moment où le paiement est
            demandé ; il vous est présenté avant tout paiement. Un paiement déjà
            demandé et une période déjà accordée ne sont jamais modifiés par un
            changement de prix.
          </p>
        </>
      ),
    },
    {
      id: "duree",
      title: "Début et durée d'une période",
      content: (
        <ul>
          <li>
            Une période se compte en mois du calendrier : une période d&apos;un
            mois commencée le 10 mars se termine le 10 avril à la même heure. Si
            le jour n&apos;existe pas (31), elle se termine le dernier jour du
            mois.
          </li>
          <li>
            Une période accordée avant la fin de l&apos;essai ou de la période
            en cours commence à la fin de celle-ci : le temps déjà accordé
            n&apos;est jamais perdu.
          </li>
          <li>
            L&apos;état de l&apos;abonnement et ses dates sont visibles dans
            Organisation, puis Abonnement.
          </li>
        </ul>
      ),
    },
    {
      id: "renouvellement",
      title: "Paiement et renouvellement",
      content: (
        <>
          {/* 1-21D (0.5) : procédure livrée en 1-21B et vérifiée en LIVE
              (1-21C). Aucune garantie propre à SasPay n'est décrite. */}
          <p>Le propriétaire paie depuis Organisation, puis Abonnement :</p>
          <ul>
            <li>
              il choisit une durée ; le montant est fixé par {SITE.name} à ce
              moment ;
            </li>
            <li>
              il paie ce montant en une fois sur la page sécurisée de SasPay,
              prestataire de paiement, par Mobile Money (MTN ou Orange) ;
            </li>
            <li>
              la période est accordée lorsque {SITE.name} a obtenu de SasPay la
              confirmation du paiement ; le simple retour sur {SITE.name} ne
              suffit pas. Le bouton « Vérifier le paiement » relance cette
              vérification ;
            </li>
            <li>
              il n&apos;y a aucun renouvellement ni prélèvement automatique :
              chaque nouvelle période est une décision du propriétaire.
            </li>
          </ul>
          <p>
            En cas de difficulté, contactez{" "}
            <MailLink to="support" subject="Renouvellement de l'abonnement" />.
          </p>
          {/* À COMPLÉTER : justificatif remis et délai d'activation. */}
        </>
      ),
    },
    {
      id: "expiration",
      title: "Expiration",
      content: (
        <>
          <p>
            À la fin de l&apos;essai ou de la dernière période payée, sans
            nouvelle période :
          </p>
          <ul>
            <li>
              l&apos;accès aux pages du commerce est bloqué pour tous ses
              membres, y compris sur les appareils déjà connectés ;
            </li>
            <li>
              le propriétaire voit un écran qui l&apos;invite à renouveler ; les
              autres membres sont invités à le contacter ;
            </li>
            <li>
              les ventes enregistrées sans connexion et pas encore envoyées
              restent sur l&apos;appareil ; elles sont envoyées lorsque
              l&apos;accès est rétabli, dans la limite de 14 jours après leur
              saisie ;
            </li>
            <li>
              les données du commerce ne sont pas supprimées automatiquement à
              l&apos;expiration.
            </li>
          </ul>
          {/* À COMPLÉTER : durée de conservation des données d'un
              commerce qui ne renouvelle pas, et possibilité de les récupérer. */}
        </>
      ),
    },
    {
      id: "resiliation",
      title: "Arrêt, rétractation et remboursement",
      content: (
        <>
          <p>
            Comme rien n&apos;est renouvelé automatiquement, il suffit de ne pas
            renouveler pour arrêter l&apos;abonnement à la fin de la période en
            cours.
          </p>
          {/* 1-21D (0.5) : décision commerciale du titulaire. Aucun délai,
              aucune retenue, aucun montant forfaitaire ni procédure
              automatisée n'est annoncé (aucun n'existe). */}
          <p>
            Une période payée n&apos;est pas remboursée en cas de changement
            d&apos;avis, de non-utilisation du service ou d&apos;arrêt
            volontaire, y compris lorsque le paiement a eu lieu avant le début
            de la période.
          </p>
          <ul>
            <li>
              Par exception, lorsqu&apos;une erreur imputable à {SITE.name}{" "}
              cause un préjudice au client, celui-ci peut obtenir un
              remboursement, après vérification de l&apos;incident.
            </li>
            <li>
              Un double débit confirmé pour un même achat n&apos;est pas dû : le
              montant débité en double est remboursé.
            </li>
          </ul>
          <p>
            Pour signaler un incident ou un double débit, écrivez à{" "}
            <MailLink to="support" subject="Remboursement d'un abonnement" /> en
            indiquant le nom du commerce et la référence du paiement.
          </p>
          <p>
            Ces règles s&apos;appliquent sans préjudice des droits que la loi
            applicable vous reconnaît de manière impérative, y compris un
            éventuel droit de rétractation.
          </p>
          {/* À VALIDER par un juriste : applicabilité du droit de
              rétractation (loi 2010/021, art. 20 ; décret 2011/1521/PM,
              art. 13 à 15 et 20 ; loi-cadre 2011/012, art. 7) et conformité
              de la règle de non-remboursement. */}
        </>
      ),
    },
    {
      id: "acceptation",
      title: "Qui accepte ces conditions",
      content: (
        <>
          <p>
            Ces conditions engagent la personne qui crée le commerce et en
            devient propriétaire. Elle les accepte en cochant la case prévue à
            l&apos;inscription, avec les conditions d&apos;utilisation. Cette
            case n&apos;est jamais cochée d&apos;avance.
          </p>
          <p>
            Les administrateurs et les vendeurs invités acceptent les conditions
            d&apos;utilisation, pas ces conditions. Après un transfert de
            propriété, l&apos;accord du nouveau propriétaire lui sera demandé
            dans l&apos;application.
          </p>
          <p>
            La preuve de l&apos;acceptation est enregistrée par le serveur comme
            décrit dans les{" "}
            <Link href="/conditions-utilisation#acceptation">
              conditions d&apos;utilisation
            </Link>
            , avec le commerce concerné.
          </p>
        </>
      ),
    },
    {
      id: "reclamations",
      title: "Réclamations",
      content: (
        <>
          <p>
            Pour toute question ou réclamation sur l&apos;essai, une période ou
            un paiement, écrivez à <MailLink to="support" /> en indiquant le nom
            du commerce et l&apos;adresse e-mail du propriétaire.
          </p>
          {/* À COMPLÉTER : délai de réponse aux réclamations. */}
          <p>
            Ces conditions ne réduisent aucun droit que la loi vous reconnaît.
          </p>
        </>
      ),
    },
  ],
};

export default content;
