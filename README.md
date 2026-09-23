# Backrooms VR (titre provisoire)

Jeu d'exploration horrifique en VR, dans le navigateur (WebXR). Voir la fiche projet pour le concept complet.

**État actuel : étape 8 de la roadmap (déploiement)** — scène WebXR, locomotion fluide +
snap-turn, génération par chunks streamés avec collisions, levels avec sortie signalée (portail
VHS, pas un simple anneau) et difficulté progressive, deux types de pièges glitch (zones de
corruption + murs qui surgissent) et un labyrinthe dynamique. Décor (mobilier CC0) et ~50 objets
de collection (vrais modèles CC0, rareté fixe par objet) avec physique légère (bousculade, chute),
ramassage/manipulation au grip, menu poignet, persistance IndexedDB. Classement en ligne (API
Node + SQLite, validation anti-triche serveur, filtre pseudo, écran de fin de run) et
déploiement (Docker + scripts SSH/PM2 pour Plesk).

## Stack

Three.js (WebXRManager) + TypeScript + Vite (HTTPS local via `vite-plugin-mkcert`) +
`simplex-noise` / `seedrandom` pour la génération procédurale seedée.

## Démarrage

Le front seul fonctionne sans backend (seed locale de secours, voir `main.ts`), mais le
classement (étape 7) a besoin du serveur API :

```bash
npm install
npm run dev            # front, https://localhost:5173

cd server
npm install
npm run dev            # API, http://127.0.0.1:8787 — proxiée par Vite sous /api en dev
```

Le serveur de dev front tourne en HTTPS (requis par WebXR hors `localhost`) grâce à
`vite-plugin-mkcert`, qui génère un certificat local à la première exécution (nécessite un accès
réseau sortant vers GitHub pour télécharger le binaire `mkcert` ; si ce téléchargement échoue dans
un environnement restreint, `http://localhost` fonctionne aussi car les navigateurs le considèrent
comme un contexte sécurisé).

