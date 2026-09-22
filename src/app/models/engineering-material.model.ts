/**
 * An engineering material for solid bodies (mass properties today; stress analysis later). SI units
 * throughout, matching the structural (beam) solver's own `Material` so the two can share data later.
 * Deliberately separate from `MaterialProperties`, which is only the render appearance.
 */
export interface EngineeringMaterial {
  id: string;
  name: string;
  /** kg/m³ */
  density: number;
  /** Pa */
  youngsModulus: number;
  poissonsRatio: number;
  /** Pa; null where the material has no meaningful yield point (e.g. grey cast iron). */
  yieldStrength: number | null;
}

/**
 * A starter library of typical handbook values, intended for quick estimates. Real alloys and tempers
 * vary (especially yield strength and plastics); check the values for your specific grade before
 * relying on them for design decisions.
 */
export const MATERIAL_LIBRARY: readonly EngineeringMaterial[] = [
  { id: 'steel-a36', name: 'Structural steel (A36)', density: 7850, youngsModulus: 200e9, poissonsRatio: 0.26, yieldStrength: 250e6 },
  { id: 'stainless-304', name: 'Stainless steel 304', density: 8000, youngsModulus: 193e9, poissonsRatio: 0.29, yieldStrength: 215e6 },
  { id: 'aluminium-6061-t6', name: 'Aluminium 6061-T6', density: 2700, youngsModulus: 68.9e9, poissonsRatio: 0.33, yieldStrength: 276e6 },
  { id: 'aluminium-7075-t6', name: 'Aluminium 7075-T6', density: 2810, youngsModulus: 71.7e9, poissonsRatio: 0.33, yieldStrength: 503e6 },
  { id: 'titanium-6al-4v', name: 'Titanium Ti-6Al-4V', density: 4430, youngsModulus: 113.8e9, poissonsRatio: 0.342, yieldStrength: 880e6 },
  { id: 'copper-c11000', name: 'Copper (C11000)', density: 8940, youngsModulus: 117e9, poissonsRatio: 0.34, yieldStrength: 69e6 },
  { id: 'cast-iron-grey', name: 'Grey cast iron', density: 7200, youngsModulus: 110e9, poissonsRatio: 0.28, yieldStrength: null },
  { id: 'abs', name: 'ABS plastic', density: 1040, youngsModulus: 2.2e9, poissonsRatio: 0.35, yieldStrength: 40e6 }
];

export function findMaterial(id: string | undefined | null): EngineeringMaterial | null {
  if (!id) return null;
  return MATERIAL_LIBRARY.find((m) => m.id === id) ?? null;
}
