export type DockMode = 'floating' | 'docked-left' | 'docked-right';

export interface FloatingPanelLayout {
  mode: DockMode;
  x: number;
  y: number;
}

export type ToolPanelId = 'measure' | 'section' | 'sketch' | 'structural' | 'results' | 'bridge' | 'primitive' | 'filletChamfer' | 'pattern' | 'mirror' | 'holeWizard' | 'referencePlane' | 'shell' | 'draft' | 'loft' | 'featureTree';

export interface PanelLayoutStorageV1 {
  version: 1;
  floating: Record<ToolPanelId, FloatingPanelLayout>;
  treeWidth: number;
  propertiesWidth: number;
}
