import * as THREE from 'three';
import { CadBody } from '../models/cad-body.model';
import { FaceReferencePoint } from '../models/sketch.model';

/** Triangle-normal deviation tolerance for treating a face as planar (~2.5°). */
const PLANAR_DOT_TOLERANCE = 0.999;

/** Screen-space-independent tolerance (in model units) for fitting boundary points to a common circle. */
const CIRCLE_FIT_TOLERANCE_RATIO = 0.02;

interface FacePlane {
  origin: THREE.Vector3;
  normal: THREE.Vector3;
}

function triangleIndicesForFace(faceIdMap: Uint32Array, faceIndex: number): number[] {
  const tris: number[] = [];
  for (let t = 0; t < faceIdMap.length; t++) {
    if (faceIdMap[t] === faceIndex) tris.push(t);
  }
  return tris;
}

/**
 * Resolves a picked face's world-space plane (origin + normal) purely from the body's
 * tessellation — no OCCT round-trip, mirroring how SelectionService.pickFace/BridgeMeshService
 * already derive face-scoped geometry client-side via faceIdMap. Returns null if the face
 * isn't planar (Phase 1 only supports sketching on flat faces).
 */
export function getFacePlane(body: CadBody, faceIndex: number): FacePlane | null {
  const { geometry, faceIdMap, mesh } = body;
  const index = geometry.index;
  const positionAttr = geometry.attributes['position'];
  if (!index || !positionAttr) return null;

  const tris = triangleIndicesForFace(faceIdMap, faceIndex);
  if (tris.length === 0) return null;

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const centroid = new THREE.Vector3();
  const normalSum = new THREE.Vector3();
  let areaSum = 0;

  const triNormals: THREE.Vector3[] = [];
  const triAreas: number[] = [];
  const triCentroids: THREE.Vector3[] = [];

  for (const t of tris) {
    const i0 = index.getX(t * 3);
    const i1 = index.getX(t * 3 + 1);
    const i2 = index.getX(t * 3 + 2);
    a.fromBufferAttribute(positionAttr, i0);
    b.fromBufferAttribute(positionAttr, i1);
    c.fromBufferAttribute(positionAttr, i2);

    const edge1 = b.clone().sub(a);
    const edge2 = c.clone().sub(a);
    const cross = edge1.clone().cross(edge2);
    const area = cross.length() * 0.5;
    if (area < 1e-9) continue; // degenerate sliver triangle — skip, don't let it skew the average

    const triNormal = cross.normalize();
    const triCentroid = a.clone().add(b).add(c).multiplyScalar(1 / 3);

    triNormals.push(triNormal);
    triAreas.push(area);
    triCentroids.push(triCentroid);

    normalSum.addScaledVector(triNormal, area);
    centroid.addScaledVector(triCentroid, area);
    areaSum += area;
  }

  if (areaSum < 1e-9) return null;

  const localNormal = normalSum.divideScalar(areaSum).normalize();
  const localOrigin = centroid.divideScalar(areaSum);

  // Planarity check: every triangle's normal must agree with the area-weighted average.
  for (const n of triNormals) {
    if (Math.abs(n.dot(localNormal)) < PLANAR_DOT_TOLERANCE) return null;
  }

  // Transform to world space: point transform for origin, normal-matrix transform for normal.
  mesh.updateMatrixWorld();
  const origin = localOrigin.applyMatrix4(mesh.matrixWorld);
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
  const normal = localNormal.applyMatrix3(normalMatrix).normalize();

  return { origin, normal };
}

/**
 * Deterministic, stable in-plane axis for an arbitrary plane normal: projects world X onto
 * the plane, falling back to world Y when the normal is nearly parallel to X (degenerate
 * cross product near that pole). Mirrors the near-pole guard shape CameraService uses for
 * its up-vector heuristic, applied to a different axis choice.
 */
export function pickUAxis(normal: THREE.Vector3): THREE.Vector3 {
  const worldX = new THREE.Vector3(1, 0, 0);
  const reference = Math.abs(normal.dot(worldX)) > 0.9 ? new THREE.Vector3(0, 1, 0) : worldX;
  return reference.clone().sub(normal.clone().multiplyScalar(reference.dot(normal))).normalize();
}

interface BoundaryEdge {
  a: THREE.Vector3;
  b: THREE.Vector3;
}

/** Builds the ordered boundary-edge list for one face: an edge appearing in exactly one triangle of that face's triangle subset is a boundary edge, chained by shared endpoints. */
function boundaryEdges(body: CadBody, faceIndex: number): BoundaryEdge[] {
  const { geometry, faceIdMap } = body;
  const index = geometry.index;
  const positionAttr = geometry.attributes['position'];
  if (!index || !positionAttr) return [];

  const edgeCount = new Map<string, number>();
  const edgeDir = new Map<string, [number, number]>();

  const numTris = index.count / 3;
  for (let t = 0; t < numTris; t++) {
    if (faceIdMap[t] !== faceIndex) continue;
    const ia = index.getX(t * 3);
    const ib = index.getX(t * 3 + 1);
    const ic = index.getX(t * 3 + 2);
    for (const [u, v] of [
      [ia, ib],
      [ib, ic],
      [ic, ia]
    ] as [number, number][]) {
      const key = u < v ? `${u}_${v}` : `${v}_${u}`;
      edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
      if (!edgeDir.has(key)) edgeDir.set(key, [u, v]);
    }
  }

  const nextMap = new Map<number, number>();
  for (const [key, count] of edgeCount) {
    if (count === 1) {
      const [u, v] = edgeDir.get(key)!;
      nextMap.set(u, v);
    }
  }

  const point = (i: number): THREE.Vector3 => new THREE.Vector3().fromBufferAttribute(positionAttr, i);

  const visited = new Set<number>();
  const edges: BoundaryEdge[] = [];
  for (const start of nextMap.keys()) {
    if (visited.has(start)) continue;
    let current = start;
    let guard = 0;
    while (!visited.has(current) && guard < nextMap.size + 1) {
      visited.add(current);
      const next = nextMap.get(current);
      guard++;
      if (next === undefined) break;
      edges.push({ a: point(current), b: point(next) });
      current = next;
      if (current === start) break;
    }
  }
  return edges;
}

