import { Injectable, signal } from '@angular/core';
import * as THREE from 'three';
import { ViewerService } from './viewer.service';
import { TreeService } from './tree.service';
import { computeCentroid, radialDirection } from '../utils/geometry-math.util';

@Injectable({ providedIn: 'root' })
export class ExplodedViewService {
  readonly amount = signal(0);

  private basePositions = new Map<string, THREE.Vector3>();
  private directions = new Map<string, THREE.Vector3>();
  private animationHandle: number | null = null;

  constructor(
    private readonly viewer: ViewerService,
    private readonly tree: TreeService
  ) {}

  private computeBaseState(): void {
    this.basePositions.clear();
    this.directions.clear();

    const bodies = this.tree.allBodies();
    if (bodies.length === 0) return;

    const boxes = bodies.map((b) => new THREE.Box3().setFromObject(b.mesh));
    const assemblyCenter = computeCentroid(boxes);

    bodies.forEach((body, i) => {
      this.basePositions.set(body.id, body.mesh.position.clone());
      const bodyCenter = boxes[i].getCenter(new THREE.Vector3());
      this.directions.set(body.id, radialDirection(bodyCenter, assemblyCenter));
    });
  }

  setAmount(value: number): void {
    if (this.basePositions.size === 0) {
      this.computeBaseState();
    }

    this.amount.set(value);
    const bodies = this.tree.allBodies();
    for (const body of bodies) {
      const base = this.basePositions.get(body.id);
      const dir = this.directions.get(body.id);
      if (!base || !dir) continue;
      body.mesh.position.copy(base.clone().add(dir.clone().multiplyScalar(value)));
    }
  }

  reset(): void {
    if (this.animationHandle !== null) cancelAnimationFrame(this.animationHandle);

    const startAmount = this.amount();
    const duration = 400;
    const startTime = performance.now();

    const step = (now: number) => {
      const t = Math.min((now - startTime) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      this.setAmount(startAmount * (1 - eased));
      if (t < 1) {
        this.animationHandle = requestAnimationFrame(step);
      } else {
        this.animationHandle = null;
        this.basePositions.clear();
        this.directions.clear();
      }
    };
    this.animationHandle = requestAnimationFrame(step);
  }
}
