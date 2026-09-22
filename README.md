# Backrooms VR (titre provisoire)

Jeu d'exploration horrifique en VR, dans le navigateur (WebXR). Voir la fiche projet pour le concept complet.

**État actuel : étape 2 de la roadmap (génération)** — scène WebXR, locomotion fluide + snap-turn,
vignette de confort, chunks infinis générés depuis une seed avec streaming autour du joueur et
collisions par grille.

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
  player/
    locomotion.ts           Déplacement fluide (joystick gauche) + snap-turn (joystick droit)
    comfortVignette.ts      Vignette de confort (quad shader fixé à la caméra)
  world/
    chunkStreamer.ts        Charge/décharge les chunks autour du joueur (rayon 2 chunks)
    chunkMesh.ts             Construit les meshes THREE d'un chunk (murs fusionnés, piliers instanciés)
    collision.ts             Résolution de collision cercle/AABB (plan XZ)
    materials.ts             Textures procédurales de substitution (en attendant Poliigon)
  shared/                    Logique pure, sans dépendance three.js — réutilisable côté serveur
    constants.ts             Constantes de la grille (taille cellule/chunk, rayon de streaming...)
    levelProfile.ts          Profil de génération (seed, densité de murs, piliers)
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
- Les murs de chaque chunk sont fusionnés en une seule géométrie (1 draw call), les piliers en
  `InstancedMesh`, pour tenir le budget de la fiche projet (<100 draw calls).
- Pas de niveaux/sortie ni de profondeur pour l'instant : un unique profil génère un monde infini
  dans toutes les directions (étape 4 de la roadmap pour la progression par niveaux).
- Pas de post-processing `EffectComposer` : la vignette de confort est un quad shader attaché
  à la caméra, comme prévu pour les futurs overlays VHS.

## Prochaines étapes (roadmap)

3. Direction artistique VHS (shader matériaux, overlay caméscope, néons, brouillard, audio)
4. Levels, sortie, profils de difficulté, compteur de profondeur
5. Glitchs (pièges), labyrinthe dynamique
6. Collection d'objets FR/EN, menu poignet, persistance IndexedDB
7. Classement en ligne (API Node + SQLite, validation serveur)
8. Déploiement (Docker Compose, reverse proxy HTTPS)
9. Optimisation Quest (profiling fps/draw calls, réglages de confort)
