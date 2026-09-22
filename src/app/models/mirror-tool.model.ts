export type MirrorPlane = 'XY' | 'YZ' | 'XZ';

export interface MirrorToolState {
  /** Body the mirror will be applied to — snapshotted from SelectionService.selectedBodyId the moment the tool activates, same convention PatternToolState.targetBodyId uses and for the same reason (the panel has its own Apply step; the user's live selection shouldn't silently drift out from under a half-configured mirror). */
  targetBodyId: string | null;
  /** Which fixed global datum plane to reflect across — the same three planes Sketch's datum option and the Section tool already use, through the world origin. Mirroring across an arbitrary offset/picked-face plane is a future extension, not v1 scope (see architecture.md). */
  plane: MirrorPlane;
}

export const IDLE_MIRROR_TOOL: MirrorToolState = {
  targetBodyId: null,
  plane: 'YZ'
};
