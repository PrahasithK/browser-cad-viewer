import { Injectable, signal } from '@angular/core';
import * as THREE from 'three';
import { ViewerService } from './viewer.service';
import { TreeService } from './tree.service';
import { SelectionState } from '../models/selection-state.model';
import { CadBody } from '../models/cad-body.model';

@Injectable({ providedIn: 'root' })
export class SelectionService {
  readonly state = signal<SelectionState>({
    selectedNodeId: null,
    selectedBodyId: null,
    hoveredBodyId: null,
    selectedBodyIds: []
  });

  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  /** One highlight (box + gizmo) per currently-selected mesh, keyed by bodyId — plural now that multi-select exists; single-select is just this map holding one entry. */
  private readonly boxHelpers = new Map<string, THREE.Box3Helper>();
  private readonly gizmos = new Map<string, THREE.Group>();
  private readonly originalEmissive = new Map<string, THREE.Color>();

  constructor(
    private readonly viewer: ViewerService,
    private readonly tree: TreeService
  ) {}

  pickAtClient(clientX: number, clientY: number, canvas: HTMLCanvasElement, camera: THREE.Camera): THREE.Mesh | null {
    const rect = canvas.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.pointer, camera);
    const intersects = this.raycaster.intersectObjects(this.viewer.getBodyGroup().children, true);
    for (const hit of intersects) {
      if (hit.object instanceof THREE.Mesh && hit.object.visible) {
        return hit.object;
      }
    }
    return null;
  }

  /**
   * Edge-level pick for Fillet/Chamfer: first raycasts normally to find which body is under the
   * cursor (so edge-picking only searches that one body's edges, not the whole scene), then finds
   * the nearest of that body's `edges` polylines to the click in screen space — the same
   * screen-space-pixel-threshold technique `Viewport.resolveSnap` already uses for sketch
   * reference-point snapping, just measuring point-to-segment distance instead of point-to-point.
   * No raycast-against-3D-line-geometry approach exists in three.js with a usable pick tolerance,
   * so this mirrors the sketch tool's own established snap pattern rather than introducing a new
   * picking primitive.
   */
  pickEdge(clientX: number, clientY: number, canvas: HTMLCanvasElement, camera: THREE.Camera): { body: CadBody; edgeIndex: number } | null {
    const hit = this.pickAtClient(clientX, clientY, canvas, camera);
    if (!hit) return null;
    const bodyId = hit.userData['bodyId'] as string | undefined;
    if (!bodyId) return null;
    const body = this.tree.allBodies().find((b) => b.id === bodyId);
    if (!body || body.edges.length === 0) return null;

    const rect = canvas.getBoundingClientRect();
    const cursorPx = new THREE.Vector2(clientX - rect.left, clientY - rect.top);
    const toScreenPx = (local: THREE.Vector3): THREE.Vector2 => {
      const world = local.clone().applyMatrix4(body.mesh.matrixWorld);
      const ndc = world.project(camera);
      return new THREE.Vector2(((ndc.x + 1) / 2) * rect.width, ((1 - ndc.y) / 2) * rect.height);
    };

    const EDGE_PICK_PIXEL_THRESHOLD = 8;
    let bestEdgeIndex = -1;
    let bestDist = EDGE_PICK_PIXEL_THRESHOLD;

    for (const edge of body.edges) {
      for (let i = 0; i < edge.points.length - 1; i++) {
        const a = toScreenPx(edge.points[i]);
        const b = toScreenPx(edge.points[i + 1]);
        const dist = distanceToSegment(cursorPx, a, b);
        if (dist < bestDist) {
          bestDist = dist;
          bestEdgeIndex = edge.index;
        }
      }
    }

    return bestEdgeIndex >= 0 ? { body, edgeIndex: bestEdgeIndex } : null;
  }

  /**
   * Face-level pick, additive to the existing whole-mesh `pickAtClient` (untouched). THREE's
   * Raycaster already returns `intersection.faceIndex` (the triangle index) for any mesh hit —
   * mapping it through the body's `faceIdMap` (set on `mesh.userData` alongside `bodyId`) gives
   * the originating OCCT face index with no extra picking math needed.
   */
  pickFace(clientX: number, clientY: number, canvas: HTMLCanvasElement, camera: THREE.Camera): { body: CadBody; faceIndex: number } | null {
    const rect = canvas.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.pointer, camera);
    const intersects = this.raycaster.intersectObjects(this.viewer.getBodyGroup().children, true);
    for (const hit of intersects) {
      if (!(hit.object instanceof THREE.Mesh) || !hit.object.visible || hit.faceIndex == null) continue;
      const faceIdMap = hit.object.userData['faceIdMap'] as Uint32Array | undefined;
      const bodyId = hit.object.userData['bodyId'] as string | undefined;
      if (!faceIdMap || !bodyId) continue;
      const body = this.tree.allBodies().find((b) => b.id === bodyId);
      if (!body) continue;
      return { body, faceIndex: faceIdMap[hit.faceIndex] };
    }
    return null;
  }

  /** Single-select: replaces the whole selection with just this mesh (or clears if null). Unchanged behavior/signature — every pre-existing call site keeps working as before. */
  selectMesh(mesh: THREE.Mesh | null): void {
    this.clearHighlight();

    if (!mesh) {
      this.state.set({ selectedNodeId: null, selectedBodyId: null, hoveredBodyId: null, selectedBodyIds: [] });
      return;
    }

    const nodeId = this.tree.getNodeIdForMesh(mesh) ?? null;
    const bodyId = mesh.userData['bodyId'] ?? null;

    this.highlightMesh(mesh);
    this.state.set({ selectedNodeId: nodeId, selectedBodyId: bodyId, hoveredBodyId: null, selectedBodyIds: bodyId ? [bodyId] : [] });
  }

  selectByNodeId(nodeId: string | null): void {
    if (!nodeId) {
      this.selectMesh(null);
      return;
    }
    const body = this.tree.getBodyForNodeId(nodeId);
    this.selectMesh(body?.mesh ?? null);
  }

  clearSelection(): void {
    this.selectMesh(null);
  }

  /**
   * Ctrl/Shift-click entry point: `additive=false` behaves exactly like `selectMesh` (replace).
   * `additive=true` toggles this mesh in/out of the existing multi-select set. The "primary"
   * fields (`selectedNodeId`/`selectedBodyId`) track the most-recently-toggled-in mesh so every
   * existing single-select-reading call site (properties panel, dimension labels, etc.) still
   * gets a sensible single body even during a multi-select session.
   */
  toggleMesh(mesh: THREE.Mesh | null, additive: boolean): void {
    if (!additive) {
      this.selectMesh(mesh);
      return;
    }
    // Ctrl/Shift-click on empty space (mesh === null) is a no-op, not a clear — matches SolidWorks/
    // Fusion: an additive-select miss leaves the existing multi-select set untouched. Only a plain
    // (non-additive) miss clears, handled by the branch above.
    if (!mesh) return;

    const bodyId = mesh.userData['bodyId'] as string | undefined;
    if (!bodyId) return;

    const current = this.state();
    const alreadySelected = current.selectedBodyIds.includes(bodyId);
    const nextIds = alreadySelected ? current.selectedBodyIds.filter((id) => id !== bodyId) : [...current.selectedBodyIds, bodyId];

    this.applySelection(nextIds, alreadySelected ? (nextIds.at(-1) ?? null) : bodyId);
  }

  /** Selects every body currently in the tree (Ctrl+A). */
  selectAll(): void {
    const bodyIds = this.tree.allBodies().map((b) => b.id);
    this.applySelection(bodyIds, bodyIds.at(-1) ?? null);
  }

  /** Rebuilds highlight + state signal from a target bodyId set, given the new "primary" id. Shared by toggleMesh/selectAll so highlight bookkeeping lives in one place. */
  private applySelection(bodyIds: string[], primaryBodyId: string | null): void {
    this.clearHighlight();

    if (bodyIds.length === 0) {
      this.state.set({ selectedNodeId: null, selectedBodyId: null, hoveredBodyId: null, selectedBodyIds: [] });
      return;
    }

    const bodies = this.tree.allBodies();
    for (const id of bodyIds) {
      const body = bodies.find((b) => b.id === id);
      if (body) this.highlightMesh(body.mesh);
    }

    const primaryBody = primaryBodyId ? bodies.find((b) => b.id === primaryBodyId) : undefined;
    const primaryNodeId = primaryBody ? (this.tree.getNodeIdForMesh(primaryBody.mesh) ?? null) : null;

    this.state.set({
      selectedNodeId: primaryNodeId,
      selectedBodyId: primaryBodyId,
      hoveredBodyId: null,
      selectedBodyIds: bodyIds
    });
  }

  /**
   * Repositions an already-highlighted body's box helper + axis gizmo to its mesh's current
   * transform, without touching emissive/selection state — for ObjectTransformService's
   * per-tick drag callback, where a full selectMesh/applySelection rebuild would be needlessly
   * heavy (and would wrongly collapse an active multi-select back to single-select). No-op if
   * the body isn't currently highlighted.
   */
  refreshHighlightTransform(bodyId: string): void {
    const boxHelper = this.boxHelpers.get(bodyId);
    const gizmo = this.gizmos.get(bodyId);
    if (!boxHelper || !gizmo) return;

    const body = this.tree.allBodies().find((b) => b.id === bodyId);
    if (!body) return;

    const box = new THREE.Box3().setFromObject(body.mesh);
    boxHelper.box.copy(box);

    this.viewer.scene.remove(gizmo);
    const freshGizmo = this.buildGizmo(box);
    this.viewer.scene.add(freshGizmo);
    this.gizmos.set(bodyId, freshGizmo);
  }

  private highlightMesh(mesh: THREE.Mesh): void {
    const bodyId = mesh.userData['bodyId'] as string | undefined;
    if (!bodyId) return;

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of materials) {
      if (mat instanceof THREE.MeshStandardMaterial) {
        this.originalEmissive.set(mesh.uuid + mat.uuid, mat.emissive.clone());
        mat.emissive.setHex(0x2a6fdb);
        mat.emissiveIntensity = 0.55;
      }
    }

    mesh.geometry.computeBoundingBox();
    const box = new THREE.Box3().setFromObject(mesh);
    const boxHelper = new THREE.Box3Helper(box, new THREE.Color(0xffa500));
    this.viewer.scene.add(boxHelper);
    this.boxHelpers.set(bodyId, boxHelper);

    const gizmo = this.buildGizmo(box);
    this.viewer.scene.add(gizmo);
    this.gizmos.set(bodyId, gizmo);
  }

  private buildGizmo(box: THREE.Box3): THREE.Group {
    const group = new THREE.Group();
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const length = Math.max(size.x, size.y, size.z, 1) * 0.35;

    const axes: [THREE.Vector3, number][] = [
      [new THREE.Vector3(1, 0, 0), 0xff4444],
      [new THREE.Vector3(0, 1, 0), 0x44ff44],
      [new THREE.Vector3(0, 0, 1), 0x4488ff]
    ];

    for (const [dir, color] of axes) {
      const arrow = new THREE.ArrowHelper(dir, center, length, color, length * 0.2, length * 0.12);
      group.add(arrow);
    }
    return group;
  }

  private clearHighlight(): void {
    this.originalEmissive.clear();

    const bodyGroup = this.viewer.getBodyGroup();
    bodyGroup.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const mat of materials) {
          if (mat instanceof THREE.MeshStandardMaterial) {
            mat.emissive.setHex(0x000000);
            mat.emissiveIntensity = 1;
          }
        }
      }
    });

    for (const boxHelper of this.boxHelpers.values()) {
      this.viewer.scene.remove(boxHelper);
      boxHelper.dispose();
    }
    this.boxHelpers.clear();

    for (const gizmo of this.gizmos.values()) {
      this.viewer.scene.remove(gizmo);
    }
    this.gizmos.clear();
  }
}

/** Shortest distance from point `p` to the segment `a`-`b`, all in the same 2D screen-pixel space — standard clamped-projection formula. */
function distanceToSegment(p: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2): number {
  const ab = b.clone().sub(a);
  const lengthSq = ab.lengthSq();
  if (lengthSq < 1e-9) return p.distanceTo(a);
  const t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / lengthSq));
  const closest = a.clone().addScaledVector(ab, t);
  return p.distanceTo(closest);
}
