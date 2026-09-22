import { Injectable, signal } from '@angular/core';
import { StructuralNode, Member, Section, Material, Support, DofRestraints } from '../models/structural-model.model';
import { LoadCase, LoadCombination, StructuralLoad } from '../models/structural-load.model';
import { generateId } from '../utils/id-generator.util';

const DEFAULT_MATERIAL: Material = {
  id: 'default-steel',
  name: 'Steel (default)',
  youngsModulus: 200e9,
  shearModulus: 77e9,
  density: 7850
};

const DEFAULT_SECTION: Section = {
  id: 'default-section',
  name: 'Default Section',
  area: 0.01,
  momentOfInertiaY: 8e-6,
  momentOfInertiaZ: 8e-6,
  torsionalConstant: 1e-5
};

/** Owns the structural (node/member/support/load) data model, parallel to TreeService's CAD tree but its own domain. */
@Injectable({ providedIn: 'root' })
export class StructuralModelService {
  readonly nodes = signal<StructuralNode[]>([]);
  readonly members = signal<Member[]>([]);
  readonly sections = signal<Section[]>([DEFAULT_SECTION]);
  readonly materials = signal<Material[]>([DEFAULT_MATERIAL]);
  readonly supports = signal<Support[]>([]);
  readonly loadCases = signal<LoadCase[]>([]);
  readonly loads = signal<StructuralLoad[]>([]);
  readonly combinations = signal<LoadCombination[]>([]);

  addNode(position: [number, number, number]): StructuralNode {
    const node: StructuralNode = { id: generateId('node'), position };
    this.nodes.update((current) => [...current, node]);
    return node;
  }

  addMember(startNodeId: string, endNodeId: string): Member {
    const member: Member = {
      id: generateId('member'),
      startNodeId,
      endNodeId,
      sectionId: this.sections()[0].id,
      materialId: this.materials()[0].id,
      betaAngle: 0
    };
    this.members.update((current) => [...current, member]);
    return member;
  }

  setMemberSection(memberId: string, sectionId: string): void {
    this.members.update((current) => current.map((m) => (m.id === memberId ? { ...m, sectionId } : m)));
  }

  setMemberMaterial(memberId: string, materialId: string): void {
    this.members.update((current) => current.map((m) => (m.id === memberId ? { ...m, materialId } : m)));
  }

  addSupport(nodeId: string, restraints: DofRestraints): Support {
    const support: Support = { id: generateId('support'), nodeId, restraints };
    this.supports.update((current) => [...current.filter((s) => s.nodeId !== nodeId), support]);
    return support;
  }

  removeSupport(nodeId: string): void {
    this.supports.update((current) => current.filter((s) => s.nodeId !== nodeId));
  }

  addLoadCase(name: string): LoadCase {
    const loadCase: LoadCase = { id: generateId('loadcase'), name };
    this.loadCases.update((current) => [...current, loadCase]);
    return loadCase;
  }

  addLoad(load: StructuralLoad): void {
    this.loads.update((current) => [...current, load]);
  }

  removeLoad(loadId: string): void {
    this.loads.update((current) => current.filter((l) => l.id !== loadId));
  }

  addCombination(name: string, factors: LoadCombination['factors']): LoadCombination {
    const combination: LoadCombination = { id: generateId('combo'), name, factors };
    this.combinations.update((current) => [...current, combination]);
    return combination;
  }

  reset(): void {
    this.nodes.set([]);
    this.members.set([]);
    this.sections.set([DEFAULT_SECTION]);
    this.materials.set([DEFAULT_MATERIAL]);
    this.supports.set([]);
    this.loadCases.set([]);
    this.loads.set([]);
    this.combinations.set([]);
  }
}
