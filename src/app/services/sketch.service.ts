import { Injectable, signal } from '@angular/core';
import * as THREE from 'three';
import { ModelingSessionService } from './modeling-session.service';
import { ViewerService } from './viewer.service';
import { TreeService } from './tree.service';
import { CameraService } from './camera.service';
import { SketchRendererService } from './sketch-renderer.service';
import { SelectionService } from './selection.service';
import { PropertyService } from './property.service';
import { FeatureTreeService } from './feature-tree.service';
import { generateId } from '../utils/id-generator.util';
import { randomBodyColor } from '../utils/color.util';
import { toCadBodyEdges } from '../utils/edge-geometry.util';
import { getFacePlane, extractFaceReferencePoints, pickUAxis } from '../utils/face-geometry.util';
import { DocBodyRef, FeatureCutTarget, PlaneRef, SketchEntity, WorkerTessellatedBody } from '../workers/step-worker-messages.model';
import { planeRefInBodyFrame } from '../utils/body-frame.util';
import { CadBody } from '../models/cad-body.model';
import { IDLE_SKETCH, RevolveAxis, SKETCH_SHAPE_POINT_COUNT, SketchShape, SketchState, SweepAxis } from '../models/sketch.model';

const DATUM_NORMALS: Record<'XY' | 'YZ' | 'XZ', THREE.Vector3> = {
  XY: new THREE.Vector3(0, 0, 1),
  YZ: new THREE.Vector3(1, 0, 0),
  XZ: new THREE.Vector3(0, 1, 0)
};

/** Same convention `planeFromDatum` (worker-side) uses for a datum plane's world-space origin point. */
const DATUM_ORIGINS: Record<'XY' | 'YZ' | 'XZ', (offset: number) => THREE.Vector3> = {
  XY: (offset) => new THREE.Vector3(0, 0, offset),
  YZ: (offset) => new THREE.Vector3(offset, 0, 0),
  XZ: (offset) => new THREE.Vector3(0, offset, 0)
};

/** In-plane (u, v) basis matching `projectToPlane`'s own swizzle for each datum, so `uvToWorld` is its exact inverse. */
const DATUM_U_AXES: Record<'XY' | 'YZ' | 'XZ', THREE.Vector3> = {
  XY: new THREE.Vector3(1, 0, 0),
  YZ: new THREE.Vector3(0, 1, 0),
  XZ: new THREE.Vector3(1, 0, 0)
};
const DATUM_V_AXES: Record<'XY' | 'YZ' | 'XZ', THREE.Vector3> = {
  XY: new THREE.Vector3(0, 1, 0),
  YZ: new THREE.Vector3(0, 0, 1),
  XZ: new THREE.Vector3(0, 0, 1)
};

/**
 * v1 sketching: datum planes (XY/YZ/XZ) or a picked face on an existing part, one closed
 * profile per sketch (rectangle/circle/polygon/slot, each drawn by 2 viewport clicks — no
 * arbitrary multi-segment wire drawing or constraint solver, see the plan's v1 scope
 * boundary). Face planes are resolved entirely client-side from the picked body's
 * tessellation (see face-geometry.util.ts) — no OCCT round-trip needed to orient the camera,
 * highlight the face, or populate snap references; the worker only builds a Geom_Plane from
 * the resolved origin/normal at commit/extrude time. Talks to ModelingSessionService to
 * commit the sketch and extrude it once the user confirms.
 */
@Injectable({ providedIn: 'root' })
export class SketchService {
  readonly state = signal<SketchState>(IDLE_SKETCH);
  readonly busy = signal(false);
  readonly lastError = signal<string | null>(null);

  private currentSketchId: string | null = null;

  /** Node ids of the extra (non-primary) solids a feature produced, keyed by the feature's `producesBodyId` — see `applyFeatureEditResult`. */
  private readonly extraNodeIdsByFeatureBody = new Map<string, string[]>();

  /**
   * Serializes `commitEditOfFeature`/`commitEditOfRevolveFeature`/`commitEditOfSweepFeature`/
   * `commitEditOfLoftFeature` calls PER featureId, so two overlapping edit requests against the
   * SAME feature run one after the other instead of racing — added alongside Feature Tree undo/
   * redo, since Ctrl+Z/Ctrl+Y (unlike the panel's own Apply button, which is already
   * `[disabled]`-gated on `busy()`) bypass any UI-level guard and can genuinely fire twice in
   * quick succession (a rapid Ctrl+Z Ctrl+Z is a normal user gesture). A DIFFERENT feature's edit
   * is unaffected — the worker's own per-feature replay is independent, this only serializes calls
   * that target the same `featureId`.
   *
   * Originally built as a `Set<string>`-based guard that DROPPED (silently no-op'd) a second call
   * while the first was still in flight — that was wrong, not just incomplete: confirmed via a
   * real Playwright run against Loft (whose `BRepOffsetAPI_ThruSections` replay is slow enough,
   * 5+ seconds, to make the race window easy to hit) that a Redo pressed shortly after a successful
   * Undo could be silently dropped if the Undo's own worker round-trip hadn't fully settled yet —
   * `history.run()`'s internal `redo()` (fired synchronously, but wrapping an async call) and a
   * user's own next keypress can genuinely overlap. Fixed by QUEUING instead of dropping: each
   * call for a given `featureId` chains onto whatever Promise is already pending for that same id,
   * so every call still runs, in order, none silently lost — see `runSerializedFeatureEdit` below.
   */
  private readonly pendingFeatureEdits = new Map<string, Promise<void>>();

