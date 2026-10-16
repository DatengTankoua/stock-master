import Link from "next/link";
import { ArticleCta } from "@/components/public/article-cta";
import { DemoSalesCapture } from "@/components/public/demo-sales-capture";
import { formatFcfa } from "@/i18n/format";
import { SITE } from "@/lib/legal/site-identity";
import { TRIAL_DAYS } from "@/lib/subscription-offers";
import type { ArticleContent } from "@/i18n/documents/types";
import { REORDER_EXAMPLE, STOCK_EXAMPLE } from "./example";

// Guide pratique « gérer le stock d'une boutique ». Sections 1 à 6 : bonnes
// pratiques GÉNÉRALES, valables sans logiciel. Section 8 : opérations de
// Stock Master VÉRIFIÉES dans le code (produits, ajout de stock, ventes,
// correction des erreurs de saisie, statuts et alertes de stock, Analyse,
// droits), puis un seul bloc « À noter à part » pour ce qui ne s'y
// enregistre pas (retours, pertes, péremption, comptages). Essai : attribué
// à la création du commerce, donc à l'inscription d'un nouveau compte
// (`OrganizationsService.createOwnerOrganization`), jamais à un membre
// invité. Les noms de boutons sont ceux de l'interface française.
// Exemples fictifs : `./example.ts`.
const registrationEnabled =
  process.env.NEXT_PUBLIC_REGISTRATION_ENABLED === "true";

const ex = STOCK_EXAMPLE;
const fcfa = (amount: number) => formatFcfa(amount, "fr");

