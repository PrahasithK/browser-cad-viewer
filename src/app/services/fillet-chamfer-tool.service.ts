import { Injectable, signal } from '@angular/core';
import * as THREE from 'three';
import { ViewerService } from './viewer.service';
import { TreeService } from './tree.service';
import { CameraService } from './camera.service';
import { SelectionService } from './selection.service';
import { PropertyService } from './property.service';
import { FilletChamferRendererService } from './fillet-chamfer-renderer.service';
import { ModelingSessionService } from './modeling-session.service';
import { SketchService } from './sketch.service';
import { FeatureTreeService } from './feature-tree.service';
import { generateId } from '../utils/id-generator.util';
import { randomBodyColor } from '../utils/color.util';
import { toCadBodyEdges } from '../utils/edge-geometry.util';
import { CadBody } from '../models/cad-body.model';
import { FilletChamferKind, IDLE_FILLET_CHAMFER, FilletChamferState } from '../models/fillet-chamfer.model';
import { DocBodyRef, FilletChamferEdgeValue, WorkerTessellatedBody } from '../workers/step-worker-messages.model';

/**
 * Click-to-select-edges tool for Fillet/Chamfer, the interaction-domain analogue of
 * PrimitiveToolService (click-to-place) and BridgeMeshService (click-to-pick-face): activate →
 * pick one or more edges on a single existing body → configure radius/distance → commit.
 *
 * Feature-tree-aware since Slice 5 (parametric feature tree) — `commit()` now goes through
 * `ModelingSessionService`'s persistent session (like Extrude/Revolve/Sweep/Loft) instead of a
 * one-shot `Worker` spun up per call, and registers into `FeatureTreeService` so the result shows
 * up as an editable Feature Tree row. Reuses `SketchService.resolveCutTargetForPickedFace`-style
 * resolution via `TreeService.getFeatureId`/`resolveFeatureCutTarget` (see `resolveTargetBody`
 * below) so a fillet/chamfer can target either a STEP-imported body or a prior feature-tree
 * feature's own output — the same widening Sweep/Loft each got in their own slices.
 */
@Injectable({ providedIn: 'root' })
export class FilletChamferToolService {
  readonly state = signal<FilletChamferState>(IDLE_FILLET_CHAMFER);
  readonly busy = signal(false);
  readonly lastError = signal<string | null>(null);

  /**
   * Serializes `commitEditOfFilletChamferFeature` calls PER featureId — identical protection to
   * `SketchService`'s own `pendingFeatureEdits`/`runSerializedFeatureEdit` (see that class's
   * docstring for the real race a bare `Set`-based drop-on-conflict guard let through: a fast
   * Ctrl+Z immediately followed by Ctrl+Y could silently lose the redo). Not shared with
   * `SketchService`'s own map since each service only ever serializes edits to features IT owns
   * — a different service's featureId space never collides in practice, but keeping the maps
   * separate avoids any cross-service coupling for no benefit.
   */
  private readonly pendingFeatureEdits = new Map<string, Promise<void>>();

  private runSerializedFeatureEdit(featureId: string, fn: () => Promise<void>): Promise<void> {
    const prior = this.pendingFeatureEdits.get(featureId) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(fn);
    this.pendingFeatureEdits.set(featureId, next.catch(() => {}));
    return next;
  }

  constructor(
    private readonly viewer: ViewerService,
    private readonly tree: TreeService,
    private readonly camera: CameraService,
    private readonly selection: SelectionService,
    private readonly property: PropertyService,
    private readonly renderer: FilletChamferRendererService,
    private readonly session: ModelingSessionService,
    private readonly sketch: SketchService,
    private readonly featureTree: FeatureTreeService
  ) {}

  setKind(kind: FilletChamferKind): void {
    this.state.update((st) => ({ ...st, kind, defaultValue: kind === 'fillet' ? 3 : st.defaultValue }));
  }

  /** Sets the value NEW picks will start at — does not touch already-picked edges' own values (see PickedEdge's own docstring). */
  setDefaultValue(value: number): void {
    if (!Number.isFinite(value) || value <= 0) return;
    this.state.update((st) => ({ ...st, defaultValue: value }));
  }

