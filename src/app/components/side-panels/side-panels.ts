import { Component, computed, effect, EventEmitter, Output, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { TreeService } from '../../services/tree.service';
import { SelectionService } from '../../services/selection.service';
import { BodyPropertySnapshot, PropertyService } from '../../services/property.service';
import { HistoryService } from '../../services/history.service';
import { PanelLayoutService } from '../../services/panel-layout.service';
import { Icon } from '../icon/icon';
import { TreeNode } from '../../models/tree-node.model';
import { formatArea, formatLength, formatVolume } from '../../utils/unit-conversion.util';
import { MATERIAL_LIBRARY } from '../../models/engineering-material.model';
import { formatInertia, formatMass, inertiaKgMm2, massKg } from '../../utils/mass-properties.util';

/** Docked info panels flanking the viewport: left model tree, right properties editor. */
@Component({
  selector: 'app-side-panels',
  imports: [NgTemplateOutlet, Icon],
  templateUrl: './side-panels.html',
  styleUrl: './side-panels.css'
})
export class SidePanels {
  /** Deletion touches the scene (mesh disposal) which Viewport owns — bubble up to App, same pattern as `openStepFile`. */
  @Output() deletePart = new EventEmitter<string>();

  /** Column-width changes bubble up to App, which owns `.cad-main`'s grid — same bubbling pattern as `deletePart`. */
  @Output() treeWidthChange = new EventEmitter<number>();
  @Output() propertiesWidthChange = new EventEmitter<number>();

  // --- Model tree ---
  readonly nodes;
  readonly treeSelection;
  readonly renamingNodeId = signal<string | null>(null);
  /** Search/filter text — client-side view filter only, TreeService's own data is untouched. */
  readonly treeFilter = signal('');
  /** Node ids that match the current filter (by label) or are an ancestor of a match, so a matching deeply-nested body stays reachable. Empty filter means "show everything" (computed short-circuits). */
  readonly visibleNodeIds = computed(() => {
    const query = this.treeFilter().trim().toLowerCase();
    if (!query) return null; // null = no filtering active

    const matchIds = new Set<string>();
    const markAncestors = (path: TreeNode[]) => {
      for (const node of path) matchIds.add(node.id);
    };
    const walk = (nodes: TreeNode[], path: TreeNode[]) => {
      for (const node of nodes) {
        const nextPath = [...path, node];
        if (node.label.toLowerCase().includes(query)) markAncestors(nextPath);
        walk(node.children, nextPath);
      }
    };
    walk(this.nodes(), []);
    return matchIds;
  });

  // --- Properties ---
  readonly snapshot;
  readonly editingName = signal(false);
  /** Brief highlight pulse on the (always-visible) properties panel header — the context menu's "Properties" action's only visible feedback, since the panel itself has no hidden/shown state to toggle. */
  readonly propertiesFlash = signal(false);

  flashProperties(): void {
    this.propertiesFlash.set(true);
    setTimeout(() => this.propertiesFlash.set(false), 600);
  }

  // --- Resize ---
  readonly treeWidth;
  readonly propertiesWidth;
  private resizingTree = false;
  private resizingProperties = false;
  private resizeStartClientX = 0;
  private resizeStartWidth = 0;

  constructor(
    private readonly tree: TreeService,
    private readonly selectionService: SelectionService,
    private readonly property: PropertyService,
    private readonly history: HistoryService,
    private readonly layout: PanelLayoutService
  ) {
    this.nodes = this.tree.nodes;
    this.treeSelection = this.selectionService.state;
    this.snapshot = this.property.selectedSnapshot;
    this.treeWidth = this.layout.treeWidth;
    this.propertiesWidth = this.layout.propertiesWidth;

    // React to the viewport context menu's "Properties"/"Rename" requests (see PropertyService's
    // focusPropertiesRequest/startRenameRequest) so Viewport doesn't need a direct SidePanels reference.
    effect(() => {
      this.property.focusPropertiesRequest();
      if (this.property.focusPropertiesRequest() > 0) this.flashProperties();
    });
    effect(() => {
      const snap = this.snapshot();
      if (this.property.startRenameRequest() > 0 && snap) this.startNameEdit();
    });
  }

  // --- Resize ---
  onTreeResizeStart(event: PointerEvent): void {
    this.resizingTree = true;
    this.resizeStartClientX = event.clientX;
    this.resizeStartWidth = this.layout.treeWidth();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  onTreeResizeMove(event: PointerEvent): void {
    if (!this.resizingTree) return;
    const width = this.resizeStartWidth + (event.clientX - this.resizeStartClientX);
    this.layout.setTreeWidth(width);
    this.treeWidthChange.emit(this.layout.treeWidth());
  }

  onTreeResizeEnd(): void {
    if (!this.resizingTree) return;
    this.resizingTree = false;
    this.layout.persistSideWidths();
  }

  onPropertiesResizeStart(event: PointerEvent): void {
    this.resizingProperties = true;
    this.resizeStartClientX = event.clientX;
    this.resizeStartWidth = this.layout.propertiesWidth();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  onPropertiesResizeMove(event: PointerEvent): void {
    if (!this.resizingProperties) return;
    // Properties panel is on the right — dragging left (negative delta) should widen it.
    const width = this.resizeStartWidth - (event.clientX - this.resizeStartClientX);
    this.layout.setPropertiesWidth(width);
    this.propertiesWidthChange.emit(this.layout.propertiesWidth());
  }

  onPropertiesResizeEnd(): void {
    if (!this.resizingProperties) return;
    this.resizingProperties = false;
    this.layout.persistSideWidths();
  }

  // --- Model tree ---
  /** Ctrl/Shift-click toggles this node into/out of the multi-select set, mirroring the viewport's click behavior — same modifier convention in both places. */
  select(node: TreeNode, event: MouseEvent): void {
    if (node.type !== 'body') return;
    const body = this.tree.getBodyForNodeId(node.id);
    const additive = event.ctrlKey || event.shiftKey;
    if (additive) {
      this.selectionService.toggleMesh(body?.mesh ?? null, true);
    } else {
      this.selectionService.selectByNodeId(node.id);
    }

    // Properties panel always reflects the primary (most-recently-toggled-in) selection, not
    // necessarily this clicked node — e.g. Ctrl-clicking to *remove* a different node from the set.
    const primaryBodyId = this.selectionService.state().selectedBodyId;
    const primaryBody = primaryBodyId ? this.tree.allBodies().find((b) => b.id === primaryBodyId) : null;
    this.property.showProperties(primaryBody ?? null);
  }

  toggleExpand(node: TreeNode, event: Event): void {
    event.stopPropagation();
    this.tree.toggleExpanded(node.id);
  }

  /** Whether a node should render under the current filter — always true with no filter active. */
  isVisibleUnderFilter(node: TreeNode): boolean {
    const visibleIds = this.visibleNodeIds();
    return visibleIds === null || visibleIds.has(node.id);
  }

  onFilterInput(event: Event): void {
    this.treeFilter.set((event.target as HTMLInputElement).value);
  }

  clearFilter(): void {
    this.treeFilter.set('');
  }

  toggleVisibility(node: TreeNode, event: Event): void {
    event.stopPropagation();
    const nodeId = node.id;
    const wasVisible = node.visible;
    this.history.run({
      label: `Toggle visibility: ${node.label}`,
      redo: () => this.tree.setNodeVisibility(nodeId, !wasVisible),
      undo: () => this.tree.setNodeVisibility(nodeId, wasVisible)
    });
  }

  isSelected(node: TreeNode): boolean {
    if (this.treeSelection().selectedNodeId === node.id) return true;
    if (node.type !== 'body') return false;
    const body = this.tree.getBodyForNodeId(node.id);
    return !!body && this.treeSelection().selectedBodyIds.includes(body.id);
  }

  startRename(node: TreeNode, event: Event): void {
    if (node.type !== 'body') return;
    event.stopPropagation();
    this.renamingNodeId.set(node.id);
  }

  commitRename(node: TreeNode, event: Event): void {
    event.stopPropagation();
    this.renamingNodeId.set(null);

    const input = event.target as HTMLInputElement;
    const newLabel = input.value.trim();
    const oldLabel = node.label;
    if (!newLabel || newLabel === oldLabel) return;

    this.renameNode(node.id, oldLabel, newLabel);
  }

  private renameNode(nodeId: string, oldLabel: string, newLabel: string): void {
    const applyLabel = (label: string) => {
      this.tree.renameNode(nodeId, label);
      const body = this.tree.getBodyForNodeId(nodeId);
      if (body) this.property.refreshIfSelected(body);
    };
    this.history.run({
      label: `Rename: ${oldLabel} → ${newLabel}`,
      redo: () => applyLabel(newLabel),
      undo: () => applyLabel(oldLabel)
    });
  }

  cancelRename(event: Event): void {
    event.stopPropagation();
    this.renamingNodeId.set(null);
  }

  isRenaming(node: TreeNode): boolean {
    return this.renamingNodeId() === node.id;
  }

  requestDelete(node: TreeNode, event: Event): void {
    event.stopPropagation();
    this.deletePart.emit(node.id);
  }

  // --- Properties ---
  // --- Mass properties ---
  readonly materials = MATERIAL_LIBRARY;

  onMaterialChange(event: Event): void {
    const snap = this.snapshot();
    if (!snap) return;
    const body = snap.body;
    const oldId = body.materialId ?? null;
    const newId = (event.target as HTMLSelectElement).value || null;
    this.history.run({
      label: `Material: ${body.name}`,
      redo: () => this.property.setMaterial(body, newId),
      undo: () => this.property.setMaterial(body, oldId)
    });
  }

  /** Rows for the Mass Properties section. Centre of volume is always available; mass and inertia need a material (density). Inertia is about the centre of gravity in world axes. */
  massRows(snap: BodyPropertySnapshot): { label: string; value: string }[] {
    const m = snap.mass;
    if (!m) return [];
    const c = m.centroid;
    const material = snap.engineeringMaterial;
    const rows = [{ label: material ? 'Center of gravity' : 'Centroid', value: `${c.x.toFixed(2)}, ${c.y.toFixed(2)}, ${c.z.toFixed(2)} mm` }];
    if (!material) return rows;

    const d = material.density;
    // Products of inertia of a symmetric body come out as ~1e-13 floating-point noise; show them as zero.
    const noiseFloor = 1e-9 * Math.max(m.inertia.xx, m.inertia.yy, m.inertia.zz);
    const inertia = (v: number): string => formatInertia(inertiaKgMm2(Math.abs(v) < noiseFloor ? 0 : v, d));
    rows.unshift({ label: 'Mass', value: formatMass(massKg(m.volume, d)) });
    rows.unshift({ label: 'Density', value: `${d} kg/m³` });
    rows.push(
      { label: 'Ixx', value: inertia(m.inertia.xx) },
      { label: 'Iyy', value: inertia(m.inertia.yy) },
      { label: 'Izz', value: inertia(m.inertia.zz) },
      { label: 'Ixy', value: inertia(m.inertia.xy) },
      { label: 'Ixz', value: inertia(m.inertia.xz) },
      { label: 'Iyz', value: inertia(m.inertia.yz) },
      { label: 'Principal I1', value: inertia(m.principal[0]) },
      { label: 'Principal I2', value: inertia(m.principal[1]) },
      { label: 'Principal I3', value: inertia(m.principal[2]) }
    );
    return rows;
  }

  formatVolume(mm3: number | null): string {
    return mm3 === null ? '—' : formatVolume(mm3);
  }

  formatArea(mm2: number | null): string {
    return mm2 === null ? '—' : formatArea(mm2);
  }

  formatLength(mm: number): string {
    return formatLength(mm);
  }

  onColorChange(event: Event): void {
    const snap = this.snapshot();
    if (!snap) return;
    const body = snap.body;
    const oldColor = snap.material.color;
    const newColor = (event.target as HTMLInputElement).value;
    this.history.run({
      label: `Color: ${body.name}`,
      redo: () => this.property.setColor(body, newColor),
      undo: () => this.property.setColor(body, oldColor)
    });
  }

  onOpacityChange(event: Event): void {
    const snap = this.snapshot();
    if (!snap) return;
    const body = snap.body;
    const oldOpacity = snap.material.opacity;
    const newOpacity = Number((event.target as HTMLInputElement).value);
    this.history.run({
      label: `Opacity: ${body.name}`,
      redo: () => this.property.setOpacity(body, newOpacity),
      undo: () => this.property.setOpacity(body, oldOpacity)
    });
  }

  onVisibilityChange(event: Event): void {
    const snap = this.snapshot();
    if (!snap) return;
    const body = snap.body;
    const newVisible = (event.target as HTMLInputElement).checked;
    this.history.run({
      label: `Visibility: ${body.name}`,
      redo: () => this.property.setVisible(body, newVisible),
      undo: () => this.property.setVisible(body, !newVisible)
    });
  }

  startNameEdit(): void {
    this.editingName.set(true);
  }

  commitNameEdit(event: Event): void {
    this.editingName.set(false);
    const snap = this.snapshot();
    if (!snap) return;

    const nodeId = this.tree.getNodeIdForMesh(snap.body.mesh);
    if (!nodeId) return;

    const input = event.target as HTMLInputElement;
    const newLabel = input.value.trim();
    const oldLabel = snap.body.name;
    if (!newLabel || newLabel === oldLabel) return;

    this.renameNode(nodeId, oldLabel, newLabel);
  }

  cancelNameEdit(): void {
    this.editingName.set(false);
  }
}
