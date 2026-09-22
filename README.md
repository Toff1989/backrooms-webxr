# Backrooms VR (titre provisoire)

Jeu d'exploration horrifique en VR, dans le navigateur (WebXR). Voir la fiche projet pour le concept complet.

**État actuel : étape 1 de la roadmap (proto)** — scène WebXR, locomotion fluide + snap-turn,
vignette de confort, un chunk statique texturé (placeholder).

## Stack

Three.js (WebXRManager) + TypeScript + Vite (HTTPS local via `vite-plugin-mkcert`).

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
  main.ts                 Bootstrap : scène, renderer XR, boucle de rendu
  player/
    locomotion.ts          Déplacement fluide (joystick gauche) + snap-turn (joystick droit)
    comfortVignette.ts      Vignette de confort (quad shader fixé à la caméra)
  world/
    chunk.ts                Chunk statique du proto (salle 20×20 m, piliers, néons)
    materials.ts             Textures procédurales de substitution (en attendant Poliigon)
```

## Notes sur ce proto

- Les textures sont générées proceduralement (canvas 2D) en attente de l'intégration des
  textures Poliigon (KTX2/Basis) prévues dans la fiche projet.
- Le déplacement est borné aux limites de la salle par un simple clamp de position ; le vrai
  système de collision par grille (étape 2 de la roadmap) le remplacera.
- Aucune génération procédurale infinie ni streaming de chunks pour l'instant : un seul chunk
  statique, conformément à l'étape 1 de la roadmap.
- Pas de post-processing `EffectComposer` : la vignette de confort est un quad shader attaché
  à la caméra, comme prévu pour les futurs overlays VHS.

## Prochaines étapes (roadmap)

2. Génération de chunks infinis seedés, streaming, collisions par grille, code partagé client/serveur
3. Direction artistique VHS (shader matériaux, overlay caméscope, néons, brouillard, audio)
4. Levels, sortie, profils de difficulté, compteur de profondeur
5. Glitchs (pièges), labyrinthe dynamique
6. Collection d'objets FR/EN, menu poignet, persistance IndexedDB
7. Classement en ligne (API Node + SQLite, validation serveur)
8. Déploiement (Docker Compose, reverse proxy HTTPS)
9. Optimisation Quest (profiling fps/draw calls, réglages de confort)
