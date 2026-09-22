import { Injectable, signal } from '@angular/core';
import * as THREE from 'three';
import { SketchService } from './sketch.service';
import { ModelingSessionService } from './modeling-session.service';
import { ViewerService } from './viewer.service';
import { TreeService } from './tree.service';
import { CameraService } from './camera.service';
import { SelectionService } from './selection.service';
import { PropertyService } from './property.service';
import { FeatureTreeService } from './feature-tree.service';
import { generateId } from '../utils/id-generator.util';
import { randomBodyColor } from '../utils/color.util';
import { toCadBodyEdges } from '../utils/edge-geometry.util';
import { CadBody } from '../models/cad-body.model';
import { IDLE_LOFT_TOOL, LoftToolState } from '../models/loft-tool.model';
import { WorkerTessellatedBody } from '../workers/step-worker-messages.model';

/**
 * Loft drives SketchService's existing plane-pick/draw phases to collect 2+ profiles one at a
 * time (each committed but not yet built into anything), then blends between all of them at
 * once. This composition — reusing SketchService rather than reimplementing plane-picking and
 * shape-drawing a second time — is why LoftToolService depends on SketchService directly rather
 * than going through ToolService's mutual-exclusion the way every other tool does; while Loft is
 * active, the viewport's Sketch-click routing (viewport.ts) is what's actually driving
 * SketchService underneath, exactly as if plain Sketch were active, just with LoftToolService
 * intercepting the "profile complete" moment to commit-and-continue instead of finish-and-build.
 */
@Injectable({ providedIn: 'root' })
export class LoftToolService {
  readonly state = signal<LoftToolState>(IDLE_LOFT_TOOL);
  readonly busy = signal(false);
  readonly lastError = signal<string | null>(null);

  constructor(
    private readonly sketch: SketchService,
    private readonly session: ModelingSessionService,
    private readonly viewer: ViewerService,
    private readonly tree: TreeService,
    private readonly camera: CameraService,
    private readonly selection: SelectionService,
    private readonly property: PropertyService,
    private readonly featureTree: FeatureTreeService
  ) {}

  activate(): void {
    this.state.set(IDLE_LOFT_TOOL);
    this.lastError.set(null);
  }

  /** True once the CURRENT (not-yet-committed) profile has enough points to be a closed shape — same check Extrude/Revolve/Sweep gate their own finish buttons on. */
  canCommitCurrentProfile(): boolean {
    return this.sketch.canFinishSketch();
  }

  /** Commits the in-progress profile, adds it to the cross-section list, and resets SketchService back to picking a plane for the next profile — deliberately NOT calling SketchService.cancel(), which would also clear lastError/renderer state Loft doesn't own. */
  async addCurrentProfile(): Promise<void> {
    if (!this.canCommitCurrentProfile()) {
      throw new Error('Draw a closed profile before adding it to the Loft');
    }

    this.busy.set(true);
    this.lastError.set(null);
    try {
      const sketchId = await this.sketch.commitCurrentProfile();
      const pickedFace = this.sketch.state().pickedFace;
      this.state.update((st) => ({
        phase: 'ready-to-add-more',
        profiles: [...st.profiles, { sketchId, label: `Profile ${st.profiles.length + 1}`, pickedFace }]
      }));
      this.sketch.resetForNextProfile();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError.set(message);
      throw err;
    } finally {
      this.busy.set(false);
    }
  }

  canFinishLoft(): boolean {
    return this.state().profiles.length >= 2;
  }

  removeProfile(sketchId: string): void {
    this.state.update((st) => ({ ...st, profiles: st.profiles.filter((p) => p.sketchId !== sketchId) }));
  }

