# Brief — Stock Master, film de présentation (lot 1-23A)

| | |
|---|---|
| **Message unique** | Avec Stock Master, un commerçant sait à tout moment ce qu'il a en stock et ce qui s'est vendu, même avec une équipe et même quand le réseau coupe. |
| **Public** | Commerçants et responsables de petites entreprises au Cameroun. |
| **Objectif** | Comprendre l'utilité de Stock Master et savoir comment commencer. |
| **Format** | Master 1920 × 1080, 30 i/s, 90 s. Composition centrée sur le téléphone, déclinable en vertical (non produit ici). |
| **Son** | Voix off française (Gemini TTS, fournie plus tard), musique discrète, quelques effets doux. Compréhensible sans le son. |
| **Source de vérité** | Le code du dépôt (`subscription-pricing.ts`, `permissions.ts`, guide `web/src/i18n/documents/guide/fr.tsx`) et l'application locale de démonstration. Aucun chiffre de clientèle, aucun témoignage, aucun résultat promis. |
| **Commerce de démonstration** | RoyalVibe Cosmétique (fictif dans la recette) : 4 comptes, 5 rayons, 24 produits, ventes sur 13 jours. Mention « Données de démonstration » sur les plans d'application. |
| **Ton** | Chaleureux, professionnel, assuré. Énergie à l'accroche, explications posées, conclusion engageante. Jamais de téléachat. |

## Composants (réel ou imaginaire)

| Composant | Choix | Raison |
|---|---|---|
| Écrans de l'application (catalogue, fiche, vente, notifications, membres, hors ligne, analyse, export) | **Réel** : captures de l'application locale, à l'échelle 3 | Exigence du lot : aucune interface fictive. |
| Compteur de stock (3 → 2) | Mise en valeur d'un chiffre **réel** relevé à l'écran | Lisibilité sur téléphone. |
| Fil de synchronisation (paquet envoyé une fois) | **Nouveau composant**, simplification véridique | Montre ce qui a été vérifié : une vente hors ligne, reçue une seule fois. |
| Mur de produits (accroche) | Photos réelles du catalogue de démonstration | Ancre le film dans le commerce. |
| Marque | Logo officiel Stock Master (`web/public/brand`), police Geist (celle de l'application), marine `#062B5C` et orange `#FF6A00` | Jamais redessiné. |

## Appel à l'action

`stock-master.app` (source : `web/src/lib/legal/site-identity.ts`). Variante « Essai gratuit de 7 jours » (`TRIAL_DAYS = 7`) **seulement si** l'inscription publique est ouverte à la diffusion (défaut de production : `PUBLIC_REGISTRATION_ENABLED=false`). Aucun tarif ni plafond de produits dans les accroches.