  /**
   * Runs `fn` for `featureId`, chained after any edit already pending for that SAME featureId
   * (a no-op `.catch(() => {})` on the chained-onto promise means a PRIOR call's rejection never
   * blocks or rejects a LATER call waiting behind it — each call's own success/failure is still
   * reported via its own returned promise, only the ordering is serialized). Shared by all four
   * `commitEditOf*Feature` methods so undo/redo mashing on one feature always ends up correct
   * (every call actually runs, in the order issued) instead of racing or silently dropping.
   */
  private runSerializedFeatureEdit(featureId: string, fn: () => Promise<void>): Promise<void> {
    const prior = this.pendingFeatureEdits.get(featureId) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(fn);
    // Store a version that never rejects (so the NEXT queued call, if any, doesn't get skipped by
    // its own `.catch` seeing an already-settled rejected promise) while still returning the real
    // (possibly-rejecting) `next` to this call's own caller.
    this.pendingFeatureEdits.set(featureId, next.catch(() => {}));
    return next;
  }

  constructor(
    private readonly session: ModelingSessionService,
    private readonly viewer: ViewerService,
    private readonly tree: TreeService,
    private readonly camera: CameraService,
    private readonly sketchRenderer: SketchRendererService,
    private readonly selection: SelectionService,
    private readonly property: PropertyService,
    private readonly featureTree: FeatureTreeService
  ) {}

  async begin(plane: 'XY' | 'YZ' | 'XZ'): Promise<void> {
    this.lastError.set(null);
    this.sketchRenderer.clear();
    await this.session.start();
    const planeRef: PlaneRef = { kind: 'datum', plane, offset: 0 };
    this.state.set({ ...IDLE_SKETCH, phase: 'drawing', planeRef, shape: this.state().shape });
  }

  /**
   * Entry point for face-based sketching: resolves the picked face's plane, highlights it,
   * orients the camera normal to it, and populates snap references — all before the worker
   * session is even confirmed ready, since none of that depends on OCCT. Converges with
   * `begin()` on the same `phase: 'drawing'` state shape.
   */
  async beginFromFace(body: CadBody, faceIndex: number): Promise<void> {
    this.lastError.set(null);

    const plane = getFacePlane(body, faceIndex);
    if (!plane) {
      this.lastError.set('Selected face is not planar — sketching is only supported on flat faces.');
      return;
    }

    const uAxis = pickUAxis(plane.normal);
    const vAxis = plane.normal.clone().cross(uAxis).normalize();
    const referencePoints = extractFaceReferencePoints(body, faceIndex, plane);

    this.sketchRenderer.clear();
    this.sketchRenderer.highlightFace(body, faceIndex);
    this.sketchRenderer.showReferencePoints(referencePoints);
    // `CadBody.boundingBox` is already world-space (gizmo drags and `TreeService.replaceBody` keep it so);
    // applying `matrixWorld` again double-counted a moved body's offset and pointed the camera at empty space.
    this.camera.animateToFace(plane.origin, plane.normal, body.boundingBox);

    await this.session.start();

    const planeRef: PlaneRef = {
      kind: 'face',
      origin: [plane.origin.x, plane.origin.y, plane.origin.z],
      normal: [plane.normal.x, plane.normal.y, plane.normal.z],
      uAxis: [uAxis.x, uAxis.y, uAxis.z]
    };
    this.state.set({
      ...IDLE_SKETCH,
      phase: 'drawing',
      planeRef,
      shape: this.state().shape,
      facePlane: {
        origin: [plane.origin.x, plane.origin.y, plane.origin.z],
        normal: [plane.normal.x, plane.normal.y, plane.normal.z],
        uAxis: [uAxis.x, uAxis.y, uAxis.z],
        vAxis: [vAxis.x, vAxis.y, vAxis.z]
      },
      pickedFace: { bodyId: body.id, faceIndex },
      referencePoints
    });
  }

  /**
   * Entry point for sketching on a user-defined reference plane (ReferencePlaneService): the
   * caller has already resolved the plane's {origin, normal, uAxis, vAxis} frame (the same
   * ResolvedPlaneFrame shape ReferencePlaneService.resolve produces), so unlike beginFromFace
   * there's no face to highlight or planarity to check — a stored reference plane is planar by
   * construction. Converges with begin()/beginFromFace() on the same `phase: 'drawing'` state
   * shape and the identical PlaneRef(kind: 'face') wire format the worker already accepts for
   * an arbitrary origin/normal, so no worker change was needed to add this entry point.
   */
  async beginFromCustomPlane(frame: { origin: THREE.Vector3; normal: THREE.Vector3; uAxis: THREE.Vector3; vAxis: THREE.Vector3 }): Promise<void> {
    this.lastError.set(null);
    this.sketchRenderer.clear();
    this.camera.animateToFace(frame.origin, frame.normal, new THREE.Box3().setFromCenterAndSize(frame.origin, new THREE.Vector3(200, 200, 200)));
    await this.session.start();

    const planeRef: PlaneRef = {
      kind: 'face',
      origin: [frame.origin.x, frame.origin.y, frame.origin.z],
      normal: [frame.normal.x, frame.normal.y, frame.normal.z],
      uAxis: [frame.uAxis.x, frame.uAxis.y, frame.uAxis.z]
    };
    this.state.set({
      ...IDLE_SKETCH,
      phase: 'drawing',
      planeRef,
      shape: this.state().shape,
      facePlane: {
        origin: [frame.origin.x, frame.origin.y, frame.origin.z],
        normal: [frame.normal.x, frame.normal.y, frame.normal.z],
        uAxis: [frame.uAxis.x, frame.uAxis.y, frame.uAxis.z],
        vAxis: [frame.vAxis.x, frame.vAxis.y, frame.vAxis.z]
      },
      pickedFace: null,
      referencePoints: []
    });
  }

  setShape(shape: SketchShape): void {
    this.state.update((st) => ({ ...st, shape, points: [], closed: false }));
  }

