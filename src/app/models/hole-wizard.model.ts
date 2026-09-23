import { FaceReferencePoint } from './sketch.model';
import { HoleType } from '../workers/step-worker-messages.model';

export type HoleWizardPhase = 'picking-face' | 'picking-point' | 'configuring';

export type HoleFit = 'close' | 'normal' | 'loose';

/** One fastener size's clearance-hole diameter at each fit class — standard values (ISO 273 metric clearance holes; ANSI B18.2.8 for the inch sizes), not house-specific numbers. */
export interface HoleSizePreset {
  /** Display label, e.g. "M6" or "#10-24". */
  label: string;
  diameters: Record<HoleFit, number>;
  /** Counterbore for a socket head cap screw of this size (ISO 4762 / ASME B18.3), mm — the usual starting values from published counterbore tables; editable in the panel. */
  counterbore: { diameter: number; depth: number };
  /** Countersink surface diameter for a flat head screw of this size (ISO 10642 at 90°, ASME B18.3 at 82°), mm. */
  countersinkDiameter: number;
}

/** Metric clearance-hole diameters (mm) per ISO 273, close/normal/loose fit classes — the same reference table SolidWorks/Fusion's own Hole Wizard metric clearance presets are built from. */
export const METRIC_HOLE_PRESETS: HoleSizePreset[] = [
  { label: 'M3', diameters: { close: 3.2, normal: 3.4, loose: 3.6 }, counterbore: { diameter: 6.5, depth: 3.3 }, countersinkDiameter: 6.3 },
  { label: 'M4', diameters: { close: 4.3, normal: 4.5, loose: 4.8 }, counterbore: { diameter: 8, depth: 4.4 }, countersinkDiameter: 9.4 },
  { label: 'M5', diameters: { close: 5.3, normal: 5.5, loose: 5.8 }, counterbore: { diameter: 9.5, depth: 5.4 }, countersinkDiameter: 10.4 },
  { label: 'M6', diameters: { close: 6.4, normal: 6.6, loose: 7.0 }, counterbore: { diameter: 11, depth: 6.5 }, countersinkDiameter: 12.6 },
  { label: 'M8', diameters: { close: 8.4, normal: 9.0, loose: 10.0 }, counterbore: { diameter: 14, depth: 8.6 }, countersinkDiameter: 17.3 },
  { label: 'M10', diameters: { close: 10.5, normal: 11.0, loose: 12.0 }, counterbore: { diameter: 17.5, depth: 10.8 }, countersinkDiameter: 20 },
  { label: 'M12', diameters: { close: 13.0, normal: 13.5, loose: 14.5 }, counterbore: { diameter: 20, depth: 13 }, countersinkDiameter: 24 }
];

/** Common inch fastener clearance-hole diameters (mm, converted from ANSI B18.2.8 inch values) — kept as a second preset family rather than mixing units into one table. */
export const INCH_HOLE_PRESETS: HoleSizePreset[] = [
  { label: '#4-40', diameters: { close: 2.84, normal: 2.97, loose: 3.30 }, counterbore: { diameter: 5.54, depth: 2.84 }, countersinkDiameter: 6.48 },
  { label: '#6-32', diameters: { close: 3.51, normal: 3.71, loose: 4.09 }, counterbore: { diameter: 6.35, depth: 3.51 }, countersinkDiameter: 7.80 },
  { label: '#8-32', diameters: { close: 4.17, normal: 4.37, loose: 4.75 }, counterbore: { diameter: 7.14, depth: 4.17 }, countersinkDiameter: 9.12 },
  { label: '#10-24', diameters: { close: 4.83, normal: 5.10, loose: 5.56 }, counterbore: { diameter: 7.92, depth: 4.83 }, countersinkDiameter: 10.44 },
  { label: '1/4-20', diameters: { close: 6.53, normal: 6.86, loose: 7.54 }, counterbore: { diameter: 10.31, depth: 6.35 }, countersinkDiameter: 13.49 },
  { label: '5/16-18', diameters: { close: 8.03, normal: 8.43, loose: 9.09 }, counterbore: { diameter: 12.70, depth: 7.92 }, countersinkDiameter: 16.66 },
  { label: '3/8-16', diameters: { close: 9.63, normal: 10.06, loose: 10.72 }, counterbore: { diameter: 15.06, depth: 9.53 }, countersinkDiameter: 19.84 }
];

export type HoleStandard = 'metric' | 'inch';

/** Included countersink angle for flat head screws in each standard. */
export const COUNTERSINK_ANGLE_DEG: Record<HoleStandard, number> = { metric: 90, inch: 82 };

export interface HoleWizardState {
  phase: HoleWizardPhase;
  standard: HoleStandard;
  /** Index into METRIC_HOLE_PRESETS or INCH_HOLE_PRESETS, whichever `standard` selects. */
  presetIndex: number;
  fit: HoleFit;
  holeType: HoleType;
  /** Counterbore/countersink sizes — reset to the preset's standard values whenever the standard or size changes, then freely editable. */
  cboreDiameter: number;
  cboreDepth: number;
  csinkDiameter: number;
  csinkAngleDeg: number;
  /** Set once a face is picked — the same face-plane/reference-point shape Sketch's face-pick phase produces, reused here for the same client-side, zero-OCCT-round-trip resolution. */
  pickedFace: { bodyId: string; faceIndex: number } | null;
  facePlane: { origin: [number, number, number]; normal: [number, number, number]; uAxis: [number, number, number]; vAxis: [number, number, number] } | null;
  referencePoints: FaceReferencePoint[];
  /** Hole center, in the face plane's local (u, v) coordinates — set once the point-pick click lands. */
  center: [number, number] | null;
}

export function holePresetsFor(standard: HoleStandard): HoleSizePreset[] {
  return standard === 'metric' ? METRIC_HOLE_PRESETS : INCH_HOLE_PRESETS;
}

/** The counterbore/countersink fields for a given standard + size, straight from the preset tables. */
export function standardEntrySizes(standard: HoleStandard, presetIndex: number): Pick<HoleWizardState, 'cboreDiameter' | 'cboreDepth' | 'csinkDiameter' | 'csinkAngleDeg'> {
  const preset = holePresetsFor(standard)[presetIndex] ?? holePresetsFor(standard)[0];
  return {
    cboreDiameter: preset.counterbore.diameter,
    cboreDepth: preset.counterbore.depth,
    csinkDiameter: preset.countersinkDiameter,
    csinkAngleDeg: COUNTERSINK_ANGLE_DEG[standard]
  };
}

export const IDLE_HOLE_WIZARD: HoleWizardState = {
  phase: 'picking-face',
  standard: 'metric',
  presetIndex: 3, // M6 — a reasonable general-purpose default, same "sensible starting value" convention primitive-tool.model.ts's defaults already use
  fit: 'normal',
  holeType: 'simple',
  ...standardEntrySizes('metric', 3),
  pickedFace: null,
  facePlane: null,
  referencePoints: [],
  center: null
};
