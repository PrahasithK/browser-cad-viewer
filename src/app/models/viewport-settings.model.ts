export type ShadingMode = 'solid' | 'wireframe' | 'transparent';
export type CameraProjection = 'perspective' | 'orthographic';

export interface ViewportSettings {
  shadingMode: ShadingMode;
  showGrid: boolean;
  showAxes: boolean;
  darkMode: boolean;
  cameraProjection: CameraProjection;
  pixelRatio: number;
}
