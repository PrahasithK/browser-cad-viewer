export interface LoadCase {
  id: string;
  name: string;
}

export interface LoadCombinationFactor {
  loadCaseId: string;
  factor: number;
}

export interface LoadCombination {
  id: string;
  name: string;
  factors: LoadCombinationFactor[];
}

export interface NodalLoad {
  id: string;
  type: 'nodal';
  loadCaseId: string;
  nodeId: string;
  force: [number, number, number];
  moment: [number, number, number];
}

export interface MemberUdlLoad {
  id: string;
  type: 'member-udl';
  loadCaseId: string;
  memberId: string;
  /** Force per unit length in global -Z (this app's "down"), e.g. gravity/self-weight-like loading. Arbitrary-direction member loads are a later increment. */
  intensity: number;
}

export type StructuralLoad = NodalLoad | MemberUdlLoad;
