import { Injectable, signal } from '@angular/core';
import * as THREE from 'three';
import { CadBody } from '../models/cad-body.model';
import { LoadingProgress, IDLE_PROGRESS } from '../models/loading-progress.model';
import { generateId } from '../utils/id-generator.util';
import { randomBodyColor } from '../utils/color.util';
import { toCadBodyEdges } from '../utils/edge-geometry.util';
import { PrimitiveSpec, StepWorkerRequest, StepWorkerResponse } from '../workers/step-worker-messages.model';

/** CAD "mesh view" appearance (CATIA / NX / SolidWorks): per-body shaded faces with every triangulation edge drawn as a thin grey line on top. */
const WIREFRAME_COLOR = 0x707070;

@Injectable({ providedIn: 'root' })
export class StepLoaderService {
  readonly progress = signal<LoadingProgress>(IDLE_PROGRESS);

  /** Loads a user-picked local STEP file by routing it through the same URL-based worker path (object URL is fetchable like any other URL). */
  async loadStepFileFromBlob(file: File): Promise<CadBody[]> {
    const objectUrl = URL.createObjectURL(file);
    try {
      return await this.loadStepFile(objectUrl);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  /** Creates a standalone 3D primitive solid (box/cylinder/sphere/cone) directly, bypassing the sketch/extrude pipeline — a one-shot worker call like `loadStepFile`, not a `ModelingSessionService` feature (no shape to chain onto). */
  async createPrimitive(spec: PrimitiveSpec): Promise<CadBody> {
    return new Promise<CadBody>((resolve, reject) => {
      const worker = new Worker(new URL('../workers/step-loader.worker.ts', import.meta.url), { type: 'module' });
      const requestId = generateId('primitive');

      worker.onmessage = (event: MessageEvent<StepWorkerResponse>) => {
        const msg = event.data;
        if (msg.type !== 'primitive.result' || msg.requestId !== requestId) return;

        worker.terminate();
        if (!msg.success || !msg.body) {
          reject(new Error(msg.error ?? 'Failed to create primitive'));
          return;
        }

        const b = msg.body;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(b.positions, 3));
        geometry.setIndex(new THREE.BufferAttribute(b.indices, 1));
        geometry.computeVertexNormals();
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();

        const color = randomBodyColor(0);
        const material = new THREE.MeshStandardMaterial({ color, metalness: 0.1, roughness: 0.6, side: THREE.DoubleSide });
        const mesh3d = new THREE.Mesh(geometry, material);
        mesh3d.castShadow = true;
        mesh3d.receiveShadow = true;

        const bodyId = generateId('body');
        mesh3d.userData['bodyId'] = bodyId;
        mesh3d.userData['faceIdMap'] = b.faceIdMap;

        resolve({
          id: bodyId,
          name: `${spec.kind[0].toUpperCase()}${spec.kind.slice(1)}`,
          solidIndex: 0,
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
        });
      };

      worker.onerror = (event: ErrorEvent) => {
        worker.terminate();
        reject(new Error(event.message));
      };

      const request: StepWorkerRequest = { type: 'primitive.create', requestId, spec };
      worker.postMessage(request);
    });
  }

  /**
   * STEP parsing runs in a dedicated Web Worker rather than on the main thread. OCCT's
   * embind/WASM STEP reader in this build has been observed to intermittently fail its very
   * first read on the main thread (returning IFSelect_RetError for an otherwise well-formed
   * file) — the same OCCT calls made in complete isolation always succeed, which points at
   * main-thread contention (Angular zones, WebGL context churn, etc.) rather than a bug in
   * the parsing logic itself. A worker gives OCCT its own thread and global scope, sidestepping
   * that contention entirely, and is the standard place to run CPU-heavy WASM work anyway.
   */
  async loadStepFile(url: string): Promise<CadBody[]> {
    return new Promise<CadBody[]>((resolve, reject) => {
      const worker = new Worker(new URL('../workers/step-loader.worker.ts', import.meta.url), { type: 'module' });
      const bodies: CadBody[] = [];

      worker.onmessage = (event: MessageEvent<StepWorkerResponse>) => {
        const msg = event.data;

        if (msg.type === 'progress') {
          this.progress.set({
            phase: msg.phase as LoadingProgress['phase'],
            message: msg.message,
            indeterminate: msg.indeterminate,
            percent: msg.percent,
            bodyIndex: msg.bodyIndex,
            bodyCount: msg.bodyCount
          });
          return;
        }

        if (msg.type === 'body') {
          const b = msg.body;

          // Render geometry stays the original OCCT triangulation — fast to shade, raycast, and
          // pick against. Mesh-view's dense grid only needs to exist on the *wireframe overlay*
          // (built below), never on the shaded fill, so the default view pays none of that cost.
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute('position', new THREE.Float32BufferAttribute(b.positions, 3));
          geometry.setIndex(new THREE.BufferAttribute(b.indices, 1));
          geometry.computeVertexNormals();
          geometry.computeBoundingBox();
          geometry.computeBoundingSphere();

          const color = randomBodyColor(b.solidIndex);
          const material = new THREE.MeshStandardMaterial({
            color,
            metalness: 0.05,
            roughness: 0.7,
            side: THREE.DoubleSide,
            // Pushes filled triangles back a hair in depth so the wireframe overlay draws cleanly on top without z-fighting.
            polygonOffset: true,
            polygonOffsetFactor: 1,
            polygonOffsetUnits: 1
          });
          const mesh3d = new THREE.Mesh(geometry, material);
          mesh3d.castShadow = true;
          mesh3d.receiveShadow = true;

          const bodyId = generateId('body');
          mesh3d.userData['bodyId'] = bodyId;
          mesh3d.userData['faceIdMap'] = b.faceIdMap;

          // Mesh View's wireframe is built from `meshViewPositions`/`meshViewIndices` — a second,
          // much finer tessellation of the same solid that the worker gets from OCCT's own
          // curvature-adaptive mesher (tight deflection), not a uniform re-split of the render
          // triangulation above. That's what gives it a real unstructured-FEA-mesh look: denser,
          // irregular triangles on curved/filleted regions, coarser on flat faces — a uniform
          // split can only ever produce a regular grid. See the worker's `MESH_VIEW_LINEAR_
          // DEFLECTION` docstring for the full reasoning (including why an earlier randomized-
          // jitter attempt at faking this client-side was reverted).
          const meshViewGeometry = new THREE.BufferGeometry();
          meshViewGeometry.setAttribute('position', new THREE.BufferAttribute(b.meshViewPositions, 3));
          meshViewGeometry.setIndex(new THREE.BufferAttribute(b.meshViewIndices, 1));

          const wireframeGeometry = new THREE.WireframeGeometry(meshViewGeometry);
          meshViewGeometry.dispose();
          const wireframeMaterial = new THREE.LineBasicMaterial({
            color: WIREFRAME_COLOR,
            transparent: false,
            depthTest: true
          });
          const wireframe = new THREE.LineSegments(wireframeGeometry, wireframeMaterial);
          wireframe.userData['isTriangulationWireframe'] = true;
          wireframe.raycast = () => {}; // visual overlay only — keep it out of selection raycasts
          wireframe.visible = false; // hidden until "Mesh View" is toggled on — default view is the plain shaded assembly
          mesh3d.add(wireframe);

          bodies.push({
            id: bodyId,
            name: `Body ${b.solidIndex + 1}`,
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
          });
          return;
        }

        if (msg.type === 'done') {
          this.progress.set({ phase: 'done', message: `Loaded ${msg.bodyCount} bodies`, indeterminate: false });
          worker.terminate();
          resolve(bodies);
          return;
        }

        if (msg.type === 'error') {
          this.progress.set({ phase: 'error', message: 'Failed to read STEP file', indeterminate: false, error: msg.message });
          worker.terminate();
          reject(new Error(msg.message));
        }
      };

      worker.onerror = (event: ErrorEvent) => {
        this.progress.set({ phase: 'error', message: 'Failed to read STEP file', indeterminate: false, error: event.message });
        worker.terminate();
        reject(new Error(event.message));
      };

      const request: StepWorkerRequest = { type: 'load', url };
      worker.postMessage(request);
    });
  }
}
