/**
 * One polyline per OCCT edge (index = its position in a TopExp_Explorer_2 TopAbs_EDGE walk,
 * the same deterministic-per-unchanged-shape traversal order `faceIdMap`/`explodeSolids`
 * already rely on elsewhere in this worker). Sampled at a fixed point count via
 * `BRepAdaptor_Curve` rather than read back from the render triangulation's own edge topology
 * (which OCCT's mesher doesn't expose per-edge) — good enough for click-picking and highlight
 * rendering, not intended as exact CAD-grade curve geometry.
 */
export interface WorkerEdge {
  index: number;
  /** Flattened [x0,y0,z0, x1,y1,z1, ...] world-space polyline points. */
  points: Float32Array;
}

export interface WorkerTessellatedBody {
  solidIndex: number;
  positions: Float32Array;
  indices: Uint32Array;
  /** One OCCT face index per triangle (length === indices.length / 3), for face-level picking. */
  faceIdMap: Uint32Array;
  /**
   * A separate, much finer triangulation of the same solid (tighter OCCT mesher deflection —
   * see `MESH_VIEW_LINEAR_DEFLECTION` in the worker), used only to build the "Mesh View"
   * wireframe overlay. Curvature-adaptive like `positions`/`indices`, just denser, so it
   * naturally shows more triangles on curved/filleted regions and fewer on flat faces — no
   * per-triangle face id needed since this geometry is never raycast/picked against.
   */
  meshViewPositions: Float32Array;
  meshViewIndices: Uint32Array;
  /** Per-edge polylines for edge-level picking (Fillet/Chamfer edge selection). */
  edges: WorkerEdge[];
  volume: number | null;
  surfaceArea: number | null;
  faceCount: number;
  edgeCount: number;
  /**
   * Stable body id from the producing `FeatureRecord` (parametric feature tree, Slice 1) — set
   * only for results of `feature.extrude` requests that passed `producesBodyId` and for every
   * body a `feature.edit` replay returns (the edited feature plus every downstream dependent).
   * `undefined` for every other tessellation path (STEP import, primitives, Revolve/Sweep/Loft/
   * Fillet/Shell/Draft), which have no feature-tree entry yet and keep addressing results by
   * array position as before.
   */
  producesBodyId?: string;
}

/**
 * A reference to the plane a sketch is drawn on. Face planes carry their full world-space
 * frame (origin/normal/uAxis) resolved client-side from the picked body's tessellation —
 * see `utils/face-geometry.util.ts` — rather than a session/faceIndex the worker would have
 * to dereference back to a live OCCT face. `uAxis` must be the exact vector the client used
 * to compute sketch point (u,v) coordinates, so the worker's Geom_Plane parameterization
 * matches; otherwise the extruded profile could come out rotated relative to what was drawn.
 */
export type PlaneRef =
  | { kind: 'datum'; plane: 'XY' | 'YZ' | 'XZ'; offset: number }
  | { kind: 'face'; origin: [number, number, number]; normal: [number, number, number]; uAxis: [number, number, number] };

/** A 2D sketch entity, expressed in the sketch plane's local coordinates. */
export type SketchEntity =
  | { type: 'line'; id: string; points: [[number, number], [number, number]] }
  | { type: 'circle'; id: string; center: [number, number]; radius: number }
  | { type: 'polygon'; id: string; center: [number, number]; radius: number; sides: number }
  | { type: 'slot'; id: string; start: [number, number]; end: [number, number]; width: number };

/** A standalone 3D solid primitive, placed directly into the assembly (no sketch/extrude needed). */
export type PrimitiveSpec =
  | { kind: 'box'; origin: [number, number, number]; width: number; depth: number; height: number }
  | { kind: 'cylinder'; origin: [number, number, number]; radius: number; height: number }
  | { kind: 'sphere'; origin: [number, number, number]; radius: number }
  | { kind: 'cone'; origin: [number, number, number]; radius1: number; radius2: number; height: number };

