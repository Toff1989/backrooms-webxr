# Backrooms VR (titre provisoire)

Jeu d'exploration horrifique en VR, dans le navigateur (WebXR). Voir la fiche projet pour le concept complet.

**État actuel : étape 8 de la roadmap (déploiement)** — scène WebXR, locomotion fluide +
snap-turn, génération par chunks streamés avec collisions, levels avec sortie sombre (porte
entrouverte sur le noir, balise sonore, signal du caméscope) et difficulté progressive, murs qui
surgissent, zones sombres (lampe torche à piles) et un labyrinthe dynamique. Les pièges "glitch"
visuels ont été remplacés par deux menaces : la Coupure et le Cadreur. Décor (mobilier CC0) et 39 objets
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
| Attraper / tenir | Grip au contact d'un objet (il s'illumine) : on le prend **là où on le touche** ; la main reste posée sur l'objet, une main fantôme montre la manette si l'objet est retenu |
| Attraper à distance | Maintenir la gâchette : un rayon s'affiche (5 m, l'objet visé s'illumine) ; grip = verrouillage (lien vert) ; **coup de poignet vers soi** : l'objet vole en cloche vers la main, garder le grip pour le rattraper (sans geste, il vient seul après ~1 s) |
| Deux mains / changer de main | Saisir le même objet avec l'autre main (on le porte à deux, un meuble lourd se soulève) ; lâcher la première main pour changer de main. D'une seule main, un meuble lourd se traîne |
| Lâcher / lancer | Relâcher le grip (l'objet part avec la vitesse de la main) |
| Ranger l'objet tenu | A / X, le lâcher **derrière l'épaule** (sac à dos), ou le lâcher sur une case du menu d'inventaire (rangé à cette case) |
| Pousser / frapper | Poing fermé (grip sans objet) ou geste vif |
| Inventaire | Y (ouvrir/fermer) ; gâchette sur une case puis sur une autre : déplacer l'objet ; grip sur une case : sortir l'objet, puis le relâcher sur une autre case pour l'y ranger ; bouton TRI (récent / rareté / profondeur / nom) ; identifiant de build en bas à droite |
| Lampe frontale | B (batterie limitée, HUD `BAT` : ramasser des piles au sol en marchant dessus ou en les touchant) |
| Journal des bandes perdues | Bouton JOURNAL du menu d'inventaire (il flotte devant soi) ; l'autre main tourne les pages à la gâchette |
| Lire une bande perdue | Saisir la page au sol (grip) : elle entre au journal ; A/X ou par-dessus l'épaule pour la classer |
| Utiliser un objet | Gâchette en le tenant (allumer la télé, remonter le réveil, allumer un briquet, pulvériser...) ; pour un meuble, le toucher du bout de l'index (gâchette relâchée) : télé, tabouret |
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

Mode debug : ouvrir le jeu avec `?debug=1`. En casque : FPS, draw calls, à-coups et graphe des
frames sous le HUD. Et surtout un **journal envoyé au serveur** toutes les 5 s (erreurs, à-coups
avec leur cause, stats par seconde, état audio, session XR, chunks...) dans
`server/logs/debug-AAAA-MM-JJ.jsonl`, relisible via `GET /api/debug-log?token=DEBUG_LOG_TOKEN`
(jeton dans `server/.env`, généré par `scripts/plesk-install.sh`). L'identifiant de build (commit
+ date) est affiché dans le menu d'inventaire et les options : il permet de vérifier que le casque
charge bien la dernière version.

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
    journal.ts               Journal des bandes perdues (carnet flottant, ouvert depuis le menu) : index, lecture, code de cassette, jumelage
    endRunScreen.ts          Écran de fin de run (pseudo, envoi au classement)
    flashlight.ts            Lampe frontale (B)
    comfortVignette.ts      Vignette de confort (quad shader fixé à la caméra, réagit au mouvement)
    vhsOverlay.ts            Scanlines + vraie texture vidéo de bruit (quad shader fixé à la caméra)
    camcorderHud.ts          Viseur caméscope en haut du champ (REC, temps, batterie, niveau, états)
    haptics.ts / sfx.ts      Vibrations par manette, petits sons d'interface procéduraux
  ui/
    uiPanel.ts / uiPointer.ts Panneaux de menu en espace monde + pointeur laser (gâchette/grip)
  world/
    grabbable.ts             Objets physiques saisissables (mobilier, collection, pages) + registre
    lorePage.ts              Page de bande perdue : feuille de cahier, texte manuscrit sur le papier
    loreJournal.ts           Progression des bandes perdues (IndexedDB + serveur), indépendante de l'inventaire
    playerIdentity.ts        Identité anonyme de l'appareil, code de cassette, jumelage façon télé
    atmosphere.ts            Lumière selon la profondeur, néons qui clignotent (glitchs, pannes)
    levelManager.ts          Orchestre la progression : profil par profondeur, sortie, transition
    chunkStreamer.ts        Charge/décharge les chunks (rayon 2), anime les pièges, régénère le
                               labyrinthe hors champ de vision
    chunkMesh.ts             Construit les meshes THREE d'un chunk (murs fusionnés, piliers instanciés)
    exitBeacon.ts             Sortie : porte entrouverte sur le noir + balise sonore positionnelle
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
    chunkLayout.ts           Génère la disposition (murs/piliers/pièges/mobilier/collection/page) d'un chunk
    props.ts                 Mises en scène du mobilier (bureau, réserve, classe, salle d'attente, abandon)
    lore.ts                  Bandes perdues : nombre de fragments, cellule de la page de chaque level
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
- **Corruption VHS cumulable** (`corruption.ts`) : chaque déclencheur (transition de level,
  mur-piège, régénération de labyrinthe hors champ) ajoute de l'intensité à l'uniforme `uCorruption`
  du shader ; elle se dissipe ensuite progressivement. Aucune distorsion de la position/rotation
  caméra — uniquement l'effet shader, comme demandé par la fiche pour le confort VR.
- **Pièges glitch** : retirés (rendu jugé raté) ; restent les murs qui surgissent (`wallTrap.ts`).
- **La Coupure** (`blackout.ts`, `blackoutField.ts`, dès la profondeur 2) : les néons
  s'étranglent, un disjoncteur saute au loin et le courant meurt en vague vers le joueur (tubes
  qui agonisent sur le front, bourdonnement qui s'éteint). ~30 s de noir complet (seule la lampe
  éclaire), puis les tubes redémarrent un à un, starters qui claquent. Même champ calculé sur
  CPU (audio, visibilité) et GPU (néons du plafond, éclairage ambiant des surfaces).