  /** Sets one already-picked edge's own value independently of every other picked edge — the "variable-radius fillet" input, added 2026-09-13. */
  setEdgeValue(bodyId: string, edgeIndex: number, value: number): void {
    if (!Number.isFinite(value) || value <= 0) return;
    this.state.update((st) => ({
      ...st,
      picks: st.picks.map((p) => (p.bodyId === bodyId && p.edgeIndex === edgeIndex ? { ...p, value } : p))
    }));
  }

  /** Toggles one edge in/out of the pick set — re-clicking an already-picked edge removes it, matching how sketch reference points and multi-select both treat a repeat click as a toggle. All picks must be on the same body (a fillet/chamfer is one boolean op against one target solid); picking an edge on a different body starts a fresh pick set with just that edge, same "switch target" convention BridgeMeshService uses when the second pick lands on the same body as the first (there: an error; here: simpler to just restart since order doesn't matter for a same-body multi-edge set). A newly-added edge starts at the panel's current `defaultValue`, independently editable afterward via `setEdgeValue`. */
  pickEdge(body: CadBody, edgeIndex: number): void {
    this.lastError.set(null);
    const st = this.state();

    const existingBodyId = st.picks[0]?.bodyId;
    let picks = st.picks;
    if (existingBodyId && existingBodyId !== body.id) {
      picks = [];
    }

    const alreadyPicked = picks.some((p) => p.bodyId === body.id && p.edgeIndex === edgeIndex);
    picks = alreadyPicked ? picks.filter((p) => !(p.bodyId === body.id && p.edgeIndex === edgeIndex)) : [...picks, { bodyId: body.id, edgeIndex, value: st.defaultValue }];

    this.state.set({ ...st, picks, phase: picks.length > 0 ? 'configuring' : 'picking-edges' });
    this.syncHighlight();
  }

  showHover(body: CadBody | null, edgeIndex: number | null): void {
    this.renderer.showHoverEdge(body, edgeIndex);
  }

  private syncHighlight(): void {
    const bodies = this.tree.allBodies();
    const picks = this.state()
      .picks.map((p) => {
        const body = bodies.find((b) => b.id === p.bodyId);
        return body ? { body, edgeIndex: p.edgeIndex } : null;
      })
      .filter((p): p is { body: CadBody; edgeIndex: number } => p !== null);
    this.renderer.setPickedEdges(picks);
  }

  canCommit(): boolean {
    return this.state().picks.length > 0 && this.state().picks.every((p) => p.value > 0);
  }

  /**
   * Resolves the picked body to a `DocBodyRef` — either a prior feature-tree feature's own live
   * output (`TreeService.getFeatureId`) or a re-read of its STEP source
   * (`TreeService.resolveFeatureCutTarget`), via `SketchService.resolveCutTargetForPickedFace`
   * (Slice 5: reused as-is rather than re-implemented here, so this resolution logic stays in
   * exactly one place — see that method's own docstring). This is what lifts the old "only
   * STEP-imported, never-yet-modified bodies" restriction for the feature-tree-created-body case:
   * a Fillet/Chamfer can now target an Extrude/Revolve/Sweep/Loft feature's own result directly.
   */
  private async resolveTargetBody(bodyId: string): Promise<{ nodeId: string; targetBody: DocBodyRef } | undefined> {
    const body = this.tree.allBodies().find((b) => b.id === bodyId);
    if (!body) return undefined;
    const faceIndex = 0; // resolveCutTargetForPickedFace only reads pickedFace.bodyId — faceIndex is unused by the resolution itself, kept only to satisfy the shared type.
    return this.sketch.resolveCutTargetForPickedFace({ bodyId, faceIndex });
  }

