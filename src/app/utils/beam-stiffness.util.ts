import { zerosMatrix } from './linear-solve.util';

export interface LocalAxes {
  ex: [number, number, number];
  ey: [number, number, number];
  ez: [number, number, number];
  length: number;
}

function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(a: [number, number, number]): [number, number, number] {
  const n = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
  return [a[0] / n, a[1] / n, a[2] / n];
}

/**
 * Local x runs from node1 to node2. Local y/z are derived from a reference "up" vector (global Z,
 * this app's vertical axis) unless the member itself is vertical, in which case global X is used
 * as the reference instead — without this special case, a vertical member's local axes would be
 * undefined (the reference vector would be parallel to the member axis).
 */
export function computeLocalAxes(
  node1: [number, number, number],
  node2: [number, number, number],
  betaAngle = 0
): LocalAxes {
  const dx = node2[0] - node1[0];
  const dy = node2[1] - node1[1];
  const dz = node2[2] - node1[2];
  const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const ex: [number, number, number] = [dx / length, dy / length, dz / length];

  const isVertical = Math.abs(ex[0]) < 1e-9 && Math.abs(ex[1]) < 1e-9;
  const ref: [number, number, number] = isVertical ? [1, 0, 0] : [0, 0, 1];

  let ey = normalize(cross(ref, ex));
  let ez = normalize(cross(ex, ey));

  if (betaAngle !== 0) {
    const c = Math.cos(betaAngle);
    const s = Math.sin(betaAngle);
    const eyRot: [number, number, number] = [ey[0] * c + ez[0] * s, ey[1] * c + ez[1] * s, ey[2] * c + ez[2] * s];
    const ezRot: [number, number, number] = [-ey[0] * s + ez[0] * c, -ey[1] * s + ez[1] * c, -ey[2] * s + ez[2] * c];
    ey = eyRot;
    ez = ezRot;
  }

  return { ex, ey, ez, length };
}

/** 12x12 transformation matrix (global -> local): block-diagonal, 4 copies of the 3x3 rotation. */
export function transformationMatrix(axes: LocalAxes): number[][] {
  const r = [axes.ex, axes.ey, axes.ez];
  const t = zerosMatrix(12, 12);
  for (let block = 0; block < 4; block++) {
    const o = block * 3;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) t[o + i][o + j] = r[i][j];
  }
  return t;
}

/**
 * Local 3D beam element stiffness (Euler-Bernoulli, 6 DOF/node: ux,uy,uz,rx,ry,rz).
 * The y-bending block (uz/ry, using Iy) has sign-flipped off-diagonal terms relative to the
 * z-bending block (uy/rz, using Iz) — this is the standard convention and the single most
 * common source of sign bugs in a 3D beam formulation. Validated against closed-form deflection
 * checks with Iy != Iz specifically to catch a swapped or incorrectly-signed block (see spec).
 */
export function localBeamStiffness(
  youngsModulus: number,
  shearModulus: number,
  area: number,
  momentOfInertiaY: number,
  momentOfInertiaZ: number,
  torsionalConstant: number,
  length: number
): number[][] {
  const k = zerosMatrix(12, 12);
  const l2 = length * length;
  const l3 = l2 * length;

  const ka = (youngsModulus * area) / length;
  k[0][0] += ka; k[0][6] += -ka;
  k[6][0] += -ka; k[6][6] += ka;

  const kt = (shearModulus * torsionalConstant) / length;
  k[3][3] += kt; k[3][9] += -kt;
  k[9][3] += -kt; k[9][9] += kt;

  const kz = (youngsModulus * momentOfInertiaZ) / l3;
  const zIdx = [1, 5, 7, 11];
  const zBlock = [
    [12, 6 * length, -12, 6 * length],
    [6 * length, 4 * l2, -6 * length, 2 * l2],
    [-12, -6 * length, 12, -6 * length],
    [6 * length, 2 * l2, -6 * length, 4 * l2]
  ];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) k[zIdx[i]][zIdx[j]] += kz * zBlock[i][j];

  const ky = (youngsModulus * momentOfInertiaY) / l3;
  const yIdx = [2, 4, 8, 10];
  const yBlock = [
    [12, -6 * length, -12, -6 * length],
    [-6 * length, 4 * l2, 6 * length, 2 * l2],
    [-12, 6 * length, 12, 6 * length],
    [-6 * length, 2 * l2, 6 * length, 4 * l2]
  ];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) k[yIdx[i]][yIdx[j]] += ky * yBlock[i][j];

  return k;
}
