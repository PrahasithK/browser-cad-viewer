export type LoadingPhase =
  | 'idle'
  | 'downloading-wasm'
  | 'initializing-occt'
  | 'reading-step'
  | 'tessellating'
  | 'building-geometry'
  | 'done'
  | 'error';

export interface LoadingProgress {
  phase: LoadingPhase;
  bodyIndex?: number;
  bodyCount?: number;
  percent?: number;
  message: string;
  indeterminate: boolean;
  error?: string;
}

export const IDLE_PROGRESS: LoadingProgress = {
  phase: 'idle',
  message: '',
  indeterminate: false
};
