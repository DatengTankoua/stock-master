# Emplacement audio (remplaçable)

| Dossier / fichier | Contenu | État |
|---|---|---|
| `voice/voiceover-fr.wav` | prise **complète** Gemini TTS (à privilégier) | à fournir (`voice/gemini-tts-direction-fr.md`) |
| `voice/vo-s<n>.wav` | reprises par scène, seulement si nécessaire | facultatif |
| `music/afro-house-455843.mp3` | « Afro House », Artsiom Bialou (Pixabay, sans Content ID) | retenue provisoirement |
| `sfx/` | effets doux synthétisés par `tools/warm_sfx.py` du kit | générés |

À réception : `node scripts/produce-master.js` (recalage sans accélération, rendus, SRT, livrables,
contrôles). Remplacer la musique : même nom de fichier, ou modifier `scripts/sync-cues.js`.
