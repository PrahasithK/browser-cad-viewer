import { Injectable, signal } from '@angular/core';
import * as THREE from 'three';
import { CadBody } from '../models/cad-body.model';
import { MaterialProperties } from '../models/material-properties.model';
import { EngineeringMaterial, findMaterial } from '../models/engineering-material.model';
import { computeMassProperties, MassProperties } from '../utils/mass-properties.util';
import { formatLength } from '../utils/unit-conversion.util';

export interface BodyDimensionLabel {
  id: string;
  text: string;
  x: number;
  y: number;
}

export interface BodyPropertySnapshot {
  body: CadBody;
  position: THREE.Vector3;
  rotationDeg: THREE.Vector3;
  scale: THREE.Vector3;
  material: MaterialProperties;
  /** Volume/centroid/inertia in world space (follows the body's current transform); null for an empty or degenerate mesh. */
  mass: MassProperties | null;
  /** The assigned engineering material, or null when none is assigned. */
  engineeringMaterial: EngineeringMaterial | null;
}

@Injectable({ providedIn: 'root' })
export class PropertyService {
  readonly selectedSnapshot = signal<BodyPropertySnapshot | null>(null);
  /** Bumped by the viewport context menu's "Properties" action; SidePanels watches this (via an effect) to flash its panel header — the only visible feedback available since the panel is always shown, never hidden/collapsed. Plain counter, not a boolean, so repeated clicks each re-trigger the flash even if the previous one hasn't finished. */
  readonly focusPropertiesRequest = signal(0);
  /** Bumped by the viewport context menu's "Rename" action to trigger the same inline-rename UI the tree's own rename control uses, without Viewport needing a direct reference to SidePanels. */
  readonly startRenameRequest = signal(0);

  requestFocusProperties(): void {
    this.focusPropertiesRequest.update((n) => n + 1);
  }

  requestStartRename(): void {
    this.startRenameRequest.update((n) => n + 1);
  }

  showProperties(body: CadBody | null): void {
    if (!body) {
      this.selectedSnapshot.set(null);
      return;
    }

    const mesh = body.mesh;
    const euler = new THREE.Euler().setFromQuaternion(mesh.quaternion);
    const material = mesh.material as THREE.MeshStandardMaterial;

    this.selectedSnapshot.set({
      body,
      position: mesh.position.clone(),
      rotationDeg: new THREE.Vector3(
        THREE.MathUtils.radToDeg(euler.x),
        THREE.MathUtils.radToDeg(euler.y),
        THREE.MathUtils.radToDeg(euler.z)
      ),
      scale: mesh.scale.clone(),
      material: {
        color: `#${material.color.getHexString()}`,
        opacity: material.opacity,
        metalness: material.metalness,
        roughness: material.roughness,
        wireframe: material.wireframe
      },
      mass: this.computeMass(body),
      engineeringMaterial: findMaterial(body.materialId)
    });
  }

  private computeMass(body: CadBody): MassProperties | null {
    body.mesh.updateWorldMatrix(true, false);
    return computeMassProperties(body.geometry, body.mesh.matrixWorld, body.volume);
  }

  /** Assigns (or clears, with null) the engineering material used for mass properties. */
  setMaterial(body: CadBody, materialId: string | null): void {
    body.materialId = materialId ?? undefined;
    this.refresh(body);
  }

  setColor(body: CadBody, hex: string): void {
    const material = body.mesh.material as THREE.MeshStandardMaterial;
    material.color.set(hex);
    body.color = hex;
    this.refresh(body);
  }

  setOpacity(body: CadBody, opacity: number): void {
    const material = body.mesh.material as THREE.MeshStandardMaterial;
    material.opacity = opacity;
    material.transparent = opacity < 1;
    body.opacity = opacity;
    this.refresh(body);
  }

  setVisible(body: CadBody, visible: boolean): void {
    body.mesh.visible = visible;
    body.visible = visible;
    this.refresh(body);
  }

  setPosition(body: CadBody, position: THREE.Vector3): void {
    body.mesh.position.copy(position);
    this.refresh(body);
  }

  /** Re-reads the snapshot after something outside this service mutated the body (e.g. a tree rename). No-op if a different body is selected. */
  refreshIfSelected(body: CadBody): void {
    this.refresh(body);
  }

  clearIfSelected(bodyId: string): void {
    const current = this.selectedSnapshot();
    if (current && current.body.id === bodyId) {
      this.selectedSnapshot.set(null);
    }
  }

  private refresh(body: CadBody): void {
    const current = this.selectedSnapshot();
    if (current && current.body.id === body.id) {
      this.showProperties(body);
    }
  }

  /**
   * Overall Length/Width/Height labels for the selected body, shown directly on the model in the
   * 3D view (not just as bounding-box min/max text in this panel) — one label per world axis,
   * positioned at the midpoint of that axis's bounding-box edge nearest the camera, so it reads
   * as "this edge of the box is this long" rather than floating at the box center. Mirrors
   * MeasurementService.labelPositions' screen-projection approach; empty when nothing is
   * selected, so the caller can render it unconditionally every frame.
   */
  selectedDimensionLabels(camera: THREE.Camera, canvasRect: { width: number; height: number }): BodyDimensionLabel[] {
    const snap = this.selectedSnapshot();
    if (!snap) return [];

    const box = snap.body.boundingBox;
    if (box.isEmpty()) return [];

    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    // For each axis, pick the box corner nearer the camera along the OTHER two axes, so the
    // label sits on a visible/near edge rather than potentially behind the model.
    const camDir = camera.position.clone().sub(center);
    const sign = (v: number): number => (v >= 0 ? 1 : -1);

    const axes: { axis: 'x' | 'y' | 'z'; length: number; midpoint: THREE.Vector3 }[] = [
      {
        axis: 'x',
        length: size.x,
        midpoint: new THREE.Vector3(center.x, center.y + (size.y / 2) * sign(camDir.y), center.z + (size.z / 2) * sign(camDir.z))
      },
      {
        axis: 'y',
        length: size.y,
        midpoint: new THREE.Vector3(center.x + (size.x / 2) * sign(camDir.x), center.y, center.z + (size.z / 2) * sign(camDir.z))
      },
      {
        axis: 'z',
        length: size.z,
        midpoint: new THREE.Vector3(center.x + (size.x / 2) * sign(camDir.x), center.y + (size.y / 2) * sign(camDir.y), center.z)
      }
    ];

    const labels: BodyDimensionLabel[] = [];
    for (const { axis, length, midpoint } of axes) {
      if (length < 1e-6) continue; // degenerate/flat along this axis — nothing meaningful to label

      const ndc = midpoint.project(camera);
      if (ndc.z < -1 || ndc.z > 1) continue;

      const x = ((ndc.x + 1) / 2) * canvasRect.width;
      const y = ((1 - ndc.y) / 2) * canvasRect.height;
      if (x < 0 || x > canvasRect.width || y < 0 || y > canvasRect.height) continue;

      labels.push({ id: `${snap.body.id}-${axis}`, text: formatLength(length), x, y });
    }
    return labels;
  }
}
