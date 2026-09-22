import { Injectable, signal } from '@angular/core';
import * as THREE from 'three';
import { ViewerService } from './viewer.service';
import { TreeService } from './tree.service';
import { SelectionService } from './selection.service';
import { PropertyService } from './property.service';
import { HistoryService } from './history.service';
import { generateId } from '../utils/id-generator.util';
import { CadBody } from '../models/cad-body.model';
import { PatternAxis, PatternKind, PatternToolState, IDLE_PATTERN_TOOL } from '../models/pattern-tool.model';

const AXIS_VECTORS: Record<PatternAxis, THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1)
};

/**
 * Linear/Circular Pattern: array-copies the currently selected body along a direction (linear)
 * or around an axis (circular). Unlike FilletChamferToolService/PrimitiveToolService, this is
 * purely a rigid-body duplication — no topology change, no OCCT/worker round-trip — so it's
 * built as a direct extension of Viewport.contextMenuDuplicate's existing shape (shared geometry
 * reference since it's immutable, cloned material so per-copy color/opacity edits don't cross-
 * affect) rather than following FilletChamferToolService's worker-request pattern. That also
 * means, unlike Fillet/Chamfer, this works uniformly on ANY body regardless of origin
 * (STEP-imported, sketch-extruded, primitive, or already-filleted) — there's no STEP-source
 * re-read to gate it on.
 *
 * Not wired into ToolService's click-driven ActiveTool machine the way Sketch/BridgeMesh/
 * Fillet-Chamfer are: this tool needs no viewport picking step, only a target body (read once
 * from SelectionService at activation) and numeric fields, so it's driven entirely by its own
 * panel, the same "selection-gated panel" shape AppChrome's Transform buttons use (gated on
 * hasSelection()) rather than the "click-to-pick" shape BridgeMeshService/FilletChamferToolService
 * use. It still gets an ActiveTool value ('pattern') purely so it reuses ToolPanels' existing
 * open/close/dock/mutual-exclusion machinery for free, matching every other tool panel.
 */
@Injectable({ providedIn: 'root' })
export class PatternToolService {
  readonly state = signal<PatternToolState>(IDLE_PATTERN_TOOL);
  readonly lastError = signal<string | null>(null);

  constructor(
    private readonly viewer: ViewerService,
    private readonly tree: TreeService,
    private readonly selection: SelectionService,
    private readonly property: PropertyService,
    private readonly history: HistoryService
  ) {}

  /** Snapshots the current primary selection as the pattern target — called once when the tool activates (ToolService.setTool('pattern')), not read live thereafter, so a stray selection change mid-configuration can't silently retarget a half-set-up pattern. */
  activate(): void {
    const bodyId = this.selection.state().selectedBodyId;
    this.state.set({ ...IDLE_PATTERN_TOOL, targetBodyId: bodyId });
    this.lastError.set(null);
  }

  setKind(kind: PatternKind): void {
    this.state.update((st) => ({ ...st, kind }));
  }

  setAxis(axis: PatternAxis): void {
    this.state.update((st) => ({ ...st, axis }));
  }

  setSpacing(spacing: number): void {
    if (!Number.isFinite(spacing) || spacing === 0) return;
    this.state.update((st) => ({ ...st, spacing }));
  }

  setTotalAngle(totalAngle: number): void {
    if (!Number.isFinite(totalAngle) || totalAngle === 0) return;
    this.state.update((st) => ({ ...st, totalAngle }));
  }

  setCount(count: number): void {
    if (!Number.isInteger(count) || count < 2) return;
    this.state.update((st) => ({ ...st, count }));
  }

  targetBody(): CadBody | null {
    const id = this.state().targetBodyId;
    return id ? (this.tree.allBodies().find((b) => b.id === id) ?? null) : null;
  }

  canCommit(): boolean {
    return this.targetBody() !== null && this.state().count >= 2;
  }

