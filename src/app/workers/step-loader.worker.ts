/// <reference lib="webworker" />
import { DocBodyRef, FeatureCutTarget, FeatureRecord, FilletChamferEdgeValue, FilletChamferKind, FilletChamferRequest, HoleFeatureParams, PlaneRef, PrimitiveSpec, SketchEntity, StepWorkerRequest, StepWorkerResponse, WorkerEdge, WorkerTessellatedBody } from './step-worker-messages.model';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OcctModule = any;

const LINEAR_DEFLECTION = 0.1;
const ANGULAR_DEFLECTION = 0.5;

/**
 * Deflection for the *mesh-view* tessellation only (see `tessellateSolid`'s second pass below).
 * Much tighter than the render deflection above: OCCT's `BRepMesh_IncrementalMesh` is a
 * curvature-adaptive mesher (deflection = max chordal distance from the true surface), so
 * tightening it densifies triangles on curved/filleted regions while flat faces stay coarse
 * (a flat face is already within any deflection at just 1-2 triangles) — this is what a real
 * unstructured FEA surface mesh looks like, and it comes straight from OCCT for free. This
 * replaced an earlier approach (see `mesh-subdivision.util.ts`, now unused for this) that
 * uniformly 4-way-split the *render* triangulation instead: uniform splitting can only ever
 * produce a regular grid, never the irregular, curvature-driven density a real FEA mesh has,
 * and a prior attempt to fake irregularity with randomized jitter produced sliver/spike
 * triangles on repeated subdivision (see architecture.md's 2026-08-08 entry). Kept separate
 * from the render deflection rather than just tightening that one globally, since the render
 * mesh feeds shading/raycasting for every body all the time and a much denser render mesh
 * would regress those without ever being seen (mesh-view's wireframe is hidden by default).
 */
const MESH_VIEW_LINEAR_DEFLECTION = 0.015;
const MESH_VIEW_ANGULAR_DEFLECTION = 0.15;

/**
 * Above this many RENDER-pass triangles, `tessellateSolid` skips the fine Mesh View pass for that
 * body entirely and reuses the render triangulation for it too (same fallback the "fine pass
 * failed" case below already uses, just triggered proactively by size instead of by a thrown
 * error). The fine pass's curvature-adaptive deflection is ~7x tighter than the render pass, which
 * measured as a 7-20x triangle-count multiplier per body on a real, unusually large assembly (a
 * 112MB, 26-solid partial vehicle STEP file) — one body alone went from 321,586 render triangles
 * to 2,795,464 fine triangles, and the file's fine-pass total (6.4M triangles) came to ~10x its
 * render-pass total (653K). Mesh View is an optional wireframe overlay (off by default) built
 * unconditionally for every body at load time regardless of whether the user ever turns it on —
 * for a body already this dense at the coarse deflection, the extra fine detail is imperceptible
 * in a wireframe overlay anyway, so this trades a small amount of overlay crispness on unusually
 * large/complex bodies for a large cut in peak memory during import, without affecting the (far
 * more common) small-to-medium body case at all.
 */
const MESH_VIEW_MAX_RENDER_TRIS = 50000;

/**
 * Worker-side counterpart of the client-facing `FeatureRecord` (step-worker-messages.model.ts) —
 * same identity/replay-input fields, plus the one thing that can never leave the worker: the live
 * OCCT shape handle this feature last produced. `resultShape` is `null` only transiently, between
 * a record being appended and its first successful build (a failed build never gets appended —
 * see `handleFeatureExtrude`/`handleFeatureEdit`).
 *
 * `FeatureRecord` became a discriminated union in Slice 2 (one member per feature kind), so this
 * can no longer be a plain `interface X extends FeatureRecord` (TS2312 — `extends` doesn't
 * distribute over a union) — `& { resultShape }` intersects with EACH union member individually
 * instead, preserving the discriminant so `record.kind === 'extrude'` still correctly narrows
 * `record.params` everywhere this type is used.
 */
type SessionFeatureRecord = FeatureRecord & { resultShape: OcctModule | null };

/**
 * A modeling session keeps the OCCT document alive in the worker across multiple
 * sketch/feature operations, instead of the one-shot load-and-discard used by the STEP
 * viewer path below. Sketches are keyed by id.
 *
 * `shape` is the pre-existing (unchanged by this slice) single running accumulated shape that
 * Revolve/Sweep/Loft still exclusively read/write when they have no `targetBody` — see each of
 * their handlers below. It is NOT part of the new feature-tree machinery and is deliberately left
 * exactly as it always was, since migrating Revolve/Sweep/Loft onto feature records is out of
 * scope for this slice.
 *
 * `features` (new, parametric feature tree Slice 1) is a SEPARATE, ORDERED, APPEND-ON-CREATE list
 * of every EXTRUDE feature built via the new feature-tree-aware path, each retaining its own
 * inputs (so it can be replayed from scratch) and its own last-built shape (so unrelated features
 * don't need replaying on every edit). Dependency tracking is deliberately the simplest correct
 * thing rather than a general DAG: since only `targetRef` can point backward, "this feature and
 * everything after it in array order" is already a correct — if conservative — superset of
 * "everything that depends on this feature," because no feature in this slice can depend on more
 * than one prior feature. A real multi-input dependency graph (so an edit doesn't force-replay
 * siblings that don't actually depend on it) is out of scope for Slice 1; see the dated
 * architecture.md entry for this slice.
 *
 * `kind: 'extrude'|'revolve'|'sweep'|'loft'|'filletChamfer'` features can all live in this array
 * (Slices 1-5) — Shell/Draft/Hole-Wizard remain unmigrated and keep using their own pre-existing,
 * stateless, re-read-from-STEP-bytes path (or `shape` above) entirely untouched by this array.
 */
/** What identifies a planar face independently of its index: enough to find "the same face" again after the shape it belongs to has been rebuilt with different dimensions. */
interface FaceSignature {
  normal: [number, number, number];
  centroid: [number, number, number];
  area: number;
}

/** A sketch drawn on a face of an earlier feature's output: remembers WHICH face, so a replay can move the sketch plane with it. */
interface FaceAnchor {
  featureId: string;
  signature: FaceSignature;
}

interface StoredSketch {
  planeRef: PlaneRef;
  entities: SketchEntity[];
  /** Set only when the sketch's plane is a face of a prior feature's output (see `anchorSketchToFace`). */
  faceAnchor?: FaceAnchor;
}

interface Session {
  occt: OcctModule;
  sketches: Map<string, StoredSketch>;
  shape: OcctModule | null;
  features: SessionFeatureRecord[];
}

const sessions = new Map<string, Session>();

function post(msg: StepWorkerResponse, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(msg, transfer);
}

async function initOcct(): Promise<OcctModule> {
  post({ type: 'progress', phase: 'initializing-occt', message: 'Initializing OpenCascade kernel…', indeterminate: true });

  const mod = await import('opencascade.js/dist/opencascade.wasm.js');
  const initOpenCascade = mod.default;
  const occt: OcctModule = await initOpenCascade({
    locateFile: (path: string) => (path.endsWith('.wasm') ? 'assets/occt/opencascade.wasm.wasm' : path)
  });
  occt.STEPControl_Controller.Init();
  return occt;
}

/**
 * This build's STEP tokenizer fails to parse files using CRLF line endings (observed as
 * STEPControl_Reader.ReadFile always returning IFSelect_RetError with "DATA NOT AVAILABLE
 * FOR CHECK", even for well-formed STEP text) — stripping the CR bytes fixes it reliably.
 * Many CAD tools (SolidWorks among them) export STEP with CRLF line endings by default.
 */
function stripCarriageReturns(buffer: Uint8Array): Uint8Array {
  let crCount = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 13) crCount++;
  }
  if (crCount === 0) return buffer;

  const out = new Uint8Array(buffer.length - crCount);
  let j = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] !== 13) out[j++] = buffer[i];
  }
  return out;
}

/**
 * Collects every descendant shape of `shape` matching `type`. Deliberately NOT built on
 * `TopExp_Explorer` (the usual OCCT idiom, still used elsewhere in this file for exploring within
 * a single already-isolated solid) — `TopExp_Explorer`'s own internal traversal of a deeply nested
 * compound tree recurses natively inside the WASM binary, one call per nesting level, which for a
 * real, unusually large assembly (a 112MB, 26-solid partial vehicle STEP file, confirmed via a
 * captured browser stack trace: a repeating cycle of the same 3 wasm-function frames) overflows a
 * browser Worker's native stack — even though the exact same call succeeds instantly in Node.js,
 * whose main thread gets a larger native stack for the same WASM binary. This walks one level at a
 * time via `TopoDS_Iterator` (direct children only, no internal recursion) instead, using an
 * explicit JS array as the frontier — depth is then bounded by heap memory, not native call-stack
 * frames, so it can't overflow regardless of how deeply nested a file's product structure is.
 *
 * Each shape's children are pushed onto the frontier in REVERSE so that popping them back off (a
 * plain array used as a stack) visits them in their ORIGINAL order — matching the left-to-right,
 * depth-first order `TopExp_Explorer` itself visits in. This isn't just cosmetic: `solidIndex`
 * (this function's whole reason for existing, via `explodeSolids`) is a stable identity used
 * throughout this app — DocBodyRef, the tree's body list, "first body" UI conventions — so a
 * traversal that quietly reorders which shape ends up first is a real regression, not a harmless
 * reshuffle. Caught by `verify-loft-into-existing.mjs` failing after this function's first version
 * (which pushed children in iterator order, visiting them in REVERSE overall) picked a different,
 * much smaller body as bodyIndex 0 for the exact same file.
 */
function explodeByType(occt: OcctModule, shape: any, type: any): any[] {
  const results: any[] = [];
  const frontier: any[] = [shape];
  while (frontier.length > 0) {
    const current = frontier.pop();
    if (current.ShapeType().value === type.value) {
      results.push(current);
      continue;
    }
    const children: any[] = [];
    const it = new occt.TopoDS_Iterator_2(current, true, true);
    while (it.More()) {
      children.push(it.Value());
      it.Next();
    }
    it.delete();
    for (let i = children.length - 1; i >= 0; i--) {
      frontier.push(children[i]);
    }
  }
  return results;
}

function explodeSolids(occt: OcctModule, shape: any): any[] {
  const solids = explodeByType(occt, shape, occt.TopAbs_ShapeEnum.TopAbs_SOLID);
  if (solids.length > 0) return solids;
  const shells = explodeByType(occt, shape, occt.TopAbs_ShapeEnum.TopAbs_SHELL);
  if (shells.length > 0) return shells;
  return [shape];
}

/**
 * Runs OCCT's incremental mesher at the given deflection and reads back the resulting
 * triangulation (positions/indices/per-triangle face id). `BRepMesh_IncrementalMesh` stores
 * its result directly on the shape's faces (`BRep_Tool.Triangulation`), so calling this twice
 * on the same solid at two different deflections and reading in between (as `tessellateSolid`
 * below does) yields two independent triangulations, each reflecting its own deflection.
 */
function readTriangulation(
  occt: OcctModule,
  solid: any,
  linearDeflection: number,
  angularDeflection: number
): { positions: number[]; indices: number[]; faceIdMap: number[] } | null {
  const toDelete: any[] = [];
  try {
    const mesh = new occt.BRepMesh_IncrementalMesh_2(solid, linearDeflection, false, angularDeflection, true);
    toDelete.push(mesh);

    const positions: number[] = [];
    const indices: number[] = [];
    const faceIdMap: number[] = [];
    let vertexBase = 0;
    let faceIndex = 0;

    const faceExplorer = new occt.TopExp_Explorer_2(solid, occt.TopAbs_ShapeEnum.TopAbs_FACE, occt.TopAbs_ShapeEnum.TopAbs_SHAPE);
    toDelete.push(faceExplorer);

    while (faceExplorer.More()) {
      const face = occt.TopoDS.Face_1(faceExplorer.Current());
      const location = new occt.TopLoc_Location_1();
      toDelete.push(location);

      const triHandle = occt.BRep_Tool.Triangulation(face, location);
      if (triHandle.IsNull()) {
        faceIndex++;
        faceExplorer.Next();
        continue;
      }
      const triangulation = triHandle.get();

      const transform = location.Transformation();
      const isReversed = face.Orientation_1().value === occt.TopAbs_Orientation.TopAbs_REVERSED.value;

      const nbNodes = triangulation.NbNodes();
      for (let i = 1; i <= nbNodes; i++) {
        const pnt = triangulation.Node(i).Transformed(transform);
        positions.push(pnt.X(), pnt.Y(), pnt.Z());
        pnt.delete();
      }

      const nbTriangles = triangulation.NbTriangles();
      for (let i = 1; i <= nbTriangles; i++) {
        const tri = triangulation.Triangle(i);
        const n1 = tri.Value(1) - 1 + vertexBase;
        const n2 = tri.Value(2) - 1 + vertexBase;
        const n3 = tri.Value(3) - 1 + vertexBase;
        if (isReversed) {
          indices.push(n1, n3, n2);
        } else {
          indices.push(n1, n2, n3);
        }
        faceIdMap.push(faceIndex);
      }

      vertexBase += nbNodes;
      faceIndex++;
      faceExplorer.Next();
    }

    if (positions.length === 0) return null;
    return { positions, indices, faceIdMap };
  } finally {
    for (const obj of toDelete) {
      obj?.delete?.();
    }
  }
}

/** Number of sample points per edge polyline — enough for click-picking and a visually smooth highlight on curved edges without shipping a full curve representation to the client. */
const EDGE_SAMPLE_COUNT = 12;

/**
 * Walks every edge of a solid (same `TopExp_Explorer_2` TopAbs_EDGE order `BRepFilletAPI_*`
 * expects edge indices in, so a client-picked `WorkerEdge.index` can be handed straight back
 * as a fillet/chamfer target) and samples each one via `BRepAdaptor_Curve` into a short
 * world-space polyline. Only used for the render-deflection pass — Mesh View's fine pass has
 * no need for pickable edges.
 */
function extractEdges(occt: OcctModule, solid: any): WorkerEdge[] {
  const edges: WorkerEdge[] = [];
  const explorer = new occt.TopExp_Explorer_2(solid, occt.TopAbs_ShapeEnum.TopAbs_EDGE, occt.TopAbs_ShapeEnum.TopAbs_SHAPE);
  let index = 0;
  while (explorer.More()) {
    const edge = occt.TopoDS.Edge_1(explorer.Current());
    try {
      const curveAdaptor = new occt.BRepAdaptor_Curve_2(edge);
      const first = curveAdaptor.FirstParameter();
      const last = curveAdaptor.LastParameter();
      const points = new Float32Array(EDGE_SAMPLE_COUNT * 3);
      for (let i = 0; i < EDGE_SAMPLE_COUNT; i++) {
        const t = first + ((last - first) * i) / (EDGE_SAMPLE_COUNT - 1);
        const pnt = new occt.gp_Pnt_1();
        curveAdaptor.D0(t, pnt);
        points[i * 3] = pnt.X();
        points[i * 3 + 1] = pnt.Y();
        points[i * 3 + 2] = pnt.Z();
        pnt.delete();
      }
      curveAdaptor.delete();
      edges.push({ index, points });
    } catch {
      // A degenerate edge (rare, e.g. a cone apex) has no meaningful curve to sample — skip it
      // rather than failing the whole tessellation; its index is still consumed so later real
      // edges keep the same index as this same explorer order used elsewhere (faceIdMap etc.).
    }
    index++;
    explorer.Next();
  }
  explorer.delete();
  return edges;
}

/**
 * Builds the full body payload for one solid: the render triangulation (coarse, deflection-
 * tuned for shading/raycast cost) plus a separate, much finer triangulation used only for the
 * "Mesh View" wireframe overlay (see `MESH_VIEW_LINEAR_DEFLECTION` above) — both come from
 * OCCT's own curvature-adaptive mesher, just run twice at different deflections, rather than
 * uniformly re-splitting the render triangulation in JS.
 */
