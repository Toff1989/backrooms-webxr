import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

/**
 * Loader glTF/Draco partagé : un seul décodeur Draco chargé pour tout le jeu, réutilisé
 * par le mobilier (`propLoader.ts`) et les objets de collection (`collectibleLoader.ts`).
 */
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath("/draco/");

export const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);