/** Fits a circumcircle to 3 points; returns null if they're (nearly) collinear. */
function circumcircle(p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3, normal: THREE.Vector3): { center: THREE.Vector3; radius: number } | null {
  // Work in the face's local 2D basis to avoid a degenerate 3D circumcenter solve.
  const u = pickUAxis(normal);
  const v = normal.clone().cross(u).normalize();
  const to2d = (p: THREE.Vector3): [number, number] => [p.dot(u), p.dot(v)];

  const [ax, ay] = to2d(p1);
  const [bx, by] = to2d(p2);
  const [cx, cy] = to2d(p3);

  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) return null; // collinear

  const ux =
    ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy =
    ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;

  // `to2d` dotted absolute positions (not positions relative to a plane origin) against unit
  // axes u/v, so re-composing with the same axes yields back a valid world-space point.
  const center = new THREE.Vector3().addScaledVector(u, ux).addScaledVector(v, uy);
  const radius = center.distanceTo(p1);
  return { center, radius };
}

/**
 * Extracts sketch reference points from a picked face's boundary: vertex/midpoint pairs for
 * straight edges, one center point per fitted circular-edge run, plus non-adjacent straight-
 * segment intersections within the face. Tessellation-based (edges are already polygonal
 * after triangulation) — circular edges are detected via circumcircle-fit tolerance, not
 * read back from OCCT, consistent with the client-side-only approach used throughout.
 */
export function extractFaceReferencePoints(body: CadBody, faceIndex: number, plane: FacePlane): FaceReferencePoint[] {
  // `boundaryEdges` reads the raw (local-frame) geometry, but `plane` is world-space (see
  // `getFacePlane`) and snapping happens against world-space clicks: bring the edges into world
  // space too, or a moved/rotated body gets snap points where it used to be.
  body.mesh.updateWorldMatrix(true, false);
  const edges = boundaryEdges(body, faceIndex).map((e) => ({
    a: e.a.clone().applyMatrix4(body.mesh.matrixWorld),
    b: e.b.clone().applyMatrix4(body.mesh.matrixWorld)
  }));
  if (edges.length === 0) return [];

  const bbox = new THREE.Box3();
  for (const e of edges) {
    bbox.expandByPoint(e.a);
    bbox.expandByPoint(e.b);
  }
  const scale = Math.max(bbox.getSize(new THREE.Vector3()).length(), 1);
  const circleFitTolerance = scale * CIRCLE_FIT_TOLERANCE_RATIO;

  const points: FaceReferencePoint[] = [];
  const push = (kind: FaceReferencePoint['kind'], p: THREE.Vector3): void => {
    points.push({ kind, position: [p.x, p.y, p.z] });
  };

  // Classify maximal runs of consecutive boundary edges that fit one common circle.
  let i = 0;
  const straightSegments: BoundaryEdge[] = [];
  while (i < edges.length) {
    const runStart = i;
    if (i + 2 < edges.length) {
      const fit = circumcircle(edges[i].a, edges[i + 1].a, edges[i + 2].a, plane.normal);
      if (fit) {
        let j = i;
        while (j < edges.length && edges[j].a.distanceTo(fit.center) - fit.radius < circleFitTolerance) {
          j++;
        }
        const runLength = j - runStart;
        if (runLength >= 3) {
          push('circle-center', fit.center);
          i = j;
          continue;
        }
      }
    }
    straightSegments.push(edges[i]);
    i++;
  }

  for (const seg of straightSegments) {
    push('vertex', seg.a);
    push('vertex', seg.b);
    push('midpoint', seg.a.clone().add(seg.b).multiplyScalar(0.5));
  }

  // Non-adjacent straight-segment intersections, projected into the face's (u,v) plane.
  const u = pickUAxis(plane.normal);
  const v = plane.normal.clone().cross(u).normalize();
  const to2d = (p: THREE.Vector3): [number, number] => [p.clone().sub(plane.origin).dot(u), p.clone().sub(plane.origin).dot(v)];

  for (let s1 = 0; s1 < straightSegments.length; s1++) {
    for (let s2 = s1 + 1; s2 < straightSegments.length; s2++) {
      const seg1 = straightSegments[s1];
      const seg2 = straightSegments[s2];
      const hit = segmentIntersection2d(to2d(seg1.a), to2d(seg1.b), to2d(seg2.a), to2d(seg2.b));
      if (!hit) continue;
      const [hu, hv] = hit;
      const worldHit = plane.origin.clone().addScaledVector(u, hu).addScaledVector(v, hv);
      push('intersection', worldHit);
    }
  }

  return points;
}

/** 2D segment-segment intersection (excludes shared endpoints — those are already vertex references). */
function segmentIntersection2d(
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  p4: [number, number]
): [number, number] | null {
  const [x1, y1] = p1;
  const [x2, y2] = p2;
  const [x3, y3] = p3;
  const [x4, y4] = p4;

  const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denom) < 1e-9) return null;

  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
  const s = ((x1 - x3) * (y1 - y2) - (y1 - y3) * (x1 - x2)) / denom;

  const EPS = 1e-4;
  if (t < EPS || t > 1 - EPS || s < EPS || s > 1 - EPS) return null; // outside segment bounds or at a shared endpoint

  return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
}
