// Config vite minimale pour les tests navigateur (tests/browser/*.test.ts) : mêmes réglages
// d'assets que le vrai vite.config.ts (glb/ktx2), mais sans HTTPS/mkcert (ça tape sur
// api.github.com, souvent bloqué en environnement sandbox) — inutile pour ces tests qui ne
// touchent ni WebXR ni l'API du jeu.
import { defineConfig } from "vite";

export default defineConfig({
  root: process.cwd(),
  assetsInclude: ["**/*.glb", "**/*.ktx2"],
});
