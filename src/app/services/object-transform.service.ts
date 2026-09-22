import { Injectable, signal } from '@angular/core';
import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { ViewerService } from './viewer.service';
import { CameraService } from './camera.service';
import { HistoryService } from './history.service';
import { PropertyService } from './property.service';
import { SelectionService } from './selection.service';
import { CadBody } from '../models/cad-body.model';

export type TransformGizmoMode = 'translate' | 'rotate' | 'scale';

/**
 * Owns the interactive move/rotate/scale gizmo (Three.js TransformControls) attached to the
 * primary selected body — the CAD-parity counterpart to SolidWorks' "Move/Copy Bodies" drag
 * handles, deferred twice already (2026-07-31, 2026-08-07) as real design work. Mirrors this
 * codebase's per-interaction-domain service shape (StructuralToolService/SketchService/
 * BridgeMeshService), but is deliberately NOT wired into ToolService's mutually-exclusive
 * ActiveTool state machine: a transform gizmo overlays whatever is already selected regardless
 * of which click-tool (if any) is active, the same way SelectionService's own highlight/gizmo
 * triad already does — forcing it into ActiveTool would make it fight Select instead of layer on
 * top of it.
 */
@Injectable({ providedIn: 'root' })
export class ObjectTransformService {
  /** Null means the gizmo is hidden — no body attached. */
  readonly mode = signal<TransformGizmoMode | null>(null);
  /** Mirrors TransformControls.dragging — Viewport/CameraService use this to suspend OrbitControls for the drag's duration, same pattern already used for the (now-removed) box-select's rotate suspension. */
  readonly dragging = signal(false);

  /** Set by Viewport after init() — plain callback rather than another signal/event bus, since this fires on every pointermove during a drag and only one consumer (Viewport) ever needs it. */
  onDrag: (() => void) | null = null;

  private controls: TransformControls | null = null;
  /** The Object3D TransformControls.getHelper() returns — visibility lives here, not on TransformControls itself (which extends Controls, not Object3D, in this Three.js version). */
  private helper: THREE.Object3D | null = null;
  private attachedBody: CadBody | null = null;
  /** Captured on mouseDown, compared against the live transform on mouseUp to build one undo entry per completed drag — never per-tick, matching the section-slider's existing drag-coalescing convention. */
  private dragStart: { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 } | null = null;

  constructor(
    private readonly viewer: ViewerService,
    private readonly camera: CameraService,
    private readonly history: HistoryService,
    private readonly property: PropertyService,
    private readonly selection: SelectionService
  ) {}

  /** Builds the TransformControls instance and adds its helper to the scene — called once from Viewport.ngAfterViewInit, after ViewerService/CameraService are both initialized. */
  init(canvas: HTMLCanvasElement): void {
    const controls = new TransformControls(this.camera.getActiveCamera(), canvas);
    controls.setSize(0.9);
    controls.enabled = false;

    const helper = controls.getHelper();
    helper.visible = false;
    this.helper = helper;

    controls.addEventListener('dragging-changed', (event) => {
      this.dragging.set(!!event.value);
    });
    controls.addEventListener('mouseDown', () => {
      if (!this.attachedBody) return;
      const mesh = this.attachedBody.mesh;
      this.dragStart = { position: mesh.position.clone(), quaternion: mesh.quaternion.clone(), scale: mesh.scale.clone() };
    });
    controls.addEventListener('mouseUp', () => this.commitDrag());
    // Fires continuously while dragging (not just on mouseUp) — Viewport wires this to refresh
    // SelectionService's highlight box/gizmo and PropertyService's panel so both track the mesh
    // live instead of visibly lagging until the drag ends.
    controls.addEventListener('objectChange', () => this.onDrag?.());

    this.viewer.scene.add(helper);
    this.controls = controls;
  }

