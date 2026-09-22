import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { ViewerService } from './viewer.service';
import { BridgeMeshResult } from '../utils/bridge-mesh.util';

const SURFACE_COLOR = 0x22ddaa;
const WIREFRAME_COLOR = 0x0a3d33;

/** Renders the generated bridge mesh (translucent surface + overlaid wireframe) directly into ViewerService's scene, independent of the CAD bodyGroup/TreeService. */
@Injectable({ providedIn: 'root' })
export class BridgeMeshRendererService {
  private readonly group = new THREE.Group();
  private surfaceMesh: THREE.Mesh | null = null;
  private wireframe: THREE.LineSegments | null = null;
  private initialized = false;

  constructor(private readonly viewer: ViewerService) {}

  private ensureInScene(): void {
    if (!this.initialized) {
      this.group.name = 'BridgeMesh';
      this.viewer.scene.add(this.group);
      this.initialized = true;
    }
  }

  render(result: BridgeMeshResult): void {
    this.ensureInScene();
    this.clear();

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(result.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(result.indices, 1));
    geometry.computeVertexNormals();

    const material = new THREE.MeshStandardMaterial({
      color: SURFACE_COLOR,
      metalness: 0.1,
      roughness: 0.6,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    this.surfaceMesh = new THREE.Mesh(geometry, material);
    this.group.add(this.surfaceMesh);

    const wireframeGeometry = new THREE.WireframeGeometry(geometry);
    const wireframeMaterial = new THREE.LineBasicMaterial({ color: WIREFRAME_COLOR });
    this.wireframe = new THREE.LineSegments(wireframeGeometry, wireframeMaterial);
    this.group.add(this.wireframe);
  }

  clear(): void {
    if (this.surfaceMesh) {
      this.group.remove(this.surfaceMesh);
      this.surfaceMesh.geometry.dispose();
      (this.surfaceMesh.material as THREE.Material).dispose();
      this.surfaceMesh = null;
    }
    if (this.wireframe) {
      this.group.remove(this.wireframe);
      this.wireframe.geometry.dispose();
      (this.wireframe.material as THREE.Material).dispose();
      this.wireframe = null;
    }
  }
}
