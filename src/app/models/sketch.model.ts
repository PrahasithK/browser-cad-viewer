import { PlaneRef } from '../workers/step-worker-messages.model';

export type SketchPhase = 'picking-plane' | 'picking-face' | 'drawing' | 'ready';
export type SketchShape = 'rectangle' | 'circle' | 'polygon' | 'slot' | 'polyline';

/** Which in-plane direction of the active sketch plane acts as the Revolve axis — the plane's own U or V axis, not a separately-drawn line (see architecture.md's Revolve dated entry for the scoping decision: reuses the plane basis every sketch already computes, no new picking primitive needed). */
export type RevolveAxis = 'u' | 'v';

/**
 * Which in-plane direction a Sweep's straight path is TILTED toward, away from the sketch
 * plane's own normal. v1 first tried "sweep straight along the plane's own U or V axis" and
 * that's a real geometry bug, not just a scoping choice: U/V are IN the profile's own plane, so
 * a prism swept along either is degenerate (zero volume — there's no out-of-plane extent at
 * all). The corrected model sweeps along the plane's NORMAL (exactly what plain Extrude already
 * does at 0°), rotated by `tiltDeg` toward the chosen in-plane axis — at 0° this is identical to
 * Extrude, and at higher angles it's a genuinely oblique/angled prism (the real-world case this
 * feature exists for: angled ribs, draft-like walls), reachable through no other tool in this
 * app. See the 2026-09-11 Sweep dated entry in architecture.md for the full bug/fix story.
 */
export type SweepAxis = 'u' | 'v';

/** A snap-target derived from the picked face's boundary edges — world-space, read-only in Phase 1. */
export type FaceReferencePointKind = 'vertex' | 'midpoint' | 'circle-center' | 'intersection';

export interface FaceReferencePoint {
  kind: FaceReferencePointKind;
  position: [number, number, number];
}

/** The picked face's world-space sketch frame — an orthonormal (origin, uAxis, vAxis, normal) basis, precomputed once so projection/rendering never re-derive it. */
export interface FacePlaneFrame {
  origin: [number, number, number];
  normal: [number, number, number];
  uAxis: [number, number, number];
  vAxis: [number, number, number];
}

export interface SketchState {
  phase: SketchPhase;
  planeRef: PlaneRef | null;
  shape: SketchShape;
  points: [number, number][];
  /** Extra shape-specific parameter: regular-polygon side count, or slot width in mm. Unused by rectangle/circle. */
  param: number;
  /** Only set when planeRef.kind === 'face': the resolved world-space frame, for client-side projection/rendering. */
  facePlane: FacePlaneFrame | null;
  /** Only set when planeRef.kind === 'face': identity of the picked face, for re-deriving/redrawing overlays. */
  pickedFace: { bodyId: string; faceIndex: number } | null;
  /** Snap targets for the active face, computed once at pick time. Empty for datum planes. */
  referencePoints: FaceReferencePoint[];
  /**
   * Polyline only: whether the user has explicitly closed the loop (double-click, Enter, or clicking
   * back near the start point). Every other shape completes automatically at its fixed point count
   * (see `SKETCH_SHAPE_POINT_COUNT`), so this stays false and unused for them. A polyline keeps
   * accepting points — any number, not just a fixed count — until it's closed.
   */
  closed: boolean;
}

/**
 * Number of viewport clicks each fixed-shape needs before it has a complete profile. Polyline is
 * NOT driven by this — see `SketchState.closed` — but keeps a 3-point floor here as documentation
 * of its real minimum (a closed loop needs at least a triangle).
 */
export const SKETCH_SHAPE_POINT_COUNT: Record<SketchShape, number> = {
  rectangle: 2,
  circle: 2,
  polygon: 2,
  slot: 2,
  polyline: 3
};

export const IDLE_SKETCH: SketchState = {
  phase: 'picking-plane',
  planeRef: null,
  shape: 'rectangle',
  points: [],
  param: 6,
  facePlane: null,
  pickedFace: null,
  referencePoints: [],
  closed: false
};
