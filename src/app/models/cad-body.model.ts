import * as THREE from 'three';

/** One OCCT edge's world-space sample polyline, plus its index in the same edge-explorer order the worker's fillet/chamfer request expects — see `WorkerEdge`. */
export interface CadBodyEdge {
  index: number;
  points: THREE.Vector3[];
}

export interface CadBody {
  id: string;
  name: string;
  solidIndex: number;
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  visible: boolean;
  color: string;
  opacity: number;
  /** Assigned engineering material (id into `MATERIAL_LIBRARY`); unset means no density is known, so no mass is reported. Not a render property — see `MaterialProperties` for appearance. */
  materialId?: string;
  /** World-space bounding box (kept in world space by gizmo drags and `TreeService.replaceBody`); geometry/edges/faceIdMap below are in the body's local frame. */
  boundingBox: THREE.Box3;
  volume: number | null;
  surfaceArea: number | null;
  faceCount: number;
  edgeCount: number;
  /** One OCCT face index per triangle (length === geometry.index.count / 3), for face-level picking. */
  faceIdMap: Uint32Array;
  /** Per-edge sample polylines, in local (pre-`mesh.matrixWorld`) space, for edge-level picking (Fillet/Chamfer). */
  edges: CadBodyEdge[];
}
