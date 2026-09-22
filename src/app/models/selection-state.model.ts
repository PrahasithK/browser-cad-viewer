export interface SelectionState {
  /** Primary/last-selected node — unchanged meaning, every existing single-select call site still reads this. */
  selectedNodeId: string | null;
  selectedBodyId: string | null;
  hoveredBodyId: string | null;
  /** Full multi-select set (Ctrl/Shift-click, Ctrl+A). Always contains selectedBodyId when non-empty — additive to the singular fields above, not a replacement. */
  selectedBodyIds: string[];
}
