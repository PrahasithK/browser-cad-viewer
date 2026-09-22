import { Injectable, signal } from '@angular/core';
import { CadBody } from '../models/cad-body.model';
import { PickedFace } from '../models/bridge-mesh.model';
import { extractBoundaryLoop } from '../utils/mesh-boundary.util';
import { buildBridgeMesh } from '../utils/bridge-mesh.util';
import { BridgeMeshRendererService } from './bridge-mesh-renderer.service';

const DEFAULT_DENSITY = 6;

/** Interaction state for picking two faces and generating the bridging mesh — mirrors StructuralToolService/SketchService's shape. */
@Injectable({ providedIn: 'root' })
export class BridgeMeshService {
  readonly firstPick = signal<PickedFace | null>(null);
  readonly secondPick = signal<PickedFace | null>(null);
  readonly density = signal(DEFAULT_DENSITY);
  readonly errorMessage = signal<string | null>(null);

  constructor(private readonly renderer: BridgeMeshRendererService) {}

  handlePick(body: CadBody, faceIndex: number): void {
    this.errorMessage.set(null);

    const positionAttr = body.geometry.attributes['position'];
    const indexAttr = body.geometry.index;
    if (!positionAttr || !indexAttr) return;

    const loop = extractBoundaryLoop(
      positionAttr.array as Float32Array,
      indexAttr.array as Uint32Array,
      body.faceIdMap,
      faceIndex
    );
    if (!loop) {
      this.errorMessage.set('Could not extract a boundary loop for that face.');
      return;
    }

    const picked: PickedFace = { bodyId: body.id, faceIndex, loop };
    const first = this.firstPick();

    if (!first) {
      this.firstPick.set(picked);
      this.secondPick.set(null);
      this.renderer.clear();
      return;
    }

    if (first.bodyId === body.id) {
      this.errorMessage.set('Pick a face on a different part than the first selection.');
      return;
    }

    this.secondPick.set(picked);
    this.recompute();
  }

  setDensity(value: number): void {
    this.density.set(value);
    if (this.firstPick() && this.secondPick()) this.recompute();
  }

  private recompute(): void {
    const a = this.firstPick();
    const b = this.secondPick();
    if (!a || !b) return;
    const result = buildBridgeMesh(a.loop, b.loop, this.density());
    this.renderer.render(result);
  }

  cancel(): void {
    this.firstPick.set(null);
    this.secondPick.set(null);
    this.errorMessage.set(null);
    this.renderer.clear();
  }
}
