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
import { FeatureTreeService } from './feature-tree.service';
import { DocBodyRef, FeatureCutTarget, HoleFeatureParams, HoleType, PlaneRef, SketchEntity, WorkerTessellatedBody } from '../workers/step-worker-messages.model';
import { CadBody } from '../models/cad-body.model';
import { HoleFit, HoleStandard, HoleWizardState, IDLE_HOLE_WIZARD, holePresetsFor, standardEntrySizes } from '../models/hole-wizard.model';

/** Feature Tree row prefix per hole type — the row reads e.g. "Counterbore (M6, normal)". */
export const HOLE_TYPE_LABELS: Record<HoleType, string> = { simple: 'Hole', counterbore: 'Counterbore', countersink: 'Countersink' };

/** How far past a body's own thickness the through-cut extrudes, so the hole reliably punches all the way through regardless of the picked face's local thickness — same "guarantee it goes all the way through" idea the user-manual's own Sketch cut guidance already recommends manually (§5.1's Example B: "Set Depth larger than the bracket's thickness"), just computed automatically here from the body's real bounding box instead of asking the user to guess a number. */
const THROUGH_DEPTH_MARGIN = 1.25;

/**
 * Hole Wizard: standard-fastener-size through-holes, optionally counterbored or countersunk, on a
 * picked face of a STEP-imported part or a feature-tree body, without the user having to sketch a
 * circle and guess a depth by hand. Each hole is its own `kind: 'hole'` feature (2026-09-24; holes
 * were plain `'extrude'` cuts before counterbore/countersink needed a compound tool solid — see
 * the worker's `buildHoleToolSolid`), so its type and every size stay editable in the Feature Tree.
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

  /** Serializes `commitEditOfHoleFeature` calls per featureId — same protection as `FilletChamferToolService`'s own (a fast Ctrl+Z then Ctrl+Y must not lose the redo). */
  private readonly pendingFeatureEdits = new Map<string, Promise<void>>();

  private runSerializedFeatureEdit(featureId: string, fn: () => Promise<void>): Promise<void> {
    const prior = this.pendingFeatureEdits.get(featureId) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(fn);
    this.pendingFeatureEdits.set(featureId, next.catch(() => {}));
    return next;
  }

  constructor(
    private readonly session: ModelingSessionService,
    private readonly viewer: ViewerService,
    private readonly tree: TreeService,
    private readonly camera: CameraService,
    private readonly sketchRenderer: SketchRendererService,
    private readonly selection: SelectionService,
    private readonly property: PropertyService,
    private readonly featureTree: FeatureTreeService
  ) {}

  /** Entry point once a face is picked — resolves its plane, highlights it, orients the camera, and populates snap references, identical to SketchService.beginFromFace's shape. */
  async beginFromFace(body: CadBody, faceIndex: number): Promise<void> {
    this.lastError.set(null);

    // A body qualifies if it has a retained STEP source OR is itself a feature-tree body
    // (featureId set) — the same two paths resolveFeatureAwareCutTarget checks at commit time.
    // Checking it here too, not just at commit, is what lets a SECOND Hole Wizard cut even start
    // (pick a face) on a body that was already cut once by a Hole Wizard/Extrude/Revolve/Sweep —
    // without this, the pick itself was rejected before commit()'s own fix ever ran.
    const nodeId = this.tree.getNodeIdForMesh(body.mesh);
    const qualifies = nodeId ? !!this.tree.getFeatureId(nodeId) || !!this.tree.getImportSource(nodeId) : false;
    if (!qualifies) {
      this.lastError.set(
        'This part has no retained STEP source to re-read (only STEP-imported parts, or a part already produced by an editable feature, currently support Hole Wizard).'
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
      ...this.keptSettings(),
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
    this.state.update((st) => ({ ...st, standard, presetIndex: 0, ...standardEntrySizes(standard, 0) }));
    this.syncPreview();
  }

  setPresetIndex(index: number): void {
    const presets = holePresetsFor(this.state().standard);
    if (index < 0 || index >= presets.length) return;
    this.state.update((st) => ({ ...st, presetIndex: index, ...standardEntrySizes(st.standard, index) }));
    this.syncPreview();
  }

  setFit(fit: HoleFit): void {
    this.state.update((st) => ({ ...st, fit }));
    this.syncPreview();
  }

  setHoleType(holeType: HoleType): void {
    this.state.update((st) => ({ ...st, holeType }));
    this.syncPreview();
  }

  /** Sets one counterbore/countersink size; non-finite or non-positive values are ignored (the input keeps its last valid value). */
  setEntrySize(field: 'cboreDiameter' | 'cboreDepth' | 'csinkDiameter' | 'csinkAngleDeg', value: number): void {
    if (!Number.isFinite(value) || value <= 0) return;
    this.state.update((st) => ({ ...st, [field]: value }));
    this.syncPreview();
  }

  /** The settings that carry over from one hole to the next (everything except the face/center picks). */
  private keptSettings(): Pick<HoleWizardState, 'standard' | 'presetIndex' | 'fit' | 'holeType' | 'cboreDiameter' | 'cboreDepth' | 'csinkDiameter' | 'csinkAngleDeg'> {
    const { standard, presetIndex, fit, holeType, cboreDiameter, cboreDepth, csinkDiameter, csinkAngleDeg } = this.state();
    return { standard, presetIndex, fit, holeType, cboreDiameter, cboreDepth, csinkDiameter, csinkAngleDeg };
  }

  /** Why the current counterbore/countersink sizes can't be cut, or null when they're fine — shown in the panel and blocks Apply. The worker re-checks the depth-vs-thickness limits it alone knows. */
  entryError(): string | null {
    const st = this.state();
    const diameter = this.currentDiameter();
    if (st.holeType === 'counterbore' && st.cboreDiameter <= diameter) return `Counterbore diameter must be larger than the ${diameter.toFixed(2)} mm hole.`;
    if (st.holeType === 'countersink' && st.csinkDiameter <= diameter) return `Countersink diameter must be larger than the ${diameter.toFixed(2)} mm hole.`;
    if (st.holeType === 'countersink' && st.csinkAngleDeg >= 180) return 'Countersink angle must be less than 180°.';
    return null;
  }

  /** Outer diameter at the face — the counterbore/countersink diameter, or the hole itself for a simple hole. */
  private entryDiameter(): number {
    const st = this.state();
    if (st.holeType === 'counterbore') return st.cboreDiameter;
    if (st.holeType === 'countersink') return st.csinkDiameter;
    return this.currentDiameter();
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
    const entities: SketchEntity[] = [{ type: 'circle', id: generateId('circle'), center: st.center, radius: this.currentDiameter() / 2 }];
    if (st.holeType !== 'simple') {
      entities.push({ type: 'circle', id: generateId('circle'), center: st.center, radius: this.entryDiameter() / 2 });
    }
    this.sketchRenderer.showPreview(entities, {
      origin: new THREE.Vector3(...st.facePlane.origin),
      uAxis: new THREE.Vector3(...st.facePlane.uAxis),
      vAxis: new THREE.Vector3(...st.facePlane.vAxis)
    });
  }

  canCommit(): boolean {
    const st = this.state();
    return st.phase === 'configuring' && st.center !== null && st.pickedFace !== null && this.entryError() === null;
  }

  /** The full parameter set the worker builds this hole from. */
  private currentParams(depth: number): HoleFeatureParams {
    const st = this.state();
    return {
      holeType: st.holeType,
      diameter: this.currentDiameter(),
      depth,
      cboreDiameter: st.cboreDiameter,
      cboreDepth: st.cboreDepth,
      csinkDiameter: st.csinkDiameter,
      csinkAngleDeg: st.csinkAngleDeg
    };
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

  /**
   * Feature-tree-aware target resolution — a local duplicate of SketchService's own
   * `resolveFeatureAwareCutTarget` (same "duplicate a small helper locally" precedent
   * FilletChamferToolService's own `resolveTargetBody` already established, rather than making
   * SketchService's private method public for one other caller). Prefers a prior feature's own
   * output (`{kind:'feature', featureId}`, resolved against its live in-session shape) over a raw
   * STEP-bytes re-read — this is what makes a SECOND Hole Wizard cut (or a Fillet/Extrude/etc.)
   * on an already-feature-tree'd body work at all: a body's `hasStepSource` flag is cleared the
   * moment it's replaced by any cut (see `TreeService.replaceBody`'s own docstring), but
   * `featureId` is deliberately NOT cleared, so this check still finds it.
   */
  private async resolveFeatureAwareCutTarget(nodeId: string, bodyId: string): Promise<DocBodyRef | undefined> {
    const featureId = this.tree.getFeatureId(nodeId);
    if (featureId) return { kind: 'feature', featureId };
    const imported = await this.resolveCutTarget(bodyId);
    return imported ? { kind: 'imported', ...imported } : undefined;
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

      const targetBody = await this.resolveFeatureAwareCutTarget(nodeId, bodyId);
      if (!targetBody) {
        throw new Error(
          'This part has no retained STEP source to re-read (only STEP-imported parts, or a part already produced by an editable feature, currently support Hole Wizard).'
        );
      }

      await this.session.start();
      const planeRef: PlaneRef = planeRefInBodyFrame(
        { kind: 'face', origin: st.facePlane!.origin, normal: st.facePlane!.normal, uAxis: st.facePlane!.uAxis },
        body.mesh
      );
      const entity: SketchEntity = { type: 'circle', id: generateId('circle'), center: st.center!, radius: this.currentDiameter() / 2 };

      const sketchId = generateId('sketch');
      // Face-anchored (faceAnchorFeatureId below) via the same reanchorSketch mechanism a plain
      // Sketch cut gets, so the hole follows the face it was cut into if that face's own feature
      // is later edited.
      const producesBodyId = generateId('body');
      const featureId = generateId('feature');
      const faceAnchorFeatureId = this.tree.getFeatureId(nodeId) ?? undefined;
      const commitResult = await this.session.commitSketch(sketchId, planeRef, [entity], faceAnchorFeatureId);
      if (!commitResult.success) throw new Error(commitResult.error ?? 'Hole sketch commit failed');

      // Depth guarantees a clean through-cut regardless of the picked face's local thickness —
      // the worker cuts this far both ways from the face, so it only needs to be at least as deep
      // as the body's own largest dimension, not aimed precisely at the opposite face.
      const size = body.boundingBox.getSize(new THREE.Vector3());
      const depth = Math.max(size.x, size.y, size.z) * THROUGH_DEPTH_MARGIN;
      const params = this.currentParams(depth);

      const result = await this.session.hole(sketchId, params, targetBody, producesBodyId, featureId);
      this.replaceBodyInScene(nodeId, result.bodies[0], producesBodyId);

      this.tree.linkFeature(nodeId, featureId);
      this.featureTree.register({
        featureId,
        kind: 'hole',
        label: `${HOLE_TYPE_LABELS[st.holeType]} (${this.currentLabel()}, ${st.fit})`,
        sketchId,
        params,
        nodeId
      });

      this.state.set({ ...IDLE_HOLE_WIZARD, ...this.keptSettings() });
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

  /**
   * Changes a hole's type/sizes and replays it plus every feature after it — same shape as
   * `FilletChamferToolService.commitEditOfFilletChamferFeature`. The face and center are fixed
   * at creation; `depth` (the through-cut length) is carried over unchanged from the record.
   */
  async commitEditOfHoleFeature(featureId: string, params: HoleFeatureParams): Promise<void> {
    return this.runSerializedFeatureEdit(featureId, async () => {
      if (!this.featureTree.find(featureId)) throw new Error('Feature not found');

      this.busy.set(true);
      this.lastError.set(null);
      try {
        const result = await this.session.editHole(featureId, params);
        for (const b of result.bodies) {
          if (!b.producesBodyId) continue;
          const body = this.tree.allBodies().find((candidate) => candidate.id === b.producesBodyId);
          const targetNodeId = body ? this.tree.getNodeIdForMesh(body.mesh) : null;
          if (targetNodeId) this.replaceBodyInScene(targetNodeId, b, b.producesBodyId);
        }
        this.featureTree.update(featureId, params);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.lastError.set(message);
        throw err;
      } finally {
        this.busy.set(false);
      }
    });
  }

  /**
   * Builds the resulting mesh/CadBody and swaps it into the same tree node — same dispose/select-clear/replace sequence SketchService.replaceBodyInScene and FilletChamferToolService.replaceBodyInScene both already use.
   * `idOverride` (the feature's `producesBodyId`) keeps the body id stable, which is how an edit's
   * replay results find this body again. Before 2026-09-24 this always minted a fresh id, so edit
   * results for a hole body were silently never applied to the scene.
   */
  private replaceBodyInScene(nodeId: string, b: WorkerTessellatedBody, idOverride?: string): void {
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

    const bodyId = idOverride ?? generateId('body');
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
    this.state.set({ ...IDLE_HOLE_WIZARD, ...this.keptSettings() });
    this.lastError.set(null);
    this.sketchRenderer.clear();
  }
}
