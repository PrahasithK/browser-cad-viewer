import { StructuralNode, Member, Section, Material, Support, DofRestraints } from '../models/structural-model.model';
import { LoadCase, LoadCombination, StructuralLoad } from '../models/structural-load.model';
import { AnalysisResult, MemberForces, NodeDisplacement, Reaction } from '../models/structural-result.model';
import { computeLocalAxes, localBeamStiffness, transformationMatrix, LocalAxes } from './beam-stiffness.util';
import { fixedEndLoadsUDL } from './beam-fixed-end-forces.util';
import { matMul, matVec, solveLinearSystem, transpose, zerosMatrix } from './linear-solve.util';

const GRAVITY_DIRECTION: [number, number, number] = [0, 0, -1];
const DOF_KEYS: (keyof DofRestraints)[] = ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'];

export interface StructuralModelInput {
  nodes: StructuralNode[];
  members: Member[];
  sections: Section[];
  materials: Material[];
  supports: Support[];
  loadCases: LoadCase[];
  loads: StructuralLoad[];
  combinations: LoadCombination[];
}

interface ElementData {
  member: Member;
  dofMap: number[];
  axes: LocalAxes;
  kLocal: number[][];
  T: number[][];
  kGlobal: number[][];
}

function buildElements(input: StructuralModelInput, nodeIndex: Map<string, number>): ElementData[] {
  const sectionById = new Map(input.sections.map((s) => [s.id, s]));
  const materialById = new Map(input.materials.map((m) => [m.id, m]));

  return input.members.map((member) => {
    const i1 = nodeIndex.get(member.startNodeId)!;
    const i2 = nodeIndex.get(member.endNodeId)!;
    const node1 = input.nodes[i1].position;
    const node2 = input.nodes[i2].position;
    const section = sectionById.get(member.sectionId)!;
    const material = materialById.get(member.materialId)!;

    const axes = computeLocalAxes(node1, node2, member.betaAngle);
    const kLocal = localBeamStiffness(
      material.youngsModulus,
      material.shearModulus,
      section.area,
      section.momentOfInertiaY,
      section.momentOfInertiaZ,
      section.torsionalConstant,
      axes.length
    );
    const T = transformationMatrix(axes);
    const kGlobal = matMul(matMul(transpose(T), kLocal), T);

    const dofMap = [0, 1, 2, 3, 4, 5].map((i) => i1 * 6 + i).concat([0, 1, 2, 3, 4, 5].map((i) => i2 * 6 + i));

    return { member, dofMap, axes, kLocal, T, kGlobal };
  });
}

function assembleGlobalStiffness(elements: ElementData[], nDof: number): number[][] {
  const K = zerosMatrix(nDof, nDof);
  for (const el of elements) {
    for (let i = 0; i < 12; i++) {
      for (let j = 0; j < 12; j++) {
        K[el.dofMap[i]][el.dofMap[j]] += el.kGlobal[i][j];
      }
    }
  }
  return K;
}

function buildRestraintArray(input: StructuralModelInput, nodeIndex: Map<string, number>, nDof: number): boolean[] {
  const restrained = new Array(nDof).fill(false);
  for (const support of input.supports) {
    const nodeIdx = nodeIndex.get(support.nodeId);
    if (nodeIdx === undefined) continue;
    DOF_KEYS.forEach((key, i) => {
      if (support.restraints[key]) restrained[nodeIdx * 6 + i] = true;
    });
  }
  return restrained;
}

