export type ViewPreset = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso';

export interface ViewPresetVector {
  position: [number, number, number];
  up: [number, number, number];
}

export const VIEW_PRESET_VECTORS: Record<ViewPreset, ViewPresetVector> = {
  front: { position: [0, -1, 0], up: [0, 0, 1] },
  back: { position: [0, 1, 0], up: [0, 0, 1] },
  left: { position: [-1, 0, 0], up: [0, 0, 1] },
  right: { position: [1, 0, 0], up: [0, 0, 1] },
  top: { position: [0, 0, 1], up: [0, 1, 0] },
  bottom: { position: [0, 0, -1], up: [0, -1, 0] },
  iso: { position: [1, -1, 1], up: [0, 0, 1] }
};
