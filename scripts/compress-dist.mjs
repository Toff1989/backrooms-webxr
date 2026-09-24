// Pré-compresse le build (brotli + gzip) : servi tel quel par @fastify/static
// (`preCompressed`), sans compresser à chaque requête. Lancé après `vite build`.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const DIST = new URL("../dist/", import.meta.url).pathname;
const COMPRESSIBLE = /\.(js|mjs|css|html|json|wasm|svg|ktx2|glb)$/;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (COMPRESSIBLE.test(name)) {
      const data = readFileSync(path);
      if (data.length < 1024) continue;
      const brotli = brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
      if (brotli.length < data.length * 0.9) writeFileSync(`${path}.br`, brotli);
      const gzip = gzipSync(data, { level: 9 });
      if (gzip.length < data.length * 0.9) writeFileSync(`${path}.gz`, gzip);
    }
  }
}

walk(DIST);