function buildLoadVectorForCase(
  elements: ElementData[],
  nodeIndex: Map<string, number>,
  loads: StructuralLoad[],
  loadCaseId: string,
  nDof: number
): { loadVector: number[]; memberEquivNodalLoadLocal: Map<string, number[]> } {
  const loadVector = new Array(nDof).fill(0);
  const memberEquivNodalLoadLocal = new Map<string, number[]>();

  for (const load of loads) {
    if (load.loadCaseId !== loadCaseId) continue;

    if (load.type === 'nodal') {
      const nodeIdx = nodeIndex.get(load.nodeId);
      if (nodeIdx === undefined) continue;
      const base = nodeIdx * 6;
      for (let i = 0; i < 3; i++) loadVector[base + i] += load.force[i];
      for (let i = 0; i < 3; i++) loadVector[base + 3 + i] += load.moment[i];
    }

    if (load.type === 'member-udl') {
      const el = elements.find((e) => e.member.id === load.memberId);
      if (!el) continue;
      const fLocal = fixedEndLoadsUDL(el.axes, load.intensity, GRAVITY_DIRECTION);
      const existing = memberEquivNodalLoadLocal.get(el.member.id) ?? new Array(12).fill(0);
      memberEquivNodalLoadLocal.set(el.member.id, existing.map((v, i) => v + fLocal[i]));

      const fGlobal = matVec(transpose(el.T), fLocal);
      for (let i = 0; i < 12; i++) loadVector[el.dofMap[i]] += fGlobal[i];
    }
  }

  return { loadVector, memberEquivNodalLoadLocal };
}

function solveDisplacements(K: number[][], restrained: boolean[], loadVector: number[], nDof: number): number[] {
  const free: number[] = [];
  for (let i = 0; i < nDof; i++) if (!restrained[i]) free.push(i);

  const Kff = free.map((r) => free.map((c) => K[r][c]));
  const Ff = free.map((r) => loadVector[r]);
  const df = solveLinearSystem(Kff, Ff);

  const d = new Array(nDof).fill(0);
  free.forEach((idx, i) => (d[idx] = df[i]));
  return d;
}

function computeReactions(nodes: StructuralNode[], K: number[][], displacements: number[], loadVector: number[], restrained: boolean[]): Reaction[] {
  const kd = matVec(K, displacements);
  const reactions: Reaction[] = [];
  nodes.forEach((node, idx) => {
    const base = idx * 6;
    const isRestrained = DOF_KEYS.some((_, i) => restrained[base + i]);
    if (!isRestrained) return;
    const r = [0, 1, 2, 3, 4, 5].map((i) => kd[base + i] - loadVector[base + i]);
    reactions.push({
      nodeId: node.id,
      force: [r[0], r[1], r[2]],
      moment: [r[3], r[4], r[5]]
    });
  });
  return reactions;
}

/** Member end forces = k_local * d_local - equivalentNodalLoad_local (validated against cantilever+UDL statics: M=wL^2/2, V=wL). */
function computeMemberForces(elements: ElementData[], displacements: number[], memberEquivNodalLoadLocal: Map<string, number[]>): MemberForces[] {
  return elements.map((el) => {
    const dGlobal = el.dofMap.map((i) => displacements[i]);
    const dLocal = matVec(el.T, dGlobal);
    const kd = matVec(el.kLocal, dLocal);
    const equiv = memberEquivNodalLoadLocal.get(el.member.id) ?? new Array(12).fill(0);
    const q = kd.map((v, i) => v - equiv[i]);
    return {
      memberId: el.member.id,
      start: [q[0], q[1], q[2], q[3], q[4], q[5]],
      end: [q[6], q[7], q[8], q[9], q[10], q[11]]
    };
  });
}

function toNodeDisplacements(nodes: StructuralNode[], displacements: number[]): NodeDisplacement[] {
  return nodes.map((node, idx) => {
    const base = idx * 6;
    return {
      nodeId: node.id,
      translation: [displacements[base], displacements[base + 1], displacements[base + 2]],
      rotation: [displacements[base + 3], displacements[base + 4], displacements[base + 5]]
    };
  });
}

