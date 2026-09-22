import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { ViewerService } from './viewer.service';
import { StructuralModelService } from './structural-model.service';
import { computeLocalAxes } from '../utils/beam-stiffness.util';
import { AnalysisResult } from '../models/structural-result.model';

export type DiagramMode = 'none' | 'deflection' | 'reactions' | 'moment' | 'shear' | 'axial' | 'torsion';

const DEFLECTED_COLOR = 0xffaa00;
const REACTION_COLOR = 0xff4444;
const DIAGRAM_COLOR = 0x22ddaa;

/**
 * v1 diagrams linearly interpolate between each member's recovered end forces. This is EXACT
 * for members with only nodal loads (no distributed load along the span), and a documented
 * simplification for members carrying a UDL (whose true moment/shear shape is quadratic/linear,
 * not straight) — full per-span sampling using the fixed-end-force data is a later increment.
 */
@Injectable({ providedIn: 'root' })
export class StructuralResultsRendererService {
  private readonly group = new THREE.Group();
  private initialized = false;

  constructor(
    private readonly viewer: ViewerService,
    private readonly model: StructuralModelService
  ) {}

  private ensureInScene(): void {
    if (!this.initialized) {
      this.group.name = 'StructuralResults';
      this.viewer.scene.add(this.group);
      this.initialized = true;
    }
  }

  clear(): void {
    this.ensureInScene();
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      if (child instanceof THREE.Line || child instanceof THREE.LineSegments) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }
  }

  render(result: AnalysisResult | null, mode: DiagramMode, deflectionScale: number): void {
    this.ensureInScene();
    this.clear();
    if (!result || mode === 'none') return;

    if (mode === 'deflection') {
      this.renderDeflection(result, deflectionScale);
      return;
    }
    if (mode === 'reactions') {
      this.renderReactions(result);
      return;
    }
    this.renderForceDiagram(result, mode);
  }

  private renderDeflection(result: AnalysisResult, scale: number): void {
    const nodes = this.model.nodes();
    const members = this.model.members();
    const nodeIndex = new Map(nodes.map((n, i) => [n.id, i]));
    const dispByNode = new Map(result.displacements.map((d) => [d.nodeId, d]));

    const positions = new Float32Array(members.length * 6);
    members.forEach((m, i) => {
      const i1 = nodeIndex.get(m.startNodeId);
      const i2 = nodeIndex.get(m.endNodeId);
      if (i1 === undefined || i2 === undefined) return;
      const p1 = nodes[i1].position;
      const p2 = nodes[i2].position;
      const d1 = dispByNode.get(m.startNodeId)?.translation ?? [0, 0, 0];
      const d2 = dispByNode.get(m.endNodeId)?.translation ?? [0, 0, 0];
      positions[i * 6] = p1[0] + d1[0] * scale;
      positions[i * 6 + 1] = p1[1] + d1[1] * scale;
      positions[i * 6 + 2] = p1[2] + d1[2] * scale;
      positions[i * 6 + 3] = p2[0] + d2[0] * scale;
      positions[i * 6 + 4] = p2[1] + d2[1] * scale;
      positions[i * 6 + 5] = p2[2] + d2[2] * scale;
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({ color: DEFLECTED_COLOR });
    const lines = new THREE.LineSegments(geometry, material);
    this.group.add(lines);
  }

  private renderReactions(result: AnalysisResult): void {
    const nodes = this.model.nodes();
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const maxForce = Math.max(1e-6, ...result.reactions.map((r) => Math.hypot(...r.force)));
    const arrowLength = this.autoScaleLength();

    for (const reaction of result.reactions) {
      const node = nodeById.get(reaction.nodeId);
      if (!node) continue;
      const magnitude = Math.hypot(...reaction.force);
      if (magnitude < 1e-9) continue;
      const dir = new THREE.Vector3(...reaction.force).normalize();
      const origin = new THREE.Vector3(...node.position);
      const length = (magnitude / maxForce) * arrowLength;
      const arrow = new THREE.ArrowHelper(dir, origin, length, REACTION_COLOR, length * 0.25, length * 0.15);
      this.group.add(arrow);
    }
  }

  /** Offset diagrams perpendicular to each member, using the member's local axes so a moment/shear about a given axis draws in its own bending plane. */
  private renderForceDiagram(result: AnalysisResult, mode: DiagramMode): void {
    const nodes = this.model.nodes();
    const members = this.model.members();
    const nodeIndex = new Map(nodes.map((n, i) => [n.id, i]));
    const forcesByMember = new Map(result.memberForces.map((f) => [f.memberId, f]));

    const componentIndex: Record<'moment' | 'shear' | 'axial' | 'torsion', number> = {
      axial: 0,
      shear: 1,
      torsion: 3,
      moment: 5
    };
    const idx = componentIndex[mode as 'moment' | 'shear' | 'axial' | 'torsion'];
    if (idx === undefined) return;

    const allValues = members.flatMap((m) => {
      const f = forcesByMember.get(m.id);
      return f ? [Math.abs(f.start[idx]), Math.abs(f.end[idx])] : [];
    });
    const maxValue = Math.max(1e-6, ...allValues);
    const offsetScale = this.autoScaleLength() / maxValue;

    const positions: number[] = [];
    for (const member of members) {
      const i1 = nodeIndex.get(member.startNodeId);
      const i2 = nodeIndex.get(member.endNodeId);
      const forces = forcesByMember.get(member.id);
      if (i1 === undefined || i2 === undefined || !forces) continue;

      const p1 = new THREE.Vector3(...nodes[i1].position);
      const p2 = new THREE.Vector3(...nodes[i2].position);
      const axes = computeLocalAxes(nodes[i1].position, nodes[i2].position, member.betaAngle);
      const offsetDir = new THREE.Vector3(...(idx === 2 || idx === 4 ? axes.ez : axes.ey));

      const vStart = forces.start[idx] * offsetScale;
      const vEnd = -forces.end[idx] * offsetScale;
      const o1 = p1.clone().addScaledVector(offsetDir, vStart);
      const o2 = p2.clone().addScaledVector(offsetDir, vEnd);

      positions.push(p1.x, p1.y, p1.z, o1.x, o1.y, o1.z);
      positions.push(o1.x, o1.y, o1.z, o2.x, o2.y, o2.z);
      positions.push(o2.x, o2.y, o2.z, p2.x, p2.y, p2.z);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    const material = new THREE.LineBasicMaterial({ color: DIAGRAM_COLOR });
    const lines = new THREE.LineSegments(geometry, material);
    this.group.add(lines);
  }

  private autoScaleLength(): number {
    const nodes = this.model.nodes();
    if (nodes.length < 2) return 1;
    const box = new THREE.Box3();
    for (const n of nodes) box.expandByPoint(new THREE.Vector3(...n.position));
    const size = box.getSize(new THREE.Vector3());
    return Math.max(size.x, size.y, size.z, 1) * 0.15;
  }
}
