export type PrimitiveKind = 'box' | 'cylinder' | 'sphere' | 'cone';

export interface PrimitiveDimensions {
  width: number;
  depth: number;
  height: number;
  radius: number;
  radius1: number;
  radius2: number;
}

export const DEFAULT_PRIMITIVE_DIMENSIONS: PrimitiveDimensions = {
  width: 50,
  depth: 50,
  height: 50,
  radius: 25,
  radius1: 25,
  radius2: 10
};

export type PrimitiveToolPhase = 'picking-point' | 'configuring';

export interface PrimitiveToolState {
  phase: PrimitiveToolPhase;
  kind: PrimitiveKind;
  origin: [number, number, number] | null;
}

export const IDLE_PRIMITIVE_TOOL: PrimitiveToolState = {
  phase: 'picking-point',
  kind: 'box',
  origin: null
};