function tessellateSolid(occt: OcctModule, solid: any, index: number): WorkerTessellatedBody | null {
  const render = readTriangulation(occt, solid, LINEAR_DEFLECTION, ANGULAR_DEFLECTION);
  if (!render) return null;

  const edges = extractEdges(occt, solid);

  // Best-effort: if the fine pass fails for any reason (or is skipped outright for an already-huge
  // body — see MESH_VIEW_MAX_RENDER_TRIS above), mesh-view falls back to the render triangulation
  // client-side rather than losing the whole body.
  const renderTriCount = render.indices.length / 3;
  const fine =
    renderTriCount > MESH_VIEW_MAX_RENDER_TRIS
      ? null
      : readTriangulation(occt, solid, MESH_VIEW_LINEAR_DEFLECTION, MESH_VIEW_ANGULAR_DEFLECTION);

  let faceCount = 0;
  let edgeCount = 0;
  const fCount = new occt.TopExp_Explorer_2(solid, occt.TopAbs_ShapeEnum.TopAbs_FACE, occt.TopAbs_ShapeEnum.TopAbs_SHAPE);
  while (fCount.More()) {
    faceCount++;
    fCount.Next();
  }
  fCount.delete();
  const eCount = new occt.TopExp_Explorer_2(solid, occt.TopAbs_ShapeEnum.TopAbs_EDGE, occt.TopAbs_ShapeEnum.TopAbs_SHAPE);
  while (eCount.More()) {
    edgeCount++;
    eCount.Next();
  }
  eCount.delete();

  let volume: number | null = null;
  let surfaceArea: number | null = null;
  try {
    const volProps = new occt.GProp_GProps_1();
    occt.BRepGProp.VolumeProperties_1(solid, volProps, false, false, false);
    volume = volProps.Mass();
    volProps.delete();

    const surfProps = new occt.GProp_GProps_1();
    occt.BRepGProp.SurfaceProperties_1(solid, surfProps, false, false);
    surfaceArea = surfProps.Mass();
    surfProps.delete();
  } catch {
    // Analytical properties are best-effort; tessellated geometry still transfers without them.
  }

  return {
    solidIndex: index,
    positions: new Float32Array(render.positions),
    indices: new Uint32Array(render.indices),
    faceIdMap: new Uint32Array(render.faceIdMap),
    meshViewPositions: new Float32Array(fine ? fine.positions : render.positions),
    meshViewIndices: new Uint32Array(fine ? fine.indices : render.indices),
    edges,
    volume,
    surfaceArea,
    faceCount,
    edgeCount
  };
}

/** Transfer-list buffers for one tessellated body — every place a body is posted across the worker boundary needs the same list, now including each edge's polyline buffer alongside the two triangulations. */
function bodyTransferList(body: WorkerTessellatedBody): Transferable[] {
  return [
    body.positions.buffer,
    body.indices.buffer,
    body.faceIdMap.buffer,
    body.meshViewPositions.buffer,
    body.meshViewIndices.buffer,
    ...body.edges.map((e) => e.points.buffer)
  ];
}

/** Builds a Geom_Plane for a datum plane reference. Face-based planes are resolved by planeFromFace below. */
function planeFromDatum(occt: OcctModule, plane: 'XY' | 'YZ' | 'XZ', offset: number): OcctModule {
  const origin =
    plane === 'XY'
      ? new occt.gp_Pnt_3(0, 0, offset)
      : plane === 'YZ'
        ? new occt.gp_Pnt_3(offset, 0, 0)
        : new occt.gp_Pnt_3(0, offset, 0);
  const normal =
    plane === 'XY'
      ? new occt.gp_Dir_4(0, 0, 1)
      : plane === 'YZ'
        ? new occt.gp_Dir_4(1, 0, 0)
        : new occt.gp_Dir_4(0, 1, 0);
  const ax3 = new occt.gp_Ax3_4(origin, normal);
  const pln = new occt.gp_Pln_2(ax3);
  return new occt.Geom_Plane_2(pln);
}

/**
 * Builds a Geom_Plane for a face-based plane reference. The origin/normal here come from
 * client-side analysis of the picked face's tessellation (see face-geometry.util.ts) — the
 * worker never dereferences the pick back to a live TopoDS_Face; this mirrors planeFromDatum's
 * gp_Pnt+gp_Dir->gp_Ax3->gp_Pln->Geom_Plane construction exactly, just with a runtime origin/
 * normal instead of a fixed datum axis.
 */
function planeFromFace(occt: OcctModule, origin: [number, number, number], normal: [number, number, number]): OcctModule {
  const pnt = new occt.gp_Pnt_3(origin[0], origin[1], origin[2]);
  const dir = new occt.gp_Dir_4(normal[0], normal[1], normal[2]);
  const ax3 = new occt.gp_Ax3_4(pnt, dir);
  const pln = new occt.gp_Pln_2(ax3);
  return new occt.Geom_Plane_2(pln);
}

/** Projects a 2D sketch-plane point into 3D world coordinates for the given plane. */
function planePoint(occt: OcctModule, geomPlane: OcctModule, u: number, v: number): OcctModule {
  const pnt = new occt.gp_Pnt_1();
  geomPlane.D0(u, v, pnt);
  return pnt;
}

/** Builds a closed wire from a loop of 2D sketch-plane points (last point implicitly connects back to the first). */
function wireFromPointLoop(occt: OcctModule, geomPlane: OcctModule, points: [number, number][]): OcctModule {
  const wireMaker = new occt.BRepBuilderAPI_MakeWire_1();
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    const p1 = planePoint(occt, geomPlane, x1, y1);
    const p2 = planePoint(occt, geomPlane, x2, y2);
    const edge = new occt.BRepBuilderAPI_MakeEdge_3(p1, p2).Edge();
    wireMaker.Add_1(edge);
  }
  return wireMaker.Wire();
}

/** Regular N-sided polygon inscribed in a circle of the given radius, centered at `center`. */
function polygonPoints(center: [number, number], radius: number, sides: number): [number, number][] {
  const points: [number, number][] = [];
  for (let i = 0; i < sides; i++) {
    const angle = (i / sides) * Math.PI * 2 - Math.PI / 2;
    points.push([center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)]);
  }
  return points;
}

/** Stadium/slot outline: two straight sides plus semicircular caps, approximated as a point loop (matches the polygon path so both reuse `wireFromPointLoop`). */
function slotPoints(start: [number, number], end: [number, number], width: number): [number, number][] {
  const radius = width / 2;
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const length = Math.hypot(dx, dy) || 1;
  const nx = (-dy / length) * radius;
  const ny = (dx / length) * radius;
  const axis = Math.atan2(dy, dx);
  const CAP_SEGMENTS = 16;

  const points: [number, number][] = [
    [start[0] + nx, start[1] + ny],
    [end[0] + nx, end[1] + ny]
  ];
  for (let i = 1; i < CAP_SEGMENTS; i++) {
    const angle = axis - Math.PI / 2 + (i / CAP_SEGMENTS) * Math.PI;
    points.push([end[0] + radius * Math.cos(angle), end[1] + radius * Math.sin(angle)]);
  }
  points.push([end[0] - nx, end[1] - ny], [start[0] - nx, start[1] - ny]);
  for (let i = 1; i < CAP_SEGMENTS; i++) {
    const angle = axis + Math.PI / 2 + (i / CAP_SEGMENTS) * Math.PI;
    points.push([start[0] + radius * Math.cos(angle), start[1] + radius * Math.sin(angle)]);
  }
  return points;
}

/** Resolves the Geom_Plane for either a datum or face PlaneRef — the one place both kinds converge. */
function resolveGeomPlane(occt: OcctModule, planeRef: PlaneRef): OcctModule {
  return planeRef.kind === 'datum' ? planeFromDatum(occt, planeRef.plane, planeRef.offset) : planeFromFace(occt, planeRef.origin, planeRef.normal);
}

/**
 * Builds a closed wire from committed sketch entities on a datum or face plane. Lines form a
 * closed wire; circle/polygon/slot each form an independent closed profile (only one such
 * profile is supported per sketch). Returns the geomPlane alongside the wire so callers building
 * an extrude/sweep direction (which needs the plane's axis) don't have to re-resolve it. Split
 * out of what used to be `buildFaceFromSketch` (which additionally wrapped the wire in
 * `BRepBuilderAPI_MakeFace`) when Loft needed the bare WIRE — `BRepOffsetAPI_ThruSections` takes
 * one wire per cross-section, not a filled face, unlike every other feature built on this sketch
 * pipeline so far (Extrude/Revolve/Sweep all need a face to prism/revolve).
 */
function buildWireFromSketch(occt: OcctModule, planeRef: PlaneRef, entities: SketchEntity[]): { wire: OcctModule; geomPlane: OcctModule } {
  const geomPlane = resolveGeomPlane(occt, planeRef);

  const lines = entities.filter((e): e is Extract<SketchEntity, { type: 'line' }> => e.type === 'line');
  const circles = entities.filter((e): e is Extract<SketchEntity, { type: 'circle' }> => e.type === 'circle');
  const polygons = entities.filter((e): e is Extract<SketchEntity, { type: 'polygon' }> => e.type === 'polygon');
  const slots = entities.filter((e): e is Extract<SketchEntity, { type: 'slot' }> => e.type === 'slot');

  if (lines.length > 0) {
    const wireMaker = new occt.BRepBuilderAPI_MakeWire_1();
    for (const line of lines) {
      const p1 = planePoint(occt, geomPlane, line.points[0][0], line.points[0][1]);
      const p2 = planePoint(occt, geomPlane, line.points[1][0], line.points[1][1]);
      const edge = new occt.BRepBuilderAPI_MakeEdge_3(p1, p2).Edge();
      wireMaker.Add_1(edge);
    }
    return { wire: wireMaker.Wire(), geomPlane };
  }

  if (circles.length === 1) {
    const c = circles[0];
    const center = planePoint(occt, geomPlane, c.center[0], c.center[1]);
    const ax2 = new occt.gp_Ax2_3(center, geomPlane.Axis().Direction());
    const circle = new occt.gp_Circ_2(ax2, c.radius);
    const edge = new occt.BRepBuilderAPI_MakeEdge_8(circle).Edge();
    const wireMaker = new occt.BRepBuilderAPI_MakeWire_2(edge);
    return { wire: wireMaker.Wire(), geomPlane };
  }

  if (polygons.length === 1) {
    const p = polygons[0];
    const wire = wireFromPointLoop(occt, geomPlane, polygonPoints(p.center, p.radius, p.sides));
    return { wire, geomPlane };
  }

  if (slots.length === 1) {
    const s = slots[0];
    const wire = wireFromPointLoop(occt, geomPlane, slotPoints(s.start, s.end, s.width));
    return { wire, geomPlane };
  }

  throw new Error('Sketch has no closed profile (need a closed line loop, or a single circle/polygon/slot)');
}

/**
 * Builds a face from committed sketch entities — thin wrapper over `buildWireFromSketch` that
 * additionally wraps the wire in `BRepBuilderAPI_MakeFace`, for every caller that needs a solid
 * cross-section to prism/revolve rather than a bare profile outline (Extrude, Revolve, Sweep).
 */
function buildFaceFromSketch(occt: OcctModule, planeRef: PlaneRef, entities: SketchEntity[]): { face: OcctModule; geomPlane: OcctModule } {
  const { wire, geomPlane } = buildWireFromSketch(occt, planeRef, entities);
  const faceMaker = new occt.BRepBuilderAPI_MakeFace_15(wire, true);
  return { face: faceMaker.Face(), geomPlane };
}

/** Builds the OCCT shape for a standalone primitive spec. Position is applied via BRepBuilderAPI_Transform so all 4 primitive kinds share one placement step. */
function buildPrimitiveShape(occt: OcctModule, spec: PrimitiveSpec): OcctModule {
  let local: OcctModule;
  switch (spec.kind) {
    case 'box':
      local = new occt.BRepPrimAPI_MakeBox_1(spec.width, spec.depth, spec.height).Shape();
      break;
    case 'cylinder':
      local = new occt.BRepPrimAPI_MakeCylinder_1(spec.radius, spec.height).Shape();
      break;
    case 'sphere':
      local = new occt.BRepPrimAPI_MakeSphere_1(spec.radius).Shape();
      break;
    case 'cone':
      local = new occt.BRepPrimAPI_MakeCone_1(spec.radius1, spec.radius2, spec.height).Shape();
      break;
  }

  const [x, y, z] = spec.origin;
  if (x === 0 && y === 0 && z === 0) return local;

  const transform = new occt.gp_Trsf_1();
  transform.SetTranslation_1(new occt.gp_Vec_4(x, y, z));
  const transformer = new occt.BRepBuilderAPI_Transform_2(local, transform, false);
  return transformer.Shape();
}

let primitiveOcct: OcctModule | null = null;

async function handlePrimitiveCreate(req: Extract<StepWorkerRequest, { type: 'primitive.create' }>): Promise<void> {
  try {
    primitiveOcct ??= await initOcct();
    const shape = buildPrimitiveShape(primitiveOcct, req.spec);
    const body = tessellateSolid(primitiveOcct, shape, 0);
    if (!body) {
      post({ type: 'primitive.result', requestId: req.requestId, body: null, success: false, error: 'Primitive produced no triangulation' });
      return;
    }
    post({ type: 'primitive.result', requestId: req.requestId, body, success: true }, bodyTransferList(body));
  } catch (err) {
    post({ type: 'primitive.result', requestId: req.requestId, body: null, success: false, error: err instanceof Error ? err.message : String(err) });
  }
}

function tessellateShapeBodies(occt: OcctModule, shape: OcctModule): WorkerTessellatedBody[] {
  const solids = explodeSolids(occt, shape);
  const bodies: WorkerTessellatedBody[] = [];
  for (let i = 0; i < solids.length; i++) {
    const body = tessellateSolid(occt, solids[i], i);
    if (body) bodies.push(body);
  }
  return bodies;
}

async function handleSessionStart(req: Extract<StepWorkerRequest, { type: 'session.start' }>): Promise<void> {
  const occt: OcctModule = await initOcct();
  sessions.set(req.sessionId, { occt, sketches: new Map(), shape: null, features: [] });
  post({ type: 'session.ready', sessionId: req.sessionId });
}

function handleSessionDispose(req: Extract<StepWorkerRequest, { type: 'session.dispose' }>): void {
  const session = sessions.get(req.sessionId);
  session?.shape?.delete?.();
  // Every retained feature's last-built shape needs explicit disposal now that the session can
  // accumulate many of them over its lifetime via the new feature-tree array — leaving these
  // undisposed would leak one OCCT handle per feature ever built in the session, not just one.
  for (const feature of session?.features ?? []) {
    feature.resultShape?.delete?.();
  }
  sessions.delete(req.sessionId);
}

/** Looks up an existing feature record by id, or throws — shared by handleFeatureEdit and any future edit-aware handler. */
function findFeatureRecord(session: Session, featureId: string): SessionFeatureRecord {
  const record = session.features.find((f) => f.featureId === featureId);
  if (!record) throw new Error(`Feature ${featureId} not found in this session's history`);
  return record;
}

/**
 * Resolves a `DocBodyRef` to the actual OCCT solid it names — either re-reading STEP bytes
 * (`kind: 'imported'`, identical to `cutOrFuseAgainstTarget`'s own pre-existing `targetBody`
 * handling) or reading a prior feature's own cached `resultShape` (`kind: 'feature'`, the new
 * capability this slice adds — a target that lives inside the session's own history instead of
 * only ever being an external STEP re-read).
 */
