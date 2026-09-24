# Backrooms VR (titre provisoire)

Jeu d'exploration horrifique en VR, dans le navigateur (WebXR). Voir la fiche projet pour le concept complet.

**État actuel : étape 8 de la roadmap (déploiement)** — scène WebXR, locomotion fluide +
snap-turn, génération par chunks streamés avec collisions, levels avec sortie signalée (portail
VHS, pas un simple anneau) et difficulté progressive, deux types de pièges glitch (zones de
corruption + murs qui surgissent) et un labyrinthe dynamique. Décor (mobilier CC0) et ~50 objets
de collection (vrais modèles CC0, rareté fixe par objet) avec un vrai moteur physique (Rapier),
mains gantées, saisie/lancer au grip (y compris à distance), menu d'inventaire avec aperçus 3D,
accroupi, jouable assis, persistance IndexedDB. Contrôles inspirés de *The Walking Dead: Saints
& Sinners* (voir [Contrôles](#contrôles-meta-quest)). Classement en ligne (API
Node + SQLite, validation anti-triche serveur, filtre pseudo, écran de fin de run) et
déploiement (Docker, ou hébergement Node.js natif Plesk — voir `docs/DEPLOIEMENT-PLESK.md`).

## Stack

Three.js (WebXRManager) + TypeScript + Vite (HTTPS local via `vite-plugin-mkcert`) +
`simplex-noise` / `seedrandom` pour la génération procédurale seedée + Rapier
(`@dimforge/rapier3d-compat`, moteur physique WASM) pour les collisions et les objets.

## Contrôles (Meta Quest)

Inspirés de *The Walking Dead: Saints & Sinners* (mains physiques, objets qui "sautent" dans la
main, menus sans quitter le jeu) :

| Action | Commande |
|---|---|
| Se déplacer | Stick gauche (clic : sprint, bascule) |
| Tourner | Stick droit gauche/droite (crans de 45°, pivot sur la tête) |
| S'accroupir / se relever | Stick droit vers le bas / le haut (ou clic du stick droit, ou se baisser physiquement) |
| Attraper / tenir | Grip au contact d'un objet (il s'illumine) |
| Attraper à distance | Maintenir la gâchette : un rayon s'affiche (jusqu'à 4 m, l'objet visé s'illumine) + grip : il vole jusqu'à la main |
| Deux mains / changer de main | Saisir le même objet avec l'autre main (on le porte à deux, un meuble lourd se soulève) ; lâcher la première main pour changer de main. D'une seule main, un meuble lourd se traîne |
| Lâcher / lancer | Relâcher le grip (l'objet part avec la vitesse de la main) |
| Ranger l'objet tenu | A / X, ou le relâcher sur le menu d'inventaire ouvert |
| Pousser / frapper | Poing fermé (grip sans objet) ou geste vif |
| Inventaire | Y (ouvrir/fermer) ; viser + gâchette pour les boutons, viser une case + grip pour sortir l'objet à taille réelle |
| Lampe frontale | B (batterie limitée, HUD `BAT` : ramasser des piles au sol en marchant dessus ou en les touchant) |
| Recaler la hauteur / STOP REC | Boutons du menu d'inventaire |

Hauteur : au démarrage de la session, un joueur assis est automatiquement rehaussé à hauteur
debout (bouton "Recaler hauteur" pour refaire la mesure). Les indices de boutons suivent les
profils officiels `oculus-touch-v3` / `meta-quest-touch-plus` (stick = bouton 3, A/X = 4, B/Y = 5),
avec un repli pour les émulateurs qui omettent l'emplacement réservé au pavé tactile.

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
| `npm run build` | Typecheck (`tsc -b`) + build de production + pré-compression brotli/gzip |
| `npm run preview` | Sert le build de production |
| `npm run typecheck` | Vérification TypeScript seule |
| `npm run test:physics` | Simulation physique sans rendu (marcher dans un meuble, saisir/lancer, murs, saisie à distance, rangement) |
| `python3 scripts/convert-textures.py` | Recompresse les textures sources (`assets-src/`) en KTX2 (Pillow + `toktx` de KTX-Software requis) |

Mesures de perfs en casque : ouvrir le jeu avec `?debug=1` (FPS, draw calls, triangles,
géométries/textures en mémoire affichés sous le HUD caméscope).

## Structure

```
src/
  main.ts                   Bootstrap : scène, renderer XR, boucle de rendu
  assets/
    audio/ambientHum.ts      Bourdonnement ambiant des néons (Web Audio, généré procéduralement)
    textures/                Textures PBR CC0 (basecolor/normal/roughness par surface)
    video/vhs-noise.webm     Vraie vidéo de bruit TV (CC0, retraitée), pas un hash procédural
    models/hands/            Mains génériques WebXR (profil "generic-hand", @webxr-input-profiles, MIT)
  physics/
    physicsWorld.ts          Monde Rapier : sol/plafond infinis, groupes de collision, pas de simulation
    modelShape.ts            Enveloppe convexe d'un modèle glTF (forme de collision fidèle, en cache)
  player/
    playerController.ts      Corps du joueur : capsule Rapier suivant la tête, déplacement/sprint,
                               rotation par crans, accroupi, rehaussement assis → debout
    xrInput.ts               Boutons/sticks des deux manettes (mapping officiel Quest, fronts)
    hand.ts / handModel.ts   Mains gantées (doigts pliés selon grip/gâchette), vitesse de lancer,
                               collider cinématique (poing fermé = on bouscule)
    grabSystem.ts            Saisie proche/à distance, suivi physique en main, lancer, rangement
    inventoryMenu.ts         Menu d'inventaire : miniatures 3D, sortie à taille réelle, actions système
    endRunScreen.ts          Écran de fin de run (pseudo, envoi au classement)
    flashlight.ts            Lampe frontale (B)
    comfortVignette.ts      Vignette de confort (quad shader fixé à la caméra, réagit au mouvement)
    vhsOverlay.ts            Scanlines + vraie texture vidéo de bruit (quad shader fixé à la caméra)
    camcorderHud.ts          Viseur caméscope en haut du champ (REC, temps, batterie, niveau, états)
    haptics.ts / sfx.ts      Vibrations par manette, petits sons d'interface procéduraux
  ui/
    uiPanel.ts / uiPointer.ts Panneaux de menu en espace monde + pointeur laser (gâchette/grip)
  world/
    grabbable.ts             Objets physiques saisissables (mobilier, collection) + registre
    atmosphere.ts            Lumière selon la profondeur, néons qui clignotent (glitchs, pannes)
    levelManager.ts          Orchestre la progression : profil par profondeur, sortie, transition
    chunkStreamer.ts        Charge/décharge les chunks (rayon 2), anime les pièges, régénère le
                               labyrinthe hors champ de vision
    chunkMesh.ts             Construit les meshes THREE d'un chunk (murs fusionnés, piliers instanciés)
    exitBeacon.ts             Marqueur de sortie : anneau émissif pulsé + balise sonore positionnelle
    glitchTrap.ts             Piège "zone de corruption" : décalques (sol + mur proche) scintillants
    wallTrap.ts                Piège "mur qui surgit" : bloque temporairement un passage ouvert
    vhsNoiseTexture.ts         Texture vidéo de bruit VHS partagée (un seul <video> décodé)
    corruption.ts             Accumulateur de corruption VHS cumulable, dissipée dans le temps
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
scripts/                     Scripts de déploiement Plesk (étape 8) — voir docs/DEPLOIEMENT-PLESK.md
tests/physics.sim.ts         Simulation physique sans rendu (`npm run test:physics`)
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
  espacement minimal entre objets (difficiles à trouver, jamais groupés).
  - **Physique** : moteur Rapier. Murs/piliers en colliders fixes par chunk, sol et plafond
    infinis (pas de couture entre chunks), mobilier et objets en corps dynamiques avec une
    enveloppe convexe calculée depuis le modèle (une canette roule, une clé reste à plat) et une
    masse réaliste (une armoire de 45 kg se pousse mais ne se soulève pas). Le joueur est une
    capsule cinématique qui suit sa *tête* : on ne traverse ni mur ni objet, même en se penchant
    physiquement, et marcher dans un meuble le pousse.
  - **Saisie** : l'objet tenu reste un corps physique asservi à la main par vitesse — il cogne
    les murs au lieu de les traverser (et se lâche s'il reste coincé), un objet lourd traîne
    derrière la main, et au relâchement il part avec la vitesse réelle de la main (lancer).
  - **Inventaire** : menu (Y) avec les objets en miniatures 3D ; on en sort un à taille réelle
    directement dans la main, on range l'objet tenu en le relâchant sur le menu ou avec A/X. Ce
    qui est rangé persiste entre les runs (IndexedDB, `world/collection.ts`) ; un objet sorti et
    laissé au sol est perdu en changeant de level.
  - **Ambiance** (vers *Saints & Sinners*) : mains gantées, chaque descente assombrit les néons
    et densifie le brouillard, les néons clignotent pendant les glitchs et tombent en panne au
    hasard en profondeur — d'où la lampe frontale (B). Le viseur REC est en haut du champ.
- **Classement (étape 7)** : `server/` (Fastify + SQLite/`better-sqlite3`). `POST /run/start`
  fournit une seed signée (HMAC, `server/src/token.ts`) ; le client l'utilise pour générer le
  monde (remplace la seed locale de secours du tout premier rendu). `POST /run/level` valide
  chaque passage : le serveur régénère le level *sortant* avec le même code de génération pur
  que le client (`src/shared/`) et calcule la distance spawn→sortie en ligne droite — le temps
  écoulé doit être ≥ `distance / vitesse max du joueur`, une borne physique, pas une heuristique
  (`server/src/validation.ts`, vitesse max = sprint). "STOP REC" (bouton du menu d'inventaire,
  avec confirmation) ouvre l'écran de fin de run (`player/endRunScreen.ts`) : pseudo
  suggéré (pas de clavier virtuel — templates seedés FR-flavored, filtrés côté serveur contre une
  liste FR+EN, `server/src/wordFilter.ts`), puis classement.
- **Déploiement (étape 8)** : un seul process Node sert le build statique du front ET l'API
  (`server/src/server.ts`), plus simple à héberger qu'un couple de conteneurs séparés.
  `docker-compose.yml` + `Dockerfile` pour un usage local/VPS générique ; hébergement Node.js natif
  Plesk (extension Node.js Toolkit, Phusion Passenger) en recommandé — un seul script
  (`scripts/plesk-install.sh`) installe/compile/configure/redémarre, voir `docs/DEPLOIEMENT-PLESK.md`.
  `server/passenger.cjs` fait le pont entre Passenger (charge son fichier de démarrage avec
  `require()`) et le serveur en modules ES (`server/dist/server.mjs`, bundlé avec esbuild).

## Prochaine étape

Voir `docs/PLAN-ACTION.md` (améliorations esthétique / gameplay / performance, toutes
implémentées) : reste à mesurer en casque avec `?debug=1` et à ajuster (étape 9).
