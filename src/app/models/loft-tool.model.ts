/**
 * Loft blends between 2+ profiles drawn one at a time — a materially different shape than every
 * other Sketch-based feature (Extrude/Revolve/Sweep), which each commit ONE profile and
 * immediately build a feature from it. Loft instead needs to accumulate a LIST of already-
 * committed profiles (each its own sketchId) before Build can run, so it gets its own tool/state
 * rather than being a 4th finish-mode toggle inside the Sketch panel — 'picking-plane'/'drawing'/
 * etc. mid-profile state still lives entirely in SketchService (LoftToolService drives it, not
 * duplicates it); this state only tracks the cross-section LIST once each profile is done.
 */
export type LoftPhase = 'drawing-profile' | 'ready-to-add-more';

export interface CommittedLoftProfile {
  sketchId: string;
  /** Human-readable label for the panel's list — "Profile 1", "Profile 2", etc. in commit order. */
  label: string;
  /**
   * Snapshotted from SketchService.state().pickedFace at the moment this profile was committed
   * (added 2026-09-13, alongside Loft's own cut/fuse-into-an-existing-part support) — captured
   * here because `resetForNextProfile()` clears SketchService's own `pickedFace` before the next
   * profile begins, so by Finish-Loft time it would otherwise be lost. Only the FIRST profile's
   * pickedFace is ever used as the cut/fuse target (see `feature.loft`'s own docstring in
   * step-worker-messages.model.ts for why); every other profile's is kept here too, for symmetry,
   * but ignored.
   */
  pickedFace: { bodyId: string; faceIndex: number } | null;
}

export interface LoftToolState {
  phase: LoftPhase;
  profiles: CommittedLoftProfile[];
}

export const IDLE_LOFT_TOOL: LoftToolState = {
  phase: 'drawing-profile',
  profiles: []
};
