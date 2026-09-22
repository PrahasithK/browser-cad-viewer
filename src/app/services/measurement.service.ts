import { computed, Injectable, signal } from '@angular/core';
import * as THREE from 'three';
import { ViewerService } from './viewer.service';
import { CadBody } from '../models/cad-body.model';
import { Measurement, MeasureMode, MeasurementPoint } from '../models/measurement.model';
import { generateId } from '../utils/id-generator.util';
import { getFacePlane } from '../utils/face-geometry.util';
import { angleAtVertexDeg, fitCircle, measurePlanes } from '../utils/measure-geometry.util';
import { formatAngle, formatLength } from '../utils/unit-conversion.util';

export interface DimensionLabel {
  id: string;
  text: string;
  x: number;
  y: number;
}

interface PendingFace {
  origin: THREE.Vector3;
  normal: THREE.Vector3;
  bodyId: string;
  faceIndex: number;
}

const MARKER_COLOR = 0xffcc00;
const CIRCLE_SEGMENTS = 64;

@Injectable({ providedIn: 'root' })
export class MeasurementService {
  readonly active = signal(false);
  readonly mode = signal<MeasureMode>('distance');
  /** Points clicked so far for the measurement in progress (distance: 0–1, angle: 0–2). */
  readonly pendingPoints = signal<MeasurementPoint[]>([]);
  /** First face of a face-to-face measurement in progress. */
  readonly pendingFace = signal<PendingFace | null>(null);
  readonly measurements = signal<Measurement[]>([]);
  readonly lastError = signal<string | null>(null);

  /** What the user should do next — one line for the panel. */
  readonly hint = computed(() => {
    const pending = this.pendingPoints().length;
    switch (this.mode()) {
      case 'distance':
        return pending === 0 ? 'Click first point…' : 'Click second point…';
      case 'angle':
        return ['Click first point…', 'Click the vertex (middle point)…', 'Click third point…'][pending] ?? 'Click a point…';
      case 'face':
        return this.pendingFace() ? 'Click the second planar face…' : 'Click a planar face…';
      case 'circle':
        return 'Click a circular edge…';
    }
  });

  private readonly markers = new THREE.Group();
  private initialized = false;

  constructor(private readonly viewer: ViewerService) {}

  private ensureMarkersInScene(): void {
    if (!this.initialized) {
      this.viewer.scene.add(this.markers);
      this.initialized = true;
    }
  }

  toggleActive(): void {
    this.active.set(!this.active());
    this.resetPending();
  }

  setMode(mode: MeasureMode): void {
    this.mode.set(mode);
    this.resetPending();
  }

  private resetPending(): void {
    this.pendingPoints.set([]);
    this.pendingFace.set(null);
    this.lastError.set(null);
  }

  /** Click on a point in space: the 1st/2nd click of a Distance, the 1st/2nd/3rd of an Angle. Ignored in face/circle modes. */
  addPoint(point: MeasurementPoint): void {
    const mode = this.mode();
    if (mode !== 'distance' && mode !== 'angle') return;

    this.ensureMarkersInScene();
    this.lastError.set(null);
    this.addMarker(point.position);
    const points = [...this.pendingPoints(), point];

    if (mode === 'distance') {
      if (points.length < 2) {
        this.pendingPoints.set(points);
        return;
      }
      const [a, b] = points;
      const distance = a.position.distanceTo(b.position);
      this.addLine(a.position, b.position);
      this.commit({
        type: 'distance',
        pointA: a,
        pointB: b,
        distance,
        text: formatLength(distance),
        anchor: a.position.clone().add(b.position).multiplyScalar(0.5)
      });
      return;
    }

    if (points.length < 3) {
      this.pendingPoints.set(points);
      return;
    }
    const [a, vertex, c] = points;
    const angle = angleAtVertexDeg(a.position, vertex.position, c.position);
    this.addLine(vertex.position, a.position);
    this.addLine(vertex.position, c.position);
    if (angle === null) {
      this.pendingPoints.set([]);
      this.lastError.set('The three points must be distinct.');
      return;
    }
    this.commit({ type: 'angle', pointA: a, pointB: c, distance: angle, text: formatAngle(angle), anchor: vertex.position.clone() });
  }

