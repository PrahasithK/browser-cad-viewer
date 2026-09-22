import { Injectable, signal } from '@angular/core';
import * as THREE from 'three';
import { ViewerService } from './viewer.service';
import { CameraService } from './camera.service';
import { ShadingMode } from '../models/viewport-settings.model';

@Injectable({ providedIn: 'root' })
export class RenderService {
  readonly shadingMode = signal<ShadingMode>('solid');
  readonly darkMode = signal(true);
  readonly meshView = signal(false);

  constructor(
    private readonly viewer: ViewerService,
    private readonly camera: CameraService
  ) {}

  setShadingMode(mode: ShadingMode): void {
    this.shadingMode.set(mode);
    this.viewer.getBodyGroup().traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const mat of materials) {
          if (mat instanceof THREE.MeshStandardMaterial) {
            mat.wireframe = mode === 'wireframe';
            mat.transparent = mode === 'transparent';
            mat.opacity = mode === 'transparent' ? 0.45 : 1;
          }
        }
      }
    });
  }

  toggleMeshView(): void {
    this.setMeshView(!this.meshView());
  }

  setMeshView(enabled: boolean): void {
    this.meshView.set(enabled);
    this.viewer.getBodyGroup().traverse((obj) => {
      if (obj instanceof THREE.LineSegments && obj.userData['isTriangulationWireframe']) {
        obj.visible = enabled;
      }
    });
  }

  toggleDarkMode(): void {
    const next = !this.darkMode();
    this.darkMode.set(next);
    this.viewer.setBackground(next ? 0x1e1f22 : 0xe8e9ec);
  }

  setPixelRatio(ratio: number): void {
    this.viewer.renderer?.setPixelRatio(ratio);
  }

  captureScreenshot(): string | null {
    return this.viewer.captureScreenshot();
  }

  downloadScreenshot(filename = 'cad-viewport.png'): void {
    const dataUrl = this.captureScreenshot();
    if (!dataUrl) return;
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = filename;
    link.click();
  }
}
