import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { ViewerService } from './viewer.service';
import { StructuralModelService } from './structural-model.service';

const NODE_COLOR = 0x44ff88;
const MEMBER_COLOR = 0x4488ff;
const SELECTED_NODE_COLOR = 0xffcc00;

/** Renders the structural model (nodes as points, members as lines) directly into ViewerService's scene, independent of the CAD bodyGroup/TreeService. */
@Injectable({ providedIn: 'root' })
export class StructuralRendererService {
  private readonly group = new THREE.Group();
  private pointsObject: THREE.Points | null = null;
  private lineSegments: THREE.LineSegments | null = null;
  private initialized = false;

  constructor(
    private readonly viewer: ViewerService,
    private readonly model: StructuralModelService
  ) {}

  private ensureInScene(): void {
    if (!this.initialized) {
      this.group.name = 'StructuralModel';
      this.viewer.scene.add(this.group);
      this.initialized = true;
    }
  }

  refresh(selectedNodeId: string | null = null): void {
    this.ensureInScene();
    this.disposeExisting();

    const nodes = this.model.nodes();
    const members = this.model.members();
    const nodeIndex = new Map(nodes.map((n, i) => [n.id, i]));

    const positions = new Float32Array(nodes.length * 3);
    const colors = new Float32Array(nodes.length * 3);
    const selectedColor = new THREE.Color(SELECTED_NODE_COLOR);
    const normalColor = new THREE.Color(NODE_COLOR);
    nodes.forEach((n, i) => {
      positions[i * 3] = n.position[0];
      positions[i * 3 + 1] = n.position[1];
      positions[i * 3 + 2] = n.position[2];
      const c = n.id === selectedNodeId ? selectedColor : normalColor;
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    });

    const pointsGeometry = new THREE.BufferGeometry();
    pointsGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    pointsGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const pointsMaterial = new THREE.PointsMaterial({ size: 10, sizeAttenuation: false, vertexColors: true, depthTest: false });
    this.pointsObject = new THREE.Points(pointsGeometry, pointsMaterial);
    this.pointsObject.renderOrder = 999;
    this.group.add(this.pointsObject);

    const linePositions = new Float32Array(members.length * 6);
    members.forEach((m, i) => {
      const i1 = nodeIndex.get(m.startNodeId);
      const i2 = nodeIndex.get(m.endNodeId);
      if (i1 === undefined || i2 === undefined) return;
      const p1 = nodes[i1].position;
      const p2 = nodes[i2].position;
      linePositions[i * 6] = p1[0];
      linePositions[i * 6 + 1] = p1[1];
      linePositions[i * 6 + 2] = p1[2];
      linePositions[i * 6 + 3] = p2[0];
      linePositions[i * 6 + 4] = p2[1];
      linePositions[i * 6 + 5] = p2[2];
    });
    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));
    const lineMaterial = new THREE.LineBasicMaterial({ color: MEMBER_COLOR, linewidth: 2 });
    this.lineSegments = new THREE.LineSegments(lineGeometry, lineMaterial);
    this.group.add(this.lineSegments);
  }

  getNodeScreenPositions(camera: THREE.Camera): { nodeId: string; x: number; y: number }[] {
    return this.model.nodes().map((node) => {
      const v = new THREE.Vector3(node.position[0], node.position[1], node.position[2]);
      v.project(camera);
      return { nodeId: node.id, x: v.x, y: v.y };
    });
  }

  private disposeExisting(): void {
    if (this.pointsObject) {
      this.group.remove(this.pointsObject);
      this.pointsObject.geometry.dispose();
      (this.pointsObject.material as THREE.Material).dispose();
      this.pointsObject = null;
    }
    if (this.lineSegments) {
      this.group.remove(this.lineSegments);
      this.lineSegments.geometry.dispose();
      (this.lineSegments.material as THREE.Material).dispose();
      this.lineSegments = null;
    }
  }
}
