import * as THREE from 'three';

export type MeasurementType = 'distance' | 'angle' | 'radius' | 'diameter' | 'area' | 'volume';

/** What a click in the Measure tool means. */
export type MeasureMode =
  /** Two points → straight-line distance. */
  | 'distance'
  /** Three points (vertex in the middle) → angle. */
  | 'angle'
  /** Two planar faces → distance if parallel, otherwise the angle between them. */
  | 'face'
  /** One circular edge → radius and diameter. */
  | 'circle';

export interface MeasurementPoint {
  position: THREE.Vector3;
  bodyId: string | null;
  faceIndex: number | null;
}

export interface Measurement {
  id: string;
  type: MeasurementType;
  pointA: MeasurementPoint;
  pointB: MeasurementPoint;
  /** The primary value: millimetres for distance/radius, degrees for angle. */
  distance: number;
  /** Ready-to-display text, e.g. "50.00 mm", "90.00°" or "R 25.00 mm  Ø 50.00 mm". */
  text: string;
  /** World-space point the in-view label is attached to. */
  anchor: THREE.Vector3;
}
