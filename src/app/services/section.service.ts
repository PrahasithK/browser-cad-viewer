import { Injectable, signal } from '@angular/core';
import * as THREE from 'three';
import { ViewerService } from './viewer.service';
import { SectionAxis, SectionPlaneConfig } from '../models/section-plane.model';

const AXIS_NORMALS: Record<SectionAxis, THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1)
};

@Injectable({ providedIn: 'root' })
export class SectionService {
  readonly configs = signal<Record<SectionAxis, SectionPlaneConfig>>({
    x: { axis: 'x', enabled: false, offset: 0, flipped: false, min: -1000, max: 1000 },
    y: { axis: 'y', enabled: false, offset: 0, flipped: false, min: -1000, max: 1000 },
    z: { axis: 'z', enabled: false, offset: 0, flipped: false, min: -1000, max: 1000 }
  });

  private readonly planes: Record<SectionAxis, THREE.Plane> = {
    x: new THREE.Plane(AXIS_NORMALS['x'].clone(), 0),
    y: new THREE.Plane(AXIS_NORMALS['y'].clone(), 0),
    z: new THREE.Plane(AXIS_NORMALS['z'].clone(), 0)
  };

  constructor(private readonly viewer: ViewerService) {}

  setEnabled(axis: SectionAxis, enabled: boolean): void {
    this.configs.update((c) => ({ ...c, [axis]: { ...c[axis], enabled } }));
    this.applyClippingPlanes();
  }

  setOffset(axis: SectionAxis, offset: number): void {
    this.configs.update((c) => ({ ...c, [axis]: { ...c[axis], offset } }));
    this.updatePlane(axis);
    this.applyClippingPlanes();
  }

  setFlipped(axis: SectionAxis, flipped: boolean): void {
    this.configs.update((c) => ({ ...c, [axis]: { ...c[axis], flipped } }));
    this.updatePlane(axis);
    this.applyClippingPlanes();
  }

  private updatePlane(axis: SectionAxis): void {
    const cfg = this.configs()[axis];
    const normal = AXIS_NORMALS[axis].clone();
    if (cfg.flipped) normal.negate();
    this.planes[axis].normal.copy(normal);
    this.planes[axis].constant = -cfg.offset;
  }

  private applyClippingPlanes(): void {
    const cfg = this.configs();
    const active = (['x', 'y', 'z'] as SectionAxis[]).filter((a) => cfg[a].enabled).map((a) => this.planes[a]);
    if (this.viewer.renderer) {
      this.viewer.renderer.clippingPlanes = active;
    }
  }

  reset(): void {
    for (const axis of ['x', 'y', 'z'] as SectionAxis[]) {
      this.setEnabled(axis, false);
      this.setOffset(axis, 0);
    }
  }
}
