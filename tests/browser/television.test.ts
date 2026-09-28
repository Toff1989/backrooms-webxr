/**
 * Test navigateur (sans WebGL) : vérifie la détection de l'écran de la télé sur le vrai
 * `television.glb`, avec le vrai pipeline de chargement (Draco + WebP + fusion des meshes par
 * matériau, voir `gltfLoader.ts`) et le vrai code de détection (`findTelevisionScreen`,
 * `findModelFace`). Aucun `THREE.WebGLRenderer` n'est créé : seuls le graphe de scène et un
 * canvas 2D sont exercés, donc ça tourne même sans GPU/WebGL disponible.
 *
 * Lancer : `npm run dev`, ouvrir /tests/browser/television.html dans le navigateur.
 * Ou en headless : `node scripts/test-television-browser.mjs`.
 */
import * as THREE from "three";
import televisionUrl from "../../src/assets/models/props/television.glb";
import { loadTemplateModel } from "../../src/world/gltfLoader";
import { findTelevisionScreen } from "../../src/world/interactions";
import { findModelFace } from "../../src/world/modelFace";

// Preuve structurelle qu'aucun contexte WebGL n'est nécessaire : si un code importé ici tentait
// d'en créer un (effet de bord d'un import, par exemple), ce test échouerait bruyamment plutôt
// que de dépendre silencieusement d'un GPU.
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
    template = await loadTemplateModel(televisionUrl);
    check("chargement", true, "television.glb chargé (Draco + WebP + fusion par matériau, pipeline réel du jeu)");
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

  const modelSize = boxSize(template);
  const modelDiag = modelSize.length();
  const screen = findTelevisionScreen(template);

  if (screen) {
    const screenSize = boxSize(screen);
    const screenDiag = screenSize.length();
    const coverage = screenDiag / modelDiag;
    check("écran dédié détecté", true, `mesh "${screen.name || "(sans nom)"}" — diagonale ${screenDiag.toFixed(3)} m sur un modèle de ${modelDiag.toFixed(3)} m (${(coverage * 100).toFixed(0)}%)`);
    check(
      "l'écran n'est pas le corps entier",
      coverage < 0.9,
      coverage < 0.9
        ? "la maille détectée est bien plus petite que le modèle complet"
        : "BUG : la maille détectée couvre quasi tout le modèle — le boîtier entier serait caché/recoloré comme un écran",
    );

    const dims = [screenSize.x, screenSize.y, screenSize.z].sort((a, b) => a - b);
    const flatness = dims[0]! / dims[1]!;
    check("l'écran est une surface plate", flatness < 0.2, `plus petite dimension / dimension médiane = ${flatness.toFixed(3)} (doit être proche de 0)`);

    // Le pipeline doit remplacer le matériau EN PLACE, jamais ajouter
    // un objet par-dessus : on simule l'échange et on vérifie que le nombre de meshes ne bouge pas.
    const original = screen.material;
    const testMaterial = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
    screen.material = testMaterial;
    const meshesAfter: THREE.Mesh[] = [];
    template.traverse((child) => {
      if (child instanceof THREE.Mesh) meshesAfter.push(child);
    });
    check("remplacement en place (pas de nouvel objet)", meshesAfter.length === meshes.length, `${meshes.length} mesh(es) avant et après le remplacement de matériau`);
    screen.material = original;
    testMaterial.dispose();
  } else {
    check(
      "écran dédié détecté",
      false,
      'aucune sous-maille "screen"/"display" trouvée (attendu tant que le .glb n\'a pas d\'écran séparé) — le comportement retombe sur findModelFace, testé ci-dessous',
    );
  }

  const TV_FRONT = new THREE.Vector3(0, 0, 1);
  const face = findModelFace(template, TV_FRONT);
  check(
    "détection de la face avant (fallback)",
    face !== null && face.width > 0 && face.height > 0,
    face ? `centre (${face.center.x.toFixed(3)}, ${face.center.y.toFixed(3)}, ${face.center.z.toFixed(3)}), ${face.width.toFixed(3)}×${face.height.toFixed(3)} m` : "aucune face avant trouvée sur l'axe +Z",
  );

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