- **Test sans casque** : `npm run dev:open` ouvre automatiquement le navigateur. Installer
  [Immersive Web Emulator](https://chromewebstore.google.com/detail/immersive-web-emulator/cgffilbpcibhmcfbgggfhfolhkfbhmik)
  (extension Chrome) pour simuler une session WebXR et des manettes : ouvrir les DevTools (F12),
  onglet **WebXR**, choisir un device puis cliquer **Enter VR** sur la page. Les panneaux de
  contrôleurs affichent les touches clavier mappées à chaque joystick/bouton (ex. WASD pour le
  joystick gauche) — **une pression = un aller-retour complet de l'axe (modèle toggle)**, pas un
  maintien : appuyer une fois pour démarrer le mouvement, une seconde fois pour l'arrêter.
- **Test sur casque** : ouvrir l'URL réseau (`https://<ip-locale>:5173`) dans le navigateur du
  Meta Quest, sur le même réseau que la machine de dev.

## Scripts

| Commande | Rôle |
|---|---|
| `npm run dev` | Serveur de dev HTTPS avec HMR |
| `npm run build` | Typecheck (`tsc -b`) + build de production |
| `npm run preview` | Sert le build de production |
| `npm run typecheck` | Vérification TypeScript seule |

## Structure

```
src/
  main.ts                   Bootstrap : scène, renderer XR, boucle de rendu
  assets/
    audio/ambientHum.ts      Bourdonnement ambiant des néons (Web Audio, généré procéduralement)
    textures/                Textures PBR CC0 (basecolor/normal/roughness par surface)
    video/vhs-noise.webm     Vraie vidéo de bruit TV (CC0, retraitée), pas un hash procédural
  player/
    locomotion.ts           Déplacement fluide (joystick gauche) + snap-turn (joystick droit)
    comfortVignette.ts      Vignette de confort (quad shader fixé à la caméra, réagit au mouvement)
    vhsOverlay.ts            Scanlines + vraie texture vidéo de bruit (quad shader fixé à la caméra)
    camcorderHud.ts          Panneau caméscope (REC, horodatage, batterie, profondeur)
    haptics.ts                Déclenche une pulsation sur les manettes (signal de piège glitch)
  world/
    levelManager.ts          Orchestre la progression : profil par profondeur, sortie, transition
    chunkStreamer.ts        Charge/décharge les chunks (rayon 2), anime les pièges, régénère le
                               labyrinthe hors champ de vision
    chunkMesh.ts             Construit les meshes THREE d'un chunk (murs fusionnés, piliers instanciés)
    exitBeacon.ts             Marqueur de sortie : anneau émissif pulsé + balise sonore positionnelle
    glitchTrap.ts             Piège "zone de corruption" : décalques (sol + mur proche) scintillants
    wallTrap.ts                Piège "mur qui surgit" : bloque temporairement un passage ouvert
    vhsNoiseTexture.ts         Texture vidéo de bruit VHS partagée (un seul <video> décodé)
    corruption.ts             Accumulateur de corruption VHS cumulable, dissipée dans le temps
    collision.ts             Résolution de collision cercle/AABB (plan XZ)
    materials.ts             Charge les textures PBR (basecolor/normal/roughness/ao/displacement)
                               et construit les matériaux ; plafond : vraie carte d'émission Poliigon
                               en emissiveMap (dalles lumineuses déjà présentes dans la photo)
    vhsMaterial.ts            Effet VHS injecté dans les matériaux (onBeforeCompile) : grain,
                               aberration chromatique, quantification des couleurs, teinte jaunâtre
  shared/                    Logique pure, sans dépendance three.js — réutilisable côté serveur
    constants.ts             Constantes de la grille (taille cellule/chunk, rayon de streaming...)
    levelProfile.ts          Profil de génération par profondeur (seed dérivée, difficulté progressive)
    exit.ts                   Position de la sortie du level (fonction pure de la seed)
    rng.ts                   Hash déterministe par coordonnées + PRNG seedé (seedrandom)
    noise.ts                 Bruit simplex 2D seedé (simplex-noise)
    chunkLayout.ts           Génère la disposition (murs/piliers/pièges/collection) d'un chunk
    collectibles.ts          Pool des ~50 objets de collection (rareté fixe, lore FR/EN)
    pseudoGenerator.ts       Suggestions de pseudo (templates seedés, pas de clavier virtuel)
server/                      API de classement (étape 7) — voir server/src/, code partagé avec le
                               client via des imports relatifs vers src/shared/
deploy/                      Scripts de déploiement SSH/Plesk (étape 8) — voir deploy/README.md
```

## Notes sur cette étape

- Les textures sont de vraies textures PBR Poliigon (collection Backrooms, téléchargées
  gratuitement sur le site), redimensionnées en 1K et converties en WebP : basecolor, normal,
  roughness, ao et displacement pour les 4 surfaces (mur/sol/plafond/pilier), plus une vraie
  carte d'émission pour le plafond. Voir `src/world/materials.ts`.
- Le displacement déplace réellement les sommets (`displacementMap` + `displacementScale`/`Bias`
  faibles) : sol/murs/plafond/piliers sont subdivisés en conséquence dans `chunkMesh.ts`
  (sinon seuls les coins du quad bougeraient, ce qui gondole toute la surface au lieu de créer
  un relief). L'aoMap réutilise le même jeu d'UV que le reste (`texture.channel = 0` par défaut
  en three.js), pas besoin d'un second canal UV.
- Les dalles lumineuses du plafond viennent de la vraie carte d'émission Poliigon (`emissiveMap`,
  alignée pixel pour pixel avec le carrelage photographié) plutôt que d'être des objets 3D séparés
  — plus de InstancedMesh de néons, juste un plan de plafond dont le matériau porte les panneaux
  émissifs.
- Le grain de l'overlay VHS (`vhsOverlay.ts`) vient d'une vraie vidéo de bruit TV (Pixabay,
  licence Content License — retraitée : redimensionnée, recompressée en WebM, pas le fichier
  brut, pour rester dans le cadre "modifier/adapter" de la licence), pas d'un hash procédural.
  Échantillonnée en `NearestFilter` pour garder le grain brut, son intensité suit `uCorruption`.
- La disposition d'un chunk (murs/piliers/pièges) est une fonction pure de ses coordonnées
  globales et de la seed (`src/shared/`) : deux chunks voisins générés indépendamment restent
  cohérents à leur frontière, et cette logique est réellement réutilisée côté serveur pour la
  validation anti-triche (`server/src/validation.ts`, étape 7).
- Les murs de chaque chunk sont fusionnés en une seule géométrie boîte (épaisseur réelle, cohérente
  avec la collision — pas un simple plan), les piliers en `InstancedMesh`, pour tenir le budget de
  la fiche projet (<100 draw calls). Les piliers ont une vraie collision (boîte carrée).
- L'effet VHS (`vhsMaterial.ts`) est injecté par matériau via `onBeforeCompile`, pas de
  post-processing `EffectComposer` (non pris en charge nativement en WebXR).
- L'ambiance sonore est un bourdonnement procédural (Web Audio), sans fichier audio externe ; la
  lecture démarre au `sessionstart` XR pour respecter les politiques d'autoplay des navigateurs.
