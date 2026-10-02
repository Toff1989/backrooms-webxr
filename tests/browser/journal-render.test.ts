/**
 * Rendu 3D du journal : l'objet de l'archive en vitrine (repos), puis saisi par une main (tenu),
 * avec l'éclairage du jeu (ambiante + hémisphérique) — vérifie que le texte reste lisible.
 * Lancer : `node scripts/render-test.mjs journal-render`.
 */
import * as THREE from "three";
import { Journal } from "../../src/player/journal";
import type { LoreJournal } from "../../src/world/loreJournal";
import { createLogger, createRenderer, createStageController } from "./support/harness";

const { log } = createLogger();
const FRAGMENTS = [0, 1, 3, 4];
const NAMES = ["note", "fiche", "polaroid", "cassette"];
const stages = createStageController(NAMES.flatMap((name) => [`${name}-repos`, `${name}-tenue`]));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function fakeHand(): Record<string, unknown> {
  return {
    tracked: true,
    holding: null,
    palm: new THREE.Vector3(0.06, 1.5, -0.34),
    quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.4, 0.3, 0.2)),
    input: { squeeze: { justPressed: false, pressed: true }, trigger: { justPressed: false, pressed: false } },
    pulse: () => {},
  };
}

async function run(): Promise<void> {
  const canvas = document.getElementById("view") as HTMLCanvasElement;
  canvas.width = 1600;
  canvas.height = 900;
  const { renderer } = createRenderer();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14120f);
  // Même éclairage que le jeu (voir main.ts).
  scene.add(new THREE.HemisphereLight(0xfff3cf, 0x171512, 0.9), new THREE.AmbientLight(0xfff0c0, 0.25));
  const camera = new THREE.PerspectiveCamera(65, canvas.width / canvas.height, 0.03, 20);
  camera.position.set(0, 1.6, 0);
  scene.add(camera);
  camera.updateMatrixWorld(true);

  const lore = { count: 16, onChange: () => {}, sync: async () => null } as unknown as LoreJournal;
  const journal = new Journal(camera, scene, lore, { play: () => {} } as never);
  const panel = journal as unknown as Record<string, any>;
  const hand = fakeHand();

  const frame = (seconds: number): void => {
    for (let i = 0; i < Math.round(seconds * 60); i++) {
      journal.update(1 / 60, [hand as never]);
      journal.refresh();
    }
    renderer.render(scene, camera);
  };

  for (let i = 0; i < FRAGMENTS.length; i++) {
    const name = NAMES[i]!;
    journal.close();
    panel["selected"] = FRAGMENTS[i]!;
    journal.openFloating();
    panel["selected"] = FRAGMENTS[i]!;
    panel["refreshDisplay"]();
    await sleep(900);
    frame(1.5);
    const size = new THREE.Box3().setFromObject(panel["display"].object.template).getSize(new THREE.Vector3());
    log(`${name} : vitrine, boîte ${size.x.toFixed(3)} × ${size.y.toFixed(3)} × ${size.z.toFixed(3)} m`);
    await stages.enter(`${name}-repos`);

    // Grip visé sur le centre de la vitrine : l'objet vient dans la main.
    (hand["input"] as Record<string, Record<string, boolean>>)["squeeze"]!["justPressed"] = true;
    journal.onPress(hand as never, 800, 300, "grip");
    frame(2);
    log(`${name} : tenu (retour en vitrine au relâchement)`);
    await stages.enter(`${name}-tenue`);
    (hand["input"] as Record<string, Record<string, boolean>>)["squeeze"]!["pressed"] = false;
    frame(1.5);
    (hand["input"] as Record<string, Record<string, boolean>>)["squeeze"]!["pressed"] = true;
  }
  (window as unknown as Record<string, boolean>)["__done"] = true;
}

run().catch((error) => {
  log(`ERREUR : ${error instanceof Error ? error.stack : String(error)}`);
  stages.fail();
});
