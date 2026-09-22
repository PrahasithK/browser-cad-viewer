import { Injectable, effect } from '@angular/core';
import * as THREE from 'three';
import { ViewerService } from './viewer.service';
import { ReferencePlaneService, ResolvedPlaneFrame } from './reference-plane.service';
import { disposeObject3D } from '../utils/disposal.util';
import { ReferencePlane } from '../models/reference-plane.model';

const PLANE_SIZE = 200; // mm half-extent of the drawn quad — large enough to read as a plane, small enough not to dominate the scene
const PLANE_COLOR = 0x22aaff;
const PREVIEW_COLOR = 0xffee00; // matches SketchRendererService's own snap-indicator yellow, for the same "in-progress, not yet committed" visual meaning

/**
 * Owns the "ReferencePlaneOverlay" scene group: one translucent quad + border per stored,
 * visible ReferencePlane, plus a live preview quad while the creation tool is active. Mirrors
 * SketchRendererService/BridgeMeshRendererService's group-ownership shape exactly — a dedicated
 * service since nothing else draws this domain into the scene and it needs to react to the
 * stored-planes list changing independently of any other rendering concern.
 */
@Injectable({ providedIn: 'root' })
export class ReferencePlaneRendererService {
  private readonly group = new THREE.Group();
  private initialized = false;
  private readonly planeMeshes = new Map<string, THREE.Object3D>();
  private previewMesh: THREE.Object3D | null = null;

  constructor(
    private readonly viewer: ViewerService,
    private readonly referencePlanes: ReferencePlaneService
  ) {
    // Rebuilds whenever the stored plane list (or any plane's visibility) changes — cheap enough
    // (a handful of planes at most) to fully rebuild rather than diff, same simplicity tradeoff
    // SketchRendererService's own per-move rebuilds already make for a much hotter path.
    effect(() => {
      const planes = this.referencePlanes.planes();
      this.syncStoredPlanes(planes);
    });
  }

  private ensureInScene(): void {
    if (!this.initialized) {
      this.group.name = 'ReferencePlaneOverlay';
      this.viewer.scene.add(this.group);
      this.initialized = true;
    }
  }

  private syncStoredPlanes(planes: ReferencePlane[]): void {
    this.ensureInScene();

    const keep = new Set(planes.map((p) => p.id));
    for (const [id, mesh] of this.planeMeshes) {
      if (!keep.has(id)) {
        this.group.remove(mesh);
        disposeObject3D(mesh);
        this.planeMeshes.delete(id);
      }
    }

    for (const plane of planes) {
      const existing = this.planeMeshes.get(plane.id);
      if (existing) {
        this.group.remove(existing);
        disposeObject3D(existing);
        this.planeMeshes.delete(plane.id);
      }
      if (!plane.visible) continue;

      const frame = this.referencePlanes.resolve(plane.id);
      if (!frame) continue;

      const obj = this.buildPlaneVisual(frame, PLANE_COLOR, 0.18);
      this.planeMeshes.set(plane.id, obj);
      this.group.add(obj);
    }
  }

  /** Live preview while the creation tool is active — called every time the base/offset changes, same "cheap enough to fully rebuild" tradeoff as the stored-plane sync above. */
  showPreview(frame: ResolvedPlaneFrame | null): void {
    this.ensureInScene();
    this.clearPreview();
    if (!frame) return;
    this.previewMesh = this.buildPlaneVisual(frame, PREVIEW_COLOR, 0.28);
    this.group.add(this.previewMesh);
  }

  private clearPreview(): void {
    if (this.previewMesh) {
      this.group.remove(this.previewMesh);
      disposeObject3D(this.previewMesh);
      this.previewMesh = null;
    }
  }

  private buildPlaneVisual(frame: ResolvedPlaneFrame, color: number, opacity: number): THREE.Object3D {
    const group = new THREE.Group();

    const geometry = new THREE.PlaneGeometry(PLANE_SIZE * 2, PLANE_SIZE * 2);
    const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false });
    const quad = new THREE.Mesh(geometry, material);

    // PlaneGeometry is built in the XY plane facing +Z by default — orient it via the frame's own
    // basis (uAxis, vAxis, normal) rather than a lookAt, so the plane's drawn edges align with the
    // uAxis/vAxis a sketch on it would actually use.
    const basis = new THREE.Matrix4().makeBasis(frame.uAxis, frame.vAxis, frame.normal);
    quad.quaternion.setFromRotationMatrix(basis);
    quad.position.copy(frame.origin);
    group.add(quad);

    const edges = new THREE.EdgesGeometry(geometry);
    const border = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color, depthTest: false }));
    border.quaternion.copy(quad.quaternion);
    border.position.copy(frame.origin);
    group.add(border);

    return group;
  }

  clear(): void {
    for (const [, mesh] of this.planeMeshes) {
      this.group.remove(mesh);
      disposeObject3D(mesh);
    }
    this.planeMeshes.clear();
    this.clearPreview();
  }
}
