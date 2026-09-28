/**
 * Test navigateur (sans WebGL) : vérifie la détection de la sous-maille "artwork" du cadre photo,
 * avec le vrai pipeline de chargement et le vrai `findMeshByName` (voir `interactions.ts`).
 * Même principe que `television.test.ts`.
 *
 * Lancer : `npm run dev`, ouvrir /tests/browser/photo.html.
 */
import * as THREE from "three";
import photoUrl from "../../src/assets/models/collectibles/photo.glb";
import { findMeshByName } from "../../src/world/interactions";
import { loadTemplateModel } from "../../src/world/gltfLoader";
import { findModelFace } from "../../src/world/modelFace";

const originalGetContext = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
  if (type.includes("webgl")) throw new Error(`getContext("${type}") appelé — ce test doit tourner sans WebGL`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (originalGetContext as any).call(this, type, ...args);
};

const results: string[] = [];
let failed = 0;
const check = (label: string, ok: boolean, detail: string): void => {
  results.push(`${ok ? "PASS" : "FAIL"} ${label} — ${detail}`);
  if (!ok) failed++;
};

function boxSize(object: THREE.Object3D): THREE.Vector3 {
  return new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3());
}

async function run(): Promise<void> {
  let template: THREE.Object3D;
  try {
    template = await loadTemplateModel(photoUrl);
    check("chargement", true, "photo.glb chargé (pipeline réel du jeu)");
  } catch (error) {
    check("chargement", false, `échec du chargement : ${error instanceof Error ? error.message : String(error)}`);
    return render();
  }

  const meshes: THREE.Mesh[] = [];
  template.traverse((child) => {
    if (child instanceof THREE.Mesh) meshes.push(child);
  });
  check("meshes présents", meshes.length > 0, `${meshes.length} mesh(es) après fusion par matériau`);
  for (const mesh of meshes) {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    results.push(`  mesh "${mesh.name || "(sans nom)"}" — matériau(x) : ${materials.map((m) => m.name || "(sans nom)").join(", ")}`);
  }

  const modelDiag = boxSize(template).length();
  const artwork = findMeshByName(template, /artwork/i);
  const glass = findMeshByName(template, /glass/i);

  if (artwork) {
    const artworkDiag = boxSize(artwork).length();
    const coverage = artworkDiag / modelDiag;
    check("sous-maille artwork détectée", true, `mesh "${artwork.name || "(sans nom)"}" — diagonale ${artworkDiag.toFixed(3)} m sur un modèle de ${modelDiag.toFixed(3)} m (${(coverage * 100).toFixed(0)}%)`);
    check("l'artwork n'est pas le cadre entier", coverage < 0.8, coverage < 0.8 ? "la maille détectée est bien plus petite que le modèle complet" : "BUG : la maille détectée couvre quasi tout le modèle");
  } else {
    check("sous-maille artwork détectée", false, 'aucune sous-maille "artwork" trouvée — le comportement retombe sur findModelFace (moins précis, peut déborder sur le cadre)');
  }
  check("sous-maille glass détectée", glass !== null, glass ? `mesh "${glass.name || "(sans nom)"}" présent (vitre, ne doit pas être touchée)` : "aucune vitre trouvée");

  const front = findModelFace(template);
  check("détection de la face avant (fallback)", front !== null && front.width > 0 && front.height > 0, front ? `centre (${front.center.x.toFixed(3)}, ${front.center.y.toFixed(3)}, ${front.center.z.toFixed(3)}), ${front.width.toFixed(3)}×${front.height.toFixed(3)} m` : "aucune face avant trouvée");

  render();
}

function render(): void {
  const banner = failed === 0 ? "TOUT PASSE" : `${failed} ECHEC(S)`;
  const el = document.getElementById("results");
  if (el) el.textContent = [...results, "", banner].join("\n");
  console.log(results.join("\n"));
  console.log(banner);
  (window as unknown as { __TEST_DONE__?: boolean }).__TEST_DONE__ = true;
  (window as unknown as { __TEST_PASSED__?: boolean }).__TEST_PASSED__ = failed === 0;
}

run().catch((error) => {
  console.error(error);
  const el = document.getElementById("results");
  if (el) el.textContent = `ERREUR NON GÉRÉE : ${error instanceof Error ? error.stack : String(error)}`;
  (window as unknown as { __TEST_DONE__?: boolean }).__TEST_DONE__ = true;
  (window as unknown as { __TEST_PASSED__?: boolean }).__TEST_PASSED__ = false;
});