function scaleAndSumResults(results: AnalysisResult[], factors: { resultId: string; factor: number }[], combinationId: string): AnalysisResult {
  const byId = new Map(results.map((r) => [r.resultId, r]));
  const nodeIds = byId.get(factors[0].resultId)!.displacements.map((d) => d.nodeId);
  const memberIds = byId.get(factors[0].resultId)!.memberForces.map((m) => m.memberId);
  const reactionNodeIds = byId.get(factors[0].resultId)!.reactions.map((r) => r.nodeId);

  const scaleVec3 = (acc: [number, number, number], v: [number, number, number], f: number): [number, number, number] => [
    acc[0] + v[0] * f,
    acc[1] + v[1] * f,
    acc[2] + v[2] * f
  ];
  const scaleVec6 = (
    acc: [number, number, number, number, number, number],
    v: [number, number, number, number, number, number],
    f: number
  ): [number, number, number, number, number, number] => [
    acc[0] + v[0] * f,
    acc[1] + v[1] * f,
    acc[2] + v[2] * f,
    acc[3] + v[3] * f,
    acc[4] + v[4] * f,
    acc[5] + v[5] * f
  ];

  const displacements: NodeDisplacement[] = nodeIds.map((nodeId) => {
    let translation: [number, number, number] = [0, 0, 0];
    let rotation: [number, number, number] = [0, 0, 0];
    for (const { resultId, factor } of factors) {
      const d = byId.get(resultId)!.displacements.find((x) => x.nodeId === nodeId)!;
      translation = scaleVec3(translation, d.translation, factor);
      rotation = scaleVec3(rotation, d.rotation, factor);
    }
    return { nodeId, translation, rotation };
  });

  const reactions: Reaction[] = reactionNodeIds.map((nodeId) => {
    let force: [number, number, number] = [0, 0, 0];
    let moment: [number, number, number] = [0, 0, 0];
    for (const { resultId, factor } of factors) {
      const r = byId.get(resultId)!.reactions.find((x) => x.nodeId === nodeId)!;
      force = scaleVec3(force, r.force, factor);
      moment = scaleVec3(moment, r.moment, factor);
    }
    return { nodeId, force, moment };
  });

  const memberForces: MemberForces[] = memberIds.map((memberId) => {
    let start: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0];
    let end: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0];
    for (const { resultId, factor } of factors) {
      const m = byId.get(resultId)!.memberForces.find((x) => x.memberId === memberId)!;
      start = scaleVec6(start, m.start, factor);
      end = scaleVec6(end, m.end, factor);
    }
    return { memberId, start, end };
  });

  return { resultId: combinationId, resultKind: 'combination', displacements, reactions, memberForces };
}

export function analyzeStructure(input: StructuralModelInput): AnalysisResult[] {
  const nodeIndex = new Map(input.nodes.map((n, i) => [n.id, i]));
  const nDof = 6 * input.nodes.length;

  const elements = buildElements(input, nodeIndex);
  const K = assembleGlobalStiffness(elements, nDof);
  const restrained = buildRestraintArray(input, nodeIndex, nDof);

  const caseResults: AnalysisResult[] = input.loadCases.map((loadCase) => {
    const { loadVector, memberEquivNodalLoadLocal } = buildLoadVectorForCase(elements, nodeIndex, input.loads, loadCase.id, nDof);
    const displacements = solveDisplacements(K, restrained, loadVector, nDof);
    const reactions = computeReactions(input.nodes, K, displacements, loadVector, restrained);
    const memberForces = computeMemberForces(elements, displacements, memberEquivNodalLoadLocal);
    return {
      resultId: loadCase.id,
      resultKind: 'load-case',
      displacements: toNodeDisplacements(input.nodes, displacements),
      reactions,
      memberForces
    };
  });

  const combinationResults: AnalysisResult[] = input.combinations.map((combo) =>
    scaleAndSumResults(
      caseResults,
      combo.factors.map((f) => ({ resultId: f.loadCaseId, factor: f.factor })),
      combo.id
    )
  );

  return [...caseResults, ...combinationResults];
}
