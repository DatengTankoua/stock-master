# Storyboard — Stock Master, une journée chez RoyalVibe Cosmétique

Theme: direction « Vitrine marine » (validée le 14/10/2026) (grammaire de la référence 01 + thème 053 Editorial Data du kit) · Format: 1920x1080 · Length: 90 s · Sound: voix off + musique discrète + effets doux

## Message & tone
- **Sentence:** I want to say "votre stock et vos ventes restent sous contrôle, même en équipe et même sans réseau" in a trustworthy tone, so the viewer feels rassuré et capable de commencer.
- **Tone arc:** bold → bold → trustworthy → warm → trustworthy → calm → warm
- accent: orange Stock Master `#FF6A00` (un seul accent ; le vert de RoyalVibe n'existe que dans les captures)
- **Motif:** le chiffre qui change (stock 3 → 2, puis « 1 seule fois », puis les totaux) revient trois fois, toujours en orange.

## Ledger

| # | start | dur | beat | tone | entrance | transition_out | ease | direction | palette | camera | components | new_component | sfx | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 0:00 | 2.4 | hook | bold | word-rise | T04 Beat Cut with Hold-frame | power3.out | bottom | navy+orange | slow-drift | product-wall | | soft-tick | première question, mot « reste-t-il » en orange ; ref:01 |
| 2 | 0:02.4 | 2.6 | hook | bold | word-drop | T15 Focal Iris | expo.out | top | navy+mist | slow-drift | product-wall | | soft-tick | seconde question ; iris ouvert depuis le mot orange |
| 3 | 0:05 | 3.0 | reveal | bold | scale-from-centre | T13 Product-Shape Mask | expo.out | radial | paper+navy | locked | logo | | warm-stab | surprise: passage au fond clair, logo officiel |
| 4 | 0:08 | 6.0 | proof | trustworthy | mask-left | T11 Dolly-Out Reveal | power2.out | left | navy+mist | push-in | phone, rayons, rayon-laits | | tap | tap réel sur « Laits corporels » puis défilement de la vraie liste |
| 5 | 0:14 | 6.0 | proof | trustworthy | tilt-in | T07 Cursor Carry | sine.inOut | right | navy+mist | perspective-pan | laptop-panel, callouts | | swipe-soft | surprise: changement de support (bureau incliné) ; ref:01 |
| 6 | 0:20 | 6.5 | proof | trustworthy | slide-up | crossfade | power3.out | bottom | navy+mist | locked | phone, sale-dialog | | tap | Junior ouvre la fiche et touche « Enregistrer une vente » |
| 7 | 0:26.5 | 4.0 | proof | bold | counter-roll | motif:counter-cut | power3.inOut | top | orange+navy | push-in | stock-counter | | confirm | surprise: le 3 roule vers le 2 en très grand ; motif:digit |
| 8 | 0:30.5 | 4.5 | proof | trustworthy | badge-pop | T05 Object Carry | power2.out | right | navy+orange | slow-push | stock-badge | | soft-tick | le badge « Stock faible » est porté jusqu'à la notification |
| 9 | 0:35 | 5.0 | proof | warm | slide-right | T12 Parallax Slide | expo.out | right | navy+mist | two-phones | notifications | | notify | surprise: deux téléphones côte à côte (vendeur / propriétaire) |
| 10 | 0:40 | 8.0 | proof | warm | type-on | T10 Whip Pan with Motion Blur | power2.inOut | left | navy+mist | locked | members, rights-dialog | | tick | coche réelle « Voir toutes les ventes » puis « Membre mis à jour » |
| 11 | 0:48 | 4.5 | problem | trustworthy | fade-desaturate | crossfade | sine.inOut | left | navy+mist | locked | phone-offline, wire | | dropout | surprise: le son baisse, le fil se coupe |
| 12 | 0:52.5 | 4.0 | proof | trustworthy | slide-up | motif:counter-cut | power3.out | bottom | navy+mist | push-in | sale-dialog-offline, packet | | tap | vente saisie hors ligne : « en attente » |
| 13 | 0:56.5 | 6.5 | proof | trustworthy | packet-travel | T08 Line-to-Horizon | power3.inOut | right | orange+navy | locked | wire, packet | sync-thread | confirm | le fil se referme, le paquet part une fois ; motif:digit « 1 seule fois » |
| 14 | 1:03 | 7.0 | proof | calm | line-to-chart | T09 Push-Through | power4.out | bottom | paper+navy | slow-dolly | laptop-analytics, kpi | | soft-tick | surprise: fond clair ; totaux réels 440 700 FCFA / 117 ventes ; motif:digit |
| 15 | 1:10 | 7.0 | proof | calm | slide-left | T01 Match Cut: Shape | sine.inOut | left | paper+navy | push-in | phone-chart, export | | tap | bouton « Télécharger en Excel » → pastille orange de l'appel à l'action |
| 16 | 1:17 | 13.0 | cta | warm | rise-soft | end | power2.out | center | paper+orange | slow-rotate | lockup, cta | | warm-stab | surprise: silence musical court avant le logo |

## The seven questions (answer before you build)
1. **Dire quoi, sur quel ton ?** Voir la phrase ci-dessus : confiance, jamais de promesse chiffrée.
2. **Répétitions ?** Audit du kit (`variety_audit.py`) : voir la sortie consignée dans `docs/architecture/phase-1-23a-stock-master-motion.md`.
3. **Sens des transitions.** Iris : la question appelle la réponse. Masque de forme : la marque ouvre sur le produit. Dolly arrière : un rayon fait partie d'un catalogue. Report du curseur : on touche ce qu'on va voir. Report d'objet : l'alerte de stock devient la notification. Glissé parallaxe : on passe du vendeur à la propriétaire. Filé : « pendant ce temps, le réseau coupe ». Ligne d'horizon : la ligne de synchronisation devient l'axe du graphique. Raccord de forme : le bouton orange d'export devient l'appel à l'action.
4. **Couleur dans le temps.** Marine dominant ; l'orange n'éclate que trois fois (stock, synchronisation, appel à l'action) ; deux respirations claires (logo, analyse).
5. **Composant nouveau.** Le fil de synchronisation (plan 13).
6. **Surprises.** Toutes les 15 s au plus (plans 3, 5, 7, 9, 11, 14, 16).
7. **Répète un film précédent ?** Premier film du dépôt ; historique local `storyboard/motion-ledger.json`.

## Séquences (exigences du lot)

Durées indicatives : elles seront ajustées sur la voix Gemini réelle (texte, pauses, plans ; jamais en coupant ou en accélérant la voix).

### A · 0–8 s · Accroche
- **Bénéfice :** savoir, sans chercher, ce qui reste et ce qui s'est vendu.
- **Action montrée :** mur des 24 produits réels de RoyalVibe ; questions ; logo Stock Master.
- **Texte à l'écran :** « Combien en reste-t-il ? » / « Qui a vendu quoi ? »
- **Voix off :** « Combien reste-t-il de lait de karité en rayon ? Qui a vendu quoi aujourd'hui ? Avec Stock Master, vous le savez. »
- **Transition :** iris depuis le mot orange vers le fond clair, puis le cube du logo ouvre sur le catalogue.

### B · 8–20 s · Retrouver et organiser ses produits
- **Bénéfice :** chaque produit retrouvé en un geste, avec sa photo, son prix et son stock.
- **Action montrée :** rayons → « Laits corporels » (vraie liste avec photos), puis la même grille sur ordinateur.
- **Texte à l'écran :** « Chaque produit, sa fiche. » ; repères « Photo · Prix en FCFA · Stock ».
- **Voix off :** « Chez Royal Vibe Cosmétique, chaque produit a sa fiche : sa photo, son prix en francs CFA, son stock. Et tout est rangé par rayon. »
- **Transition :** recul de caméra vers l'écran d'ordinateur, puis toucher sur « Huile d'argan ».

### C · 20–35 s · Enregistrer une vente
- **Bénéfice :** le stock suit chaque vente, sans calcul.
- **Action montrée :** Junior ouvre « Huile d'argan 50 ml », « Enregistrer une vente », quantité 1 à 6 000 FCFA, « Confirmer la vente » ; « Vente enregistrée » ; stock 3 → 2 ; badge « Stock faible ».
- **Texte à l'écran :** « Une vente. Le stock suit. » ; compteur « Stock restant 3 → 2 ».
- **Voix off :** « Une cliente prend une huile d'argan. Junior enregistre la vente… et le stock passe de trois à deux. Stock Master signale aussitôt un stock faible. »
- **Transition :** le badge orange glisse vers le téléphone de la propriétaire.

### D · 35–48 s · Travailler en équipe
- **Bénéfice :** la propriétaire est informée et décide des droits de chacun.
- **Action montrée :** cloche de Mireille (2 notifications réelles : « Nouvelle vente enregistrée », « Le stock d'un produit est presque épuisé ») ; Membres ; « Modifier Grâce Ewane » ; coche « Voir toutes les ventes » ; « Membre mis à jour ».
- **Texte à l'écran :** « Mireille est prévenue. » ; « Vous décidez qui fait quoi. » ; « Vendre · Ajuster le stock · Voir toutes les ventes ».
- **Voix off :** « Mireille, la propriétaire, est prévenue. C'est elle qui choisit les droits de chacun : vendre, ajuster le stock, voir toutes les ventes. »
- **Transition :** filé horizontal : « pendant ce temps, à la boutique… ».

### E · 48–63 s · Vendre pendant une coupure, puis synchroniser
- **Bénéfice :** la boutique continue de vendre quand le réseau coupe.
- **Action montrée :** téléphone de Grâce hors connexion (bandeau réel), vente de 2 savons noirs « en attente » ; retour du réseau ; « Récemment synchronisées (1) », 0 en attente ; côté serveur une seule vente reçue, stock 37 → 35.
- **Texte à l'écran :** « Sans réseau, la vente continue. » ; encadré « Préparation : application ouverte en ligne sur ce téléphone, avec ce compte, dans les 72 h précédentes. Hors ligne : catalogue et ventes seulement. » ; « Réseau coupé » ; « 1 vente reçue · 1 seule fois ».
- **Voix off :** « Le réseau coupe ? Grâce continue de vendre. Au retour de la connexion, la vente est envoyée, une seule fois, et le stock se met à jour. »
- **Transition :** la ligne de synchronisation devient l'axe du graphique de l'analyse.

### F · 63–77 s · Historique et analyse
- **Bénéfice :** comprendre son activité et préparer le réassort.
- **Action montrée :** Analyse sur ordinateur (« Stock faible : Huile d'argan 50 ml : 2 en stock », 440 700 FCFA, 117 ventes) ; « Ventes par jour » sur téléphone ; « Télécharger en Excel » (fichier réel).
- **Texte à l'écran :** « Votre activité, au clair. » ; montant des ventes, nombre de ventes, stock faible (chiffres relevés) ; « Produits classés par montant vendu » ; nom réel du fichier exporté « · Excel ou PDF ».
- **Voix off :** « Le soir, l'analyse fait le point : le montant des ventes, les produits classés par montant vendu, et les stocks faibles. L'historique du mois se télécharge en Excel ou en PDF. »
- **Transition :** le bouton orange devient la pastille de l'appel à l'action.

### G · 77–90 s · Conclusion
- **Bénéfice :** savoir où commencer.
- **Action montrée :** logo Stock Master, phrase de marque, adresse du site.
- **Texte à l'écran :** « Vos produits, vos ventes, votre équipe. » ; « Découvrez Stock Master » ; « stock-master.app » en grand. Pas de mention d'essai gratuit (décision du 14/10).
- **Voix off :** « Vos produits, vos ventes, votre équipe : tout est au même endroit. Découvrez Stock Master sur stock tiret master point app. »
- **Transition :** fin sur le logo, musique qui se résout.