  async commit(): Promise<void> {
    const st = this.state();
    if (!this.canCommit()) throw new Error('Pick at least one edge first');

    this.busy.set(true);
    this.lastError.set(null);
    try {
      const bodyId = st.picks[0].bodyId;
      const resolved = await this.resolveTargetBody(bodyId);
      if (!resolved) {
        throw new Error(
          "This body has no retained STEP source to re-read (only STEP-imported bodies, or bodies produced by an earlier Extrude/Revolve/Sweep/Loft feature, currently support Fillet/Chamfer — primitive/Shell/Draft-created bodies aren't supported yet)."
        );
      }
      const { nodeId, targetBody } = resolved;

      await this.session.start();
      const producesBodyId = generateId('body');
      const featureId = generateId('feature');
      const edges: FilletChamferEdgeValue[] = st.picks.map((p) => ({ edgeIndex: p.edgeIndex, value: p.value }));

      const result = await this.session.filletChamfer(st.kind, targetBody, edges, producesBodyId, featureId);
      const primaryBody = result.bodies[0];
      if (!primaryBody) throw new Error(`${st.kind} produced no triangulation`);

      this.replaceBodyInScene(nodeId, primaryBody, producesBodyId);
      this.tree.linkFeature(nodeId, featureId);
      this.featureTree.register({
        featureId,
        kind: 'filletChamfer',
        label: st.kind === 'fillet' ? 'Fillet' : 'Chamfer',
        params: { filletChamferKind: st.kind, edges },
        nodeId
      });

      this.state.set(IDLE_FILLET_CHAMFER);
      this.renderer.clear();
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
   * Edits a previously-created fillet/chamfer feature's per-edge values (and/or fillet↔chamfer
   * kind) and replays it plus every feature after it in the worker's history — same shape as
   * `SketchService.commitEditOfSweepFeature`/`commitEditOfLoftFeature`. The picked edge SET
   * itself is fixed at creation (same restriction Loft's own profile set has); only already-picked
   * edges' own values are editable here, matching what the standalone tool panel already allows.
   */
  async commitEditOfFilletChamferFeature(featureId: string, filletChamferKind: FilletChamferKind, edges: FilletChamferEdgeValue[]): Promise<void> {
    return this.runSerializedFeatureEdit(featureId, async () => {
      const record = this.featureTree.find(featureId);
      if (!record) throw new Error('Feature not found');

      this.busy.set(true);
      this.lastError.set(null);
      try {
        const result = await this.session.editFilletChamfer(featureId, { filletChamferKind, edges });
        for (const b of result.bodies) {
          if (!b.producesBodyId) continue;
          const targetNodeId = this.findNodeIdForFeatureProduct(b.producesBodyId);
          if (targetNodeId) this.replaceBodyInScene(targetNodeId, b, b.producesBodyId);
        }
        this.featureTree.update(featureId, { filletChamferKind, edges });
        this.camera.fitAll();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.lastError.set(message);
        throw err;
      } finally {
        this.busy.set(false);
      }
    });
  }

  /** Same lookup `SketchService.findNodeIdForFeatureProduct` uses — kept as its own small copy here rather than making that method public, since this is the only other caller. */
  private findNodeIdForFeatureProduct(producesBodyId: string): string | undefined {
    const body = this.tree.allBodies().find((b) => b.id === producesBodyId);
    if (!body) return undefined;
    return this.tree.getNodeIdForMesh(body.mesh);
  }

  /**
   * Builds the resulting mesh/CadBody and swaps it into the same tree node — mirrors
   * SketchService.replaceBodyInScene exactly (same dispose/select-clear/replace sequence), since a
   * fillet/chamfer is conceptually "the same cut-target-and-replace-in-place operation, just with
   * a different worker maker class." `idOverride`, when passed (Slice 5), keeps the resulting
   * `CadBody.id` stable across an edit/replay — mirrors `SketchService.buildCadBodyFromResult`'s
   * own `idOverride` param, needed so `findNodeIdForFeatureProduct` can find this same body again
   * by id after a later edit.
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

    const color = oldBody.color || randomBodyColor(b.solidIndex);
    const material = new THREE.MeshStandardMaterial({ color, metalness: 0.15, roughness: 0.55, side: THREE.DoubleSide });
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
      color,
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
    this.state.set({ ...IDLE_FILLET_CHAMFER, kind: this.state().kind });
    this.lastError.set(null);
    this.renderer.clear();
  }
}
