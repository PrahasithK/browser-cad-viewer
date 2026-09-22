export interface StructuralNode {
  id: string;
  position: [number, number, number];
}

export interface Section {
  id: string;
  name: string;
  area: number;
  momentOfInertiaY: number;
  momentOfInertiaZ: number;
  torsionalConstant: number;
}

export interface Material {
  id: string;
  name: string;
  youngsModulus: number;
  shearModulus: number;
  density: number;
}

export interface Member {
  id: string;
  startNodeId: string;
  endNodeId: string;
  sectionId: string;
  materialId: string;
  betaAngle: number;
}

export interface DofRestraints {
  ux: boolean;
  uy: boolean;
  uz: boolean;
  rx: boolean;
  ry: boolean;
  rz: boolean;
}

export interface Support {
  id: string;
  nodeId: string;
  restraints: DofRestraints;
}

export const FIXED_RESTRAINTS: DofRestraints = { ux: true, uy: true, uz: true, rx: true, ry: true, rz: true };
export const PINNED_RESTRAINTS: DofRestraints = { ux: true, uy: true, uz: true, rx: false, ry: false, rz: false };
export const ROLLER_Y_RESTRAINTS: DofRestraints = { ux: false, uy: true, uz: false, rx: false, ry: false, rz: false };
