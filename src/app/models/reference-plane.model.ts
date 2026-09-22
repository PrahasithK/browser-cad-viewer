export type ReferencePlaneBaseKind = 'datum' | 'face';

/** What a new reference plane is offset from — a fixed global datum plane, or a picked face on an existing part. Mirrors PlaneRef's own datum/face split (workers/step-worker-messages.model.ts) since a reference plane ultimately resolves to the exact same shape once built. */
export type ReferencePlaneBase =
  | { kind: 'datum'; plane: 'XY' | 'YZ' | 'XZ' }
  | { kind: 'face'; bodyId: string; faceIndex: number };

/** A user-created, named, offset reference plane — stored independently of TreeService (a plane has no solid geometry to select/measure/export the way a CadBody does; SectionService's own clipping-plane config is the closest existing precedent for "plane state that isn't a tree body"). Once built, it resolves to exactly the same {origin, normal, uAxis} frame Sketch's face-pick phase already produces, so it plugs into the existing sketch/extrude pipeline with zero worker changes. */
export interface ReferencePlane {
  id: string;
  name: string;
  base: ReferencePlaneBase;
  /** Offset distance in mm along the base plane's normal — the only free parameter in v1 (offset-only, no rotation; see architecture.md's 2026-09-10 planning note for the scoping decision). */
  offset: number;
  visible: boolean;
}

/** Interactive creation-tool state — mirrors PatternToolState/MirrorToolState's own IDLE_* shape: a snapshot the panel edits before committing, not live-synced to anything else. */
export interface ReferencePlaneToolState {
  /** Set once the user has picked a base (a datum button click, or a face click in the viewport) — null while still picking. */
  base: ReferencePlaneBase | null;
  offset: number;
  name: string;
}

export const IDLE_REFERENCE_PLANE_TOOL: ReferencePlaneToolState = {
  base: null,
  offset: 25,
  name: ''
};
