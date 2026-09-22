import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { ViewerService } from './viewer.service';
import { CadBody } from '../models/cad-body.model';
import { FaceReferencePoint, FaceReferencePointKind } from '../models/sketch.model';
import { SketchEntity } from '../workers/step-worker-messages.model';
import { disposeObject3D } from '../utils/disposal.util';

const HIGHLIGHT_COLOR = 0x2a6fdb; // matches SelectionService's existing highlight tint
const REFERENCE_COLORS: Record<FaceReferencePointKind, THREE.Color> = {
  vertex: new THREE.Color(0xffa500),
  midpoint: new THREE.Color(0x22ddaa),
  'circle-center': new THREE.Color(0xff4488),
  intersection: new THREE.Color(0xffffff)
};
const SNAP_INDICATOR_COLOR = 0xffee00;
const PREVIEW_COLOR = 0x2a6fdb;
const FACE_OFFSET = 0.05; // small offset along the normal, avoids z-fighting with the body's own material

interface PlaneBasis {
  origin: THREE.Vector3;
  uAxis: THREE.Vector3;
  vAxis: THREE.Vector3;
}

/**
 * Owns the "SketchOverlay" scene group: the picked face's highlight, its reference-point
 * markers, the live snap indicator, and the in-progress shape preview. Mirrors
 * BridgeMeshRendererService/StructuralRendererService's group-ownership shape — nothing else
 * in the app draws sketch state into the scene, and this needs frequent rebuilds through the
 * whole drawing phase (pointermove-driven), which is why it's a dedicated service rather than
 * folded into SketchService (kept scene-agnostic) or SelectionService (whole-mesh, transient
 * highlight — a different concern from a single-face overlay).
 */
@Injectable({ providedIn: 'root' })
export class SketchRendererService {
  private readonly group = new THREE.Group();
  private initialized = false;

  private faceHighlight: THREE.Mesh | null = null;
  private referencePoints: THREE.Points | null = null;
  private snapIndicator: THREE.Mesh | null = null;
  private previewEntity: THREE.Object3D | null = null;

  constructor(private readonly viewer: ViewerService) {}

  private ensureInScene(): void {
    if (!this.initialized) {
      this.group.name = 'SketchOverlay';
      this.viewer.scene.add(this.group);
      this.initialized = true;
    }
  }

  /** Builds a small highlight overlay mesh from just the triangles matching faceIndex — not a whole-mesh tint. */
  highlightFace(body: CadBody, faceIndex: number): void {
    this.ensureInScene();
    this.clearFaceHighlight();

    const { geometry, faceIdMap, mesh } = body;
    const index = geometry.index;
    const positionAttr = geometry.attributes['position'];
    const normalAttr = geometry.attributes['normal'];
    if (!index || !positionAttr) return;

    const positions: number[] = [];
    const normals: number[] = [];
    for (let t = 0; t < faceIdMap.length; t++) {
      if (faceIdMap[t] !== faceIndex) continue;
      for (let k = 0; k < 3; k++) {
        const vi = index.getX(t * 3 + k);
        positions.push(positionAttr.getX(vi), positionAttr.getY(vi), positionAttr.getZ(vi));
        if (normalAttr) {
          normals.push(normalAttr.getX(vi), normalAttr.getY(vi), normalAttr.getZ(vi));
        }
      }
    }
    if (positions.length === 0) return;

    const highlightGeometry = new THREE.BufferGeometry();
    highlightGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    if (normals.length === positions.length) {
      highlightGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    } else {
      highlightGeometry.computeVertexNormals();
    }

    const material = new THREE.MeshBasicMaterial({
      color: HIGHLIGHT_COLOR,
      transparent: true,
      opacity: 0.35,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      side: THREE.DoubleSide
    });

    this.faceHighlight = new THREE.Mesh(highlightGeometry, material);
    this.faceHighlight.renderOrder = 998;
    this.faceHighlight.applyMatrix4(mesh.matrixWorld);
    // Nudge slightly along the world-space face normal (approximated from the first triangle)
    // as a second z-fighting guard on top of polygonOffset.
    if (normals.length >= 3) {
      const n = new THREE.Vector3(normals[0], normals[1], normals[2]).transformDirection(mesh.matrixWorld).normalize();
      this.faceHighlight.position.addScaledVector(n, FACE_OFFSET);
    }
    this.group.add(this.faceHighlight);
  }

  showReferencePoints(points: FaceReferencePoint[]): void {
    this.ensureInScene();
    this.clearReferencePoints();
    if (points.length === 0) return;

    const positions = new Float32Array(points.length * 3);
    const colors = new Float32Array(points.length * 3);
    points.forEach((p, i) => {
      positions[i * 3] = p.position[0];
      positions[i * 3 + 1] = p.position[1];
      positions[i * 3 + 2] = p.position[2];
      const color = REFERENCE_COLORS[p.kind];
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: 7,
      sizeAttenuation: false,
      vertexColors: true,
      depthTest: false
    });

    this.referencePoints = new THREE.Points(geometry, material);
    this.referencePoints.renderOrder = 999;
    this.group.add(this.referencePoints);
  }

