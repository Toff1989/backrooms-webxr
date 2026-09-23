import { defineConfig } from "vite";
import mkcert from "vite-plugin-mkcert";

export default defineConfig({
  plugins: [mkcert()],
  assetsInclude: ["**/*.glb"],
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
  },
});
