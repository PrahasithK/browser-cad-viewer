import { Injectable, signal } from '@angular/core';
import { StepLoaderService } from './step-loader.service';
import { ViewerService } from './viewer.service';
import { TreeService } from './tree.service';
import { CameraService } from './camera.service';
import { PrimitiveSpec } from '../workers/step-worker-messages.model';
import {
  DEFAULT_PRIMITIVE_DIMENSIONS,
  IDLE_PRIMITIVE_TOOL,
  PrimitiveDimensions,
  PrimitiveKind,
  PrimitiveToolState
} from '../models/primitive-tool.model';

/** Interaction state for placing a 3D primitive (box/cylinder/sphere/cone): click a base point in the viewport, then configure dimensions before committing. Click-to-place analogue of StructuralToolService/SketchService for standalone solids rather than sketch-driven features. */
@Injectable({ providedIn: 'root' })
export class PrimitiveToolService {
  readonly state = signal<PrimitiveToolState>(IDLE_PRIMITIVE_TOOL);
  readonly dimensions = signal<PrimitiveDimensions>(DEFAULT_PRIMITIVE_DIMENSIONS);
  readonly busy = signal(false);
  readonly lastError = signal<string | null>(null);

  constructor(
    private readonly stepLoader: StepLoaderService,
    private readonly viewer: ViewerService,
    private readonly tree: TreeService,
    private readonly camera: CameraService
  ) {}

  setKind(kind: PrimitiveKind): void {
    this.state.update((st) => ({ ...st, kind }));
  }

  placeAt(x: number, y: number, z: number): void {
    if (this.state().phase !== 'picking-point') return;
    this.state.update((st) => ({ ...st, phase: 'configuring', origin: [x, y, z] }));
  }

  setDimension(key: keyof PrimitiveDimensions, value: number): void {
    if (!Number.isFinite(value) || value <= 0) return;
    this.dimensions.update((d) => ({ ...d, [key]: value }));
  }

  private buildSpec(): PrimitiveSpec {
    const { kind, origin } = this.state();
    if (!origin) throw new Error('No placement point set');
    const d = this.dimensions();

    switch (kind) {
      case 'box':
        return { kind: 'box', origin, width: d.width, depth: d.depth, height: d.height };
      case 'cylinder':
        return { kind: 'cylinder', origin, radius: d.radius, height: d.height };
      case 'sphere':
        return { kind: 'sphere', origin, radius: d.radius };
      case 'cone':
        return { kind: 'cone', origin, radius1: d.radius1, radius2: d.radius2, height: d.height };
    }
  }

  async commit(): Promise<void> {
    this.busy.set(true);
    this.lastError.set(null);
    try {
      const spec = this.buildSpec();
      const body = await this.stepLoader.createPrimitive(spec);
      this.viewer.addBody(body.mesh);
      this.tree.registerBody(body);
      this.camera.fitAll();
      this.state.set(IDLE_PRIMITIVE_TOOL);
    } catch (err) {
      this.lastError.set(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      this.busy.set(false);
    }
  }

  cancel(): void {
    this.state.set({ ...IDLE_PRIMITIVE_TOOL, kind: this.state().kind });
    this.lastError.set(null);
  }
}
