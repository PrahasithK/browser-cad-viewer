import { Injectable, signal } from '@angular/core';
import * as THREE from 'three';
import { ViewerService } from './viewer.service';
import { TreeService } from './tree.service';
import { CameraService } from './camera.service';
import { SelectionService } from './selection.service';
import { PropertyService } from './property.service';
import { ShellRendererService } from './shell-renderer.service';
import { generateId } from '../utils/id-generator.util';
import { toCadBodyEdges } from '../utils/edge-geometry.util';
import { CadBody } from '../models/cad-body.model';
import { IDLE_SHELL_TOOL, ShellToolState } from '../models/shell-tool.model';
import { ShellRequest, StepWorkerRequest, StepWorkerResponse, WorkerTessellatedBody } from '../workers/step-worker-messages.model';

/**
 * Click-to-select-faces tool for Shell (hollow-out), the face-picking analogue of
 * FilletChamferToolService (edge-picking): activate → pick one or more faces on a single
 * existing body (the faces to REMOVE/open) → configure wall thickness → commit. Same one-shot
 * worker-per-call shape FilletChamferToolService already established (no persistent
 * ModelingSessionService session needed — Shell, like Fillet/Chamfer, always operates on a body
 * that already fully exists, never an in-progress sketch).
 */
@Injectable({ providedIn: 'root' })
export class ShellToolService {
  readonly state = signal<ShellToolState>(IDLE_SHELL_TOOL);
  readonly busy = signal(false);
  readonly lastError = signal<string | null>(null);

  constructor(
    private readonly viewer: ViewerService,
    private readonly tree: TreeService,
    private readonly camera: CameraService,
    private readonly selection: SelectionService,
    private readonly property: PropertyService,
    private readonly renderer: ShellRendererService
  ) {}

  setThickness(thickness: number): void {
    if (!Number.isFinite(thickness) || thickness <= 0) return;
    this.state.update((st) => ({ ...st, thickness }));
  }

  /** Toggles one face in/out of the pick set — re-clicking an already-picked face removes it, same convention FilletChamferToolService.pickEdge already established for edges. All picks must be on the same body (a shell is one boolean op against one target solid); picking a face on a different body restarts the pick set. */
  pickFace(body: CadBody, faceIndex: number): void {
    this.lastError.set(null);
    const st = this.state();

    const existingBodyId = st.picks[0]?.bodyId;
    let picks = st.picks;
    if (existingBodyId && existingBodyId !== body.id) {
      picks = [];
    }

    const alreadyPicked = picks.some((p) => p.bodyId === body.id && p.faceIndex === faceIndex);
    picks = alreadyPicked ? picks.filter((p) => !(p.bodyId === body.id && p.faceIndex === faceIndex)) : [...picks, { bodyId: body.id, faceIndex }];

    this.state.set({ ...st, picks, phase: picks.length > 0 ? 'configuring' : 'picking-faces' });
    this.syncHighlight();
  }

  showHover(body: CadBody | null, faceIndex: number | null): void {
    this.renderer.showHoverFace(body, faceIndex);
  }

  private syncHighlight(): void {
    const bodies = this.tree.allBodies();
    const picks = this.state()
      .picks.map((p) => {
        const body = bodies.find((b) => b.id === p.bodyId);
        return body ? { body, faceIndex: p.faceIndex } : null;
      })
      .filter((p): p is { body: CadBody; faceIndex: number } => p !== null);
    this.renderer.setPickedFaces(picks);
  }

  canCommit(): boolean {
    return this.state().picks.length > 0 && this.state().thickness > 0;
  }

  /** Re-reads the picked body's original STEP source bytes — identical resolution to SketchService.resolveCutTarget/FilletChamferToolService.resolveTargetBody. */
  private async resolveTargetBody(bodyId: string): Promise<{ bytes: Uint8Array; solidIndex: number } | null> {
    const body = this.tree.allBodies().find((b) => b.id === bodyId);
    if (!body) return null;
    const nodeId = this.tree.getNodeIdForMesh(body.mesh);
    const source = nodeId ? this.tree.getImportSource(nodeId) : undefined;
    if (!source) return null;

    const buffer = typeof source === 'string' ? await (await fetch(source)).arrayBuffer() : await source.arrayBuffer();
    return { bytes: new Uint8Array(buffer), solidIndex: body.solidIndex };
  }

  async commit(): Promise<void> {
    const st = this.state();
    if (!this.canCommit()) throw new Error('Pick at least one face to remove first');

    this.busy.set(true);
    this.lastError.set(null);
    try {
      const bodyId = st.picks[0].bodyId;
      const nodeId = this.tree.getNodeIdForMesh(this.tree.allBodies().find((b) => b.id === bodyId)!.mesh);
      const targetBody = await this.resolveTargetBody(bodyId);
      if (!targetBody || !nodeId) {
        throw new Error(
          "This body has no retained STEP source to re-read (only STEP-imported bodies currently support Shell — sketch/primitive-created bodies aren't supported yet)."
        );
      }

      const result = await this.runWorker({
        requestId: generateId('shell'),
        targetBody,
        faceIndices: st.picks.map((p) => p.faceIndex),
        thickness: st.thickness
      });

      this.replaceBodyInScene(nodeId, result);
      this.state.set(IDLE_SHELL_TOOL);
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

  /** One-shot worker call, mirroring FilletChamferToolService.runWorker's shape exactly (spin up a worker, post one request, resolve/reject on the matching response, terminate). */
  private runWorker(req: ShellRequest): Promise<WorkerTessellatedBody> {
    return new Promise<WorkerTessellatedBody>((resolve, reject) => {
      const worker = new Worker(new URL('../workers/step-loader.worker.ts', import.meta.url), { type: 'module' });

      worker.onmessage = (event: MessageEvent<StepWorkerResponse>) => {
        const msg = event.data;
        if (msg.type !== 'shell.result' || msg.requestId !== req.requestId) return;
        worker.terminate();
        if (!msg.success || !msg.body) {
          reject(new Error(msg.error ?? 'Shell failed'));
          return;
        }
        resolve(msg.body);
      };
      worker.onerror = (event: ErrorEvent) => {
        worker.terminate();
        reject(new Error(event.message));
      };

      const request: StepWorkerRequest = { type: 'feature.shell', ...req };
      worker.postMessage(request, [req.targetBody.bytes.buffer]);
    });
  }

  /** Builds the resulting mesh/CadBody and swaps it into the same tree node — mirrors FilletChamferToolService.replaceBodyInScene exactly. */
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
    this.state.set(IDLE_SHELL_TOOL);
    this.lastError.set(null);
    this.renderer.clear();
  }
}