/**
 * Identifies the real solid to cut against when a sketch/extrude targets an existing
 * (imported or previously-extruded) body: the raw STEP source bytes it originally came from,
 * plus which solid within that source it is (`explodeSolids`'s deterministic traversal order
 * for unchanged bytes). Cutting against `session.shape` alone only ever works for shapes the
 * session itself created — imported STEP geometry is never in `session.shape`, which is why
 * this is threaded through separately rather than relying on that field.
 */
export interface FeatureCutTarget {
  bytes: Uint8Array;
  solidIndex: number;
}

/**
 * Identifies a cut/fuse target that may live INSIDE the session's own feature history instead of
 * only ever being a fresh STEP-bytes re-read — the structural change the parametric feature tree
 * needs (see architecture.md's Slice-1 dated entry). `kind: 'imported'` is exactly today's
 * `FeatureCutTarget` (a STEP-imported body with no feature history of its own yet); `kind:
 * 'feature'` points at a prior `FeatureRecord`'s own cached result shape in this session, letting
 * a feature target the OUTPUT of an earlier feature rather than only ever an original STEP solid.
 * Only `feature.extrude`/`feature.revolve`/`feature.edit` build/consume this as of Slice 2 —
 * Sweep/Loft/Fillet/Shell/Draft still only accept the plain `FeatureCutTarget` shape until a
 * follow-up migration pass.
 */
export type DocBodyRef = { kind: 'imported'; bytes: Uint8Array; solidIndex: number } | { kind: 'feature'; featureId: string };

/**
 * One entry in a modeling session's persistent, replayable feature history (added for the
 * parametric feature tree — Slice 1 shipped Extrude only; Slice 2 added Revolve; Slice 3 added
 * Sweep; Slice 4 added Loft). `params` is what an edit changes; `sketchId`/`sketchIds`/`targetRef`
 * are what a replay needs to rebuild this feature's geometry from scratch after an earlier feature
 * in the same session's history changes. `producesBodyId` is a stable id assigned once at creation
 * and never reassigned, so an edit-triggered replay can address the same `CadBody`/tree node
 * deterministically instead of the client having to guess by array position. Kept in
 * `step-worker-messages.model.ts` (not a client-only model) because both the worker (source of
 * truth, holds the live `resultShape` handle — see the worker's own `Session.features`) and the
 * client (a lightweight shadow copy for the Feature Tree panel, sans `resultShape` — see
 * `models/feature-record.model.ts`'s `ClientFeatureRecord`, kept as the identical union minus that
 * one field) need the same field shape. Adding a new feature kind means adding a new union member
 * here, in `ClientFeatureRecord`, and in `feature.edit`'s own params union below — all three are
 * meant to move together.
 *
 * `kind: 'loft'` (Slice 4) deliberately has its OWN `sketchIds: string[]` field rather than reusing
 * `sketchId: string` for a plural value — Loft is the only kind that blends between 2+ committed
 * profiles at once, and a distinct field name makes every read site's assumption explicit and
 * type-checked (code still written against `record.sketchId` for a `kind: 'loft'` record fails to
 * compile, rather than silently reading `undefined`). Loft's `params` is deliberately narrower than
 * the other three kinds too — `{cut: boolean}` only, no numeric field — since v1 editing a Loft
 * after the fact only covers the Cut checkbox, not re-adding/removing/reordering its profiles (see
 * the 2026-09-14 Slice 4 dated entry in architecture.md for the full scoping rationale).
 *
 * `kind: 'filletChamfer'` (Slice 5) is shaped differently from the other four in two ways, both
 * because it isn't a sketch-based feature at all: it has no `sketchId`/`sketchIds` (nothing was
 * drawn — the input is a set of picked edges on an already-existing solid), and its `targetRef` is
 * **non-nullable** (every other kind can be `null` — a standalone new body on a datum plane — but
 * a fillet/chamfer always modifies a real existing solid in place; there is no "standalone" case).
 * `filletChamferKind`/`edges` sit alongside `params` rather than inside it, mirroring how `sketchId`
 * sits alongside `params` for the other kinds — `params` stays "the part an edit changes", and here
 * that's `{filletChamferKind, edges}` together (see `feature.edit`'s own params union below).
 */
