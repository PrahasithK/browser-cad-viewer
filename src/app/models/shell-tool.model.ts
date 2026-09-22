export type ShellPhase = 'picking-faces' | 'configuring';

/** One picked face-to-remove, kept alongside its owning body — same single-body-per-operation constraint FilletChamferState's PickedEdge already documents (a shell is one boolean op against one target solid, so every pick must be the same body). */
export interface PickedShellFace {
  bodyId: string;
  faceIndex: number;
}

export interface ShellToolState {
  phase: ShellPhase;
  picks: PickedShellFace[];
  /** Wall thickness in mm — always hollows inward; see ShellRequest's own docstring for why the sign is fixed rather than user-facing. */
  thickness: number;
}

export const IDLE_SHELL_TOOL: ShellToolState = {
  phase: 'picking-faces',
  picks: [],
  thickness: 3
};
