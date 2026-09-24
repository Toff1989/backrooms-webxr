import * as THREE from "three";
import type { Hand } from "../player/hand";
import type { UiPanel } from "./uiPanel";

const LASER_IDLE_LENGTH = 0.6;
const LASER_COLOR = 0xffe3a0;

interface HandPointer {
  hand: Hand;
  line: THREE.Line;
  cursor: THREE.Mesh;
  hovered: UiPanel | null;
}

export interface PointerFrame {
  /** Panneau visé par cette main (null si aucun). */
  target: UiPanel | null;
  /** L'appui grip de cette frame a été consommé par un menu : ne rien attraper dans le monde. */
  consumedGrip: boolean;
}

/**
 * Pointeur laser des menus (convention VR standard) : dès qu'un panneau est ouvert, chaque
 * main projette un rayon ; gâchette = clic, grip sur un emplacement d'objet = le prendre en main.
 */
export class UiPointer {
  private readonly pointers: HandPointer[];
  private readonly frames = new Map<Hand, PointerFrame>();

  constructor(
    hands: Hand[],
    scene: THREE.Scene,
    private readonly panels: UiPanel[],
  ) {
    this.pointers = hands.map((hand) => {
      const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]);
      const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: LASER_COLOR, transparent: true, opacity: 0.55, depthWrite: false, fog: false }));
      line.frustumCulled = false;
      line.visible = false;
      line.renderOrder = 11;
      const cursor = new THREE.Mesh(
        new THREE.RingGeometry(0.004, 0.008, 20),
        new THREE.MeshBasicMaterial({ color: LASER_COLOR, depthTest: false, transparent: true, fog: false }),
      );
      cursor.visible = false;
      cursor.renderOrder = 12;
      scene.add(line, cursor);
      return { hand, line, cursor, hovered: null };
    });
    for (const hand of hands) this.frames.set(hand, { target: null, consumedGrip: false });
  }

  frame(hand: Hand): PointerFrame {
    return this.frames.get(hand)!;
  }

  update(): void {
    const anyVisible = this.panels.some((panel) => panel.visible);
    for (const pointer of this.pointers) {
      const { hand } = pointer;
      const frame = this.frames.get(hand)!;
      frame.target = null;
      frame.consumedGrip = false;

      if (!anyVisible || !hand.tracked) {
        this.setHover(pointer, null, null, null);
        pointer.line.visible = false;
        pointer.cursor.visible = false;
        continue;
      }

      let best: { panel: UiPanel; hit: NonNullable<ReturnType<UiPanel["raycast"]>> } | null = null;
      for (const panel of this.panels) {
        const hit = panel.raycast(hand.aimOrigin, hand.aimDirection);
        if (hit && (!best || hit.distance < best.hit.distance)) best = { panel, hit };
      }

      const end = best ? best.hit.point : hand.aimOrigin.clone().addScaledVector(hand.aimDirection, LASER_IDLE_LENGTH);
      const positions = pointer.line.geometry.getAttribute("position") as THREE.BufferAttribute;
      positions.setXYZ(0, hand.aimOrigin.x, hand.aimOrigin.y, hand.aimOrigin.z);
      positions.setXYZ(1, end.x, end.y, end.z);
      positions.needsUpdate = true;
      pointer.line.visible = true;

      if (!best) {
        this.setHover(pointer, null, null, null);
        pointer.cursor.visible = false;
        continue;
      }

      frame.target = best.panel;
      pointer.cursor.visible = true;
      pointer.cursor.position.copy(best.hit.point);
      pointer.cursor.quaternion.copy(best.panel.group.getWorldQuaternion(new THREE.Quaternion()));
      this.setHover(pointer, best.panel, best.hit.px, best.hit.py);

      if (hand.input.trigger.justPressed) best.panel.onPress(hand, best.hit.px, best.hit.py, "trigger");
      if (hand.input.squeeze.justPressed && !hand.holding) {
        frame.consumedGrip = best.panel.onPress(hand, best.hit.px, best.hit.py, "grip");
      }
    }
    for (const panel of this.panels) panel.refresh();
  }

  private setHover(pointer: HandPointer, panel: UiPanel | null, px: number | null, py: number | null): void {
    if (pointer.hovered && pointer.hovered !== panel) pointer.hovered.onHover(pointer.hand, null, null);
    pointer.hovered = panel;
    if (panel) panel.onHover(pointer.hand, px, py);
  }
}