export type FeatureRecord =
  | { featureId: string; kind: 'extrude'; sketchId: string; params: { depth: number; cut: boolean }; targetRef: DocBodyRef | null; producesBodyId: string }
  | {
      featureId: string;
      kind: 'revolve';
      sketchId: string;
      params: { axis: 'u' | 'v'; angleDeg: number; cut: boolean };
      targetRef: DocBodyRef | null;
      producesBodyId: string;
    }
  | {
      featureId: string;
      kind: 'sweep';
      sketchId: string;
      params: { axis: 'u' | 'v'; tiltDeg: number; distance: number; cut: boolean };
      targetRef: DocBodyRef | null;
      producesBodyId: string;
    }
  | {
      featureId: string;
      kind: 'loft';
      sketchIds: string[];
      params: { cut: boolean };
      targetRef: DocBodyRef | null;
      producesBodyId: string;
    }
  | {
      featureId: string;
      kind: 'filletChamfer';
      params: { filletChamferKind: FilletChamferKind; edges: FilletChamferEdgeValue[] };
      targetRef: DocBodyRef;
      producesBodyId: string;
    };

/** Fillet rounds an edge with a fixed radius; chamfer bevels it with a fixed setback distance — same edge-selection input, different BRepFilletAPI maker class worker-side. */
export type FilletChamferKind = 'fillet' | 'chamfer';

/**
 * One picked edge plus its own fillet radius / chamfer distance (mm, meaning depends on the
 * request's `kind`) — added 2026-09-13 so a multi-edge fillet/chamfer can give each edge a
 * DIFFERENT value in one operation ("variable-radius fillet": e.g. 5mm/8mm/3mm across 3 picked
 * edges), rather than every edge sharing one value. `edgeIndex` is a position in the same
 * `TopExp_Explorer_2` TopAbs_EDGE walk that produced the `WorkerEdge.index` values the client
 * picked from — unchanged from the single-shared-value v1 this replaced.
 */
export interface FilletChamferEdgeValue {
  edgeIndex: number;
  value: number;
}

/**
 * A Fillet/Chamfer request against an existing body's own solid. `edges`, in pick order, each
 * carry their own radius/distance — added 2026-09-13 (replacing a single shared
 * `edgeIndices[] + value` shape) so different picked edges can have different values in one
 * operation; see `FilletChamferEdgeValue`'s own docstring.
 *
 * `targetBody` widened from the plain STEP-bytes-only `FeatureCutTarget` to `DocBodyRef`, and
 * `sessionId`/`featureId`/`producesBodyId` added, in Slice 5 (parametric feature tree) — mirroring
 * `feature.extrude`'s own Slice-1 widening exactly, so a fillet/chamfer can target either a
 * STEP-imported body OR a prior feature's own output (`kind: 'feature'`), and so it can register
 * itself into `Session.features` and participate in `handleFeatureEdit`'s replay. Unlike
 * Extrude/Revolve/Sweep/Loft, there is no unmigrated legacy caller of this request to keep
 * working — `FilletChamferToolService` was and remains its only caller — so these fields are
 * required, not optional, and the old session-less `filletChamfer.result` response/handler this
 * request used before Slice 5 no longer exists; replies come back as an ordinary `feature.result`,
 * same as every other feature-tree-aware kind.
 */
export interface FilletChamferRequest {
  sessionId: string;
  featureId: string;
  kind: FilletChamferKind;
  targetBody: DocBodyRef;
  edges: FilletChamferEdgeValue[];
  producesBodyId: string;
}

