import * as THREE from 'three';

/** Angle at `vertex` between the rays to `a` and `c`, in degrees (0–180). Null if either ray has zero length. */
export function angleAtVertexDeg(a: THREE.Vector3, vertex: THREE.Vector3, c: THREE.Vector3): number | null {
  const u = a.clone().sub(vertex);
  const v = c.clone().sub(vertex);
  if (u.lengthSq() < 1e-18 || v.lengthSq() < 1e-18) return null;
  const cos = THREE.MathUtils.clamp(u.normalize().dot(v.normalize()), -1, 1);
  return THREE.MathUtils.radToDeg(Math.acos(cos));
}

export interface PlaneLike {
  origin: THREE.Vector3;
  normal: THREE.Vector3;
}

export interface PlanePairResult {
  /** Acute angle between the two planes, 0–90°. */
  angleDeg: number;
  parallel: boolean;
  /** Perpendicular distance between the planes; only meaningful when `parallel`. */
  distance: number;
}

/** Faces this close to parallel (degrees) are treated as parallel and measured by distance; anything else by angle. */
export const PARALLEL_TOLERANCE_DEG = 0.5;

export function measurePlanes(a: PlaneLike, b: PlaneLike): PlanePairResult {
  const na = a.normal.clone().normalize();
  const nb = b.normal.clone().normalize();
  const cos = THREE.MathUtils.clamp(Math.abs(na.dot(nb)), 0, 1); // |cos| folds opposite-facing normals together
  const angleDeg = THREE.MathUtils.radToDeg(Math.acos(cos));
  const parallel = angleDeg < PARALLEL_TOLERANCE_DEG;
  const distance = Math.abs(b.origin.clone().sub(a.origin).dot(na));
  return { angleDeg, parallel, distance };
}

export interface CircleFit {
  center: THREE.Vector3;
  radius: number;
  /** Unit normal of the circle's plane. */
  normal: THREE.Vector3;
  /** Root-mean-square deviation of the points from the fitted circle, mm. */
  rmsError: number;
}

/**
 * Best-fit circle through 3D points (Kåsa algebraic least squares in the points' best-fit plane).
 * Works for a full circle or an arc. Returns null when the points are collinear, too few, or do not
 * lie on a circle (`maxRelativeError` is the allowed rms deviation as a fraction of the radius) — that
 * is how a straight or freeform edge is rejected instead of reporting a nonsense radius.
 */
export function fitCircle(points: THREE.Vector3[], maxRelativeError = 0.005): CircleFit | null {
  if (points.length < 3) return null;

  const centroid = new THREE.Vector3();
  for (const p of points) centroid.add(p);
  centroid.divideScalar(points.length);

  // Plane normal: the largest-magnitude cross product of vectors from the centroid. Robust for arcs.
  const normal = new THREE.Vector3();
  for (let i = 0; i < points.length; i++) {
    const cross = points[i].clone().sub(centroid).cross(points[(i + 1) % points.length].clone().sub(centroid));
    if (cross.dot(normal) < 0) cross.negate();
    normal.add(cross);
  }
  if (normal.lengthSq() < 1e-18) return null;
  normal.normalize();

  // In-plane basis.
  const helper = Math.abs(normal.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const uAxis = helper.clone().sub(normal.clone().multiplyScalar(helper.dot(normal))).normalize();
  const vAxis = normal.clone().cross(uAxis);
  const local = points.map((p) => {
    const d = p.clone().sub(centroid);
    return [d.dot(uAxis), d.dot(vAxis)] as const;
  });

  // Solve  x² + y² = 2ax + 2by + c  in the least-squares sense (normal equations, 3×3).
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, sxz = 0, syz = 0, sz = 0;
  for (const [x, y] of local) {
    const z = x * x + y * y;
    sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y; sxz += x * z; syz += y * z; sz += z;
  }
  const n = local.length;
  const m = new THREE.Matrix3().set(sxx, sxy, sx, sxy, syy, sy, sx, sy, n);
  const det = m.determinant();
  if (Math.abs(det) < 1e-12) return null;
  const inv = m.clone().invert();
  const rhs = new THREE.Vector3(sxz, syz, sz);
  const sol = rhs.applyMatrix3(inv); // (2a, 2b, c)
  const a = sol.x / 2;
  const b = sol.y / 2;
  const radiusSq = sol.z + a * a + b * b;
  if (!(radiusSq > 1e-12)) return null;
  const radius = Math.sqrt(radiusSq);

  let sumSq = 0;
  for (const [x, y] of local) sumSq += (Math.hypot(x - a, y - b) - radius) ** 2;
  const rmsError = Math.sqrt(sumSq / n);
  if (rmsError > maxRelativeError * radius) return null;

  const center = centroid.clone().add(uAxis.multiplyScalar(a)).add(vAxis.multiplyScalar(b));
  return { center, radius, normal, rmsError };
}
