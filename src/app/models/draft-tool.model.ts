export type DraftPhase = 'picking-faces' | 'configuring';

/** One picked face-to-draft, kept alongside its owning body — same single-body-per-operation constraint ShellToolState's/FilletChamferState's own picked-item types already document (one boolean/offset op against one target solid, so every pick must be the same body). */
export interface PickedDraftFace {
  bodyId: string;
  faceIndex: number;
}

export interface DraftToolState {
  phase: DraftPhase;
  picks: PickedDraftFace[];
  /** Draft angle in degrees, applied around the fixed world-XY neutral plane along the fixed world +Z pull direction — see DraftRequest's own docstring for why both are fixed rather than user-picked in v1. */
  angleDeg: number;
}

export const IDLE_DRAFT_TOOL: DraftToolState = {
  phase: 'picking-faces',
  picks: [],
  angleDeg: 3
};
