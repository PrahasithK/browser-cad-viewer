import { Injectable, signal } from '@angular/core';
import * as THREE from 'three';
import { StructuralModelService } from './structural-model.service';
import { StructuralRendererService } from './structural-renderer.service';

const NODE_PICK_PIXEL_THRESHOLD = 16;

/** Interaction state for placing nodes/members in the viewport — the structural-analysis analogue of SketchService. */
@Injectable({ providedIn: 'root' })
export class StructuralToolService {
  readonly workingPlaneElevation = signal(0);
  readonly pendingMemberStartNodeId = signal<string | null>(null);
  readonly selectedNodeId = signal<string | null>(null);
  readonly selectedMemberId = signal<string | null>(null);

  constructor(
    private readonly model: StructuralModelService,
    private readonly renderer: StructuralRendererService
  ) {}

  placeNodeOnWorkingPlane(x: number, y: number): void {
    this.model.addNode([x, y, this.workingPlaneElevation()]);
    this.renderer.refresh(this.selectedNodeId());
  }

  pickNodeNear(clientX: number, clientY: number, canvas: HTMLCanvasElement, camera: THREE.Camera): string | null {
    const rect = canvas.getBoundingClientRect();
    const targetNdcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const targetNdcY = -((clientY - rect.top) / rect.height) * 2 + 1;

    const positions = this.renderer.getNodeScreenPositions(camera);
    let closest: { nodeId: string; distPx: number } | null = null;
    for (const p of positions) {
      const dx = (p.x - targetNdcX) * (rect.width / 2);
      const dy = (p.y - targetNdcY) * (rect.height / 2);
      const distPx = Math.hypot(dx, dy);
      if (distPx <= NODE_PICK_PIXEL_THRESHOLD && (!closest || distPx < closest.distPx)) {
        closest = { nodeId: p.nodeId, distPx };
      }
    }
    return closest?.nodeId ?? null;
  }

  handleMemberClickTarget(nodeId: string): void {
    const pending = this.pendingMemberStartNodeId();
    if (!pending) {
      this.pendingMemberStartNodeId.set(nodeId);
      return;
    }
    if (pending !== nodeId) {
      this.model.addMember(pending, nodeId);
      this.renderer.refresh(this.selectedNodeId());
    }
    this.pendingMemberStartNodeId.set(null);
  }

  cancel(): void {
    this.pendingMemberStartNodeId.set(null);
  }
}
