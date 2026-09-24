import { perf } from "../player/perfStats";
import RAPIER from "@dimforge/rapier3d-compat";
import { WALL_HEIGHT } from "../shared/constants";

export { RAPIER };

/**
 * Groupes de collision (appartenance). Deux colliders interagissent seulement si chacun
 * accepte l'appartenance de l'autre dans son filtre — les filtres ci-dessous sont donc
 * symétriques deux à deux.
 */
export const Groups = {
  STATIC: 1 << 0,
  PLAYER: 1 << 1,
  HAND: 1 << 2,
  DYNAMIC: 1 << 3,
  /** Objet tenu en main : cogne le décor et les autres objets, jamais le corps/les mains du joueur. */
  HELD: 1 << 4,
} as const;

function interaction(membership: number, filter: number): number {
  return (((membership & 0xffff) << 16) | (filter & 0xffff)) >>> 0;
}

export const CollisionGroups = {
  static: interaction(Groups.STATIC, Groups.PLAYER | Groups.DYNAMIC | Groups.HELD),
  player: interaction(Groups.PLAYER, Groups.STATIC | Groups.DYNAMIC),
  hand: interaction(Groups.HAND, Groups.DYNAMIC),
  dynamic: interaction(Groups.DYNAMIC, Groups.STATIC | Groups.PLAYER | Groups.HAND | Groups.DYNAMIC | Groups.HELD),
  held: interaction(Groups.HELD, Groups.STATIC | Groups.DYNAMIC),
  /** Requête "que peut-on attraper ici ?" : ne voit que les objets dynamiques libres. */
  queryGrabbable: interaction(Groups.HAND, Groups.DYNAMIC),
  /** Requête de visée (saisie à distance) : décor + objets, pour que les murs masquent. */
  querySight: interaction(Groups.PLAYER, Groups.STATIC | Groups.DYNAMIC),
} as const;

/** Pas de simulation borné : suit la cadence du casque (72/90 Hz) sans sauts, coupé en deux sur un gros à-coup. */
const MIN_STEP = 1 / 120;
const MAX_STEP = 1 / 45;
/** Demi-côté des dalles sol/plafond : couvre largement la zone chargée (5 chunks de 20 m). */
const BOUNDS_HALF_EXTENT = 80;

/**
 * Monde physique Rapier (moteur rigide WASM) : sol et plafond infinis (un seul collider
 * chacun, jamais retirés — pas de couture entre chunks), murs/piliers ajoutés par chunk
 * (voir `ChunkStreamer`), objets dynamiques (mobilier, collection), corps cinématiques du
 * joueur et des mains.
 */
export class PhysicsWorld {
  readonly world: RAPIER.World;
  private readonly bounds: RAPIER.RigidBody;

  private constructor() {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

    const bounds = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    // Dalles de sol/plafond de taille raisonnable, recentrées sur le joueur (`recenter`) : une
    // boîte de 10 km donnait des contacts imprécis en flottants 32 bits — les meubles lourds
    // tremblaient sur le sol sans jamais s'endormir.
    this.bounds = bounds;
    this.world.createCollider(
      // Épaisse (5 m) : un objet qui apparaît enfoncé est toujours repoussé vers le haut.
      RAPIER.ColliderDesc.cuboid(BOUNDS_HALF_EXTENT, 5, BOUNDS_HALF_EXTENT)
        .setTranslation(0, -5, 0)
        .setFriction(0.9)
        .setCollisionGroups(CollisionGroups.static),
      bounds,
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(BOUNDS_HALF_EXTENT, 0.5, BOUNDS_HALF_EXTENT)
        .setTranslation(0, WALL_HEIGHT + 0.5, 0)
        .setCollisionGroups(CollisionGroups.static),
      bounds,
    );
  }

  /** Recentre les dalles sol/plafond sous le joueur (à chaque changement de chunk). */
  recenter(x: number, z: number): void {
    this.bounds.setTranslation({ x, y: 0, z }, true);
  }

  static async create(): Promise<PhysicsWorld> {
    await RAPIER.init();
    return new PhysicsWorld();
  }

  /**
   * Avance la simulation de `deltaSeconds`. `beforeStep` est appelé avant chaque pas
   * (cibles des corps cinématiques, suivi des objets tenus), avec la durée du pas.
   */
  step(deltaSeconds: number, beforeStep: (stepSeconds: number) => void): void {
    const clamped = Math.max(MIN_STEP, deltaSeconds);
    const steps = clamped > MAX_STEP ? Math.min(3, Math.ceil(clamped / MAX_STEP)) : 1;
    const stepSeconds = Math.min(MAX_STEP, clamped / steps);
    this.world.timestep = stepSeconds;
    for (let i = 0; i < steps; i++) {
      beforeStep(stepSeconds);
      perf?.begin("rapier");
      this.world.step();
      perf?.end("rapier");
    }
  }
}
