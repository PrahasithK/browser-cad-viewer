export interface NodeDisplacement {
  nodeId: string;
  translation: [number, number, number];
  rotation: [number, number, number];
}

export interface Reaction {
  nodeId: string;
  force: [number, number, number];
  moment: [number, number, number];
}

/** Local-axis end forces for a member: [axial, shearY, shearZ, torsion, momentY, momentZ] at each end. */
export interface MemberForces {
  memberId: string;
  start: [number, number, number, number, number, number];
  end: [number, number, number, number, number, number];
}

export interface AnalysisResult {
  resultId: string;
  resultKind: 'load-case' | 'combination';
  displacements: NodeDisplacement[];
  reactions: Reaction[];
  memberForces: MemberForces[];
}