  /**
   * Builds `count - 1` copies (the original stays where it is, matching how the panel's own
   * "count" field is documented as inclusive) and registers all of them as one undo step —
   * a deliberate difference from Duplicate's one-copy-per-click undo entries, since undoing a
   * pattern one instance at a time would be a strange interaction for something the user
   * configured and applied as a single operation. Mirrors Viewport.contextMenuDuplicate's own
   * mesh-clone/register shape exactly, just loop-driven and batched into one HistoryCommand.
   */
  commit(): void {
    const original = this.targetBody();
    if (!original || !this.canCommit()) {
      throw new Error('Select a part and set a count of 2 or more first.');
    }

    const st = this.state();
    const offsets = computeOffsets(st);

    const created: { mesh: THREE.Mesh; body: CadBody }[] = [];
    for (let i = 0; i < offsets.length; i++) {
      const { translation, rotation } = offsets[i];
      const material = (Array.isArray(original.mesh.material) ? original.mesh.material[0] : original.mesh.material).clone() as THREE.MeshStandardMaterial;
      const mesh = new THREE.Mesh(original.geometry, material);
      mesh.position.copy(original.mesh.position);
      mesh.quaternion.copy(original.mesh.quaternion);
      mesh.scale.copy(original.mesh.scale);
      if (st.kind === 'linear') {
        mesh.position.add(translation);
      } else {
        // Circular: rotate the instance's position around the target's own origin, then apply
        // the same rotation to its orientation, so the copy both orbits and re-faces outward
        // (matches SolidWorks/Fusion circular pattern behavior) rather than only translating.
        mesh.position.sub(original.mesh.position).applyAxisAngle(AXIS_VECTORS[st.axis], rotation).add(original.mesh.position);
        mesh.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(AXIS_VECTORS[st.axis], rotation));
      }
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const bodyId = generateId('body');
      mesh.userData['bodyId'] = bodyId;
      mesh.userData['faceIdMap'] = original.mesh.userData['faceIdMap'];

      // boundingBox must reflect this copy's own transform, not a reused reference to the
      // original's world-space box — computed from the shared LOCAL geometry box (present since
      // every CadBody-producing path already calls geometry.computeBoundingBox()) against this
      // mesh's own matrixWorld, the same technique FilletChamferToolService/StepLoaderService use.
      mesh.updateMatrixWorld(true);
      const boundingBox = original.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld);

      const body: CadBody = {
        ...original,
        id: bodyId,
        name: `${original.name} (Pattern ${i + 2})`,
        mesh,
        boundingBox
      };
      created.push({ mesh, body });
    }

    const nodeIds: (string | null)[] = created.map(() => null);
    this.history.run({
      label: `${st.kind === 'linear' ? 'Linear' : 'Circular'} Pattern: ${original.name} (${st.count})`,
      redo: () => {
        created.forEach(({ mesh, body }, i) => {
          this.viewer.addBody(mesh);
          nodeIds[i] = this.tree.registerBody(body);
        });
      },
      undo: () => {
        created.forEach(({ mesh, body }, i) => {
          const nodeId = nodeIds[i];
          if (!nodeId) return;
          this.tree.deleteBody(nodeId);
          this.viewer.removeBody(mesh);
          if (this.selection.state().selectedBodyId === body.id) this.selection.clearSelection();
          this.property.clearIfSelected(body.id);
        });
      }
    });

    this.state.set(IDLE_PATTERN_TOOL);
  }

  cancel(): void {
    this.state.set(IDLE_PATTERN_TOOL);
    this.lastError.set(null);
  }
}

/** One instance's transform delta relative to the original — translation for linear, an angle (radians) to orbit by for circular. */
function computeOffsets(st: PatternToolState): { translation: THREE.Vector3; rotation: number }[] {
  const copies = st.count - 1;
  const offsets: { translation: THREE.Vector3; rotation: number }[] = [];

  if (st.kind === 'linear') {
    const dir = AXIS_VECTORS[st.axis];
    for (let i = 1; i <= copies; i++) {
      offsets.push({ translation: dir.clone().multiplyScalar(st.spacing * i), rotation: 0 });
    }
  } else {
    // Full-circle (360°) divides evenly by count so the last instance doesn't land back on the
    // original; a partial sweep divides by (count - 1) so the last instance lands exactly at
    // totalAngle, matching mainstream CAD circular-pattern convention for the two cases.
    const isFullCircle = Math.abs(st.totalAngle % 360) < 1e-6;
    const stepDeg = st.totalAngle / (isFullCircle ? st.count : copies);
    for (let i = 1; i <= copies; i++) {
      offsets.push({ translation: new THREE.Vector3(), rotation: THREE.MathUtils.degToRad(stepDeg * i) });
    }
  }

  return offsets;
}