/**
 * A self-contained fillet/chamfer build request, handled by a FRESH, throwaway Worker instance
 * (one per call, never reused) rather than the primary session worker — see
 * `handleFilletChamferBuild`'s own docstring in step-loader.worker.ts for why: this WASM build's
 * `BRepFilletAPI_MakeFillet`/`MakeChamfer` throws an uncatchable raw WASM error
 * (`___cxa_is_pointer_type is not defined`) the SECOND time either is constructed within the same
 * Worker's lifetime, confirmed by direct isolation during Slice 5's own implementation — a fresh
 * `initOcct()` module instance in the SAME Worker does not avoid it (also confirmed), only a
 * genuinely fresh Worker does, matching how the pre-Slice-5 one-shot-worker-per-call design always
 * avoided this bug by construction (every call got a fresh Worker, so `BRepFilletAPI_*` was always
 * "first use" for its own Worker).
 *
 * **The fresh Worker is always spawned from the MAIN THREAD** (`ModelingSessionService`), never
 * from inside another Worker — a nested Worker-in-Worker spawn was tried first and failed outright
 * in this dev environment (`new Worker(...)` called from inside a Worker's own module scope fires
 * `onerror` immediately with no diagnostic detail; the nested worker never received its first
 * message — a Vite dev-server module-worker-resolution limitation, not a code bug). So the primary
 * session worker, when it needs a fillet/chamfer built, sends `filletChamfer.needsBuild` back OUT
 * to the main thread (see that type's own docstring) instead of spawning a Worker itself; the main
 * thread does the actual spawn-fresh-worker-and-relay, exactly the same way every one-shot tool
 * (Shell/Draft/primitives, and the pre-Slice-5 Fillet/Chamfer) already spawns workers successfully
 * — main-thread-spawns-worker is proven; worker-spawns-worker is not, in this setup.
 *
 * `targetBytes` is always real STEP bytes, never a live OCCT shape handle — a handle can't cross a
 * Worker boundary at all (OCCT handles are tied to their originating module instance, documented
 * elsewhere in this file), so the caller resolves whatever the true target is (an imported body's
 * own bytes, or — for a target that's a PRIOR FEATURE's own live `resultShape` — that shape
 * written out to STEP bytes via `writeShapeToStepBytes` first) before sending this request.
 */
export interface FilletChamferBuildRequest {
  requestId: string;
  kind: FilletChamferKind;
  targetBytes: Uint8Array;
  solidIndex: number;
  edges: FilletChamferEdgeValue[];
}

/**
 * A Shell (hollow-out) request against an existing body's own solid — same STEP-source re-read
 * shape as FilletChamferRequest, since Shell also only ever operates on a body that already
 * exists. `faceIndices` are positions in the same `TopExp_Explorer_2` TopAbs_FACE walk that
 * assigns `WorkerTessellatedBody.faceIdMap`'s per-triangle face ids — the same face-index space
 * `SelectionService.pickFace` already resolves a client click into, so no new picking primitive
 * was needed (unlike Fillet/Chamfer's edge-index space, which needed a new `extractEdges`/
 * `pickEdge` primitive built from scratch in the 2026-08-16 pass). The picked faces are REMOVED
 * (opened) by the shell operation — this is `BRepOffsetAPI_MakeThickSolid`'s own convention, the
 * same one every mainstream CAD tool's Shell tool uses ("faces to remove").
 */
export interface ShellRequest {
  requestId: string;
  targetBody: FeatureCutTarget;
  faceIndices: number[];
  /** Wall thickness in mm — always applied as a negative offset internally (hollowing inward), regardless of sign the UI passes; see the worker handler for why. */
  thickness: number;
}

