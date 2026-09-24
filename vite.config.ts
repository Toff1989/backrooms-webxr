import { defineConfig } from "vite";
import mkcert from "vite-plugin-mkcert";

export default defineConfig({
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
