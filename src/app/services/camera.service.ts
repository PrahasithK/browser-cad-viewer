import { Injectable, signal } from '@angular/core';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ViewerService } from './viewer.service';
import { boxUnion } from '../utils/geometry-math.util';
import { CameraProjection, ViewportSettings } from '../models/viewport-settings.model';
import { ViewPreset, VIEW_PRESET_VECTORS } from '../models/view-preset.model';

const FRUSTUM_SIZE = 1000;

@Injectable({ providedIn: 'root' })
export class CameraService {
  perspectiveCamera!: THREE.PerspectiveCamera;
  orthographicCamera!: THREE.OrthographicCamera;
  controls: OrbitControls | null = null;

  readonly projection = signal<CameraProjection>('perspective');

  private animationHandle: number | null = null;

  constructor(private readonly viewer: ViewerService) {}

  init(canvas: HTMLCanvasElement, container: HTMLElement): void {
    const aspect = (container.clientWidth || 1) / (container.clientHeight || 1);

    this.perspectiveCamera = new THREE.PerspectiveCamera(45, aspect, 0.1, 100000);
    this.perspectiveCamera.up.set(0, 0, 1);
    this.perspectiveCamera.position.set(800, -1200, 900);

    this.orthographicCamera = new THREE.OrthographicCamera(
      (-FRUSTUM_SIZE * aspect) / 2,
      (FRUSTUM_SIZE * aspect) / 2,
      FRUSTUM_SIZE / 2,
      -FRUSTUM_SIZE / 2,
      0.1,
      100000
    );
    this.orthographicCamera.up.set(0, 0, 1);
    this.orthographicCamera.position.set(800, -1200, 900);

    this.controls = new OrbitControls(this.perspectiveCamera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.controls.zoomSpeed = 1.0;
    this.controls.target.set(0, 0, 0);
    // CAD-standard mouse scheme: middle-drag pans (three.js defaults MIDDLE to dolly/zoom-drag,
    // which duplicates the scroll wheel and leaves no button for pan). Right-click is intentionally
    // left off this map (disabled, not remapped) — Viewport's own `onContextMenu` already owns
    // right-click for the custom context menu; giving OrbitControls the right button too would
    // fight it for the same input. Left stays ROTATE (default) — click-vs-drag is already
    // disambiguated by Viewport's own pointerdown/click delta-threshold check.
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: null };
    this.controls.update();

    this.viewer.setActiveCamera(this.perspectiveCamera);
    this.viewer.onFrame(() => this.controls?.update());
  }

  setProjection(mode: CameraProjection): void {
    if (!this.controls) return;
    const from = this.controls.object as THREE.Camera;
    const to = mode === 'perspective' ? this.perspectiveCamera : this.orthographicCamera;
    to.position.copy(from.position);
    to.up.copy(from.up);
    this.controls.object = to;
    this.controls.target.copy(this.controls.target);
    this.controls.update();
    this.viewer.setActiveCamera(to);
    this.projection.set(mode);
  }

  getActiveCamera(): THREE.Camera {
    return this.controls?.object ?? this.perspectiveCamera;
  }

