import { LocalAxes } from './beam-stiffness.util';

function dot(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * Fixed-end (equivalent nodal) load vector, local coordinates, for a UDL applied in a fixed
 * GLOBAL direction (e.g. gravity, global -Z) over a member's full length. The global intensity
 * is projected onto the member's local y and z axes since an arbitrarily-oriented member picks
 * up a global-direction load on both its local bending axes, not just one.
 *
 * The y-bending (uz/ry) fixed-end-force pattern is sign-flipped relative to the z-bending
 * (uy/rz) pattern, mirroring the sign flip in the y-bending stiffness block — both were
 * validated independently against closed-form UDL deflection formulas (wL^4/8EI) using Iy != Iz,
 * since a UDL applied to only one axis wouldn't catch a swapped/mis-signed formula on the other.
 */
export function fixedEndLoadsUDL(axes: LocalAxes, globalIntensity: number, globalDirection: [number, number, number]): number[] {
  const f = new Array(12).fill(0);
  const length = axes.length;

  const qy = globalIntensity * dot(globalDirection, axes.ey);
  const qz = globalIntensity * dot(globalDirection, axes.ez);

  const vy = (qy * length) / 2;
  const my = (qy * length * length) / 12;
  f[1] += vy; f[5] += my; f[7] += vy; f[11] += -my;

  const vz = (qz * length) / 2;
  const mz = (qz * length * length) / 12;
  f[2] += vz; f[4] += -mz; f[8] += vz; f[10] += mz;

  return f;
}
