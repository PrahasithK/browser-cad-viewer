type Vec3 = [number, number, number];

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function length(a: Vec3): number {
  return Math.sqrt(dot(a, a));
}
function normalize(a: Vec3): Vec3 {
  const l = length(a);
  return l < 1e-12 ? [0, 0, 0] : scale(a, 1 / l);
}
function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
function centroid(points: Vec3[]): Vec3 {
  let c: Vec3 = [0, 0, 0];
  for (const p of points) c = add(c, p);
  return scale(c, 1 / points.length);
}

const RESAMPLE_COLUMNS = 24;

function resampleLoopArcLength(loopPoints: Vec3[], n: number): Vec3[] {
  const count = loopPoints.length;
  const segLens: number[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    const d = length(sub(loopPoints[(i + 1) % count], loopPoints[i]));
    segLens.push(d);
    total += d;
  }

  const result: Vec3[] = [];
  for (let k = 0; k < n; k++) {
    const targetDist = (k / n) * total;
    let acc = 0;
    let i = 0;
    while (i < count && acc + segLens[i] < targetDist) {
      acc += segLens[i];
      i++;
    }
    if (i >= count) i = count - 1;
    const remain = targetDist - acc;
    const t = segLens[i] > 1e-12 ? remain / segLens[i] : 0;
    result.push(lerp(loopPoints[i], loopPoints[(i + 1) % count], t));
  }
  return result;
}

/** Signed winding sense of a closed loop about `axis` — used to detect and correct a twisted bridge. */
function windingSign(points: Vec3[], axis: Vec3): number {
  let sum: Vec3 = [0, 0, 0];
  const n = points.length;
  for (let i = 0; i < n; i++) {
    sum = add(sum, cross(points[i], points[(i + 1) % n]));
  }
  return Math.sign(dot(sum, axis));
}

export interface BridgeMeshResult {
  positions: Float32Array;
  indices: Uint32Array;
  crossingWarnings: number;
}

/**
 * Builds a ruled (linearly interpolated) mesh bridging two boundary loops. Both loops are
 * resampled to a common column count, loop B's winding is corrected to match loop A's (relative
 * to the axis between their centroids) if needed — this is what prevents a twisted bridge, not a
 * distance heuristic alone — then the starting correspondence offset minimizing total connector
 * length is found by brute force (cheap at RESAMPLE_COLUMNS=24). `density` is the number of rows
 * of quads between the two loops.
 */
export function buildBridgeMesh(loopARaw: Vec3[], loopBRaw: Vec3[], density: number): BridgeMeshResult {
  const n = RESAMPLE_COLUMNS;
  const loopA = resampleLoopArcLength(loopARaw, n);
  let loopB = resampleLoopArcLength(loopBRaw, n);

  const axis = normalize(sub(centroid(loopB), centroid(loopA)));
  const signA = windingSign(loopA, axis);
  const signB = windingSign(loopB, axis);
  if (signA !== 0 && signB !== 0 && signA !== signB) {
    loopB = loopB.slice().reverse();
  }

  let bestK = 0;
  let bestCost = Infinity;
  for (let k = 0; k < n; k++) {
    let cost = 0;
    for (let i = 0; i < n; i++) {
      const d = sub(loopA[i], loopB[(i + k) % n]);
      cost += dot(d, d);
    }
    if (cost < bestCost) {
      bestCost = cost;
      bestK = k;
    }
  }

  const alignedB: Vec3[] = [];
  for (let i = 0; i < n; i++) alignedB.push(loopB[(i + bestK) % n]);

  let crossingWarnings = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dir1 = normalize(sub(alignedB[i], loopA[i]));
    const dir2 = normalize(sub(alignedB[j], loopA[j]));
    if (dot(dir1, dir2) < -0.5) crossingWarnings++;
  }
  if (crossingWarnings > 0) {
    // eslint-disable-next-line no-console
    console.warn(`[bridge-mesh] ${crossingWarnings} adjacent connector(s) look suspicious (possible twist)`);
  }

  const rows = Math.max(1, density);
  const positions: number[] = [];
  for (let j = 0; j <= rows; j++) {
    const t = j / rows;
    for (let i = 0; i < n; i++) {
      const p = lerp(loopA[i], alignedB[i], t);
      positions.push(p[0], p[1], p[2]);
    }
  }

  const indicesOut: number[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < n; i++) {
      const iNext = (i + 1) % n;
      const a0 = j * n + i;
      const a1 = j * n + iNext;
      const b0 = (j + 1) * n + i;
      const b1 = (j + 1) * n + iNext;
      indicesOut.push(a0, b0, a1);
      indicesOut.push(a1, b0, b1);
    }
  }

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indicesOut),
    crossingWarnings
  };
}
