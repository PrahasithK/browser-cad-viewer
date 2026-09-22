import * as THREE from 'three';

/** Second moments of a body's volume, per unit density, in world axes about its centre of volume. Lengths in mm. */
export interface MassProperties {
  /** mm³. The kernel's exact volume when one was supplied, otherwise the tessellated mesh's. */
  volume: number;
  /** Centre of volume in world space, mm. Equals the centre of mass for a uniform-density body. */
  centroid: THREE.Vector3;
  /**
   * Inertia tensor per unit density, mm⁵, about the centroid in world axes. Off-diagonals use the
   * standard tensor sign (I_xy = −∫xy dV). Multiply by density (kg/mm³) for kg·mm².
   */
  inertia: { xx: number; yy: number; zz: number; xy: number; xz: number; yz: number };
  /** Principal moments of the tensor above, ascending, mm⁵ per unit density. */
  principal: [number, number, number];
}

const MM3_PER_M3 = 1e9;

/**
 * Volume, centre of volume and inertia tensor of a closed triangle mesh, computed exactly for the mesh
 * by summing signed tetrahedra to the origin (divergence theorem; Eberly's polyhedral mass properties).
 * Works for every body kind, needs no kernel round-trip, and is evaluated in WORLD space so a moved or
 * rotated body reports its real position. Accuracy is that of the display tessellation (a curved
 * surface is a polyhedron), so pass the kernel's exact `referenceVolume` when known: the result is
 * scaled to it, which removes the systematic shrinkage of a coarse tessellation.
 *
 * Returns null for an empty or degenerate mesh.
 */
export function computeMassProperties(
  geometry: THREE.BufferGeometry,
  matrixWorld: THREE.Matrix4,
  referenceVolume?: number | null
): MassProperties | null {
  const position = geometry.getAttribute('position');
  if (!position) return null;
  const index = geometry.getIndex();
  const triangleCount = index ? index.count / 3 : position.count / 3;
  if (triangleCount < 4) return null;

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const vertex = (n: number, out: THREE.Vector3): void => {
    out.fromBufferAttribute(position, index ? index.getX(n) : n).applyMatrix4(matrixWorld);
  };

  // Accumulate relative to the first vertex: models far from the origin would otherwise lose precision
  // to cancellation when the centroid is subtracted from the raw second moments.
  const origin = new THREE.Vector3();
  vertex(0, origin);

  let volume = 0;
  let cx = 0, cy = 0, cz = 0;
  let sxx = 0, syy = 0, szz = 0, sxy = 0, sxz = 0, syz = 0;

  for (let t = 0; t < triangleCount; t++) {
    vertex(t * 3, a);
    vertex(t * 3 + 1, b);
    vertex(t * 3 + 2, c);
    a.sub(origin);
    b.sub(origin);
    c.sub(origin);

    const det = a.x * (b.y * c.z - b.z * c.y) - a.y * (b.x * c.z - b.z * c.x) + a.z * (b.x * c.y - b.y * c.x); // 6 × signed tetra volume
    volume += det / 6;

    const sx = a.x + b.x + c.x;
    const sy = a.y + b.y + c.y;
    const sz = a.z + b.z + c.z;
    cx += (det / 24) * sx;
    cy += (det / 24) * sy;
    cz += (det / 24) * sz;

    const f = det / 120;
    sxx += f * (a.x * a.x + b.x * b.x + c.x * c.x + sx * sx);
    syy += f * (a.y * a.y + b.y * b.y + c.y * c.y + sy * sy);
    szz += f * (a.z * a.z + b.z * b.z + c.z * c.z + sz * sz);
    sxy += f * (a.x * a.y + b.x * b.y + c.x * c.y + sx * sy);
    sxz += f * (a.x * a.z + b.x * b.z + c.x * c.z + sx * sz);
    syz += f * (a.y * a.z + b.y * b.z + c.y * c.z + sy * sz);
  }

  // An inside-out mesh (or a mirrored world matrix) gives a negative signed volume: flip everything.
  const sign = volume < 0 ? -1 : 1;
  volume *= sign;
  if (!(volume > 1e-9)) return null;
  cx *= sign; cy *= sign; cz *= sign;
  sxx *= sign; syy *= sign; szz *= sign; sxy *= sign; sxz *= sign; syz *= sign;

  const gx = cx / volume;
  const gy = cy / volume;
  const gz = cz / volume;

  // Covariance of the volume about its centroid.
  const cxx = sxx - volume * gx * gx;
  const cyy = syy - volume * gy * gy;
  const czz = szz - volume * gz * gz;
  const cxy = sxy - volume * gx * gy;
  const cxz = sxz - volume * gx * gz;
  const cyz = syz - volume * gy * gz;

  const hasReference = !!referenceVolume && referenceVolume > 0;
  const scale = hasReference ? referenceVolume / volume : 1;
  const inertia = {
    xx: (cyy + czz) * scale,
    yy: (cxx + czz) * scale,
    zz: (cxx + cyy) * scale,
    xy: -cxy * scale,
    xz: -cxz * scale,
    yz: -cyz * scale
  };

  return {
    volume: hasReference ? referenceVolume : volume,
    centroid: new THREE.Vector3(origin.x + gx, origin.y + gy, origin.z + gz),
    inertia,
    principal: principalMoments(inertia)
  };
}

/** Eigenvalues of a symmetric 3×3 tensor, ascending (closed-form trigonometric solution). */
export function principalMoments(t: MassProperties['inertia']): [number, number, number] {
  const p1 = t.xy * t.xy + t.xz * t.xz + t.yz * t.yz;
  if (p1 <= 1e-30 * Math.max(t.xx * t.xx, t.yy * t.yy, t.zz * t.zz, 1e-300)) {
    return [t.xx, t.yy, t.zz].sort((x, y) => x - y) as [number, number, number];
  }

  const q = (t.xx + t.yy + t.zz) / 3;
  const p2 = (t.xx - q) ** 2 + (t.yy - q) ** 2 + (t.zz - q) ** 2 + 2 * p1;
  const p = Math.sqrt(p2 / 6);
  const bxx = (t.xx - q) / p, byy = (t.yy - q) / p, bzz = (t.zz - q) / p;
  const bxy = t.xy / p, bxz = t.xz / p, byz = t.yz / p;
  const detB = bxx * (byy * bzz - byz * byz) - bxy * (bxy * bzz - byz * bxz) + bxz * (bxy * byz - byy * bxz);
  const r = Math.min(1, Math.max(-1, detB / 2));
  const phi = Math.acos(r) / 3;

  const largest = q + 2 * p * Math.cos(phi);
  const smallest = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  const middle = 3 * q - largest - smallest;
  return [smallest, middle, largest];
}

/** kg from a volume in mm³ and a density in kg/m³. */
export function massKg(volumeMm3: number, densityKgM3: number): number {
  return (volumeMm3 / MM3_PER_M3) * densityKgM3;
}

/** kg·mm² from an inertia component per unit density (mm⁵) and a density in kg/m³. */
export function inertiaKgMm2(perDensityMm5: number, densityKgM3: number): number {
  return (perDensityMm5 / MM3_PER_M3) * densityKgM3;
}

export function formatMass(kg: number): string {
  if (kg >= 1) return `${kg.toFixed(3)} kg`;
  if (kg >= 1e-3) return `${(kg * 1e3).toFixed(2)} g`;
  return `${(kg * 1e6).toFixed(2)} mg`;
}

export function formatInertia(kgMm2: number): string {
  return `${kgMm2.toPrecision(4)} kg·mm²`;
}
