import { analyzeStructure, StructuralModelInput } from './structural-solver.util';
import { Material, Section, FIXED_RESTRAINTS, PINNED_RESTRAINTS, ROLLER_Y_RESTRAINTS, DofRestraints } from '../models/structural-model.model';
import { NodalLoad, MemberUdlLoad } from '../models/structural-load.model';

const MATERIAL: Material = { id: 'mat', name: 'steel', youngsModulus: 200e9, shearModulus: 77e9, density: 7850 };
const SECTION: Section = { id: 'sec', name: 'default', area: 0.01, momentOfInertiaY: 8e-6, momentOfInertiaZ: 8e-6, torsionalConstant: 1e-5 };

function noRestraints(): DofRestraints {
  return { ux: false, uy: false, uz: false, rx: false, ry: false, rz: false };
}

function almostEqual(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
}

describe('structural-solver.util (Phase 0 closed-form validation, ported)', () => {
  it('cantilever point load matches PL^3/3EI', () => {
    const L = 3;
    const P = -1000;
    const input: StructuralModelInput = {
      nodes: [{ id: 'n1', position: [0, 0, 0] }, { id: 'n2', position: [L, 0, 0] }],
      members: [{ id: 'm1', startNodeId: 'n1', endNodeId: 'n2', sectionId: SECTION.id, materialId: MATERIAL.id, betaAngle: 0 }],
      sections: [SECTION],
      materials: [MATERIAL],
      supports: [{ id: 's1', nodeId: 'n1', restraints: FIXED_RESTRAINTS }],
      loadCases: [{ id: 'lc1', name: 'Case 1' }],
      loads: [{ id: 'l1', type: 'nodal', loadCaseId: 'lc1', nodeId: 'n2', force: [0, P, 0], moment: [0, 0, 0] } as NodalLoad],
      combinations: []
    };

    const [result] = analyzeStructure(input);
    const uy2 = result.displacements.find((d) => d.nodeId === 'n2')!.translation[1];
    const expected = (P * L ** 3) / (3 * MATERIAL.youngsModulus * SECTION.momentOfInertiaZ);
    expect(almostEqual(uy2, expected, 1e-6)).toBeTrue();
  });

  it('cantilever UDL matches wL^4/8EI', () => {
    const L = 3;
    // `intensity` is a magnitude acting in the fixed global -Z ("down") direction — positive
    // means "this much load, downward", matching how a structural engineer enters a gravity load.
    const intensity = 500;
    const input: StructuralModelInput = {
      nodes: [{ id: 'n1', position: [0, 0, 0] }, { id: 'n2', position: [L, 0, 0] }],
      members: [{ id: 'm1', startNodeId: 'n1', endNodeId: 'n2', sectionId: SECTION.id, materialId: MATERIAL.id, betaAngle: 0 }],
      sections: [SECTION],
      materials: [MATERIAL],
      supports: [{ id: 's1', nodeId: 'n1', restraints: FIXED_RESTRAINTS }],
      loadCases: [{ id: 'lc1', name: 'Case 1' }],
      loads: [{ id: 'l1', type: 'member-udl', loadCaseId: 'lc1', memberId: 'm1', intensity } as MemberUdlLoad],
      combinations: []
    };

    const [result] = analyzeStructure(input);
    // Member is along global X with ex=(1,0,0); ey ends up as global Y, ez as global Z, so the
    // -Z gravity load is a pure local -z UDL here (magnitude `intensity`, downward) => check uz.
    const uz2 = result.displacements.find((d) => d.nodeId === 'n2')!.translation[2];
    const expected = (-intensity * L ** 4) / (8 * MATERIAL.youngsModulus * SECTION.momentOfInertiaY);
    expect(almostEqual(uz2, expected, 1e-4)).toBeTrue();
  });

  it('simply-supported beam midspan load matches PL^3/48EI', () => {
    const L = 6;
    const P = -1000;
    const pinRestraints: DofRestraints = { ...PINNED_RESTRAINTS, rx: true };
    const input: StructuralModelInput = {
      nodes: [
        { id: 'n1', position: [0, 0, 0] },
        { id: 'n2', position: [L / 2, 0, 0] },
        { id: 'n3', position: [L, 0, 0] }
      ],
      members: [
        { id: 'm1', startNodeId: 'n1', endNodeId: 'n2', sectionId: SECTION.id, materialId: MATERIAL.id, betaAngle: 0 },
        { id: 'm2', startNodeId: 'n2', endNodeId: 'n3', sectionId: SECTION.id, materialId: MATERIAL.id, betaAngle: 0 }
      ],
      sections: [SECTION],
      materials: [MATERIAL],
      supports: [
        { id: 's1', nodeId: 'n1', restraints: pinRestraints },
        { id: 's2', nodeId: 'n3', restraints: ROLLER_Y_RESTRAINTS }
      ],
      loadCases: [{ id: 'lc1', name: 'Case 1' }],
      loads: [{ id: 'l1', type: 'nodal', loadCaseId: 'lc1', nodeId: 'n2', force: [0, P, 0], moment: [0, 0, 0] } as NodalLoad],
      combinations: []
    };

    const [result] = analyzeStructure(input);
    const uyMid = result.displacements.find((d) => d.nodeId === 'n2')!.translation[1];
    const expected = (P * L ** 3) / (48 * MATERIAL.youngsModulus * SECTION.momentOfInertiaZ);
    expect(almostEqual(uyMid, expected, 1e-6)).toBeTrue();
  });

  it('combination result equals factored superposition of separately-solved cases', () => {
    const L = 3;
    const P1 = -1000;
    const P2 = -600;
    const input: StructuralModelInput = {
      nodes: [{ id: 'n1', position: [0, 0, 0] }, { id: 'n2', position: [L, 0, 0] }],
      members: [{ id: 'm1', startNodeId: 'n1', endNodeId: 'n2', sectionId: SECTION.id, materialId: MATERIAL.id, betaAngle: 0 }],
      sections: [SECTION],
      materials: [MATERIAL],
      supports: [{ id: 's1', nodeId: 'n1', restraints: FIXED_RESTRAINTS }],
      loadCases: [
        { id: 'lc1', name: 'Case 1' },
        { id: 'lc2', name: 'Case 2' }
      ],
      loads: [
        { id: 'l1', type: 'nodal', loadCaseId: 'lc1', nodeId: 'n2', force: [0, P1, 0], moment: [0, 0, 0] } as NodalLoad,
        { id: 'l2', type: 'nodal', loadCaseId: 'lc2', nodeId: 'n2', force: [0, P2, 0], moment: [0, 0, 0] } as NodalLoad
      ],
      combinations: [{ id: 'combo1', name: 'Combo', factors: [{ loadCaseId: 'lc1', factor: 1.2 }, { loadCaseId: 'lc2', factor: 1.6 }] }]
    };

    const results = analyzeStructure(input);
    const case1 = results.find((r) => r.resultId === 'lc1')!;
    const case2 = results.find((r) => r.resultId === 'lc2')!;
    const combo = results.find((r) => r.resultId === 'combo1')!;

    const uy1 = case1.displacements.find((d) => d.nodeId === 'n2')!.translation[1];
    const uy2 = case2.displacements.find((d) => d.nodeId === 'n2')!.translation[1];
    const uyCombo = combo.displacements.find((d) => d.nodeId === 'n2')!.translation[1];

    expect(almostEqual(uyCombo, uy1 * 1.2 + uy2 * 1.6, 1e-9)).toBeTrue();
  });

  it('Iy vs Iz isolation: bending on each axis uses the correct moment of inertia', () => {
    const L = 3;
    const P = -1000;
    const section: Section = { ...SECTION, momentOfInertiaY: 3e-6, momentOfInertiaZ: 8e-6 };
    const baseInput: Omit<StructuralModelInput, 'loads'> = {
      nodes: [{ id: 'n1', position: [0, 0, 0] }, { id: 'n2', position: [L, 0, 0] }],
      members: [{ id: 'm1', startNodeId: 'n1', endNodeId: 'n2', sectionId: section.id, materialId: MATERIAL.id, betaAngle: 0 }],
      sections: [section],
      materials: [MATERIAL],
      supports: [{ id: 's1', nodeId: 'n1', restraints: FIXED_RESTRAINTS }],
      loadCases: [{ id: 'lc1', name: 'Case 1' }],
      combinations: []
    };

    const inputY: StructuralModelInput = { ...baseInput, loads: [{ id: 'l1', type: 'nodal', loadCaseId: 'lc1', nodeId: 'n2', force: [0, P, 0], moment: [0, 0, 0] } as NodalLoad] };
    const [resultY] = analyzeStructure(inputY);
    const uy2 = resultY.displacements.find((d) => d.nodeId === 'n2')!.translation[1];
    expect(almostEqual(uy2, (P * L ** 3) / (3 * MATERIAL.youngsModulus * section.momentOfInertiaZ), 1e-6)).toBeTrue();

    const inputZ: StructuralModelInput = { ...baseInput, loads: [{ id: 'l2', type: 'nodal', loadCaseId: 'lc1', nodeId: 'n2', force: [0, 0, P], moment: [0, 0, 0] } as NodalLoad] };
    const [resultZ] = analyzeStructure(inputZ);
    const uz2 = resultZ.displacements.find((d) => d.nodeId === 'n2')!.translation[2];
    expect(almostEqual(uz2, (P * L ** 3) / (3 * MATERIAL.youngsModulus * section.momentOfInertiaY), 1e-6)).toBeTrue();
  });

  it('vertical member (isVertical branch) matches cantilever formula', () => {
    const L = 3;
    const P = -1000;
    const input: StructuralModelInput = {
      nodes: [{ id: 'n1', position: [0, 0, 0] }, { id: 'n2', position: [0, 0, L] }],
      members: [{ id: 'm1', startNodeId: 'n1', endNodeId: 'n2', sectionId: SECTION.id, materialId: MATERIAL.id, betaAngle: 0 }],
      sections: [SECTION],
      materials: [MATERIAL],
      supports: [{ id: 's1', nodeId: 'n1', restraints: FIXED_RESTRAINTS }],
      loadCases: [{ id: 'lc1', name: 'Case 1' }],
      loads: [{ id: 'l1', type: 'nodal', loadCaseId: 'lc1', nodeId: 'n2', force: [P, 0, 0], moment: [0, 0, 0] } as NodalLoad],
      combinations: []
    };

    const [result] = analyzeStructure(input);
    const ux2 = result.displacements.find((d) => d.nodeId === 'n2')!.translation[0];
    const expected = (P * L ** 3) / (3 * MATERIAL.youngsModulus * SECTION.momentOfInertiaY);
    expect(almostEqual(ux2, expected, 1e-6)).toBeTrue();
  });

  it('cantilever UDL force recovery matches statics (M=wL^2/2, V=wL at the fixed end)', () => {
    const L = 3;
    const intensity = 500;
    const input: StructuralModelInput = {
      nodes: [{ id: 'n1', position: [0, 0, 0] }, { id: 'n2', position: [L, 0, 0] }],
      members: [{ id: 'm1', startNodeId: 'n1', endNodeId: 'n2', sectionId: SECTION.id, materialId: MATERIAL.id, betaAngle: 0 }],
      sections: [SECTION],
      materials: [MATERIAL],
      supports: [{ id: 's1', nodeId: 'n1', restraints: FIXED_RESTRAINTS }],
      loadCases: [{ id: 'lc1', name: 'Case 1' }],
      loads: [{ id: 'l1', type: 'member-udl', loadCaseId: 'lc1', memberId: 'm1', intensity } as MemberUdlLoad],
      combinations: []
    };

    const [result] = analyzeStructure(input);
    const forces = result.memberForces.find((m) => m.memberId === 'm1')!;
    // Member's ez aligns with global Z here, so a -Z gravity UDL loads the local z-axis (uz/ry, index 2/4).
    const shearAtStart = forces.start[2];
    const momentAtStart = forces.start[4];
    expect(almostEqual(Math.abs(shearAtStart), intensity * L, 1e-6)).toBeTrue();
    expect(almostEqual(Math.abs(momentAtStart), (intensity * L * L) / 2, 1e-6)).toBeTrue();
  });
});