  showSnapIndicator(point: THREE.Vector3 | null): void {
    this.ensureInScene();
    this.clearSnapIndicator();
    if (!point) return;

    const geometry = new THREE.RingGeometry(3, 5, 24);
    const material = new THREE.MeshBasicMaterial({ color: SNAP_INDICATOR_COLOR, side: THREE.DoubleSide, depthTest: false });
    this.snapIndicator = new THREE.Mesh(geometry, material);
    this.snapIndicator.renderOrder = 1000;
    this.snapIndicator.position.copy(point);
    this.group.add(this.snapIndicator);
  }

  /** Projects local (u,v) entity points to world space via the plane basis and draws the in-progress shape outline. */
  showPreview(entities: SketchEntity[] | null, plane: PlaneBasis): void {
    this.ensureInScene();
    this.clearPreview();
    if (!entities || entities.length === 0) return;

    const toWorld = (uv: [number, number]): THREE.Vector3 =>
      plane.origin.clone().addScaledVector(plane.uAxis, uv[0]).addScaledVector(plane.vAxis, uv[1]);

    const segments: THREE.Vector3[] = [];
    for (const entity of entities) {
      if (entity.type === 'line') {
        segments.push(toWorld(entity.points[0]), toWorld(entity.points[1]));
      } else if (entity.type === 'circle') {
        this.pushCircleSegments(segments, toWorld, entity.center, entity.radius);
      } else if (entity.type === 'polygon') {
        this.pushPolygonSegments(segments, toWorld, entity.center, entity.radius, entity.sides);
      } else if (entity.type === 'slot') {
        // Slot preview approximated as its two endpoints' connecting segment — good enough for
        // Phase 1 live feedback; the committed geometry (worker-side) is the real slot shape.
        segments.push(toWorld(entity.start), toWorld(entity.end));
      }
    }
    if (segments.length === 0) return;

    const geometry = new THREE.BufferGeometry().setFromPoints(segments);
    const material = new THREE.LineBasicMaterial({ color: PREVIEW_COLOR, depthTest: false });
    this.previewEntity = new THREE.LineSegments(geometry, material);
    this.previewEntity.renderOrder = 999;
    this.group.add(this.previewEntity);
  }

  private pushCircleSegments(out: THREE.Vector3[], toWorld: (uv: [number, number]) => THREE.Vector3, center: [number, number], radius: number): void {
    const SEGMENTS = 48;
    for (let i = 0; i < SEGMENTS; i++) {
      const a0 = (i / SEGMENTS) * Math.PI * 2;
      const a1 = ((i + 1) / SEGMENTS) * Math.PI * 2;
      out.push(
        toWorld([center[0] + radius * Math.cos(a0), center[1] + radius * Math.sin(a0)]),
        toWorld([center[0] + radius * Math.cos(a1), center[1] + radius * Math.sin(a1)])
      );
    }
  }

  private pushPolygonSegments(
    out: THREE.Vector3[],
    toWorld: (uv: [number, number]) => THREE.Vector3,
    center: [number, number],
    radius: number,
    sides: number
  ): void {
    const n = Math.max(3, Math.round(sides));
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2 - Math.PI / 2;
      const a1 = ((i + 1) / n) * Math.PI * 2 - Math.PI / 2;
      out.push(
        toWorld([center[0] + radius * Math.cos(a0), center[1] + radius * Math.sin(a0)]),
        toWorld([center[0] + radius * Math.cos(a1), center[1] + radius * Math.sin(a1)])
      );
    }
  }

  private clearFaceHighlight(): void {
    if (this.faceHighlight) {
      disposeObject3D(this.faceHighlight);
      this.faceHighlight = null;
    }
  }

  private clearReferencePoints(): void {
    if (this.referencePoints) {
      this.group.remove(this.referencePoints);
      this.referencePoints.geometry.dispose();
      (this.referencePoints.material as THREE.Material).dispose();
      this.referencePoints = null;
    }
  }

  private clearSnapIndicator(): void {
    if (this.snapIndicator) {
      disposeObject3D(this.snapIndicator);
      this.snapIndicator = null;
    }
  }

  private clearPreview(): void {
    if (this.previewEntity) {
      disposeObject3D(this.previewEntity);
      this.previewEntity = null;
    }
  }

  /** Removes and disposes the whole overlay — called on sketch cancel/close and before re-entering on a different face. */
  clear(): void {
    this.clearFaceHighlight();
    this.clearReferencePoints();
    this.clearSnapIndicator();
    this.clearPreview();
  }
}