function resolveDocBodyRef(occt: OcctModule, session: Session, ref: DocBodyRef): OcctModule {
  if (ref.kind === 'imported') {
    const { shape: sourceShape, lastStatus } = readStepShape(occt, ref.bytes);
    if (!sourceShape) {
      throw new Error(`Failed to re-read target body's STEP source (IFSelect_ReturnStatus=${lastStatus})`);
    }
    const solids = explodeSolids(occt, sourceShape);
    const targetSolid = solids[ref.solidIndex];
    if (!targetSolid) {
      throw new Error(`Target body's solid index ${ref.solidIndex} not found in its re-read STEP source`);
    }
    return targetSolid;
  }

  const targetRecord = findFeatureRecord(session, ref.featureId);
  if (!targetRecord.resultShape) {
    throw new Error(`Feature ${ref.featureId} has no built shape to target (it may have failed its last build)`);
  }
  return targetRecord.resultShape;
}

/** Normal, centroid and area of every planar face of `shape` (non-planar faces are skipped). Normals are outward: a reversed face's plane normal is flipped. */
function planarFaceSignatures(occt: OcctModule, shape: OcctModule): FaceSignature[] {
  const signatures: FaceSignature[] = [];
  const explorer = new occt.TopExp_Explorer_2(shape, occt.TopAbs_ShapeEnum.TopAbs_FACE, occt.TopAbs_ShapeEnum.TopAbs_SHAPE);
  for (; explorer.More(); explorer.Next()) {
    const face = occt.TopoDS.Face_1(explorer.Current());
    const surface = new occt.BRepAdaptor_Surface_2(face, true);
    if (surface.GetType().value !== occt.GeomAbs_SurfaceType.GeomAbs_Plane.value) continue;

    const direction = surface.Plane().Axis().Direction();
    const sign = face.Orientation_1().value === occt.TopAbs_Orientation.TopAbs_REVERSED.value ? -1 : 1;
    const props = new occt.GProp_GProps_1();
    occt.BRepGProp.SurfaceProperties_1(face, props, false, false);
    const centre = props.CentreOfMass();
    signatures.push({
      normal: [sign * direction.X(), sign * direction.Y(), sign * direction.Z()],
      centroid: [centre.X(), centre.Y(), centre.Z()],
      area: props.Mass()
    });
  }
  return signatures;
}

/** Rough size of a set of faces (extent of their centroids), used to make distance tolerances scale-free. */
function signaturesScale(signatures: FaceSignature[]): number {
  if (signatures.length === 0) return 1;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const s of signatures) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], s.centroid[i]);
      max[i] = Math.max(max[i], s.centroid[i]);
    }
  }
  return Math.max(Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]), Math.sqrt(Math.max(...signatures.map((s) => s.area))), 1);
}

