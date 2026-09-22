import { Injectable, signal } from '@angular/core';
import * as THREE from 'three';
import { ModelingSessionService } from './modeling-session.service';
import { ViewerService } from './viewer.service';
import { TreeService } from './tree.service';
import { CameraService } from './camera.service';
import { SketchRendererService } from './sketch-renderer.service';
import { SelectionService } from './selection.service';
import { PropertyService } from './property.service';
import { generateId } from '../utils/id-generator.util';
import { toCadBodyEdges } from '../utils/edge-geometry.util';
import { planeRefInBodyFrame } from '../utils/body-frame.util';
import { getFacePlane, extractFaceReferencePoints, pickUAxis } from '../utils/face-geometry.util';
import { FeatureCutTarget, PlaneRef, SketchEntity, WorkerTessellatedBody } from '../workers/step-worker-messages.model';
import { CadBody } from '../models/cad-body.model';
import { HoleFit, HoleStandard, HoleWizardState, IDLE_HOLE_WIZARD, holePresetsFor } from '../models/hole-wizard.model';

/** How far past a body's own thickness the through-cut extrudes, so the hole reliably punches all the way through regardless of the picked face's local thickness — same "guarantee it goes all the way through" idea the user-manual's own Sketch cut guidance already recommends manually (§5.1's Example B: "Set Depth larger than the bracket's thickness"), just computed automatically here from the body's real bounding box instead of asking the user to guess a number. */
const THROUGH_DEPTH_MARGIN = 1.25;

/**
 * Hole Wizard: standard-fastener-size through-holes on a picked face of an existing STEP-imported
 * part, without the user having to sketch a circle and guess a depth by hand. Deliberately scoped
 * to simple through-holes only (v1) — counterbore/countersink need a SECOND cut into the same
 * body, which today's cut pipeline can't do (a body's `hasStepSource` is cleared after its first
 * cut — see TreeService.replaceBody's docstring — so a second targeted cut would silently degrade
 * to "no target"/no-op rather than compounding). That's flagged as a real, separate follow-on in
 * architecture.md rather than worked around here.
 *
 * Built as a thin, purpose-specific service reusing SketchService's already-proven pieces rather
 * than driving SketchService's own interactive state machine (which is shaped around 2-click
 * freeform drawing, not a preset-driven single click): face-plane resolution
 * (face-geometry.util.ts, identical to Sketch's face-pick phase), SketchRendererService for the
 * face highlight/reference points/live preview (already scene-agnostic and reusable, per its own
 * docstring), and ModelingSessionService.commitSketch/extrude — the exact same two worker calls
 * SketchService.finishAndExtrude makes internally, just with a circle entity built from a preset
 * diameter instead of two freeform clicks. This mirrors FilletChamferToolService's own precedent
 * of duplicating a small resolve/replace-in-scene helper locally rather than reaching into
 * SketchService's private internals for it.
 */
@Injectable({ providedIn: 'root' })
export class HoleWizardService {
  readonly state = signal<HoleWizardState>(IDLE_HOLE_WIZARD);
  readonly busy = signal(false);
  readonly lastError = signal<string | null>(null);

  constructor(
    private readonly session: ModelingSessionService,
    private readonly viewer: ViewerService,
    private readonly tree: TreeService,
    private readonly camera: CameraService,
    private readonly sketchRenderer: SketchRendererService,
    private readonly selection: SelectionService,
    private readonly property: PropertyService
  ) {}

  /** Entry point once a face is picked — resolves its plane, highlights it, orients the camera, and populates snap references, identical to SketchService.beginFromFace's shape. */
  async beginFromFace(body: CadBody, faceIndex: number): Promise<void> {
    this.lastError.set(null);

    const nodeId = this.tree.getNodeIdForMesh(body.mesh);
    const hasSource = nodeId ? !!this.tree.getImportSource(nodeId) : false;
    if (!hasSource) {
      this.lastError.set(
        'This part has no retained STEP source to re-read (only STEP-imported, un-cut parts currently support Hole Wizard).'
      );
      return;
    }

    const plane = getFacePlane(body, faceIndex);
    if (!plane) {
      this.lastError.set('Selected face is not planar — Hole Wizard needs a flat face.');
      return;
    }

    const uAxis = pickUAxis(plane.normal);
    const vAxis = plane.normal.clone().cross(uAxis).normalize();
    const referencePoints = extractFaceReferencePoints(body, faceIndex, plane);

    this.sketchRenderer.clear();
    this.sketchRenderer.highlightFace(body, faceIndex);
    this.sketchRenderer.showReferencePoints(referencePoints);
    // `CadBody.boundingBox` is already world-space — see the matching note in `SketchService.beginFromFace`.
    this.camera.animateToFace(plane.origin, plane.normal, body.boundingBox);

    this.state.set({
      ...IDLE_HOLE_WIZARD,
      standard: this.state().standard,
      presetIndex: this.state().presetIndex,
      fit: this.state().fit,
      phase: 'picking-point',
      pickedFace: { bodyId: body.id, faceIndex },
      facePlane: {
        origin: [plane.origin.x, plane.origin.y, plane.origin.z],
        normal: [plane.normal.x, plane.normal.y, plane.normal.z],
        uAxis: [uAxis.x, uAxis.y, uAxis.z],
        vAxis: [vAxis.x, vAxis.y, vAxis.z]
      },
      referencePoints
    });
  }

