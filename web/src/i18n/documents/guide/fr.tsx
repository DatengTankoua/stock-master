import Link from "next/link";
import { MailLink } from "@/components/legal/mail-link";
import { SITE, WHATSAPP } from "@/lib/legal/site-identity";
import { TRIAL_DAYS } from "@/lib/subscription-offers";

// 1-16C — Guide d'utilisation. Chaque étape reprend les libellés réels de
// l'interface et les limites mesurées dans le code (durées, droits,
// hors ligne). Lots, pertes et alertes de péremption activés pour tous les
// commerces, notifications push testées sur de vrais téléphones : confirmé
// par le propriétaire le 21 octobre 2026. Aucun nom de variable technique
// dans ce texte destiné aux clients.
import type { DocumentContent } from "@/i18n/documents/types";

const registrationEnabled =
  process.env.NEXT_PUBLIC_REGISTRATION_ENABLED === "true";

// 1-16G : texte français déplacé tel quel depuis la page (le texte
// affiché, archivé et accepté ne change pas).
const content: DocumentContent = {
  metaTitle: "Guide d'utilisation",
  metaDescription:
    "Inscription, membres, produits, lots et péremption, pertes, ventes, analyses, corbeille, hors connexion, abonnement, notifications et assistance WhatsApp : le guide pas à pas de Stock Master.",
  title: "Guide d'utilisation",
  intro: (
    <>
      <p>
        Ce guide explique, étape par étape, comment utiliser {SITE.name} dans
        votre commerce. Les noms des boutons sont écrits comme dans
        l&apos;application.
      </p>
      <p className="mt-3">
        Vous cherchez d&apos;abord une méthode pour organiser votre stock ?
        Lisez{" "}
        <Link href="/guides/gestion-stock-boutique">
          Comment gérer le stock d&apos;une boutique
        </Link>
        .
      </p>
    </>
  ),
  sections: [
    {
      id: "inscription",
      title: "S'inscrire et confirmer son adresse e-mail",
      content: (
        <>
          {!registrationEnabled && (
            <p>
              <strong>
                Les inscriptions en ligne sont momentanément fermées.
              </strong>{" "}
              Les étapes ci-dessous s&apos;appliqueront à leur réouverture. Un
              vendeur invité peut toujours rejoindre un commerce (voir la
              section suivante).
            </p>
          )}
          <ol>
            <li>
              Ouvrez la page{" "}
              {registrationEnabled ? (
                <Link href="/auth/register">Inscription</Link>
              ) : (
                "Inscription"
              )}{" "}
              et indiquez votre nom, votre adresse e-mail, un mot de passe de 6
              à 100 caractères et le nom de votre commerce (20 caractères au
              plus).
            </li>
            <li>
              Lisez puis acceptez les{" "}
              <Link href="/conditions-utilisation">
                conditions d&apos;utilisation
              </Link>{" "}
              et les{" "}
              <Link href="/conditions-abonnement">
                conditions d&apos;abonnement
              </Link>{" "}
              en cochant la case prévue : le compte n&apos;est pas créé sans
              elle.
            </li>
            <li>
              Un e-mail de confirmation vous est envoyé. Ouvrez le lien
              qu&apos;il contient dans les 24 heures.
            </li>
            <li>
              Vous pouvez ensuite vous <Link href="/auth/login">connecter</Link>
              . L&apos;essai gratuit de {TRIAL_DAYS} jours a commencé à la
              création du commerce.
            </li>
          </ol>
          <h3>Se connecter</h3>
          <p>
            Ouvrez <Link href="/auth/login">Connexion</Link> et saisissez votre
            adresse e-mail et votre mot de passe. Si vous appartenez à plusieurs
            commerces, choisissez celui à ouvrir. Si l&apos;abonnement du
            commerce a pris fin, un écran l&apos;indique : le propriétaire peut
            renouveler depuis cet écran.
          </p>
          <p>
            Pas d&apos;e-mail ? Vérifiez le dossier des indésirables, puis
            essayez de vous connecter : l&apos;écran de connexion propose alors
            de renvoyer le lien. Si vous oubliez votre mot de passe, utilisez «
            Mot de passe oublié ? » : le lien reçu est valable 1 heure.
          </p>
        </>
      ),
    },
    {
      id: "membres",
      title: "Créer son commerce, inviter des membres, choisir leurs droits",
      content: (
        <>
          <p>
            Votre commerce est créé à l&apos;inscription, et vous en êtes le
            propriétaire. Dans <strong>Organisation</strong>, vous pouvez
            modifier son nom, son logo et sa couleur (Branding), et gérer
            l&apos;équipe.
          </p>
          <h3>Inviter un membre</h3>
          <ol>
            <li>
              Ouvrez <strong>Organisation, puis Invitations</strong>, et créez
              une invitation avec l&apos;adresse e-mail de la personne, son rôle
              et ses droits.
            </li>
            <li>
              Copiez le lien affiché et envoyez-le vous-même, par SMS ou
              messagerie. {SITE.name} n&apos;envoie pas l&apos;invitation par
              e-mail. Le lien n&apos;est affiché qu&apos;une fois et reste
              valable 72 heures.
            </li>
            <li>
              La personne ouvre le lien et crée son accès. Si elle n&apos;a pas
              encore de compte, elle accepte les conditions d&apos;utilisation
              en cochant la case prévue.
            </li>
          </ol>
          <h3>Rôles et droits</h3>
          <ul>
            <li>
              <strong>Propriétaire</strong> : tous les droits, abonnement et
              transfert de la propriété.
            </li>
            <li>
              <strong>Administrateur</strong> : tous les droits sauf ceux
              propres au propriétaire.
            </li>
            <li>
              <strong>Vendeur</strong> : enregistre des ventes et voit les
              siennes. Vous pouvez lui ajouter d&apos;autres droits un par un
              (voir toutes les ventes, gérer le catalogue, ajuster le stock,
              voir les analyses, contacter le service client…).
            </li>
          </ul>
          <p>
            Les droits liés au stock se donnent aussi un par un : « Gérer les
            dates de péremption », « Personnaliser les seuils de stock », «
            Activer le suivi par lots et répartir le stock existant », « Mettre
            un lot à l&apos;écart et le remettre à disposition », « Enregistrer
            et corriger des pertes de stock » et « Régler le délai des alertes
            de péremption ». Le propriétaire et l&apos;administrateur les ont
            tous ; un vendeur n&apos;en a aucun tant que vous ne les cochez pas.
          </p>
          <p>
            <strong>Une option manque ?</strong> Un bouton ou un champ
            n&apos;apparaît que si votre rôle ou vos droits le permettent.
            Demandez le droit correspondant au propriétaire ou à un
            administrateur.
          </p>
          <p>
            Dans <strong>Organisation, puis Membres</strong>, choisissez «
            Modifier » sur un membre pour changer ses droits ou son statut : «
            Suspendue » retire l&apos;accès temporairement, « Révoquée » le
            retire définitivement. Le propriétaire peut aussi « Transférer la
            propriété » à un autre membre.
          </p>
        </>
      ),
    },
    {
      id: "catalogue",
      title: "Produits, catégories, stock, ventes et analyses",
      content: (
        <>
          <h3>Ranger les produits par catégorie</h3>
          <p>
            Dans <strong>Catalogue</strong>, créez vos catégories avec «
            Nouvelle section » (par exemple Boissons, Épicerie). Une catégorie
            peut contenir des sous-catégories.
          </p>
          <h3>Ajouter un produit</h3>
          <p>
            Ouvrez une catégorie, puis ajoutez un produit : nom, photo, prix
            d&apos;achat, prix de vente et quantité initiale (en FCFA). La photo
            est obligatoire.
          </p>
          <p>Deux champs sont facultatifs, selon vos droits :</p>
          <ul>
            <li>
              <strong>Date de péremption</strong> (droit « Gérer les dates de
              péremption ») : une seule date pour toute la fiche d&apos;un
              produit sans lots. Elle est indicative :{" "}
              <strong>elle ne bloque jamais les ventes</strong>, même dépassée
              (la fiche indique alors « dépassée »). Elle sert aux alertes de
              péremption. Pour suivre plusieurs dates sur un même produit,
              activez le <a href="#lots">suivi par lots</a>.
            </li>
            <li>
              <strong>Seuil de stock faible</strong> (droit « Personnaliser les
              seuils de stock ») : le produit passe en « Stock faible » quand la
              quantité restante est en dessous de ce seuil. Vide : règle par
              défaut (20 % ou moins du stock initial, ajouts compris). 0 : seule
              la rupture est signalée.
            </li>
          </ul>
          <p>
            Dans « Modifier », « Retirer la date » et « Revenir à la règle par
            défaut » effacent ces valeurs.
          </p>
          <h3>Suivre et compléter le stock</h3>
          <ul>
            <li>
              Chaque vente fait baisser le stock du produit. La fiche produit
              indique « En stock », « Stock faible » ou « Épuisé », ainsi que le
              seuil appliqué (personnalisé ou par défaut).
            </li>
            <li>
              Pour ajouter des marchandises, choisissez « Modifier » sur le
              produit et remplissez « Stock supplémentaire à ajouter » (droit «
              Ajuster le stock »).
            </li>
            <li>
              Produit suivi par lots : ce champ n&apos;apparaît plus.
              Enregistrez les nouvelles unités depuis la section « Lots » de la
              fiche (voir <a href="#lots">Lots, péremption et pertes</a>).
            </li>
          </ul>
          <h3>Enregistrer une vente</h3>
          <ol>
            <li>Ouvrez le produit dans le catalogue.</li>
            <li>
              Choisissez « Vendre » : la fenêtre « Enregistrer une vente »
              s&apos;ouvre.
            </li>
            <li>
              Indiquez la quantité et le prix de vente réel. Le nom et le
              contact de l&apos;acheteur sont facultatifs : ne les saisissez que
              si votre commerce en a besoin.
            </li>
            <li>
              Produit suivi par lots : vérifiez aussi les « Lots remis au client
              » (voir <a href="#lots">plus bas</a>).
            </li>
            <li>
              Choisissez « Confirmer la vente ». La vente apparaît dans{" "}
              <strong>Ventes</strong>.
            </li>
          </ol>
          <p>
            Une vente peut être corrigée ou supprimée par la suite, selon vos
            droits. Supprimer une vente remet la quantité en stock.
          </p>
          <h3>Comprendre l&apos;activité</h3>
          <p>
            <strong>Analyse</strong> (droit « Voir les analyses ») présente le
            capital investi, le chiffre d&apos;affaires, le bénéfice, la marge,
            les unités vendues, l&apos;évolution mensuelle et les classements
            des produits et des vendeurs. Un bilan du mois écoulé est aussi
            produit au début de chaque mois.
          </p>
          <p>
            Quand un mois est choisi, la carte devient « Gain estimé du mois » :
            montant des ventes du mois moins le prix d&apos;achat actuel des
            produits vendus ce mois-là (prix conservé lors de la suppression
            d&apos;un produit). Si ce prix est inconnu pour une vente du mois,
            le gain est affiché « — » plutôt que faux.
          </p>
          <h3>Télécharger l&apos;historique d&apos;un mois</h3>
          <ul>
            <li>
              Le propriétaire et l&apos;administrateur trouvent, en haut de{" "}
              <strong>Analyse</strong>, le bloc « Historique mensuel » :
              choisissez un mois, puis « Télécharger en Excel » ou « Télécharger
              en PDF ».
            </li>
            <li>
              Le fichier contient un bilan du mois, toutes les ventes (date,
              produit, quantité, prix, montant, vendeur, acheteur), un
              récapitulatif par produit et par vendeur, et les corrections et
              annulations de ventes du mois.
            </li>
            <li>
              Les chiffres suivent les mêmes règles que l&apos;écran Analyse. Le
              nom d&apos;un produit est celui enregistré lors de la vente, même
              s&apos;il a été renommé ou supprimé depuis. Une valeur inconnue
              est notée « Information indisponible », jamais zéro.
            </li>
            <li>
              Les ventes encore en attente de synchronisation sur un appareil
              n&apos;y figurent pas : synchronisez-les avant de télécharger.
            </li>
            <li>
              Le PDF reproduit les noms à l&apos;identique (accents, œ,
              apostrophes comprises). Si un nom contient des caractères
              qu&apos;il ne peut pas reproduire (autre alphabet, émoji…), il est
              refusé avec un message : téléchargez alors l&apos;Excel, qui
              conserve les noms exactement.
            </li>
            <li>
              Le téléchargement nécessite une connexion Internet. Le fichier
              contient des informations sur les acheteurs : conservez-le en lieu
              sûr.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "lots",
      title: "Lots, péremption et pertes",
      content: (
        <>
          <p>
            Le suivi par lots sert aux produits dont les arrivages n&apos;ont
            pas la même date de péremption. Chaque lot a sa quantité, sa date
            (facultative) et son numéro. Tout se passe dans la section « Lots »
            de la fiche produit.
          </p>
          <h3>Activer le suivi par lots</h3>
          <ol>
            <li>
              Sur la fiche du produit, section « Lots », choisissez « Activer le
              suivi par lots » (droit « Activer le suivi par lots et répartir le
              stock existant »).
            </li>
            <li>
              Répartissez le stock actuel : « Je connais la répartition : une
              ligne par lot » (quantité, puis date de péremption et numéro de
              lot fabricant facultatifs), ou « Je ne connais pas la répartition
              : un lot historique, date inconnue ».
            </li>
            <li>
              Le total doit être exactement le stock affiché. Cochez la
              confirmation, puis « Valider la répartition ».
            </li>
          </ol>
          <p>
            Résultat : la fiche indique « Suivi du stock : Par lots ». Ce
            n&apos;est ni une vente ni une entrée de stock : le total ne change
            pas. Les dates des lots remplacent la date unique de la fiche («
            Reprendre la date de la fiche » la propose ligne par ligne, jamais
            automatiquement).{" "}
            <strong>Le suivi par lots ne peut pas être désactivé.</strong> Si
            une vente a eu lieu pendant la saisie, un message demande
            d&apos;actualiser le produit et de répartir à nouveau.
          </p>
          <h3>Recevoir des marchandises</h3>
          <ul>
            <li>
              « Nouveau lot » : quantité reçue, date de réception, date de
              péremption et numéro fabricant (droits « Gérer les produits » et «
              Ajuster le stock »).
            </li>
            <li>
              « Recevoir » sur un lot existant : seule la quantité est ajoutée
              (droit « Ajuster le stock »).
            </li>
          </ul>
          <h3>Vendre un produit suivi par lots</h3>
          <ol>
            <li>
              Dans « Enregistrer une vente », la partie « Lots remis au client »
              propose une répartition, péremption la plus proche d&apos;abord.
            </li>
            <li>
              Ajustez-la aux unités <strong>réellement remises</strong> : la
              somme des lots doit être égale à la quantité vendue. Rien
              n&apos;est réservé avant la confirmation.
            </li>
            <li>
              « Confirmer la vente ». La vente garde les lots choisis ; le
              serveur ne les remplace jamais. Si un lot n&apos;a plus assez
              d&apos;unités, la fenêtre reste ouverte et propose une nouvelle
              répartition.
            </li>
          </ol>
          <ul>
            <li>
              <strong>Lots sans date</strong> : listés à part, jamais proposés
              d&apos;office. Pour les vendre, cochez « Je confirme vendre des
              unités dont la date de péremption est inconnue ».
            </li>
            <li>
              <strong>Lot périmé</strong> : il n&apos;est plus proposé et{" "}
              <strong>ne peut plus être vendu</strong>, même remis à
              disposition.
            </li>
          </ul>
          <h3>Stock physique et stock vendable</h3>
          <p>
            <strong>La péremption seule ne retire pas le stock.</strong> Les
            unités d&apos;un lot périmé ou mis à l&apos;écart restent dans le
            stock physique (le « Stock restant ») tant qu&apos;aucune perte
            n&apos;est enregistrée. La section « Lots » distingue « Vendable
            aujourd&apos;hui » et le stock non vendable. Le seuil de stock
            faible se calcule sur le stock physique total, lots dépassés
            compris.
          </p>
          <p>
            Sur une fiche <strong>sans lots</strong>, au contraire, la date de
            péremption ne bloque pas les ventes.
          </p>
          <h3>Mettre un lot à l&apos;écart</h3>
          <p>
            « Mettre à l&apos;écart » (droit « Mettre un lot à l&apos;écart et
            le remettre à disposition ») retire le lot <strong>entier</strong>{" "}
            de la vente, avec un motif obligatoire, par exemple en attendant un
            contrôle. Aucune unité ne quitte le stock. « Remettre à disposition
            » le rend de nouveau vendable, sauf s&apos;il est périmé.
          </p>
          <h3>Enregistrer et corriger une perte</h3>
          <ol>
            <li>
              Sur un lot, « Enregistrer une perte » (droit « Enregistrer et
              corriger des pertes de stock »).
            </li>
            <li>
              Indiquez la quantité perdue et le motif : « Péremption », « Casse
              ou dommage » ou « Autre » (commentaire obligatoire). Cochez la
              confirmation, puis « Enregistrer la perte ».
            </li>
          </ol>
          <p>
            Résultat : les unités quittent le stock.{" "}
            <strong>Une perte n&apos;est jamais une vente</strong> : ni chiffre
            d&apos;affaires, ni unités vendues. Elle apparaît dans « Historique
            des pertes » et dans l&apos;Analyse. Perdre tout le stock restant
            d&apos;un lot le ferme (« Retiré »).
          </p>
          <p>
            Erreur de saisie ? Dans l&apos;historique des pertes, « Corriger »
            rend des unités au même lot, avec un motif. La perte d&apos;origine
            reste visible, et le lot garde son état : une remise en vente se
            fait explicitement.
          </p>
          <h3>Alertes de péremption</h3>
          <ul>
            <li>
              Deux catégories de notifications : « Péremption proche » (le lot
              ou le produit entre dans la période d&apos;alerte) et « Produits
              périmés » (date dépassée). Chacune est envoyée une seule fois par
              échéance, pour les produits encore en stock, aux membres qui ont
              le droit « Voir le détail du stock ».
            </li>
            <li>
              Elles concernent les lots et les produits sans lots qui ont une
              date. Une date est valable le jour même ; elle est dépassée le
              lendemain, selon le jour du commerce.
            </li>
            <li>
              Le délai se règle dans <strong>Analyse</strong>, bloc « Péremption
              et pertes », champ « Délai d&apos;alerte (jours) » (droit « Régler
              le délai des alertes de péremption ») : de 0 à 365 jours, 30 par
              défaut. 0 signifie une alerte le jour même de l&apos;échéance, pas
              une désactivation.
            </li>
            <li>
              Ce bloc liste aussi ce qui « Expire bientôt », les « Périmés » et
              les « Pertes du mois ».
            </li>
          </ul>
          <p>Mise à l&apos;écart et pertes demandent une connexion Internet.</p>
        </>
      ),
    },
    {
      id: "corbeille",
      title: "Corbeille, suppression définitive et historique des ventes",
      content: (
        <>
          <ul>
            <li>
              Supprimer un produit ou une catégorie le place dans la{" "}
              <strong>Corbeille</strong> (« Placer dans la corbeille »). Rien
              n&apos;est encore effacé : vous pouvez le « Restaurer ».
            </li>
            <li>
              Dans <strong>Corbeille</strong>, les catalogues et les produits
              sont listés séparément. Cochez un ou plusieurs éléments, puis «
              Restaurer » ou « Supprimer définitivement ». La suppression
              définitive efface le produit et sa photo : elle ne peut pas être
              annulée.
            </li>
            <li>
              L&apos;historique des ventes est conservé après une suppression
              définitive : les ventes passées gardent le nom du produit et
              restent comptées dans les analyses.
            </li>
          </ul>
          <p>La corbeille demande le droit « Gérer la corbeille ».</p>
        </>
      ),
    },
    {
      id: "hors-ligne",
      title: "Travailler sans connexion",
      content: (
        <>
          <p>
            {SITE.name} permet de continuer à vendre quand le réseau coupe, avec
            ces conditions :
          </p>
          <ul>
            <li>
              vous devez avoir ouvert l&apos;application avec du réseau dans les{" "}
              <strong>72 dernières heures</strong>, sur le même appareil et avec
              le même compte ;
            </li>
            <li>
              sans réseau, seuls le catalogue et l&apos;enregistrement des
              ventes sont disponibles. Ajouter des produits, consulter les
              analyses ou gérer l&apos;équipe demande une connexion ;
            </li>
            <li>
              le stock affiché sans réseau est indicatif : il ne tient pas
              compte des ventes faites entre-temps sur d&apos;autres appareils.
            </li>
          </ul>
          <h3>Synchronisation</h3>
          <ul>
            <li>
              Les ventes saisies sans réseau sont marquées « en attente » et
              envoyées automatiquement au retour de la connexion.
            </li>
            <li>
              Le serveur vérifie chaque vente. Si l&apos;une est refusée (stock
              insuffisant, droit retiré…), elle reste dans « Ventes en attente »
              : « Corriger », « Réessayer » ou, après confirmation, « Abandonner
              ». Une vente refusée ne bloque pas les autres.
            </li>
            <li>
              Un appareil garde au plus 200 ventes en attente, chacune pendant
              14 jours au plus. Si l&apos;envoi tarde, ouvrez « Ventes en
              attente » pour voir la raison et les corriger ou les relancer.
            </li>
            <li>La déconnexion ne supprime pas les ventes en attente.</li>
          </ul>
          <h3>Produits suivis par lots</h3>
          <ul>
            <li>
              Sans réseau, vous pouvez vendre un produit suivi par lots si ses
              lots ont été chargés avec du réseau sur cet appareil. Les
              quantités par lot ne sont pas vérifiées hors ligne : rien
              n&apos;est réservé.
            </li>
            <li>
              Si un lot choisi n&apos;a plus assez d&apos;unités ou n&apos;est
              plus disponible à la synchronisation, la vente est refusée :
              choisissez « Corriger » pour changer les lots.
            </li>
            <li>
              Si la vente a été saisie avant la péremption du lot mais reçue
              après, elle doit être régularisée. Avec le droit « Ajuster le
              stock », choisissez « Régulariser ». Sinon, choisissez « Demander
              une régularisation » : la demande apparaît dans la carte «
              Régularisations à examiner » de la page <strong>Ventes</strong>,
              où un responsable (droits « Ajuster le stock » et « Voir toutes
              les ventes ») choisit « Approuver » ou « Rejeter ». Rien
              n&apos;est enregistré avant son approbation.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "abonnement",
      title: "Abonnement et renouvellement",
      content: (
        <>
          <ul>
            <li>
              L&apos;essai de {TRIAL_DAYS} jours démarre à la création du
              commerce. Son état et sa date de fin sont visibles dans{" "}
              <strong>Organisation, puis Abonnement</strong>.
            </li>
            <li>
              Les durées et les prix figurent dans les{" "}
              <Link href="/conditions-abonnement">
                conditions d&apos;abonnement
              </Link>
              .
            </li>
            <li>
              Pour renouveler, le propriétaire choisit une durée dans
              Organisation, puis Abonnement, et paie en une fois par Mobile
              Money (MTN ou Orange) sur la page sécurisée de SasPay. Les frais
              de paiement sont pris en charge par Stock Master. De retour dans
              Stock Master, « Vérifier le paiement » confirme l&apos;abonnement.
              Pour toute question, écrivez-nous sur WhatsApp ou passez par{" "}
              <a href="#aide">l&apos;assistance</a>.
            </li>
            <li>
              À l&apos;échéance sans renouvellement, l&apos;accès au commerce
              est bloqué pour tous ses membres. Les données ne sont pas
              effacées, et les ventes en attente restent sur l&apos;appareil.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "notifications",
      title: "Notifications, installation et push",
      content: (
        <>
          <h3>Centre de notifications</h3>
          <p>
            La cloche en haut de l&apos;application ouvre vos notifications :
            stock épuisé ou presque épuisé, nouvelles ventes, péremption proche,
            produits périmés, régularisations à examiner, fin d&apos;essai ou
            d&apos;abonnement, paiement confirmé, bilan mensuel. Vous ne recevez
            que celles qui correspondent à vos droits.
          </p>
          <h3>Installer l&apos;application</h3>
          <ul>
            <li>
              Sur les navigateurs qui le permettent (par exemple Chrome), le
              bouton « Installer » ajoute {SITE.name} à l&apos;écran
              d&apos;accueil.
            </li>
            <li>
              Sur iPhone et iPad, dans Safari : touchez Partager, puis « Sur
              l&apos;écran d&apos;accueil ».
            </li>
          </ul>
          <h3>Activer ou désactiver les notifications sur l&apos;appareil</h3>
          <ol>
            <li>
              Ouvrez <strong>Organisation, puis Notifications</strong>.
            </li>
            <li>
              Choisissez « Activer les notifications », puis acceptez la demande
              du navigateur.
            </li>
            <li>Cochez les catégories qui vous intéressent.</li>
            <li>
              Pour arrêter, choisissez « Désactiver les notifications ». Vous
              pouvez aussi les bloquer dans les réglages du navigateur.
            </li>
          </ol>
          <p>
            Le réglage vaut pour cet appareil seulement. Sur iPhone et iPad, les
            notifications ne sont proposées qu&apos;à l&apos;application ajoutée
            à l&apos;écran d&apos;accueil.
          </p>
          <h3>Déconnexion et reconnexion</h3>
          <ul>
            <li>
              À la déconnexion, l&apos;appareil cesse de recevoir vos
              notifications ; vos choix de catégories sont conservés.
            </li>
            <li>
              À la reconnexion sur le même appareil, elles reprennent sans
              nouvelle demande du navigateur. Si l&apos;appareil a servi à un
              autre compte, {SITE.name} propose « Relier cet appareil aux
              notifications » : un clic suffit.
            </li>
            <li>
              « Plus tard » repousse l&apos;invitation de 7 jours sur cet
              appareil. Après « Désactiver les notifications », elle n&apos;est
              plus proposée automatiquement.
            </li>
          </ul>
          <p>
            L&apos;« abonnement » d&apos;un appareil aux notifications désigne
            seulement son inscription pour les recevoir.{" "}
            <strong>Il ne correspond à aucun paiement</strong> et n&apos;a aucun
            lien avec l&apos;abonnement du commerce.
          </p>
          <p>
            Les messages restent généraux sur l&apos;écran verrouillé. Si une
            notification n&apos;arrive pas sur un appareil, la cloche reste la
            référence.
          </p>
        </>
      ),
    },
    {
      id: "aide",
      title: "Besoin d'aide ?",
      content: (
        <>
          <h3>Sur WhatsApp (recommandé)</h3>
          <p>
            Écrivez-nous sur WhatsApp à toute heure, au{" "}
            <a
              href={WHATSAPP.url}
              target="_blank"
              rel="noopener noreferrer"
              translate="no"
            >
              {WHATSAPP.display}
            </a>
            . Nous vous répondons dès que possible.
          </p>
          <ul>
            <li>
              Dans l&apos;application, le bouton WhatsApp en bas de l&apos;écran
              ou <strong>Organisation, puis Assistance</strong> permettent de
              préparer un sujet et un message, puis de choisir « Continuer sur
              WhatsApp ». Sur le site, le même bouton est en bas à droite des
              pages.
            </li>
            <li>
              WhatsApp s&apos;ouvre avec votre texte : envoyez-le pour démarrer
              la conversation. {SITE.name} n&apos;envoie rien à votre place et
              n&apos;ajoute aucune information de votre compte.
            </li>
            <li>
              La conversation se poursuit dans WhatsApp :{" "}
              <strong>
                elle n&apos;est ni enregistrée ni synchronisée dans {SITE.name}
              </strong>
              , et elle ne crée pas de demande d&apos;assistance.
            </li>
            <li>
              Ne partagez jamais votre mot de passe ni un code reçu par SMS ou
              par e-mail.
            </li>
          </ul>
          <h3>Par e-mail, depuis l&apos;application</h3>
          <ol>
            <li>
              Ouvrez <strong>Organisation, puis Assistance</strong>, section «
              Par e-mail ».
            </li>
            <li>
              Choisissez une catégorie (Utilisation, Abonnement, Problème
              technique, Autre), puis écrivez un sujet et votre message.
            </li>
            <li>
              Vérifiez le bloc « Informations transmises au service client » :
              votre nom, votre e-mail, votre commerce, votre rôle et des
              identifiants sont joints automatiquement pour retrouver votre
              compte. Aucune vente ni aucun contact d&apos;acheteur n&apos;est
              joint.
            </li>
            <li>
              Choisissez « Envoyer au service client ». Une référence de demande
              s&apos;affiche : notez-la. La réponse arrive à votre adresse
              e-mail.
            </li>
          </ol>
          <p>
            L&apos;envoi demande une connexion Internet. En cas d&apos;échec,
            votre texte reste sur l&apos;écran : réessayez sans le retaper. Le
            propriétaire et les administrateurs ont accès à l&apos;Assistance ;
            un vendeur seulement si le droit « Contacter le service client » lui
            a été donné.
          </p>
          <h3>Sans accès à votre commerce</h3>
          <p>
            Écrivez-nous sur WhatsApp, ou à <MailLink to="support" />, en
            précisant le nom de votre commerce, l&apos;écran concerné et ce que
            vous avez essayé. Les autres contacts sont sur la page{" "}
            <Link href="/contact">Contact</Link>.
          </p>
        </>
      ),
    },
  ],
};

export default content;
