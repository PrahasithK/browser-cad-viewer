import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { ViewerService } from './viewer.service';
import { CadBody } from '../models/cad-body.model';
import { disposeObject3D } from '../utils/disposal.util';

const PICKED_EDGE_COLOR = 0xffee00; // matches SketchRendererService's snap-indicator yellow — same "you selected this" convention
const HOVER_EDGE_COLOR = 0x2a6fdb; // matches the app-wide selection highlight tint

/**
 * Renders the "FilletChamferOverlay" scene group: a thick highlighted line per picked edge, plus
 * a single hover-preview line for whatever edge is currently under the cursor before it's picked.
 * Same group-ownership shape as SketchRendererService/BridgeMeshRendererService — a dedicated
 * service because this needs frequent hover-driven rebuilds (pointermove), which FilletChamferTool
 * Service (kept scene-agnostic, matching every other *ToolService in this app) shouldn't own.
 */
@Injectable({ providedIn: 'root' })
export class FilletChamferRendererService {
  private readonly group = new THREE.Group();
  private initialized = false;

  private pickedLines: THREE.Line[] = [];
  private hoverLine: THREE.Line | null = null;

  constructor(private readonly viewer: ViewerService) {}

  private ensureInScene(): void {
    if (!this.initialized) {
      this.group.name = 'FilletChamferOverlay';
      this.viewer.scene.add(this.group);
      this.initialized = true;
    }
  }

  private buildLine(body: CadBody, edgeIndex: number, color: number, opacity: number): THREE.Line | null {
    const edge = body.edges.find((e) => e.index === edgeIndex);
    if (!edge || edge.points.length === 0) return null;

    const geometry = new THREE.BufferGeometry().setFromPoints(edge.points);
    const material = new THREE.LineBasicMaterial({ color, linewidth: 3, transparent: true, opacity, depthTest: false });
    const line = new THREE.Line(geometry, material);
    line.applyMatrix4(body.mesh.matrixWorld);
    line.renderOrder = 999;
    return line;
  }

  setPickedEdges(picks: { body: CadBody; edgeIndex: number }[]): void {
    this.ensureInScene();
    for (const line of this.pickedLines) disposeObject3D(line);
    this.pickedLines = [];

    for (const { body, edgeIndex } of picks) {
      const line = this.buildLine(body, edgeIndex, PICKED_EDGE_COLOR, 0.95);
      if (line) {
        this.group.add(line);
        this.pickedLines.push(line);
      }
    }
  }

  showHoverEdge(body: CadBody | null, edgeIndex: number | null): void {
    this.ensureInScene();
    if (this.hoverLine) {
      disposeObject3D(this.hoverLine);
      this.hoverLine = null;
    }
    if (!body || edgeIndex == null) return;

    const line = this.buildLine(body, edgeIndex, HOVER_EDGE_COLOR, 0.7);
    if (line) {
      this.group.add(line);
      this.hoverLine = line;
    }
  }

  /** Removes and disposes the whole overlay — called on tool cancel/deactivate/commit. */
  clear(): void {
    for (const line of this.pickedLines) disposeObject3D(line);
    this.pickedLines = [];
    if (this.hoverLine) {
      disposeObject3D(this.hoverLine);
      this.hoverLine = null;
    }
  }
}
