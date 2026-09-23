# Backrooms VR (titre provisoire)

Jeu d'exploration horrifique en VR, dans le navigateur (WebXR). Voir la fiche projet pour le concept complet.

**État actuel : étape 5 de la roadmap (glitchs), look affiné** — scène WebXR, locomotion fluide +
snap-turn, génération par chunks streamés avec collisions, levels avec sortie signalée et
difficulté progressive, deux types de pièges glitch (zones de corruption plaquées sur les
surfaces + murs qui surgissent temporairement) et un labyrinthe dynamique. Look VHS affiné après
retours visuels : vraie vidéo de bruit en overlay, papier peint à motif chevron, plafond avec
dalles lumineuses tissées dans la texture (plus d'objets 3D pour les néons).

## Stack

Three.js (WebXRManager) + TypeScript + Vite (HTTPS local via `vite-plugin-mkcert`) +
`simplex-noise` / `seedrandom` pour la génération procédurale seedée.

## Démarrage

```bash
npm install
npm run dev
```

Le serveur de dev tourne en HTTPS (requis par WebXR hors `localhost`) grâce à `vite-plugin-mkcert`,
qui génère un certificat local à la première exécution (nécessite un accès réseau sortant vers
GitHub pour télécharger le binaire `mkcert` ; si ce téléchargement échoue dans un environnement
restreint, `http://localhost` fonctionne aussi car les navigateurs le considèrent comme un contexte
sécurisé).

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
    materials.ts             Charge/génère les textures et construit les matériaux (mur : motif
                               chevron par canvas ; plafond : dalles lumineuses en emissiveMap)
    vhsMaterial.ts            Effet VHS injecté dans les matériaux (onBeforeCompile) : grain,
                               aberration chromatique, quantification des couleurs, teinte jaunâtre
  shared/                    Logique pure, sans dépendance three.js — réutilisable côté serveur
    constants.ts             Constantes de la grille (taille cellule/chunk, rayon de streaming...)
    levelProfile.ts          Profil de génération par profondeur (seed dérivée, difficulté progressive)
    exit.ts                   Position de la sortie du level (fonction pure de la seed)
    rng.ts                   Hash déterministe par coordonnées + PRNG seedé (seedrandom)
    noise.ts                 Bruit simplex 2D seedé (simplex-noise)
    chunkLayout.ts           Génère la disposition (murs/piliers/pièges) d'un chunk depuis sa seed
```

## Notes sur cette étape

- Les textures sont de vraies textures PBR CC0 (ambientCG.com — pas les textures Poliigon
  fournies : licence commerciale incompatible avec un dépôt public, voir `src/world/materials.ts`).
  Déjà en 1K, WebP (basecolor + normal + roughness).
- Le motif chevron du papier peint (référence fournie) n'existe pas en CC0 : généré par canvas
  (`createWallBaseColorTexture`), en réutilisant le relief/la rugosité de la vraie photo pour
  garder un grain de surface réaliste.
- Les dalles lumineuses du plafond sont tissées dans la texture (`emissiveMap`, son propre
  `repeat` indépendant du `map`) plutôt que d'être des objets 3D séparés — plus de InstancedMesh
  de néons, juste un plan de plafond dont le matériau porte les panneaux émissifs.
- Le grain de l'overlay VHS (`vhsOverlay.ts`) vient d'une vraie vidéo de bruit TV (Pixabay,
  licence Content License — retraitée : redimensionnée, recompressée en WebM, pas le fichier
  brut, pour rester dans le cadre "modifier/adapter" de la licence), pas d'un hash procédural.
  Échantillonnée en `NearestFilter` pour garder le grain brut, son intensité suit `uCorruption`.
- La disposition d'un chunk (murs/piliers/pièges) est une fonction pure de ses coordonnées
  globales et de la seed (`src/shared/`) : deux chunks voisins générés indépendamment restent
  cohérents à leur frontière, et cette logique est réutilisable telle quelle côté serveur pour la
  validation anti-triche (étape 7 de la roadmap).
- Les murs de chaque chunk sont fusionnés en une seule géométrie boîte (épaisseur réelle, cohérente
  avec la collision — pas un simple plan), les piliers en `InstancedMesh`, pour tenir le budget de
  la fiche projet (<100 draw calls). Les piliers ont une vraie collision (boîte carrée).
- L'effet VHS (`vhsMaterial.ts`) est injecté par matériau via `onBeforeCompile`, pas de
  post-processing `EffectComposer` (non pris en charge nativement en WebXR).
- L'ambiance sonore est un bourdonnement procédural (Web Audio), sans fichier audio externe ; la
  lecture démarre au `sessionstart` XR pour respecter les politiques d'autoplay des navigateurs.
- Chaque level a sa propre seed dérivée (`<runSeed>:<profondeur>`, `levelProfile.ts`) et sa propre
  difficulté : densité de murs, probabilité de pilier/piège et distance de la sortie augmentent
  avec la profondeur (bornées par des plafonds). La seed de run est fixe côté client pour
  l'instant ; la vraie seed aléatoire signée par le serveur (`POST /run/start`) arrive à l'étape 7.
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

## Prochaines étapes (roadmap)

6. Collection d'objets FR/EN, menu poignet, persistance IndexedDB
7. Classement en ligne (API Node + SQLite, validation serveur)
8. Déploiement (Docker Compose, reverse proxy HTTPS)
9. Optimisation Quest (profiling fps/draw calls, réglages de confort)
