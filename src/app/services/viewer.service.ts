import { Injectable, signal } from '@angular/core';
import * as THREE from 'three';
import { disposeObject3D } from '../utils/disposal.util';

@Injectable({ providedIn: 'root' })
export class ViewerService {
  readonly scene = new THREE.Scene();
  readonly clock = new THREE.Clock();

  renderer: THREE.WebGLRenderer | null = null;
  canvas: HTMLCanvasElement | null = null;

  readonly activeCamera = signal<THREE.Camera | null>(null);
  readonly ready = signal(false);
  /** Rolling-average FPS, updated once per second from render-loop frame timestamps — cheap perf visibility in the status bar, not a profiling tool. */
  readonly fps = signal(0);
  /** World-space X/Y/Z under the cursor, updated by Viewport's pointermove handler — status-bar display, shared here (like activeCamera/ready) since both Viewport and AppChrome need it. */
  readonly cursorWorldPos = signal<THREE.Vector3 | null>(null);

  private readonly bodyGroup = new THREE.Group();
  private gridHelper: THREE.GridHelper | null = null;
  private axesHelper: THREE.AxesHelper | null = null;
  private ambientLight!: THREE.AmbientLight;
  private directionalLight!: THREE.DirectionalLight;
  private hemiLight!: THREE.HemisphereLight;
  private animationHandle: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private readonly frameCallbacks = new Set<() => void>();
  private frameCountSinceLastFpsSample = 0;
  private lastFpsSampleTime = 0;

  init(canvas: HTMLCanvasElement, container: HTMLElement): void {
    this.canvas = canvas;

    this.scene.background = new THREE.Color(0x1e1f22);
    this.bodyGroup.name = 'ImportedBodies';
    this.scene.add(this.bodyGroup);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.localClippingEnabled = true;

    this.setupLighting();
    this.setupGrid();
    this.setupAxes();
    this.resizeToContainer(container);

    this.resizeObserver = new ResizeObserver(() => this.resizeToContainer(container));
    this.resizeObserver.observe(container);

    this.ready.set(true);
    this.startRenderLoop();
  }

  private setupLighting(): void {
    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.35);
    this.scene.add(this.ambientLight);

    this.hemiLight = new THREE.HemisphereLight(0xcfe0ff, 0x33352e, 0.5);
    this.scene.add(this.hemiLight);

    this.directionalLight = new THREE.DirectionalLight(0xffffff, 1.4);
    this.directionalLight.position.set(500, -800, 900);
    this.directionalLight.castShadow = true;
    this.directionalLight.shadow.mapSize.set(2048, 2048);
    this.directionalLight.shadow.bias = -0.0005;
    this.scene.add(this.directionalLight);
    this.scene.add(this.directionalLight.target);
  }

  private setupGrid(): void {
    this.gridHelper = new THREE.GridHelper(2000, 40, 0x4a4d55, 0x33353a);
    this.gridHelper.rotation.x = Math.PI / 2; // XY ground plane (Z-up)
    this.scene.add(this.gridHelper);
  }

  private setupAxes(): void {
    this.axesHelper = new THREE.AxesHelper(300);
    this.scene.add(this.axesHelper);
  }

  setGridVisible(visible: boolean): void {
    if (this.gridHelper) this.gridHelper.visible = visible;
  }

  setAxesVisible(visible: boolean): void {
    if (this.axesHelper) this.axesHelper.visible = visible;
  }

  setBackground(color: number): void {
    this.scene.background = new THREE.Color(color);
  }

  setActiveCamera(camera: THREE.Camera): void {
    this.activeCamera.set(camera);
  }

  addBody(mesh: THREE.Mesh): void {
    this.bodyGroup.add(mesh);
  }

  removeBody(mesh: THREE.Mesh): void {
    disposeObject3D(mesh);
  }

  clearBodies(): void {
    for (const child of [...this.bodyGroup.children]) {
      disposeObject3D(child);
    }
  }

  getBodyGroup(): THREE.Group {
    return this.bodyGroup;
  }

  onFrame(callback: () => void): () => void {
    this.frameCallbacks.add(callback);
    return () => this.frameCallbacks.delete(callback);
  }

  private resizeToContainer(container: HTMLElement): void {
    if (!this.renderer) return;
    const width = container.clientWidth || 1;
    const height = container.clientHeight || 1;
    this.renderer.setSize(width, height, false);

    const camera = this.activeCamera();
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    } else if (camera instanceof THREE.OrthographicCamera) {
      const aspect = width / height;
      const frustumHeight = camera.top - camera.bottom;
      camera.left = (-frustumHeight * aspect) / 2;
      camera.right = (frustumHeight * aspect) / 2;
      camera.updateProjectionMatrix();
    }
  }

  private startRenderLoop(): void {
    this.lastFpsSampleTime = performance.now();
    const tick = (now: number) => {
      this.animationHandle = requestAnimationFrame(tick);
      for (const cb of this.frameCallbacks) cb();
      const camera = this.activeCamera();
      if (this.renderer && camera) {
        this.renderer.render(this.scene, camera);
      }
      this.sampleFps(now);
    };
    requestAnimationFrame(tick);
  }

  /** Updates the `fps` signal once per second (not every frame — a signal write every frame would itself cost perf and the number would be unreadable at 60Hz). */
  private sampleFps(now: number): void {
    this.frameCountSinceLastFpsSample++;
    const elapsed = now - this.lastFpsSampleTime;
    if (elapsed >= 1000) {
      this.fps.set(Math.round((this.frameCountSinceLastFpsSample * 1000) / elapsed));
      this.frameCountSinceLastFpsSample = 0;
      this.lastFpsSampleTime = now;
    }
  }

  captureScreenshot(): string | null {
    if (!this.renderer) return null;
    const camera = this.activeCamera();
    if (camera) this.renderer.render(this.scene, camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  dispose(): void {
    if (this.animationHandle !== null) cancelAnimationFrame(this.animationHandle);
    this.resizeObserver?.disconnect();
    this.clearBodies();
    this.renderer?.dispose();
    this.ready.set(false);
  }
}