- **Le Cadreur** (`cadreur.ts`, `cadreurModel.ts`, dès la profondeur 1) : monstre humanoïde
  voûté, plus grand qu'un homme, dont la tête est une vieille caméra 8 mm (LED REC rouge
  visible dans le noir), bras trop longs et ballants. Démarche Mixamo rendue malsaine : il
  boite, s'arrête net puis repart d'un coup, la tête-caméra tressaute et reste braquée sur le
  joueur. Il suit la trace exacte du joueur et apparaît derrière lui. Sous tes yeux il avance
  lentement ; hors de vue (dos tourné, mur, noir) il accélère ; pris dans le faisceau de la
  lampe, il se fige et sa caméra grésille. S'il te rattrape : « COUPEZ ! PRISE 2 », réveil un
  niveau plus bas, ce que tu tenais est perdu (on refait la prise, comme au montage). La Coupure l'appelle s'il n'est pas déjà là.
- **Session de test avec journaux** : `npm run debug` installe ce qui manque, lance le serveur
  (réception des journaux) et le jeu, affiche les adresses PC/casque avec `?debug=1`, confirme
  toutes les 10 s que les journaux arrivent, et à l'arrêt (Ctrl+C) exporte la session dans
  `server/logs/export-….jsonl` — à déposer dans la page d'analyse (Artifact « Banc de test
  Backrooms ») puis « Envoyer à Claude », ou directement dans la conversation.
- **Récit générique.** Pas de personnage nommé ni d'incident précis : les bandes sont des
  fragments anonymes laissés par d'autres explorateurs (notes, fiches, photos, cassettes),
  qui racontent la descente dans les Backrooms et la présence du Cadreur, sans jamais
  l'expliquer — il regarde, il filme, on ne sait ni qui il est ni ce qu'il veut vraiment.
- **Bandes perdues** (`shared/lore.ts`, `loreArt.ts`, `lorePage.ts`, `loreJournal.ts`,
  `player/journal.ts`) : 16 bandes, lues dans l'ordre d'une run à l'autre, sous quatre formes :
  note manuscrite (feuille de cahier), fiche de montage (bobine, plan, time-code, note au stylo
  rouge), polaroid (vierge quand on le trouve ; ramassé, il se développe en quelques secondes et
  révèle la scène photographiée derrière le joueur à cet instant, légende au dos —
  `player/photoCapture.ts`) et cassette (souffle de bande + transcription en sous-titres dans le
  viseur, `player/tapePlayer.ts`). À chaque level, la bande attendue traîne au sol, à l'écart du
  chemin vers la sortie (cellule dégagée, jamais emmurée) ; la prendre en main la lit et
  l'ajoute au journal.
  Le journal (carnet ouvert depuis le menu d'inventaire) liste les bandes lues ou
  encore perdues. Progression gardée sur l'appareil et côté serveur (une seule nouvelle bande par
  level et par run, validée contre la run en cours).
