import { Component, ElementRef, EventEmitter, HostListener, Output, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { CameraService } from '../../services/camera.service';
import { RenderService } from '../../services/render.service';
import { ViewerService } from '../../services/viewer.service';
import { SectionService } from '../../services/section.service';
import { SelectionService } from '../../services/selection.service';
import { PropertyService } from '../../services/property.service';
import { MeasurementService } from '../../services/measurement.service';
import { ExplodedViewService } from '../../services/exploded-view.service';
import { ToolService } from '../../services/tool.service';
import { TreeService } from '../../services/tree.service';
import { PrimitiveToolService } from '../../services/primitive-tool.service';
import { FilletChamferToolService } from '../../services/fillet-chamfer-tool.service';
import { ExportService, downloadBlob } from '../../services/export.service';
import { HistoryService } from '../../services/history.service';
import { ObjectTransformService, TransformGizmoMode } from '../../services/object-transform.service';
import { FeatureTreeService } from '../../services/feature-tree.service';
import { ProjectService } from '../../services/project.service';
import { Icon } from '../icon/icon';
import { ViewPreset } from '../../models/view-preset.model';
import { ShadingMode } from '../../models/viewport-settings.model';
import { SectionAxis } from '../../models/section-plane.model';
import { PrimitiveKind } from '../../models/primitive-tool.model';

interface MenuDef {
  label: string;
  items: { label: string; action: () => void }[];
}

/**
 * The app's top+bottom chrome: menu bar, feature ribbon, view toolbar, and status bar.
 * Merges what were 4 separate components — none of them touch the 3D scene beyond
 * calling services, and none of their members collided, so this is a straight merge.
 */
@Component({
  selector: 'app-chrome',
  imports: [DecimalPipe, Icon],
  templateUrl: './app-chrome.html',
  styleUrl: './app-chrome.css'
})
export class AppChrome {
  @Output() openStepFile = new EventEmitter<void>();
  @Output() openProjectFile = new EventEmitter<void>();

  // --- Menu bar ---
  readonly openMenu = signal<string | null>(null);
  menus: MenuDef[] = [];

  // --- Undo/redo ---
  readonly canUndo;
  readonly canRedo;
  /** Which history dropdown (if any) is open — undo or redo lists are mutually exclusive, mirroring the existing single-open-menu pattern used for the File/Edit/View/… menu bar. */
  readonly historyDropdown = signal<'undo' | 'redo' | null>(null);
  readonly undoEntries = () => this.history.undoEntries();
  readonly redoEntries = () => this.history.redoEntries();

  // --- Status bar ---
  readonly cursorCoords;
  readonly fps;

  // --- Ribbon toolbar ---
  readonly measureActive;
  readonly sketchActive;
  readonly structuralNodeActive;
  readonly structuralMemberActive;
  readonly bridgeMeshActive;
  readonly explodeAmount;
  readonly sectionConfigs;
  readonly meshViewActive;
  readonly transformMode;
  readonly hasSelection;
  readonly featureTreePanelOpen;

  // --- View toolbar ---
  readonly shadingMode;
  readonly darkMode;
  readonly showGrid = () => this.gridVisible;
  readonly showAxes = () => this.axesVisible;
  private gridVisible = true;
  private axesVisible = true;

  readonly viewPresets: { preset: ViewPreset; label: string }[] = [
    { preset: 'front', label: 'Front' },
    { preset: 'back', label: 'Back' },
    { preset: 'left', label: 'Left' },
    { preset: 'right', label: 'Right' },
    { preset: 'top', label: 'Top' },
    { preset: 'bottom', label: 'Bottom' },
    { preset: 'iso', label: 'Iso' }
  ];

  readonly selectedLabel;
  readonly projection;
  readonly bodyCount;
  readonly triangleCount;

  constructor(
    private readonly camera: CameraService,
    private readonly render: RenderService,
    private readonly viewer: ViewerService,
    private readonly section: SectionService,
    private readonly selection: SelectionService,
    private readonly property: PropertyService,
    private readonly measurement: MeasurementService,
    private readonly exploded: ExplodedViewService,
    private readonly tool: ToolService,
    private readonly tree: TreeService,
    private readonly primitiveTool: PrimitiveToolService,
    private readonly filletChamferTool: FilletChamferToolService,
    private readonly exportSvc: ExportService,
    private readonly history: HistoryService,
    private readonly objectTransform: ObjectTransformService,
    private readonly featureTree: FeatureTreeService,
    private readonly project: ProjectService,
    private readonly elementRef: ElementRef<HTMLElement>
  ) {
    this.menus = [
      {
        label: 'File',
        items: [
          { label: 'New', action: () => this.newDocument() },
          { label: 'Open Project…', action: () => this.openProjectFile.emit() },
          { label: 'Save Project (Ctrl+S)', action: () => void this.project.save() },
          { label: 'Open STEP…', action: () => this.openStepFile.emit() },
          { label: 'Export STEP…', action: () => void this.exportStep() },
          { label: 'Export STL…', action: () => this.exportStl() },
          { label: 'Save Screenshot', action: () => this.render.downloadScreenshot() }
        ]
      },
      {
        label: 'Edit',
        items: [
          { label: 'Undo', action: () => this.history.undo() },
          { label: 'Redo', action: () => this.history.redo() },
          { label: 'Reset Camera', action: () => this.camera.resetCamera() }
        ]
      },
      {
        label: 'View',
        items: [
          { label: 'Fit All', action: () => this.camera.fitAll() },
          { label: 'Toggle Projection', action: () => this.camera.setProjection(this.camera.projection() === 'perspective' ? 'orthographic' : 'perspective') },
          { label: 'Toggle Dark Mode', action: () => this.render.toggleDarkMode() }
        ]
      },
      {
        label: 'Tools',
        items: [{ label: 'Clear Section Planes', action: () => this.section.reset() }]
      },
      {
        label: 'Help',
        items: [
          { label: 'Keyboard Shortcuts', action: () => this.showShortcuts() },
          { label: 'About', action: () => this.showAbout() }
        ]
      }
    ];

    this.canUndo = this.history.canUndo;
    this.canRedo = this.history.canRedo;

    this.measureActive = this.measurement.active;
    this.explodeAmount = this.exploded.amount;
    this.sectionConfigs = this.section.configs;
    this.meshViewActive = this.render.meshView;
    this.featureTreePanelOpen = this.featureTree.panelOpen;
    this.sketchActive = () => this.tool.activeTool() === 'sketch';
    this.structuralNodeActive = () => this.tool.activeTool() === 'structural-node';
    this.structuralMemberActive = () => this.tool.activeTool() === 'structural-member';
    this.bridgeMeshActive = () => this.tool.activeTool() === 'bridge-mesh';
    this.transformMode = this.objectTransform.mode;
    this.hasSelection = () => this.selection.state().selectedBodyId !== null;

    this.shadingMode = this.render.shadingMode;
    this.darkMode = this.render.darkMode;

    this.selectedLabel = () => {
      const state = this.selection.state();
      if (!state.selectedNodeId) return 'No selection';
      const node = this.tree.findNode(state.selectedNodeId);
      return node ? node.label : 'No selection';
    };
    this.projection = this.camera.projection;
    this.bodyCount = () => this.tree.allBodies().length;
    this.triangleCount = () => {
      let total = 0;
      for (const body of this.tree.allBodies()) {
        const index = body.geometry.getIndex();
        total += index ? index.count / 3 : body.geometry.attributes['position'].count / 3;
      }
      return Math.round(total);
    };

    this.fps = this.viewer.fps;
    this.cursorCoords = () => {
      const p = this.viewer.cursorWorldPos();
      return p ? `X ${p.x.toFixed(1)}  Y ${p.y.toFixed(1)}  Z ${p.z.toFixed(1)}` : '';
    };
  }

  // --- Menu bar behavior ---
  toggleMenu(label: string): void {
    this.openMenu.set(this.openMenu() === label ? null : label);
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.elementRef.nativeElement.contains(event.target as Node)) {
      this.closeMenu();
    }
    const target = event.target as HTMLElement;
    if (this.historyDropdown() && !target.closest('.history-btn-group') && !target.closest('.history-dropdown')) {
      this.historyDropdown.set(null);
    }
  }

  closeMenu(): void {
    this.openMenu.set(null);
  }

  @HostListener('document:keydown', ['$event'])
  onDocumentKeydown(event: KeyboardEvent): void {
    if (!(event.ctrlKey || event.metaKey)) return;
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return; // don't hijack Ctrl+Z while editing a name/value field

    const key = event.key.toLowerCase();
    if (key === 's') {
      event.preventDefault(); // the browser's own "Save page as"
      void this.project.save();
    } else if (key === 'z' && !event.shiftKey) {
      event.preventDefault();
      this.history.undo();
    } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
      event.preventDefault();
      this.history.redo();
    }
  }

  /** File → New: clears the document, asking first if there is anything to lose. */
  newDocument(): void {
    // eslint-disable-next-line no-alert
    if (this.tree.allBodies().length > 0 && !confirm('Start a new document? Anything not saved with Save Project will be lost.')) return;
    this.project.newDocument();
  }

  runAction(action: () => void): void {
    action();
    this.closeMenu();
  }

  private showAbout(): void {
    // eslint-disable-next-line no-alert
    alert('Browser CAD Viewer — Angular 20 + Three.js + OpenCascade.js');
  }

  /**
   * Exports every body that still has a retained STEP source as one combined STEP file (see
   * `ExportService.exportStep`'s docstring for exactly which bodies qualify). `exportBusy` guards
   * against firing a second export while the worker round-trip for the first is still in flight —
   * there's no visible "in progress" UI for this one-shot menu action (unlike Fillet/Chamfer's
   * panel, which has its own busy state), so the guard is the only thing preventing a double-click
   * from spinning up two overlapping worker instances.
   */
  private async exportStep(): Promise<void> {
    if (this.exportBusy) return;
    this.exportBusy = true;
    try {
      const result = await this.exportSvc.exportStep();
      if (!result) {
        // eslint-disable-next-line no-alert
        alert('Nothing to export — no bodies have a retained STEP source (only parts from an opened STEP file can be exported as STEP; try Export STL… instead).');
        return;
      }
      downloadBlob(result.blob, 'export.step');
      if (result.outcome.skipped.length > 0) {
        // eslint-disable-next-line no-alert
        alert(
          [
            `Exported ${result.outcome.exportedCount} of ${result.outcome.exportedCount + result.outcome.skipped.length} bodies as STEP.`,
            '',
            'Skipped (no retained STEP source — created by Sketch/Extrude, a primitive, or Fillet/Chamfer in this session):',
            ...result.outcome.skipped.map((name) => `  • ${name}`),
            '',
            'Use Export STL… instead if you need every body included.'
          ].join('\n')
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-alert
      alert(`STEP export failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.exportBusy = false;
    }
  }

  /** STL export has no partial-export case (works for every body regardless of origin — see ExportService.exportStl's docstring), so this is a plain synchronous call with no busy-guard needed. */
  private exportStl(): void {
    const blob = this.exportSvc.exportStl();
    if (!blob) {
      // eslint-disable-next-line no-alert
      alert('Nothing to export — no bodies are loaded.');
      return;
    }
    downloadBlob(blob, 'export.stl');
  }

  private exportBusy = false;

  /** Plain alert dialog, matching showAbout's existing pattern — no dedicated shortcuts-panel component for what's a one-time reference list. */
  private showShortcuts(): void {
    // eslint-disable-next-line no-alert
    alert(
      [
        'Keyboard Shortcuts',
        '',
        'Esc — Clear selection / cancel active tool',
        'Delete / Backspace — Delete selected part',
        'F — Fit all',
        '1-7 — Front/Back/Left/Right/Top/Bottom/Iso view',
        'M — Distance tool',
        'S — Sketch tool',
        'G / R / Y — Move / Rotate / Scale gizmo (on current selection)',
        'Ctrl+A — Select all',
        'Ctrl+Z / Ctrl+Y — Undo / Redo',
        '',
        'Mouse: Left-drag orbit · Middle-drag pan · Scroll zoom · Right-click menu',
        'Ctrl/Shift-click — Multi-select'
      ].join('\n')
    );
  }

  // --- Ribbon toolbar behavior ---
  clearSelection(): void {
    this.selection.clearSelection();
    // SelectionService (whole-mesh highlight) and PropertyService (properties-panel snapshot,
    // now also the source of the in-viewport body-size labels) are separate pieces of selection
    // state that were never kept in sync here — this button previously left the properties panel
    // (and, now, its labels) showing the old body after "clearing" the 3D highlight.
    this.property.showProperties(null);
  }

  toggleMeasure(): void {
    this.tool.setTool('measure');
  }

  toggleSketch(): void {
    this.tool.setTool('sketch');
  }

  toggleStructuralNode(): void {
    this.tool.setTool('structural-node');
  }

  toggleStructuralMember(): void {
    this.tool.setTool('structural-member');
  }

  toggleBridgeMesh(): void {
    this.tool.setTool('bridge-mesh');
  }

  primitiveActive(kind: PrimitiveKind): boolean {
    return this.tool.activeTool() === 'primitive' && this.primitiveTool.state().kind === kind;
  }

  togglePrimitive(kind: PrimitiveKind): void {
    if (this.tool.activeTool() === 'primitive' && this.primitiveTool.state().kind === kind) {
      this.tool.setTool('primitive'); // re-selecting the active kind toggles the tool off (setTool's own toggle rule)
      return;
    }
    this.primitiveTool.setKind(kind);
    if (this.tool.activeTool() !== 'primitive') this.tool.setTool('primitive');
  }

  filletChamferActive(): boolean {
    return this.tool.activeTool() === 'fillet-chamfer';
  }

  toggleFilletChamfer(): void {
    this.tool.setTool('fillet-chamfer');
  }

  patternActive(): boolean {
    return this.tool.activeTool() === 'pattern';
  }

  togglePattern(): void {
    this.tool.setTool('pattern');
  }

  mirrorActive(): boolean {
    return this.tool.activeTool() === 'mirror';
  }

  toggleMirror(): void {
    this.tool.setTool('mirror');
  }

  holeWizardActive(): boolean {
    return this.tool.activeTool() === 'hole-wizard';
  }

  toggleHoleWizard(): void {
    this.tool.setTool('hole-wizard');
  }

  referencePlaneActive(): boolean {
    return this.tool.activeTool() === 'reference-plane';
  }

  toggleReferencePlane(): void {
    this.tool.setTool('reference-plane');
  }

  shellActive(): boolean {
    return this.tool.activeTool() === 'shell';
  }

  toggleShell(): void {
    this.tool.setTool('shell');
  }

  draftActive(): boolean {
    return this.tool.activeTool() === 'draft';
  }

  toggleDraft(): void {
    this.tool.setTool('draft');
  }

  loftActive(): boolean {
    return this.tool.activeTool() === 'loft';
  }

  toggleLoft(): void {
    this.tool.setTool('loft');
  }

  toggleMeshView(): void {
    this.render.toggleMeshView();
  }

  toggleFeatureTreePanel(): void {
    this.featureTree.togglePanel();
  }

  toggleTransformMode(mode: TransformGizmoMode): void {
    this.objectTransform.toggleMode(mode);
  }

  clearMeasurements(): void {
    this.measurement.clear();
  }

  toggleSection(axis: SectionAxis): void {
    const wasEnabled = this.section.configs()[axis].enabled;
    this.history.run({
      label: `Section ${axis.toUpperCase()} ${wasEnabled ? 'off' : 'on'}`,
      redo: () => this.section.setEnabled(axis, !wasEnabled),
      undo: () => this.section.setEnabled(axis, wasEnabled)
    });
  }

  onExplodeChange(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.exploded.setAmount(value);
  }

  resetExplode(): void {
    this.exploded.reset();
  }

  // --- Undo/redo ---
  undo(): void {
    this.history.undo();
  }

  redo(): void {
    this.history.redo();
  }

  toggleHistoryDropdown(which: 'undo' | 'redo'): void {
    this.historyDropdown.set(this.historyDropdown() === which ? null : which);
  }

  /** Jumps to a clicked history entry by re-invoking undo()/redo() up to (and including) that index — reuses the existing single-step methods rather than adding a jump-to-index primitive to HistoryService. */
  jumpUndo(index: number): void {
    for (let i = 0; i <= index; i++) this.history.undo();
    this.historyDropdown.set(null);
  }

  jumpRedo(index: number): void {
    for (let i = 0; i <= index; i++) this.history.redo();
    this.historyDropdown.set(null);
  }

  // --- View toolbar behavior ---
  fitAll(): void {
    this.camera.fitAll();
  }

  resetCamera(): void {
    this.camera.resetCamera();
  }

  applyPreset(preset: ViewPreset): void {
    this.camera.applyViewPreset(preset);
  }

  setShading(mode: ShadingMode): void {
    this.render.setShadingMode(mode);
  }

  toggleGrid(): void {
    this.gridVisible = !this.gridVisible;
    this.viewer.setGridVisible(this.gridVisible);
  }

  toggleAxes(): void {
    this.axesVisible = !this.axesVisible;
    this.viewer.setAxesVisible(this.axesVisible);
  }

  toggleDarkMode(): void {
    this.render.toggleDarkMode();
  }

  toggleFullscreen(): void {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.();
    } else {
      document.exitFullscreen?.();
    }
  }

  screenshot(): void {
    this.render.downloadScreenshot();
  }

  toggleProjection(): void {
    const next = this.camera.projection() === 'perspective' ? 'orthographic' : 'perspective';
    this.camera.setProjection(next);
  }
}