  /** Converts a world-space raycast hit into the picked face's local (u,v) coordinates — same projection SketchService.projectToPlane uses for its face-plane branch. */
  projectToPlane(worldPoint: THREE.Vector3): [number, number] | null {
    const st = this.state();
    if (st.phase !== 'picking-point' || !st.facePlane) return null;
    const origin = new THREE.Vector3(...st.facePlane.origin);
    const uAxis = new THREE.Vector3(...st.facePlane.uAxis);
    const vAxis = new THREE.Vector3(...st.facePlane.vAxis);
    const rel = worldPoint.clone().sub(origin);
    return [rel.dot(uAxis), rel.dot(vAxis)];
  }

  planeNormal(): THREE.Vector3 | null {
    const st = this.state();
    return st.facePlane ? new THREE.Vector3(...st.facePlane.normal) : null;
  }

  planeOrigin(): THREE.Vector3 | null {
    const st = this.state();
    return st.facePlane ? new THREE.Vector3(...st.facePlane.origin) : null;
  }

  setCenter(uv: [number, number]): void {
    const st = this.state();
    if (st.phase !== 'picking-point') return;
    this.state.set({ ...st, phase: 'configuring', center: uv });
    this.syncPreview();
  }

  setStandard(standard: HoleStandard): void {
    this.state.update((st) => ({ ...st, standard, presetIndex: 0 }));
    this.syncPreview();
  }

  setPresetIndex(index: number): void {
    const presets = holePresetsFor(this.state().standard);
    if (index < 0 || index >= presets.length) return;
    this.state.update((st) => ({ ...st, presetIndex: index }));
    this.syncPreview();
  }

  setFit(fit: HoleFit): void {
    this.state.update((st) => ({ ...st, fit }));
    this.syncPreview();
  }

  currentDiameter(): number {
    const st = this.state();
    const presets = holePresetsFor(st.standard);
    return presets[st.presetIndex]?.diameters[st.fit] ?? presets[0].diameters[st.fit];
  }

  currentLabel(): string {
    const st = this.state();
    return holePresetsFor(st.standard)[st.presetIndex]?.label ?? '';
  }

  private syncPreview(): void {
    const st = this.state();
    if (!st.center || !st.facePlane) {
      this.sketchRenderer.showPreview(null, { origin: new THREE.Vector3(), uAxis: new THREE.Vector3(), vAxis: new THREE.Vector3() });
      return;
    }
    const entity: SketchEntity = { type: 'circle', id: generateId('circle'), center: st.center, radius: this.currentDiameter() / 2 };
    this.sketchRenderer.showPreview([entity], {
      origin: new THREE.Vector3(...st.facePlane.origin),
      uAxis: new THREE.Vector3(...st.facePlane.uAxis),
      vAxis: new THREE.Vector3(...st.facePlane.vAxis)
    });
  }

  canCommit(): boolean {
    const st = this.state();
    return st.phase === 'configuring' && st.center !== null && st.pickedFace !== null;
  }

  /** Re-reads the picked body's original STEP source bytes — identical resolution to SketchService.resolveCutTarget/FilletChamferToolService.resolveTargetBody. */
  private async resolveCutTarget(bodyId: string): Promise<FeatureCutTarget | undefined> {
    const body = this.tree.allBodies().find((b) => b.id === bodyId);
    if (!body) return undefined;
    const nodeId = this.tree.getNodeIdForMesh(body.mesh);
    const source = nodeId ? this.tree.getImportSource(nodeId) : undefined;
    if (!source) return undefined;

    const buffer = typeof source === 'string' ? await (await fetch(source)).arrayBuffer() : await source.arrayBuffer();
    return { bytes: new Uint8Array(buffer), solidIndex: body.solidIndex };
  }