  /**
   * `cut` mirrors Extrude/Revolve/Sweep's own boss(add)/cut(remove) choice, and only has a real
   * effect when the FIRST profile was drawn on a picked face — added 2026-09-13, after v1
   * (2026-09-13, same day) shipped standalone-new-body-only. Per `feature.loft`'s own docstring
   * in step-worker-messages.model.ts, only the first profile's `pickedFace` is ever consulted;
   * later profiles just shape the blend.
   *
   * Opts into the parametric feature tree (Slice 4, mirroring `finishAndExtrude`/`Revolve`/
   * `Sweep`'s own treatment exactly): generates `producesBodyId`/`featureId` up front, registers
   * the result with `TreeService.linkFeature`/`FeatureTreeService` on success.
   */
  async finishLoft(cut = false): Promise<void> {
    if (!this.canFinishLoft()) {
      throw new Error('Loft needs at least 2 profiles');
    }

    this.busy.set(true);
    this.lastError.set(null);
    try {
      const profiles = this.state().profiles;
      const sketchIds = profiles.map((p) => p.sketchId);
      const resolved = await this.sketch.resolveCutTargetForPickedFace(profiles[0].pickedFace);

      const producesBodyId = generateId('body');
      const featureId = generateId('feature');
      const result = await this.session.loft(sketchIds, cut, resolved?.targetBody, producesBodyId, featureId);
      const resultNodeId = this.addResultToScene(result.bodies, resolved?.nodeId, producesBodyId);
      if (resultNodeId) {
        this.tree.linkFeature(resultNodeId, featureId);
        this.featureTree.register({
          featureId,
          kind: 'loft',
          label: `Loft`,
          sketchIds,
          params: { cut },
          nodeId: resultNodeId
        });
      }
      this.state.set(IDLE_LOFT_TOOL);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError.set(message);
      throw err;
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Mirrors SketchService's own addResultToScene exactly, including the replaceNodeId branch
   * (added 2026-09-13, alongside Loft's own cut/fuse-into-an-existing-part support) — when set,
   * the FIRST returned body replaces that node in place; any additional bodies are appended as new
   * ones, same as the always-append path. `producesBodyId` (Slice 4) becomes the FIRST returned
   * body's `CadBody.id` instead of a freshly generated one, and the method now returns the node id
   * the first (primary) result body ended up at — same feature-tree-linking shape
   * `SketchService.addResultToScene` already established.
   */
  private addResultToScene(bodies: WorkerTessellatedBody[], replaceNodeId?: string, producesBodyId?: string): string | undefined {
    let firstBody = true;
    let firstNodeId: string | undefined;
    for (const b of bodies) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(b.positions, 3));
      geometry.setIndex(new THREE.BufferAttribute(b.indices, 1));
      geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();

      const color = randomBodyColor(b.solidIndex);
      const material = new THREE.MeshStandardMaterial({ color, metalness: 0.15, roughness: 0.55, side: THREE.DoubleSide });
      const mesh3d = new THREE.Mesh(geometry, material);
      mesh3d.castShadow = true;
      mesh3d.receiveShadow = true;

      const bodyId = firstBody && producesBodyId ? producesBodyId : generateId('body');
      mesh3d.userData['bodyId'] = bodyId;
      mesh3d.userData['faceIdMap'] = b.faceIdMap;

      const newBody: CadBody = {
        id: bodyId,
        name: `Feature Body ${b.solidIndex + 1}`,
        solidIndex: b.solidIndex,
        mesh: mesh3d,
        geometry,
        visible: true,
        color,
        opacity: 1,
        boundingBox: geometry.boundingBox?.clone() ?? new THREE.Box3(),
        volume: b.volume,
        surfaceArea: b.surfaceArea,
        faceCount: b.faceCount,
        edgeCount: b.edgeCount,
        faceIdMap: b.faceIdMap,
        edges: toCadBodyEdges(b.edges)
      };

      if (firstBody && replaceNodeId) {
        this.replaceBodyInScene(replaceNodeId, newBody);
        firstNodeId = replaceNodeId;
      } else {
        this.viewer.addBody(mesh3d);
        const nodeId = this.tree.registerBody(newBody);
        if (firstBody) firstNodeId = nodeId;
      }
      firstBody = false;
    }
    this.camera.fitAll();
    return firstNodeId;
  }

  /** Disposes the old mesh, clears selection/properties if it was the active one, and swaps in the new body at the same tree node — mirrors SketchService's own replaceBodyInScene exactly. */
  private replaceBodyInScene(nodeId: string, newBody: CadBody): void {
    const oldBody = this.tree.getBodyForNodeId(nodeId);
    if (!oldBody) {
      this.viewer.addBody(newBody.mesh);
      this.tree.registerBody(newBody);
      return;
    }

    if (this.selection.state().selectedBodyId === oldBody.id) {
      this.selection.clearSelection();
    }
    this.property.clearIfSelected(oldBody.id);
    this.viewer.removeBody(oldBody.mesh);

    this.viewer.addBody(newBody.mesh);
    this.tree.replaceBody(nodeId, newBody);
  }

  cancel(): void {
    this.sketch.cancel();
    this.state.set(IDLE_LOFT_TOOL);
    this.lastError.set(null);
  }
}