/**
 * A Draft (mold-pull angle) request against an existing body's own solid — same STEP-source
 * re-read shape as ShellRequest/FilletChamferRequest, since Draft also only ever operates on a
 * body that already exists. `faceIndices` are positions in the same `TopExp_Explorer_2`
 * TopAbs_FACE walk `ShellRequest.faceIndices` already uses — the same face-index space
 * `SelectionService.pickFace` resolves a client click into.
 *
 * v1 deliberately fixes the pull direction to world +Z (not user-picked — offered against a full
 * direction picker and not chosen, the same "don't build past what today's UI actually exercises"
 * judgment call Shell's own fixed-offset-sign and Hole Wizard's fixed-cut-sign already made).
 * The NEUTRAL plane (where the solid keeps its size while faces rotate away from it) is derived
 * from the TARGET SOLID's own volumetric center of mass — two other approaches were tried and
 * both failed (see the worker's own `handleDraft` and the 2026-09-11 Draft dated entry in
 * architecture.md for the full before/after evidence): a fixed world-Z=0 plane fails
 * `BRepOffsetAPI_DraftAngle`'s `IsDone()` outright for any body not literally straddling the
 * origin; a per-face neutral plane at the picked face's OWN centroid builds successfully but has
 * no measurable effect (degenerate — the face has nothing to rotate away from at its own
 * location). The solid's own center of mass needs no extra picking UI either, and is guaranteed
 * to lie inside the body rather than on the face being drafted.
 */
export interface DraftRequest {
  requestId: string;
  targetBody: FeatureCutTarget;
  faceIndices: number[];
  /** Draft angle in degrees. */
  angleDeg: number;
}

/**
 * One re-readable STEP source file (an import), plus which solid indices within it to pull out —
 * grouped this way (source-major, not body-major) so a source shared by many bodies (the common
 * case: one multi-solid STEP import explodes into N bodies, all pointing at the SAME source
 * bytes) is only re-read and re-parsed by OCCT ONCE, not once per body. Re-parsing a multi-
 * megabyte STEP file's full `STEPControl_Reader` pipeline is expensive; doing it N times for an
 * N-body import (as an earlier, body-major version of this request shape did) made exporting a
 * 17-body assembly hang for minutes instead of seconds — this grouping is a real perf fix, not
 * just a tidier shape.
 */
export interface StepExportSource {
  bytes: Uint8Array;
  /** Which solids (by their index in this source's own explodeSolids order) to include, each paired with the display label to use in error messages. */
  solids: { solidIndex: number; nodeLabel: string }[];
}

export interface StepExportRequest {
  requestId: string;
  sources: StepExportSource[];
}