  async commit(): Promise<void> {
    const st = this.state();
    if (!this.canCommit()) throw new Error('Pick a face and a hole center first.');

    this.busy.set(true);
    this.lastError.set(null);
    try {
      const bodyId = st.pickedFace!.bodyId;
      const body = this.tree.allBodies().find((b) => b.id === bodyId);
      const nodeId = body ? this.tree.getNodeIdForMesh(body.mesh) : null;
      if (!body || !nodeId) throw new Error('Target part is no longer available.');

      const targetBody = await this.resolveCutTarget(bodyId);
      if (!targetBody) {
        throw new Error(
          'This part has no retained STEP source to re-read (only STEP-imported, un-cut parts currently support Hole Wizard).'
        );
      }

      await this.session.start();
      const planeRef: PlaneRef = planeRefInBodyFrame(
        { kind: 'face', origin: st.facePlane!.origin, normal: st.facePlane!.normal, uAxis: st.facePlane!.uAxis },
        body.mesh
      );
      const entity: SketchEntity = { type: 'circle', id: generateId('circle'), center: st.center!, radius: this.currentDiameter() / 2 };

      const sketchId = generateId('sketch');
      const commitResult = await this.session.commitSketch(sketchId, planeRef, [entity]);
      if (!commitResult.success) throw new Error(commitResult.error ?? 'Hole sketch commit failed');

      // Depth guarantees a clean through-cut regardless of the picked face's local thickness —
      // the same "extrude both directions from the sketch plane" tool-solid construction the
      // 2026-08-06 cut-direction bug fix already relies on worker-side means this only needs to
      // be at least as deep as the body's own diagonal, not aimed precisely at the opposite face.
      const size = body.boundingBox.getSize(new THREE.Vector3());
      const depth = Math.max(size.x, size.y, size.z) * THROUGH_DEPTH_MARGIN;

      // ModelingSessionService.extrude's targetBody is a DocBodyRef (widened for the parametric
      // feature tree, Slice 1 — see that method's docstring); Hole Wizard doesn't opt into the
      // feature tree (no producesBodyId passed), so it just wraps its existing plain
      // STEP-source-bytes target in the 'imported' variant.
      const result = await this.session.extrude(sketchId, depth, true, { kind: 'imported', ...targetBody });
      this.replaceBodyInScene(nodeId, result.bodies[0]);

      this.state.set({ ...IDLE_HOLE_WIZARD, standard: st.standard, presetIndex: st.presetIndex, fit: st.fit });
      this.sketchRenderer.clear();
      this.camera.fitAll();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError.set(message);
      throw err;
    } finally {
      this.busy.set(false);
    }
  }

  /** Builds the resulting mesh/CadBody and swaps it into the same tree node — same dispose/select-clear/replace sequence SketchService.replaceBodyInScene and FilletChamferToolService.replaceBodyInScene both already use. */
  private replaceBodyInScene(nodeId: string, b: WorkerTessellatedBody): void {
    const oldBody = this.tree.getBodyForNodeId(nodeId);
    if (!oldBody) return;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(b.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(b.indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    const material = (Array.isArray(oldBody.mesh.material) ? oldBody.mesh.material[0] : oldBody.mesh.material).clone() as THREE.MeshStandardMaterial;
    const mesh3d = new THREE.Mesh(geometry, material);
    mesh3d.castShadow = true;
    mesh3d.receiveShadow = true;

    const bodyId = generateId('body');
    mesh3d.userData['bodyId'] = bodyId;
    mesh3d.userData['faceIdMap'] = b.faceIdMap;

    const newBody: CadBody = {
      id: bodyId,
      name: oldBody.name,
      solidIndex: b.solidIndex,
      mesh: mesh3d,
      geometry,
      visible: true,
      color: oldBody.color,
      opacity: oldBody.opacity,
      boundingBox: geometry.boundingBox?.clone() ?? new THREE.Box3(),
      volume: b.volume,
      surfaceArea: b.surfaceArea,
      faceCount: b.faceCount,
      edgeCount: b.edgeCount,
      faceIdMap: b.faceIdMap,
      edges: toCadBodyEdges(b.edges)
    };

    if (this.selection.state().selectedBodyId === oldBody.id) {
      this.selection.clearSelection();
    }
    this.property.clearIfSelected(oldBody.id);
    this.viewer.removeBody(oldBody.mesh);

    this.viewer.addBody(newBody.mesh);
    this.tree.replaceBody(nodeId, newBody);
  }

  cancel(): void {
    this.state.set({ ...IDLE_HOLE_WIZARD, standard: this.state().standard, presetIndex: this.state().presetIndex, fit: this.state().fit });
    this.lastError.set(null);
    this.sketchRenderer.clear();
  }
}
