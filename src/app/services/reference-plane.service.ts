import { Injectable, signal } from '@angular/core';
import * as THREE from 'three';
import { TreeService } from './tree.service';
import { generateId } from '../utils/id-generator.util';
import { getFacePlane, pickUAxis } from '../utils/face-geometry.util';
import { CadBody } from '../models/cad-body.model';
import { IDLE_REFERENCE_PLANE_TOOL, ReferencePlane, ReferencePlaneBase, ReferencePlaneToolState } from '../models/reference-plane.model';

/** Same convention SketchService's own (private) DATUM_NORMALS/DATUM_ORIGINS use — duplicated locally rather than imported, matching the precedent MirrorToolService/PatternToolService already established for not reaching into another tool's private constants. */
const DATUM_NORMALS: Record<'XY' | 'YZ' | 'XZ', THREE.Vector3> = {
  XY: new THREE.Vector3(0, 0, 1),
  YZ: new THREE.Vector3(1, 0, 0),
  XZ: new THREE.Vector3(0, 1, 0)
};
const DATUM_ORIGINS: Record<'XY' | 'YZ' | 'XZ', THREE.Vector3> = {
  XY: new THREE.Vector3(0, 0, 0),
  YZ: new THREE.Vector3(0, 0, 0),
  XZ: new THREE.Vector3(0, 0, 0)
};

export interface ResolvedPlaneFrame {
  origin: THREE.Vector3;
  normal: THREE.Vector3;
  uAxis: THREE.Vector3;
  vAxis: THREE.Vector3;
}

/**
 * User-defined offset reference planes: pick a base (a fixed datum plane or a face on an existing
 * part), type an offset distance along its normal, name it, and it becomes available as a Sketch
 * target alongside the datum planes and direct face-picking. Offset-only in v1 (no rotation/tilt,
 * no 3-point definition) — see architecture.md's 2026-09-10 planning note for the scoping
 * decision; those remain open follow-ons.
 *
 * Storage is deliberately NOT TreeService — a reference plane has no solid geometry to select/
 * measure/export the way a CadBody does, the same reasoning SectionService's own per-axis
 * clipping-plane config already established for "plane state that isn't a tree body." A dedicated
 * service with its own signal-based list is the established shape for that (SectionService is the
 * closest existing precedent, not TreeService).
 *
 * Zero OCCT/worker changes needed: `resolveFrame` below produces exactly the {origin, normal,
 * uAxis, vAxis} shape SketchService's own face-pick phase already produces, which the worker
 * already accepts as an arbitrary PlaneRef of kind 'face' (workers/step-worker-messages.model.ts)
 * — the worker has no opinion about where that origin/normal came from.
 */
@Injectable({ providedIn: 'root' })
export class ReferencePlaneService {
  readonly planes = signal<ReferencePlane[]>([]);
  readonly toolState = signal<ReferencePlaneToolState>(IDLE_REFERENCE_PLANE_TOOL);
  readonly lastError = signal<string | null>(null);

  constructor(private readonly tree: TreeService) {}

  // --- Creation tool ---

  activate(): void {
    this.toolState.set(IDLE_REFERENCE_PLANE_TOOL);
    this.lastError.set(null);
  }

  pickDatumBase(plane: 'XY' | 'YZ' | 'XZ'): void {
    this.toolState.update((st) => ({ ...st, base: { kind: 'datum', plane } }));
  }

  pickFaceBase(body: CadBody, faceIndex: number): void {
    const plane = getFacePlane(body, faceIndex);
    if (!plane) {
      this.lastError.set('Selected face is not planar — pick a flat face as the base.');
      return;
    }
    this.lastError.set(null);
    this.toolState.update((st) => ({ ...st, base: { kind: 'face', bodyId: body.id, faceIndex } }));
  }

  setOffset(offset: number): void {
    if (!Number.isFinite(offset)) return;
    this.toolState.update((st) => ({ ...st, offset }));
  }

  setName(name: string): void {
    this.toolState.update((st) => ({ ...st, name }));
  }

  canCommit(): boolean {
    return this.toolState().base !== null;
  }

  /** Resolves a base + offset into the plane's world-space frame — shared by both the live creation preview and every later sketch/render consumer, so the two can never disagree. */
  resolveFrame(base: ReferencePlaneBase, offset: number): ResolvedPlaneFrame | null {
    let origin: THREE.Vector3;
    let normal: THREE.Vector3;

    if (base.kind === 'datum') {
      origin = DATUM_ORIGINS[base.plane].clone();
      normal = DATUM_NORMALS[base.plane].clone();
    } else {
      const body = this.tree.allBodies().find((b) => b.id === base.bodyId);
      if (!body) return null;
      const facePlane = getFacePlane(body, base.faceIndex);
      if (!facePlane) return null;
      origin = facePlane.origin;
      normal = facePlane.normal;
    }

    const offsetOrigin = origin.clone().addScaledVector(normal, offset);
    const uAxis = pickUAxis(normal);
    const vAxis = normal.clone().cross(uAxis).normalize();
    return { origin: offsetOrigin, normal, uAxis, vAxis };
  }

  /** Live frame for whatever base/offset is currently configured in the creation tool — null until a base is picked, used for the in-progress preview overlay. */
  previewFrame(): ResolvedPlaneFrame | null {
    const st = this.toolState();
    if (!st.base) return null;
    return this.resolveFrame(st.base, st.offset);
  }

  commit(): ReferencePlane {
    const st = this.toolState();
    if (!st.base) throw new Error('Pick a base plane or face first.');

    const plane: ReferencePlane = {
      id: generateId('refplane'),
      name: st.name.trim() || `Plane ${this.planes().length + 1}`,
      base: st.base,
      offset: st.offset,
      visible: true
    };
    this.planes.update((list) => [...list, plane]);
    this.toolState.set(IDLE_REFERENCE_PLANE_TOOL);
    return plane;
  }

  cancel(): void {
    this.toolState.set(IDLE_REFERENCE_PLANE_TOOL);
    this.lastError.set(null);
  }

  // --- Stored planes ---

  rename(id: string, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    this.planes.update((list) => list.map((p) => (p.id === id ? { ...p, name: trimmed } : p)));
  }

  toggleVisible(id: string): void {
    this.planes.update((list) => list.map((p) => (p.id === id ? { ...p, visible: !p.visible } : p)));
  }

  delete(id: string): void {
    this.planes.update((list) => list.filter((p) => p.id !== id));
  }

  resolve(id: string): ResolvedPlaneFrame | null {
    const plane = this.planes().find((p) => p.id === id);
    if (!plane) return null;
    return this.resolveFrame(plane.base, plane.offset);
  }
}