const content: ArticleContent = {
  metaTitle: "Gérer le stock d'une boutique au Cameroun",
  metaDescription:
    "Méthode simple pour petites boutiques : fiches produits et variantes, stock de départ, entrées, ventes et pertes, réapprovisionnement, équipe, inventaire.",
  title: "Comment gérer le stock d'une boutique au Cameroun\u00a0?",
  intro: (
    <>
      <p>
        Un produit introuvable, une rupture sur l&apos;article qui se vend le
        mieux, un écart inexpliqué en fin de mois : dans une petite boutique,
        notamment de cosmétiques, le stock échappe vite au contrôle. Voici une
        méthode en six étapes, applicable avec un cahier, un tableur ou une
        application.
      </p>
      <p className="mt-3">
        Les étapes 1 à 6 sont des bonnes pratiques générales. La partie 8 montre
        ensuite ce que {SITE.name} permet d&apos;appliquer, et ce qu&apos;il
        faut encore noter à part.
      </p>
    </>
  ),
  sections: [
    {
      id: "fiches-produits",
      title: "Créer une fiche par produit et distinguer les variantes",
      content: (
        <>
          <p>
            Une fiche correspond à un article que vous pouvez compter
            séparément. Chaque contenance, parfum, teinte ou format a sa propre
            fiche : « Lait corporel karité 250 ml » et « Lait corporel karité
            500 ml » sont deux produits, car ils n&apos;ont ni le même prix ni
            le même rythme de vente.
          </p>
          <ul>
            <li>
              Donnez un nom précis et stable : marque, produit, variante,
              contenance. Évitez les fiches fourre-tout comme « crèmes diverses
              ».
            </li>
            <li>
              Indiquez sur chaque fiche le prix d&apos;achat, le prix de vente
              et la quantité en stock. Une photo aide les vendeurs à prendre le
              bon article.
            </li>
            <li>
              Regroupez les fiches par famille (soins du corps, cheveux,
              maquillage, parfums) pour les retrouver vite.
            </li>
            <li>
              Pour les produits qui se périment, notez les dates et vendez
              d&apos;abord les plus anciens.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "stock-de-depart",
      title: "Compter le stock de départ",
      content: (
        <>
          <p>
            Tous vos calculs partiront de ce comptage : prenez le temps de le
            faire correctement, une fois.
          </p>
          <ul>
            <li>
              Choisissez un moment sans vente : avant l&apos;ouverture ou après
              la fermeture.
            </li>
            <li>
              Comptez rayon par rayon, à deux si possible : l&apos;un compte,
              l&apos;autre note.
            </li>
            <li>
              Mettez de côté les articles abîmés, ouverts ou périmés : ils ne
              font pas partie du stock vendable.
            </li>
            <li>Notez la date du comptage.</li>
          </ul>
        </>
      ),
    },
    {
      id: "mouvements",
      title: "Noter chaque entrée, vente, retour ou perte",
      content: (
        <>
          <p>
            Le stock ne change que par des mouvements. Si chacun est noté au
            moment où il se produit, le stock attendu se calcule simplement :
          </p>
          <p>
            <strong>
              Stock attendu = stock de départ + entrées − sorties (ventes,
              pertes, retours au fournisseur)
            </strong>
          </p>
          <ul>
            <li>
              <strong>Entrées</strong> : à chaque livraison, comptez les
              articles et comparez-les au bon de livraison ou à la facture avant
              de payer.
            </li>
            <li>
              <strong>Ventes</strong> : notez-les au moment de la vente, pas le
              soir de mémoire.
            </li>
            <li>
              <strong>Retours</strong> : un article rapporté par un client et
              encore vendable revient en stock ; un article renvoyé au
              fournisseur en sort.
            </li>
            <li>
              <strong>Pertes</strong> : produit abîmé, périmé, cassé, testeur
              ouvert, vol constaté. Notez la date, la quantité et la raison. Une
              perte non notée devient un écart inexpliqué au comptage suivant.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "reapprovisionnement",
      title: "Définir les produits à surveiller pour le réapprovisionnement",
      content: (
        <>
          <p>
            Tous les produits ne méritent pas la même attention. Repérez ceux
            qui se vendent le plus et ceux qui ne doivent jamais manquer, puis
            fixez pour chacun un seuil de commande :
          </p>
          <p>
            <strong>
              Seuil de commande = ventes moyennes par jour × (délai du
              fournisseur + quelques jours de marge)
            </strong>
          </p>
          <p>
            Par exemple, un produit qui se vend environ{" "}
            {REORDER_EXAMPLE.dailySales} fois par jour, livré en{" "}
            {REORDER_EXAMPLE.supplierDelayDays} jours, avec{" "}
            {REORDER_EXAMPLE.safetyDays} jours de marge :{" "}
            {REORDER_EXAMPLE.dailySales} × ({REORDER_EXAMPLE.supplierDelayDays}{" "}
            + {REORDER_EXAMPLE.safetyDays}) = {REORDER_EXAMPLE.reorderPoint}.
            Dès qu&apos;il en reste {REORDER_EXAMPLE.reorderPoint}, recommandez.
          </p>
          <ul>
            <li>
              Revoyez les seuils quand les ventes changent : fêtes, rentrée,
              nouveau produit à la mode.
            </li>
            <li>
              Repérez aussi les produits qui ne se vendent plus : ils
              immobilisent votre argent. Ne les recommandez pas par habitude.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "equipe",
      title: "Répartir les responsabilités dans l'équipe",
      content: (
        <>
          <p>
            Savoir qui fait quoi n&apos;est pas une question de méfiance : cela
            permet de retrouver et de corriger vite une erreur.
          </p>
          <ul>
            <li>
              Une ou deux personnes seulement réceptionnent les livraisons et
              enregistrent les entrées.
            </li>
            <li>
              Chaque vendeur enregistre ses propres ventes, au moment où il les
              fait.
            </li>
            <li>
              Les corrections, retours et pertes sont signalés à une personne
              désignée, qui les note.
            </li>
            <li>
              Le propriétaire ou le gérant organise les comptages et examine les
              écarts.
            </li>
            <li>
              Quand quelqu&apos;un quitte la boutique, retirez-lui l&apos;accès
              à vos outils.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "inventaire",
      title: "Comparer régulièrement le stock enregistré au stock physique",
      content: (
        <>
          <ul>
            <li>
              Faites un comptage complet au moins une fois par mois et, chaque
              semaine, un comptage rapide des produits chers ou très vendus.
            </li>
            <li>
              Comptez d&apos;abord, puis comparez au stock enregistré : ne
              partez pas du chiffre attendu.
            </li>
            <li>
              En cas d&apos;écart, cherchez la cause avant de corriger : vente
              non notée, livraison incomplète, confusion entre deux variantes,
              perte oubliée.
            </li>
            <li>
              Notez chaque écart et sa cause. Si les mêmes produits reviennent
              souvent, changez la façon de travailler sur ces produits.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "exemple",
      title: "Exemple chiffré : stock restant et chiffre d'affaires",
      content: (
        <>
          <p>
            <strong>Exemple fictif, à but pédagogique</strong> : il ne décrit la
            situation d&apos;aucun client de {SITE.name}. Le produit est un lait
            corporel karité 250 ml, vendu {fcfa(ex.unitPriceXaf)} l&apos;unité.
          </p>
          <div className="overflow-x-auto">
            <table>
              <caption className="pb-2 text-left text-sm text-(--public-muted)">
                Mouvements du lait corporel karité 250 ml sur la période
              </caption>
              <thead>
                <tr>
                  <th scope="col">Mouvement</th>
                  <th scope="col">Quantité</th>
                  <th scope="col">Stock après</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                <tr>
                  <th scope="row">Stock de départ (comptage)</th>
                  <td>{ex.opening}</td>
                  <td>{ex.opening}</td>
                </tr>
                <tr>
                  <th scope="row">Livraison reçue</th>
                  <td>+{ex.received}</td>
                  <td>{ex.afterReceipt}</td>
                </tr>
                <tr>
                  <th scope="row">Ventes</th>
                  <td>−{ex.sold}</td>
                  <td>{ex.afterSales}</td>
                </tr>
                <tr>
                  <th scope="row">Flacon abîmé (perte)</th>
                  <td>−{ex.damaged}</td>
                  <td>{ex.remaining}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>
            <strong>
              Stock restant attendu : {ex.opening} + {ex.received} − {ex.sold} −{" "}
              {ex.damaged} = {ex.remaining} unités.
            </strong>{" "}
            Si vous en comptez {ex.remaining} sur l&apos;étagère, tout est en
            ordre. Si vous en comptez moins, l&apos;écart est à expliquer.
          </p>
          <p>
            Les {ex.sold} ventes représentent {ex.sold} ×{" "}
            {fcfa(ex.unitPriceXaf)} = <strong>{fcfa(ex.revenueXaf)}</strong> de
            chiffre d&apos;affaires. Ce n&apos;est pas un bénéfice : pour
            l&apos;obtenir, il faut retirer au moins le prix d&apos;achat des{" "}
            {ex.sold} flacons vendus, la valeur du flacon abîmé et les charges
            de la boutique (loyer, transport, électricité…). Ce n&apos;est pas
            non plus forcément l&apos;argent encaissé, si certaines ventes ont
            été faites à crédit.
          </p>
        </>
      ),
    },
    {
      id: "stock-master",
      title: "Appliquer la méthode avec Stock Master",
      content: (
        <>
          <p>
            Les étapes 1 à 6 restent valables avec n&apos;importe quel outil.
            Voici les opérations réellement disponibles aujourd&apos;hui dans{" "}
            {SITE.name}, application de gestion du stock et des ventes
            utilisable depuis le téléphone, pour les appliquer. Le détail des
            écrans est dans le{" "}
            <Link href="/guide">guide d&apos;utilisation</Link>.
          </p>

          <h3>Fiches produits et variantes</h3>
          <ul>
            <li>
              Chaque produit a un nom, une photo (obligatoire), un prix
              d&apos;achat, un prix de vente et une quantité initiale. Les
              produits sont rangés par catégories et sous-catégories (« Nouvelle
              section »).
            </li>
            <li>
              Créez un produit par variante (250 ml et 500 ml, par exemple),
              comme à l&apos;étape 1.
            </li>
          </ul>

          <h3>Stock de départ</h3>
          <p>
            La quantité initiale saisie à la création du produit est votre stock
            de départ : indiquez le résultat de votre comptage.
          </p>

          <h3>Entrées et ventes</h3>
          <ul>
            <li>
              <strong>Entrées</strong> : « Modifier » sur le produit, puis «
              Stock supplémentaire à ajouter » (droit « Ajuster le stock »).
            </li>
            <li>
              <strong>Ventes</strong> : « Enregistrer une vente » sur le
              produit. Chaque vente fait baisser le stock et garde le vendeur,
              la date et l&apos;heure. Les ventes peuvent aussi être saisies
              sans réseau, sous{" "}
              <Link href="/guide#hors-ligne">certaines conditions</Link>.
            </li>
            <li>
              <strong>Erreurs de saisie</strong> : selon vos droits, une vente
              enregistrée par erreur peut être corrigée ou supprimée ; les
              unités reviennent alors en stock.
            </li>
            <li>
              L&apos;« Historique complet » du produit liste sa création, les
              ventes, les ajouts de stock, les changements de prix et les ventes
              modifiées ou annulées, avec leur auteur et leur date (droit « Voir
              l&apos;historique d&apos;audit »).
            </li>
          </ul>
          <DemoSalesCapture />

          <h3>Produits à surveiller</h3>
          <ul>
            <li>
              Chaque produit affiche « En stock », « Stock faible » ou « Épuisé
              ». « Stock faible » apparaît quand il reste 20 % ou moins de la
              quantité totale entrée (quantité initiale et ajouts). Ce seuil est
              le même pour tous les produits : gardez vos propres seuils de
              commande (étape 4) pour les produits importants.
            </li>
            <li>
              Les membres qui ont le droit « Voir le détail du stock » sont
              prévenus quand un produit est presque épuisé ou épuisé.
            </li>
            <li>
              La page <strong>Analyse</strong> (droit « Voir les analyses »)
              regroupe dans « À surveiller » les ruptures, les produits «
              Bientôt épuisé » (environ 7 jours de stock ou moins au rythme des
              ventes enregistrées, s&apos;il y en a assez pour estimer) et ceux
              sans vente récente.
            </li>
          </ul>

          <h3>Équipe et droits</h3>
          <ul>
            <li>
              Trois rôles : Propriétaire, Administrateur et Vendeur. Par défaut,
              un vendeur enregistre des ventes et voit les siennes ; il peut
              aussi corriger ou supprimer ses propres ventes, et chaque
              correction reste visible dans l&apos;historique du produit.
            </li>
            <li>
              Vous ajoutez d&apos;autres droits un par un, par exemple « Ajuster
              le stock » à la seule personne qui réceptionne les livraisons.
            </li>
            <li>
              Le propriétaire est prévenu quand un autre membre modifie un
              produit (un ajout de stock, par exemple), corrige ou annule une
              vente.
            </li>
            <li>
              Un membre peut être suspendu ou révoqué. Voir{" "}
              <Link href="/guide#membres">les rôles et les droits</Link>.
            </li>
          </ul>

          <h3>Comparer au stock physique</h3>
          <ul>
            <li>
              Le « Stock restant » de chaque produit est le stock enregistré à
              comparer à votre comptage. Synchronisez d&apos;abord les ventes
              saisies sans réseau.
            </li>
            <li>
              Si l&apos;écart vient d&apos;une erreur de saisie, corrigez la
              vente concernée ou ajoutez la livraison oubliée.
            </li>
            <li>
              Le propriétaire et l&apos;administrateur peuvent télécharger
              l&apos;historique d&apos;un mois (Excel ou PDF) : ventes,
              corrections et annulations, pour vérifier une période.
            </li>
          </ul>

          <h3>À noter à part</h3>
          <p>
            Ces mouvements ne s&apos;enregistrent pas dans {SITE.name} :
            gardez-les dans un cahier ou un tableur, avec la date, la quantité
            et la raison.
          </p>
          <ul>
            <li>
              Les retours de clients et les retours au fournisseur. Corriger ou
              supprimer une vente sert à rectifier une erreur de saisie : ce
              n&apos;est pas un suivi des retours.
            </li>
            <li>
              Les pertes : produits abîmés, périmés, testeurs ouverts, vols
              constatés.
            </li>
            <li>Les dates de péremption et les résultats de vos comptages.</li>
          </ul>
          <p>
            Le stock affiché ne baisse que par une vente : dans l&apos;exemple
            ci-dessus, l&apos;application indique {ex.afterSales} unités pour{" "}
            {ex.remaining} sur l&apos;étagère. Tenez compte de ces notes lors de
            chaque comptage.
          </p>
        </>
      ),
    },
  ],
  closing: registrationEnabled ? (
    <ArticleCta
      id="essayer"
      title="Appliquez cette méthode avec Stock Master"
      text={
        <p>
          Créez votre compte, puis ajoutez vos produits et invitez vos vendeurs
          depuis votre téléphone. Un nouveau compte crée son commerce et reçoit
          un essai gratuit de {TRIAL_DAYS} jours, qui démarre à la création du
          commerce.
        </p>
      }
      primary={{ href: "/auth/register", label: "Créer un compte" }}
      secondary={{ href: "/", label: "Découvrir Stock Master" }}
      note={
        <p>
          <Link href="/#tarifs">Voir les tarifs</Link> · Déjà inscrit ?{" "}
          <Link href="/auth/login">Se connecter</Link>
        </p>
      }
    />
  ) : (
    <ArticleCta
      id="essayer"
      title="Découvrez Stock Master"
      text={
        <p>
          Les inscriptions en ligne sont momentanément fermées. Découvrez ce que
          fait {SITE.name} et ses tarifs ; si vous avez déjà un compte,
          connectez-vous.
        </p>
      }
      primary={{ href: "/", label: "Découvrir Stock Master" }}
      secondary={{ href: "/auth/login", label: "Se connecter" }}
      note={
        <p>
          <Link href="/#tarifs">Voir les tarifs</Link>
        </p>
      }
    />
  ),
};

export default content;
