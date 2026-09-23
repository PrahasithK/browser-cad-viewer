import { Component, ElementRef, ViewChild, computed, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { ToolService } from '../../services/tool.service';
import { MeasurementService } from '../../services/measurement.service';
import { MeasureMode } from '../../models/measurement.model';
import { SectionService } from '../../services/section.service';
import { SketchService } from '../../services/sketch.service';
import { TreeService } from '../../services/tree.service';
import { StructuralToolService } from '../../services/structural-tool.service';
import { StructuralModelService } from '../../services/structural-model.service';
import { StructuralSolverService } from '../../services/structural-solver.service';
import { StructuralResultsRendererService, DiagramMode } from '../../services/structural-results-renderer.service';
import { BridgeMeshService } from '../../services/bridge-mesh.service';
import { PrimitiveToolService } from '../../services/primitive-tool.service';
import { FilletChamferToolService } from '../../services/fillet-chamfer-tool.service';
import { PatternToolService } from '../../services/pattern-tool.service';
import { MirrorToolService } from '../../services/mirror-tool.service';
import { HOLE_TYPE_LABELS, HoleWizardService } from '../../services/hole-wizard.service';
import { ReferencePlaneService } from '../../services/reference-plane.service';
import { ShellToolService } from '../../services/shell-tool.service';
import { DraftToolService } from '../../services/draft-tool.service';
import { LoftToolService } from '../../services/loft-tool.service';
import { FeatureTreeService } from '../../services/feature-tree.service';
import { HistoryService } from '../../services/history.service';
import { PanelLayoutService } from '../../services/panel-layout.service';
import { PanelDragHandle, PanelDragEvent } from '../../directives/panel-drag-handle.directive';
import { Icon } from '../icon/icon';
import { formatLength } from '../../utils/unit-conversion.util';
import { SectionAxis } from '../../models/section-plane.model';
import { FIXED_RESTRAINTS, PINNED_RESTRAINTS, DofRestraints } from '../../models/structural-model.model';
import { MemberUdlLoad, LoadCombinationFactor } from '../../models/structural-load.model';
import { AnalysisResult } from '../../models/structural-result.model';
import { PrimitiveDimensions } from '../../models/primitive-tool.model';
import { MirrorPlane } from '../../models/mirror-tool.model';
import { HoleFit, HoleStandard, holePresetsFor } from '../../models/hole-wizard.model';
import { FilletChamferEdgeValue, FilletChamferKind, HoleFeatureParams, HoleType } from '../../workers/step-worker-messages.model';
import { ReferencePlane } from '../../models/reference-plane.model';
import { RevolveAxis, SketchShape, SweepAxis } from '../../models/sketch.model';
import { DockMode, ToolPanelId } from '../../models/panel-layout.model';

type SupportType = 'none' | 'fixed' | 'pinned';

const DOCK_ZONE_PX = 40;

/**
 * The 6 floating, tool-specific panels (measure/section/sketch/structural/structural
 * results/bridge-mesh) that overlay the viewport while a tool is active. Merged from 6
 * separate components — each panel's markup, root class (`.measure-panel` etc.) and
 * `@if` gate condition are unchanged; only same-named members across the 6 original
 * classes were renamed (documented inline) to make them coexist in one class.
 */
@Component({
  selector: 'app-tool-panels',
  imports: [NgTemplateOutlet, PanelDragHandle, Icon],
  templateUrl: './tool-panels.html',
  styleUrl: './tool-panels.css'
})
export class ToolPanels {
  /** The canvas-overlay region (matches the shrunk canvas footprint once a panel is docked) — read by Viewport for renderer sizing/raycasting instead of the outer .viewport-container, which spans the docked columns too. */
  @ViewChild('canvasOverlay', { static: true }) canvasOverlayRef!: ElementRef<HTMLElement>;

  /** Which edge is currently highlighted as a drop target during an active drag, or null when not dragging/not near an edge. */
  readonly dockZoneHighlight = signal<'left' | 'right' | null>(null);

  // --- Measure ---
  readonly measureActive;
  readonly measurements;
  readonly measureMode;
  readonly measureHint;
  readonly measureError;
  readonly measureModes: { id: MeasureMode; label: string; title: string }[] = [
    { id: 'distance', label: 'Distance', title: 'Distance between two points' },
    { id: 'angle', label: 'Angle', title: 'Angle from three points (vertex in the middle)' },
    { id: 'face', label: 'Faces', title: 'Distance or angle between two planar faces' },
    { id: 'circle', label: 'Radius', title: 'Radius and diameter of a circular edge' }
  ];

  // --- Section ---
  readonly sectionConfigs;
  readonly sectionAxes: SectionAxis[] = ['x', 'y', 'z'];

  // --- Sketch ---
  readonly sketchState;
  readonly sketchBusy;
  readonly sketchLastError;
  sketchDepth = 10;
  sketchCut = false;
  /** Which finish operation the completed profile builds into — Extrude/Revolve (existing) or Sweep (new). A profile-level choice, not a separate tool, since all three share the exact same picking/drawing phase. */
  sketchFinishMode: 'extrude' | 'revolve' | 'sweep' = 'extrude';
  sketchRevolveAxis: RevolveAxis = 'u';
  sketchRevolveAngle = 360;
  sketchSweepAxis: SweepAxis = 'u';
  sketchSweepTiltDeg = 20;
  sketchSweepDistance = 10;

  // --- Structural (nodes/members/loads) ---
  readonly structuralToolActive;
  readonly structuralMode;
  readonly structuralElevation;
  readonly structuralNodes;
  readonly structuralMembers;
  readonly structuralSupports;
  readonly structuralLoadCases;
  readonly structuralCombinations;
  readonly structuralSolverError;

  newLoadCaseName = 'Dead Load';
  newLoadMemberId = '';
  newLoadCaseId = '';
  newLoadIntensity = 1000;
  newComboName = 'Combo 1';
  comboFactorCaseId = '';
  comboFactorValue = 1.2;
  pendingComboFactors: LoadCombinationFactor[] = [];

  // --- Structural results ---
  readonly structuralResults;
  readonly resultsSelectedResultId = signal<string | null>(null);
  readonly resultsDisplayMode = signal<DiagramMode>('none');
  readonly resultsDeflectionScale = signal(10);

  // --- Bridge mesh ---
  readonly bridgeMeshToolActive;
  readonly bridgeFirstPick;
  readonly bridgeSecondPick;
  readonly bridgeDensity;
  readonly bridgeErrorMessage;

  // --- Primitive shapes ---
  readonly primitiveState;
  readonly primitiveDimensions;
  readonly primitiveBusy;
  readonly primitiveError;

  // --- Fillet / Chamfer ---
  readonly filletChamferState;
  readonly filletChamferBusy;
  readonly filletChamferError;

  // --- Pattern ---
  readonly patternState;
  readonly patternError;
  readonly patternAxes: ('x' | 'y' | 'z')[] = ['x', 'y', 'z'];

  // --- Mirror ---
  readonly mirrorState;
  readonly mirrorError;
  readonly mirrorPlanes: MirrorPlane[] = ['XY', 'YZ', 'XZ'];

  // --- Hole Wizard ---
  readonly holeWizardState;
  readonly holeWizardBusy;
  readonly holeWizardError;

  // --- Reference Plane ---
  readonly referencePlaneToolState;
  readonly referencePlaneError;
  readonly storedReferencePlanes;
  readonly referencePlaneDatums: ('XY' | 'YZ' | 'XZ')[] = ['XY', 'YZ', 'XZ'];

  // --- Shell ---
  readonly shellState;
  readonly shellBusy;
  readonly shellError;

  // --- Draft ---
  readonly draftState;
  readonly draftBusy;
  readonly draftError;

  // --- Loft ---
  readonly loftState;
  readonly loftBusy;
  readonly loftError;

  // --- Feature Tree (parametric feature tree — Slice 1: Extrude, Slice 2: + Revolve, Slice 3: + Sweep) ---
  readonly featureTreeOpen;
  readonly featureTreeEntries;
  readonly featureTreeEditingId;
  featureEditDepth = 10;
  featureEditCut = false;
  featureEditAxis: RevolveAxis = 'u';
  featureEditAngle = 360;
  featureEditTiltDeg = 20;
  featureEditDistance = 10;
  /** Fillet/Chamfer's own edit-form state (Slice 5) — a repeating per-edge list, unlike the other four kinds' flat scalar fields, so it gets its own field rather than joining the shared featureEdit* set above. */
  featureEditFilletChamferKind: FilletChamferKind = 'fillet';
  featureEditEdges: FilletChamferEdgeValue[] = [];
  /** Hole's own edit-form state — a copy of the record's params, edited field by field. */
  featureEditHole: HoleFeatureParams | null = null;
  readonly featureEditBusy;
  readonly featureEditError;
  /** Only has an effect if the FIRST profile was sketched on an existing part's face — see LoftToolService.finishLoft's own docstring. */
  loftCut = false;

  constructor(
    private readonly tool: ToolService,
    private readonly measurement: MeasurementService,
    private readonly section: SectionService,
    private readonly sketch: SketchService,
    private readonly tree: TreeService,
    private readonly structuralTool: StructuralToolService,
    private readonly structuralModel: StructuralModelService,
    private readonly solver: StructuralSolverService,
    private readonly resultsRenderer: StructuralResultsRendererService,
    private readonly bridgeMesh: BridgeMeshService,
    private readonly primitiveTool: PrimitiveToolService,
    private readonly filletChamferTool: FilletChamferToolService,
    private readonly patternTool: PatternToolService,
    private readonly mirrorTool: MirrorToolService,
    private readonly holeWizardTool: HoleWizardService,
    private readonly referencePlaneTool: ReferencePlaneService,
    private readonly shellTool: ShellToolService,
    private readonly draftTool: DraftToolService,
    private readonly loftTool: LoftToolService,
    private readonly featureTree: FeatureTreeService,
    private readonly history: HistoryService,
    readonly layout: PanelLayoutService,
    private readonly host: ElementRef<HTMLElement>
  ) {
    this.measureActive = this.measurement.active;
    this.measurements = this.measurement.measurements;
    this.measureMode = this.measurement.mode;
    this.measureHint = this.measurement.hint;
    this.measureError = this.measurement.lastError;

    this.sectionConfigs = this.section.configs;

    this.sketchState = this.sketch.state;
    this.sketchBusy = this.sketch.busy;
    this.sketchLastError = this.sketch.lastError;

    this.structuralToolActive = () => this.tool.activeTool() === 'structural-node' || this.tool.activeTool() === 'structural-member';
    this.structuralMode = this.tool.activeTool;
    this.structuralElevation = this.structuralTool.workingPlaneElevation;
    this.structuralNodes = this.structuralModel.nodes;
    this.structuralMembers = this.structuralModel.members;
    this.structuralSupports = this.structuralModel.supports;
    this.structuralLoadCases = this.structuralModel.loadCases;
    this.structuralCombinations = this.structuralModel.combinations;
    this.structuralSolverError = this.solver.lastError;

    this.structuralResults = this.solver.lastResults;

    this.bridgeMeshToolActive = () => this.tool.activeTool() === 'bridge-mesh';
    this.bridgeFirstPick = this.bridgeMesh.firstPick;
    this.bridgeSecondPick = this.bridgeMesh.secondPick;
    this.bridgeDensity = this.bridgeMesh.density;
    this.bridgeErrorMessage = this.bridgeMesh.errorMessage;

    this.primitiveState = this.primitiveTool.state;
    this.primitiveDimensions = this.primitiveTool.dimensions;
    this.primitiveBusy = this.primitiveTool.busy;
    this.primitiveError = this.primitiveTool.lastError;

    this.filletChamferState = this.filletChamferTool.state;
    this.filletChamferBusy = this.filletChamferTool.busy;
    this.filletChamferError = this.filletChamferTool.lastError;

    this.patternState = this.patternTool.state;
    this.patternError = this.patternTool.lastError;

    this.mirrorState = this.mirrorTool.state;
    this.mirrorError = this.mirrorTool.lastError;

    this.holeWizardState = this.holeWizardTool.state;
    this.holeWizardBusy = this.holeWizardTool.busy;
    this.holeWizardError = this.holeWizardTool.lastError;

    this.referencePlaneToolState = this.referencePlaneTool.toolState;
    this.referencePlaneError = this.referencePlaneTool.lastError;
    this.storedReferencePlanes = this.referencePlaneTool.planes;

    this.shellState = this.shellTool.state;
    this.shellBusy = this.shellTool.busy;
    this.shellError = this.shellTool.lastError;

    this.draftState = this.draftTool.state;
    this.draftBusy = this.draftTool.busy;
    this.draftError = this.draftTool.lastError;

    this.loftState = this.loftTool.state;
    this.loftBusy = this.loftTool.busy;
    this.loftError = this.loftTool.lastError;

    this.featureTreeOpen = this.featureTree.panelOpen;
    this.featureTreeEntries = this.featureTree.entries;
    this.featureTreeEditingId = this.featureTree.editingFeatureId;
    // Slice 5: Fillet/Chamfer edits run through FilletChamferToolService's OWN busy/lastError
    // signals, not SketchService's (it isn't sketch-based at all) — branch on the currently-
    // editing record's kind so the panel shows the right service's state regardless of which
    // kind is open, same "one shared field set, one shared code path" convention the rest of
    // this panel already uses for featureEdit* fields.
    this.featureEditBusy = computed(() => {
      const record = this.featureTreeEditingId() ? this.featureTree.find(this.featureTreeEditingId()!) : undefined;
      if (record?.kind === 'filletChamfer') return this.filletChamferTool.busy();
      if (record?.kind === 'hole') return this.holeWizardTool.busy();
      return this.sketch.busy();
    });
    this.featureEditError = computed(() => {
      const record = this.featureTreeEditingId() ? this.featureTree.find(this.featureTreeEditingId()!) : undefined;
      if (record?.kind === 'filletChamfer') return this.filletChamferTool.lastError();
      if (record?.kind === 'hole') return this.holeWizardTool.lastError();
      return this.sketch.lastError();
    });
  }

  // --- Measure ---
  formatLength(mm: number): string {
    return formatLength(mm);
  }

  setMeasureMode(mode: MeasureMode): void {
    this.measurement.setMode(mode);
  }

  clearMeasurements(): void {
    this.measurement.clear();
  }

  closeMeasure(): void {
    // Route through ToolService (like every other panel's close button — see closeSketch/
    // closeStructural/closeBridgeMesh/closePrimitiveTool) rather than calling
    // MeasurementService.toggleActive() directly. Calling it directly desynced ToolService's
    // activeTool signal from MeasurementService.active: activeTool stayed 'measure' after this
    // button was clicked, so the next ribbon "Distance" click saw current === tool and treated
    // it as a toggle-OFF of an already-inactive tool, silently doing nothing.
    this.tool.setTool('none');
  }

  // --- Section ---
  sectionAnyEnabled(): boolean {
    const c = this.sectionConfigs();
    return c.x.enabled || c.y.enabled || c.z.enabled;
  }

  private sectionDragStartOffset: number | null = null;

  /** Live-updates the plane on every drag tick — no history entry per tick, only on release (see onSectionOffsetDragEnd). */
  onSectionOffsetChange(axis: SectionAxis, event: Event): void {
    this.section.setOffset(axis, Number((event.target as HTMLInputElement).value));
  }

  onSectionOffsetDragStart(axis: SectionAxis): void {
    this.sectionDragStartOffset = this.sectionConfigs()[axis].offset;
  }

  /** Fires once on slider release — coalesces the whole drag into a single undo step. */
  onSectionOffsetDragEnd(axis: SectionAxis): void {
    const oldOffset = this.sectionDragStartOffset;
    this.sectionDragStartOffset = null;
    const newOffset = this.sectionConfigs()[axis].offset;
    if (oldOffset === null || oldOffset === newOffset) return;

    this.history.run({
      label: `Section ${axis.toUpperCase()} offset`,
      redo: () => this.section.setOffset(axis, newOffset),
      undo: () => this.section.setOffset(axis, oldOffset)
    });
  }

  toggleSectionFlip(axis: SectionAxis): void {
    const cfg = this.sectionConfigs()[axis];
    const wasFlipped = cfg.flipped;
    this.history.run({
      label: `Flip section ${axis.toUpperCase()}`,
      redo: () => this.section.setFlipped(axis, !wasFlipped),
      undo: () => this.section.setFlipped(axis, wasFlipped)
    });
  }

  toggleSectionEnabled(axis: SectionAxis): void {
    const cfg = this.sectionConfigs()[axis];
    const wasEnabled = cfg.enabled;
    this.history.run({
      label: `Section ${axis.toUpperCase()} ${wasEnabled ? 'off' : 'on'}`,
      redo: () => this.section.setEnabled(axis, !wasEnabled),
      undo: () => this.section.setEnabled(axis, wasEnabled)
    });
  }

  // --- Sketch ---
  isSketchActive(): boolean {
    return this.tool.activeTool() === 'sketch';
  }

  /** Whether the picking-phase panel should also hint at clicking a face — datum-plane buttons stay available regardless (a global plane is still valid even inside an assembly). */
  hasPartsToSketchOn(): boolean {
    return this.tree.allBodies().length > 0;
  }

  pickSketchPlane(plane: 'XY' | 'YZ' | 'XZ'): void {
    void this.sketch.begin(plane);
  }

  setSketchShape(shape: SketchShape): void {
    this.sketch.setShape(shape);
  }

  onSketchParamChange(event: Event): void {
    this.sketch.setParam(Number((event.target as HTMLInputElement).value));
  }

  /** Explicit "Finish Polyline" button — a mouse-only alternative to double-click/Enter/click-back-on-start (see Viewport's own click/keydown handling for those). */
  closeSketchPolyline(): void {
    this.sketch.closePolyline();
  }

  canFinishSketch(): boolean {
    return this.sketch.canFinishSketch();
  }

  async extrudeSketch(): Promise<void> {
    try {
      await this.sketch.finishAndExtrude(this.sketchDepth, this.sketchCut);
      this.tool.setTool('none');
    } catch {
      // error is surfaced via sketch.lastError; keep the tool open so the user can retry
    }
  }

  setSketchFinishMode(mode: 'extrude' | 'revolve' | 'sweep'): void {
    this.sketchFinishMode = mode;
  }

  onSketchRevolveAxisChange(event: Event): void {
    this.sketchRevolveAxis = (event.target as HTMLSelectElement).value as RevolveAxis;
  }

  onSketchRevolveAngleChange(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value) && value > 0 && value <= 360) this.sketchRevolveAngle = value;
  }

  async revolveSketch(): Promise<void> {
    try {
      await this.sketch.finishAndRevolve(this.sketchRevolveAxis, this.sketchRevolveAngle, this.sketchCut);
      this.tool.setTool('none');
    } catch {
      // error is surfaced via sketch.lastError; keep the tool open so the user can retry
    }
  }

  onSketchSweepAxisChange(event: Event): void {
    this.sketchSweepAxis = (event.target as HTMLSelectElement).value as SweepAxis;
  }

  onSketchSweepTiltChange(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value) && value >= 0 && value < 90) this.sketchSweepTiltDeg = value;
  }

  onSketchSweepDistanceChange(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value) && value > 0) this.sketchSweepDistance = value;
  }

  async sweepSketch(): Promise<void> {
    try {
      await this.sketch.finishAndSweep(this.sketchSweepAxis, this.sketchSweepTiltDeg, this.sketchSweepDistance, this.sketchCut);
      this.tool.setTool('none');
    } catch {
      // error is surfaced via sketch.lastError; keep the tool open so the user can retry
    }
  }

  closeSketch(): void {
    this.sketch.cancel();
    this.tool.setTool('none');
  }

  onSketchDepthChange(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value) && value > 0) this.sketchDepth = value;
  }

  onSketchCutChange(event: Event): void {
    this.sketchCut = (event.target as HTMLInputElement).checked;
  }

  // --- Structural ---
  setStructuralMode(mode: 'structural-node' | 'structural-member'): void {
    this.tool.setTool(mode);
  }

  onElevationChange(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value)) this.structuralTool.workingPlaneElevation.set(value);
  }

  supportTypeFor(nodeId: string): SupportType {
    const support = this.structuralSupports().find((s) => s.nodeId === nodeId);
    if (!support) return 'none';
    if (support.restraints.rx && support.restraints.ry && support.restraints.rz) return 'fixed';
    return 'pinned';
  }

  onSupportTypeChange(nodeId: string, event: Event): void {
    const value = (event.target as HTMLSelectElement).value as SupportType;
    if (value === 'none') {
      this.structuralModel.removeSupport(nodeId);
      return;
    }
    const restraints: DofRestraints = value === 'fixed' ? FIXED_RESTRAINTS : PINNED_RESTRAINTS;
    this.structuralModel.addSupport(nodeId, restraints);
  }

  addLoadCase(): void {
    if (!this.newLoadCaseName.trim()) return;
    this.structuralModel.addLoadCase(this.newLoadCaseName.trim());
  }

  addMemberLoad(): void {
    if (!this.newLoadMemberId || !this.newLoadCaseId) return;
    const load: MemberUdlLoad = {
      id: `load-${Date.now()}`,
      type: 'member-udl',
      loadCaseId: this.newLoadCaseId,
      memberId: this.newLoadMemberId,
      intensity: this.newLoadIntensity
    };
    this.structuralModel.addLoad(load);
  }

  onIntensityChange(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value)) this.newLoadIntensity = value;
  }

  onComboFactorValueChange(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value)) this.comboFactorValue = value;
  }

  addComboFactor(): void {
    if (!this.comboFactorCaseId) return;
    this.pendingComboFactors = [...this.pendingComboFactors, { loadCaseId: this.comboFactorCaseId, factor: this.comboFactorValue }];
  }

  removeComboFactor(index: number): void {
    this.pendingComboFactors = this.pendingComboFactors.filter((_, i) => i !== index);
  }

  loadCaseName(id: string): string {
    return this.structuralLoadCases().find((c) => c.id === id)?.name ?? id;
  }

  saveCombination(): void {
    if (!this.newComboName.trim() || this.pendingComboFactors.length === 0) return;
    this.structuralModel.addCombination(this.newComboName.trim(), this.pendingComboFactors);
    this.pendingComboFactors = [];
  }

  runAnalysis(): void {
    try {
      this.solver.analyze();
    } catch {
      // surfaced via solver.lastError
    }
  }

  closeStructural(): void {
    this.tool.setTool('none');
  }

  // --- Structural results ---
  hasResults(): boolean {
    return (this.structuralResults()?.length ?? 0) > 0;
  }

  private selectedResult(): AnalysisResult | null {
    const id = this.resultsSelectedResultId();
    return this.structuralResults()?.find((r) => r.resultId === id) ?? null;
  }

  onResultChange(event: Event): void {
    this.resultsSelectedResultId.set((event.target as HTMLSelectElement).value || null);
    this.updateResultsRender();
  }

  onResultsModeChange(event: Event): void {
    this.resultsDisplayMode.set((event.target as HTMLSelectElement).value as DiagramMode);
    this.updateResultsRender();
  }

  onResultsScaleChange(event: Event): void {
    this.resultsDeflectionScale.set(Number((event.target as HTMLInputElement).value));
    this.updateResultsRender();
  }

  private updateResultsRender(): void {
    this.resultsRenderer.render(this.selectedResult(), this.resultsDisplayMode(), this.resultsDeflectionScale());
  }

  clearStructuralResults(): void {
    this.resultsDisplayMode.set('none');
    this.resultsRenderer.clear();
  }

  // --- Bridge mesh ---
  onBridgeDensityChange(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value)) this.bridgeMesh.setDensity(value);
  }

  clearBridgeMesh(): void {
    this.bridgeMesh.cancel();
  }

  closeBridgeMesh(): void {
    this.tool.setTool('none');
  }

  // --- Primitive shapes ---
  primitiveToolActive(): boolean {
    return this.tool.activeTool() === 'primitive';
  }

  onDimensionChange(key: keyof PrimitiveDimensions, event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.primitiveTool.setDimension(key, value);
  }

  async createPrimitive(): Promise<void> {
    try {
      await this.primitiveTool.commit();
      this.tool.setTool('none');
    } catch {
      // error is surfaced via primitiveTool.lastError; keep the tool open so the user can retry
    }
  }

  cancelPrimitivePlacement(): void {
    this.primitiveTool.cancel();
  }

  closePrimitiveTool(): void {
    this.tool.setTool('none');
  }

  // --- Fillet / Chamfer ---
  filletChamferToolActive(): boolean {
    return this.tool.activeTool() === 'fillet-chamfer';
  }

  setFilletChamferKind(kind: 'fillet' | 'chamfer'): void {
    this.filletChamferTool.setKind(kind);
  }

  onFilletChamferDefaultValueChange(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.filletChamferTool.setDefaultValue(value);
  }

  /** Per-edge radius/distance input, added 2026-09-13 for variable-radius fillet — sets ONE picked edge's own value, leaving every other picked edge's value untouched. */
  onFilletChamferEdgeValueChange(bodyId: string, edgeIndex: number, event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.filletChamferTool.setEdgeValue(bodyId, edgeIndex, value);
  }

  removeFilletChamferPick(bodyId: string, edgeIndex: number): void {
    const body = this.tree.allBodies().find((b) => b.id === bodyId);
    if (body) this.filletChamferTool.pickEdge(body, edgeIndex); // pickEdge toggles — re-picking an already-picked edge removes it
  }

  async commitFilletChamfer(): Promise<void> {
    try {
      await this.filletChamferTool.commit();
      this.tool.setTool('none');
    } catch {
      // error is surfaced via filletChamferTool.lastError; keep the tool open so the user can retry
    }
  }

  closeFilletChamfer(): void {
    this.tool.setTool('none');
  }

  // --- Pattern ---
  patternToolActive(): boolean {
    return this.tool.activeTool() === 'pattern';
  }

  patternTargetName(): string {
    return this.patternTool.targetBody()?.name ?? 'nothing selected';
  }

  setPatternKind(kind: 'linear' | 'circular'): void {
    this.patternTool.setKind(kind);
  }

  onPatternAxisChange(event: Event): void {
    this.patternTool.setAxis((event.target as HTMLSelectElement).value as 'x' | 'y' | 'z');
  }

  onPatternSpacingChange(event: Event): void {
    this.patternTool.setSpacing(Number((event.target as HTMLInputElement).value));
  }

  onPatternAngleChange(event: Event): void {
    this.patternTool.setTotalAngle(Number((event.target as HTMLInputElement).value));
  }

  onPatternCountChange(event: Event): void {
    this.patternTool.setCount(Number((event.target as HTMLInputElement).value));
  }

  canCommitPattern(): boolean {
    return this.patternTool.canCommit();
  }

  applyPattern(): void {
    try {
      this.patternTool.commit();
      this.tool.setTool('none');
    } catch {
      // error is surfaced via patternTool.lastError; keep the tool open so the user can retry
    }
  }

  closePattern(): void {
    this.tool.setTool('none');
  }

  // --- Mirror ---
  mirrorToolActive(): boolean {
    return this.tool.activeTool() === 'mirror';
  }

  mirrorTargetName(): string {
    return this.mirrorTool.targetBody()?.name ?? 'nothing selected';
  }

  onMirrorPlaneChange(event: Event): void {
    this.mirrorTool.setPlane((event.target as HTMLSelectElement).value as MirrorPlane);
  }

  canCommitMirror(): boolean {
    return this.mirrorTool.canCommit();
  }

  applyMirror(): void {
    try {
      this.mirrorTool.commit();
      this.tool.setTool('none');
    } catch {
      // error is surfaced via mirrorTool.lastError; keep the tool open so the user can retry
    }
  }

  closeMirror(): void {
    this.tool.setTool('none');
  }

  // --- Hole Wizard ---
  holeWizardActive(): boolean {
    return this.tool.activeTool() === 'hole-wizard';
  }

  holeWizardPhase(): string {
    return this.holeWizardState().phase;
  }

  holeWizardPresets() {
    return holePresetsFor(this.holeWizardState().standard);
  }

  onHoleWizardStandardChange(event: Event): void {
    this.holeWizardTool.setStandard((event.target as HTMLSelectElement).value as HoleStandard);
  }

  onHoleWizardPresetChange(event: Event): void {
    this.holeWizardTool.setPresetIndex(Number((event.target as HTMLSelectElement).value));
  }

  onHoleWizardFitChange(event: Event): void {
    this.holeWizardTool.setFit((event.target as HTMLSelectElement).value as HoleFit);
  }

  holeWizardDiameter(): number {
    return this.holeWizardTool.currentDiameter();
  }

  onHoleWizardTypeChange(event: Event): void {
    this.holeWizardTool.setHoleType((event.target as HTMLSelectElement).value as HoleType);
  }

  onHoleWizardEntrySizeChange(field: 'cboreDiameter' | 'cboreDepth' | 'csinkDiameter' | 'csinkAngleDeg', event: Event): void {
    this.holeWizardTool.setEntrySize(field, Number((event.target as HTMLInputElement).value));
  }

  holeWizardEntryError(): string | null {
    return this.holeWizardTool.entryError();
  }

  canCommitHoleWizard(): boolean {
    return this.holeWizardTool.canCommit();
  }

  applyHoleWizard(): void {
    this.holeWizardTool
      .commit()
      .then(() => this.tool.setTool('none'))
      .catch(() => {
        // error is surfaced via holeWizardTool.lastError; keep the tool open so the user can retry
      });
  }

  closeHoleWizard(): void {
    this.tool.setTool('none');
  }

  // --- Reference Plane ---
  referencePlaneToolActive(): boolean {
    return this.tool.activeTool() === 'reference-plane';
  }

  referencePlaneBaseLabel(): string {
    const base = this.referencePlaneToolState().base;
    if (!base) return '';
    if (base.kind === 'datum') return base.plane;
    return 'picked face';
  }

  pickReferencePlaneDatum(plane: 'XY' | 'YZ' | 'XZ'): void {
    this.referencePlaneTool.pickDatumBase(plane);
  }

  onReferencePlaneOffsetChange(event: Event): void {
    this.referencePlaneTool.setOffset(Number((event.target as HTMLInputElement).value));
  }

  onReferencePlaneNameChange(event: Event): void {
    this.referencePlaneTool.setName((event.target as HTMLInputElement).value);
  }

  canCommitReferencePlane(): boolean {
    return this.referencePlaneTool.canCommit();
  }

  applyReferencePlane(): void {
    try {
      this.referencePlaneTool.commit();
      this.tool.setTool('none');
    } catch {
      // error is surfaced via referencePlaneTool.lastError; keep the tool open so the user can retry
    }
  }

  restartReferencePlanePick(): void {
    this.referencePlaneTool.activate();
  }

  closeReferencePlane(): void {
    this.tool.setTool('none');
  }

  renameReferencePlane(plane: ReferencePlane, event: Event): void {
    this.referencePlaneTool.rename(plane.id, (event.target as HTMLInputElement).value);
  }

  toggleReferencePlaneVisible(plane: ReferencePlane): void {
    this.referencePlaneTool.toggleVisible(plane.id);
  }

  deleteReferencePlane(plane: ReferencePlane): void {
    this.referencePlaneTool.delete(plane.id);
  }

  /**
   * Starts a Sketch on a stored reference plane — resolves the plane's frame once and hands it to
   * SketchService.beginFromCustomPlane, the same entry point a datum/face pick uses, just
   * pre-resolved instead of picked live. Deliberately does NOT call `tool.setTool('sketch')`
   * directly: ToolService.setTool toggles the CURRENT tool off if it's already 'sketch' (e.g. the
   * Sketch panel's own datum-picker was left open) rather than re-entering it, which would leave
   * beginFromCustomPlane overwriting a just-deactivated SketchService's state. Forcing whatever
   * tool is active to 'none' first, unconditionally, guarantees the follow-up setTool('sketch')
   * always activates rather than toggles — the same explicit-reset-not-a-toggle shape
   * Viewport.onStepFileSelected already uses before a second STEP import.
   */
  sketchOnReferencePlane(plane: ReferencePlane): void {
    const frame = this.referencePlaneTool.resolve(plane.id);
    if (!frame) return;
    if (this.tool.activeTool() !== 'none') this.tool.setTool('none');
    this.tool.setTool('sketch');
    void this.sketch.beginFromCustomPlane(frame);
  }

  // --- Shell ---
  shellToolActive(): boolean {
    return this.tool.activeTool() === 'shell';
  }

  onShellThicknessChange(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.shellTool.setThickness(value);
  }

  removeShellPick(bodyId: string, faceIndex: number): void {
    const body = this.tree.allBodies().find((b) => b.id === bodyId);
    if (body) this.shellTool.pickFace(body, faceIndex); // pickFace toggles — re-picking an already-picked face removes it
  }

  canCommitShell(): boolean {
    return this.shellTool.canCommit();
  }

  async commitShell(): Promise<void> {
    try {
      await this.shellTool.commit();
      this.tool.setTool('none');
    } catch {
      // error is surfaced via shellTool.lastError; keep the tool open so the user can retry
    }
  }

  closeShell(): void {
    this.tool.setTool('none');
  }

  // --- Draft ---
  draftToolActive(): boolean {
    return this.tool.activeTool() === 'draft';
  }

  onDraftAngleChange(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.draftTool.setAngle(value);
  }

  removeDraftPick(bodyId: string, faceIndex: number): void {
    const body = this.tree.allBodies().find((b) => b.id === bodyId);
    if (body) this.draftTool.pickFace(body, faceIndex); // pickFace toggles — re-picking an already-picked face removes it
  }

  canCommitDraft(): boolean {
    return this.draftTool.canCommit();
  }

  async commitDraft(): Promise<void> {
    try {
      await this.draftTool.commit();
      this.tool.setTool('none');
    } catch {
      // error is surfaced via draftTool.lastError; keep the tool open so the user can retry
    }
  }

  closeDraft(): void {
    this.tool.setTool('none');
  }

  // --- Loft ---
  loftToolActive(): boolean {
    return this.tool.activeTool() === 'loft';
  }

  /** Same picking-plane/picking-face/drawing phase language Sketch's own panel copy uses — Loft is just SketchService's phase, read through the same signal, while Loft is the active tool. */
  loftSketchPhase(): 'picking-plane' | 'picking-face' | 'drawing' | 'ready' {
    return this.sketch.state().phase;
  }

  canAddLoftProfile(): boolean {
    return this.loftTool.canCommitCurrentProfile();
  }

  async addLoftProfile(): Promise<void> {
    try {
      await this.loftTool.addCurrentProfile();
    } catch {
      // error is surfaced via loftTool.lastError; keep the tool open so the user can retry
    }
  }

  removeLoftProfile(sketchId: string): void {
    this.loftTool.removeProfile(sketchId);
  }

  canFinishLoft(): boolean {
    return this.loftTool.canFinishLoft();
  }

  onLoftCutChange(event: Event): void {
    this.loftCut = (event.target as HTMLInputElement).checked;
  }

  async finishLoft(): Promise<void> {
    try {
      await this.loftTool.finishLoft(this.loftCut);
      this.tool.setTool('none');
    } catch {
      // error is surfaced via loftTool.lastError; keep the tool open so the user can retry
    }
  }

  closeLoft(): void {
    this.tool.setTool('none');
  }

  // --- Feature Tree (parametric feature tree — Slice 1: Extrude, Slice 2: + Revolve, Slice 3: + Sweep) ---
  closeFeatureTree(): void {
    this.featureTree.panelOpen.set(false);
    this.featureTree.cancelEdit();
  }

  /** Branches on the record's own `kind` to populate the matching edit-form fields — the panel keeps one shared `featureEdit*` field set (depth/cut for Extrude, axis/angle/cut for Revolve, axis/tilt/distance/cut for Sweep, cut only for Loft) rather than one per kind, same as the sketch panel's own existing Extrude/Revolve/Sweep field reuse. Fillet/Chamfer (Slice 5) populates its own separate `featureEditFilletChamferKind`/`featureEditEdges` fields instead — a repeating per-edge list, not a flat scalar set. */
  beginEditFeature(featureId: string): void {
    const record = this.featureTree.find(featureId);
    if (!record) return;
    if (record.kind === 'extrude') {
      this.featureEditDepth = record.params.depth;
      this.featureEditCut = record.params.cut;
    } else if (record.kind === 'revolve') {
      this.featureEditAxis = record.params.axis;
      this.featureEditAngle = record.params.angleDeg;
      this.featureEditCut = record.params.cut;
    } else if (record.kind === 'sweep') {
      this.featureEditAxis = record.params.axis;
      this.featureEditTiltDeg = record.params.tiltDeg;
      this.featureEditDistance = record.params.distance;
      this.featureEditCut = record.params.cut;
    } else if (record.kind === 'filletChamfer') {
      this.featureEditFilletChamferKind = record.params.filletChamferKind;
      this.featureEditEdges = record.params.edges.map((e) => ({ ...e }));
    } else if (record.kind === 'hole') {
      this.featureEditHole = { ...record.params };
    } else {
      this.featureEditCut = record.params.cut;
    }
    this.featureTree.beginEdit(featureId);
  }

  /** A hole's label starts with its type as created ("Counterbore (M6, normal)") — swap in the current type so the row stays right after an edit changes it. */
  holeRowLabel(label: string, holeType: HoleType): string {
    return label.replace(/^\S+/, HOLE_TYPE_LABELS[holeType]);
  }

  onFeatureEditHoleTypeChange(event: Event): void {
    if (this.featureEditHole) this.featureEditHole = { ...this.featureEditHole, holeType: (event.target as HTMLSelectElement).value as HoleType };
  }

  onFeatureEditHoleSizeChange(field: 'diameter' | 'cboreDiameter' | 'cboreDepth' | 'csinkDiameter' | 'csinkAngleDeg', event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (this.featureEditHole && Number.isFinite(value) && value > 0) this.featureEditHole = { ...this.featureEditHole, [field]: value };
  }

  /** Sets one edge's own value in the Feature Tree edit form's edge list — mirrors FilletChamferToolService.setEdgeValue's per-edge-independence, adapted for the edit-form's own local array instead of the tool panel's live picking state. */
  onFeatureEditEdgeValueChange(edgeIndex: number, event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (!Number.isFinite(value) || value <= 0) return;
    this.featureEditEdges = this.featureEditEdges.map((e) => (e.edgeIndex === edgeIndex ? { ...e, value } : e));
  }

  cancelEditFeature(): void {
    this.featureTree.cancelEdit();
  }

  onFeatureEditDepthChange(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value) && value > 0) this.featureEditDepth = value;
  }

  onFeatureEditCutChange(event: Event): void {
    this.featureEditCut = (event.target as HTMLInputElement).checked;
  }

  onFeatureEditAxisChange(event: Event): void {
    this.featureEditAxis = (event.target as HTMLSelectElement).value as RevolveAxis;
  }

  onFeatureEditAngleChange(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value) && value > 0 && value <= 360) this.featureEditAngle = value;
  }

  onFeatureEditTiltDegChange(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value) && value >= 0 && value < 90) this.featureEditTiltDeg = value;
  }

  onFeatureEditDistanceChange(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value) && value > 0) this.featureEditDistance = value;
  }

  /**
   * Dispatches to `SketchService.commitEditOfFeature`/`commitEditOfRevolveFeature`/
   * `commitEditOfSweepFeature` based on the record's own `kind` — the three sibling methods have
   * genuinely different param shapes, so this is the one place that needs to know all three.
   *
   * Also where Feature Tree edits join the Undo stack: `record.params` is read BEFORE the commit
   * call as `oldParams` (the record itself is what already serves as the "snapshot" — no separate
   * snapshot mechanism needed, since the worker's replay machinery can rebuild any feature's
   * geometry from just its own record at any time). The direct call already applies the edit; the
   * `history.run()` that follows only PUSHES the undo entry — its own internal `redo()` invocation
   * re-applies the same new params a second time, which is a harmless idempotent replay, not a
   * double-apply bug (same precedent `ObjectTransformService.commitDrag()` already established for
   * an already-applied async operation). `undo()`/`redo()` here are async closures — structurally
   * fine against `HistoryCommand`'s `(): void` signature; `HistoryService` doesn't await them,
   * same fire-and-forget shape as any other command whose effect happens to take time.
   */
  async applyFeatureEdit(): Promise<void> {
    const featureId = this.featureTree.editingFeatureId();
    if (!featureId) return;
    const record = this.featureTree.find(featureId);
    if (!record) return;
    const bodyName = this.tree.getBodyForNodeId(record.nodeId)?.name ?? record.label;
    try {
      if (record.kind === 'extrude') {
        const oldParams = record.params;
        const newParams = { depth: this.featureEditDepth, cut: this.featureEditCut };
        await this.sketch.commitEditOfFeature(featureId, newParams.depth, newParams.cut);
        this.history.run({
          label: `Edit Extrude: ${bodyName}`,
          redo: () => void this.sketch.commitEditOfFeature(featureId, newParams.depth, newParams.cut),
          undo: () => void this.sketch.commitEditOfFeature(featureId, oldParams.depth, oldParams.cut)
        });
      } else if (record.kind === 'revolve') {
        const oldParams = record.params;
        const newParams = { axis: this.featureEditAxis, angleDeg: this.featureEditAngle, cut: this.featureEditCut };
        await this.sketch.commitEditOfRevolveFeature(featureId, newParams.axis, newParams.angleDeg, newParams.cut);
        this.history.run({
          label: `Edit Revolve: ${bodyName}`,
          redo: () => void this.sketch.commitEditOfRevolveFeature(featureId, newParams.axis, newParams.angleDeg, newParams.cut),
          undo: () => void this.sketch.commitEditOfRevolveFeature(featureId, oldParams.axis, oldParams.angleDeg, oldParams.cut)
        });
      } else if (record.kind === 'sweep') {
        const oldParams = record.params;
        const newParams = { axis: this.featureEditAxis as SweepAxis, tiltDeg: this.featureEditTiltDeg, distance: this.featureEditDistance, cut: this.featureEditCut };
        await this.sketch.commitEditOfSweepFeature(featureId, newParams.axis, newParams.tiltDeg, newParams.distance, newParams.cut);
        this.history.run({
          label: `Edit Sweep: ${bodyName}`,
          redo: () => void this.sketch.commitEditOfSweepFeature(featureId, newParams.axis, newParams.tiltDeg, newParams.distance, newParams.cut),
          undo: () => void this.sketch.commitEditOfSweepFeature(featureId, oldParams.axis as SweepAxis, oldParams.tiltDeg, oldParams.distance, oldParams.cut)
        });
      } else if (record.kind === 'filletChamfer') {
        const oldParams = record.params;
        const newParams = { filletChamferKind: this.featureEditFilletChamferKind, edges: this.featureEditEdges.map((e) => ({ ...e })) };
        await this.filletChamferTool.commitEditOfFilletChamferFeature(featureId, newParams.filletChamferKind, newParams.edges);
        this.history.run({
          label: `Edit ${newParams.filletChamferKind === 'fillet' ? 'Fillet' : 'Chamfer'}: ${bodyName}`,
          redo: () => void this.filletChamferTool.commitEditOfFilletChamferFeature(featureId, newParams.filletChamferKind, newParams.edges),
          undo: () => void this.filletChamferTool.commitEditOfFilletChamferFeature(featureId, oldParams.filletChamferKind, oldParams.edges)
        });
      } else if (record.kind === 'hole') {
        if (!this.featureEditHole) return;
        const oldParams = record.params;
        const newParams = { ...this.featureEditHole };
        await this.holeWizardTool.commitEditOfHoleFeature(featureId, newParams);
        this.history.run({
          label: `Edit Hole: ${bodyName}`,
          redo: () => void this.holeWizardTool.commitEditOfHoleFeature(featureId, newParams),
          undo: () => void this.holeWizardTool.commitEditOfHoleFeature(featureId, oldParams)
        });
      } else {
        const oldParams = record.params;
        const newCut = this.featureEditCut;
        await this.sketch.commitEditOfLoftFeature(featureId, newCut);
        this.history.run({
          label: `Edit Loft: ${bodyName}`,
          redo: () => void this.sketch.commitEditOfLoftFeature(featureId, newCut),
          undo: () => void this.sketch.commitEditOfLoftFeature(featureId, oldParams.cut)
        });
      }
      this.featureTree.cancelEdit();
    } catch {
      // error surfaced via featureEditError (sketch.lastError); keep the edit form open to retry
    }
  }

  // --- Panel drag / dock (shared across all 12 floating panels) ---
  dockModeFor(id: ToolPanelId): DockMode {
    return this.layout.getLayout(id).mode;
  }

  private readonly panelVisibility: Record<ToolPanelId, () => boolean> = {
    measure: () => this.measureActive(),
    section: () => this.sectionAnyEnabled(),
    sketch: () => this.isSketchActive(),
    structural: () => this.structuralToolActive(),
    results: () => this.hasResults(),
    bridge: () => this.bridgeMeshToolActive(),
    primitive: () => this.primitiveToolActive(),
    filletChamfer: () => this.filletChamferToolActive(),
    pattern: () => this.patternToolActive(),
    mirror: () => this.mirrorToolActive(),
    holeWizard: () => this.holeWizardActive(),
    referencePlane: () => this.referencePlaneToolActive(),
    shell: () => this.shellToolActive(),
    draft: () => this.draftToolActive(),
    loft: () => this.loftToolActive(),
    featureTree: () => this.featureTreeOpen()
  };

  /** Whether any currently-visible panel is docked to the given side — used to collapse that grid column to zero width when empty. */
  hasDockedPanels(side: 'docked-left' | 'docked-right'): boolean {
    return (Object.keys(this.panelVisibility) as ToolPanelId[]).some(
      (id) => this.panelVisibility[id]() && this.dockModeFor(id) === side
    );
  }

  panelLeft(id: ToolPanelId): number | null {
    const layout = this.layout.getLayout(id);
    return layout.mode === 'floating' ? layout.x : null;
  }

  panelTop(id: ToolPanelId): number | null {
    const layout = this.layout.getLayout(id);
    return layout.mode === 'floating' ? layout.y : null;
  }

  onPanelDragMove(id: ToolPanelId, event: PanelDragEvent): void {
    this.layout.setPosition(id, event.x, event.y);
    this.dockZoneHighlight.set(this.edgeZoneFor(event.clientX));
  }

  onPanelDragEnd(id: ToolPanelId, event: PanelDragEvent): void {
    const zone = this.edgeZoneFor(event.clientX);
    this.dockZoneHighlight.set(null);
    if (zone === 'left') {
      this.layout.setDocked(id, 'docked-left');
    } else if (zone === 'right') {
      this.layout.setDocked(id, 'docked-right');
    } else {
      this.layout.setPosition(id, event.x, event.y);
    }
  }

  private edgeZoneFor(clientX: number): 'left' | 'right' | null {
    const rect = this.host.nativeElement.getBoundingClientRect();
    if (clientX - rect.left <= DOCK_ZONE_PX) return 'left';
    if (rect.right - clientX <= DOCK_ZONE_PX) return 'right';
    return null;
  }
}