  /** Regular-polygon side count, or slot width in mm depending on the active shape. */
  setParam(param: number): void {
    if (!Number.isFinite(param) || param <= 0) return;
    this.state.update((st) => ({ ...st, param }));
  }

  /** Converts a world-space raycast hit into the active sketch plane's 2D (u,v) coordinates. */
  projectToPlane(worldPoint: THREE.Vector3): [number, number] | null {
    const st = this.state();
    if (st.phase !== 'drawing' || !st.planeRef) return null;

    if (st.planeRef.kind === 'datum') {
      switch (st.planeRef.plane) {
        case 'XY':
          return [worldPoint.x, worldPoint.y];
        case 'YZ':
          return [worldPoint.y, worldPoint.z];
        case 'XZ':
          return [worldPoint.x, worldPoint.z];
      }
    }

    if (!st.facePlane) return null;
    const origin = new THREE.Vector3(...st.facePlane.origin);
    const uAxis = new THREE.Vector3(...st.facePlane.uAxis);
    const vAxis = new THREE.Vector3(...st.facePlane.vAxis);
    const rel = worldPoint.clone().sub(origin);
    return [rel.dot(uAxis), rel.dot(vAxis)];
  }

  planeNormal(): THREE.Vector3 | null {
    const st = this.state();
    if (!st.planeRef) return null;
    if (st.planeRef.kind === 'datum') return DATUM_NORMALS[st.planeRef.plane];
    return st.facePlane ? new THREE.Vector3(...st.facePlane.normal) : null;
  }

  /** World-space point the sketch plane passes through — used to build a correctly-offset raycast plane (datum planes with a nonzero offset, or any face plane, don't pass through the world origin). */
  planeOrigin(): THREE.Vector3 | null {
    const st = this.state();
    if (!st.planeRef) return null;
    if (st.planeRef.kind === 'datum') return DATUM_ORIGINS[st.planeRef.plane](st.planeRef.offset);
    return st.facePlane ? new THREE.Vector3(...st.facePlane.origin) : null;
  }

  /** In-plane U axis of the active sketch plane, matching `projectToPlane`'s own convention — the exact inverse basis vector, so `uvToWorld` round-trips with it. */
  planeUAxis(): THREE.Vector3 | null {
    const st = this.state();
    if (!st.planeRef) return null;
    if (st.planeRef.kind === 'datum') return DATUM_U_AXES[st.planeRef.plane];
    return st.facePlane ? new THREE.Vector3(...st.facePlane.uAxis) : null;
  }

  /** In-plane V axis — see `planeUAxis`. */
  planeVAxis(): THREE.Vector3 | null {
    const st = this.state();
    if (!st.planeRef) return null;
    if (st.planeRef.kind === 'datum') return DATUM_V_AXES[st.planeRef.plane];
    return st.facePlane ? new THREE.Vector3(...st.facePlane.vAxis) : null;
  }

  /** Inverse of `projectToPlane`: a sketch-plane (u, v) point back to its world position. Null when the plane isn't fully resolved yet. */
  uvToWorld(uv: [number, number]): THREE.Vector3 | null {
    const origin = this.planeOrigin();
    const uAxis = this.planeUAxis();
    const vAxis = this.planeVAxis();
    if (!origin || !uAxis || !vAxis) return null;
    return origin.clone().addScaledVector(uAxis, uv[0]).addScaledVector(vAxis, uv[1]);
  }

  addPoint(uv: [number, number]): void {
    const st = this.state();
    if (st.phase !== 'drawing' || st.closed) return;
    const points = [...st.points, uv];
    this.state.set({ ...st, points });
  }

  /**
   * Explicitly closes an in-progress polyline profile (Viewport calls this on a double-click, Enter,
   * or a click back near the start point). No-op for every other shape — they complete automatically
   * at their fixed point count — and for a polyline with fewer than 3 points, which isn't a valid
   * closed loop yet.
   */
  closePolyline(): void {
    const st = this.state();
    if (st.shape !== 'polyline' || st.closed || st.points.length < SKETCH_SHAPE_POINT_COUNT.polyline) return;
    this.state.set({ ...st, closed: true });
  }

  canFinishSketch(): boolean {
    const st = this.state();
    if (st.shape === 'polyline') return st.closed;
    return st.points.length >= SKETCH_SHAPE_POINT_COUNT[st.shape];
  }

  private rectangleEntities(): SketchEntity[] {
    const [p1, p2] = this.state().points;
    const [x1, y1] = p1;
    const [x2, y2] = p2;
    const corners: [number, number][] = [
      [x1, y1],
      [x2, y1],
      [x2, y2],
      [x1, y2]
    ];
    const lines: SketchEntity[] = [];
    for (let i = 0; i < 4; i++) {
      lines.push({
        type: 'line',
        id: generateId('line'),
        points: [corners[i], corners[(i + 1) % 4]]
      });
    }
    return lines;
  }

  /** One 'line' entity per edge of the closed loop, including the closing edge back to the first point — the same shape `rectangleEntities` builds for 4 fixed corners, generalized to however many points the user clicked. `buildWireFromSketch` (worker) already chains an arbitrary number of 'line' entities into one wire, so no worker change is needed to support this. */
  private polylineEntities(): SketchEntity[] {
    const points = this.state().points;
    const lines: SketchEntity[] = [];
    for (let i = 0; i < points.length; i++) {
      lines.push({
        type: 'line',
        id: generateId('line'),
        points: [points[i], points[(i + 1) % points.length]]
      });
    }
    return lines;
  }

  private buildEntities(): SketchEntity[] {
    const st = this.state();
    const [p1, p2] = st.points;
    const radius = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);