  fitAll(padding = 1.3): void {
    const box = boxUnion(
      this.viewer
        .getBodyGroup()
        .children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh)
        .map((mesh) => new THREE.Box3().setFromObject(mesh))
    );
    if (box.isEmpty()) return;
    this.fitToBox(box, padding);
  }

  fitToBox(box: THREE.Box3, padding = 1.3): void {
    if (!this.controls) return;
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);

    const maxDim = Math.max(size.x, size.y, size.z, 1);
    const camera = this.getActiveCamera();

    const direction = camera.position.clone().sub(this.controls.target).normalize();
    if (direction.lengthSq() < 1e-6) direction.set(1, -1, 1).normalize();

    if (camera instanceof THREE.PerspectiveCamera) {
      const fovRad = (camera.fov * Math.PI) / 180;
      const distance = (maxDim * padding) / 2 / Math.tan(fovRad / 2);
      camera.position.copy(center.clone().add(direction.multiplyScalar(distance)));
      camera.near = Math.max(distance / 1000, 0.1);
      camera.far = distance * 1000;
      camera.updateProjectionMatrix();
    } else if (camera instanceof THREE.OrthographicCamera) {
      const distance = maxDim * padding * 2;
      camera.position.copy(center.clone().add(direction.multiplyScalar(distance)));
      const aspect = (camera.right - camera.left) / (camera.top - camera.bottom);
      const half = (maxDim * padding) / 2;
      camera.left = -half * aspect;
      camera.right = half * aspect;
      camera.top = half;
      camera.bottom = -half;
      camera.near = 0.1;
      camera.far = distance * 1000;
      camera.updateProjectionMatrix();
    }

    this.controls.target.copy(center);
    this.controls.update();
  }

  resetCamera(): void {
    this.animateTo(new THREE.Vector3(800, -1200, 900), new THREE.Vector3(0, 0, 0));
  }

  /**
   * Animates the camera to look normal to a picked sketch face — used when entering
   * face-based sketch mode. Distance is derived from the picked body's own bounding box
   * (not the whole scene) via the same maxDim/fov framing math as fitToBox. The look-at
   * target is the box center projected onto the plane, which frames the visible face better
   * than its raw local origin when that origin sits off to one side of the geometry.
   */
  animateToFace(origin: THREE.Vector3, normal: THREE.Vector3, bodyBox: THREE.Box3): void {
    const size = bodyBox.isEmpty() ? new THREE.Vector3(100, 100, 100) : bodyBox.getSize(new THREE.Vector3());
    const boxCenter = bodyBox.isEmpty() ? origin.clone() : bodyBox.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1);

    // Project the box center onto the sketch plane so the look-at target sits on the plane
    // even when the face's own local origin is off-center relative to the visible geometry.
    const toCenter = boxCenter.clone().sub(origin);
    const lookAt = origin.clone().add(toCenter.sub(normal.clone().multiplyScalar(toCenter.dot(normal))));

    const camera = this.getActiveCamera();
    let distance: number;
    if (camera instanceof THREE.PerspectiveCamera) {
      const fovRad = (camera.fov * Math.PI) / 180;
      distance = (maxDim * 1.6) / 2 / Math.tan(fovRad / 2);
    } else {
      distance = maxDim * 1.6 * 2;
    }

    const targetPosition = lookAt.clone().add(normal.clone().multiplyScalar(distance));
    this.animateTo(targetPosition, lookAt, this.faceUpVector(normal));
  }

  /** Stable up-vector for an arbitrary sketch-plane normal: falls back near the Z pole (the camera's own default up axis) to avoid a degenerate/unstable orientation. */
  private faceUpVector(normal: THREE.Vector3): THREE.Vector3 {
    const worldZ = new THREE.Vector3(0, 0, 1);
    if (Math.abs(normal.dot(worldZ)) > 0.99) {
      return new THREE.Vector3(0, 1, 0);
    }
    return worldZ.clone().sub(normal.clone().multiplyScalar(worldZ.dot(normal))).normalize();
  }

  applyViewPreset(preset: ViewPreset): void {
    const box = boxUnion(
      this.viewer
        .getBodyGroup()
        .children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh)
        .map((mesh) => new THREE.Box3().setFromObject(mesh))
    );
    const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    const size = box.isEmpty() ? new THREE.Vector3(1000, 1000, 1000) : box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1) * 2.5;

    const preset3 = VIEW_PRESET_VECTORS[preset];
    const dir = new THREE.Vector3(...preset3.position).normalize();
    const target = center.clone().add(dir.multiplyScalar(maxDim));

    this.animateTo(target, center, new THREE.Vector3(...preset3.up));
  }

  private animateTo(targetPosition: THREE.Vector3, targetLookAt: THREE.Vector3, up?: THREE.Vector3): void {
    if (!this.controls) return;
    const camera = this.getActiveCamera();
    const startPos = camera.position.clone();
    const startTarget = this.controls.target.clone();
    const startUp = camera.up.clone();
    const endUp = up ?? startUp;

    if (this.animationHandle !== null) cancelAnimationFrame(this.animationHandle);

    const duration = 450;
    const startTime = performance.now();

    const step = (now: number) => {
      const t = Math.min((now - startTime) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);

      camera.position.lerpVectors(startPos, targetPosition, eased);
      this.controls!.target.lerpVectors(startTarget, targetLookAt, eased);
      camera.up.lerpVectors(startUp, endUp, eased).normalize();
      this.controls!.update();

      if (t < 1) {
        this.animationHandle = requestAnimationFrame(step);
      } else {
        this.animationHandle = null;
      }
    };
    this.animationHandle = requestAnimationFrame(step);
  }

  resize(container: HTMLElement): void {
    const aspect = (container.clientWidth || 1) / (container.clientHeight || 1);
    this.perspectiveCamera.aspect = aspect;
    this.perspectiveCamera.updateProjectionMatrix();

    const frustumHeight = this.orthographicCamera.top - this.orthographicCamera.bottom;
    this.orthographicCamera.left = (-frustumHeight * aspect) / 2;
    this.orthographicCamera.right = (frustumHeight * aspect) / 2;
    this.orthographicCamera.updateProjectionMatrix();
  }
}
