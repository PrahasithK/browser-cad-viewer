import { Injectable, signal } from '@angular/core';
import { FloatingPanelLayout, PanelLayoutStorageV1, ToolPanelId } from '../models/panel-layout.model';

const STORAGE_KEY = 'panel-layout-v1';

const TOOL_PANEL_IDS: ToolPanelId[] = ['measure', 'section', 'sketch', 'structural', 'results', 'bridge', 'primitive', 'filletChamfer', 'pattern', 'mirror', 'holeWizard', 'referencePlane', 'shell', 'draft', 'loft', 'featureTree'];

const DEFAULT_TREE_WIDTH = 240;
const DEFAULT_PROPERTIES_WIDTH = 260;
const MIN_SIDE_WIDTH = 160;
const MAX_SIDE_WIDTH = 480;

function defaultFloatingLayouts(): Record<ToolPanelId, FloatingPanelLayout> {
  return {
    measure: { mode: 'floating', x: 12, y: 12 },
    section: { mode: 'floating', x: 0, y: 0 },
    sketch: { mode: 'floating', x: 12, y: 12 },
    structural: { mode: 'floating', x: 12, y: 12 },
    results: { mode: 'floating', x: 0, y: 0 },
    bridge: { mode: 'floating', x: 12, y: 12 },
    primitive: { mode: 'floating', x: 12, y: 12 },
    filletChamfer: { mode: 'floating', x: 12, y: 12 },
    pattern: { mode: 'floating', x: 12, y: 12 },
    mirror: { mode: 'floating', x: 12, y: 12 },
    holeWizard: { mode: 'floating', x: 12, y: 12 },
    referencePlane: { mode: 'floating', x: 12, y: 12 },
    shell: { mode: 'floating', x: 12, y: 12 },
    draft: { mode: 'floating', x: 12, y: 12 },
    loft: { mode: 'floating', x: 12, y: 12 },
    featureTree: { mode: 'docked-right', x: 12, y: 12 }
  };
}

/**
 * Persisted layout preferences for the floating tool panels (position/dock state) and the
 * side panels (tree/properties column widths) — a cross-cutting UI-shell concern that belongs
 * to none of the 7 tool-domain services, since none of them own "where the panel sits on
 * screen." Kept as one service since both are the same concern (persisted panel geometry).
 */
@Injectable({ providedIn: 'root' })
export class PanelLayoutService {
  readonly floatingLayouts = signal<Record<ToolPanelId, FloatingPanelLayout>>(defaultFloatingLayouts());
  readonly treeWidth = signal(DEFAULT_TREE_WIDTH);
  readonly propertiesWidth = signal(DEFAULT_PROPERTIES_WIDTH);

  constructor() {
    this.load();
  }

  getLayout(id: ToolPanelId): FloatingPanelLayout {
    return this.floatingLayouts()[id];
  }

  setPosition(id: ToolPanelId, x: number, y: number): void {
    this.floatingLayouts.update((rec) => ({ ...rec, [id]: { mode: 'floating', x, y } }));
    this.persist();
  }

  setDocked(id: ToolPanelId, side: 'docked-left' | 'docked-right'): void {
    const prev = this.floatingLayouts()[id];
    this.floatingLayouts.update((rec) => ({ ...rec, [id]: { ...prev, mode: side } }));
    this.persist();
  }

  setTreeWidth(px: number): void {
    this.treeWidth.set(clamp(px, MIN_SIDE_WIDTH, MAX_SIDE_WIDTH));
  }

  setPropertiesWidth(px: number): void {
    this.propertiesWidth.set(clamp(px, MIN_SIDE_WIDTH, MAX_SIDE_WIDTH));
  }

  /** Call once on drag-end to avoid flooding localStorage on every pointermove tick. */
  persistSideWidths(): void {
    this.persist();
  }

  private persist(): void {
    const blob: PanelLayoutStorageV1 = {
      version: 1,
      floating: this.floatingLayouts(),
      treeWidth: this.treeWidth(),
      propertiesWidth: this.propertiesWidth()
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
    } catch {
      // localStorage unavailable (private browsing, quota) — layout just won't persist
    }
  }

  private load(): void {
    let raw: string | null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch {
      return;
    }
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw) as PanelLayoutStorageV1;
      if (!isValidStorage(parsed)) return;
      this.floatingLayouts.set(parsed.floating);
      this.treeWidth.set(parsed.treeWidth);
      this.propertiesWidth.set(parsed.propertiesWidth);
    } catch {
      // corrupt JSON — fall back to defaults already set
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isValidStorage(value: unknown): value is PanelLayoutStorageV1 {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<PanelLayoutStorageV1>;
  if (v.version !== 1) return false;
  if (typeof v.treeWidth !== 'number' || typeof v.propertiesWidth !== 'number') return false;
  if (!v.floating || typeof v.floating !== 'object') return false;
  return TOOL_PANEL_IDS.every((id) => {
    const layout = (v.floating as Record<string, FloatingPanelLayout>)[id];
    return (
      layout &&
      (layout.mode === 'floating' || layout.mode === 'docked-left' || layout.mode === 'docked-right') &&
      typeof layout.x === 'number' &&
      typeof layout.y === 'number'
    );
  });
}
