import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { ViewerService } from './viewer.service';
import { CadBody } from '../models/cad-body.model';
import { disposeObject3D } from '../utils/disposal.util';

const PICKED_FACE_COLOR = 0xffee00; // matches FilletChamferRendererService's own "you picked this" yellow
const HOVER_FACE_COLOR = 0x2a6fdb; // matches the app-wide selection highlight tint
const FACE_OFFSET = 0.05; // same z-fighting guard SketchRendererService's own highlightFace uses

/**
 * Renders the "ShellOverlay" scene group: one translucent highlight mesh per picked face-to-
 * remove, plus a hover-preview highlight for whatever face is under the cursor before it's
 * picked. Same group-ownership + multi-item shape FilletChamferRendererService already uses for
 * picked edges, just building a face-triangle highlight mesh (same geometry-extraction technique
 * SketchRendererService.highlightFace uses) instead of an edge polyline — a dedicated service
 * rather than reusing SketchRendererService directly, since that service only tracks ONE face
 * highlight at a time (a single sketch plane), while Shell needs several simultaneous picks.
 */
@Injectable({ providedIn: 'root' })
export class ShellRendererService {
  private readonly group = new THREE.Group();
  private initialized = false;

  private pickedMeshes: THREE.Mesh[] = [];
  private hoverMesh: THREE.Mesh | null = null;

  constructor(private readonly viewer: ViewerService) {}

  private ensureInScene(): void {
    if (!this.initialized) {
      this.group.name = 'ShellOverlay';
      this.viewer.scene.add(this.group);
      this.initialized = true;
    }
  }

  private buildFaceHighlight(body: CadBody, faceIndex: number, color: number, opacity: number): THREE.Mesh | null {
    const { geometry, faceIdMap, mesh } = body;
    const index = geometry.index;
    const positionAttr = geometry.attributes['position'];
    const normalAttr = geometry.attributes['normal'];
    if (!index || !positionAttr) return null;

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
    if (positions.length === 0) return null;

    const highlightGeometry = new THREE.BufferGeometry();
    highlightGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    if (normals.length === positions.length) {
      highlightGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    } else {
      highlightGeometry.computeVertexNormals();
    }

    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      side: THREE.DoubleSide
    });

    const highlightMesh = new THREE.Mesh(highlightGeometry, material);
    highlightMesh.renderOrder = 998;
    highlightMesh.applyMatrix4(mesh.matrixWorld);
    if (normals.length >= 3) {
      const n = new THREE.Vector3(normals[0], normals[1], normals[2]).transformDirection(mesh.matrixWorld).normalize();
      highlightMesh.position.addScaledVector(n, FACE_OFFSET);
    }
    return highlightMesh;
  }

  setPickedFaces(picks: { body: CadBody; faceIndex: number }[]): void {
    this.ensureInScene();
    for (const m of this.pickedMeshes) disposeObject3D(m);
    this.pickedMeshes = [];

    for (const { body, faceIndex } of picks) {
      const mesh = this.buildFaceHighlight(body, faceIndex, PICKED_FACE_COLOR, 0.35);
      if (mesh) {
        this.group.add(mesh);
        this.pickedMeshes.push(mesh);
      }
    }
  }

  showHoverFace(body: CadBody | null, faceIndex: number | null): void {
    this.ensureInScene();
    if (this.hoverMesh) {
      disposeObject3D(this.hoverMesh);
      this.hoverMesh = null;
    }
    if (!body || faceIndex == null) return;

    const mesh = this.buildFaceHighlight(body, faceIndex, HOVER_FACE_COLOR, 0.25);
    if (mesh) {
      this.group.add(mesh);
      this.hoverMesh = mesh;
    }
  }

  /** Removes and disposes the whole overlay — called on tool cancel/deactivate/commit. */
  clear(): void {
    for (const m of this.pickedMeshes) disposeObject3D(m);
    this.pickedMeshes = [];
    if (this.hoverMesh) {
      disposeObject3D(this.hoverMesh);
      this.hoverMesh = null;
    }
  }
}
