export type FilletChamferKind = 'fillet' | 'chamfer';
export type FilletChamferPhase = 'picking-edges' | 'configuring';

/**
 * One picked edge, kept alongside its owning body so a multi-edge fillet/chamfer can span edges
 * on the same body (multiple bodies would mean multiple separate boolean targets — not supported
 * in v1, mirrors how BridgeMeshService requires its two picks on different bodies but inverted:
 * here every pick must be the SAME body). `value` (added 2026-09-13 — "variable-radius fillet")
 * is this edge's OWN radius/distance, defaulted from `FilletChamferState.defaultValue` at pick
 * time but independently editable afterward — a 3-edge fillet can mix 5mm/8mm/3mm in one
 * operation instead of every edge sharing one value.
 */
export interface PickedEdge {
  bodyId: string;
  edgeIndex: number;
  value: number;
}

export interface FilletChamferState {
  phase: FilletChamferPhase;
  kind: FilletChamferKind;
  picks: PickedEdge[];
  /** Fillet radius or chamfer distance, in mm, that a NEWLY picked edge starts at — not applied to already-picked edges, which each keep their own independently-set `value` (see PickedEdge's own docstring). Renamed from a plain `value` (which used to apply uniformly to every pick) when per-edge values were added 2026-09-13. */
  defaultValue: number;
}

export const IDLE_FILLET_CHAMFER: FilletChamferState = {
  phase: 'picking-edges',
  kind: 'fillet',
  picks: [],
  defaultValue: 3
};