    switch (st.shape) {
      case 'rectangle':
        return this.rectangleEntities();
      case 'circle':
        return [{ type: 'circle', id: generateId('circle'), center: p1, radius }];
      case 'polygon':
        return [{ type: 'polygon', id: generateId('polygon'), center: p1, radius, sides: Math.round(st.param) }];
      case 'slot':
        return [{ type: 'slot', id: generateId('slot'), start: p1, end: p2, width: st.param }];
      case 'polyline':
        return this.polylineEntities();
    }
  }

  /**
   * Commits the active sketch shape, extrudes it, and adds the resulting body/bodies to the
   * scene + model tree. Opts into the parametric feature tree (Slice 1): generates a stable
   * `producesBodyId` up front and passes it to `ModelingSessionService.extrude`, so the worker
   * records this as an editable `FeatureRecord` — the resulting node is linked via
   * `TreeService.linkFeature` and mirrored into `FeatureTreeService` for the Feature Tree panel.
   * Revolve/Sweep/Loft (below) do NOT do this yet — they keep calling their own `session.*`
   * methods with no `producesBodyId`, exactly as before this slice.
   */
  async finishAndExtrude(depth: number, cut: boolean): Promise<void> {
    const st = this.state();
    if (st.phase !== 'drawing' || !st.planeRef || !this.canFinishSketch()) {
      throw new Error('Sketch is not ready to extrude');
    }

    this.busy.set(true);
    this.lastError.set(null);
    try {
      const sketchId = generateId('sketch');
      const entities = this.buildEntities();
      const commit = await this.session.commitSketch(sketchId, this.planeRefForTarget(st.planeRef, st.pickedFace), entities, this.faceAnchorFeatureId(st.pickedFace));
      if (!commit.success) {
        throw new Error(commit.error ?? 'Sketch commit failed');
      }
      this.currentSketchId = sketchId;

      // Sketching on a face of an existing body means cut/fuse should target THAT body's own
      // solid, not this session's own accumulated shape (which is never seeded from imported
      // geometry) — resolve it here, right before extrude. Uses the feature-aware resolver (not
      // plain resolveCutTarget) so a body this session itself built via a prior feature-tree
      // extrude can be targeted too, not just a STEP-imported one — see that method's docstring.
      const targetNodeId = st.pickedFace ? this.findNodeIdForBody(st.pickedFace.bodyId) : null;
      const targetBody: DocBodyRef | undefined = targetNodeId ? await this.resolveFeatureAwareCutTarget(targetNodeId, st.pickedFace!.bodyId) : undefined;

      const producesBodyId = generateId('body');
      const featureId = generateId('feature');
      // Pass featureId through explicitly so the worker stores THIS exact id in
      // session.features[].featureId — see ModelingSessionService.extrude's own docstring for why
      // letting it mint its own internal id here was a real bug (client/worker feature-identity
      // mismatch, causing "not found in this session's history" the moment a later feature tried
      // to target this one via {kind:'feature', featureId}).
      const result = await this.session.extrude(sketchId, depth, cut, targetBody, producesBodyId, featureId);
      const resultNodeId = this.addResultToScene(result.bodies, targetNodeId ?? undefined, producesBodyId);
      if (resultNodeId) {
        this.tree.linkFeature(resultNodeId, featureId);
        this.featureTree.register({
          featureId,
          kind: 'extrude',
          label: `Extrude`,
          sketchId,
          params: { depth, cut },
          nodeId: resultNodeId
        });
      }
      this.state.set(IDLE_SKETCH);
      this.sketchRenderer.clear();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError.set(message);
      throw err;
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Edits a previously-created extrude feature's depth/cut params (Slice 1 — sketch geometry
   * itself is NOT re-editable, only these two params; see `FeatureTreeService`'s own docstring
   * for why this is a deliberate v1 boundary, same "don't build past what today's UI exercises"
   * precedent as Draft's fixed pull direction). Replays the feature and every feature after it in
   * the worker's history, then updates every affected `CadBody` from the single response —
   * including any downstream dependent that was cut into/fused onto this feature's own output.
   */
  async commitEditOfFeature(featureId: string, depth: number, cut: boolean): Promise<void> {
    return this.runSerializedFeatureEdit(featureId, async () => {
      const record = this.featureTree.find(featureId);
      if (!record) throw new Error('Feature not found');

      this.busy.set(true);
      this.lastError.set(null);
      try {
        const result = await this.session.editExtrude(featureId, { depth, cut });
        this.applyFeatureEditResult(result.bodies);
        this.featureTree.update(featureId, { depth, cut });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.lastError.set(message);
        throw err;
      } finally {
        this.busy.set(false);
      }
    });
  }

  /**
   * Revolve's counterpart of `commitEditOfFeature` above — same shape and same v1 boundary
   * (axis/angle/cut only, sketch geometry itself is not re-editable), added in Slice 2. Kept as a
   * separate sibling method rather than one generic method, since Extrude's and Revolve's
   * UI-facing params genuinely differ (depth vs. axis+angle) — same "small sibling methods over
   * one generic one when call-site shapes differ" precedent this file already follows for
   * `resolveCutTarget`/`resolveCutTargetForPickedFace`.
   */
  async commitEditOfRevolveFeature(featureId: string, axis: RevolveAxis, angleDeg: number, cut: boolean): Promise<void> {
    return this.runSerializedFeatureEdit(featureId, async () => {
      const record = this.featureTree.find(featureId);
      if (!record) throw new Error('Feature not found');

      this.busy.set(true);
      this.lastError.set(null);
      try {
        const result = await this.session.editRevolve(featureId, { axis, angleDeg, cut });
        this.applyFeatureEditResult(result.bodies);
        this.featureTree.update(featureId, { axis, angleDeg, cut });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.lastError.set(message);
        throw err;
      } finally {
        this.busy.set(false);
      }
    });
  }

  /**
   * Finds the tree node currently holding the body a given feature produces, by looking up the
   * `ClientFeatureRecord` whose `producesBodyId`-tagged result this is — `FeatureTreeService`
   * tracks `nodeId` directly (stable across edits, since `TreeService.replaceBody` never changes
   * a node's id), so this only needs a linear scan over the small in-memory feature list, not a
   * body-id reverse lookup through `TreeService`.
   */
  private findNodeIdForFeatureProduct(producesBodyId: string): string | undefined {
    // producesBodyId is the CadBody.id assigned when the feature was first created (see
    // addResultToScene below) — TreeService.getNodeIdForMesh needs a mesh, not a body id, so look
    // up the current CadBody by id across all bodies instead.
    const body = this.tree.allBodies().find((b) => b.id === producesBodyId);
    if (!body) return undefined;
    return this.tree.getNodeIdForMesh(body.mesh);
  }

  /**
   * Commits the active sketch shape, revolves it around the sketch plane's own U or V axis, and
   * adds the resulting body to the scene + model tree. `cut` mirrors `finishAndExtrude`'s own
   * boss(add)/cut(remove) choice and only has a real effect when the sketch was drawn on a
   * picked face (`st.pickedFace` set) — added 2026-09-13, after v1 (2026-09-10) shipped
   * standalone-new-body-only.
   *
   * Opts into the parametric feature tree (Slice 2, mirroring `finishAndExtrude`'s own Slice-1
   * treatment exactly): generates `producesBodyId`/`featureId` up front, resolves the target via
   * `resolveFeatureAwareCutTarget` (so a body built by an earlier feature-tree feature can be
   * targeted too, not just a STEP-imported one), and registers the result with
   * `TreeService.linkFeature`/`FeatureTreeService` so it shows up as an editable row.
   */
  async finishAndRevolve(axis: RevolveAxis, angleDeg: number, cut = false): Promise<void> {
    const st = this.state();
    if (st.phase !== 'drawing' || !st.planeRef || !this.canFinishSketch()) {
      throw new Error('Sketch is not ready to revolve');
    }

    this.busy.set(true);
    this.lastError.set(null);
    try {
      const sketchId = generateId('sketch');
      const entities = this.buildEntities();
      const commit = await this.session.commitSketch(sketchId, this.planeRefForTarget(st.planeRef, st.pickedFace), entities, this.faceAnchorFeatureId(st.pickedFace));
      if (!commit.success) {
        throw new Error(commit.error ?? 'Sketch commit failed');
      }
      this.currentSketchId = sketchId;

      const targetNodeId = st.pickedFace ? this.findNodeIdForBody(st.pickedFace.bodyId) : null;
      const targetBody: DocBodyRef | undefined = targetNodeId ? await this.resolveFeatureAwareCutTarget(targetNodeId, st.pickedFace!.bodyId) : undefined;

      const producesBodyId = generateId('body');
      const featureId = generateId('feature');
      const result = await this.session.revolve(sketchId, axis, angleDeg, cut, targetBody, producesBodyId, featureId);
      const resultNodeId = this.addResultToScene(result.bodies, targetNodeId ?? undefined, producesBodyId);
      if (resultNodeId) {
        this.tree.linkFeature(resultNodeId, featureId);
        this.featureTree.register({
          featureId,
          kind: 'revolve',
          label: `Revolve`,
          sketchId,
          params: { axis, angleDeg, cut },
          nodeId: resultNodeId
        });
      }
      this.state.set(IDLE_SKETCH);
      this.sketchRenderer.clear();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError.set(message);
      throw err;
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Commits the active sketch shape, sweeps it a straight distance along a direction tilted
   * `tiltDeg` away from the sketch plane's own normal (toward its own u or v in-plane axis), and
   * adds the resulting body to the scene + model tree. `cut` works the same as
   * `finishAndRevolve`'s own — added 2026-09-13, after v1 (2026-09-11) shipped standalone-only.
   *
   * Opts into the parametric feature tree (Slice 3, mirroring `finishAndExtrude`/
   * `finishAndRevolve`'s own treatment exactly).
   */
  async finishAndSweep(axis: SweepAxis, tiltDeg: number, distance: number, cut = false): Promise<void> {
    const st = this.state();
    if (st.phase !== 'drawing' || !st.planeRef || !this.canFinishSketch()) {
      throw new Error('Sketch is not ready to sweep');
    }

    this.busy.set(true);
    this.lastError.set(null);
    try {
      const sketchId = generateId('sketch');
      const entities = this.buildEntities();
      const commit = await this.session.commitSketch(sketchId, this.planeRefForTarget(st.planeRef, st.pickedFace), entities, this.faceAnchorFeatureId(st.pickedFace));
      if (!commit.success) {
        throw new Error(commit.error ?? 'Sketch commit failed');
      }
      this.currentSketchId = sketchId;

      const targetNodeId = st.pickedFace ? this.findNodeIdForBody(st.pickedFace.bodyId) : null;
      const targetBody: DocBodyRef | undefined = targetNodeId ? await this.resolveFeatureAwareCutTarget(targetNodeId, st.pickedFace!.bodyId) : undefined;

      const producesBodyId = generateId('body');
      const featureId = generateId('feature');
      const result = await this.session.sweep(sketchId, axis, tiltDeg, distance, cut, targetBody, producesBodyId, featureId);
      const resultNodeId = this.addResultToScene(result.bodies, targetNodeId ?? undefined, producesBodyId);
      if (resultNodeId) {
        this.tree.linkFeature(resultNodeId, featureId);
        this.featureTree.register({
          featureId,
          kind: 'sweep',
          label: `Sweep`,
          sketchId,
          params: { axis, tiltDeg, distance, cut },
          nodeId: resultNodeId
        });
      }
      this.state.set(IDLE_SKETCH);
      this.sketchRenderer.clear();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError.set(message);
      throw err;
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Sweep's counterpart of `commitEditOfFeature`/`commitEditOfRevolveFeature` above — same shape
   * and v1 boundary, added in Slice 3.
   */
  async commitEditOfSweepFeature(featureId: string, axis: SweepAxis, tiltDeg: number, distance: number, cut: boolean): Promise<void> {
    return this.runSerializedFeatureEdit(featureId, async () => {
      const record = this.featureTree.find(featureId);
      if (!record) throw new Error('Feature not found');

      this.busy.set(true);
      this.lastError.set(null);
      try {
        const result = await this.session.editSweep(featureId, { axis, tiltDeg, distance, cut });
        this.applyFeatureEditResult(result.bodies);
        this.featureTree.update(featureId, { axis, tiltDeg, distance, cut });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.lastError.set(message);
        throw err;
      } finally {
        this.busy.set(false);
      }
    });
  }

  /**
   * Loft's counterpart of `commitEditOfFeature`/`commitEditOfRevolveFeature`/
   * `commitEditOfSweepFeature` above — deliberately the smallest of the four: only the Cut
   * checkbox is editable (v1 doesn't support re-adding/removing/reordering a Loft's profiles after
   * the fact — see `FeatureRecord`'s own docstring in step-worker-messages.model.ts for the full
   * scoping rationale). Lives here (not on `LoftToolService`, which owns the CREATE side of Loft)
   * for the same reason `commitEditOfFeature`/etc. all live here: the edit path only ever needs
   * `session`/`featureTree`/`findNodeIdForFeatureProduct`/`applyReplacementBody`, all already on
   * this class — routing it through `LoftToolService` instead would mean that service duplicating
   * this machinery for no benefit. Added in Slice 4.
   */
  async commitEditOfLoftFeature(featureId: string, cut: boolean): Promise<void> {
    return this.runSerializedFeatureEdit(featureId, async () => {
      const record = this.featureTree.find(featureId);
      if (!record) throw new Error('Feature not found');

      this.busy.set(true);
      this.lastError.set(null);
      try {
        const result = await this.session.editLoft(featureId, { cut });
        this.applyFeatureEditResult(result.bodies);
        this.featureTree.update(featureId, { cut });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.lastError.set(message);
        throw err;
      } finally {
        this.busy.set(false);
      }
    });
  }

  /**
   * Commits the active sketch shape WITHOUT building any feature from it — returns the committed
   * sketchId so a caller can reference it later. Used by LoftToolService, which needs 2+
   * committed profiles to exist simultaneously before Loft can blend between them; every other
   * finish method (finishAndExtrude/Revolve/Sweep) commits and immediately builds a single
   * feature from that one sketch, so none of them needed to expose the commit step on its own
   * until now. Does not touch `state`/`sketchRenderer` — pair with `resetForNextProfile()` to
   * advance to picking the next profile's plane, the way LoftToolService does.
   */
  async commitCurrentProfile(): Promise<string> {
    const st = this.state();
    if (st.phase !== 'drawing' || !st.planeRef || !this.canFinishSketch()) {
      throw new Error('Sketch is not ready to commit');
    }

    const sketchId = generateId('sketch');
    const entities = this.buildEntities();
    const commit = await this.session.commitSketch(sketchId, st.planeRef, entities);
    if (!commit.success) {
      throw new Error(commit.error ?? 'Sketch commit failed');
    }
    return sketchId;
  }

  /**
   * Resets back to 'picking-plane' for drawing the NEXT profile, without tearing down the
   * modeling session the way `cancel()` would (Loft needs the same worker session to keep
   * running across all its profiles) and without clearing `lastError` (LoftToolService owns its
   * own error signal, surfaced separately from Sketch's). Used only by LoftToolService, between
   * `commitCurrentProfile()` calls.
   */
  resetForNextProfile(): void {
    this.sketchRenderer.clear();
    this.state.set({ ...IDLE_SKETCH, phase: 'picking-plane', shape: this.state().shape });
  }

  /** The feature whose output body owns the picked face, if any: the worker anchors the sketch to that face so editing the feature carries the sketch along. STEP-imported and primitive bodies never change, so they need no anchor. */
  private faceAnchorFeatureId(pickedFace: { bodyId: string } | null): string | undefined {
    if (!pickedFace) return undefined;
    const nodeId = this.findNodeIdForBody(pickedFace.bodyId);
    return (nodeId ? this.tree.getFeatureId(nodeId) : null) ?? undefined;
  }

  /** For a sketch drawn on a picked face, the plane expressed in that body's own kernel frame (see `planeRefInBodyFrame`); any other plane is returned unchanged. */
  private planeRefForTarget(planeRef: PlaneRef, pickedFace: { bodyId: string } | null): PlaneRef {
    if (!pickedFace) return planeRef;
    const nodeId = this.findNodeIdForBody(pickedFace.bodyId);
    const body = nodeId ? this.tree.getBodyForNodeId(nodeId) : undefined;
    return body ? planeRefInBodyFrame(planeRef, body.mesh) : planeRef;
  }

  private findNodeIdForBody(bodyId: string): string | null {
    for (const body of this.tree.allBodies()) {
      if (body.id !== bodyId) continue;
      const nodeId = this.tree.getNodeIdForMesh(body.mesh);
      return nodeId ?? null;
    }
    return null;
  }

  /**
   * Re-reads the picked body's original STEP source into bytes for the worker to cut/fuse
   * against — undefined (no target) if that body's import has no retained source (shouldn't
   * normally happen, but degrades to today's "no cut" behavior rather than throwing). Delegates
   * to `TreeService.resolveFeatureCutTarget` (added for the parametric feature tree, Slice 1),
   * which centralizes the identical chain that used to be duplicated verbatim here and in
   * `FilletChamferToolService`/`ShellToolService`/`DraftToolService`/`HoleWizardService` — only
   * this copy has been switched over so far; the other four keep their own copies until a
   * follow-up migration pass. `nodeId` is unused now that resolution goes by `bodyId` alone, kept
   * as a parameter so every existing call site is unaffected.
   */
  private async resolveCutTarget(nodeId: string, bodyId: string): Promise<FeatureCutTarget | undefined> {
    void nodeId;
    return this.tree.resolveFeatureCutTarget(bodyId);
  }

  /**
   * Feature-tree-aware counterpart of `resolveCutTarget` above — returns a `DocBodyRef` instead of
   * the plain `FeatureCutTarget`, so a picked face belonging to a body this session ITSELF built
   * via a feature-tree-aware Extrude OR Revolve (`TreeService.getFeatureId` returns non-null) can
   * be targeted directly (`{kind: 'feature', featureId}`), without needing `hasStepSource` — a
   * feature-tree body never has that flag set (it isn't STEP-imported), so without this branch
   * such a body could never be a cut/fuse target at all, and "build feature A, then cut into A"
   * (the scenario that actually exercises `handleFeatureEdit`'s downstream-dependent replay) would
   * be unreachable from the UI. Falls back to `resolveCutTarget`'s STEP-source path for every other
   * body, unchanged.
   *
   * Named generically (renamed from `resolveExtrudeCutTarget` in Slice 2) since Extrude and
   * Revolve now both use it identically — the resolution logic has no Extrude/Revolve-specific
   * knowledge, only the caller's own worker request shape differs. Sweep/Loft keep calling the
   * plain `resolveCutTarget` above, since their worker request types weren't widened to accept a
   * `DocBodyRef` yet.
   */
  private async resolveFeatureAwareCutTarget(nodeId: string, bodyId: string): Promise<DocBodyRef | undefined> {
    const featureId = this.tree.getFeatureId(nodeId);
    if (featureId) return { kind: 'feature', featureId };
    const imported = await this.resolveCutTarget(nodeId, bodyId);
    return imported ? { kind: 'imported', ...imported } : undefined;
  }

  /**
   * Public wrapper over `findNodeIdForBody`+`resolveFeatureAwareCutTarget`, for callers that
   * resolve a cut/fuse target from a `pickedFace` snapshot they hold onto themselves rather than
   * reading `this.state()` directly — added 2026-09-13 for `LoftToolService`, which snapshots each
   * profile's `pickedFace` at commit time (its own `state` moves on to the next profile
   * afterward, unlike `finishAndExtrude`/`Revolve`/`Sweep`, which all read `pickedFace` from the
   * CURRENT `state()` right before building their one feature). Returns a `DocBodyRef` (not the
   * plain `FeatureCutTarget`) since Slice 4 — so a Loft's first profile, drawn on a body a prior
   * feature-tree feature produced, can be targeted too, not just a STEP-imported one.
   */
  async resolveCutTargetForPickedFace(pickedFace: { bodyId: string; faceIndex: number } | null): Promise<{ nodeId: string; targetBody: DocBodyRef } | undefined> {
    if (!pickedFace) return undefined;
    const nodeId = this.findNodeIdForBody(pickedFace.bodyId);
    if (!nodeId) return undefined;
    const targetBody = await this.resolveFeatureAwareCutTarget(nodeId, pickedFace.bodyId);
    if (!targetBody) return undefined;
    return { nodeId, targetBody };
  }

  /** Builds a fresh THREE mesh + CadBody from one worker tessellation result — factored out of `addResultToScene` so `applyReplacementBody` (the feature-edit path) can reuse the identical mesh-construction logic instead of duplicating it. */
  private buildCadBodyFromResult(b: WorkerTessellatedBody, idOverride?: string): CadBody {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(b.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(b.indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    const color = randomBodyColor(b.solidIndex);
    const material = new THREE.MeshStandardMaterial({ color, metalness: 0.15, roughness: 0.55, side: THREE.DoubleSide });
    const mesh3d = new THREE.Mesh(geometry, material);
    mesh3d.castShadow = true;
    mesh3d.receiveShadow = true;

    const bodyId = idOverride ?? generateId('body');
    mesh3d.userData['bodyId'] = bodyId;
    mesh3d.userData['faceIdMap'] = b.faceIdMap;

    return {
      id: bodyId,
      name: `Feature Body ${b.solidIndex + 1}`,
      solidIndex: b.solidIndex,
      mesh: mesh3d,
      geometry,
      visible: true,
      color,
      opacity: 1,
      boundingBox: geometry.boundingBox?.clone() ?? new THREE.Box3(),
      volume: b.volume,
      surfaceArea: b.surfaceArea,
      faceCount: b.faceCount,
      edgeCount: b.edgeCount,
      faceIdMap: b.faceIdMap,
      edges: toCadBodyEdges(b.edges)
    };
  }

  /**
   * Adds extrude results to the scene. When `replaceNodeId` is set (a cut/fuse targeted an
   * existing body's own solid rather than this session's shape), the FIRST returned body
   * replaces that node in place; any additional returned bodies (rare — a cut can split a solid
   * into multiple pieces) are appended as new bodies, same as the always-append path.
   *
   * `producesBodyId`, when passed (parametric feature tree, Slice 1), becomes the FIRST returned
   * body's `CadBody.id` instead of a freshly generated one — this is what lets a later
   * `commitEditOfFeature` find the same body again by id across an edit/replay. Returns the node
   * id the first (primary) result body ended up at, so the caller can link it to a feature record.
   */
  private addResultToScene(bodies: WorkerTessellatedBody[], replaceNodeId?: string, producesBodyId?: string): string | undefined {
    let firstBody = true;
    let firstNodeId: string | undefined;
    const extraNodeIds: string[] = [];
    for (const b of bodies) {
      const newBody = this.buildCadBodyFromResult(b, firstBody ? producesBodyId : undefined);

      if (firstBody && replaceNodeId) {
        this.replaceBodyInScene(replaceNodeId, newBody);
        firstNodeId = replaceNodeId;
      } else {
        this.viewer.addBody(newBody.mesh);
        const nodeId = this.tree.registerBody(newBody);
        if (firstBody) firstNodeId = nodeId;
        else extraNodeIds.push(nodeId);
      }
      firstBody = false;
    }
    // A feature can yield more than one solid (a boss that doesn't touch its target, a cut that
    // splits a part). Only the first carries `producesBodyId`; remember where the rest went so a
    // later edit/replay can update them instead of overwriting the first.
    if (producesBodyId) {
      if (extraNodeIds.length > 0) this.extraNodeIdsByFeatureBody.set(producesBodyId, extraNodeIds);
      else this.extraNodeIdsByFeatureBody.delete(producesBodyId);
    }
    this.camera.fitAll();
    return firstNodeId;
  }

  /**
   * Applies a feature edit/replay result to the scene. The worker tags every solid a feature
   * produces with the same `producesBodyId`, so results are grouped by it: the first solid of a
   * group replaces the feature's primary node (which owns that id), and any further solids update
   * the extra nodes recorded at creation — adding or removing nodes if the solid count changed.
   * Applying each solid to the primary node instead (the previous behaviour) let the last solid
   * overwrite the first, silently destroying the feature's main body.
   */
  private applyFeatureEditResult(bodies: WorkerTessellatedBody[]): void {
    const groups = new Map<string, WorkerTessellatedBody[]>();
    for (const b of bodies) {
      if (!b.producesBodyId) continue;
      const group = groups.get(b.producesBodyId);
      if (group) group.push(b);
      else groups.set(b.producesBodyId, [b]);
    }

    for (const [producesBodyId, solids] of groups) {
      const primaryNodeId = this.findNodeIdForFeatureProduct(producesBodyId);
      if (!primaryNodeId) continue;
      this.applyReplacementBody(primaryNodeId, solids[0]);
      this.syncExtraSolids(producesBodyId, solids.slice(1));
    }
  }

  /** Brings a feature's extra (non-primary) solids' nodes in line with `solids`: replace in place, append new ones, delete surplus ones. */
  private syncExtraSolids(producesBodyId: string, solids: WorkerTessellatedBody[]): void {
    const existing = (this.extraNodeIdsByFeatureBody.get(producesBodyId) ?? []).filter((nodeId) => !!this.tree.getBodyForNodeId(nodeId));
    const next: string[] = [];

    solids.forEach((solid, i) => {
      const nodeId = existing[i];
      const oldBody = nodeId ? this.tree.getBodyForNodeId(nodeId) : undefined;
      if (nodeId && oldBody) {
        // Keep the extra body's own id — it must never collide with the primary's `producesBodyId`.
        this.replaceBodyInScene(nodeId, this.buildCadBodyFromResult(solid, oldBody.id));
        next.push(nodeId);
      } else {
        const newBody = this.buildCadBodyFromResult(solid);
        this.viewer.addBody(newBody.mesh);
        next.push(this.tree.registerBody(newBody));
      }
    });

    for (const surplusNodeId of existing.slice(solids.length)) {
      const removed = this.tree.deleteBody(surplusNodeId);
      if (!removed) continue;
      if (this.selection.state().selectedBodyId === removed.id) this.selection.clearSelection();
      this.property.clearIfSelected(removed.id);
      this.viewer.removeBody(removed.mesh);
    }

    if (next.length > 0) this.extraNodeIdsByFeatureBody.set(producesBodyId, next);
    else this.extraNodeIdsByFeatureBody.delete(producesBodyId);
    this.camera.fitAll();
  }

  /**
   * The feature-edit counterpart of `addResultToScene`/`replaceBodyInScene`: replaces the body
   * currently at `nodeId` with a freshly-replayed tessellation, preserving the same `CadBody.id`
   * (`producesBodyId` never changes across an edit — see `buildCadBodyFromResult`'s
   * `idOverride`), then re-fits the camera. Used by `commitEditOfFeature` for the edited feature
   * itself and for every downstream dependent the replay also returned.
   */
  private applyReplacementBody(nodeId: string, result: WorkerTessellatedBody): void {
    const newBody = this.buildCadBodyFromResult(result, result.producesBodyId);
    this.replaceBodyInScene(nodeId, newBody);
    this.camera.fitAll();
  }

  /** Disposes the old mesh, clears selection/properties if it was the active one, and swaps in the new body at the same tree node — mirrors Viewport's existing delete-part dispose sequence. */
  private replaceBodyInScene(nodeId: string, newBody: CadBody): void {
    const oldBody = this.tree.getBodyForNodeId(nodeId);
    if (!oldBody) {
      // Node vanished somehow — fall back to a plain append rather than losing the result.
      this.viewer.addBody(newBody.mesh);
      this.tree.registerBody(newBody);
      return;
    }

    if (this.selection.state().selectedBodyId === oldBody.id) {
      this.selection.clearSelection();
    }
    this.property.clearIfSelected(oldBody.id);
    this.viewer.removeBody(oldBody.mesh);

    this.viewer.addBody(newBody.mesh);
    this.tree.replaceBody(nodeId, newBody);
  }

  cancel(): void {
    this.state.set(IDLE_SKETCH);
    this.currentSketchId = null;
    this.lastError.set(null);
    this.sketchRenderer.clear();
  }
}