  /** Click on a face in Face mode. Two planar faces: parallel → distance between them, otherwise the angle. */
  addFace(body: CadBody, faceIndex: number): void {
    if (this.mode() !== 'face') return;
    this.ensureMarkersInScene();
    this.lastError.set(null);

    const plane = getFacePlane(body, faceIndex);
    if (!plane) {
      this.lastError.set('That face is not planar — only flat faces can be measured this way.');
      return;
    }

    const first = this.pendingFace();
    if (!first) {
      this.addMarker(plane.origin);
      this.pendingFace.set({ origin: plane.origin.clone(), normal: plane.normal.clone(), bodyId: body.id, faceIndex });
      return;
    }
    if (first.bodyId === body.id && first.faceIndex === faceIndex) {
      this.lastError.set('Pick a second, different face.');
      return;
    }

    this.addMarker(plane.origin);
    const result = measurePlanes(first, plane);
    const pointA: MeasurementPoint = { position: first.origin, bodyId: first.bodyId, faceIndex: first.faceIndex };
    const pointB: MeasurementPoint = { position: plane.origin.clone(), bodyId: body.id, faceIndex };

    if (result.parallel) {
      // Draw the perpendicular between the planes, from the first face's marker.
      const side = Math.sign(plane.origin.clone().sub(first.origin).dot(first.normal)) || 1;
      const foot = first.origin.clone().add(first.normal.clone().normalize().multiplyScalar(side * result.distance));
      this.addLine(first.origin, foot);
      this.commit({
        type: 'distance',
        pointA,
        pointB,
        distance: result.distance,
        text: `${formatLength(result.distance)} (parallel faces)`,
        anchor: first.origin.clone().add(foot).multiplyScalar(0.5)
      });
    } else {
      this.addLine(first.origin, plane.origin);
      this.commit({
        type: 'angle',
        pointA,
        pointB,
        distance: result.angleDeg,
        text: `${formatAngle(result.angleDeg)} between faces`,
        anchor: first.origin.clone().add(plane.origin).multiplyScalar(0.5)
      });
    }
  }

  /** Click on an edge in Circle mode: fits a circle to the edge's sampled points and reports radius and diameter. */
  addCircle(body: CadBody, edgeIndex: number): void {
    if (this.mode() !== 'circle') return;
    this.ensureMarkersInScene();
    this.lastError.set(null);

    const edge = body.edges.find((e) => e.index === edgeIndex);
    if (!edge) {
      this.lastError.set('That edge is not available for measuring.');
      return;
    }
    body.mesh.updateWorldMatrix(true, false);
    const world = edge.points.map((p) => p.clone().applyMatrix4(body.mesh.matrixWorld));
    const fit = fitCircle(world);
    if (!fit) {
      this.lastError.set('That edge is not a circle or a circular arc.');
      return;
    }

    // Draw the fitted circle, its centre, and a radius to the first sample.
    const ring: THREE.Vector3[] = [];
    const u = world[0].clone().sub(fit.center).normalize();
    const v = fit.normal.clone().cross(u);
    for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
      const t = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
      ring.push(fit.center.clone().add(u.clone().multiplyScalar(fit.radius * Math.cos(t))).add(v.clone().multiplyScalar(fit.radius * Math.sin(t))));
    }
    const loop = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(ring),
      new THREE.LineBasicMaterial({ color: MARKER_COLOR, depthTest: false })
    );
    loop.renderOrder = 999;
    this.markers.add(loop);
    this.addMarker(fit.center);
    this.addLine(fit.center, ring[0]);

    this.commit({
      type: 'radius',
      pointA: { position: fit.center.clone(), bodyId: body.id, faceIndex: null },
      pointB: { position: ring[0].clone(), bodyId: body.id, faceIndex: null },
      distance: fit.radius,
      text: `R ${formatLength(fit.radius)}  Ø ${formatLength(fit.radius * 2)}`,
      anchor: fit.center.clone()
    });
  }

  private commit(m: Omit<Measurement, 'id'>): void {
    this.measurements.update((list) => [...list, { id: generateId('measure'), ...m }]);
    this.pendingPoints.set([]);
    this.pendingFace.set(null);
  }

  private addMarker(position: THREE.Vector3): void {
    const geometry = new THREE.SphereGeometry(4, 12, 12);
    const material = new THREE.MeshBasicMaterial({ color: MARKER_COLOR, depthTest: false });
    const sphere = new THREE.Mesh(geometry, material);
    sphere.position.copy(position);
    sphere.renderOrder = 999;
    this.markers.add(sphere);
  }

  private addLine(a: THREE.Vector3, b: THREE.Vector3): void {
    const geometry = new THREE.BufferGeometry().setFromPoints([a, b]);
    const material = new THREE.LineBasicMaterial({ color: MARKER_COLOR, depthTest: false });
    const line = new THREE.Line(geometry, material);
    line.renderOrder = 999;
    this.markers.add(line);
  }

  clear(): void {
    for (const child of [...this.markers.children]) {
      this.markers.remove(child);
      if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }
    this.measurements.set([]);
    this.resetPending();
  }

  lastMeasurement(): Measurement | null {
    const list = this.measurements();
    return list.length > 0 ? list[list.length - 1] : null;
  }

  /**
   * Screen-space label for each committed measurement — the value shown directly in the 3D view at
   * the measurement's anchor, not just in the side panel list. Positions are recomputed by the
   * caller every frame (no camera dependency cached here) so labels track correctly while
   * orbiting/zooming; points behind the camera or off-canvas are filtered out rather than clamped.
   */
  labelPositions(camera: THREE.Camera, canvasRect: { width: number; height: number }): DimensionLabel[] {
    const labels: DimensionLabel[] = [];
    for (const m of this.measurements()) {
      const ndc = m.anchor.clone().project(camera);
      if (ndc.z < -1 || ndc.z > 1) continue; // behind the camera or beyond the far plane

      const x = ((ndc.x + 1) / 2) * canvasRect.width;
      const y = ((1 - ndc.y) / 2) * canvasRect.height;
      if (x < 0 || x > canvasRect.width || y < 0 || y > canvasRect.height) continue;

      labels.push({ id: m.id, text: m.text, x, y });
    }
    return labels;
  }
}
