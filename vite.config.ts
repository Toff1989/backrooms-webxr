import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import mkcert from "vite-plugin-mkcert";

/**
 * Identifiant de build affiché en jeu (inventaire, options, journal de debug) : commit git
 * s'il est disponible (un déploiement Plesk n'a pas toujours le dossier .git) + date/heure
 * de compilation. Permet de vérifier en un coup d'œil quelle version tourne sur le casque.
 */
function buildId(): string {
  let commit = process.env["BUILD_COMMIT"] ?? "";
  if (!commit) {
    try {
      commit = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      commit = "";
    }
  }
  const date = new Date().toISOString().slice(0, 16).replace("T", " ");
  return commit ? `${commit} ${date}` : date;
}

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(buildId()),
  },
  plugins: [mkcert()],
  assetsInclude: ["**/*.glb", "**/*.ktx2"],
  server: {
    https: {},
    host: true,
    // API de classement (étape 7) : le serveur Node tourne à part (voir server/), sur un port
    // HTTP séparé — proxié ici pour que le client appelle toujours `/api/...` en relatif,
    // dev comme prod (en prod, le même process Node sert le front ET l'API, voir server/src/server.ts).
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
  build: {
    target: "es2022",
    // Dépendances lourdes dans des fichiers séparés, stables d'une version à l'autre : le
    // navigateur (et le cache du casque) ne retélécharge que le code du jeu après une mise à jour.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: "rapier", test: /node_modules[\\/]@dimforge/ },
            { name: "three", test: /node_modules[\\/]three/ },
          ],
        },
      },
    },
    // Rapier embarque son WASM en base64 (~2 Mo) : taille connue et assumée.
    chunkSizeWarningLimit: 3000,
  },
});
