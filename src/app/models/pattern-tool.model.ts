export type PatternKind = 'linear' | 'circular';
export type PatternAxis = 'x' | 'y' | 'z';

export interface PatternToolState {
  kind: PatternKind;
  /** Body the pattern will be applied to — snapshotted from SelectionService.selectedBodyId the moment the tool activates, since the panel has its own Apply step and the user's live selection shouldn't silently drift out from under a half-configured pattern. */
  targetBodyId: string | null;
  /** Linear: which world axis to step along. Circular: which world axis to spin around. */
  axis: PatternAxis;
  /** Linear only — center-to-center spacing between instances, in mm. */
  spacing: number;
  /** Circular only — total sweep angle across all instances, in degrees (360 = full circle). */
  totalAngle: number;
  /** Total instances INCLUDING the original (matches SolidWorks/Fusion convention — "count: 3" means 1 original + 2 copies). */
  count: number;
}

export const IDLE_PATTERN_TOOL: PatternToolState = {
  kind: 'linear',
  targetBodyId: null,
  axis: 'x',
  spacing: 50,
  totalAngle: 360,
  count: 3
};