export type StepWorkerRequest =
  | { type: 'load'; url: string }
  | { type: 'session.start'; sessionId: string }
  | { type: 'session.dispose'; sessionId: string }
  /**
   * `faceAnchorFeatureId`: set when the sketch is drawn on a face of that feature's output. The worker
   * records which face, so editing the feature moves the sketch with it instead of leaving it behind.
   */
  | { type: 'sketch.commit'; sessionId: string; sketchId: string; planeRef: PlaneRef; entities: SketchEntity[]; faceAnchorFeatureId?: string }
  /**
   * `producesBodyId` (added for the parametric feature tree, Slice 1) is generated client-side up
   * front and threaded through unchanged, so a later `feature.edit` replay can address the exact
   * same body deterministically instead of relying on array position. Optional so every
   * pre-existing call site (Revolve/Sweep/Loft still call plain `extrude()` internally in a few
   * places, and any caller that hasn't been migrated to the feature-tree flow) is unaffected —
   * the worker generates one itself when omitted.
   *
   * `targetBody` accepts a `DocBodyRef` here (widened from the plain `FeatureCutTarget` every
   * other `feature.*` request still uses) so an extrude can target EITHER a STEP-imported body
   * (`kind: 'imported'`, structurally identical to the old `FeatureCutTarget` shape) OR a prior
   * feature's own output (`kind: 'feature'`) — the latter is what makes "cut into a body this
   * session itself built via Extrude" constructible, which is what actually exercises the
   * worker's downstream-dependent replay path (see `handleFeatureEdit`). Fillet/Chamfer/Shell/
   * Draft/Hole-Wizard keep the plain `FeatureCutTarget`-only shape (they aren't sketch-based
   * features at all, so aren't candidates for this widening) — Revolve/Sweep/Loft were widened the
   * same way in Slices 2-4.
   */
  | { type: 'feature.extrude'; sessionId: string; featureId: string; sketchId: string; depth: number; cut: boolean; targetBody?: DocBodyRef; producesBodyId?: string }
  /**
   * Edits a previously-created feature's params in place and replays it plus every feature after
   * it in the session's history (in array order — see the worker's own `Session.features`
   * docstring for why "everything after me" is a correct, if conservative, stand-in for a real
   * dependency graph). `params.kind` is tagged (redundant with the target `FeatureRecord`'s own
   * `kind`, but explicit) so the worker can validate the edit matches the feature's actual kind
   * before touching anything, and the client can build the right params object with no lookup
   * round-trip. `kind: 'extrude'` shipped in Slice 1; `kind: 'revolve'` added in Slice 2;
   * `kind: 'sweep'` added in Slice 3; `kind: 'loft'` added in Slice 4 (deliberately `{cut}` only —
   * see `FeatureRecord`'s own docstring for why Loft's v1 edit surface is narrower than the other
   * three); `kind: 'filletChamfer'` added in Slice 5 (its own `edges: FilletChamferEdgeValue[]`
   * field lets an edit change per-edge radius/distance values, same as the other kinds' numeric
   * params — but, like Loft, the underlying pick SET is fixed at creation; only already-picked
   * edges' own values are editable) — adding a new feature kind to the tree means adding a
   * matching member here too (see `FeatureRecord`'s own docstring for the other two places that
   * move together with this one).
   */
  | {
      type: 'feature.edit';
      sessionId: string;
      featureId: string;
      params:
        | { kind: 'extrude'; depth: number; cut: boolean }
        | { kind: 'revolve'; axis: 'u' | 'v'; angleDeg: number; cut: boolean }
        | { kind: 'sweep'; axis: 'u' | 'v'; tiltDeg: number; distance: number; cut: boolean }
        | { kind: 'loft'; cut: boolean }
        | { kind: 'filletChamfer'; filletChamferKind: FilletChamferKind; edges: FilletChamferEdgeValue[] };
    }
  /**
   * `cut`+`targetBody` (both optional) let Revolve target an existing body's own solid, exactly
   * the way `feature.extrude` already does: `targetBody` names the picked-face body to re-read
   * from STEP source, `cut` chooses boolean Cut (remove) vs Fuse (add/boss) against it. Omitting
   * both (the v1-only shape until 2026-09-13) keeps producing a standalone new body — see the
   * 2026-09-13 dated entry in architecture.md for why this was deferred, then closed, separately
   * from Revolve's own original 2026-09-10 pass.
   *
   * `targetBody` widened to `DocBodyRef` (was the plain STEP-bytes-only `FeatureCutTarget`) and
   * `producesBodyId` added in Slice 2, mirroring `feature.extrude`'s own Slice-1 widening exactly
   * — see `DocBodyRef`'s docstring for why this is what makes "revolve A, then cut/extrude into
   * A's own output" constructible, not just "revolve into a STEP-imported body."
   */
  | { type: 'feature.revolve'; sessionId: string; featureId: string; sketchId: string; axis: 'u' | 'v'; angleDeg: number; cut?: boolean; targetBody?: DocBodyRef; producesBodyId?: string }
  /**
   * Sweeps the committed sketch's profile a straight distance along a direction TILTED away from
   * the sketch plane's own normal, toward the plane's own u or v in-plane axis, by `tiltDeg`
   * (0-89°) — at tiltDeg=0 this is identical to `feature.extrude`; at higher angles it's a
   * genuinely oblique/angled prism plain Extrude can't reach. `axis`+`tiltDeg` deliberately
   * replaced an earlier, WRONG v1 shape (`axis: 'u'|'v'` alone, meaning "sweep straight along
   * u/v with no normal component") that was a real geometry bug, not just a scoping choice: u/v
   * lie IN the profile's own plane, so a prism swept purely along either is degenerate (zero
   * volume) — see the 2026-09-11 Sweep dated entry in architecture.md for the full story. v1
   * stays straight-line-only (no curved path). `cut`+`targetBody` (added 2026-09-13, same shape
   * as Revolve's own above) let Sweep target an existing body too — see that dated entry.
   *
   * `targetBody` widened to `DocBodyRef` and `producesBodyId` added in Slice 3, mirroring
   * `feature.revolve`'s own Slice-2 widening exactly — see `DocBodyRef`'s docstring.
   */
  | { type: 'feature.sweep'; sessionId: string; featureId: string; sketchId: string; axis: 'u' | 'v'; tiltDeg: number; distance: number; cut?: boolean; targetBody?: DocBodyRef; producesBodyId?: string }
  /**
   * Blends between 2+ already-committed sketch profiles (each its own closed wire, on its own
   * plane) into one solid — the standard "loft"/"blend" operation for parts whose cross-section
   * changes shape along its length (a bottle: round base, oval body, narrow neck; a duct
   * transitioning round-to-rectangular). `sketchIds`, in order, name the cross-sections the
   * result passes through, each already committed via a normal `sketch.commit` the same way
   * Extrude/Revolve/Sweep's own single sketch is — Loft is the first feature to reference MORE
   * THAN ONE committed sketch by id in a single request. `cut`+`targetBody` (added 2026-09-13, same
   * shape as Revolve/Sweep's own) target Loft into an existing body — since Loft has multiple
   * profiles (possibly on different bodies' faces), the target is always resolved from the FIRST
   * profile's picked face only, if any; later profiles just shape the blend, they never redirect
   * the cut/fuse target. Omitting both keeps producing a standalone new body; v1 doesn't support
   * closed (start-to-end-connected) lofts or guide curves, only an open blend straight through the
   * given cross-sections in order.
   *
   * `targetBody` widened to `DocBodyRef` and `producesBodyId` added in Slice 4, mirroring
   * `feature.sweep`'s own Slice-3 widening exactly — see `DocBodyRef`'s docstring.
   */
  | { type: 'feature.loft'; sessionId: string; featureId: string; sketchIds: string[]; cut?: boolean; targetBody?: DocBodyRef; producesBodyId?: string }
  | { type: 'primitive.create'; requestId: string; spec: PrimitiveSpec }
  /**
   * Session-aware and feature-tree-aware since Slice 5 (was a session-less, one-shot request
   * before — see `FilletChamferRequest`'s own docstring). Replies come back as an ordinary
   * `feature.result`, keyed by `sessionId`+`featureId` like every other feature-tree-aware kind —
   * there is no separate `filletChamfer.result` response anymore.
   */
  | ({ type: 'feature.filletChamfer' } & FilletChamferRequest)
  /** Handled only by a fresh, throwaway Worker instance, spawned from the MAIN THREAD — see `FilletChamferBuildRequest`'s own docstring for why. Never sent directly by `ModelingSessionService`; only relayed there in response to a `filletChamfer.needsBuild` message from the primary session worker. */
  | ({ type: 'filletChamfer.build' } & FilletChamferBuildRequest)
  /**
   * Sent INTO the primary session worker by `ModelingSessionService` (main thread) — the reply to
   * that worker's own `filletChamfer.needsBuild` message (see that type's docstring in
   * `StepWorkerResponse` below for the full round-trip). Carries back exactly what
   * `filletChamfer.build.result` would have (`body`+`resultBytes`), just relayed through the main
   * thread instead of a direct Worker reply, since the fresh build Worker was spawned there, not by
   * the primary session worker itself.
   */
  | { type: 'filletChamfer.needsBuild.result'; buildRequestId: string; body: WorkerTessellatedBody | null; resultBytes: Uint8Array | null; success: boolean; error?: string }
  | ({ type: 'feature.shell' } & ShellRequest)
  | ({ type: 'feature.draft' } & DraftRequest)
  | ({ type: 'model.exportStep' } & StepExportRequest);

