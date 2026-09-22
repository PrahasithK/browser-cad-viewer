export type SectionAxis = 'x' | 'y' | 'z';

export interface SectionPlaneConfig {
  axis: SectionAxis;
  enabled: boolean;
  offset: number;
  flipped: boolean;
  min: number;
  max: number;
}
