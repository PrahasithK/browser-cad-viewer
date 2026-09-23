import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, ViewChild, effect, signal } from '@angular/core';
import * as THREE from 'three';
import { ViewerService } from '../../services/viewer.service';
import { CameraService } from '../../services/camera.service';
import { RenderService } from '../../services/render.service';
import { StepLoaderService } from '../../services/step-loader.service';
import { DetachedBody, TreeService } from '../../services/tree.service';
import { SelectionService } from '../../services/selection.service';
import { PropertyService } from '../../services/property.service';
import { MeasurementService } from '../../services/measurement.service';
import { ToolService } from '../../services/tool.service';
import { SketchService } from '../../services/sketch.service';
import { SketchRendererService } from '../../services/sketch-renderer.service';
import { DimensionLabel } from '../../services/measurement.service';
import { StructuralToolService } from '../../services/structural-tool.service';
import { BridgeMeshService } from '../../services/bridge-mesh.service';
import { PrimitiveToolService } from '../../services/primitive-tool.service';
import { HistoryService } from '../../services/history.service';
import { ObjectTransformService } from '../../services/object-transform.service';
import { FilletChamferToolService } from '../../services/fillet-chamfer-tool.service';
import { HoleWizardService } from '../../services/hole-wizard.service';
import { ReferencePlaneService } from '../../services/reference-plane.service';
import { ReferencePlaneRendererService } from '../../services/reference-plane-renderer.service';
import { ShellToolService } from '../../services/shell-tool.service';
import { DraftToolService } from '../../services/draft-tool.service';
import { ProjectService } from '../../services/project.service';
import { ViewPreset } from '../../models/view-preset.model';
import { CadBody } from '../../models/cad-body.model';
import { SKETCH_SHAPE_POINT_COUNT, SketchShape } from '../../models/sketch.model';
import { ToolPanels } from '../tool-panels/tool-panels';
import { Icon } from '../icon/icon';
import { generateId } from '../../utils/id-generator.util';

/** Screen-space snap radius, in CSS pixels — a typical CAD snap tolerance, independent of zoom level since the check is done in screen space, not world space. */
const SNAP_PIXEL_THRESHOLD = 12;

const NAV_CUBE_FACE_LABELS: { preset: ViewPreset; normal: [number, number, number] }[] = [
  { preset: 'right', normal: [1, 0, 0] },
  { preset: 'left', normal: [-1, 0, 0] },
  { preset: 'back', normal: [0, 1, 0] },
  { preset: 'front', normal: [0, -1, 0] },
  { preset: 'top', normal: [0, 0, 1] },
  { preset: 'bottom', normal: [0, 0, -1] }
];

interface ContextMenuPosition {
  x: number;
  y: number;
}

/**
 * The 3D stage: canvas + interaction (unchanged) plus its permanent overlays —
 * navigation cube, STEP-load progress dialog, and right-click context menu — which
 * used to be 3 separate components. None of them touch the scene beyond calling
 * services Viewport already injects, so folding them in avoids re-injecting the same
 * services twice. Tool-specific floating panels (measure/sketch/structural/etc.) stay
 * a separate `ToolPanels` child so they still render inside `.viewport-container` and
 * keep their `position: absolute` anchoring.
 */
/** Screen-space drag threshold before a click is treated as a drag (i.e. orbit), not a click. Kept small — click detection should feel instant. */
const CLICK_DRAG_THRESHOLD_PX = 4;

/** Digit-key 1-7 → view preset, matching AppChrome's viewPresets button order exactly (Front/Back/Left/Right/Top/Bottom/Iso). */
const VIEW_PRESET_ORDER: ViewPreset[] = ['front', 'back', 'left', 'right', 'top', 'bottom', 'iso'];