const dot3 = (a: [number, number, number], b: [number, number, number]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Records which planar face of `targetShape` a sketch plane lies on, so `reanchorSketch` can find that
 * face again after the target is rebuilt. Returns null when no planar face has the plane's normal and
 * contains its origin (e.g. a free reference plane), in which case the sketch simply stays where it is.
 */
function anchorSketchToFace(occt: OcctModule, targetShape: OcctModule, planeRef: PlaneRef): FaceSignature | null {
  if (planeRef.kind !== 'face') return null;
  const signatures = planarFaceSignatures(occt, targetShape);
  const scale = signaturesScale(signatures);
  const planeTolerance = 1e-3 * scale + 1e-4;

  let best: FaceSignature | null = null;
  let bestDistance = Infinity;
  for (const s of signatures) {
    if (dot3(s.normal, planeRef.normal) < 0.999) continue;
    const offset: [number, number, number] = [planeRef.origin[0] - s.centroid[0], planeRef.origin[1] - s.centroid[1], planeRef.origin[2] - s.centroid[2]];
    if (Math.abs(dot3(offset, s.normal)) > planeTolerance) continue; // the sketch plane is not this face's plane
    const distance = Math.hypot(...offset);
    if (distance < bestDistance) {
      best = s;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Finds the face of the rebuilt `targetShape` that corresponds to `anchor`: it must face the same way,
 * and among those the one whose area and position changed least. Movement ALONG the normal (the face
 * got taller or shorter) is expected and only lightly penalised; movement within the plane is not.
 */
function findAnchoredFace(signatures: FaceSignature[], anchor: FaceSignature): FaceSignature | null {
  const scale = signaturesScale(signatures);
  let best: FaceSignature | null = null;
  let bestScore = Infinity;
  for (const s of signatures) {
    if (dot3(s.normal, anchor.normal) < 0.999) continue;
    const delta: [number, number, number] = [s.centroid[0] - anchor.centroid[0], s.centroid[1] - anchor.centroid[1], s.centroid[2] - anchor.centroid[2]];
    const along = dot3(delta, anchor.normal);
    const inPlane = Math.hypot(delta[0] - along * anchor.normal[0], delta[1] - along * anchor.normal[1], delta[2] - along * anchor.normal[2]);
    const areaChange = Math.abs(s.area - anchor.area) / Math.max(s.area, anchor.area, 1e-9);
    const score = areaChange + (2 * inPlane) / scale + (0.25 * Math.abs(along)) / scale;
    if (score < bestScore) {
      best = s;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Returns the sketch as it should be built during a replay. A sketch drawn on a face of a prior
 * feature's output has its plane moved by however far that face's centroid moved when the feature was
 * rebuilt, so what was built on the face follows it (a boss stays on top of a block whose depth was
 * edited). The stored plane is never modified: the shift is always computed from the ORIGINAL plane
 * and signature, so repeated edits, and undo back to the original, are exact and don't accumulate error.
 * Throws when the face can no longer be found, rather than silently building in the wrong place.
 */
function reanchorSketch(occt: OcctModule, session: Session, sketch: StoredSketch): StoredSketch {
  const anchor = sketch.faceAnchor;
  if (!anchor || sketch.planeRef.kind !== 'face') return sketch;

  const anchorRecord = session.features.find((f) => f.featureId === anchor.featureId);
  if (!anchorRecord?.resultShape) {
    throw new Error(`Feature ${anchor.featureId}, which this feature was sketched on, has no built shape to attach to`);
  }

  const face = findAnchoredFace(planarFaceSignatures(occt, anchorRecord.resultShape), anchor.signature);
  if (!face) {
    throw new Error('The face this feature was sketched on no longer exists after the edit (nothing faces the same way any more), so the sketch cannot be attached to it. Try a smaller change.');
  }

  const shift = [face.centroid[0] - anchor.signature.centroid[0], face.centroid[1] - anchor.signature.centroid[1], face.centroid[2] - anchor.signature.centroid[2]];
  const origin = sketch.planeRef.origin;
  return {
    ...sketch,
    planeRef: { ...sketch.planeRef, origin: [origin[0] + shift[0], origin[1] + shift[1], origin[2] + shift[2]] }
  };
}

function handleSketchCommit(req: Extract<StepWorkerRequest, { type: 'sketch.commit' }>): void {
  const session = sessions.get(req.sessionId);
  if (!session) {
    post({ type: 'sketch.result', sessionId: req.sessionId, sketchId: req.sketchId, success: false, error: 'No active session' });
    return;
  }
  try {
    // Validate the sketch actually resolves to a face now, so failures surface immediately
    // rather than at extrude time.
    buildFaceFromSketch(session.occt, req.planeRef, req.entities);

    // Sketch on a face of a prior feature's output: remember which face, so a later edit of that
    // feature carries the sketch with it (see `reanchorSketch`). Not finding a matching face is not
    // an error — a free reference plane, for example, legitimately stays where it is.
    let faceAnchor: FaceAnchor | undefined;
    if (req.faceAnchorFeatureId) {
      const anchorRecord = session.features.find((f) => f.featureId === req.faceAnchorFeatureId);
      const signature = anchorRecord?.resultShape ? anchorSketchToFace(session.occt, anchorRecord.resultShape, req.planeRef) : null;
      if (signature) faceAnchor = { featureId: req.faceAnchorFeatureId, signature };
    }

    session.sketches.set(req.sketchId, { planeRef: req.planeRef, entities: req.entities, faceAnchor });
    post({ type: 'sketch.result', sessionId: req.sessionId, sketchId: req.sketchId, success: true });
  } catch (err) {
    post({
      type: 'sketch.result',
      sessionId: req.sessionId,
      sketchId: req.sketchId,
      success: false,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

/**
 * Boolean Cut/Fuse of `newSolid` against an existing body's own solid (or, absent a targetBody,
 * this session's own accumulated shape) — extracted out of what used to be `handleFeatureExtrude`
 * alone once Revolve/Sweep/Loft all needed the identical logic to gain their own cut/fuse-into-
 * an-existing-part support (2026-09-13). Re-reads `targetBody`'s STEP source using `occt` (the
 * SAME module instance `newSolid` was built with, since OCCT shape handles are tied to the module
 * instance that created them) rather than dereferencing back to a live TopoDS shape. Returns
 * `targetIsExternal` so the caller knows whether to update `session.shape` afterward — a
 * targetBody cut/fuse is a standalone operation against that one body's own solid, never chained
 * into this session's own accumulated shape.
 */
function cutOrFuseAgainstTarget(
  occt: OcctModule,
  session: Session,
  newSolid: OcctModule,
  cut: boolean | undefined,
  targetBody: FeatureCutTarget | undefined
): { resultShape: OcctModule; targetIsExternal: boolean } {
  let cutFuseTarget: OcctModule | null = session.shape;
  let targetIsExternal = false;
  if (targetBody) {
    const { shape: sourceShape, lastStatus } = readStepShape(occt, targetBody.bytes);
    if (!sourceShape) {
      throw new Error(`Failed to re-read target body's STEP source (IFSelect_ReturnStatus=${lastStatus})`);
    }
    const solids = explodeSolids(occt, sourceShape);
    const targetSolid = solids[targetBody.solidIndex];
    if (!targetSolid) {
      throw new Error(`Target body's solid index ${targetBody.solidIndex} not found in its re-read STEP source`);
    }
    cutFuseTarget = targetSolid;
    targetIsExternal = true;
  }

  let resultShape = newSolid;
  if (cut && cutFuseTarget) {
    const cutter = new occt.BRepAlgoAPI_Cut_1();
    const argsList = new occt.TopTools_ListOfShape_1();
    argsList.Append_1(cutFuseTarget);
    const toolsList = new occt.TopTools_ListOfShape_1();
    toolsList.Append_1(newSolid);
    cutter.SetArguments(argsList);
    cutter.SetTools(toolsList);
    cutter.Build();
    if (!cutter.IsDone()) {
      throw new Error('Boolean cut failed');
    }
    resultShape = cutter.Shape();
  } else if (cutFuseTarget) {
    const fuser = new occt.BRepAlgoAPI_Fuse_1();
    const argsList = new occt.TopTools_ListOfShape_1();
    argsList.Append_1(cutFuseTarget);
    const toolsList = new occt.TopTools_ListOfShape_1();
    toolsList.Append_1(newSolid);
    fuser.SetArguments(argsList);
    fuser.SetTools(toolsList);
    fuser.Build();
    if (!fuser.IsDone()) {
      throw new Error('Boolean fuse failed');
    }
    resultShape = fuser.Shape();
  }

  return { resultShape, targetIsExternal };
}

/**
 * Builds ONLY the raw extruded tool solid from a committed sketch + depth/cut params — no
 * cut/fuse against any target, no tessellation, no session/feature-record bookkeeping. Factored
 * out of the original inline `handleFeatureExtrude` body so `buildExtrudeFeatureShape` (the new
 * feature-tree-aware path, used by both creation and edit/replay) and the original
 * `handleFeatureExtrude` (still used for every non-feature-tree extrude call, unaffected by this
 * slice) can share it byte-for-byte instead of the replay path re-deriving this logic separately
 * and risking drift from the original.
 */
function buildExtrudeToolSolid(occt: OcctModule, sketch: { planeRef: PlaneRef; entities: SketchEntity[] }, depth: number, isCutIntoExisting: boolean): OcctModule {
  const { face, geomPlane } = buildFaceFromSketch(occt, sketch.planeRef, sketch.entities);
  // Extrude along the sketch plane's own axis (already used this way for circle construction
  // above) rather than a datum-only literal — works identically for datum and face planes,
  // and fixes a latent bug where a `kind:'face'` PlaneRef fell through to the XZ-normal case.
  const axisDir = geomPlane.Axis().Direction();

  // getFacePlane (client-side) derives the plane normal by averaging the picked face's
  // triangle normals, which for a face on a solid points OUTWARD (away from material) — the
  // right direction to grow a boss/fuse, but the WRONG direction for a cut: a tool solid
  // extruded only outward sits outside the part, barely touching it at the sketch plane, so
  // BRepAlgoAPI_Cut technically succeeds (IsDone() true) but removes nothing because the tool
  // never actually overlaps the part's interior. When cutting against a real target body,
  // extrude the tool symmetrically both ways from the sketch plane instead — guarantees it
  // punches through the material regardless of which way the face normal happens to point,
  // matching how mainstream CAD tools default a cut to "through both directions" rather than
  // trusting a single guessed sign.
  const outward = new occt.gp_Vec_4(axisDir.X() * depth, axisDir.Y() * depth, axisDir.Z() * depth);
  if (isCutIntoExisting) {
    const inward = new occt.gp_Vec_4(-axisDir.X() * depth, -axisDir.Y() * depth, -axisDir.Z() * depth);
    const outwardPrism = new occt.BRepPrimAPI_MakePrism_1(face, outward, false, true).Shape();
    const inwardPrism = new occt.BRepPrimAPI_MakePrism_1(face, inward, false, true).Shape();
    const fuser = new occt.BRepAlgoAPI_Fuse_1();
    const argsList = new occt.TopTools_ListOfShape_1();
    argsList.Append_1(outwardPrism);
    const toolsList = new occt.TopTools_ListOfShape_1();
    toolsList.Append_1(inwardPrism);
    fuser.SetArguments(argsList);
    fuser.SetTools(toolsList);
    fuser.Build();
    if (!fuser.IsDone()) {
      throw new Error('Failed to build symmetric cut tool');
    }
    return fuser.Shape();
  }
  return new occt.BRepPrimAPI_MakePrism_1(face, outward, false, true).Shape();
}

/**
 * Plain boolean Cut/Fuse of `newSolid` against `cutFuseTarget` (or a no-op passthrough when
 * `cutFuseTarget` is null) — the one piece of `handleFeatureExtrude`'s original inline logic that
 * is genuinely shared across every feature-tree-aware handler AND the replay loop
 * (`handleFeatureEdit`), factored out in Slice 2 once Revolve needed it a third time rather than
 * risking a third copy drifting from the other two. Deliberately separate from the pre-existing
 * `cutOrFuseAgainstTarget` helper below, which ALSO resolves a plain `FeatureCutTarget` internally
 * (a responsibility this helper's callers already handle themselves via `resolveDocBodyRef`/
 * `session.shape` fallback) — merging the two would force every unmigrated caller of
 * `cutOrFuseAgainstTarget` (Sweep/Loft) to change shape for no benefit to them.
 */
function cutOrFuseNewSolid(occt: OcctModule, newSolid: OcctModule, cut: boolean, cutFuseTarget: OcctModule | null): OcctModule {
  if (!cutFuseTarget) return newSolid;
  if (cut) {
    const cutter = new occt.BRepAlgoAPI_Cut_1();
    const argsList = new occt.TopTools_ListOfShape_1();
    argsList.Append_1(cutFuseTarget);
    const toolsList = new occt.TopTools_ListOfShape_1();
    toolsList.Append_1(newSolid);
    cutter.SetArguments(argsList);
    cutter.SetTools(toolsList);
    cutter.Build();
    if (!cutter.IsDone()) throw new Error('Boolean cut failed');
    return cutter.Shape();
  }
  const fuser = new occt.BRepAlgoAPI_Fuse_1();
  const argsList = new occt.TopTools_ListOfShape_1();
  argsList.Append_1(cutFuseTarget);
  const toolsList = new occt.TopTools_ListOfShape_1();
  toolsList.Append_1(newSolid);
  fuser.SetArguments(argsList);
  fuser.SetTools(toolsList);
  fuser.Build();
  if (!fuser.IsDone()) throw new Error('Boolean fuse failed');
  return fuser.Shape();
}

/**
 * `feature.extrude`'s `targetBody` is a `DocBodyRef` (STEP-imported OR a prior feature's own
 * output — see that type's docstring), unlike Sweep/Loft's plain `FeatureCutTarget`-only
 * `targetBody`, so this handler resolves it via `resolveDocBodyRef` directly rather than the
 * shared `cutOrFuseAgainstTarget` helper (which only understands the plain STEP-bytes shape and
 * stays exactly as-is for the two still-unmigrated tools that call it). `handleFeatureRevolve`
 * below shares this exact shape (added in Slice 2).
 */
function handleFeatureExtrude(req: Extract<StepWorkerRequest, { type: 'feature.extrude' }>): void {
  const session = sessions.get(req.sessionId);
  const sketch = session?.sketches.get(req.sketchId);
  if (!session || !sketch) {
    post({ type: 'feature.result', sessionId: req.sessionId, featureId: req.featureId, bodies: [], success: false, error: 'Sketch not found' });
    return;
  }

  try {
    const occt = session.occt;
    const isCutIntoExisting = req.cut && !!req.targetBody;
    const newSolid = buildExtrudeToolSolid(occt, sketch, req.depth, isCutIntoExisting);

    // Resolve whatever this extrude should be cut/fused against: an explicit `req.targetBody`
    // (imported STEP body OR a prior feature's own output — see DocBodyRef's docstring) takes
    // priority; absent that, an UNMIGRATED (no `producesBodyId`) call falls back to the
    // pre-existing session.shape-chaining behavior, exactly as before this slice. A
    // feature-tree-aware call (`producesBodyId` set) with no `targetBody` is a standalone new
    // body by definition and never touches session.shape at all — it would be wrong for editing
    // feature A to ever perturb some unrelated chained shape it was never told about.
    let cutFuseTarget: OcctModule | null = null;
    let targetIsExternal = false;
    if (req.targetBody) {
      cutFuseTarget = resolveDocBodyRef(occt, session, req.targetBody);
      targetIsExternal = true;
    } else if (!req.producesBodyId) {
      cutFuseTarget = session.shape;
    }

    const resultShape = cutOrFuseNewSolid(occt, newSolid, req.cut, cutFuseTarget);

    // A targetBody cut/fuse is a standalone operation against that one body's own solid, not
    // chained into this session's own accumulated shape — only update session.shape for the
    // pre-existing, unmigrated session-shape-chaining path.
    if (!targetIsExternal && !req.producesBodyId) {
      session.shape = resultShape;
    }

    // Feature-tree bookkeeping (Slice 1): only when the caller opted in by passing
    // `producesBodyId` — every pre-existing, unmigrated extrude call keeps `producesBodyId`
    // undefined and skips this entirely, so `session.features` only ever contains features
    // created through the new feature-tree-aware flow.
    if (req.producesBodyId) {
      session.features.push({
        featureId: req.featureId,
        kind: 'extrude',
        sketchId: req.sketchId,
        params: { depth: req.depth, cut: req.cut },
        targetRef: req.targetBody ?? null,
        producesBodyId: req.producesBodyId,
        resultShape
      });
    }

    const bodies = tessellateShapeBodies(occt, resultShape);
    if (req.producesBodyId) {
      for (const b of bodies) b.producesBodyId = req.producesBodyId;
    }
    const transfer: Transferable[] = bodies.flatMap(bodyTransferList);
    post(
      { type: 'feature.result', sessionId: req.sessionId, featureId: req.featureId, bodies, success: true },
      transfer
    );
  } catch (err) {
    post({
      type: 'feature.result',
      sessionId: req.sessionId,
      featureId: req.featureId,
      bodies: [],
      success: false,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

/**
 * Edits an existing extrude feature's params and replays it plus every feature after it in the
 * session's history (array order — a correct, if conservative, stand-in for a real dependency
 * graph; see `Session.features`'s own docstring). Each replayed feature's OLD `resultShape` is
 * explicitly disposed before being overwritten (the disposal-correctness fix this slice adds —
 * see the dated architecture.md entry — since these shapes now live far longer than the old bare
 * `shape` scalar ever did). A failure partway through leaves every feature already replayed in
 * this call updated, and aborts before touching the rest — surfaced as a normal error response,
 * same convention as every other feature handler in this worker.
 */
async function handleFeatureEdit(req: Extract<StepWorkerRequest, { type: 'feature.edit' }>): Promise<void> {
  const session = sessions.get(req.sessionId);
  if (!session) {
    post({ type: 'feature.result', sessionId: req.sessionId, featureId: req.featureId, bodies: [], success: false, error: 'No active session' });
    return;
  }

  try {
    const occt = session.occt;
    const editIndex = session.features.findIndex((f) => f.featureId === req.featureId);
    if (editIndex === -1) {
      throw new Error(`Feature ${req.featureId} not found in this session's history`);
    }

    const editedRecord = session.features[editIndex];
    const editParams = req.params;
    // Branching on both discriminants together (rather than a single `!==` check plus a cast)
    // lets TypeScript verify each assignment's params type directly against the matching
    // FeatureRecord union member — no unsound cast needed.
    if (editedRecord.kind === 'extrude' && editParams.kind === 'extrude') {
      editedRecord.params = editParams;
    } else if (editedRecord.kind === 'revolve' && editParams.kind === 'revolve') {
      editedRecord.params = editParams;
    } else if (editedRecord.kind === 'sweep' && editParams.kind === 'sweep') {
      editedRecord.params = editParams;
    } else if (editedRecord.kind === 'loft' && editParams.kind === 'loft') {
      editedRecord.params = editParams;
    } else if (editedRecord.kind === 'filletChamfer' && editParams.kind === 'filletChamfer') {
      editedRecord.params = { filletChamferKind: editParams.filletChamferKind, edges: editParams.edges };
    } else if (editedRecord.kind === 'hole' && editParams.kind === 'hole') {
      const { kind: _kind, ...holeParams } = editParams;
      editedRecord.params = holeParams;
    } else {
      throw new Error(`Feature ${req.featureId} is a '${editedRecord.kind}' feature — cannot edit it with '${editParams.kind}' params`);
    }

    const allResultBodies: WorkerTessellatedBody[] = [];
    for (let i = editIndex; i < session.features.length; i++) {
      const record = session.features[i];

      // Fillet/Chamfer isn't a sketch-based feature at all (no sketch to read, no cut/fuse step
      // — BRepFilletAPI's own Shape() IS the final result) and always has a real `targetRef`
      // (never null, unlike the other four kinds' optional standalone-body case), so it gets its
      // own early branch rather than falling into the sketch-resolution/cut-fuse path below. The
      // actual build runs in a fresh throwaway Worker (same `runFilletChamferViaMainThread` bridge
      // `handleFeatureFilletChamfer` uses) — see that function's own docstring for the confirmed
      // WASM-build limitation this works around; a replay calling `buildFilletChamferToolSolid`
      // directly in THIS session's own module would hit the identical bug on the second edit.
      if (record.kind === 'filletChamfer') {
        const { bytes: targetBytes, solidIndex } = resolveDocBodyRefToStepBytes(occt, session, record.targetRef);
        const { body, resultBytes } = await runFilletChamferViaMainThread(record.params.filletChamferKind, targetBytes, solidIndex, record.params.edges);

        const { shape: reimportedShape, lastStatus } = readStepShape(occt, resultBytes);
        if (!reimportedShape) {
          throw new Error(`Failed to re-import fillet/chamfer replay result (IFSelect_ReturnStatus=${lastStatus})`);
        }
        const reimportedSolids = explodeSolids(occt, reimportedShape);
        const resultShape = reimportedSolids[0] ?? reimportedShape;

        record.resultShape?.delete?.();
        record.resultShape = resultShape;

        body.producesBodyId = record.producesBodyId;
        allResultBodies.push(body);
        continue;
      }

      // A hole is always a cut into its (non-null) target, and has no Cut checkbox of its own.
      if (record.kind === 'hole') {
        const storedSketch = session.sketches.get(record.sketchId);
        if (!storedSketch) {
          throw new Error(`Feature ${record.featureId}'s sketch ${record.sketchId} is missing — cannot replay`);
        }
        const holeTool = buildHoleToolSolid(occt, reanchorSketch(occt, session, storedSketch), record.params);
        const resultShape = cutOrFuseNewSolid(occt, holeTool, true, resolveDocBodyRef(occt, session, record.targetRef));

        record.resultShape?.delete?.();
        record.resultShape = resultShape;

        const bodies = tessellateShapeBodies(occt, resultShape);
        for (const b of bodies) b.producesBodyId = record.producesBodyId;
        allResultBodies.push(...bodies);
        continue;
      }

      // Sketch resolution varies by kind, not just the solid-builder choice below: every kind
      // except Loft reads exactly one sketch (`record.sketchId`); Loft blends between 2+
      // (`record.sketchIds`) and needs ALL of them present to replay at all — checked up front as
      // a list, same "missing sketch" error shape the other three kinds already throw per-sketch.
      const isCutIntoExisting = record.params.cut && !!record.targetRef;
      let newSolid: OcctModule;
      if (record.kind === 'loft') {
        // Loft only ever replays with `producesBodyId` set (the sole condition its own create
        // path pushes a session.features record under — see handleFeatureLoft), so unlike the
        // shared cut-only `isCutIntoExisting` above, Loft's own broadened Cut-OR-Fuse condition
        // (see buildLoftToolSolid's docstring for why Fuse needs it too) simplifies to just
        // whether a target is present at all.
        const loftWillBooleanAgainstTarget = !!record.targetRef;
        // Each profile is re-anchored independently (a no-op for one with no faceAnchor, e.g. a
        // profile drawn on a datum plane) — not just the first: any profile drawn on a face of a
        // feature-tree body should track that face if that feature is edited, the same as a
        // single-sketch feature's own sketch does, even though only the FIRST profile's pickedFace
        // additionally drives cut/fuse targeting (see buildLoftToolSolid's own docstring).
        const sketches = record.sketchIds.map((sketchId) => {
          const storedSketch = session.sketches.get(sketchId);
          if (!storedSketch) {
            throw new Error(`Feature ${record.featureId}'s profile ${sketchId} is missing — cannot replay`);
          }
          return reanchorSketch(occt, session, storedSketch);
        });
        newSolid = buildLoftToolSolid(occt, sketches, loftWillBooleanAgainstTarget);
      } else {
        const storedSketch = session.sketches.get(record.sketchId);
        if (!storedSketch) {
          throw new Error(`Feature ${record.featureId}'s sketch ${record.sketchId} is missing — cannot replay`);
        }
        // A sketch drawn on a face of an earlier feature moves with that face (the earlier feature
        // has already been replayed by this loop, so its `resultShape` is the edited one).
        const sketch = reanchorSketch(occt, session, storedSketch);
        if (record.kind === 'extrude') {
          newSolid = buildExtrudeToolSolid(occt, sketch, record.params.depth, isCutIntoExisting);
        } else if (record.kind === 'revolve') {
          newSolid = buildRevolveToolSolid(occt, sketch, record.params.axis, record.params.angleDeg, isCutIntoExisting);
        } else {
          newSolid = buildSweepToolSolid(occt, sketch, record.params.axis, record.params.tiltDeg, record.params.distance, isCutIntoExisting);
        }
      }

      const cutFuseTarget = record.targetRef ? resolveDocBodyRef(occt, session, record.targetRef) : null;
      const resultShape = cutOrFuseNewSolid(occt, newSolid, record.params.cut, cutFuseTarget);

      record.resultShape?.delete?.();
      record.resultShape = resultShape;

      const bodies = tessellateShapeBodies(occt, resultShape);
      for (const b of bodies) b.producesBodyId = record.producesBodyId;
      allResultBodies.push(...bodies);
    }

    const transfer: Transferable[] = allResultBodies.flatMap(bodyTransferList);
    post({ type: 'feature.result', sessionId: req.sessionId, featureId: req.featureId, bodies: allResultBodies, success: true }, transfer);
  } catch (err) {
    post({
      type: 'feature.result',
      sessionId: req.sessionId,
      featureId: req.featureId,
      bodies: [],
      success: false,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

/**
 * Builds a Hole Wizard hole's cutting tool: a through-cylinder spanning `params.depth` both ways
 * from the face (the same "cut both ways" guarantee `buildExtrudeToolSolid` uses for cuts), fused
 * with a counterbore cylinder or countersink cone that sinks INTO the part along the face's
 * inward normal (the sketch plane's normal is the picked face's OUTWARD normal — see
 * `buildExtrudeToolSolid`'s own comment). The entry feature also pokes a short way OUT of the face,
 * so its top cap is never coplanar with the face itself — the exact-coincidence degeneracy that
 * made Loft's cut silently remove nothing (2026-09-23 entry). The extension is kept short rather
 * than reusing `depth`, so a counterbore/countersink on a recessed face can't gouge nearby walls
 * above it. Verified against analytical volumes in a Node kernel probe: simple, counterbore and
 * 90° countersink cuts in a box all matched to ~1e-11 mm³.
 */
function buildHoleToolSolid(occt: OcctModule, sketch: { planeRef: PlaneRef; entities: SketchEntity[] }, params: HoleFeatureParams): OcctModule {
  const circle = sketch.entities.find((e): e is Extract<SketchEntity, { type: 'circle' }> => e.type === 'circle');
  if (!circle) throw new Error('Hole sketch has no center circle');
  const { holeType, diameter, depth, cboreDiameter, cboreDepth, csinkDiameter, csinkAngleDeg } = params;
  if (!(diameter > 0) || !(depth > 0)) throw new Error('Hole diameter must be greater than zero');

  const geomPlane = resolveGeomPlane(occt, sketch.planeRef);
  const center = planePoint(occt, geomPlane, circle.center[0], circle.center[1]);
  const n = geomPlane.Axis().Direction();
  const axisAt = (offsetAlongNormal: number) =>
    new occt.gp_Ax2_3(new occt.gp_Pnt_3(center.X() + n.X() * offsetAlongNormal, center.Y() + n.Y() * offsetAlongNormal, center.Z() + n.Z() * offsetAlongNormal), n);

  const radius = diameter / 2;
  const through = new occt.BRepPrimAPI_MakeCylinder_3(axisAt(-depth), radius, 2 * depth).Shape();

  if (holeType === 'counterbore') {
    if (!(cboreDiameter > diameter)) throw new Error('Counterbore diameter must be larger than the hole diameter');
    if (!(cboreDepth > 0) || cboreDepth >= depth) throw new Error('Counterbore depth must be greater than zero and less than the part thickness');
    const cboreRadius = cboreDiameter / 2;
    const extension = Math.max(0.5, cboreRadius * 0.1);
    const cbore = new occt.BRepPrimAPI_MakeCylinder_3(axisAt(-cboreDepth), cboreRadius, cboreDepth + extension).Shape();
    return cutOrFuseNewSolid(occt, cbore, false, through);
  }

  if (holeType === 'countersink') {
    if (!(csinkDiameter > diameter)) throw new Error('Countersink diameter must be larger than the hole diameter');
    if (!(csinkAngleDeg > 0) || csinkAngleDeg >= 180) throw new Error('Countersink angle must be between 0° and 180°');
    const csinkRadius = csinkDiameter / 2;
    const tanHalf = Math.tan((csinkAngleDeg * Math.PI) / 360);
    const sinkDepth = (csinkRadius - radius) / tanHalf;
    if (sinkDepth >= depth) throw new Error('Countersink is deeper than the part is thick — use a smaller diameter or a wider angle');
    const extension = Math.max(0.5, csinkRadius * 0.1);
    const cone = new occt.BRepPrimAPI_MakeCone_3(axisAt(-sinkDepth), radius, csinkRadius + extension * tanHalf, sinkDepth + extension).Shape();
    return cutOrFuseNewSolid(occt, cone, false, through);
  }

  return through;
}

function handleFeatureHole(req: Extract<StepWorkerRequest, { type: 'feature.hole' }>): void {
  const session = sessions.get(req.sessionId);
  const sketch = session?.sketches.get(req.sketchId);
  if (!session || !sketch) {
    post({ type: 'feature.result', sessionId: req.sessionId, featureId: req.featureId, bodies: [], success: false, error: 'Sketch not found' });
    return;
  }

  try {
    const occt = session.occt;
    const holeTool = buildHoleToolSolid(occt, sketch, req.params);
    const resultShape = cutOrFuseNewSolid(occt, holeTool, true, resolveDocBodyRef(occt, session, req.targetBody));

    session.features.push({
      featureId: req.featureId,
      kind: 'hole',
      sketchId: req.sketchId,
      params: req.params,
      targetRef: req.targetBody,
      producesBodyId: req.producesBodyId,
      resultShape
    });

    const bodies = tessellateShapeBodies(occt, resultShape);
    for (const b of bodies) b.producesBodyId = req.producesBodyId;
    post({ type: 'feature.result', sessionId: req.sessionId, featureId: req.featureId, bodies, success: true }, bodies.flatMap(bodyTransferList));
  } catch (err) {
    post({
      type: 'feature.result',
      sessionId: req.sessionId,
      featureId: req.featureId,
      bodies: [],
      success: false,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

/**
 * Builds ONLY the raw revolved tool solid from a committed sketch + axis/angle params, with the
 * same conditional mirror-across-axis-plane a cut needs (see the docstring above this function's
 * original inline home, moved here unchanged) — no cut/fuse against any target, no tessellation,
 * no session/feature-record bookkeeping. Factored out in Slice 2, mirroring exactly how
 * `buildExtrudeToolSolid` was factored out in Slice 1, for the same reason: both the create path
 * and the replay path (`handleFeatureEdit`) need to build this identical solid from scratch and
 * must not drift into two copies.
 *
 * Geom_Plane itself only exposes Axis()/Location() (its normal axis + origin) — the in-plane U/V
 * directions live one level down, on the underlying gp_Pln (geomPlane.Pln()), confirmed via a
 * runtime prototype-chain probe (no `.d.ts` for this WASM build, same situation every other new
 * OCCT call in this worker has needed — see architecture.md's Revolve dated entry).
 */
function buildRevolveToolSolid(occt: OcctModule, sketch: { planeRef: PlaneRef; entities: SketchEntity[] }, axis: 'u' | 'v', angleDeg: number, isCutIntoExisting: boolean): OcctModule {
  const { face, geomPlane } = buildFaceFromSketch(occt, sketch.planeRef, sketch.entities);

  const pln = geomPlane.Pln();
  const axisDirection = (axis === 'u' ? pln.XAxis() : pln.YAxis()).Direction();
  const axisOrigin = geomPlane.Location();
  const revolveAxis = new occt.gp_Ax1_2(axisOrigin, axisDirection);

  const angleRad = (angleDeg * Math.PI) / 180;
  const revol = new occt.BRepPrimAPI_MakeRevol_1(face, revolveAxis, angleRad, false);
  if (!revol.IsDone()) {
    throw new Error('Revolve failed — the profile/axis combination is not geometrically valid (the profile may cross the axis, which is not allowed)');
  }
  let newSolid = revol.Shape();

  // Cutting/boss-ing into an existing part needs the tool solid on the INSIDE of the picked
  // face, but a profile drawn on that face (client-side, via getFacePlane) sits on its
  // OUTWARD side by construction (same convention Extrude/Sweep's own docstrings describe) —
  // revolving it in place therefore produces a tool solid that stays almost entirely OUTSIDE
  // the target body, regardless of angle or which way the axis points (confirmed via a real
  // Playwright run: a tool solid ~4x the target's own volume still produced a bit-identical,
  // zero-change "successful" cut — the classic "IsDone lies" pattern this app has hit before).
  // Fix: mirror the revolved solid across the plane that CONTAINS the revolve axis and has the
  // picked face's own normal as its normal — that plane is fixed in space by construction
  // (contains the very axis the profile was revolved around), so mirroring across it flips the
  // solid from the face's outward side to its inward side without moving the axis at all.
  if (isCutIntoExisting) {
    // gp_Ax2's 2-arg overload (origin, main direction) is all a mirror plane needs — mirroring
    // across a plane only depends on the plane itself (origin + normal), not any particular
    // in-plane X reference, so the arbitrary X direction OCCT picks internally for the 2-arg
    // form doesn't matter here (unlike the 3-arg form used elsewhere in this worker for
    // circle construction, which does need a specific X direction).
    const faceNormalDir = geomPlane.Axis().Direction();
    const mirrorAx2 = new occt.gp_Ax2_3(axisOrigin, faceNormalDir);
    const mirrorTrsf = new occt.gp_Trsf_1();
    mirrorTrsf.SetMirror_3(mirrorAx2);
    newSolid = new occt.BRepBuilderAPI_Transform_2(newSolid, mirrorTrsf, false).Shape();
  }

  return newSolid;
}

/**
 * `feature.revolve`'s `targetBody` is a `DocBodyRef` (widened in Slice 2, mirroring
 * `feature.extrude`'s own Slice-1 widening) — resolved via `resolveDocBodyRef` directly, same
 * reasoning as `handleFeatureExtrude`'s own docstring above. Sweep/Loft still only accept the
 * plain `FeatureCutTarget` shape and keep using `cutOrFuseAgainstTarget`, unmigrated.
 */
function handleFeatureRevolve(req: Extract<StepWorkerRequest, { type: 'feature.revolve' }>): void {
  const session = sessions.get(req.sessionId);
  const sketch = session?.sketches.get(req.sketchId);
  if (!session || !sketch) {
    post({ type: 'feature.result', sessionId: req.sessionId, featureId: req.featureId, bodies: [], success: false, error: 'Sketch not found' });
    return;
  }

  try {
    const occt = session.occt;
    const isCutIntoExisting = !!req.cut && !!req.targetBody;
    const newSolid = buildRevolveToolSolid(occt, sketch, req.axis, req.angleDeg, isCutIntoExisting);

    // Same target-resolution shape as handleFeatureExtrude's own (Slice 1/2) — see its comments.
    let cutFuseTarget: OcctModule | null = null;
    let targetIsExternal = false;
    if (req.targetBody) {
      cutFuseTarget = resolveDocBodyRef(occt, session, req.targetBody);
      targetIsExternal = true;
    } else if (!req.producesBodyId) {
      cutFuseTarget = session.shape;
    }

    const resultShape = cutOrFuseNewSolid(occt, newSolid, !!req.cut, cutFuseTarget);

    if (!targetIsExternal && !req.producesBodyId) {
      session.shape = resultShape;
    }

    // Feature-tree bookkeeping (Slice 2): only when the caller opted in by passing
    // `producesBodyId` — see handleFeatureExtrude's identical Slice-1 comment.
    if (req.producesBodyId) {
      session.features.push({
        featureId: req.featureId,
        kind: 'revolve',
        sketchId: req.sketchId,
        params: { axis: req.axis, angleDeg: req.angleDeg, cut: !!req.cut },
        targetRef: req.targetBody ?? null,
        producesBodyId: req.producesBodyId,
        resultShape
      });
    }

    const bodies = tessellateShapeBodies(occt, resultShape);
    if (req.producesBodyId) {
      for (const b of bodies) b.producesBodyId = req.producesBodyId;
    }
    const transfer: Transferable[] = bodies.flatMap(bodyTransferList);
    post({ type: 'feature.result', sessionId: req.sessionId, featureId: req.featureId, bodies, success: true }, transfer);
  } catch (err) {
    post({
      type: 'feature.result',
      sessionId: req.sessionId,
      featureId: req.featureId,
      bodies: [],
      success: false,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

/**
 * Sweeps the committed sketch's profile a straight distance along a direction TILTED away from
 * the sketch plane's own normal (toward its own u or v in-plane axis, by `tiltDeg`) — at
 * tiltDeg=0 this is identical to `handleFeatureExtrude`'s own prism call; at higher angles it's
 * a genuinely oblique/angled prism, not reachable through Extrude at all. This corrected shape
 * replaced a first attempt that swept purely along the plane's own u/v axis with NO normal
 * component at all — a real geometry bug, not just a scoping choice: u/v lie IN the profile's
 * own plane, so a prism swept along either alone is degenerate (`BRepPrimAPI_MakePrism`
 * technically succeeds, but the result has zero volume, since there's no out-of-plane extent to
 * sweep through). Confirmed via a Playwright run against the real dev server: Faces=6 (correct
 * topology for a swept rectangle) but Volume=0.00mm³ — a wrong-but-plausible-looking result that
 * would have shipped unnoticed without checking the real number, not just "no error thrown" (the
 * same verification discipline every OCCT integration in this app follows). See the 2026-09-11
 * Sweep dated entry in architecture.md for the full bug/fix story. Reuses `buildFaceFromSketch`
 * and `BRepPrimAPI_MakePrism_1` unchanged from Extrude/Revolve — no new OCCT primitive needed.
 * v1 stays straight-line-only (no curved path).
 */
/**
 * Builds ONLY the raw swept tool solid from a committed sketch + axis/tilt/distance params — no
 * cut/fuse against any target, no tessellation, no session/feature-record bookkeeping. Factored
 * out in Slice 3, mirroring exactly how `buildExtrudeToolSolid`/`buildRevolveToolSolid` were
 * factored out in Slices 1/2, for the same reason: both the create path and the replay path
 * (`handleFeatureEdit`) need to build this identical solid from scratch and must not drift into
 * two copies.
 *
 * Same Geom_Plane -> gp_Pln -> XAxis()/YAxis() route `buildRevolveToolSolid`'s own axis picker
 * uses — Geom_Plane itself only exposes Axis()/Location() (its normal + origin), the in-plane U/V
 * directions live one level down on the underlying gp_Pln.
 */
function buildSweepToolSolid(occt: OcctModule, sketch: { planeRef: PlaneRef; entities: SketchEntity[] }, axis: 'u' | 'v', tiltDeg: number, distance: number, isCutIntoExisting: boolean): OcctModule {
  const { face, geomPlane } = buildFaceFromSketch(occt, sketch.planeRef, sketch.entities);

  const pln = geomPlane.Pln();
  const normalDir = pln.Axis().Direction();
  const tiltAxisDir = (axis === 'u' ? pln.XAxis() : pln.YAxis()).Direction();

  // Rotate the plane's own normal vector toward the chosen in-plane tilt axis by tiltDeg —
  // rotation axis is the THIRD orthogonal direction (normal × tiltAxis), so the rotation
  // tips the normal purely toward tiltAxisDir without introducing any out-of-plane skew.
  const tiltRotationAxisDir = new occt.gp_Dir_4(
    normalDir.Y() * tiltAxisDir.Z() - normalDir.Z() * tiltAxisDir.Y(),
    normalDir.Z() * tiltAxisDir.X() - normalDir.X() * tiltAxisDir.Z(),
    normalDir.X() * tiltAxisDir.Y() - normalDir.Y() * tiltAxisDir.X()
  );
  const tiltRad = (tiltDeg * Math.PI) / 180;
  const rotation = new occt.gp_Trsf_1();
  rotation.SetRotation_1(new occt.gp_Ax1_2(geomPlane.Location(), tiltRotationAxisDir), tiltRad);
  const sweepDirVec = new occt.gp_Vec_4(normalDir.X(), normalDir.Y(), normalDir.Z()).Transformed(rotation);

  // getFacePlane (client-side) derives a picked face's normal pointing OUTWARD (away from
  // material) — correct for a boss/fuse, but wrong for a cut: a tool solid swept only outward
  // from the sketch plane barely touches the part at the sketch plane and never actually
  // overlaps its interior, so BRepAlgoAPI_Cut technically succeeds (IsDone()==true) but removes
  // nothing. Same latent bug handleFeatureExtrude's own targetBody branch already hit and fixed
  // (see its own comment) — when cutting into an existing body, sweep the tool solid
  // SYMMETRICALLY both ways from the sketch plane and fuse the two halves together first, so it
  // reliably punches through the material regardless of which way the face normal points.
  const outwardPath = new occt.gp_Vec_4(sweepDirVec.X() * distance, sweepDirVec.Y() * distance, sweepDirVec.Z() * distance);
  if (isCutIntoExisting) {
    const inwardPath = new occt.gp_Vec_4(-sweepDirVec.X() * distance, -sweepDirVec.Y() * distance, -sweepDirVec.Z() * distance);
    const outwardPrism = new occt.BRepPrimAPI_MakePrism_1(face, outwardPath, false, true).Shape();
    const inwardPrism = new occt.BRepPrimAPI_MakePrism_1(face, inwardPath, false, true).Shape();
    const fuser = new occt.BRepAlgoAPI_Fuse_1();
    const argsList = new occt.TopTools_ListOfShape_1();
    argsList.Append_1(outwardPrism);
    const toolsList = new occt.TopTools_ListOfShape_1();
    toolsList.Append_1(inwardPrism);
    fuser.SetArguments(argsList);
    fuser.SetTools(toolsList);
    fuser.Build();
    if (!fuser.IsDone()) {
      throw new Error('Failed to build symmetric cut tool');
    }
    return fuser.Shape();
  }
  return new occt.BRepPrimAPI_MakePrism_1(face, outwardPath, false, true).Shape();
}

/**
 * `feature.sweep`'s `targetBody` is a `DocBodyRef` (widened in Slice 3, mirroring
 * `feature.extrude`/`feature.revolve`'s own widenings) — resolved via `resolveDocBodyRef`
 * directly, same reasoning as `handleFeatureExtrude`/`handleFeatureRevolve`'s own docstrings.
 * Loft still only accepts the plain `FeatureCutTarget` shape and keeps using
 * `cutOrFuseAgainstTarget`, unmigrated.
 */
function handleFeatureSweep(req: Extract<StepWorkerRequest, { type: 'feature.sweep' }>): void {
  const session = sessions.get(req.sessionId);
  const sketch = session?.sketches.get(req.sketchId);
  if (!session || !sketch) {
    post({ type: 'feature.result', sessionId: req.sessionId, featureId: req.featureId, bodies: [], success: false, error: 'Sketch not found' });
    return;
  }

  try {
    const occt = session.occt;
    const isCutIntoExisting = !!req.cut && !!req.targetBody;
    const newSolid = buildSweepToolSolid(occt, sketch, req.axis, req.tiltDeg, req.distance, isCutIntoExisting);

    // Same target-resolution shape as handleFeatureExtrude/handleFeatureRevolve's own — see their comments.
    let cutFuseTarget: OcctModule | null = null;
    let targetIsExternal = false;
    if (req.targetBody) {
      cutFuseTarget = resolveDocBodyRef(occt, session, req.targetBody);
      targetIsExternal = true;
    } else if (!req.producesBodyId) {
      cutFuseTarget = session.shape;
    }

    const resultShape = cutOrFuseNewSolid(occt, newSolid, !!req.cut, cutFuseTarget);

    if (!targetIsExternal && !req.producesBodyId) {
      session.shape = resultShape;
    }

    // Feature-tree bookkeeping (Slice 3): only when the caller opted in by passing
    // `producesBodyId` — see handleFeatureExtrude's identical Slice-1 comment.
    if (req.producesBodyId) {
      session.features.push({
        featureId: req.featureId,
        kind: 'sweep',
        sketchId: req.sketchId,
        params: { axis: req.axis, tiltDeg: req.tiltDeg, distance: req.distance, cut: !!req.cut },
        targetRef: req.targetBody ?? null,
        producesBodyId: req.producesBodyId,
        resultShape
      });
    }

    const bodies = tessellateShapeBodies(occt, resultShape);
    if (req.producesBodyId) {
      for (const b of bodies) b.producesBodyId = req.producesBodyId;
    }
    const transfer: Transferable[] = bodies.flatMap(bodyTransferList);
    post({ type: 'feature.result', sessionId: req.sessionId, featureId: req.featureId, bodies, success: true }, transfer);
  } catch (err) {
    post({
      type: 'feature.result',
      sessionId: req.sessionId,
      featureId: req.featureId,
      bodies: [],
      success: false,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

/**
 * Blends between 2+ already-committed sketch profiles into one solid via
 * `BRepOffsetAPI_ThruSections` — each `sketchIds[i]` names a profile committed earlier via
 * `handleSketchCommit` exactly the way Extrude/Revolve/Sweep's own single sketch is; Loft is the
 * only feature that references more than one at once. Uses `buildWireFromSketch` (the bare-wire
 * half of what Extrude/Revolve/Sweep's `buildFaceFromSketch` also uses) since `ThruSections`
 * wants one wire per cross-section, not a filled face — the solid comes from blending BETWEEN
 * cross-sections, not from any single one of them.
 *
 * `AddWire` + `Build` + `Shape()` mirrors the `Add`/`Build`/`IsDone`/`Shape` shape this app's
 * fillet/chamfer/shell/draft feature handlers have all already needed for their own maker
 * classes, discovered the same way every new OCCT class in this worker has been: prototype-chain
 * probing at runtime, since no `.d.ts` exists for this WASM build. `isSolid=true` in the
 * constructor asks `ThruSections` to cap the result (cover the first/last cross-sections rather
 * than leaving them open) so a Loft between two closed profiles yields a genuine solid rather
 * than an open shell.
 */
/**
 * Builds ONLY the raw lofted tool solid from 2+ ALREADY-RESOLVED committed sketches (not sketch
 * ids — the caller looks those up, since the create path and the replay path resolve them from
 * different sources: `handleFeatureLoft` from `req.sketchIds` against `session.sketches` directly,
 * `handleFeatureEdit`'s replay loop from `record.sketchIds` the same way but with its own
 * missing-sketch error checked up front for the whole list at once) — no cut/fuse against any
 * target, no tessellation, no session/feature-record bookkeeping. Factored out in Slice 4,
 * mirroring exactly how `buildExtrudeToolSolid`/`buildRevolveToolSolid`/`buildSweepToolSolid` were
 * factored out in Slices 1-3, for the same reason: both the create path and the replay path need
 * to build this identical solid from scratch and must not drift into two copies. `isCutIntoExisting`
 * doesn't need Extrude/Revolve/Sweep's symmetric-both-directions trick (a lofted solid is already
 * fully enclosed between its capped end profiles regardless of cut/fuse intent) but DOES need its
 * own fix for a different degeneracy: when a profile is sketched directly on the surface of the
 * body it'll be cut/fused against (the natural face-anchored workflow), that profile's end cap
 * lands exactly coplanar with the target's own boundary face. Confirmed via a standalone kernel
 * probe (two on-surface profiles on adjacent faces of a box): `BRepAlgoAPI_Cut` treats this as a
 * degenerate touching case and removes nothing at all (0.0 volume change, IsDone() true) rather
 * than erroring, and Fuse adds far less than it should — both silently wrong, not a thrown error,
 * so nothing upstream catches it. Nudging every wire a hair off its plane along the plane's own
 * normal (LOFT_CUT_FUSE_EXTENSION) breaks the exact coincidence; the probe confirmed this is
 * self-consistent (Cut's removed volume + Fuse's added volume ≈ the loft's own total volume) and
 * that 0.01mm is dimensionally negligible for real parts while comfortably clearing float noise.
 */
function buildLoftToolSolid(occt: OcctModule, sketches: { planeRef: PlaneRef; entities: SketchEntity[] }[], isCutIntoExisting: boolean): OcctModule {
  const LOFT_CUT_FUSE_EXTENSION = 0.01;
  const wires: OcctModule[] = sketches.map((sketch) => {
    const { wire, geomPlane } = buildWireFromSketch(occt, sketch.planeRef, sketch.entities);
    if (!isCutIntoExisting) return wire;
    const dir = geomPlane.Axis().Direction();
    const trsf = new occt.gp_Trsf_1();
    trsf.SetTranslation_1(new occt.gp_Vec_4(dir.X() * LOFT_CUT_FUSE_EXTENSION, dir.Y() * LOFT_CUT_FUSE_EXTENSION, dir.Z() * LOFT_CUT_FUSE_EXTENSION));
    const transformed = new occt.BRepBuilderAPI_Transform_2(wire, trsf, true).Shape();
    return occt.TopoDS.Wire_1(transformed);
  });

  // Unlike every other new OCCT class in this worker so far, this WASM build exposes
  // BRepOffsetAPI_ThruSections as a single un-suffixed constructor (no _1/_2 overload
  // variants) taking exactly 3 args: (isSolid, isRuled, precision) — confirmed via the same
  // runtime probing technique (catching BindingErrors, which state the expected arg count)
  // this app's every prior new-OCCT-class integration has used. isSolid=true caps the result
  // (covers the first/last cross-sections) so a Loft between two closed profiles yields a
  // genuine solid rather than an open shell; isRuled=false lets ThruSections build a smoothly
  // interpolated (not just straight-line-per-segment) blend between cross-sections.
  const loft = new occt.BRepOffsetAPI_ThruSections(true, false, 1.0e-6);
  for (const wire of wires) {
    loft.AddWire(wire);
  }
  loft.Build();
  if (!loft.IsDone()) {
    throw new Error('Loft failed — the profile sequence is not geometrically valid (try reordering the profiles, or check none of them self-intersect)');
  }
  return loft.Shape();
}

/**
 * `feature.loft`'s `targetBody` is a `DocBodyRef` (widened in Slice 4, mirroring
 * `feature.sweep`'s own Slice-3 widening) — resolved via `resolveDocBodyRef` directly, same
 * reasoning as `handleFeatureExtrude`/`handleFeatureRevolve`/`handleFeatureSweep`'s own
 * docstrings. `req.targetBody`, when present, is always resolved client-side from the FIRST
 * profile's picked face only (Loft's own multi-profile ambiguity — see `feature.loft`'s own
 * docstring in step-worker-messages.model.ts).
 */
function handleFeatureLoft(req: Extract<StepWorkerRequest, { type: 'feature.loft' }>): void {
  const session = sessions.get(req.sessionId);
  if (!session) {
    post({ type: 'feature.result', sessionId: req.sessionId, featureId: req.featureId, bodies: [], success: false, error: 'No active session' });
    return;
  }
  if (req.sketchIds.length < 2) {
    post({ type: 'feature.result', sessionId: req.sessionId, featureId: req.featureId, bodies: [], success: false, error: 'Loft needs at least 2 profiles' });
    return;
  }

  try {
    const occt = session.occt;
    const sketches = req.sketchIds.map((sketchId) => {
      const sketch = session.sketches.get(sketchId);
      if (!sketch) {
        throw new Error(`Loft profile ${sketchId} not found — it may have been drawn in a different session`);
      }
      return sketch;
    });

    // True whenever the loft's result will actually be booleaned against an existing target
    // below (an explicit `targetBody`, or the legacy implicit-target fallback to `session.shape`
    // when the loft isn't producing its own standalone body) — covers Fuse-into-existing too, not
    // just Cut, since both suffer the same on-surface-profile coincidence degeneracy documented on
    // buildLoftToolSolid above. A standalone loft (`producesBodyId` set, no `targetBody`) is left
    // untouched since there's no boolean op to guarantee overlap for.
    const willBooleanAgainstTarget = !!req.targetBody || !req.producesBodyId;
    const newSolid = buildLoftToolSolid(occt, sketches, willBooleanAgainstTarget);

    // Same target-resolution shape as handleFeatureExtrude/Revolve/Sweep's own — see their comments.
    let cutFuseTarget: OcctModule | null = null;
    let targetIsExternal = false;
    if (req.targetBody) {
      cutFuseTarget = resolveDocBodyRef(occt, session, req.targetBody);
      targetIsExternal = true;
    } else if (!req.producesBodyId) {
      cutFuseTarget = session.shape;
    }

    const resultShape = cutOrFuseNewSolid(occt, newSolid, !!req.cut, cutFuseTarget);

    if (!targetIsExternal && !req.producesBodyId) {
      session.shape = resultShape;
    }

    // Feature-tree bookkeeping (Slice 4): only when the caller opted in by passing
    // `producesBodyId` — see handleFeatureExtrude's identical Slice-1 comment.
    if (req.producesBodyId) {
      session.features.push({
        featureId: req.featureId,
        kind: 'loft',
        sketchIds: req.sketchIds,
        params: { cut: !!req.cut },
        targetRef: req.targetBody ?? null,
        producesBodyId: req.producesBodyId,
        resultShape
      });
    }

    const bodies = tessellateShapeBodies(occt, resultShape);
    if (req.producesBodyId) {
      for (const b of bodies) b.producesBodyId = req.producesBodyId;
    }
    const transfer: Transferable[] = bodies.flatMap(bodyTransferList);
    post({ type: 'feature.result', sessionId: req.sessionId, featureId: req.featureId, bodies, success: true }, transfer);
  } catch (err) {
    post({
      type: 'feature.result',
      sessionId: req.sessionId,
      featureId: req.featureId,
      bodies: [],
      success: false,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

/**
 * Builds ONLY the filleted/chamfered result shape from an already-resolved target solid + edge
 * picks — no target resolution, no tessellation, no session/feature-record bookkeeping. Factored
 * out of the original inline `handleFilletChamfer` body (Slice 5, parametric feature tree) so
 * `handleFeatureFilletChamfer` (creation) and `handleFeatureEdit`'s replay loop (edit) can share it
 * byte-for-byte, the same reason `buildExtrudeToolSolid`/`buildRevolveToolSolid`/
 * `buildSweepToolSolid` were each factored out in their own slices. Unlike those, there is no
 * separate cut/fuse step afterward — `BRepFilletAPI_MakeFillet`/`MakeChamfer` directly modifies
 * the target solid and its own `.Shape()` IS the final result.
 */
function buildFilletChamferToolSolid(occt: OcctModule, targetSolid: OcctModule, kind: FilletChamferKind, edges: FilletChamferEdgeValue[]): OcctModule {
  // Re-walk edges in the exact same TopExp_Explorer_2 order extractEdges used to assign the
  // indices the client picked from, so edges[].edgeIndex map back to the correct real edges.
  const edgeExplorer = new occt.TopExp_Explorer_2(targetSolid, occt.TopAbs_ShapeEnum.TopAbs_EDGE, occt.TopAbs_ShapeEnum.TopAbs_SHAPE);
  const allEdges: OcctModule[] = [];
  while (edgeExplorer.More()) {
    allEdges.push(occt.TopoDS.Edge_1(edgeExplorer.Current()));
    edgeExplorer.Next();
  }
  edgeExplorer.delete();

  // Each picked edge carries its OWN value ("variable-radius fillet": a 3-edge fillet can mix
  // 5mm/8mm/3mm in one operation instead of every edge sharing one value) —
  // BRepFilletAPI_MakeFillet/MakeChamfer's own Add() already takes a value per call, so per-edge
  // values needed no new OCCT primitive, just calling Add() with each edge's own value.
  const targetEdges = edges.map((e) => ({ edge: allEdges[e.edgeIndex], value: e.value })).filter((e) => e.edge != null);
  if (targetEdges.length === 0) {
    throw new Error('None of the selected edges were found on the target solid');
  }

  if (kind === 'fillet') {
    const maker = new occt.BRepFilletAPI_MakeFillet(targetSolid, occt.ChFi3d_FilletShape.ChFi3d_Rational);
    for (const { edge, value } of targetEdges) {
      maker.Add_2(value, edge);
    }
    maker.Build();
    if (!maker.IsDone()) {
      throw new Error('Fillet failed — the selected edge(s)/radius combination is not geometrically valid (try smaller radii or fewer edges)');
    }
    return maker.Shape();
  }

  const maker = new occt.BRepFilletAPI_MakeChamfer(targetSolid);
  for (const { edge, value } of targetEdges) {
    maker.Add_2(value, edge);
  }
  maker.Build();
  if (!maker.IsDone()) {
    throw new Error('Chamfer failed — the selected edge(s)/distance combination is not geometrically valid (try smaller distances or fewer edges)');
  }
  return maker.Shape();
}

/**
 * Handles `filletChamfer.build` — the self-contained request a FRESH, throwaway Worker (spawned
 * by `runFilletChamferViaMainThread` below) processes entirely on its own: read STEP bytes → build
 * the fillet/chamfer → write the result back out to STEP bytes (so the calling worker can recover
 * a real, chainable shape handle in ITS OWN module — see `FilletChamferBuildRequest`'s docstring)
 * → tessellate → reply. Uses its own freshly-initialized OCCT module instance every time, never a
 * cached/reused one — the whole point of running this in a throwaway Worker at all.
 */
async function handleFilletChamferBuild(req: Extract<StepWorkerRequest, { type: 'filletChamfer.build' }>): Promise<void> {
  try {
    const occt = await initOcct();
    const { shape: sourceShape, lastStatus } = readStepShape(occt, req.targetBytes);
    if (!sourceShape) {
      throw new Error(`Failed to re-read target body's STEP source (IFSelect_ReturnStatus=${lastStatus})`);
    }
    const solids = explodeSolids(occt, sourceShape);
    const targetSolid = solids[req.solidIndex];
    if (!targetSolid) {
      throw new Error(`Target body's solid index ${req.solidIndex} not found in its re-read STEP source`);
    }

    const resultShape = buildFilletChamferToolSolid(occt, targetSolid, req.kind, req.edges);
    const resultBytes = writeShapeToStepBytes(occt, resultShape);

    const body = tessellateSolid(occt, resultShape, req.solidIndex);
    if (!body) {
      post({ type: 'filletChamfer.build.result', requestId: req.requestId, body: null, resultBytes: null, resultSolidIndex: 0, success: false, error: `${req.kind} produced no triangulation` });
      return;
    }
    post(
      { type: 'filletChamfer.build.result', requestId: req.requestId, body, resultBytes, resultSolidIndex: req.solidIndex, success: true },
      [...bodyTransferList(body), resultBytes.buffer]
    );
  } catch (err) {
    post({ type: 'filletChamfer.build.result', requestId: req.requestId, body: null, resultBytes: null, resultSolidIndex: 0, success: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Pending `filletChamfer.needsBuild` round-trips awaiting their `filletChamfer.needsBuild.result` reply from the main thread — see `runFilletChamferViaMainThread`'s own docstring. */
const pendingFilletChamferBuilds = new Map<string, { resolve: (r: { body: WorkerTessellatedBody; resultBytes: Uint8Array }) => void; reject: (err: Error) => void }>();

/**
 * Asks the MAIN THREAD to spawn a fresh, throwaway Worker to do the actual
 * `BRepFilletAPI_MakeFillet`/`MakeChamfer` build, via a `filletChamfer.needsBuild` message out and
 * awaiting the matching `filletChamfer.needsBuild.result` reply in (handled by the worker's own
 * top-level message listener — see the `pendingFilletChamferBuilds.get(...)` branch there).
 *
 * This exists because of a confirmed WASM-build limitation, not a design preference: constructing
 * `BRepFilletAPI_MakeFillet`/`MakeChamfer` a SECOND time within the same Worker's lifetime throws
 * an uncatchable raw WASM error (`___cxa_is_pointer_type is not defined`) on `.Build()` — reliably
 * reproduced during Slice 5's own implementation, isolated to that exact call via step-by-step
 * logging, and confirmed NOT fixed by a fresh `initOcct()` module instance in the SAME Worker
 * (also tried and still failed identically) — only a genuinely fresh Worker avoids it. **The fresh
 * Worker cannot be spawned from HERE** (i.e. from inside this session worker) either — a nested
 * `new Worker(...)` call from inside a Worker's own module scope was tried and failed outright in
 * this dev environment (fires `onerror` immediately with no diagnostic detail; the nested worker
 * never received its first message) — so the spawn has to happen on the main thread, which is
 * proven to work (every one-shot tool, and the pre-Slice-5 Fillet/Chamfer, already does exactly
 * this successfully). `ModelingSessionService` (main thread) is what actually calls
 * `new Worker(...)` in response to this worker's own `filletChamfer.needsBuild` message.
 *
 * Returns the tessellated body PLUS the result's own re-exportable STEP bytes (`resultBytes`) so
 * the caller can re-read those into its own session's `occt` module and get a real, chainable
 * `resultShape` — necessary because an OCCT shape handle from the throwaway worker's module could
 * never be used by the session's own module anyway (handles are tied to their originating module
 * instance), so this bridge is required regardless, not merely a workaround for the WASM bug.
 */
function runFilletChamferViaMainThread(kind: FilletChamferKind, targetBytes: Uint8Array, solidIndex: number, edges: FilletChamferEdgeValue[]): Promise<{ body: WorkerTessellatedBody; resultBytes: Uint8Array }> {
  return new Promise((resolve, reject) => {
    const buildRequestId = `fillet-build-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    pendingFilletChamferBuilds.set(buildRequestId, { resolve, reject });
    post({ type: 'filletChamfer.needsBuild', buildRequestId, kind, targetBytes, solidIndex, edges }, [targetBytes.buffer]);
  });
}

/**
 * Resolves a `DocBodyRef` down to real STEP bytes + solid index — what `runFilletChamferViaMainThread`
 * needs to hand across the Worker boundary. `kind: 'imported'` already has bytes, but returns a
 * COPY (`.slice()`), never `ref.bytes` itself: the caller transfers the returned buffer's ownership
 * away via `postMessage(..., [bytes.buffer])` (detaching it), and `ref` here is frequently the same
 * `SessionFeatureRecord.targetRef` object that must stay valid for every future replay of this
 * feature — handing out the original would silently detach it the FIRST time this is called,
 * leaving every subsequent edit's `postMessage` throw "ArrayBuffer ... is already detached" (a real
 * bug hit and fixed during Slice 5's own implementation, confirmed via Playwright: create succeeded
 * once, but the very next edit failed with exactly that error). `kind: 'feature'` writes the
 * referenced feature's own live `resultShape` out to STEP bytes first (via `writeShapeToStepBytes`,
 * using THIS session's own `occt`, which still owns that shape) — already a fresh buffer every
 * call, so no copy needed there.
 */
function resolveDocBodyRefToStepBytes(occt: OcctModule, session: Session, ref: DocBodyRef): { bytes: Uint8Array; solidIndex: number } {
  if (ref.kind === 'imported') {
    return { bytes: ref.bytes.slice(), solidIndex: ref.solidIndex };
  }
  const targetRecord = findFeatureRecord(session, ref.featureId);
  if (!targetRecord.resultShape) {
    throw new Error(`Feature ${ref.featureId} has no built shape to target (it may have failed its last build)`);
  }
  // solidIndex 0: writeShapeToStepBytes/the fresh worker's own readStepShape+explodeSolids always
  // finds this single shape at index 0 when it's the ONLY thing written to that STEP file (unlike
  // an original multi-solid import, this is a single already-isolated feature result).
  return { bytes: writeShapeToStepBytes(occt, targetRecord.resultShape), solidIndex: 0 };
}

/**
 * Session-aware and feature-tree-aware since Slice 5 (parametric feature tree) — replaces the
 * earlier session-less, one-shot `handleFilletChamfer`. `FilletChamferToolService` is this
 * request's only caller in the whole app, so there was no unmigrated legacy traffic to keep
 * working, unlike Extrude/Revolve/Sweep/Loft's own migrations. Modeled on `handleFeatureExtrude`
 * in shape (resolve target, build, push a `SessionFeatureRecord`, reply as `feature.result`), but
 * the actual build runs in a FRESH throwaway Worker via `runFilletChamferViaMainThread` — see that
 * function's own docstring for the confirmed WASM-build limitation this works around — then the
 * result's STEP bytes are re-read back into THIS session's own `occt` module so `resultShape`
 * stays a real, chainable handle for any future feature that targets this one's own output.
 */
async function handleFeatureFilletChamfer(req: Extract<StepWorkerRequest, { type: 'feature.filletChamfer' }>): Promise<void> {
  const session = sessions.get(req.sessionId);
  if (!session) {
    post({ type: 'feature.result', sessionId: req.sessionId, featureId: req.featureId, bodies: [], success: false, error: 'No active session' });
    return;
  }

  try {
    const occt = session.occt;
    const { bytes: targetBytes, solidIndex } = resolveDocBodyRefToStepBytes(occt, session, req.targetBody);
    const { body, resultBytes } = await runFilletChamferViaMainThread(req.kind, targetBytes, solidIndex, req.edges);

    // Re-read the fresh worker's result bytes into THIS session's own module so resultShape is a
    // real, usable handle for any later feature that targets THIS one's own output — an OCCT
    // handle from the throwaway worker's module could never be used here directly regardless (see
    // runFilletChamferViaMainThread's own docstring).
    const { shape: reimportedShape, lastStatus } = readStepShape(occt, resultBytes);
    if (!reimportedShape) {
      throw new Error(`Failed to re-import fillet/chamfer result back into the session (IFSelect_ReturnStatus=${lastStatus})`);
    }
    const reimportedSolids = explodeSolids(occt, reimportedShape);
    const resultShape = reimportedSolids[0] ?? reimportedShape;

    session.features.push({
      featureId: req.featureId,
      kind: 'filletChamfer',
      params: { filletChamferKind: req.kind, edges: req.edges },
      targetRef: req.targetBody,
      producesBodyId: req.producesBodyId,
      resultShape
    });

    body.producesBodyId = req.producesBodyId;
    post({ type: 'feature.result', sessionId: req.sessionId, featureId: req.featureId, bodies: [body], success: true }, bodyTransferList(body));
  } catch (err) {
    post({
      type: 'feature.result',
      sessionId: req.sessionId,
      featureId: req.featureId,
      bodies: [],
      success: false,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

let shellOcct: OcctModule | null = null;

/**
 * Shell (hollow-out) always targets an existing body's own solid, re-read from its original STEP
 * source — identical shape to `handleFilletChamfer` above, just walking faces instead of edges
 * (the picked faces are the ones to OPEN/remove — `BRepOffsetAPI_MakeThickSolid`'s own
 * "closing faces" convention, matching every mainstream CAD tool's Shell UI). No new
 * picking primitive was needed client-side: `faceIndices` are positions in the same
 * `TopExp_Explorer_2` TopAbs_FACE walk `readTriangulation` already uses to assign
 * `faceIdMap`, which `SelectionService.pickFace` already resolves a client click into (Sketch's
 * face-pick phase has used this exact index space since the 2026-08-06 face-sketch pass).
 */
async function handleShell(req: Extract<StepWorkerRequest, { type: 'feature.shell' }>): Promise<void> {
  try {
    shellOcct ??= await initOcct();
    const occt = shellOcct;

    const { shape: sourceShape, lastStatus } = readStepShape(occt, req.targetBody.bytes);
    if (!sourceShape) {
      throw new Error(`Failed to re-read target body's STEP source (IFSelect_ReturnStatus=${lastStatus})`);
    }
    const solids = explodeSolids(occt, sourceShape);
    const targetSolid = solids[req.targetBody.solidIndex];
    if (!targetSolid) {
      throw new Error(`Target body's solid index ${req.targetBody.solidIndex} not found in its re-read STEP source`);
    }

    // Re-walk faces in the exact same TopExp_Explorer_2 order faceIdMap was assigned in, so
    // req.faceIndices map back to the correct real faces.
    const faceExplorer = new occt.TopExp_Explorer_2(targetSolid, occt.TopAbs_ShapeEnum.TopAbs_FACE, occt.TopAbs_ShapeEnum.TopAbs_SHAPE);
    const allFaces: OcctModule[] = [];
    while (faceExplorer.More()) {
      allFaces.push(occt.TopoDS.Face_1(faceExplorer.Current()));
      faceExplorer.Next();
    }
    faceExplorer.delete();

    const closingFaces = req.faceIndices.map((i) => allFaces[i]).filter((f) => f != null);
    if (closingFaces.length === 0) {
      throw new Error('None of the selected faces were found on the target solid');
    }

    const faceList = new occt.TopTools_ListOfShape_1();
    for (const face of closingFaces) {
      faceList.Append_1(face);
    }

    // Thickness is always applied as a negative offset — BRepOffsetAPI_MakeThickSolid hollows
    // INWARD (removes material) for a negative offset and grows the solid outward for a
    // positive one; a "wall thickness" input is always the inward case, so the sign is fixed
    // here rather than exposed as a user-facing +/- choice that could silently do the wrong
    // thing (matches Hole Wizard's own "always cut, never asked as a sign" precedent).
    //
    // **Getting this one worker call right took three separate runtime-verified fixes** — no
    // `.d.ts` exists for this WASM build (same "guessed suffixes must be runtime-verified"
    // situation the 2026-07-31 primitive-creation pass first ran into), and each wrong guess
    // below produced a "successful" `IsDone()===true` result with silently wrong geometry rather
    // than throwing, so each one needed volume/face-count sanity-checking against a real
    // Playwright run to catch — see the 2026-09-10 Shell dated entry in architecture.md for the
    // full before/after numbers at each step:
    //   1. Constructor: the parameterless `BRepOffsetAPI_MakeThickSolid` throws "no accessible
    //      constructor" — `_1` is the correct no-arg overload (this class's other overload,
    //      `_2`, takes a solid+faces+offset directly; not used here since `MakeThickSolidByJoin`
    //      offers more configuration).
    //   2. Argument ORDER: `MakeThickSolidByJoin` (no `_N` suffix on the method itself, unlike
    //      the constructors) needs exactly 9 positional args, matching OCCT's real C++ order —
    //      (shape, closingFaces, offset, tolerance, mode, intersection, selfInter, joinType,
    //      removeIntEdges). The first attempt guessed this order from memory and put
    //      `BRepOffset_Mode` into the slot real OCCT uses for `Intersection` (a boolean) — it
    //      still ran with no exception, but produced a self-intersecting box shelled to
    //      -88,193,692 mm³ (negative AND absurdly large) instead of a small positive number.
    //   3. Join type: even with the order fixed, `GeomAbs_Arc` (meant for curved/organic joins)
    //      on a sharp-cornered box still produced a plausible-looking but still-too-large result
    //      (positive 88,193,692 mm³ after the orientation fix below — an 18x-too-large box).
    //      `GeomAbs_Intersection` (OCCT's documented recommendation for sharp/polyhedral corners)
    //      combined with a looser tolerance (0.1mm, not 1e-3mm — this WASM build's STEP-import
    //      geometry doesn't resolve reliably at micron tolerance) brought the result to
    //      7,380,530.84 mm³ for a 3mm shell on a body with 1,993,994.41 mm² of surface area — a
    //      1.23x ratio against the surfaceArea*thickness thin-shell estimate, a physically sane
    //      result (this body is proportioned such that a full-surface 3mm shell's volume
    //      legitimately EXCEEDS the original solid's own volume — a "shelled volume must be
    //      smaller than the original" sanity check, tried first, was itself the wrong test for
    //      this shape and had to be replaced with the surface-area-based estimate instead).
    // Only the first 4 args are exposed as real tool inputs (target/faces/offset/tolerance); the
    // rest use OCCT's own recommended-for-CAD-solids defaults, not user-facing options nothing in
    // the UI needs yet.
    const maker = new occt.BRepOffsetAPI_MakeThickSolid_1();
    maker.MakeThickSolidByJoin(
      targetSolid,
      faceList,
      -Math.abs(req.thickness),
      0.1,
      occt.BRepOffset_Mode.BRepOffset_Skin,
      false,
      false,
      occt.GeomAbs_JoinType.GeomAbs_Intersection,
      false
    );
    maker.Build();
    if (!maker.IsDone()) {
      throw new Error('Shell failed — the selected face(s)/thickness combination is not geometrically valid (try a smaller thickness or fewer removed faces)');
    }
    let resultShape = maker.Shape();

    // BRepOffsetAPI_MakeThickSolid's output solid can come back with globally-reversed face
    // orientation (a documented OCCT quirk of MakeThickSolidByJoin) — kept as a defensive check
    // even after the join-type/tolerance fix above resolved this app's own worst case (see the
    // 2026-09-10 Shell dated entry in architecture.md for the negative-volume evidence that first
    // surfaced it). BRepGProp reports a negative mass exactly when face orientations are inverted
    // relative to the solid's own outward-normal convention — complementing the shape flips every
    // face orientation back the right way without changing the geometry itself.
    const volCheck = new occt.GProp_GProps_1();
    occt.BRepGProp.VolumeProperties_1(resultShape, volCheck, false, false, false);
    const rawVolume = volCheck.Mass();
    volCheck.delete();
    if (rawVolume < 0) {
      resultShape = resultShape.Complemented();
    }

    const body = tessellateSolid(occt, resultShape, req.targetBody.solidIndex);
    if (!body) {
      post({ type: 'shell.result', requestId: req.requestId, body: null, success: false, error: 'Shell produced no triangulation' });
      return;
    }
    post({ type: 'shell.result', requestId: req.requestId, body, success: true }, bodyTransferList(body));
  } catch (err) {
    post({ type: 'shell.result', requestId: req.requestId, body: null, success: false, error: err instanceof Error ? err.message : String(err) });
  }
}

let draftOcct: OcctModule | null = null;

/**
 * Draft (mold-pull angle) always targets an existing body's own solid, re-read from its original
 * STEP source — identical shape to `handleShell`/`handleFilletChamfer`. v1 fixes the pull
 * direction to world +Z and the neutral plane to world XY (see `DraftRequest`'s own docstring for
 * why) — every picked face gets the SAME direction/plane in one `BRepOffsetAPI_DraftAngle`
 * operation, matching how Fillet/Chamfer applies one radius/distance to every picked edge in one
 * operation.
 */
async function handleDraft(req: Extract<StepWorkerRequest, { type: 'feature.draft' }>): Promise<void> {
  try {
    draftOcct ??= await initOcct();
    const occt = draftOcct;

    const { shape: sourceShape, lastStatus } = readStepShape(occt, req.targetBody.bytes);
    if (!sourceShape) {
      throw new Error(`Failed to re-read target body's STEP source (IFSelect_ReturnStatus=${lastStatus})`);
    }
    const solids = explodeSolids(occt, sourceShape);
    const targetSolid = solids[req.targetBody.solidIndex];
    if (!targetSolid) {
      throw new Error(`Target body's solid index ${req.targetBody.solidIndex} not found in its re-read STEP source`);
    }

    // Re-walk faces in the exact same TopExp_Explorer_2 order faceIdMap was assigned in, so
    // req.faceIndices map back to the correct real faces — same technique handleShell uses.
    const faceExplorer = new occt.TopExp_Explorer_2(targetSolid, occt.TopAbs_ShapeEnum.TopAbs_FACE, occt.TopAbs_ShapeEnum.TopAbs_SHAPE);
    const allFaces: OcctModule[] = [];
    while (faceExplorer.More()) {
      allFaces.push(occt.TopoDS.Face_1(faceExplorer.Current()));
      faceExplorer.Next();
    }
    faceExplorer.delete();

    const draftFaces = req.faceIndices.map((i) => allFaces[i]).filter((f) => f != null);
    if (draftFaces.length === 0) {
      throw new Error('None of the selected faces were found on the target solid');
    }

    // Fixed pull direction (world +Z) — see DraftRequest's own docstring for the v1 scoping
    // decision. The neutral plane (where the solid keeps its exact cross-section while faces
    // rotate away from it) is set at the solid's own minimum-Z bounding extreme, normal aligned
    // to the pull direction. This is the one configuration that actually works: a fixed world
    // Z=0 plane and a plane through the solid's volumetric centroid were both tried first and
    // both failed — Z=0 fails BRepOffsetAPI_DraftAngle's IsDone() outright for bodies not
    // straddling the origin, and the centroid plane reports a clean IsDone()==true/Status()==0
    // "success" but is a bit-identical no-op, because it floats in space without actually
    // coinciding with any real face/edge of the solid. Confirmed via a ground-truth test on a
    // fresh, simple 100x100x100 box: a neutral plane at the box's own base face (Z=0, a REAL
    // face of that box) produced a correct, cleanly-scaled draft on the first try. The solid's
    // own minimum-Z bounding extreme is guaranteed to coincide with real boundary geometry
    // (every STEP-imported solid has some face/vertex touching its own bbox extremes) without
    // needing to know which face that is — see the 2026-09-11 Draft dated entry in
    // architecture.md for the full trial-and-error record.
    const pullDirection = new occt.gp_Dir_4(0, 0, 1);
    const angleRad = (req.angleDeg * Math.PI) / 180;

    const vertexExplorer = new occt.TopExp_Explorer_2(targetSolid, occt.TopAbs_ShapeEnum.TopAbs_VERTEX, occt.TopAbs_ShapeEnum.TopAbs_SHAPE);
    let minZ = Infinity;
    while (vertexExplorer.More()) {
      const vertex = occt.TopoDS.Vertex_1(vertexExplorer.Current());
      const pnt = occt.BRep_Tool.Pnt(vertex);
      if (pnt.Z() < minZ) minZ = pnt.Z();
      vertexExplorer.Next();
    }
    vertexExplorer.delete();

    const neutralPlane = new occt.gp_Pln_2(new occt.gp_Ax3_4(new occt.gp_Pnt_3(0, 0, minZ), new occt.gp_Dir_4(0, 0, 1)));

    const drafter = new occt.BRepOffsetAPI_DraftAngle_2(targetSolid);
    for (const face of draftFaces) {
      drafter.Add(face, pullDirection, angleRad, neutralPlane, true);
    }
    drafter.Build();
    if (!drafter.IsDone()) {
      throw new Error('Draft failed — the selected face(s)/angle combination is not geometrically valid (try a smaller angle or fewer faces)');
    }
    let resultShape = drafter.Shape();

    // BRepOffsetAPI_DraftAngle can hand back a solid whose overall orientation is inverted
    // (a real, correctly-shaped result but reporting a negative volume) — same inversion Shell's
    // MakeThickSolidByJoin hits; same fix, .Complemented() flips face orientation back the right
    // way without touching the geometry itself.
    const volCheck = new occt.GProp_GProps_1();
    occt.BRepGProp.VolumeProperties_1(resultShape, volCheck, false, false, false);
    const rawVolume = volCheck.Mass();
    volCheck.delete();
    if (rawVolume < 0) {
      resultShape = resultShape.Complemented();
    }

    const body = tessellateSolid(occt, resultShape, req.targetBody.solidIndex);
    if (!body) {
      post({ type: 'draft.result', requestId: req.requestId, body: null, success: false, error: 'Draft produced no triangulation' });
      return;
    }
    post({ type: 'draft.result', requestId: req.requestId, body, success: true }, bodyTransferList(body));
  } catch (err) {
    post({ type: 'draft.result', requestId: req.requestId, body: null, success: false, error: err instanceof Error ? err.message : String(err) });
  }
}

let exportOcct: OcctModule | null = null;

/**
 * Builds one combined STEP file from N source files' worth of bodies: re-reads each UNIQUE source
 * exactly once (the request is already grouped source-major by the caller — see
 * `StepExportSource`'s docstring for why body-major would re-parse a shared multi-solid source
 * once per body, which was slow enough in practice to look hung on a real 17-body assembly),
 * pulls out just the requested solid indices from each read, and fuses them all into one
 * TopoDS_Compound via BRep_Builder (a compound is a lightweight grouping shape — it does not
 * merge/boolean the solids together, each stays a separate solid inside the compound, which is
 * exactly what "export the whole assembly as one file" should do). Writes that compound out with
 * STEPControl_Writer in ManifoldSolidBrep mode (the standard mode for solid-body STEP export, as
 * opposed to GeometricCurveSet or FacetedBrep). Uses a dedicated lazily-initialized module
 * instance, same one-shot-call reasoning as `filletOcct`/`primitiveOcct` — no shape needs to
 * persist across export calls.
 */
async function handleExportStep(req: Extract<StepWorkerRequest, { type: 'model.exportStep' }>): Promise<void> {
  try {
    exportOcct ??= await initOcct();
    const occt = exportOcct;

    const builder = new occt.BRep_Builder();
    const compound = new occt.TopoDS_Compound();
    builder.MakeCompound(compound);

    let addedCount = 0;
    for (const source of req.sources) {
      const { shape: sourceShape, lastStatus } = readStepShape(occt, source.bytes);
      if (!sourceShape) {
        const labels = source.solids.map((s) => s.nodeLabel).join(', ');
        throw new Error(`Failed to re-read STEP source for ${labels} (IFSelect_ReturnStatus=${lastStatus})`);
      }
      const solids = explodeSolids(occt, sourceShape);
      for (const { solidIndex, nodeLabel } of source.solids) {
        const solid = solids[solidIndex];
        if (!solid) {
          throw new Error(`"${nodeLabel}"'s solid index ${solidIndex} not found in its re-read STEP source`);
        }
        builder.Add(compound, solid);
        addedCount++;
      }
    }
    if (addedCount === 0) {
      throw new Error('No bodies with a STEP source were available to export');
    }

    const writer = new occt.STEPControl_Writer_1();
    const transferStatus = writer.Transfer(compound, occt.STEPControl_StepModelType.STEPControl_ManifoldSolidBrep, true);
    if (transferStatus.value !== occt.IFSelect_ReturnStatus.IFSelect_RetDone.value) {
      throw new Error(`STEP transfer failed (IFSelect_ReturnStatus=${transferStatus.value})`);
    }

    // Same short-virtual-path constraint readStepShape's docstring documents for reads — applies
    // to writes on this build too, so reuse the module-global counter rather than a fixed name.
    const virtualPath = `/${virtualPathCounter++}.stp`;
    const writeStatus = writer.Write(virtualPath);
    if (writeStatus.value !== occt.IFSelect_ReturnStatus.IFSelect_RetDone.value) {
      throw new Error(`STEP write failed (IFSelect_ReturnStatus=${writeStatus.value})`);
    }

    const bytes: Uint8Array = occt.FS.readFile(virtualPath);
    post({ type: 'exportStep.result', requestId: req.requestId, bytes, success: true }, [bytes.buffer]);
  } catch (err) {
    post({ type: 'exportStep.result', requestId: req.requestId, bytes: null, success: false, error: err instanceof Error ? err.message : String(err) });
  }
}

self.addEventListener('message', (event: MessageEvent<StepWorkerRequest>) => {
  const req = event.data;
  switch (req.type) {
    case 'load':
      void handleLoad(req);
      break;
    case 'session.start':
      void handleSessionStart(req);
      break;
    case 'session.dispose':
      handleSessionDispose(req);
      break;
    case 'sketch.commit':
      handleSketchCommit(req);
      break;
    case 'feature.hole':
      handleFeatureHole(req);
      break;
    case 'feature.extrude':
      handleFeatureExtrude(req);
      break;
    case 'feature.edit':
      void handleFeatureEdit(req);
      break;
    case 'feature.revolve':
      handleFeatureRevolve(req);
      break;
    case 'feature.sweep':
      handleFeatureSweep(req);
      break;
    case 'feature.loft':
      handleFeatureLoft(req);
      break;
    case 'primitive.create':
      void handlePrimitiveCreate(req);
      break;
    case 'feature.filletChamfer':
      void handleFeatureFilletChamfer(req);
      break;
    case 'filletChamfer.build':
      void handleFilletChamferBuild(req);
      break;
    case 'filletChamfer.needsBuild.result': {
      // Reply to this worker's OWN earlier `filletChamfer.needsBuild` message — resolves the
      // matching pending promise from `runFilletChamferViaMainThread`; see that function's own
      // docstring for the full round-trip this closes.
      const pending = pendingFilletChamferBuilds.get(req.buildRequestId);
      if (pending) {
        pendingFilletChamferBuilds.delete(req.buildRequestId);
        if (req.success && req.body && req.resultBytes) {
          pending.resolve({ body: req.body, resultBytes: req.resultBytes });
        } else {
          pending.reject(new Error(req.error ?? 'Fillet/Chamfer build failed'));
        }
      }
      break;
    }
    case 'feature.shell':
      void handleShell(req);
      break;
    case 'feature.draft':
      void handleDraft(req);
      break;
    case 'model.exportStep':
      void handleExportStep(req);
      break;
  }
});

let virtualPathCounter = 0;

/**
 * Reads STEP bytes into an OCCT shape using the given (already-initialized) module. Factored
 * out of handleLoad so the cut-target path below (re-reading a body's original STEP source to
 * get a real solid to cut against) can reuse the exact same retry/virtual-path handling instead
 * of duplicating it — both the CRLF quirk and the retry dance are properties of this specific
 * compiled WASM build, not of any one call site.
 *
 * CRLF line endings are the primary cause of read failures in this build (see
 * stripCarriageReturns). Separately, once a given virtual FS path has been read by
 * STEPControl_Reader and failed, re-reading the SAME path on a later attempt keeps failing even
 * after fixing the content or constructing a brand-new reader — something in this build's STEP
 * schema/protocol state appears to key off the path itself. Each attempt therefore writes to a
 * fresh, never-before-used virtual path, and the counter is module-global (not reset per call)
 * so concurrent/sequential calls from different flows (initial load vs. a later cut-target read)
 * never collide on the same path either.
 *
 * IMPORTANT: this build's STEPControl_Reader.ReadFile() silently fails (IFSelect_RetError) for
 * any virtual path longer than 10 characters total (confirmed empirically: "/aaaa.step" at 10
 * chars succeeds, "/aaaaa.step" at 11 chars fails, independent of content) — a fixed buffer
 * limit inside this specific compiled wasm binary, unrelated to the real filename or STEP
 * content. Virtual paths must therefore stay short.
 */
/**
 * Writes a single shape out to STEP bytes in-memory (same `occt.FS` virtual-path write/read
 * round-trip `handleExportStep` already uses for a whole compound) — the counterpart to
 * `readStepShape`, factored out for Slice 5's fillet/chamfer cross-Worker bridge (see
 * `runFilletChamferViaMainThread`'s own docstring for why this is needed): a target that's a
 * PRIOR FEATURE's own live `resultShape` (`DocBodyRef.kind: 'feature'`) has no STEP bytes of its
 * own to hand across a Worker boundary, but writing it to STEP text first gives it some.
 */
function writeShapeToStepBytes(occt: OcctModule, shape: OcctModule): Uint8Array {
  const writer = new occt.STEPControl_Writer_1();
  const transferStatus = writer.Transfer(shape, occt.STEPControl_StepModelType.STEPControl_ManifoldSolidBrep, true);
  if (transferStatus.value !== occt.IFSelect_ReturnStatus.IFSelect_RetDone.value) {
    throw new Error(`STEP transfer failed (IFSelect_ReturnStatus=${transferStatus.value})`);
  }
  const virtualPath = `/${virtualPathCounter++}.stp`;
  const writeStatus = writer.Write(virtualPath);
  if (writeStatus.value !== occt.IFSelect_ReturnStatus.IFSelect_RetDone.value) {
    throw new Error(`STEP write failed (IFSelect_ReturnStatus=${writeStatus.value})`);
  }
  return occt.FS.readFile(virtualPath);
}

/**
 * `skipReaderDelete` (default false, preserving the original always-clean-up behavior) exists
 * because of one specific, confirmed failure mode: `reader.delete()`'s own embind-generated C++
 * destructor recursively tears down the `STEPControl_Reader`'s entire owned entity graph (every
 * parsed STEP record, released one nested Handle at a time), and for a large enough graph, that
 * recursion overflows a browser Worker's native stack — confirmed via a captured browser stack
 * trace against a real, unusually large STEP file (112MB, deeply cross-referenced): a
 * `RangeError: Maximum call stack size exceeded` thrown from inside the WASM binary itself, not
 * this file's own JS, immediately after `OneShape()` had already returned successfully. The exact
 * same call succeeds instantly in a Node.js process, which gets a larger native stack for the
 * identical WASM binary.
 *
 * This is only safe to skip where the caller's own Worker is about to be discarded wholesale
 * anyway — `handleLoad` passes `true` because `StepLoaderService.loadStepFile`/
 * `loadStepFileFromBlob` create a fresh, single-use Worker per call and unconditionally
 * `.terminate()` it afterwards (every exit path: success, error, `worker.onerror`), so the entire
 * Worker heap — WASM linear memory included — is torn down by the browser moments later
 * regardless; an undeleted reader there is memory that was about to be freed in bulk anyway, not a
 * real leak. Every OTHER caller of this function runs inside the long-lived per-session Worker
 * (`ModelingSessionService`'s, alive for the whole editing session, potentially hundreds of
 * operations) resolving much smaller re-exported STEP bytes for a single already-isolated body —
 * those keep the default `false` and always clean up, since skipping there would accumulate a
 * real leak across a long session rather than trading one for a moment. A user who imports a file
 * this large and then performs a feature-tree operation that re-resolves its original STEP bytes
 * inside that session Worker could in principle hit this same overflow there too — not addressed
 * here; this fix covers the import path specifically, which is where the failure was reported.
 */
function readStepShape(occt: OcctModule, rawBuffer: Uint8Array, skipReaderDelete = false): { shape: OcctModule | null; lastStatus: number } {
  const buffer = stripCarriageReturns(rawBuffer);
  let shape: OcctModule | null = null;
  let lastStatus = -1;

  for (let attempt = 0; attempt < 3 && !shape; attempt++) {
    const virtualPath = `/${virtualPathCounter++}.stp`;
    occt.FS.writeFile(virtualPath, buffer);

    const reader = new occt.STEPControl_Reader_1();
    const status = reader.ReadFile(virtualPath);
    lastStatus = status.value;

    if (status.value !== occt.IFSelect_ReturnStatus.IFSelect_RetDone.value) {
      if (!skipReaderDelete) reader.delete();
      continue;
    }

    reader.TransferRoots();
    shape = reader.OneShape();
    if (!skipReaderDelete) reader.delete();
  }

  return { shape, lastStatus };
}

async function handleLoad(req: Extract<StepWorkerRequest, { type: 'load' }>): Promise<void> {
  try {
    post({ type: 'progress', phase: 'downloading-wasm', message: 'Downloading OpenCascade WASM module…', indeterminate: true });

    post({ type: 'progress', phase: 'reading-step', message: 'Reading STEP file…', indeterminate: true });
    const response = await fetch(req.url);
    const rawBuffer = new Uint8Array(await response.arrayBuffer());

    const occt: OcctModule = await initOcct();
    // skipReaderDelete=true — see readStepShape's own docstring: this Worker is single-use and
    // gets terminated right after this call resolves either way, so skipping the STEP reader's own
    // cleanup here trades a moment-early leak (freed in bulk anyway) for avoiding a confirmed
    // native-stack overflow in its destructor on unusually large, deeply cross-referenced files.
    const { shape, lastStatus } = readStepShape(occt, rawBuffer, true);

    if (!shape) {
      post({ type: 'error', message: `Failed to read STEP file (IFSelect_ReturnStatus=${lastStatus})` });
      return;
    }

    const solids = explodeSolids(occt, shape);

    post({
      type: 'progress',
      phase: 'tessellating',
      message: 'Tessellating bodies…',
      indeterminate: false,
      bodyIndex: 0,
      bodyCount: solids.length
    });

    let emitted = 0;
    for (let i = 0; i < solids.length; i++) {
      post({
        type: 'progress',
        phase: 'tessellating',
        message: `Tessellating body ${i + 1} of ${solids.length}…`,
        indeterminate: false,
        bodyIndex: i + 1,
        bodyCount: solids.length
      });

      const body = tessellateSolid(occt, solids[i], i);
      if (body) {
        post({ type: 'body', body }, bodyTransferList(body));
        emitted++;
      }
    }

    // shape.delete() intentionally skipped too, same reasoning as skipReaderDelete above.
    post({ type: 'done', bodyCount: emitted });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
}
