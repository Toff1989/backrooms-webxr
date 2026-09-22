# Fiche projet — Backrooms VR (titre provisoire)

## Concept
Jeu d'exploration horrifique en VR, dans le navigateur (WebXR). Le joueur erre dans des Backrooms générées à l'infini, filmées comme une cassette VHS des années 90. Chaque level a une sortie à trouver ; la run est infinie et le score correspond à la profondeur atteinte. Le labyrinthe change en temps réel, des glitchs piégés brouillent la vision, et des objets de lore sont à collectionner sans limite.

## Plateforme & contraintes
- **Cible** : Meta Quest 2/3 autonome, navigateur Meta Quest (`immersive-vr`)
- **Perfs** : 72 fps minimum (90 sur Quest 3), moins de 100 draw calls, textures 1K max en KTX2
- **Tests** : Immersive Web Emulator (Chrome) en dev, casque pour validation
- **Langues** : français + anglais (UI et lore)

## Stack technique
| Rôle | Outil |
|---|---|
| Rendu 3D + WebXR | Three.js (`WebXRManager`) |
| Langage / build | TypeScript + Vite (HTTPS local via `vite-plugin-mkcert`) |
| Génération | `simplex-noise` + PRNG seedé (`seedrandom`), code partagé client/serveur |
| Collisions | Grille maison (murs alignés sur les cellules) |
| Textures | Poliigon (catégorie Backrooms) → KTX2/Basis |
| Meshes | Packs CC0 glTF + Draco |
| Audio | Web Audio API / `THREE.PositionalAudio` |
| Stockage local | IndexedDB (`idb-keyval`) |
| i18n | Fichiers JSON `fr.json` / `en.json` |
| API classement | Node.js (Fastify ou Express) + SQLite (`better-sqlite3`) |
| Déploiement | Docker Compose sur le serveur perso + reverse proxy HTTPS (Caddy ou Nginx + Let's Encrypt) |

## Gameplay
### Boucle d'une run
1. Démarrage : le serveur fournit une seed de run + un token signé
2. Exploration du level, esquive des glitchs, ramassage d'objets
3. Sortie trouvée → level suivant (seed dérivée), profondeur +1
4. Le joueur arrête quand il veut : action "STOP REC" sur le menu poignet
5. Fin de run : saisie du pseudo → envoi du score au classement

### Locomotion
- Déplacement fluide au joystick gauche, snap-turn au joystick droit
- Vignette de confort pendant le mouvement (activable dans les options)

### Levels procéduraux
- Monde en chunks (ex. 8×8 cellules de 2,5 m, aligné sur les textures Poliigon)
- Streaming autour du joueur (rayon de 2 chunks), `InstancedMesh` + merge par chunk
- Chaque level = seed + profil (palette, densité de murs, hauteur plafond, fréquence des glitchs, jeu de textures)
- Difficulté croissante avec la profondeur (labyrinthe plus dense, sortie plus loin, glitchs plus fréquents)
- Sortie placée à distance minimale du spawn, signalée par des indices (son, lumière différente)

### Labyrinthe dynamique
- Régénération à intervalle aléatoire des chunks hors du champ de vision (frustum + distance)
- Transition masquée par un glitch visuel à l'approche du joueur

### Glitchs (pièges)
- Types : mur qui surgit ou se déplace, boucle spatiale (renvoi au début du couloir), zone de corruption
- Signaux avant-coureurs : grésillement audio, néon qui clignote, vibration des manettes
- **Effet au contact** : distorsion visuelle uniquement (flou, dérive des couleurs, bruit VHS renforcé)
- Intensité cumulable (plusieurs glitchs = vue plus dégradée), **dissipation progressive** dans le temps
- Pas de mort ni de game over : la difficulté vient de la vision brouillée
- Confort VR : aucune distorsion de la position/rotation caméra, effets appliqués en shader uniquement

### Objets & collection
- Génération infinie : mesh de base (pool CC0) + variations (couleur, échelle, étiquette) + nom/description de lore générés par templates seedés en FR et EN
- Ramassage au grip → objet rangé dans un sac par-dessus l'épaule
- Menu poignet : consultation de la collection (tri par profondeur/rareté, pagination)
- **Persistance** : seule la collection est conservée entre les runs (IndexedDB) ; la progression repart de zéro à chaque run

## Direction artistique — VHS 90's adaptée à la VR
- Effet VHS dans les matériaux (`onBeforeCompile`) : grain animé, quantification des couleurs, légère aberration chromatique, teinte jaunâtre délavée
- Scanlines/bruit très subtils sur un quad fixé à la tête
- Overlay caméscope en panneau 3D (REC, horodatage, batterie, profondeur actuelle)
- Glitchs forts réservés aux événements : bandes décalées, perte de signal, écran bleu VHS bref
- Pas de post-processing `EffectComposer` (non pris en charge nativement en WebXR, trop coûteux sur Quest)
- Éclairage : néons émissifs + ambiance bakée, pas d'ombres dynamiques
- Brouillard (`FogExp2`) pour masquer le streaming des chunks

## Classement en ligne
### Identification
- ID anonyme généré au premier lancement (UUID stocké en IndexedDB)
- Pseudo choisi en fin de run, filtré par liste de mots interdits (FR + EN)

### Anti-triche (validation serveur)
- `POST /run/start` → le serveur crée la run (seed, timestamp de départ) et renvoie un token signé (HMAC)
- Le client envoie chaque changement de level (`POST /run/level`) avec le token
- Le serveur régénère le level à partir de la seed (même code de génération partagé) et vérifie :
  - que le temps passé sur le level dépasse le minimum plausible (distance spawn→sortie / vitesse max)
  - l'ordre et la continuité des levels
- `POST /run/end` avec le pseudo → score validé = profondeur atteinte
- Rate-limiting par ID et par IP

### API
| Endpoint | Rôle |
|---|---|
| `POST /run/start` | Création de run, seed + token |
| `POST /run/level` | Validation d'un passage de level |
| `POST /run/end` | Clôture + pseudo |
| `GET /leaderboard` | Top N (profondeur, pseudo, date) |

### Données SQLite
- `runs` : id, player_id, seed, started_at, ended_at, depth, pseudo, status
- `levels` : run_id, index, reached_at

## Déploiement
- `docker-compose.yml` : conteneur front (build Vite statique), conteneur API Node, volume SQLite
- Reverse proxy HTTPS devant les deux (même domaine, `/api` vers Node)
- Sauvegarde régulière du fichier SQLite

## Assets
- Textures : poliigon.com/textures/backrooms (vérifier la licence de chaque texture)
- Props CC0 : loafbrr.itch.io/backrooms-like-asset-pack, elbolilloduro.itch.io/bacx
- Pipeline : décimation Blender → glTF + Draco, textures → KTX2

## Roadmap
1. **Proto** : scène WebXR, locomotion fluide + vignette, un chunk statique texturé
2. **Génération** : chunks infinis seedés, streaming, collisions, code partagé client/serveur
3. **Look** : shader VHS matériaux, overlay caméscope, néons, brouillard, audio
4. **Levels** : sortie, profils, difficulté progressive, compteur de profondeur
5. **Glitchs** : pièges, signaux, distorsion cumulable et dissipation, labyrinthe dynamique
6. **Collection** : génération d'objets FR/EN, grab, sac, menu poignet, IndexedDB
7. **Classement** : API Node + SQLite, validation serveur, filtre pseudos, écran de fin de run
8. **Déploiement** : Docker Compose, reverse proxy HTTPS, sauvegardes
9. **Optimisation Quest** : profiling fps/draw calls, réglages de confort