- Chaque level a sa propre seed dérivée (`<runSeed>:<profondeur>`, `levelProfile.ts`) et sa propre
  difficulté : densité de murs, probabilité de pilier/piège et distance de la sortie augmentent
  avec la profondeur (bornées par des plafonds). La seed de run vient du serveur (`POST
  /run/start`, étape 7) ; le tout premier rendu démarre sur une seed locale de secours le temps
  de l'aller-retour réseau (`LevelManager.restartRun`), pour ne jamais bloquer l'affichage.
- La position de la sortie est dérivée de la seed (`exit.ts`) et un couloir en équerre entre le
  spawn et la sortie est systématiquement forcé sans mur (`chunkLayout.ts`), y compris après une
  régénération du labyrinthe dynamique : la sortie reste toujours atteignable.
- Chaque level repart d'un monde régénéré autour de l'origine locale (`ChunkStreamer.setProfile`) :
  pas de world persistant entre les levels, juste une seed différente à chaque descente.
- **Corruption VHS cumulable** (`corruption.ts`) : chaque déclencheur (transition de level, piège
  glitch, régénération de labyrinthe hors champ) ajoute de l'intensité à l'uniforme `uCorruption`
  du shader ; elle se dissipe ensuite progressivement. Aucune distorsion de la position/rotation
  caméra — uniquement l'effet shader, comme demandé par la fiche pour le confort VR.
- **Pièges glitch** (`glitchTrap.ts`) : marqueur au sol scintillant + grésillement audio
  positionnel comme signaux avant-coureurs. Au contact (rayon de déclenchement), la corruption
  augmente progressivement tant que le joueur reste à proximité, plus une pulsation haptique sur
  les manettes à l'entrée. Aucune collision, aucune mort — uniquement la vision qui se dégrade.
  Seul le type "zone de corruption" de la fiche est implémenté pour l'instant ; les types "mur qui
  surgit/se déplace" et "boucle spatiale" restent à faire.
- **Labyrinthe dynamique** (`chunkStreamer.ts`) : toutes les 6 à 12 secondes, un chunk chargé mais
  hors du champ de vision de la caméra (frustum) et à au moins 2 chunks du joueur est régénéré
  avec un agencement différent (même sortie, même couloir garanti). Déclenche un petit pic de
  corruption pour accompagner discrètement le changement.
- Le panneau caméscope affiche la profondeur réelle, mise à jour à chaque changement de level.

## Étapes 6–8 (résumé)

- **Collection (étape 6)** : ~50 modèles CC0 distincts (Poly Haven), rareté fixe par objet
  (commun/rare/légendaire — pas un tirage indépendant), lore FR/EN généré par templates seedés,
  espacement minimal entre objets (difficiles à trouver, jamais groupés). Ramassage au grip :
  l'objet suit la main (`Object3D.attach`, manipulable en 3D) puis, au relâchement, soit rangé
  dans la collection (près du corps) soit simplement lâché (physique légère, `world/physics.ts`)
  — mobilier et collection ont tous deux une collision dynamique (dérivée de leur position
  réelle, pas d'une boîte figée à la génération) et peuvent être bousculés par le joueur.
  Menu poignet (main gauche) : pagination/tri au clic des thumbsticks. Persistance IndexedDB
  (`world/collection.ts`).
- **Classement (étape 7)** : `server/` (Fastify + SQLite/`better-sqlite3`). `POST /run/start`
  fournit une seed signée (HMAC, `server/src/token.ts`) ; le client l'utilise pour générer le
  monde (remplace la seed locale de secours du tout premier rendu). `POST /run/level` valide
  chaque passage : le serveur régénère le level *sortant* avec le même code de génération pur
  que le client (`src/shared/`) et calcule la distance spawn→sortie en ligne droite — le temps
  écoulé doit être ≥ `distance / vitesse max du joueur`, une borne physique, pas une heuristique
  (`server/src/validation.ts`). "STOP REC" (gâchette droite maintenue ~1,4s,
  `player/stopRecControl.ts`) ouvre l'écran de fin de run (`player/endRunScreen.ts`) : pseudo
  suggéré (pas de clavier virtuel — templates seedés FR-flavored, filtrés côté serveur contre une
  liste FR+EN, `server/src/wordFilter.ts`), puis classement.
- **Déploiement (étape 8)** : un seul process Node sert le build statique du front ET l'API
  (`server/src/server.ts`), plus simple à héberger qu'un couple de conteneurs séparés.
  `docker-compose.yml` + `Dockerfile` pour un usage local/VPS générique ; `deploy/` pour un
  déploiement SSH direct vers un serveur Plesk (rsync + PM2, sans dépendre de l'extension Docker
  de Plesk — voir `deploy/README.md`). Plesk gère son propre reverse proxy + HTTPS : le process
  n'écoute qu'en local (`127.0.0.1`), jamais exposé directement.

## Prochaine étape

9. Optimisation Quest (profiling fps/draw calls, réglages de confort)