  /** Re-points TransformControls at whatever camera is currently active — CameraService can swap perspective/orthographic at runtime, and TransformControls only reads the camera reference it was given. */
  syncCamera(): void {
    if (this.controls) this.controls.camera = this.camera.getActiveCamera();
  }

  /** True while the pointer is over (hover-highlighted) or actively dragging one of the gizmo's handles — TransformControls sets `axis` non-null in both cases. Used by Viewport to keep a click that started on a handle from also falling through to whole-body select/deselect, since TransformControls doesn't stop propagation on its own pointer events. */
  isGizmoHandleEngaged(): boolean {
    return !!this.controls && this.controls.axis !== null;
  }

  setMode(mode: TransformGizmoMode): void {
    this.mode.set(mode);
    if (this.controls) this.controls.setMode(mode);
    this.updateAttachment();
  }

  /** Re-selecting the already-active mode turns the gizmo off entirely — the same toggle-off convention ToolService.setTool uses for click-tools. Single source of truth so the ribbon buttons (AppChrome) and keyboard shortcuts (Viewport) don't each re-implement this rule. */
  toggleMode(mode: TransformGizmoMode): void {
    if (this.mode() === mode) {
      this.disable();
    } else {
      this.setMode(mode);
    }
  }

  /** Hides the gizmo entirely (toolbar "off" state) without losing which body is selected. */
  disable(): void {
    this.mode.set(null);
    this.updateAttachment();
  }

  /** Called whenever SelectionService's primary selection changes, so the gizmo follows selection instead of needing a separate pick step. */
  setAttachedBody(body: CadBody | null): void {
    this.attachedBody = body;
    this.updateAttachment();
  }

  private updateAttachment(): void {
    if (!this.controls) return;
    const active = this.mode() !== null && this.attachedBody !== null;
    this.controls.enabled = active;
    if (this.helper) this.helper.visible = active;
    if (active && this.attachedBody) {
      this.controls.attach(this.attachedBody.mesh);
    } else {
      this.controls.detach();
    }
  }

  /** Pushes one undo entry for the whole drag, comparing the mouseDown snapshot against the post-drag transform — a no-op drag (down/up with no movement) pushes nothing. */
  private commitDrag(): void {
    const body = this.attachedBody;
    const start = this.dragStart;
    this.dragStart = null;
    if (!body || !start) return;

    const mesh = body.mesh;
    const end = { position: mesh.position.clone(), quaternion: mesh.quaternion.clone(), scale: mesh.scale.clone() };
    const unchanged = start.position.equals(end.position) && start.quaternion.equals(end.quaternion) && start.scale.equals(end.scale);
    if (unchanged) return;

    const apply = (t: typeof start) => {
      mesh.position.copy(t.position);
      mesh.quaternion.copy(t.quaternion);
      mesh.scale.copy(t.scale);
      // World matrix is normally refreshed lazily during the next render pass — force it now so
      // the recomputed bounding box below (and anything reading it before that render, like the
      // properties panel) reflects this transform immediately, not the previous frame's.
      mesh.updateMatrixWorld(true);
      body.boundingBox = mesh.geometry.boundingBox ? mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld) : body.boundingBox;
      // PropertyService.setPosition's existing callers get this refresh for free via its own
      // internal refresh() call — undo/redo bypasses that setter and writes the mesh directly
      // (it has to, to also restore rotation/scale in one shot), so it needs to trigger the same
      // panel refresh explicitly. refreshIfSelected is a no-op if a different body is selected.
      this.property.refreshIfSelected(body);
      this.selection.refreshHighlightTransform(body.id);
    };

    this.history.run({
      label: `${this.mode() === 'rotate' ? 'Rotate' : this.mode() === 'scale' ? 'Scale' : 'Move'}: ${body.name}`,
      redo: () => apply(end),
      undo: () => apply(start)
    });
  }

  dispose(): void {
    this.controls?.dispose();
    this.controls = null;
    this.helper = null;
  }
}