@Component({
  selector: 'app-viewport',
  imports: [ToolPanels, Icon],
  templateUrl: './viewport.html',
  styleUrl: './viewport.css'
})
export class Viewport implements AfterViewInit, OnDestroy {
  @ViewChild('canvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('navCubeCanvas', { static: true }) navCubeCanvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('stepFileInput', { static: true }) stepFileInputRef!: ElementRef<HTMLInputElement>;
  @ViewChild('projectFileInput', { static: true }) projectFileInputRef!: ElementRef<HTMLInputElement>;
  @ViewChild(ToolPanels, { static: true }) toolPanels!: ToolPanels;

  private pointerDownPos: { x: number; y: number } | null = null;

  // --- Navigation cube ---
  private navCubeScene!: THREE.Scene;
  private navCubeCamera!: THREE.OrthographicCamera;
  private navCubeRenderer!: THREE.WebGLRenderer;
  private navCubeMesh!: THREE.Mesh;
  private navCubeUnsubscribe: (() => void) | null = null;
  private readonly navCubeRaycaster = new THREE.Raycaster();

  // --- Loading dialog ---
  readonly loadingProgress;
  readonly projectBusyMessage;
  get loadingVisible(): boolean {
    const phase = this.loadingProgress().phase;
    return phase !== 'idle' && phase !== 'done';
  }

  // --- Context menu ---
  readonly contextMenuPosition = signal<ContextMenuPosition | null>(null);

  // --- Dimension labels (in-viewport text for Distance measurements + selected body's overall size) ---
  readonly measurementLabels = signal<DimensionLabel[]>([]);
  readonly bodyDimensionLabels = signal<DimensionLabel[]>([]);
  private dimensionLabelsUnsubscribe: (() => void) | null = null;

  constructor(
    private readonly viewer: ViewerService,
    private readonly camera: CameraService,
    private readonly render: RenderService,
    private readonly stepLoader: StepLoaderService,
    private readonly tree: TreeService,
    private readonly selection: SelectionService,
    private readonly property: PropertyService,
    private readonly measurement: MeasurementService,
    private readonly tool: ToolService,
    private readonly sketch: SketchService,
    private readonly sketchRenderer: SketchRendererService,
    private readonly structuralTool: StructuralToolService,
    private readonly bridgeMesh: BridgeMeshService,
    private readonly primitiveTool: PrimitiveToolService,
    private readonly history: HistoryService,
    private readonly objectTransform: ObjectTransformService,
    private readonly filletChamferTool: FilletChamferToolService,
    private readonly holeWizard: HoleWizardService,
    private readonly referencePlaneTool: ReferencePlaneService,
    private readonly referencePlaneRenderer: ReferencePlaneRendererService,
    private readonly shellTool: ShellToolService,
    private readonly draftTool: DraftToolService,
    private readonly project: ProjectService
  ) {
    this.loadingProgress = this.stepLoader.progress;
    this.projectBusyMessage = this.project.busyMessage;

    // Keeps the transform gizmo attached to whichever body SelectionService currently considers
    // "primary" (selectedBodyId) — the gizmo follows selection automatically rather than needing
    // its own separate pick step, matching how SelectionService's own highlight box/gizmo already
    // follows selection. Reruns on every selection change; TransformControls.attach()/detach()
    // are cheap enough to call unconditionally rather than diffing against the previous body.
    effect(() => {
      const bodyId = this.selection.state().selectedBodyId;
      const body = bodyId ? this.tree.allBodies().find((b) => b.id === bodyId) : null;
      this.objectTransform.setAttachedBody(body ?? null);
    });

    // Suspends OrbitControls' rotate/pan/zoom for the duration of a gizmo drag — the same
    // suspend-camera-input-during-drag pattern the (now-removed) box-select feature used for its
    // own drag, so a gizmo drag never fights the camera for the same pointer input.
    effect(() => {
      const dragging = this.objectTransform.dragging();
      if (this.camera.controls) this.camera.controls.enabled = !dragging;
    });

    // CameraService.setProjection (toggled from AppChrome, not through Viewport) swaps which
    // camera OrbitControls drives — re-point the gizmo at the same camera so it doesn't keep
    // rendering/raycasting against a now-inactive one.
    effect(() => {
      this.camera.projection();
      this.objectTransform.syncCamera();
    });

    // Live preview of the reference-plane creation tool: reruns whenever the base pick or offset
    // changes (both live in the same toolState signal), rebuilding the preview quad each time —
    // same "cheap enough to fully rebuild" tradeoff ReferencePlaneRendererService's own stored-
    // plane sync already makes, at a much lower frequency than SketchRendererService's per-move
    // preview (this only fires on a discrete pick/field-edit, not on pointermove).
    effect(() => {
      this.referencePlaneTool.toolState();
      const frame = this.referencePlaneTool.previewFrame();
      this.referencePlaneRenderer.showPreview(frame);
    });
  }

  ngAfterViewInit(): void {
    const canvas = this.canvasRef.nativeElement;
    const container = this.toolPanels.canvasOverlayRef.nativeElement;

    this.viewer.init(canvas, container);
    this.camera.init(canvas, container);
    this.objectTransform.init(canvas);
    // Keeps the orange highlight box/gizmo and properties panel tracking the mesh live while a
    // transform drag is in progress, instead of visibly lagging until the drag ends.
    this.objectTransform.onDrag = () => this.syncSelectedBodyDuringTransform();

    this.initNavigationCube();
    this.initDimensionLabels();
  }

  /**
   * Keeps the highlight box/gizmo and properties panel tracking the mesh during a transform
   * drag. Uses SelectionService.refreshHighlightTransform (reposition only) rather than
   * selectMesh/toggleMesh — those rebuild the whole selection and would wrongly collapse an
   * active multi-select down to just the dragged body on every drag tick.
   */
  private syncSelectedBodyDuringTransform(): void {
    const bodyId = this.selection.state().selectedBodyId;
    if (!bodyId) return;
    this.selection.refreshHighlightTransform(bodyId);

    const body = this.tree.allBodies().find((b) => b.id === bodyId);
    if (body) this.property.showProperties(body);
  }

  // --- Keyboard shortcuts ---
  // Scene/tool/camera-scoped shortcuts live here (Viewport already injects everything needed);
  // Ctrl+Z/Ctrl+Y stay in AppChrome (added first, unrelated to canvas interaction). Same
  // input/textarea/contentEditable guard AppChrome's own handler already uses, so typing in any
  // field (rename inputs, numeric fields in tool panels, etc.) never triggers these.
  @HostListener('document:keydown', ['$event'])
  onDocumentKeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
    if (event.ctrlKey || event.metaKey || event.altKey) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        this.selection.selectAll();
        const primaryBodyId = this.selection.state().selectedBodyId;
        const body = primaryBodyId ? this.tree.allBodies().find((b) => b.id === primaryBodyId) : null;
        this.property.showProperties(body ?? null);
      }
      return;
    }

    switch (event.key) {
      case 'Escape':
        this.selection.clearSelection();
        this.property.showProperties(null);
        if (this.tool.activeTool() !== 'none') this.tool.setTool(this.tool.activeTool());
        this.objectTransform.disable();
        this.closeContextMenu();
        break;
      case 'Delete':
      case 'Backspace': {
        const nodeId = this.selection.state().selectedNodeId;
        if (nodeId) this.confirmAndDeletePart(nodeId);
        break;
      }
      case 'f':
      case 'F':
        this.camera.fitAll();
        break;
      case 'Enter': {
        // The third standard "finish the shape" gesture for a polyline, alongside a double-click
        // and clicking back near the start point (see handleSketchClick/onCanvasDoubleClick).
        const activeTool = this.tool.activeTool();
        if ((activeTool === 'sketch' || activeTool === 'loft') && this.isPolylineReadyToClose()) {
          this.sketch.closePolyline();
        }
        break;
      }
      case 'm':
      case 'M':
        this.tool.setTool('measure');
        break;
      case 's':
      case 'S':
        this.tool.setTool('sketch');
        break;
      case 'g':
      case 'G':
        this.objectTransform.toggleMode('translate');
        break;
      case 'r':
      case 'R':
        this.objectTransform.toggleMode('rotate');
        break;
      case 'y':
      case 'Y':
        this.objectTransform.toggleMode('scale');
        break;
      case '1':
      case '2':
      case '3':
      case '4':
      case '5':
      case '6':
      case '7': {
        const preset = VIEW_PRESET_ORDER[Number(event.key) - 1];
        if (preset) this.camera.applyViewPreset(preset);
        break;
      }
    }
  }

  // --- Dimension labels ---
  private initDimensionLabels(): void {
    this.dimensionLabelsUnsubscribe = this.viewer.onFrame(() => this.syncDimensionLabels());
  }

  private syncDimensionLabels(): void {
    // Cheap to always recompute (measurements list + selection are both tiny) — skip only when
    // there's nothing to show at all, so an idle scene with nothing selected pays no per-frame cost.
    const hasMeasurements = this.measurement.measurements().length > 0;
    const hasSelection = this.property.selectedSnapshot() !== null;
    if (!hasMeasurements && !hasSelection) {
      if (this.measurementLabels().length > 0) this.measurementLabels.set([]);
      if (this.bodyDimensionLabels().length > 0) this.bodyDimensionLabels.set([]);
      return;
    }
    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    const activeCamera = this.camera.getActiveCamera();
    this.measurementLabels.set(hasMeasurements ? this.measurement.labelPositions(activeCamera, rect) : []);
    this.bodyDimensionLabels.set(hasSelection ? this.property.selectedDimensionLabels(activeCamera, rect) : []);
  }

  /** "Open STEP…" entry point: opens the OS file picker so the user loads a file from their own folder. */
  promptImportStepFile(): void {
    this.stepFileInputRef.nativeElement.click();
  }

  /** "Open Project…" entry point — the project counterpart of `promptImportStepFile`. */
  promptOpenProjectFile(): void {
    this.projectFileInputRef.nativeElement.click();
  }

  async onProjectFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (file) await this.project.open(file);
  }

  async onStepFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = ''; // allow re-selecting the same file next time

    if (!file) return;

    try {
      // "Open" replaces the whole document (single-document convention) rather than appending —
      // TreeService.registerImport is append-by-design (it's what a future explicit "Import"
      // action would want). resetDocument also clears the Feature Tree, undo stack and modeling
      // session; before 2026-09-24 those survived an Open, so an old Undo or Feature Tree row
      // could reach into the new document.
      this.project.resetDocument();

      // Retain the File itself (not just its name) so a later sketch/cut on one of this
      // import's bodies can re-read the original STEP bytes — loadStepFileFromBlob's own
      // object URL is revoked immediately after load and can't be reused for that.
      this.tree.registerImport(file.name, file);
      const bodies = await this.stepLoader.loadStepFileFromBlob(file);
      this.addLoadedBodies(bodies);
      this.camera.fitAll();
    } catch (err) {
      console.error('Failed to import STEP file', err);
    }
  }

  private addLoadedBodies(bodies: CadBody[]): void {
    for (const body of bodies) {
      this.viewer.addBody(body.mesh);
      // true: these bodies come straight from the just-registered import's STEP parse, so their
      // solidIndex really is re-readable from that import's retained source — the one case
      // TreeNode.hasStepSource is meant to mark. Every other registerBody call site in the app
      // (primitives, sketch/extrude, Duplicate) leaves this at its default false.
      this.tree.registerBody(body, true);
    }
    this.render.setMeshView(this.render.meshView()); // sync newly created wireframe overlays to the current toggle state
  }

  onCanvasPointerDown(event: PointerEvent): void {
    this.pointerDownPos = { x: event.clientX, y: event.clientY };
  }

  onCanvasClick(event: MouseEvent): void {
    // TransformControls listens on the same canvas and doesn't stop propagation, so a click that
    // started on one of its handles would otherwise still reach handleSelectClick below and
    // raycast through the gizmo into whatever's behind it. dragging() covers an actual drag;
    // isGizmoHandleEngaged() also covers a plain click-release directly on a handle with no
    // movement, which dragging() alone wouldn't catch.
    if (this.objectTransform.dragging() || this.objectTransform.isGizmoHandleEngaged()) return;

    if (this.pointerDownPos) {
      const dx = event.clientX - this.pointerDownPos.x;
      const dy = event.clientY - this.pointerDownPos.y;
      if (Math.hypot(dx, dy) > CLICK_DRAG_THRESHOLD_PX) return; // was a drag/orbit, not a click
    }

    const canvas = this.canvasRef.nativeElement;
    const activeCamera = this.camera.getActiveCamera();

    switch (this.tool.activeTool()) {
      case 'measure':
        this.handleMeasureClick(event, canvas, activeCamera);
        return;
      case 'sketch':
      case 'loft':
        // Loft drives SketchService's own plane-pick/draw phases underneath (see
        // LoftToolService's own docstring) — the exact same click handling Sketch itself uses
        // works unchanged, since it reads sketch.state().phase directly rather than anything
        // Sketch-tool-specific.
        this.handleSketchClick(event, canvas, activeCamera);
        return;
      case 'structural-node':
        this.handleStructuralNodeClick(event, canvas, activeCamera);
        return;
      case 'structural-member':
        this.handleStructuralMemberClick(event, canvas, activeCamera);
        return;
      case 'bridge-mesh':
        this.handleBridgeMeshClick(event, canvas, activeCamera);
        return;
      case 'primitive':
        this.handlePrimitiveClick(event, canvas, activeCamera);
        return;
      case 'fillet-chamfer':
        this.handleFilletChamferClick(event, canvas, activeCamera);
        return;
      case 'hole-wizard':
        this.handleHoleWizardClick(event, canvas, activeCamera);
        return;
      case 'reference-plane':
        this.handleReferencePlaneClick(event, canvas, activeCamera);
        return;
      case 'shell':
        this.handleShellClick(event, canvas, activeCamera);
        return;
      case 'draft':
        this.handleDraftClick(event, canvas, activeCamera);
        return;
      default:
        this.handleSelectClick(event, canvas, activeCamera);
    }
  }

  private handleMeasureClick(event: MouseEvent, canvas: HTMLCanvasElement, activeCamera: THREE.Camera): void {
    switch (this.measurement.mode()) {
      case 'face': {
        const pick = this.selection.pickFace(event.clientX, event.clientY, canvas, activeCamera);
        if (pick) this.measurement.addFace(pick.body, pick.faceIndex);
        return;
      }
      case 'circle': {
        const pick = this.selection.pickEdge(event.clientX, event.clientY, canvas, activeCamera);
        if (pick) this.measurement.addCircle(pick.body, pick.edgeIndex);
        return;
      }
    }

    const hit = this.raycastPoint(event, canvas, activeCamera);
    if (hit) {
      this.measurement.addPoint({ position: hit.point, bodyId: hit.mesh.userData['bodyId'] ?? null, faceIndex: null });
    }
  }

  private handleSelectClick(event: MouseEvent, canvas: HTMLCanvasElement, activeCamera: THREE.Camera): void {
    const mesh = this.selection.pickAtClient(event.clientX, event.clientY, canvas, activeCamera);
    const additive = event.ctrlKey || event.shiftKey;
    this.selection.toggleMesh(mesh, additive);

    const primaryBodyId = this.selection.state().selectedBodyId;
    const body = primaryBodyId ? this.tree.allBodies().find((b) => b.id === primaryBodyId) : null;
    this.property.showProperties(body ?? null);
  }

  private handleSketchClick(event: MouseEvent, canvas: HTMLCanvasElement, activeCamera: THREE.Camera): void {
    const phase = this.sketch.state().phase;

    if (phase === 'picking-plane' || phase === 'picking-face') {
      // Mirrors handleBridgeMeshClick's face-pick pattern exactly: a face click during either
      // picking phase resolves the plane and jumps straight into drawing.
      const hit = this.selection.pickFace(event.clientX, event.clientY, canvas, activeCamera);
      if (hit) {
        void this.sketch.beginFromFace(hit.body, hit.faceIndex);
      } else {
        // A miss (empty canvas / non-planar background) during the picking phase is this tool's
        // only reachable "deselect" gesture — handleSelectClick never runs while Sketch is
        // active, so without this, clicking away has no way to clear a lingering selection.
        // Both selection and properties state need clearing (SelectionService's whole-mesh
        // highlight and PropertyService's snapshot are separate and don't sync each other).
        this.selection.clearSelection();
        this.property.showProperties(null);
      }
      return;
    }

    if (phase !== 'drawing') return;

    const worldPoint = this.raycastSketchPlane(event, canvas, activeCamera);
    if (!worldPoint) return;

    const snapped = this.resolveSnap(worldPoint, canvas, activeCamera);
    const uv = this.sketch.projectToPlane(snapped ?? worldPoint);
    if (!uv) return;

    if (this.sketch.state().shape === 'polyline') {
      const clickPx = this.screenPx(snapped ?? worldPoint, canvas, activeCamera);
      const points = this.sketch.state().points;

      // The browser fires a real click for BOTH presses of a double-click before the dblclick
      // event itself — without this, "double-click to finish" would silently add a spurious
      // near-duplicate point (a zero-length segment) right before closing. Ignore a click that
      // lands on top of the point just placed.
      const last = points.length > 0 ? this.sketch.uvToWorld(points[points.length - 1]) : null;
      if (last && this.screenPx(last, canvas, activeCamera).distanceTo(clickPx) < SNAP_PIXEL_THRESHOLD) return;

      // Clicking back near the start point is the other standard "finish the shape" gesture.
      if (this.isPolylineReadyToClose()) {
        const start = this.sketch.uvToWorld(points[0]);
        if (start && this.screenPx(start, canvas, activeCamera).distanceTo(clickPx) < SNAP_PIXEL_THRESHOLD) {
          this.sketch.closePolyline();
          return;
        }
      }
    }

    this.sketch.addPoint(uv);
  }

  private isPolylineReadyToClose(): boolean {
    const st = this.sketch.state();
    return st.shape === 'polyline' && !st.closed && st.points.length >= SKETCH_SHAPE_POINT_COUNT.polyline;
  }

  private screenPx(worldPoint: THREE.Vector3, canvas: HTMLCanvasElement, activeCamera: THREE.Camera): THREE.Vector2 {
    const rect = canvas.getBoundingClientRect();
    const ndc = worldPoint.clone().project(activeCamera);
    return new THREE.Vector2(((ndc.x + 1) / 2) * rect.width, ((1 - ndc.y) / 2) * rect.height);
  }

  /**
   * Handles two per-move concerns, each cheap and independently gated: (1) status-bar cursor
   * world-coordinates, updated on every move regardless of tool; (2) sketch snap/preview feedback
   * (unchanged from before), gated to the sketch tool's drawing phase only.
   */
  onCanvasPointerMove(event: PointerEvent): void {
    this.updateCursorWorldPos(event);

    if (this.tool.activeTool() === 'fillet-chamfer') {
      const canvas = this.canvasRef.nativeElement;
      const activeCamera = this.camera.getActiveCamera();
      const hit = this.selection.pickEdge(event.clientX, event.clientY, canvas, activeCamera);
      this.filletChamferTool.showHover(hit?.body ?? null, hit?.edgeIndex ?? null);
      return;
    }

    if (this.tool.activeTool() === 'shell') {
      const canvas = this.canvasRef.nativeElement;
      const activeCamera = this.camera.getActiveCamera();
      const hit = this.selection.pickFace(event.clientX, event.clientY, canvas, activeCamera);
      this.shellTool.showHover(hit?.body ?? null, hit?.faceIndex ?? null);
      return;
    }

    if (this.tool.activeTool() === 'draft') {
      const canvas = this.canvasRef.nativeElement;
      const activeCamera = this.camera.getActiveCamera();
      const hit = this.selection.pickFace(event.clientX, event.clientY, canvas, activeCamera);
      this.draftTool.showHover(hit?.body ?? null, hit?.faceIndex ?? null);
      return;
    }

    if (this.tool.activeTool() === 'hole-wizard' && this.holeWizard.state().phase === 'picking-point') {
      const canvas = this.canvasRef.nativeElement;
      const activeCamera = this.camera.getActiveCamera();
      const worldPoint = this.raycastHoleWizardPlane(event, canvas, activeCamera);
      if (!worldPoint) {
        this.sketchRenderer.showSnapIndicator(null);
        return;
      }
      const snapped = this.resolveHoleWizardSnap(worldPoint, canvas, activeCamera);
      this.sketchRenderer.showSnapIndicator(snapped ?? null);
      return;
    }

    const isSketchOrLoft = this.tool.activeTool() === 'sketch' || this.tool.activeTool() === 'loft';
    if (!isSketchOrLoft || this.sketch.state().phase !== 'drawing') return;

    const canvas = this.canvasRef.nativeElement;
    const activeCamera = this.camera.getActiveCamera();
    const worldPoint = this.raycastSketchPlane(event, canvas, activeCamera);
    if (!worldPoint) {
      this.sketchRenderer.showSnapIndicator(null);
      return;
    }

    const snapped = this.resolveSnap(worldPoint, canvas, activeCamera);
    this.sketchRenderer.showSnapIndicator(snapped ?? null);

    const st = this.sketch.state();
    if (!st.facePlane) return;
    const uv = this.sketch.projectToPlane(snapped ?? worldPoint);
    if (!uv) return;

    const previewPoints = [...st.points, uv];
    if (previewPoints.length < 1) return;
    this.sketchRenderer.showPreview(this.hypotheticalPreviewEntities(st.shape, previewPoints, st.param), {
      origin: new THREE.Vector3(...st.facePlane.origin),
      uAxis: new THREE.Vector3(...st.facePlane.uAxis),
      vAxis: new THREE.Vector3(...st.facePlane.vAxis)
    });
  }

  /** Feeds ViewerService.cursorWorldPos (status-bar display) from a raycast against whatever's under the cursor — a body if one's there, otherwise the Z=0 ground plane, so the readout is never blank over empty space. */
  private updateCursorWorldPos(event: PointerEvent): void {
    const canvas = this.canvasRef.nativeElement;
    const activeCamera = this.camera.getActiveCamera();
    const hit = this.raycastPoint(event, canvas, activeCamera);
    if (hit) {
      this.viewer.cursorWorldPos.set(hit.point);
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, activeCamera);
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const worldPoint = new THREE.Vector3();
    this.viewer.cursorWorldPos.set(raycaster.ray.intersectPlane(groundPlane, worldPoint) ? worldPoint : null);
  }

  /** Raycasts against the sketch plane using its actual world-space origin (fixes a prior bug that always assumed distance 0 from the world origin, wrong for a datum plane with a nonzero offset and for any face plane). */
  private raycastSketchPlane(event: MouseEvent, canvas: HTMLCanvasElement, activeCamera: THREE.Camera): THREE.Vector3 | null {
    const normal = this.sketch.planeNormal();
    const origin = this.sketch.planeOrigin();
    if (!normal || !origin) return null;

    const rect = canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, activeCamera);

    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin);
    const worldPoint = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(plane, worldPoint)) return worldPoint;

    // Ray parallel to the sketch plane — the same THREE.Ray.intersectPlane behavior
    // handlePrimitiveClick's own fallback documents (a real, genuine miss, not a degenerate zero
    // point). Reachable for a sketch plane too: e.g. picking a face (which orients the camera
    // normal to it via CameraService.animateToFace), then switching a Loft's next profile to a
    // datum plane roughly edge-on to that same camera orientation, with no re-orientation between
    // the two — the click ray from screen center then has ~zero component along the datum's
    // normal. Found via Playwright while verifying Loft's own face-anchoring fix (a Loft profile
    // on the XZ datum right after a Z-normal face pick reproduced it on the very first attempt).
    // Fall back to the camera's own view plane through the SKETCH plane's origin (not the world
    // origin, so the fallback point stays spatially close to the real plane) — guaranteed
    // non-parallel to any ray the camera can cast, since the view plane's normal IS the camera's
    // own look direction. `projectToPlane` below discards whatever out-of-plane component this
    // introduces via its own dot-product math, so the result is still the correct (u, v) for
    // wherever the cursor visually points.
    const viewNormal = new THREE.Vector3();
    activeCamera.getWorldDirection(viewNormal);
    const viewPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(viewNormal, origin);
    return raycaster.ray.intersectPlane(viewPlane, worldPoint) ? worldPoint : null;
  }

  /** Finds the nearest cached reference point within a fixed screen-space pixel threshold, or null if none qualifies. Snapping overrides the raw raycast hit entirely, not just visually. */
  private resolveSnap(worldPoint: THREE.Vector3, canvas: HTMLCanvasElement, activeCamera: THREE.Camera): THREE.Vector3 | null {
    const referencePoints = this.sketch.state().referencePoints;
    if (referencePoints.length === 0) return null;

    const rect = canvas.getBoundingClientRect();
    const toScreenPx = (p: THREE.Vector3): THREE.Vector2 => {
      const ndc = p.clone().project(activeCamera);
      return new THREE.Vector2(((ndc.x + 1) / 2) * rect.width, ((1 - ndc.y) / 2) * rect.height);
    };

    const cursorPx = toScreenPx(worldPoint);
    let nearest: THREE.Vector3 | null = null;
    let nearestDist = SNAP_PIXEL_THRESHOLD;

    for (const ref of referencePoints) {
      const refPoint = new THREE.Vector3(...ref.position);
      const dist = toScreenPx(refPoint).distanceTo(cursorPx);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = refPoint;
      }
    }
    return nearest;
  }

  /** Builds a hypothetical entity list for live preview — same shape-building logic SketchService.buildEntities uses, applied to points-so-far plus the current cursor position. */
  private hypotheticalPreviewEntities(shape: SketchShape, points: [number, number][], param: number) {
    if (shape === 'polyline') {
      // Open chain while still drawing (not closed back to the start — that's only true once the
      // profile is actually finished): one committed segment per already-placed point, plus a
      // rubber-band segment from the last placed point to the cursor.
      if (points.length < 2) return null;
      return points.slice(0, -1).map((p, i) => ({
        type: 'line' as const,
        id: `preview-${i}`,
        points: [p, points[i + 1]] as [[number, number], [number, number]]
      }));
    }
    if (points.length < 2) return null;
    const [p1, p2] = points;
    const radius = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);

    switch (shape) {
      case 'rectangle': {
        const [x1, y1] = p1;
        const [x2, y2] = p2;
        const corners: [number, number][] = [
          [x1, y1],
          [x2, y1],
          [x2, y2],
          [x1, y2]
        ];
        return corners.map((_, i) => ({
          type: 'line' as const,
          id: `preview-${i}`,
          points: [corners[i], corners[(i + 1) % 4]] as [[number, number], [number, number]]
        }));
      }
      case 'circle':
        return [{ type: 'circle' as const, id: 'preview-circle', center: p1, radius }];
      case 'polygon':
        return [{ type: 'polygon' as const, id: 'preview-polygon', center: p1, radius, sides: Math.round(param) }];
      case 'slot':
        return [{ type: 'slot' as const, id: 'preview-slot', start: p1, end: p2, width: param }];
    }
  }

  private handleStructuralNodeClick(event: MouseEvent, canvas: HTMLCanvasElement, activeCamera: THREE.Camera): void {
    const rect = canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, activeCamera);

    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -this.structuralTool.workingPlaneElevation());
    const worldPoint = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(plane, worldPoint)) return;

    this.structuralTool.placeNodeOnWorkingPlane(worldPoint.x, worldPoint.y);
  }

  private handleStructuralMemberClick(event: MouseEvent, canvas: HTMLCanvasElement, activeCamera: THREE.Camera): void {
    const nodeId = this.structuralTool.pickNodeNear(event.clientX, event.clientY, canvas, activeCamera);
    if (nodeId) this.structuralTool.handleMemberClickTarget(nodeId);
  }

  private handleBridgeMeshClick(event: MouseEvent, canvas: HTMLCanvasElement, activeCamera: THREE.Camera): void {
    const hit = this.selection.pickFace(event.clientX, event.clientY, canvas, activeCamera);
    if (hit) this.bridgeMesh.handlePick(hit.body, hit.faceIndex);
  }

  private handlePrimitiveClick(event: MouseEvent, canvas: HTMLCanvasElement, activeCamera: THREE.Camera): void {
    const hit = this.raycastPoint(event, canvas, activeCamera);
    if (hit) {
      this.primitiveTool.placeAt(hit.point.x, hit.point.y, hit.point.z);
      return;
    }

    // No body under the cursor — fall back to the ground plane (Z=0) so primitives can be
    // placed into empty space, not just on top of existing geometry.
    //
    // Bug found via Playwright during the 2026-09-10 Reference Plane pass: THREE.Ray.
    // intersectPlane returns null (not a degenerate/zero point — a genuine miss) whenever the
    // ray is parallel to the plane, which happens for real whenever the camera is looking
    // exactly horizontally at the Z=0 ground plane — the same camera orientation
    // CameraService.animateToFace produces for ANY vertical sketch plane (YZ/XZ datum, or a
    // Reference Plane built on either) whose origin sits at Z=0, since the ray from screen
    // center then has zero Z-component too. Before this fix, a primitive placed in empty space
    // right after sketching on such a plane (then canceling) silently did nothing — the "Add
    // Box"-style panel stayed on "Click the viewport…" forever with no error, because this
    // fallback's own null case was never handled: a miss here just fell through with no primitive
    // placed and no feedback. Falling back further to the currently-active sketch/reference plane
    // itself (whatever the camera was just aimed at) resolves the same click the user obviously
    // intended, instead of leaving the tool silently stuck.
    const rect = canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, activeCamera);
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const worldPoint = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(groundPlane, worldPoint)) {
      this.primitiveTool.placeAt(worldPoint.x, worldPoint.y, worldPoint.z);
      return;
    }

    // Ground-plane ray was parallel (see note above) — fall back to intersecting the camera's
    // own view plane through the world origin, guaranteed non-parallel to any ray the active
    // camera can actually cast (the ray direction and the view-plane normal can only be
    // perpendicular, never parallel, since the view plane's normal IS the camera's look
    // direction).
    const viewNormal = new THREE.Vector3();
    activeCamera.getWorldDirection(viewNormal);
    const viewPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(viewNormal, new THREE.Vector3(0, 0, 0));
    if (raycaster.ray.intersectPlane(viewPlane, worldPoint)) {
      this.primitiveTool.placeAt(worldPoint.x, worldPoint.y, worldPoint.z);
    }
  }

  private handleFilletChamferClick(event: MouseEvent, canvas: HTMLCanvasElement, activeCamera: THREE.Camera): void {
    const hit = this.selection.pickEdge(event.clientX, event.clientY, canvas, activeCamera);
    if (hit) this.filletChamferTool.pickEdge(hit.body, hit.edgeIndex);
  }

  /** Face-picking analogue of handleFilletChamferClick — Shell picks faces to remove, not edges, so it reuses SelectionService.pickFace (the same face-resolution Sketch/Reference-Plane/Hole-Wizard already use) instead of pickEdge. */
  private handleShellClick(event: MouseEvent, canvas: HTMLCanvasElement, activeCamera: THREE.Camera): void {
    const hit = this.selection.pickFace(event.clientX, event.clientY, canvas, activeCamera);
    if (hit) this.shellTool.pickFace(hit.body, hit.faceIndex);
  }

  /** Face-picking analogue of handleShellClick — Draft, like Shell, picks faces via SelectionService.pickFace with no separate configuration click. */
  private handleDraftClick(event: MouseEvent, canvas: HTMLCanvasElement, activeCamera: THREE.Camera): void {
    const hit = this.selection.pickFace(event.clientX, event.clientY, canvas, activeCamera);
    if (hit) this.draftTool.pickFace(hit.body, hit.faceIndex);
  }

  /** Mirrors handleSketchClick's own two-phase shape (face-pick, then a point-on-plane click) — deliberately a separate method reading from HoleWizardService rather than generalizing handleSketchClick/raycastSketchPlane/resolveSnap to take an arbitrary plane-source, so Sketch's own click handling can't regress from a refactor this feature doesn't need. */
  private handleHoleWizardClick(event: MouseEvent, canvas: HTMLCanvasElement, activeCamera: THREE.Camera): void {
    const phase = this.holeWizard.state().phase;

    if (phase === 'picking-face') {
      const hit = this.selection.pickFace(event.clientX, event.clientY, canvas, activeCamera);
      if (hit) {
        void this.holeWizard.beginFromFace(hit.body, hit.faceIndex);
      } else {
        // Same "miss is this tool's only reachable deselect gesture" reasoning as Sketch's own
        // picking-phase branch — handleSelectClick never runs while Hole Wizard is active.
        this.selection.clearSelection();
        this.property.showProperties(null);
      }
      return;
    }

    if (phase !== 'picking-point') return;

    const worldPoint = this.raycastHoleWizardPlane(event, canvas, activeCamera);
    if (!worldPoint) return;

    const snapped = this.resolveHoleWizardSnap(worldPoint, canvas, activeCamera);
    const uv = this.holeWizard.projectToPlane(snapped ?? worldPoint);
    if (uv) this.holeWizard.setCenter(uv);
  }

  /**
   * Reference Plane's only viewport interaction: picking a face as the offset base — an
   * alternative to the panel's own datum-plane buttons (XY/YZ/XZ), not a second click phase like
   * Sketch/Hole Wizard have. Once a base is picked (via either path) the rest of configuration
   * (offset/name/commit) happens entirely in the panel, so further canvas clicks are a no-op
   * until the tool is reset — checked via `toolState().base === null` rather than a dedicated
   * phase field, since there's nothing else for a click to do once a base exists.
   */
  private handleReferencePlaneClick(event: MouseEvent, canvas: HTMLCanvasElement, activeCamera: THREE.Camera): void {
    if (this.referencePlaneTool.toolState().base !== null) return;

    const hit = this.selection.pickFace(event.clientX, event.clientY, canvas, activeCamera);
    if (hit) {
      this.referencePlaneTool.pickFaceBase(hit.body, hit.faceIndex);
    } else {
      // Same "miss is this tool's only reachable deselect gesture" reasoning as Sketch/Hole
      // Wizard's own picking-phase branches — handleSelectClick never runs while this tool is
      // active.
      this.selection.clearSelection();
      this.property.showProperties(null);
    }
  }

  /** Same raycast-against-the-picked-plane technique raycastSketchPlane uses, reading HoleWizardService's plane instead of SketchService's. */
  private raycastHoleWizardPlane(event: MouseEvent, canvas: HTMLCanvasElement, activeCamera: THREE.Camera): THREE.Vector3 | null {
    const normal = this.holeWizard.planeNormal();
    const origin = this.holeWizard.planeOrigin();
    if (!normal || !origin) return null;

    const rect = canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, activeCamera);

    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin);
    const worldPoint = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(plane, worldPoint)) return null;
    return worldPoint;
  }

  /** Same nearest-reference-point-in-screen-space technique resolveSnap uses, reading HoleWizardService's reference points instead of SketchService's — lets a hole center snap to an existing edge midpoint/vertex/circle-center the same way a sketch profile point does. */
  private resolveHoleWizardSnap(worldPoint: THREE.Vector3, canvas: HTMLCanvasElement, activeCamera: THREE.Camera): THREE.Vector3 | null {
    const referencePoints = this.holeWizard.state().referencePoints;
    if (referencePoints.length === 0) return null;

    const rect = canvas.getBoundingClientRect();
    const toScreenPx = (p: THREE.Vector3): THREE.Vector2 => {
      const ndc = p.clone().project(activeCamera);
      return new THREE.Vector2(((ndc.x + 1) / 2) * rect.width, ((1 - ndc.y) / 2) * rect.height);
    };

    const cursorPx = toScreenPx(worldPoint);
    let nearest: THREE.Vector3 | null = null;
    let nearestDist = SNAP_PIXEL_THRESHOLD;

    for (const ref of referencePoints) {
      const refPoint = new THREE.Vector3(...ref.position);
      const dist = toScreenPx(refPoint).distanceTo(cursorPx);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = refPoint;
      }
    }
    return nearest;
  }

  onCanvasDoubleClick(event: MouseEvent): void {
    // While drawing a polyline, double-click is the standard "finish the shape" gesture — takes
    // priority over the default zoom-to-fit-part behavior, which would otherwise fire on every
    // second click of a fast-clicked polyline too.
    const activeTool = this.tool.activeTool();
    if ((activeTool === 'sketch' || activeTool === 'loft') && this.isPolylineReadyToClose()) {
      this.sketch.closePolyline();
      return;
    }

    const canvas = this.canvasRef.nativeElement;
    const activeCamera = this.camera.getActiveCamera();
    const mesh = this.selection.pickAtClient(event.clientX, event.clientY, canvas, activeCamera);
    if (mesh) {
      const box = new THREE.Box3().setFromObject(mesh);
      this.camera.fitToBox(box, 1.6);
    }
  }

  private raycastPoint(
    event: { clientX: number; clientY: number },
    canvas: HTMLCanvasElement,
    activeCamera: THREE.Camera
  ): { point: THREE.Vector3; mesh: THREE.Mesh } | null {
    const rect = canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, activeCamera);
    const intersects = raycaster.intersectObjects(this.viewer.getBodyGroup().children, true);
    const hit = intersects.find((i) => i.object instanceof THREE.Mesh && i.object.visible);
    if (!hit) return null;
    return { point: hit.point, mesh: hit.object as THREE.Mesh };
  }

  // --- Navigation cube ---
  private initNavigationCube(): void {
    const canvas = this.navCubeCanvasRef.nativeElement;
    const size = 96;

    this.navCubeScene = new THREE.Scene();
    this.navCubeCamera = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 10);
    this.navCubeCamera.position.set(0, -3.2, 0);
    this.navCubeCamera.up.set(0, 0, 1);
    this.navCubeCamera.lookAt(0, 0, 0);

    this.navCubeRenderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.navCubeRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.navCubeRenderer.setSize(size, size, false);

    this.navCubeScene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const dir = new THREE.DirectionalLight(0xffffff, 0.6);
    dir.position.set(2, -2, 3);
    this.navCubeScene.add(dir);

    const materials = NAV_CUBE_FACE_LABELS.map(
      () =>
        new THREE.MeshStandardMaterial({
          color: 0x3a3c42,
          roughness: 0.6,
          metalness: 0.1
        })
    );
    const geometry = new THREE.BoxGeometry(1.6, 1.6, 1.6);
    this.navCubeMesh = new THREE.Mesh(geometry, materials);
    this.navCubeScene.add(this.navCubeMesh);

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({ color: 0x8a8c92 })
    );
    this.navCubeMesh.add(edges);

    this.navCubeUnsubscribe = this.viewer.onFrame(() => this.syncNavCubeOrientation());
    this.navCubeRenderLoop();
  }

  private syncNavCubeOrientation(): void {
    const mainCamera = this.camera.getActiveCamera();
    if (!mainCamera || !this.navCubeMesh) return;
    this.navCubeMesh.quaternion.copy(mainCamera.quaternion).invert();
  }

  private navCubeRenderLoop(): void {
    requestAnimationFrame(() => this.navCubeRenderLoop());
    this.navCubeRenderer?.render(this.navCubeScene, this.navCubeCamera);
  }

  onNavCubeClick(event: MouseEvent): void {
    const canvas = this.navCubeCanvasRef.nativeElement;
    const rect = canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    this.navCubeRaycaster.setFromCamera(pointer, this.navCubeCamera);
    const hits = this.navCubeRaycaster.intersectObject(this.navCubeMesh);
    if (hits.length === 0) return;

    const faceIndex = hits[0].face?.materialIndex ?? 0;
    const preset = NAV_CUBE_FACE_LABELS[faceIndex]?.preset ?? 'iso';
    this.camera.applyViewPreset(preset);
  }

  applyNavCubeIso(): void {
    this.camera.applyViewPreset('iso');
  }

  // --- Context menu ---
  onContextMenu(event: MouseEvent): void {
    event.preventDefault();
    this.contextMenuPosition.set({ x: event.clientX, y: event.clientY });
  }

  closeContextMenu(): void {
    this.contextMenuPosition.set(null);
  }

  contextMenuHasSelection(): boolean {
    return this.selection.state().selectedBodyId !== null;
  }

  contextMenuHide(): void {
    const snap = this.property.selectedSnapshot();
    if (snap) this.property.setVisible(snap.body, false);
    this.closeContextMenu();
  }

  contextMenuIsolate(): void {
    const state = this.selection.state();
    this.viewer.getBodyGroup().traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.visible = obj.userData['bodyId'] === state.selectedBodyId;
      }
    });
    this.closeContextMenu();
  }

  contextMenuShowAll(): void {
    this.viewer.getBodyGroup().traverse((obj) => {
      if (obj instanceof THREE.Mesh) obj.visible = true;
    });
    this.closeContextMenu();
  }

  contextMenuTransparent(): void {
    const snap = this.property.selectedSnapshot();
    if (snap) this.property.setOpacity(snap.body, snap.material.opacity < 1 ? 1 : 0.4);
    this.closeContextMenu();
  }

  /** "Zoom to Fit" — frames the camera on the selected body's bounding box. (Previously duplicated as both "Focus" and "Zoom To"; collapsed to one entry.) */
  contextMenuFocus(): void {
    const snap = this.property.selectedSnapshot();
    if (snap) {
      const box = new THREE.Box3().setFromObject(snap.body.mesh);
      this.camera.fitToBox(box, 1.6);
    }
    this.closeContextMenu();
  }

  /** Properties panel is always visible (not collapsible), so "Properties" has nothing to open — instead it flashes the panel header as feedback. See PropertyService.focusPropertiesRequest. */
  contextMenuProperties(): void {
    this.property.requestFocusProperties();
    this.closeContextMenu();
  }

  /** Triggers the same inline-rename input the model tree's own rename control uses (see PropertyService.startRenameRequest / SidePanels.startNameEdit), without requiring the tree panel to be interacted with directly. */
  contextMenuRename(): void {
    this.property.requestStartRename();
    this.closeContextMenu();
  }

  /**
   * Clones the selected body's mesh (geometry is shared/immutable so a reference copy is safe;
   * material is cloned so color/opacity edits on the copy don't affect the original) and registers
   * it as a new tree node offset +20mm on X so it's visibly distinct from the original. Undoable
   * via the existing register/delete pair, the same pattern used elsewhere for reversible tree
   * mutations — no OCCT/worker involvement, so it doesn't extend the documented delete/create
   * undo gap (see HistoryService's docstring).
   */
  contextMenuDuplicate(): void {
    const snap = this.property.selectedSnapshot();
    this.closeContextMenu();
    if (!snap) return;

    const original = snap.body;
    const material = (Array.isArray(original.mesh.material) ? original.mesh.material[0] : original.mesh.material).clone() as THREE.MeshStandardMaterial;
    const mesh = new THREE.Mesh(original.geometry, material);
    mesh.position.copy(original.mesh.position).add(new THREE.Vector3(20, 0, 0));
    mesh.rotation.copy(original.mesh.rotation);
    mesh.scale.copy(original.mesh.scale);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData['bodyId'] = generateId('body');
    mesh.userData['faceIdMap'] = original.mesh.userData['faceIdMap'];

    const duplicate: CadBody = {
      ...original,
      id: mesh.userData['bodyId'],
      name: `${original.name} (Copy)`,
      mesh,
      boundingBox: original.boundingBox.clone().translate(new THREE.Vector3(20, 0, 0))
    };

    let nodeId: string | null = null;
    this.history.run({
      label: `Duplicate: ${original.name}`,
      redo: () => {
        this.viewer.addBody(mesh);
        nodeId = this.tree.registerBody(duplicate);
      },
      undo: () => {
        if (!nodeId) return;
        this.tree.deleteBody(nodeId);
        this.viewer.removeBody(mesh);
        if (this.selection.state().selectedBodyId === duplicate.id) this.selection.clearSelection();
        this.property.clearIfSelected(duplicate.id);
      }
    });
  }

  contextMenuDelete(): void {
    const state = this.selection.state();
    if (state.selectedNodeId) this.confirmAndDeletePart(state.selectedNodeId);
    this.closeContextMenu();
  }

  /** Prompts for confirmation then removes the part. Shared by the context menu, the Delete key and the model tree's delete control. */
  confirmAndDeletePart(nodeId: string): void {
    const node = this.tree.findNode(nodeId);
    if (!node) return;
    // eslint-disable-next-line no-alert
    if (!confirm(`Delete part "${node.label}"? (Ctrl+Z undoes this.)`)) return;
    this.deletePart(nodeId);
  }

  /**
   * Removes a part as an undoable step. Undo puts the same tree node back (same id, place and
   * feature link — see `TreeService.detachBody`) and re-adds the same mesh, the way Duplicate's and
   * Pattern's undo/redo already re-add a mesh `removeBody` disposed (three.js re-uploads its
   * buffers on the next render). The worker's feature history is untouched by a delete, so a
   * restored feature body stays editable.
   */
  private deletePart(nodeId: string): void {
    const label = this.tree.findNode(nodeId)?.label ?? 'part';
    let detached: DetachedBody | undefined;
    this.history.run({
      label: `Delete: ${label}`,
      redo: () => {
        detached = this.tree.detachBody(nodeId);
        if (!detached) return;
        const body = detached.body;
        if (this.selection.state().selectedBodyId === body.id) {
          this.selection.clearSelection();
        }
        this.property.clearIfSelected(body.id);
        // Explicit, synchronous detach rather than relying on the selectedBodyId effect above —
        // that effect is scheduled, not synchronous, so without this TransformControls could still
        // hold a reference to the mesh for one tick after removeBody disposes it below.
        this.objectTransform.setAttachedBody(null);
        this.viewer.removeBody(body.mesh);
      },
      undo: () => {
        if (!detached) return;
        this.tree.restoreBody(detached);
        if (this.tree.getBodyForNodeId(nodeId) === detached.body) this.viewer.addBody(detached.body.mesh);
      }
    });
  }

  ngOnDestroy(): void {
    this.navCubeUnsubscribe?.();
    this.dimensionLabelsUnsubscribe?.();
    this.navCubeRenderer?.dispose();
    this.objectTransform.dispose();
    this.viewer.dispose();
  }
}
