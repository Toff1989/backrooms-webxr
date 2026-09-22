# Backrooms VR (titre provisoire)

Jeu d'exploration horrifique en VR, dans le navigateur (WebXR). Voir la fiche projet pour le concept complet.

**État actuel : étape 4 de la roadmap (levels)** — scène WebXR, locomotion fluide + snap-turn,
génération par chunks streamés avec collisions, look VHS (shader matériaux, scanlines, overlay
caméscope), néons, ambiance sonore, et maintenant des levels avec sortie signalée (son + lumière),
difficulté progressive et compteur de profondeur.

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

- **Test sans casque** : [Immersive Web Emulator](https://chromewebstore.google.com/detail/immersive-web-emulator/cgffilbpcibhmcfbgggfhfolhkfbhmik)
  (extension Chrome) simule une session WebXR et des manettes avec joysticks.
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
  audio/
    ambientHum.ts            Bourdonnement ambiant des néons (Web Audio, généré procéduralement)
  player/
    locomotion.ts           Déplacement fluide (joystick gauche) + snap-turn (joystick droit)
    comfortVignette.ts      Vignette de confort (quad shader fixé à la caméra, réagit au mouvement)
    vhsOverlay.ts            Scanlines + bruit (quad shader fixé à la caméra, effet constant)
    camcorderHud.ts          Panneau caméscope (REC, horodatage, batterie, profondeur)
  world/
    levelManager.ts          Orchestre la progression : profil par profondeur, sortie, transition
    chunkStreamer.ts        Charge/décharge les chunks autour du joueur (rayon 2 chunks)
    chunkMesh.ts             Construit les meshes THREE d'un chunk (murs fusionnés, piliers/néons instanciés)
    exitBeacon.ts             Marqueur de sortie : anneau émissif pulsé + balise sonore positionnelle
    collision.ts             Résolution de collision cercle/AABB (plan XZ)
    materials.ts             Textures procédurales de substitution (en attendant Poliigon)
    vhsMaterial.ts            Effet VHS injecté dans les matériaux (onBeforeCompile) : grain,
                               aberration chromatique, quantification des couleurs, teinte jaunâtre
  shared/                    Logique pure, sans dépendance three.js — réutilisable côté serveur
    constants.ts             Constantes de la grille (taille cellule/chunk, rayon de streaming...)
    levelProfile.ts          Profil de génération par profondeur (seed dérivée, difficulté progressive)
    exit.ts                   Position de la sortie du level (fonction pure de la seed)
    rng.ts                   Hash déterministe par coordonnées + PRNG seedé (seedrandom)
    noise.ts                 Bruit simplex 2D seedé (simplex-noise)
    chunkLayout.ts           Génère la disposition (murs/piliers) d'un chunk depuis sa seed
```

## Notes sur cette étape

- Les textures sont générées proceduralement (canvas 2D) en attente de l'intégration des
  textures Poliigon (KTX2/Basis) prévues dans la fiche projet.
- La disposition d'un chunk (murs/piliers) est une fonction pure de ses coordonnées globales et
  de la seed (`src/shared/`) : deux chunks voisins générés indépendamment restent cohérents à
  leur frontière, et cette logique est réutilisable telle quelle côté serveur pour la validation
  anti-triche (étape 7 de la roadmap).
- Les murs de chaque chunk sont fusionnés en une seule géométrie (1 draw call), les piliers et
  néons en `InstancedMesh`, pour tenir le budget de la fiche projet (<100 draw calls). Les piliers
  ont désormais une vraie collision (boîte carrée), plus seulement un rendu visuel.
- L'effet VHS (`vhsMaterial.ts`) est injecté par matériau via `onBeforeCompile`, pas de
  post-processing `EffectComposer` (non pris en charge nativement en WebXR). Une uniforme
  `uCorruption` est déjà câblée pour l'intensité de glitch cumulable de l'étape 5, à 0 pour l'instant.
- L'ambiance sonore est un bourdonnement procédural (Web Audio), sans fichier audio externe ; la
  lecture démarre au `sessionstart` XR pour respecter les politiques d'autoplay des navigateurs.
- Chaque level a sa propre seed dérivée (`<runSeed>:<profondeur>`, `levelProfile.ts`) et sa propre
  difficulté : densité de murs, probabilité de pilier et distance de la sortie augmentent avec la
  profondeur (bornées par des plafonds). La seed de run est fixe côté client pour l'instant ; la
  vraie seed aléatoire signée par le serveur (`POST /run/start`) arrive à l'étape 7.
- La position de la sortie est dérivée de la seed (`exit.ts`) et un couloir en équerre entre le
  spawn et la sortie est systématiquement forcé sans mur (`chunkLayout.ts`) : la sortie est donc
  toujours atteignable, quelle que soit la densité de murs du profil.
- Chaque level repart d'un monde régénéré autour de l'origine locale (`ChunkStreamer.setProfile`) :
  pas de world persistant entre les levels, juste une seed différente à chaque descente.
- Le passage au level suivant déclenche un bref pic de corruption VHS (`uCorruption`, déjà câblé à
  l'étape 3) pour masquer la téléportation, en attendant le vrai système de glitchs de l'étape 5.
- Le panneau caméscope affiche la profondeur réelle, mise à jour à chaque changement de level.

## Prochaines étapes (roadmap)

5. Glitchs (pièges), labyrinthe dynamique
6. Collection d'objets FR/EN, menu poignet, persistance IndexedDB
7. Classement en ligne (API Node + SQLite, validation serveur)
8. Déploiement (Docker Compose, reverse proxy HTTPS)
9. Optimisation Quest (profiling fps/draw calls, réglages de confort)