- **Identité sans compte** (`server/src/players.ts`, `pairing.ts`, `routes/player.ts`) : au premier
  lancement, le serveur attribue à l'appareil un secret (seule son empreinte est stockée) qui le
  rattache à un joueur ; runs et bandes lui sont rattachées. Pour retrouver sa progression
  ailleurs : le **code de cassette** (`K7-XXXX-XXXX`, affiché dans le journal, à saisir sur la
  page d'accueil → Enregistrement → Récupérer) ou le **jumelage façon télé** (le nouvel appareil
  affiche un code à 6 chiffres, l'appareil déjà enregistré le confirme au pavé numérique du
  journal ou sur la page d'accueil). Un appareil qui avait déjà sa propre identité y est fusionné
  (runs et bandes conservées) ; il adopte alors le code de cassette de l'autre.
- **Mobilier** : 18 modèles CC0 Poly Haven (dont 14 ajoutés : fauteuil, canapé, table basse,
  tabouret, chaise en plastique, étagère métallique, bibliothèque, chariot,
  tableau noir, carton, caisse en plastique, panneau « sol glissant », télévision, plante),
  optimisés avec glTF-Transform (Draco, WebP 512 px). Ils sont placés en mises en scène
  (`shared/props.ts`) tournées d'un quart de tour aléatoire : coin bureau, réserve avec caisses
  empilées, salle de classe, salle d'attente, zone abandonnée (chaises renversées), ou épars.
- **Ombres des zones sombres** : le seuil clair/noir est appliqué au pixel (seul le bruit
  lumineux, qui varie doucement, est interpolé entre sommets) — fini les ombres en biseau
  dessinées par les triangles ; pénombre plus large et moins noire.
- **Objets qui s'animent** (`world/interactions.ts`, `objectAudio.ts`, `noise.ts`,
  `modelFace.ts`, sons dans `assets/audio/objectSounds.ts`) : une trentaine d'objets ont
  un comportement. Télé (neige qui grésille, puis passe en direct après quelques secondes),
  tableau noir (un message apparaît à la craie quand on a le dos tourné), réveil (leurre à
  retardement), briquet (petite flamme à la gâchette), multimètre, boussole et instrument de
  bord (détecteurs), photo qui change quand on ne la regarde pas, ventouse qui se colle au mur,
  horloge qui se tait quand le Cadreur approche, objets qui se brisent ou résonnent quand on les
  lance (sons synthétisés dédiés par matériau : métal, plastique/bois, verre). Écrans et cadrans
  sont posés sur la surface trouvée automatiquement dans la géométrie du modèle. **Le bruit
  attire le Cadreur** : un bruit fort le fait venir plus tôt ; présent, il va voir d'où ça vient
  — un objet bruyant lancé au loin sert de leurre.
- **Vues en direct** (`player/liveViews.ts`) : caméras secondaires rendues en basse définition,
  à cadence réduite, une seule par frame et seulement quand on les regarde. La télé allumée
  passe en direct après deux secondes de neige : l'image de la caméra de surveillance qu'on a
  posée (on la pointe, on la lâche), sinon ce que voit le Cadreur quand il est là, sinon ton
  couloir filmé de dos. Jumelles (zoom ×5 portées aux yeux), loupe (grossit ce qu'on regarde à
  travers le verre).
- **Tester les menaces** : en mode debug (`?debug=1`), le menu d'inventaire (Y) a une rangée
  bleue de boutons de test : lancer/arrêter la Coupure, appeler/renvoyer le Cadreur (même au
  niveau 0), passer au niveau suivant, recharger la lampe.
- **Labyrinthe dynamique** (`chunkStreamer.ts`) : toutes les 6 à 12 secondes, un chunk chargé mais
  hors du champ de vision de la caméra (frustum) et à au moins 2 chunks du joueur est régénéré
  avec un agencement différent (même sortie, même couloir garanti). Déclenche un petit pic de
  corruption pour accompagner discrètement le changement.
- Le panneau caméscope affiche la profondeur réelle, mise à jour à chaque changement de level.

## Étapes 6–8 (résumé)

- **Collection (étape 6)** : 39 modèles CC0 distincts (Poly Haven), rareté fixe par objet
  (pièces détachées retirées : cassette du baladeur, câbles de la manette et du multimètre,
  sangle des jumelles, étui à cigarettes réduit à l'étui ouvert). Modèle du Cadreur : « X Bot »
  de Mixamo (Adobe), décimé et compressé.
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
    directement dans la main, on range l'objet tenu en le relâchant sur le menu ou avec A/X. L'inventaire
    est vidé à chaque nouvelle partie (`world/collection.ts`) ; un objet sorti et laissé au sol
    est perdu en changeant de level. Les bandes perdues ont leur propre journal, conservé (voir plus bas).
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
