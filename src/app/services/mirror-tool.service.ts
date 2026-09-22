import { Injectable, signal } from '@angular/core';
import * as THREE from 'three';
import { ViewerService } from './viewer.service';
import { TreeService } from './tree.service';
import { SelectionService } from './selection.service';
import { PropertyService } from './property.service';
import { HistoryService } from './history.service';
import { generateId } from '../utils/id-generator.util';
import { CadBody } from '../models/cad-body.model';
import { IDLE_MIRROR_TOOL, MirrorPlane, MirrorToolState } from '../models/mirror-tool.model';

/** Same convention SketchService's DATUM_NORMALS uses for a datum plane's world-space normal — kept as a separate constant rather than importing SketchService's (private, unexported) one, matching how PatternToolService keeps its own AXIS_VECTORS rather than reaching into another tool's internals. */
const DATUM_NORMALS: Record<MirrorPlane, THREE.Vector3> = {
  XY: new THREE.Vector3(0, 0, 1),
  YZ: new THREE.Vector3(1, 0, 0),
  XZ: new THREE.Vector3(0, 1, 0)
};

/**
 * Mirror: reflects the currently selected body across a fixed global datum plane (XY/YZ/XZ,
 * through the world origin — the same three planes Sketch's datum option already exposes),
 * adding one reflected copy while leaving the original untouched. Scoped like Pattern, not
 * Fillet/Chamfer: a rigid-body transform, not a topology change, so it's built as a sibling of
 * PatternToolService (shared immutable geometry reference, cloned material, no OCCT/worker
 * round-trip) rather than FilletChamferToolService's STEP-source-re-read shape. Practical
 * consequence, same as Pattern: works uniformly on ANY body regardless of origin (STEP-imported,
 * sketch-extruded, primitive, fillet/chamfered, or already-patterned/mirrored).
 *
 * The reflection itself is a negative-determinant scale on the mesh's own transform (mirroring
 * position through the plane, then negating the local axis aligned with the plane's normal) —
 * three.js's renderer already flips triangle winding automatically whenever an object's world
 * matrix has negative determinant, so front-facing normals stay correct with no need to touch
 * the shared geometry buffer itself (consistent with Pattern's approach of never mutating the
 * geometry it shares with the original).
 *
 * Not wired into ToolService's click-driven interaction shape, for the same reason Pattern isn't:
 * no viewport picking phase, just a target body (snapshotted once at activation) plus a plane
 * choice — driven entirely by its own panel. Gets an ActiveTool value ('mirror') purely to reuse
 * ToolPanels' open/close/dock/mutual-exclusion machinery for free.
 */
@Injectable({ providedIn: 'root' })
export class MirrorToolService {
  readonly state = signal<MirrorToolState>(IDLE_MIRROR_TOOL);
  readonly lastError = signal<string | null>(null);

  constructor(
    private readonly viewer: ViewerService,
    private readonly tree: TreeService,
    private readonly selection: SelectionService,
    private readonly property: PropertyService,
    private readonly history: HistoryService
  ) {}

  /** Snapshots the current primary selection as the mirror target — called once when the tool activates (ToolService.setTool('mirror')), not read live thereafter, matching PatternToolService.activate()'s exact reasoning. */
  activate(): void {
    const bodyId = this.selection.state().selectedBodyId;
    this.state.set({ ...IDLE_MIRROR_TOOL, targetBodyId: bodyId });
    this.lastError.set(null);
  }

  setPlane(plane: MirrorPlane): void {
    this.state.update((st) => ({ ...st, plane }));
  }

  targetBody(): CadBody | null {
    const id = this.state().targetBodyId;
    return id ? (this.tree.allBodies().find((b) => b.id === id) ?? null) : null;
  }

  canCommit(): boolean {
    return this.targetBody() !== null;
  }

  /**
   * Creates one reflected copy of the target body across the chosen datum plane, registered as
   * a single undo step — mirrors PatternToolService.commit()'s exact shape (mesh clone with
   * shared geometry + cloned material, register via TreeService, one HistoryService.run() entry)
   * with a reflection transform in place of a translate/rotate offset.
   */
  commit(): void {
    const original = this.targetBody();
    if (!original) {
      throw new Error('Select a part to mirror first.');
    }

    const st = this.state();
    const normal = DATUM_NORMALS[st.plane];

    const material = (Array.isArray(original.mesh.material) ? original.mesh.material[0] : original.mesh.material).clone() as THREE.MeshStandardMaterial;
    const mesh = new THREE.Mesh(original.geometry, material);
    mesh.position.copy(original.mesh.position);
    mesh.quaternion.copy(original.mesh.quaternion);
    mesh.scale.copy(original.mesh.scale);

    // Reflect position through the plane (which passes through the world origin): the component
    // of position along the plane's normal flips sign, the in-plane components are unchanged.
    const alongNormal = normal.dot(mesh.position);
    mesh.position.addScaledVector(normal, -2 * alongNormal);

    // Reflect orientation/scale: negate the local axis that (after the mesh's own rotation) is
    // most aligned with the world-space mirror normal. This keeps the reflection exact for the
    // common case (bodies aligned with world axes, or unrotated) and is the same "mirror via
    // negative scale" approach every mainstream 3D engine uses — three.js's renderer flips
    // triangle winding automatically whenever a mesh's world matrix has negative determinant, so
    // the shared geometry buffer never needs to be touched or cloned.
    const localAxis = worldNormalToDominantLocalAxis(normal, mesh.quaternion);
    mesh.scale[localAxis] *= -1;

    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const bodyId = generateId('body');
    mesh.userData['bodyId'] = bodyId;
    mesh.userData['faceIdMap'] = original.mesh.userData['faceIdMap'];

    mesh.updateMatrixWorld(true);
    const boundingBox = original.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld);

    const body: CadBody = {
      ...original,
      id: bodyId,
      name: `${original.name} (Mirror)`,
      mesh,
      boundingBox
    };

    let nodeId: string | null = null;
    this.history.run({
      label: `Mirror: ${original.name} (${st.plane})`,
      redo: () => {
        this.viewer.addBody(mesh);
        nodeId = this.tree.registerBody(body);
      },
      undo: () => {
        if (!nodeId) return;
        this.tree.deleteBody(nodeId);
        this.viewer.removeBody(mesh);
        if (this.selection.state().selectedBodyId === body.id) this.selection.clearSelection();
        this.property.clearIfSelected(body.id);
      }
    });

    this.state.set(IDLE_MIRROR_TOOL);
  }

  cancel(): void {
    this.state.set(IDLE_MIRROR_TOOL);
    this.lastError.set(null);
  }
}

/** Which local axis ('x' | 'y' | 'z'), once rotated by the mesh's own orientation, points most nearly along the given world-space normal — negating that axis's scale is what actually performs the reflection in the mesh's local frame. */
function worldNormalToDominantLocalAxis(worldNormal: THREE.Vector3, quaternion: THREE.Quaternion): 'x' | 'y' | 'z' {
  const inverse = quaternion.clone().invert();
  const localNormal = worldNormal.clone().applyQuaternion(inverse);
  const ax = Math.abs(localNormal.x);
  const ay = Math.abs(localNormal.y);
  const az = Math.abs(localNormal.z);
  if (ax >= ay && ax >= az) return 'x';
  if (ay >= az) return 'y';
  return 'z';
}
