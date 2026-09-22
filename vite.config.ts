import { defineConfig } from "vite";
import mkcert from "vite-plugin-mkcert";

export default defineConfig({
  plugins: [mkcert()],
  server: {
    https: {},
    host: true,
  },
  build: {
    target: "es2022",
  },
});