export type StepWorkerResponse =
  | { type: 'progress'; phase: string; message: string; indeterminate: boolean; percent?: number; bodyIndex?: number; bodyCount?: number }
  | { type: 'body'; body: WorkerTessellatedBody }
  | { type: 'done'; bodyCount: number }
  | { type: 'error'; message: string }
  | { type: 'session.ready'; sessionId: string }
  | { type: 'sketch.result'; sessionId: string; sketchId: string; success: boolean; error?: string }
  /**
   * Also the reply to `feature.edit` (not just the original `feature.*` creation requests):
   * `featureId` is the edited feature, and `bodies` carries one `WorkerTessellatedBody` (each
   * tagged with its own `producesBodyId`) per feature that was actually replayed — the edited one
   * plus every feature after it in the session's history, per `Session.features`'s docstring —
   * so the client can update every affected `CadBody` from one response instead of guessing which
   * bodies changed.
   */
  | { type: 'feature.result'; sessionId: string; featureId: string; bodies: WorkerTessellatedBody[]; success: boolean; error?: string; replacesBodyId?: string }
  | { type: 'primitive.result'; requestId: string; body: WorkerTessellatedBody | null; success: boolean; error?: string }
  /**
   * Reply to `filletChamfer.build` — carries the result shape's OWN re-exportable STEP bytes
   * (`resultBytes`, `resultSolidIndex`) alongside its tessellation, so the CALLING worker (which
   * spawned this throwaway one specifically to dodge the `BRepFilletAPI_*` reuse bug — see
   * `FilletChamferBuildRequest`'s docstring) can re-read those bytes into ITS OWN session module
   * to get a real, chainable `resultShape` handle for `Session.features`, the same way any other
   * `DocBodyRef.kind: 'imported'` target is already resolved — not just a tessellation with no
   * shape behind it, which a later feature targeting this one's OWN output would have nothing to
   * resolve against.
   */
  | { type: 'filletChamfer.build.result'; requestId: string; body: WorkerTessellatedBody | null; resultBytes: Uint8Array | null; resultSolidIndex: number; success: boolean; error?: string }
  /**
   * Sent OUT of the primary session worker to the main thread (`ModelingSessionService`) — a
   * request FROM the worker, not a reply, despite living in `StepWorkerResponse` (this worker's
   * only outbound channel). Asks the main thread to spawn a fresh, throwaway Worker to build this
   * fillet/chamfer — see `FilletChamferBuildRequest`'s own docstring for why the session worker
   * can't spawn that Worker itself (nested Worker-in-Worker construction fails outright in this
   * dev environment). `ModelingSessionService` answers with `filletChamfer.needsBuild.result`
   * (same `buildRequestId`) once the fresh worker's own `filletChamfer.build.result` comes back.
   */
  | { type: 'filletChamfer.needsBuild'; buildRequestId: string; kind: FilletChamferKind; targetBytes: Uint8Array; solidIndex: number; edges: FilletChamferEdgeValue[] }
  | { type: 'shell.result'; requestId: string; body: WorkerTessellatedBody | null; success: boolean; error?: string }
  | { type: 'draft.result'; requestId: string; body: WorkerTessellatedBody | null; success: boolean; error?: string }
  | { type: 'exportStep.result'; requestId: string; bytes: Uint8Array | null; success: boolean; error?: string };
