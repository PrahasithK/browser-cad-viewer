// STEP geometry is imported and kept in native millimeters as Three.js scene units (no rescale).
// These helpers format mm-based values for display and provide mm<->m conversions for any
// future unit-toggle feature, even though the core pipeline stays in mm throughout.

export function mmToM(mm: number): number {
  return mm / 1000;
}

export function mToMm(m: number): number {
  return m * 1000;
}

export function formatLength(mm: number): string {
  return `${mm.toFixed(2)} mm`;
}

export function formatAngle(deg: number): string {
  return `${deg.toFixed(2)}°`;
}

export function formatArea(mm2: number): string {
  return `${mm2.toFixed(2)} mm²`;
}

export function formatVolume(mm3: number): string {
  return `${mm3.toFixed(2)} mm³`;
}
