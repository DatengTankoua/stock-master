# Voix off Stock Master — consignes Gemini TTS (prêtes à copier)

Rédigé d'après la documentation officielle consultée le 14 octobre 2026
(<https://ai.google.dev/gemini-api/docs/speech-generation>). Aucun appel à Gemini n'a été fait dans ce lot.
Vérifiez la page avant génération : modèles et voix évoluent.

Texte parlé seul : `voiceover-fr.txt` — **165 mots** (comptés par espaces ; 170 en séparant les
élisions comme « d'argan »). Recompté sur le fichier livré.

## Ce que dit la documentation (et seulement cela)

- Modèles TTS actuels : `gemini-3.8-flash-tts` (et `gemini-3.8-flash-lite-tts`). Le français est pris en charge ; la langue est **détectée automatiquement**.
- Le champ `text` est traité **mot à mot comme le texte prononcé**. Les consignes de jeu vont dans l'annotation `speech_metadata`, champ `style` (langage naturel).
- Balises entre chevrons, dont **`<short pause>`** et **`<long pause>`**. Pas de SSML mentionné : n'en mettez pas.
- Majuscules pour appuyer un mot ; virgules, tirets et points de suspension pour les hésitations naturelles.
- Tester d'abord **sans style**, garder un style court, ne pas mettre d'âge, de genre, de nom ni d'accent permanent dans `style` (l'accent se choisit par la voix).
- Sortie par défaut : WAV 24 kHz, mono, 16 bits. Aucun paramètre de durée n'est documenté.

## Voix proposées (voix prédéfinies de la documentation)

| Ordre | Voix | Caractère indiqué |
|---|---|---|
| 1 | **Sulafat** | Warm |
| 2 | Achird | Friendly |
| 3 | Charon | Informative |

La bibliothèque étendue (`client.voices.list()`) peut proposer des voix régionales françaises ; je n'en
ai consulté aucune et n'en nomme donc aucune.

## Style (champ `style`)

```
Voix chaleureuse, professionnelle et assurée. Français naturel et bien articulé, débit posé. Énergie franche sur la première phrase, puis explications calmes, conclusion engageante. Ton conversationnel, jamais publicitaire.
```

Pas de consigne d'accent : si la voix sonne trop « français de France » pour le public visé, changez de
voix plutôt que d'ajouter un accent.

## 1. Prise complète (à privilégier)

Une seule requête, un seul fichier : `voiceover-fr.wav`. Collez **exactement** ce texte dans `text`
(les balises font partie du texte ; les `<long pause>` séparent les sept scènes) :

```
Combien reste-t-il de lait de karité en rayon ? <short pause> Qui a vendu quoi aujourd'hui ? <short pause> Avec Stock Master, vous le savez. <long pause> Chez Royal Vibe Cosmétique, chaque produit a sa fiche : sa photo, son prix en francs CFA, son stock. <short pause> Et tout est rangé par rayon. <long pause> Une cliente prend une huile d'argan. <short pause> Junior enregistre la vente… et le stock passe de trois à deux. <short pause> Stock Master signale aussitôt un stock faible. <long pause> Mireille, la propriétaire, est prévenue. <short pause> C'est elle qui choisit les droits de chacun : vendre, ajuster le stock, voir toutes les ventes. <long pause> Le réseau coupe ? <short pause> Grâce continue de vendre. <short pause> Au retour de la connexion, la vente est envoyée, une seule fois, et le stock se met à jour. <long pause> Le soir, l'analyse fait le point : le montant des ventes, les produits classés par montant vendu, et les stocks faibles. <short pause> L'historique du mois se télécharge en Excel ou en PDF. <long pause> Vos produits, vos ventes, votre équipe : tout est au même endroit. <short pause> Découvrez Stock Master sur stock tiret master point app.
```

Je repérerai les sept scènes sur les silences longs mesurés dans le fichier, puis j'adapterai le montage
à cette durée réelle, sans accélérer ni couper la voix.

## 2. Reprises par scène (seulement si nécessaire)

Si une phrase est à refaire, régénérez la scène seule, même voix et même style, et nommez-la
`vo-s<n>.wav` : elle remplacera le passage correspondant de la prise complète.

| Fichier | Repère indicatif | Texte (`text`) |
|---|---|---|
| `vo-s1.wav` | ≈ 7 s | `Combien reste-t-il de lait de karité en rayon ? <short pause> Qui a vendu quoi aujourd'hui ? <short pause> Avec Stock Master, vous le savez.` |
| `vo-s2.wav` | ≈ 9 s | `Chez Royal Vibe Cosmétique, chaque produit a sa fiche : sa photo, son prix en francs CFA, son stock. <short pause> Et tout est rangé par rayon.` |
| `vo-s3.wav` | ≈ 10 s | `Une cliente prend une huile d'argan. <short pause> Junior enregistre la vente… et le stock passe de trois à deux. <short pause> Stock Master signale aussitôt un stock faible.` |
| `vo-s4.wav` | ≈ 9 s | `Mireille, la propriétaire, est prévenue. <short pause> C'est elle qui choisit les droits de chacun : vendre, ajuster le stock, voir toutes les ventes.` |
| `vo-s5.wav` | ≈ 10 s | `Le réseau coupe ? <short pause> Grâce continue de vendre. <short pause> Au retour de la connexion, la vente est envoyée, une seule fois, et le stock se met à jour.` |
| `vo-s6.wav` | ≈ 11 s | `Le soir, l'analyse fait le point : le montant des ventes, les produits classés par montant vendu, et les stocks faibles. <short pause> L'historique du mois se télécharge en Excel ou en PDF.` |
| `vo-s7.wav` | ≈ 7 s | `Vos produits, vos ventes, votre équipe : tout est au même endroit. <short pause> Découvrez Stock Master sur stock tiret master point app.` |

Les repères sont des estimations, pas des promesses. Si le total déborde, on raccourcit d'abord le
texte ou les pauses, puis on ajuste les plans.

## Prononciation (à vérifier à l'écoute)

| Mot | Attendu | Si c'est mal prononcé |
|---|---|---|
| Stock Master | « stok mastèr », deux mots | garder deux mots séparés |
| francs CFA | « francs cé-èf-a » | écrire `francs C.F.A.` |
| Royal Vibe | « royal vaïbe » | écrire `Royal Vaïbe` dans le texte parlé seulement |
| stock tiret master point app | l'adresse `stock-master.app`, tiret compris | conserver cette écriture ; l'écran affiche `stock-master.app` |
| PDF, Excel | « pé-dé-èf », « ex-cel » | laisser tel quel |

La documentation ne propose aucun mécanisme phonétique : les corrections passent par l'orthographe du
texte parlé uniquement.

## Requête (forme de l'exemple officiel)

Remplacez `text` par le texte de la prise complète ci-dessus (apostrophes à échapper en shell, ou
utilisez un fichier JSON). La clé `GEMINI_API_KEY` reste chez vous.

```bash
curl -X POST "https://generativelanguage.googleapis.com/v1beta/interactions" \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -H "Content-Type: application/json" \
  -d @requete-voix.json \
  | jq -r '[.steps[] | select(.type=="model_output") | .content[] | select(.type=="audio")] | last | .data' \
  | base64 --decode > voiceover-fr.wav
```

`requete-voix.json` :

```json
{
  "model": "gemini-3.8-flash-tts",
  "input": [{
    "type": "user_input",
    "content": [{
      "type": "text",
      "text": "<texte de la prise complète>",
      "annotations": [{
        "type": "speech_metadata",
        "style": "Voix chaleureuse, professionnelle et assurée. Français naturel et bien articulé, débit posé. Énergie franche sur la première phrase, puis explications calmes, conclusion engageante. Ton conversationnel, jamais publicitaire."
      }]
    }]
  }],
  "response_format": { "type": "audio" },
  "generation_config": { "speech_config": [ { "voice": "Sulafat" } ] }
}
```

Dans Google AI Studio (recommandé par la documentation pour tester) : modèle TTS, voix, texte et
consigne de style dans les champs prévus.

## Livraison

Déposez le fichier dans `marketing/stock-master-motion/film/assets/audio/voice/` (WAV tel que généré,
sans retouche). Je mesurerai sa durée et ses silences, recalerai les scènes et les sous-titres, puis
rendrai le master.
