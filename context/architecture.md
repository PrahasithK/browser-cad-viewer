# Project Context: Browser CAD Viewer

## What this is

An Angular 20 single-page app (no routing — one shell, `app.routes.ts` is empty) that
renders and edits CAD models in the browser:

- Starts with an empty scene (no auto-loaded model) — the user opens a STEP file via
  File → "Open STEP…" (real OS file picker), which is parsed via OpenCascade.js (WASM)
  running in a Web Worker, tessellated, and rendered with Three.js. Opening a file replaces
  whatever's currently loaded (single-document convention — see the 2026-08-13 dated entry
  below); `public/assets/*.STEP` are just sample files on disk for the user to pick, not a
  bundled default. `TreeService.registerImport` itself is still append-by-design (kept that
  way for a future explicit multi-body-assembly "Import" action) — the replace behavior is
  enforced by the caller (`Viewport.onStepFileSelected`), which clears the scene/tree first.
- Full CRUD on assembly parts: Create (STEP import, above, plus direct 3D primitives and
  sketch+extrude — see below), Read (model tree + properties panel), Update (rename,
  visibility, color, opacity), Delete (tree row / context menu, with confirmation).
- Supports selection (with automatic in-viewport Length/Width/Height labels on the selected
  part), measurement (Distance tool, also labeled directly in the 3D view), section (clipping)
  planes, exploded view, sketching + extrusion — on a global datum plane (XY/YZ/XZ) or directly
  on a picked face of an existing part, with auto camera-orient, face highlight, and edge/vertex
  snap references (rectangle/circle/polygon/slot profiles; boss/fuse or cut, the latter correctly
  removing material from the targeted part rather than merely adding a disconnected shape),
  direct 3D primitive placement (box/cylinder/sphere/cone via click-to-place + dimension panel),
  structural (FEA) modeling and linear-elastic analysis, and bridge-mesh generation between two
  picked faces.
- Undo/redo for property-style edits (rename, visibility, color, opacity, section plane
  offset/enable/flip) via a command-stack `HistoryService`, Ctrl+Z/Ctrl+Y, toolbar buttons,
  and Edit-menu entries. Deliberately does NOT cover deletes or geometry-creating operations
  (STEP import, sketch extrude, primitive creation) — those dispose GPU resources or mutate
  the OCCT worker's shape state in ways that have no snapshot to restore to; undoing them
  needs a different design (deferred disposal / worker-side shape history), not yet built.
- Stack: Angular 20 (standalone components, signals), Three.js, OpenCascade.js (WASM,
  in-worker), no backend — everything runs client-side.

## High-level structure

```
src/app/
  app.ts / app.html          — root shell, wires 3 top-level components together
  components/
    app-chrome/    — menu bar, ribbon toolbar, view toolbar, status bar
    side-panels/   — left model tree + right properties panel (widths drag-resizable)
    viewport/      — 3D canvas, nav cube, loading dialog, right-click context menu
    tool-panels/   — floating/dockable panels for whichever tool is active (measure/
                     section/sketch/structural/structural-results/bridge-mesh/primitive)
  services/        — 39 singleton (providedIn: 'root') services as of 2026-09-21 (was 24 when this line was written), one per domain concern
  models/          — plain TS interfaces/types, no logic
  directives/      — panel-drag-handle.directive.ts (the only directive so far — see
                     "dockable panels" below)
  utils/           — small pure functions (id generation, geometry math, linear solve,
                     structural solver math, mesh subdivision, etc.)
  workers/         — step-loader.worker.ts: runs OCCT parsing + modeling-session ops
```

## Important: this codebase already went through a "reduce file count" pass

The component layer was deliberately consolidated once already, and it's documented
inline in code comments — do not re-propose merging these further without a concrete
reason tied to actual behavior:

- `app-chrome.ts`: *"Merges what were 4 separate components... this is a straight merge"*
  (menu bar + ribbon + view toolbar + status bar).
- `viewport.ts`: *"used to be 3 separate components"* (nav cube, STEP-load progress
  dialog, right-click context menu folded in alongside the canvas).
- `tool-panels.ts`: *"Merged from 6 separate components"* (measure, section, sketch,
  structural, structural-results, bridge-mesh floating panels).

So there are only 4 components today, each mapping to one distinct UI region. There are
no thin wrapper components left.

## Services: why there are so many, and why that's intentional (25 when written; 39 as of 2026-09-21)

Every service has a single, non-overlapping responsibility. Several docstrings explain
*why* two similarly-named or similarly-shaped services are kept separate rather than
merged — read these before proposing a service merge:

- `ToolService` — mutually-exclusive "which click-tool is active" state machine
  (measure/sketch/structural-node/structural-member/bridge-mesh/primitive). Resolves
  `SketchService`/`PrimitiveToolService` etc. lazily via `Injector` specifically to avoid
  circular DI dependencies.
- `StructuralToolService` — viewport interaction state for placing structural
  nodes/members; docstring calls it "the structural-analysis analogue of SketchService."
- `SketchService` — sketch/extrude interaction, on a datum plane or a picked face of an
  existing part (added 2026-08-06 — see the face-sketch pass below); one closed profile per
  sketch — rectangle, circle, polygon, or slot, each drawn by 2 viewport clicks.
- `PrimitiveToolService` — click-to-place interaction for standalone 3D primitives
  (box/cylinder/sphere/cone): click a base point in the viewport, then configure
  dimensions before committing. Click-to-place analogue of `StructuralToolService`/
  `SketchService`, but for primitives that don't go through the sketch/extrude pipeline.
- `BridgeMeshService` — face-pick interaction for bridge-mesh generation; docstring:
  "mirrors StructuralToolService/SketchService's shape."
- `ObjectTransformService` — owns the interactive Move/Rotate/Scale gizmo (Three.js
  `TransformControls`), added 2026-08-11 — see the dated entry below. Unlike the other
  interaction-domain services above, deliberately NOT wired into `ToolService`'s
  `ActiveTool` machine: it overlays whatever is currently selected regardless of which
  click-tool (if any) is active, the same way `SelectionService`'s own highlight box/gizmo
  already does.
- `ModelingSessionService` — owns the long-lived worker+OCCT session for interactive
  sketch/feature authoring, explicitly contrasted in its docstring with
  `StepLoaderService`'s one-shot worker-per-load used for STEP import and standalone
  primitive creation (neither needs a persistent session — no shape to chain onto).
- `StructuralModelService` — structural data model (nodes/members/sections/loads),
  "parallel to TreeService's CAD tree but its own domain" (per docstring).
- `StructuralSolverService` — thin wrapper invoking the pure `structural-solver.util.ts`
  math synchronously (no worker needed — sub-100ms at v1 scale).
- Four "renderer" services — `StructuralRendererService`, `StructuralResultsRendererService`,
  `BridgeMeshRendererService`, `SketchRendererService` — share a common *pattern* (own an
  independent named `THREE.Group` in the scene: `StructuralModel`, `StructuralResults`,
  `BridgeMesh`, `SketchOverlay`) but render unrelated domains with zero cross-references.
  `SketchRendererService` (added 2026-08-06, face-sketch pass) owns the picked-face highlight,
  reference-point markers, snap indicator, and in-progress shape preview — deliberately not
  folded into `SketchService` (kept scene-agnostic by design) or `SelectionService` (whose
  highlight is whole-mesh and a different, transient concern). `RenderService` is unrelated
  despite the similar name — it's global shading mode/dark mode/screenshot capture, not
  a "render domain X into the scene" service.
- `ViewerService` / `CameraService` — scene+renderer lifecycle vs. camera/controls/framing.
- `TreeService` — CAD model tree (assembly/import/body nodes); supports multiple STEP
  imports appended as sibling `import` nodes under one assembly root, plus rename/delete/
  in-place replace (`replaceBody`, added for the cut-fix pass — swaps a node's `CadBody` at
  the same id/parent/position, distinct from delete+register which would silently re-parent
  under the wrong import in a multi-import assembly) and per-import source retention
  (`getImportSource`, a side map of import-node id → the STEP URL/File it came from, so a
  later cut can re-read the original bytes). Independent of `StructuralModelService`'s tree.
- `SelectionService` / `PropertyService` / `MeasurementService` — raycasting+highlight,
  properties-panel snapshot editing (including rename/delete orchestration hooks, plus
  `selectedDimensionLabels()` — the selected body's Length/Width/Height as in-viewport screen-
  space labels, added 2026-08-06), and the distance-measurement tool (plus `labelPositions()`,
  same in-viewport-label technique, added the same pass), respectively. Each owns distinct
  state with no overlap. **Note:** `SelectionService`'s highlight state and `PropertyService`'s
  snapshot are separate and don't sync each other — several call sites historically cleared only
  one (see the 2026-08-06 dimension-labels follow-up below for the bug this caused and the fix).
- `SectionService` — per-axis clipping plane config, applied via `viewer.renderer.clippingPlanes`.
- `ExplodedViewService` — radial explode animation, keyed off `TreeService.allBodies()`.
- `StepLoaderService` — one-shot STEP import worker (URL-based or from a local `File` via
  an object URL), plus one-shot standalone primitive creation (`createPrimitive`) — see
  `ModelingSessionService` above for why these don't use the persistent session.
- `HistoryService` — generic undo/redo command stack (`{label, undo, redo}` entries).
  Scope is deliberately limited to trivially-reversible property edits (rename, visibility,
  color, opacity, section plane config) wrapped at their component call sites; deletes and
  OCCT feature/primitive creation are NOT wrapped (see docstring for why — GPU disposal and
  in-place worker shape mutation have no snapshot to restore).
- `PanelLayoutService` — persisted UI-shell layout only (floating tool-panel position/dock
  state, model-tree/properties column widths), added for the dockable-panels pass (see
  below). Deliberately not merged into any of the 7 tool-domain services above — none of
  them own "where does this panel sit on screen," and it's the only service both
  `ToolPanels` and `SidePanels` need to share, so a dedicated service avoids duplicating
  localStorage read/write and drag-math logic across those two components.

## Utils

All are small, pure, single-purpose functions reused across multiple services (e.g.
`generateId` used in 6 places, `geometry-math` in 2+). Correctly extracted — not
candidates for inlining.

## Refactor request (2026-07-31) — outcome

The user asked for a full "reduce components/services, merge overlapping logic" pass.
After reading every service/component/util directly (not just by name), the finding was
that this exact consolidation had already been done once (see docstrings above) and the
remaining structure is already minimal for the feature set — no further merge was safe
without either combining unrelated feature domains (hurts debuggability) or risking
behavior changes. The only actual dead code found: `ExplodedViewService.invalidate()`
was defined but never called anywhere — removed.

**Takeaway for future refactor requests on this repo:** don't re-run a broad "reduce
file count" pass from scratch. If something is hard to navigate, ask the user which
specific file/workflow hurts and investigate that concretely, rather than re-deriving
the whole-codebase architecture read again.

## Feature work (2026-07-31) — assembly parts CRUD, shape authoring, undo/redo

Three incremental passes, each verified end-to-end against the running dev server
(Playwright), not just typechecked:

1. **Assembly parts CRUD gap.** Before this pass, body nodes only supported Read and
   partial Update (color/opacity/visibility) — no rename, no delete, and "Open STEP…" just
   reloaded the same hardcoded file. Added: `TreeService.renameNode`/`deleteBody`,
   `PropertyService.refreshIfSelected`/`clearIfSelected`, a real file-picker wired to
   `StepLoaderService.loadStepFileFromBlob` (appends via `TreeService.registerImport`,
   which now supports multiple sibling imports under one assembly root instead of always
   replacing the tree), inline tree rename (double-click) + trash-icon delete with a
   confirm dialog, and an editable Properties-panel Name field. `Viewport` owns delete
   orchestration (disposes the mesh, clears selection/properties) since it already injects
   `tree`/`selection`/`property`/`viewer`; `SidePanels` bubbles delete requests up to `App`
   via `@Output()`, mirroring the existing `openStepFile` pattern.

2. **Shape authoring.** `SketchService` extended from rectangle-only to a `SketchShape`
   union (rectangle/circle/polygon/slot), each still 2 viewport clicks plus an optional
   numeric field (polygon sides, slot width) — new worker-side geometry in
   `step-loader.worker.ts` (`wireFromPointLoop`, `polygonPoints`, `slotPoints`) builds
   these as closed wires reusing the existing `buildFaceFromSketch` face-building path.
   Added standalone 3D primitives (box/cylinder/sphere/cone) as a new click-to-place tool
   (`PrimitiveToolService`, new `'primitive'` `ActiveTool`) that bypasses sketch/extrude
   entirely — new worker request type `primitive.create` calls `BRepPrimAPI_MakeBox_1` /
   `MakeCylinder_1` / `MakeSphere_1` / `MakeCone_1` directly, translated into place via
   `BRepBuilderAPI_Transform_2`. **Note for future OCCT primitive work:** this build's
   embind overload numbering is not documented anywhere (no `.d.ts`, minified glue JS) —
   `BRepPrimAPI_MakeBox_2` looked plausible but throws `invalid number of parameters (3) -
   expected (4)` at runtime; `_1` was the correct 3-param (width,depth,height) overload.
   Guessed overload suffixes must be runtime-verified (the worker posts back a clear error
   message on the wrong arity — that's how this was caught), not assumed from the C++ API
   shape.

3. **Undo/redo, Phase 1 only.** New `HistoryService` (see above) wired at existing
   component call sites for rename/visibility/color/opacity/section-plane edits. Explicitly
   scoped to exclude deletes and geometry creation after a research survey of every
   service's mutation methods found those need deferred GPU disposal and/or worker-side
   shape history — real design work, not a quick add. Section-plane slider drag is
   coalesced into one undo step on `(change)`/release rather than one per `(input)` tick,
   to avoid flooding the stack during a drag.

**Deliberately not done / open for a future pass:** delete undo, sketch/primitive-create
undo, and the broader "CATIA/STAAD/SolidWorks-grade platform" ask (dockable panels — now
done, see the dated entry below; multi-select + bulk edit + copy/paste, snapping/alignment
guides, search/filter/grouping, versioning, high-performance large-dataset rendering remain
open). These were scoped as separate, larger efforts rather than folded in here — see
conversation history for the mutation-reversibility survey if resuming the undo/redo work
specifically.

## Feature work (2026-07-31) — dockable panels

Implemented the "dockable panels" item from the platform wishlist above: the 7 floating
tool panels (measure/section/sketch/structural/results/bridge-mesh/primitive, all rendered
by `ToolPanels`) are now drag-and-dock (VS Code style — drag by the panel's `.panel-title`
header, drop within 40px of the viewport's left/right edge to dock, which actually shrinks
the 3D canvas), and the two side panels (model tree, properties, both in `SidePanels`) got
drag-to-resize handles on their inner edges. Both position/dock-state and side-panel widths
persist across reloads in one localStorage blob (`panel-layout-v1`).

**New files:**
- `models/panel-layout.model.ts` — `DockMode`, `FloatingPanelLayout`, `ToolPanelId`,
  `PanelLayoutStorageV1`. Plain types, no logic, same convention as `history-command.model.ts`.
- `services/panel-layout.service.ts` — `PanelLayoutService`, the single source of truth for
  floating-panel position/dock-state and side-panel widths. Justified as a new service the
  same way `PrimitiveToolService`/`HistoryService` were: "where does this panel sit on
  screen" is a cross-cutting UI-shell concern that belongs to none of the 7 tool-domain
  services. Side-panel widths live in the *same* service as floating-panel layout rather than
  a second service — both are just "persisted panel geometry," splitting them would be the
  kind of over-fragmentation this codebase's architecture already argues against.
- `directives/panel-drag-handle.directive.ts` — `PanelDragHandle`, the first directive in
  this codebase (new `directives/` folder). Deliberately dumb: pointer-capture + delta math
  only, emits `dragMove`/`dragEnd` with candidate coordinates. Knows nothing about dock zones
  or persistence — `ToolPanels` (the host) owns all of that behavior from the emitted events,
  mirroring how `ToolPanels` already owned all the drag behavior for the section-offset slider.

**Modified files:** `tool-panels.ts/.html/.css`, `side-panels.ts/.html/.css`,
`viewport.ts/.html/.css`, `app.ts/.html`. `app.css`'s static `grid-template-columns:
240px 1fr 260px` is kept only as the pre-hydration fallback; the live value is now an inline
`[style.grid-template-columns]` binding on `App` (see below).

**Non-obvious structural decision — where each panel's markup lives.** `ToolPanels` still
defines each of the 7 panels' markup exactly once (as an `ng-template`), but a docked panel
must become a *real* flex-layout child that pushes the canvas over — not just a repositioned
`position: absolute` element, which would only visually overlay the canvas, not shrink it.
Solved by giving `ToolPanels`'s `:host` `display: contents` (so it contributes no box of its
own) and having its template render 3 top-level regions — `.dock-left` column, `.canvas-
overlay` (which projects `Viewport`'s canvas/nav-cube/loading-overlay/context-menu markup via
a single `<ng-content>`), `.dock-right` column — with each panel's `ng-template` projected via
`ngTemplateOutlet` into whichever region matches its current dock state. Those 3 elements
become real flex-item siblings inside `Viewport`'s `.viewport-container` (now `display: flex`,
with `<app-tool-panels>` wrapping the canvas markup instead of sitting beside it). This is why
`Viewport`'s `containerRef` was replaced with `@ViewChild(ToolPanels) toolPanels` reading
`toolPanels.canvasOverlayRef` — `ViewerService`/`CameraService` need the *shrunk* canvas
area's `clientWidth/clientHeight`, not the full `.viewport-container` (which also spans any
docked columns). `ViewerService`'s existing `ResizeObserver` (already wired for the STEP-import
CRUD pass) needed zero changes — it fires correctly on the flex-driven resize automatically.

**Non-obvious structural decision — side-panel width ownership.** `.cad-main`'s
`grid-template-columns` is owned by `App` (its parent), not `SidePanels` — a child component
can't set a CSS custom property visible to an *ancestor's* own box, so `SidePanels` only emits
`treeWidthChange`/`propertiesWidthChange` on each resize-drag tick (mirroring the existing
`deletePart` `@Output()` bubbling pattern exactly), and `App` is the one that writes the bound
`[style.grid-template-columns]`. No component in this codebase writes to
`document.documentElement`/`:root` — that alternative was considered and explicitly rejected
to keep every component's styling authority scoped to elements it owns.

**Multi-panel-same-side stacking:** confirmed via `ToolService`/`SectionService`/
`StructuralSolverService` that `results-panel` (`hasResults()`) is independent of the
tool-exclusive state machine — it can co-occur with *any* of the other 6 panels, not just the
structural panel, if the user runs an analysis then switches tools without dismissing results.
Handled generically: `.dock-column` is itself a flex column, so any number of panels docked to
the same side stack vertically rather than overlapping; no special-casing per panel pair.

**Deliberately not done:** floating/undocking for the side panels themselves (tree/properties
stay anchored left/right, resize-only, per this pass's scope) and a max-panels-per-side cap
(unnecessary at current panel counts — see stacking note above).

## Feature work (2026-08-06) — face-based sketch planes, Phase 1

Implemented the first phase of "sketch on a picked face like SolidWorks/Fusion/Creo/NX," scoped
down from the full request (constraint solver, dynamic dimension engine, freeform line/spline
drawing, and construction geometry were explicitly deferred as separate future phases — see the
plan doc for the full scope split). What shipped: picking a face on an existing part auto-detects
its plane, highlights it, animates the camera normal to it, populates snap references from its
boundary edges, and lets the existing rectangle/circle/polygon/slot tools snap to those
references before extruding. Global datum planes (XY/YZ/XZ) remain available at all times
alongside the face-pick option, rather than being hidden — an assembly still needs a way to
sketch on a plane with no existing geometry.

**Core decision: face-plane resolution is entirely client-side, no OCCT round-trip.** The plane
(origin + normal) and reference points (vertices/midpoints/circle-centers/intersections) are
derived purely from the already-loaded THREE.js tessellation on `CadBody` (`mesh`, `geometry`,
`faceIdMap`) — the same zero-OCCT-involvement approach `SelectionService.pickFace` and
`BridgeMeshService`'s boundary-loop extraction already used. This sidesteps a real gap: STEP-
imported bodies have no live OCCT shape in `ModelingSessionService`'s worker session (`session.
shape` only gets populated after the *first* sketch/extrude, and is unrelated to imported
geometry) — re-parsing the STEP source into the session to get a queryable `TopoDS_Face` would
mean a second full OCCT parse and an unverified assumption that both parses explore faces in the
same order. Client-side derivation works uniformly for STEP-imported, primitive-created, and
feature-extruded bodies with one code path, and needs no worker round-trip before the camera/
highlight/references can appear — they're synchronous the instant a face is picked. The only
OCCT involvement is at commit/extrude time (unchanged code path): the worker builds a
`Geom_Plane` directly from an explicit origin+normal+uAxis sent by the client, never
dereferencing the pick back to a live face. Phase 1 only supports **planar faces** (triangle-
normal-parallelism tolerance check); a non-planar pick surfaces a clear error and stays in the
picking phase.

**New files:**
- `utils/face-geometry.util.ts` — pure functions, same convention as `geometry-math.util.ts`/
  `mesh-boundary.util.ts`: `getFacePlane` (world-space origin/normal from a body's tessellation,
  with the planarity check), `pickUAxis` (deterministic in-plane axis, world-X-or-Y fallback near
  the pole), `extractFaceReferencePoints` (boundary-edge walk classifying straight-edge
  endpoint/midpoint pairs vs. circumcircle-fit circular-edge-run centers, plus non-adjacent
  straight-segment intersections — tessellation-based, not read back from OCCT, consistent with
  the client-side-only approach).
- `services/sketch-renderer.service.ts` — `SketchRendererService`, justified the same way
  `BridgeMeshRendererService`/`StructuralRendererService` were: nothing owned drawing sketch
  state into the scene before this (confirmed zero existing sketch-preview rendering), and it
  needs frequent rebuilds through the whole drawing phase (pointermove-driven) — a dedicated
  group-owning service, not folded into `SketchService` (kept scene-agnostic by design) or
  `SelectionService` (whose highlight is whole-mesh and a different, transient concern). Owns
  face highlight (built from just the matching triangles, not `SelectionService`'s whole-mesh
  tint), reference-point markers (color-coded by kind), a live snap indicator, and the
  in-progress shape preview.

**Modified files:** `workers/step-worker-messages.model.ts` (`PlaneRef`'s `face` variant now
carries `origin`/`normal`/`uAxis` directly instead of an unresolved `sessionId`/`faceIndex` —
`uAxis` is threaded through explicitly so the worker's (u,v) parameterization can't silently
diverge from what the client used to compute sketch points, which would otherwise rotate the
extruded profile relative to what was drawn), `workers/step-loader.worker.ts` (`planeFromFace`
mirrors `planeFromDatum`; `buildFaceFromSketch` now resolves either plane kind and returns
`{face, geomPlane}` instead of just `face`, so `handleFeatureExtrude` can derive the extrude
direction from `geomPlane.Axis().Direction()` — the same mechanism already used for circle
construction — replacing a datum-only ternary that silently produced the wrong axis for face
planes), `models/sketch.model.ts` (new `'picking-face'` phase, `facePlane`/`pickedFace`/
`referencePoints` state), `services/sketch.service.ts` (`beginFromFace`, plane-kind-aware
`projectToPlane`/`planeNormal`, new `planeOrigin()`), `services/camera.service.ts`
(`animateToFace` wrapper around the existing `animateTo`, with a new up-vector heuristic for
arbitrary normals — falls back near the Z pole), `components/viewport/viewport.ts`
(`handleSketchClick` branches on phase; new `onCanvasPointerMove` drives live snap/preview
feedback; a `raycastSketchPlane` helper fixes a latent bug where the sketch ray-plane
intersection always assumed distance 0 from the world origin, wrong for any face plane or a
datum plane with a nonzero offset), `components/tool-panels/tool-panels.html` (picking-phase
panel shows both the datum buttons and a "click a face" hint, gated on whether any bodies exist).

**Snapping:** screen-space pixel threshold (12px, zoom-independent) against the face's cached
reference points, computed once at pick time — not re-raycast against OCCT per move. A snap hit
overrides the raw raycast point outright, not just the visual indicator.

**Deliberately not done / open for a future pass:** the geometric constraint solver (coincident/
parallel/perpendicular/tangent/horizontal/vertical/concentric/equal/symmetric/fixed), automatic/
dynamic dimension display of existing part geometry and live dimensioning while sketching,
freeform multi-segment line/spline drawing, ellipse/centerline/construction geometry entity
types, and "convert edge to sketch reference" as a user-toggled action (references are
auto-populated and read-only in this phase). Also not done: extending `SelectionState` with a
face-level field for a true "select a face first via the default tool, then click Sketch and
skip straight to drawing" flow — today that sequence still requires one more face click after
activating Sketch, since whole-body selection doesn't carry `faceIndex`. Scoped out to avoid
widening a shared, widely-used piece of state for a Phase-1-only feature.

## Bug-fix pass (2026-08-06) — cut extrude, sketch/selection interaction, dimension labels

Three issues found while using the Phase 1 face-sketch feature above, fixed in one pass.

**Cut wasn't removing material.** Root cause: `handleFeatureExtrude`'s cut/fuse boolean only
ever operated against `session.shape` — the modeling session's own internally-accumulated shape,
`null` until the session's own first extrude, never seeded from imported STEP geometry. Sketching
on a face of an imported part and checking "Cut" silently added a standalone boss instead of
subtracting material, because there was nothing real to cut against.

Fix: when a sketch targets an existing body (`SketchState.pickedFace`, already tracked from the
face-sketch pass), `SketchService.finishAndExtrude` re-reads that body's *original STEP source
bytes* (via a new `TreeService.getImportSource`/side map — `registerImport` now takes a
`source: string | File`, either the bundled asset's stable URL or the user-picked `File` itself,
since `StepLoaderService.loadStepFileFromBlob`'s object URL is revoked immediately after load and
can't be reused) and posts those bytes to the worker as a new optional `targetBody:
{bytes, solidIndex}` field on `feature.extrude`. The worker's `handleFeatureExtrude` re-parses
those bytes with **`session.occt`** (the same WASM module instance the cutter/prism already use —
OCCT shape handles are tied to the module instance that created them, so a second freshly-init'd
module would produce unusable cross-module handles), re-explodes to the same `solidIndex`
(`explodeSolids`'s traversal is deterministic for unchanged bytes, confirmed by tracing
`tessellateSolid`'s face-index assignment), and cuts/fuses against that real solid instead of
`session.shape`. The STEP-bytes-to-shape logic (CRLF strip + the 3-attempt short-virtual-path
retry loop, both pre-existing quirks of this WASM build) was factored out of `handleLoad` into a
shared `readStepShape(occt, bytes)` so the new path reuses it rather than duplicating it; the
virtual-path counter is now module-global (not reset per call) so the initial load and a later
cut-target read never collide on the same FS path.

The result **replaces** the targeted body in place — new `TreeService.replaceBody(nodeId,
newBody)` swaps the `CadBody` at the same node id/parent/position, deliberately not
`deleteBody`+`registerBody` (which would silently re-parent the replacement under
`this.importId`'s *last-registered* import, a real bug for a multi-import assembly since
`registerBody` has no per-call target-parent argument). `SketchService.replaceBodyInScene` mirrors
`Viewport.deletePart`'s existing dispose sequence (clear selection/properties if the old body was
selected, dispose the old mesh, add the new one). A `targetBody`-less extrude (datum-plane
sketches, or sketching on a body created earlier in the same session) is **byte-for-byte
unchanged** — the pre-existing `session.shape` path is untouched when `req.targetBody` is absent.

**Selection couldn't be cleared / interfered with sketching.** Once Sketch is active, every canvas
click routes through `handleSketchClick` — `handleSelectClick` (the only path that ever called
`SelectionService.selectMesh`/`clearSelection`) was unreachable, so a pre-existing selection
highlight (orange box + gizmo) just sat there indefinitely with no way to clear it. Fixed two
ways: `ToolService.activate('sketch')` now clears selection immediately (resolved lazily via the
existing `Injector`, same pattern already used for `deactivate()`'s per-tool `cancel()` calls);
and `Viewport.handleSketchClick`'s picking-phase branch now calls `selection.clearSelection()` on
a `pickFace` miss (empty canvas / non-planar background) — the only reachable "deselect" gesture
while this tool is active, matching how a miss is treated in every other tool.

**No way to see a dimension in the 3D view.** The existing Distance tool only ever rendered its
numeric value as side-panel text (`MeasurementService` draws marker spheres + a line in-scene,
but never a label). No `CSS2DRenderer`/sprite infra exists anywhere in the app (confirmed during
the face-sketch pass too), so rather than adding a second Three.js renderer, added a lightweight
DOM-overlay layer: new `MeasurementService.labelPositions(camera, canvasRect)` projects each
measurement's midpoint to screen space and pairs it with `formatLength(m.distance)` (reused from
`unit-conversion.util.ts` — same formatting the side panel already used); `Viewport` recomputes
this every frame via the existing `ViewerService.onFrame` hook (already used for nav-cube sync),
gated to a no-op when there are no measurements, and renders one absolutely-positioned
`.dimension-label` div per result in a new overlay layer inside `.canvas-overlay`. Scoped to the
existing Distance tool only — new measurement/dimension types are a separate future pass.

**Verified end-to-end** via a Playwright driver script against the dev server (not `ng build` —
see the face-sketch pass's note on a pre-existing, unrelated production-build gap): cut extrude
confirmed by body count staying at 17 (not 18 — replaced in place) and the model tree node
renaming to "Feature Body 1" at the same position "Body 1" occupied; selection-clear confirmed via
the properties panel switching to "No selection" the instant Sketch activates; dimension label
confirmed rendering in-viewport and tracking correctly through a camera orbit.

## Follow-up (2026-08-06) — automatic in-viewport dimensions on part selection

The dimension-label pass above only showed a value in the 3D view for the Distance tool, which
needs the user to click two points. The actual ask was simpler and more automatic: click a part,
see its overall size on the model itself, no extra clicks.

Added `PropertyService.selectedDimensionLabels(camera, canvasRect)` — reads the already-selected
body's `CadBody.boundingBox` (no new data needed) and computes one label per non-degenerate world
axis (Length/Width/Height), each positioned at the midpoint of that axis's bounding-box edge
nearest the camera (picked via the sign of the camera-to-center vector on the other two axes, so
the label sits on a visible near edge rather than potentially behind the model or floating at the
box center) — same screen-projection technique `MeasurementService.labelPositions` already used.
`Viewport.syncDimensionLabels` (the existing per-frame sync, still driven off `ViewerService.
onFrame`) now populates two separate signals — `measurementLabels` and `bodyDimensionLabels` —
rather than one merged list, so the template can style them distinctly (`.measurement` stays
yellow, matching `MeasurementService`'s marker/line color; `.body-size` is blue, matching
`SelectionService`'s existing highlight tint) without threading a discriminant field through both
services.

**Bug found and fixed while wiring this up:** `SelectionService` (whole-mesh highlight state) and
`PropertyService` (properties-panel snapshot — now also the source of these new labels) are two
separate pieces of selection state that several call sites only ever cleared one of. The ribbon's
"Clear Selection" button (`app-chrome.ts`) called `SelectionService.clearSelection()` only, never
`PropertyService.showProperties(null)` — pre-existing, but only became visible now that
`PropertyService`'s state also drives something rendered in the 3D view instead of just static
side-panel text. Same gap existed in the face-sketch pass's own `ToolService.activate('sketch')`
selection-clear and `Viewport.handleSketchClick`'s picking-phase-miss deselect. All three fixed to
clear both; `Viewport.deletePart`/`SketchService.replaceBodyInScene` already did this correctly
and were used as the reference for what "clear both" should look like.

## Bug fix (2026-08-06) — cut extrude direction

The cut-fix pass above got the *target* right (cut against the real imported solid, not
`session.shape`) but not the *direction*: `handleFeatureExtrude` always extruded the sketch's
profile along the outward face normal (`getFacePlane`'s client-side average of the picked face's
triangle normals — correct for growing a boss, since that's away from material). For a cut, that
means the tool solid sits almost entirely *outside* the part, barely grazing it at the sketch
plane. `BRepAlgoAPI_Cut` between the part and a tool that doesn't overlap the part's interior
returns `IsDone() === true` (no error) but removes nothing — the reported symptom exactly:
drew a rectangle, checked Cut, clicked Extrude, no error, no hole.

Fix, scoped to only the case that needs it (`req.cut && req.targetBody` — cutting into an
existing body; the fresh-session-shape cut/fuse path and the boss/fuse path are both left exactly
as before): build the tool solid as two prisms extruded in *both* directions from the sketch
plane (outward `BRepPrimAPI_MakePrism` + inward, same face, negated vector) and fuse them into
one symmetric tool before handing it to `BRepAlgoAPI_Cut`. This guarantees the tool always
punches through the material regardless of which way the face normal happens to point, matching
how mainstream CAD tools default a cut to "through both directions" rather than trusting a single
guessed sign. Verified by comparing a selected body's `Volume` property before/after: an
unrelated-body boss/fuse left the original body's volume exactly unchanged (confirms no
regression — a fresh-session fuse still correctly appends a new body rather than mutating the
original, unchanged pre-existing behavior); a same-body cut reduced volume by a real, substantial
amount (not just a technically-successful no-op), with the hole visible through the part in a
screenshot.

## Feature work (2026-08-07) — professional CAD interaction pass

Full request: make the app's *interaction layer* (not its geometry/OCCT features, which were
explicitly out of scope) feel like a professional desktop CAD tool — SolidWorks/Fusion-class
mouse/keyboard conventions, multi-select, design-system consistency, discoverable shortcuts.
Scoped down from the full ask (per user decision): **no interactive transform gizmo**
(drag-to-move/rotate/scale), no snap-to-grid for placement, no versioning, no large-dataset
render perf work — those remain open for a future pass.

**Camera controls** (`camera.service.ts`): `OrbitControls.mouseButtons` now explicitly sets
`MIDDLE: THREE.MOUSE.PAN` (previously defaulted to dolly, duplicating scroll-zoom and leaving no
button for pan) and `RIGHT: null` (disabled — `Viewport.onContextMenu`'s custom context menu
already owns right-click; leaving `OrbitControls` on that button would fight it). `LEFT` stays
`ROTATE` (default) — click-vs-drag is already disambiguated by `Viewport`'s existing pointerdown/
click delta-threshold check.

**Multi-select** (`selection-state.model.ts`, `selection.service.ts`, `viewport.ts`,
`side-panels.ts`): `SelectionState` gained `selectedBodyIds: string[]`, additive to the existing
singular `selectedNodeId`/`selectedBodyId` fields (every pre-existing single-select reader is
unaffected — those still mean "primary/last selection"). New `SelectionService.toggleMesh(mesh,
additive)` — `additive=false` is exactly the old `selectMesh` behavior; `additive=true` (Ctrl/
Shift-click) toggles into/out of the multi-select set, and a miss on empty space while additive is
a no-op (not a clear) matching SolidWorks/Fusion convention. `selectAll` (Ctrl+A) shares a new
private `applySelection` with `toggleMesh` that rebuilds per-body highlight (box outline + axis
gizmo, now keyed by bodyId in a `Map` rather than a single field, since multiple bodies can be
highlighted at once).

**Box-select (rubber-band drag-to-select) was built, then removed after user feedback.** A
screen-space drag-select rectangle was implemented (`Viewport.boxSelectRect`, arming on a
left-drag starting over empty canvas with the default tool active, disabling `OrbitControls.
enableRotate` for the drag's duration since `LEFT` is mapped to `ROTATE`). Two real bugs were found
and fixed during verification — a box-select drag silently reframing the camera and breaking the
next click's raycast, and a stale "was this an empty-canvas press" flag that never got cleared on
`pointerup`, causing a rectangle to appear and track the cursor after a plain click with no button
held. Despite both fixes verified via Playwright, the user reported it was still surprising/
unwanted in practice (a left-drag anywhere on empty space always producing a rectangle, with no way
to just orbit from empty space) and asked for the feature to be removed entirely, keeping Ctrl/
Shift-click multi-select. Removed: `Viewport.boxSelectRect`/`onCanvasPointerUp`/
`updateBoxSelectDrag`/`meshIntersectsScreenRect`, `SelectionService.selectBoxIntersect`, the
`.box-select-rect` div/CSS. **If box-select is revisited, don't default to "any left-drag on empty
space" — this repo's own experience shows that reads as an unwanted interruption to orbiting from
empty space; a modifier-key-gated variant (e.g. only left-drag while holding a key) was suggested
as the safer alternative and never built.**

**Keyboard shortcuts** (`viewport.ts`, extending `app-chrome.ts`'s existing Ctrl+Z/Y handler):
Escape (clear selection + deactivate active tool), Delete/Backspace (delete selected part, reusing
`confirmAndDeletePart`), F (fit all), 1-7 (view presets, matching `AppChrome.viewPresets`' order),
Ctrl+A (select all), M/S (measure/sketch tool toggle) — all in a new `Viewport` `@HostListener`,
guarded by the same input/textarea/contentEditable check `AppChrome`'s handler already used. Split
by ownership: canvas/tool/camera-scoped shortcuts in `Viewport` (already injects everything
needed), Ctrl+Z/Y stay in `AppChrome`.

**Undo/redo history dropdown** (`history.service.ts`, `app-chrome.ts/html/css`): new
`HistoryService.undoEntries()`/`redoEntries()` — plain getters over the existing private stacks,
purely additive, no change to undo/redo semantics. `AppChrome` adds a caret next to each of the
Undo/Redo buttons opening a dropdown of recent labeled steps (reuses the existing `HistoryCommand.
label` strings already captured for every wrapped edit); clicking an entry jumps to that point by
re-invoking `undo()`/`redo()` in a loop — no new jump-to-index primitive needed.

**Design tokens** (`styles.css`): new `:root` block of `--cad-*` custom properties (surfaces,
borders, text, accent, semantic colors, spacing scale, radius, font) consolidating what was ~16-27x
duplicated raw hex literals per file across `app.css`/`app-chrome.css`/`side-panels.css`/
`tool-panels.css`/`viewport.css`. Purely a value swap — no visual change, just a single place to
adjust the theme going forward. A handful of single-use hex values (mostly `#fff` on hover/active
states) were deliberately left literal rather than tokenized, per the "don't tokenize what's used
once" judgment call.

**Icon system** (`utils/icon-registry.util.ts`, `components/icon/icon.ts`): replaced every emoji/
Unicode glyph (📁📦◆👁⊘🗑▾▸✕⇄▭○⬡▬↶↷⛶⟲▱◼▦◻#✛📷◐) with a small inline-SVG set — a plain name→markup
registry (matches this codebase's util convention) plus one reusable `Icon` component, the second
directive/component-like exception to the "no thin wrapper components" rule (the first being
`PanelDragHandle`) — justified the same way: cross-cutting UI-shell chrome with no feature-domain
logic, used identically across `app-chrome`/`side-panels`/`tool-panels`/`viewport`.

**Status bar** (`viewer.service.ts`, `app-chrome.ts/html`): added live cursor world-coordinates
(`ViewerService.cursorWorldPos`, fed from `Viewport`'s existing pointermove handler — raycasts
whatever's under the cursor, falling back to the Z=0 ground plane) and a rolling-average FPS
counter (`ViewerService.fps`, sampled once per second from the existing render loop's frame
timestamps, not per-frame, to avoid both the perf cost and an unreadable number).

**Model tree search/filter** (`side-panels.ts/html/css`): new `treeFilter` signal + `visibleNodeIds`
computed (case-insensitive label match, auto-expanding ancestors of any match) — a pure view-layer
filter, no `TreeService` change.

**Context menu cleanup** (`viewport.ts/html`): removed the "Zoom To"/"Focus" duplicate (collapsed
to one "Zoom to Fit"); "Properties" now calls `PropertyService.requestFocusProperties()` (a plain
counter signal `SidePanels` watches via `effect()` to flash its panel header — the only feedback
possible since the panel is always visible, never collapsed); added "Rename" (via a matching
`requestStartRename()` bridge into `SidePanels`' existing inline-rename UI) and "Duplicate" (clones
the selected body's mesh — shared geometry reference since it's immutable, cloned material so
color/opacity edits don't cross-affect — offset +20mm X, registered via the existing `TreeService.
registerBody`, wrapped in `HistoryService.run` for undo). Both new bridge signals live on
`PropertyService` since `Viewport` and `SidePanels` are siblings under `App` with no direct
reference to each other.

**Verified end-to-end** via a Playwright driver script against the dev server (`ng build`'s
production bundle still fails for the pre-existing, unrelated `opencascade.js`-in-esbuild reason
documented in the face-sketch pass above — confirmed unchanged by this pass, not fixed): 0 console
errors across the full run; multi-select (Ctrl+click, additive-miss-preserves-selection) confirmed
both by status-bar text and visually (simultaneous orange highlight boxes + tree row highlighting
on multiple bodies); undo/redo history dropdown confirmed showing labeled
entries; keyboard shortcuts (Escape/Delete/F/digit-view-presets) confirmed; context menu's full
item set, Duplicate (17→18→17 bodies through do/undo), Rename (inline input appears), and Delete
key (with confirm dialog) all confirmed; tree filter confirmed; icon swap confirmed (zero leftover
emoji glyphs in rendered DOM text).

## Follow-up (2026-08-08) — Mesh View pattern, attempted randomized triangulation then reverted

User wanted "Mesh View" (`mesh-subdivision.util.ts`, `step-loader.service.ts`) to look like a real
FEA mesh — irregular triangles, not the visibly uniform rectangular grid the original recursive
4-way-midpoint-split algorithm produces on flat faces. Tried replacing it with a randomized
"jittered-centroid Steiner-point insertion, 3-way fan-split" scheme (same category of move a real
Delaunay refiner does). Looked right at a glance in a first screenshot, but a closer zoom-in
revealed the real problem: **recursing the same jitter-and-fan-split on already-thin sub-triangles
compounds** — a triangle that came out thin from one level gets jittered again next level, and
jittering near a thin triangle's long edge produces spiky, radiating fans rather than clean organic
mesh. Several density/jitter-magnitude tuning passes didn't fix the underlying convergence problem,
only made it less or more visible.

**Reverted to the original uniform 4-way-midpoint-split algorithm** (predictable, no slivers, no
spikes — the exact pre-existing code) rather than keep iterating on randomness, per explicit user
direction after seeing the spiky result. Only density was retuned finer (`MESH_DENSITY_RATIO`
0.05 → 0.035, `MESH_SUBDIVISION_MAX_DEPTH` 6, both in `step-loader.service.ts`) so it reads as a
fine mesh texture rather than an obviously coarse grid, without touching the algorithm itself.

**Takeaway for any future mesh-view visual work:** a real irregular/organic FEA-style mesh needs
actual constrained Delaunay triangulation (edge-flip based, maintains a "good triangle" quality
invariant at every step) — a recursive-random-split heuristic does not converge to well-shaped
triangles and will produce slivers/spikes under close inspection no matter how the jitter
parameters are tuned. Don't re-attempt the random-jitter approach; either bring in a real
constrained-Delaunay implementation or accept the regular-grid look (which is what every
mainstream CAD tool's "mesh view" toggle typically shows anyway, at sufficient density it reads
fine and doesn't call attention to itself).

## Follow-up (2026-08-08) — mesh view switched to OCCT's own adaptive tessellation

Turned out the "real constrained Delaunay implementation" the takeaway above called for didn't
need building from scratch: OCCT's own mesher (`BRepMesh_IncrementalMesh`, already used in
`step-loader.worker.ts` to tessellate every solid for rendering) is a curvature-adaptive
deflection-based triangulator — the same category of tool referenced above — and was only ever
being asked for a coarse, render-tuned deflection. Mesh View was discarding that entirely and
re-splitting the coarse triangulation uniformly in JS (`mesh-subdivision.util.ts`), which is
exactly why it could only ever look like a regular grid, matching the takeaway's diagnosis.

**Fix:** `tessellateSolid` (worker) now runs `BRepMesh_IncrementalMesh` a second time per solid
at a much tighter deflection (`MESH_VIEW_LINEAR_DEFLECTION`/`MESH_VIEW_ANGULAR_DEFLECTION`,
extracted into a new `readTriangulation` helper shared by both passes) and ships both
triangulations in `WorkerTessellatedBody` — `positions`/`indices` (coarse, render/raycast, used
for shading as before) and new `meshViewPositions`/`meshViewIndices` (fine, wireframe-only, no
`faceIdMap` needed since it's never picked against). `StepLoaderService` builds the Mesh View
wireframe directly from the fine pair instead of calling `subdivideTriangulation` — that util and
its uniform-split algorithm are now dead code and were deleted. Kept the render deflection
untouched (rather than just tightening it globally) since that geometry drives shading/raycasting
for every body all the time, and a much denser render mesh would regress that cost without ever
being seen — Mesh View's wireframe is hidden by default.

**Result:** because OCCT's mesher is genuinely curvature-adaptive, the fine pass naturally
produces dense, irregular triangles on curved/filleted surfaces and coarse ones on flat faces —
the actual visual signature of a real unstructured FEA surface mesh (confirmed via Playwright
screenshots: a cylindrical body's mesh view now shows a fine circumferential/longitudinal
wireframe band wrapping the curve, sharply denser than the flat plate faces next to it) — with no
slivers or spikes, since it's OCCT's mesher doing the triangulation, not a hand-rolled heuristic.
Sketch/extrude/primitive-created bodies (`sketch.service.ts`'s `addResultToScene`) still don't get
a mesh-view wireframe at all — that was already true before this pass (only
`StepLoaderService`'s STEP-import path ever built one) and stayed out of scope here.

## Feature work (2026-08-11) — interactive transform gizmo (Move/Rotate/Scale)

Full request was a broad "make this feel like SolidWorks" sweep across ~20 UI/UX areas. Read
through this file first (per the request's own instruction) and found nearly everything on the
list already shipped across the 2026-07-31/08-06/08-07 passes above (toolbar/ribbon, pan/zoom/fit/
reset, nav cube, context menus, most shortcuts, multi-select, measurement, undo/redo + history
dropdown, dockable panels, status bar, icon system, tree search, responsive canvas). Asked the
user to pick from what the doc's own "deliberately not done" lists actually leave open; they chose
the interactive transform gizmo — deferred twice already (2026-07-31 and 2026-08-07) as real
design work, and the single biggest SolidWorks-parity gap of what remained.

**New file:** `services/object-transform.service.ts` — `ObjectTransformService`, wrapping
Three.js `TransformControls` (r160+ API: `getHelper()` returns the addable `Object3D`; visibility
lives on that helper, not on `TransformControls` itself, which extends `Controls` not `Object3D`
in this three.js version — cost a build error before it was caught). Justified the same way
`BridgeMeshService`/`SketchRendererService` were: a new, single-purpose interaction-domain
service. Deliberately **not** wired into `ToolService`'s mutually-exclusive `ActiveTool` machine —
a transform gizmo overlays whatever is already selected regardless of which click-tool (if any) is
active, the same way `SelectionService`'s own highlight box/gizmo already does; forcing it into
`ActiveTool` would make it fight Select instead of layer on top of it.

**Follows selection automatically.** `Viewport` runs an `effect()` on `SelectionService.state().
selectedBodyId` that calls `objectTransform.setAttachedBody(...)` — the gizmo attaches to
whichever body is "primary," no separate pick step, and multi-select is preserved (confirmed via
Playwright: activating Move with 2 bodies multi-selected keeps `selectedBodyIds.length === 2`,
the gizmo only drags the primary one).

**Undo integration reuses `HistoryService`'s existing shape**, not a new mechanism: mouseDown
snapshots position/quaternion/scale, mouseUp diffs against the live transform and pushes one
`{label: "Move/Rotate/Scale: <body>", undo, redo}` entry (a no-op drag pushes nothing) — same
capture-old/new-value pattern already used for rename/color/opacity, and same one-entry-per-drag
coalescing already established for the section-plane slider.

**Bug found and fixed during Playwright verification, not spotted by typecheck:** the properties
panel and `SelectionService`'s highlight box/gizmo both went stale after an undo/redo of a
transform edit — `apply()` writes `mesh.position/quaternion/scale` directly (has to, since a
single undo/redo step must restore all three at once), bypassing `PropertyService.setPosition`'s
existing `refresh()` call that every other property-edit path gets automatically. Fixed by having
`commitDrag`'s `apply()` explicitly call `property.refreshIfSelected(body)` and a new `SelectionService.
refreshHighlightTransform(bodyId)` (repositions the existing box helper/gizmo without the full
rebuild `selectMesh`/`applySelection` would do — that would also wrongly collapse an active
multi-select down to one body on every drag tick). The same `refreshHighlightTransform` also
drives live tracking *during* a drag, via a plain `onDrag` callback property on the service (not
another signal — it fires on every `objectChange` during a drag, only `Viewport` ever consumes
it).

**Click-guard against TransformControls/Viewport pointer-event overlap:** `TransformControls`
listens on the same canvas as `Viewport`'s own click handler and does not call
`stopPropagation()`. A click that starts on a gizmo handle would otherwise still fall through to
`handleSelectClick` and raycast into whatever's behind the gizmo. Guarded in `onCanvasClick` via
`objectTransform.dragging()` (covers an actual drag) plus a new `isGizmoHandleEngaged()` reading
`TransformControls.axis !== null` (covers a plain click-release directly on a handle with no
movement, which `dragging()` alone wouldn't catch).

**Shortcuts:** G/R/Y (Move/Rotate/Scale — free keys, checked against every existing binding) in
`Viewport`'s existing keydown handler, plus ribbon buttons in a new "Transform" group in
`app-chrome.html` (disabled when nothing is selected). Re-selecting the already-active mode turns
the gizmo off — one `ObjectTransformService.toggleMode()` is the single source of that rule so the
ribbon buttons and keyboard shortcuts don't each reimplement it. Escape now also calls
`objectTransform.disable()` alongside its existing clear-selection/cancel-tool behavior.

**Verified end-to-end via Playwright against the dev server**, including one real debugging
detour: an initial synthetic-pointer-event sweep to find gizmo handle screen coordinates returned
zero hits everywhere, which traced back to `TransformControls`' hover handler gating on
`event.pointerType === 'mouse' | 'pen'` — a raw `dispatchEvent(new PointerEvent(...))` defaults
`pointerType` to `''` and is silently ignored; fixed the test by setting `pointerType: 'mouse'`
explicitly (Playwright's own `page.mouse.*` API already sets this correctly, so real drags worked
throughout — only the coordinate-finding probe needed the fix). Confirmed: Move drag changes
`mesh.position` and the properties panel; Rotate drag changes rotation (`0° → 21.8°` in one test
run); undo/redo both correctly restore/reapply through the panel and the highlight box; mode
toggling (Move↔Rotate↔Scale, re-click-to-turn-off) and Escape-to-disable; buttons correctly
disabled with no selection; multi-select survives gizmo activation; zero console errors throughout
and zero regressions in sketch tool activation, duplicate, or basic select/deselect.

**Fixed in passing:** `AppChrome.showShortcuts()`'s alert text still advertised "Drag on empty
space — Box-select," a feature removed in the 2026-08-07 pass — corrected while adding the new
G/R/Y line right next to it rather than leaving a stale line beside a new correct one.

**Deliberately not done / open for a future pass** (per the request's own broader wishlist, most
of which was already covered — see above): snap-to-grid for the gizmo (natural companion,
`TransformControls` supports `setTranslationSnap`/`setRotationSnap`/`setScaleSnap` directly but
wiring a UI for it wasn't part of the chosen scope), lasso-select (box-select was tried once and
reverted per the 2026-08-07 entry's own warning — lasso has never been attempted here),
delete/geometry-creation undo (still needs the deferred-disposal/worker-side-shape-history design
flagged since 2026-07-31), bulk edit/copy-paste beyond the existing single-body Duplicate,
versioning, and large-dataset render performance work.

## Bug fix (2026-08-13) — Measure panel close desynced ToolService, broke re-toggling

Reported as "step navigation" stale-data: after closing the Measure panel via its own × button
and reopening Measure from the ribbon, the tool silently failed to reactivate, and the previous
measurement's markers/line/label stayed visible in the 3D view with no way back into a fresh
measuring state via the ribbon button.

**Root cause.** Every other tool panel's close button routes through `ToolService.setTool('none')`
(`closeSketch`/`closeStructural`/`closeBridgeMesh`/`closePrimitiveTool` in `tool-panels.ts`), which
keeps `ToolService.activeTool` in sync and runs the tool's own `cancel()`/deactivate cleanup.
`closeMeasure()` was the one outlier — it called `MeasurementService.toggleActive()` directly,
flipping `active` to `false` without ever telling `ToolService`, whose `activeTool` signal stayed
`'measure'`. The next ribbon "Distance" click then hit `ToolService.setTool('measure')`'s
`current === tool` branch (treating it as a toggle-*off* of an already-inactive tool) and did
nothing.

**Fix:** `closeMeasure()` now calls `this.tool.setTool('none')`, matching every other panel's close
button. Completed measurements themselves (the marker/line/label data) are unaffected by this fix
and still persist across a close/reopen by design — `MeasurementService`'s explicit "Clear All"
button is the only thing that clears them, the same running-annotation-list convention as the
Undo history dropdown or the Duplicate list, not a bug.

Verified against the running dev server via a Playwright driver: measure two points, close via ×,
reopen via ribbon — panel now reopens and is ready for a new measurement (previously silently did
nothing); prior measurement's marker/line/label correctly still shown as a persisted record.

## Feature change (2026-08-13) — no auto-loaded model on startup; Open replaces instead of appends

Two related requests, same area (`Viewport`'s STEP-load entry points).

**No auto-load.** The app previously always loaded the bundled
`public/assets/DM556MotorDriverAssembly.STEP` on startup via `Viewport.loadDefaultStepFile()`
(called from `ngAfterViewInit`). Removed that method and its call entirely, along with the
`STEP_FILE_URL` constant — the app now starts with an empty scene (grid/axes only, model tree
shows its pre-existing "No model loaded" empty state, status bar reads "0 bodies"). The user opens
a file themselves via File → "Open STEP…", which was already a fully working real-OS-file-picker
path (`promptImportStepFile` → `onStepFileSelected` → `StepLoaderService.loadStepFileFromBlob`) —
no new loading logic was needed, only removal of the forced default load. `TreeService`'s `nodes`
signal/`rootId`/`importId` are all empty/`null` at construction, so no explicit `reset()` was
needed to reach a valid empty state.

**Open replaces instead of appends.** With auto-load gone, a second "Open STEP…" surfaced
`TreeService.registerImport`'s existing append-by-design behavior (documented in its own
docstring: "lets a user add a second part file without losing the first") on every single re-open,
not just deliberate multi-part assembly building — opening a file twice showed two sibling
`import` nodes (e.g. two copies of the same assembly) instead of replacing. Per explicit user
choice (single-document "Open" convention, not multi-import), `Viewport.onStepFileSelected` now
clears state before registering the new import: `selection.clearSelection()`,
`property.showProperties(null)`, `objectTransform.setAttachedBody(null)` (synchronous detach, same
reasoning `deletePart` already uses — an effect-based detach alone would leave `TransformControls`
holding a stale mesh reference for one tick), `viewer.clearBodies()`, then `tree.reset()`, before
the existing register/load/fit sequence. `TreeService.registerImport` itself was deliberately left
unchanged (still append-by-design) — the replace behavior lives entirely in the caller, so a future
explicit "Import" action (distinct from "Open") can still reuse the append path as-is.

Verified against the running dev server via Playwright: fresh load shows the empty state, not the
old 17-body auto-load; opening a file then opening it again (or a different one) leaves exactly one
import node and the new file's body count — not two imports/double the bodies.

## Feature work (2026-08-16) — mechanical-CAD gap analysis + Fillet/Chamfer (edge-level picking)

Full request: read this file as source of truth, compare the app against professional mechanical
CAD tools (SolidWorks/Fusion/Onshape) across sketching, features, patterns, assemblies, etc.,
produce a prioritized gap analysis, then implement the highest-priority missing tool. The full
analysis was published as an artifact; short version — this app's interaction layer, STEP
import/CRUD, sketch/extrude, and structural-FEA are already professional-grade (see every prior
dated entry above), but **feature-modeling breadth** is the real gap: no fillet/chamfer, no
patterns/mirror, no revolve/sweep/loft, no hole wizard, no parametric feature tree, no assembly
mates, no export. Fillet/Chamfer was picked as highest-leverage: the single most-used finishing
operation in real part design, and the one gap that also required building a genuinely missing
selection primitive (edge-level picking) that pattern/hole-wizard work will need too.

**Edge-level picking, the new primitive.** Before this pass, picking stopped at whole-mesh
(`SelectionService.pickAtClient`) and face-level (`pickFace`, via `faceIdMap`) — no edge
equivalent existed. Added worker-side `extractEdges` (`step-loader.worker.ts`): walks every solid's
edges via `TopExp_Explorer_2`/`TopAbs_EDGE` (same deterministic-per-unchanged-shape order
`faceIdMap`/`explodeSolids` already rely on) and samples each via `BRepAdaptor_Curve` into a
12-point world-space polyline (`WorkerEdge`), shipped alongside each `WorkerTessellatedBody` as
`edges`. Client-side, `CadBody.edges` carries the same polylines (local, pre-`matrixWorld` space —
`toCadBodyEdges`, a new shared `utils/edge-geometry.util.ts`, since three call sites now build a
`CadBody` from a `WorkerTessellatedBody`: `StepLoaderService`'s two paths, `SketchService`'s
extrude-result path, and the new `FilletChamferToolService`'s replace-in-place path).
`SelectionService.pickEdge` resolves a canvas click to `{body, edgeIndex}`: raycast to find which
body is under the cursor (as `pickAtClient` already does), then find the nearest of that body's
edge polylines in **screen space** against a fixed pixel threshold (8px) — same
point-to-segment-distance technique `Viewport.resolveSnap` already established for sketch
reference-point snapping, just measuring distance-to-segment instead of distance-to-point. No
raycast-against-3D-line-geometry primitive exists in three.js at a usable pick tolerance, so this
reuses the sketch tool's own established pattern rather than inventing a new one.

**Fillet/Chamfer tool** (`fillet-chamfer.model.ts`, `fillet-chamfer-tool.service.ts`,
`fillet-chamfer-renderer.service.ts`), the interaction-domain analogue of `PrimitiveToolService`
(click-to-place) and `BridgeMeshService` (click-to-pick-face): activate → click one or more edges
on a single body (re-clicking an already-picked edge toggles it back out, same convention as sketch
reference points) → set radius (fillet) or distance (chamfer) → Apply → worker round-trip → body
replaced in place. New `ToolService` `ActiveTool` value `'fillet-chamfer'`, wired into the same
selection-clear-on-activate behavior Sketch already gets (a stale whole-body highlight would
otherwise fight the edge-picking highlight). `FilletChamferRendererService` owns a
"FilletChamferOverlay" scene group (yellow picked-edge lines, blue hover-preview line) — same
group-ownership shape as `SketchRendererService`/`BridgeMeshRendererService`, and reuses
`disposeObject3D` for cleanup.

**Worker side** (`step-loader.worker.ts`, new `feature.filletChamfer` request/response pair in
`step-worker-messages.model.ts`): always targets an existing body's own solid, re-read from its
original STEP source bytes — the exact same `readStepShape`/`FeatureCutTarget` re-read path the
2026-08-06 cut-fix pass built for face-sketch cuts, since fillet/chamfer (like that cut) has no
session-accumulated shape to fall back to. Re-walks edges in the identical `TopExp_Explorer_2`
order `extractEdges` used, so client-picked `edgeIndex` values resolve to the correct real
`TopoDS_Edge`s. `BRepFilletAPI_MakeFillet`/`BRepFilletAPI_MakeChamfer`, one `Add_2(value, edge)`
call per picked edge, `Build()`/`IsDone()` checked the same way every other boolean op in this
worker already is — an invalid radius/distance for the local geometry fails cleanly with
`IsDone() === false` rather than crashing, surfaced as a normal `lastError` the panel displays
without losing the current pick set (confirmed: a 15mm fillet on a real edge failed exactly this
way in verification; the same edge at the default 3mm radius succeeded). Uses a dedicated
lazily-initialized module instance (`filletOcct`), not `ModelingSessionService`'s persistent
session — mirrors `handlePrimitiveCreate`'s one-shot-worker-call shape, since there's no
sketch/drawing step for this tool to have started a session for. New `bodyTransferList` helper
factors out the repeated 5-buffer (now 5 + N edges) transfer-list construction that was previously
duplicated at all 4 call sites posting a `WorkerTessellatedBody` across the worker boundary.

**UI**: new "Fillet / Chamfer" ribbon button in a new "Features" group (`app-chrome.html`, next to
"Add Shape"), and a floating/dockable tool panel (`tool-panels.html/css/ts`, same drag/dock
machinery every other panel already has) — Fillet/Chamfer toggle, a scrollable picked-edge list
(each removable individually), radius/distance field, Apply button, error display. New
`ToolPanelId` entry `'filletChamfer'` in `panel-layout.model.ts`/`panel-layout.service.ts` (default
floating position, participates in the existing dock-left/dock-right/stacking logic for free).

**Deliberately scoped like the face-sketch cut before it**: only STEP-imported bodies (ones with a
retained import source) support Fillet/Chamfer today — a sketch/primitive-created body has no STEP
bytes to re-read, and surfaces a clear error rather than silently failing (same limitation
`SketchService`'s cut-into-existing-body path already has, for the same reason). Multi-edge picks
must all be on the same body (one boolean op against one target solid); picking on a different body
restarts the pick set rather than erroring, since edge order doesn't matter for a same-body
multi-edge fillet. No feature-tree/edit-after-the-fact yet (falls under the still-open "parametric
feature tree" gap called out in the analysis) and no undo (geometry-creating op, same documented
exclusion as sketch/extrude and primitive creation since 2026-07-31 — GPU disposal + worker-side
shape mutation have no snapshot to restore to).

**Verified end-to-end via Playwright against the running dev server** (not `ng build` — a
standalone `ng build --configuration development` run intermittently failed on unrelated
`opencascade.js`/esbuild Node-builtin resolution errors that reproduced identically on unmodified
baseline code too when run repeatedly outside the dev server process; the actual dev server, this
project's established verification path, compiled every change cleanly with zero console errors
throughout): STEP import (17 bodies) → Fillet/Chamfer panel opens → edge click picks a real edge
(highlighted in-viewport, listed in the panel as "Edge N") → Fillet applies at a valid radius,
panel auto-closes, body count stays at 17 (replaced in place, not appended, matching the cut-extrude
convention) → an intentionally-oversized radius on the same edge fails gracefully with a visible
error and the tool stays open for retry → Chamfer mode verified separately (field label correctly
switches to "Distance (mm)", applies cleanly) → Escape cancels the tool and clears the edge
highlight → Sketch/Measure/Section/Primitive/multi-select/transform-gizmo tools all confirmed
unaffected by Fillet/Chamfer's changes, used before and after it in the same session with zero
regressions or console errors.

## Feature work (2026-08-17) — Model export (STEP / STL), plus a real STEP-source-tracking bug fix

Next item off the gap-analysis priority list (see the 2026-08-16 entry above): before this pass
there was **no way to save or export anything** — every edit lived only in the browser tab's
memory, and the only output was a screenshot PNG. Added **File → Export STEP…** and **File →
Export STL…**.

**STEP export** (`ExportService.exportStep`, worker `model.exportStep` request/handler): only
bodies with a retained original STEP source (i.e. came from an opened STEP file, and haven't since
been replaced by a cut/Fillet/Chamfer — see the bug fix below) can be included, since a real BRep
solid to write only exists by re-reading that source; bodies without one are skipped and reported
back to the user rather than silently omitted or failing the whole export. Every qualifying
body's source is re-read (via the same `readStepShape`/short-virtual-path machinery the cut-fix
and Fillet/Chamfer passes already built) and its target solid is added into one `TopoDS_Compound`
via `BRep_Builder`, which `STEPControl_Writer` then writes in `STEPControl_ManifoldSolidBrep` mode
— the standard mode for solid-body STEP export. **Grouped by source, not by body**: an early
version fetched/transferred/re-parsed each body's source individually, which for a 17-body import
(all sharing one ~2MB source file) meant re-parsing that same file's full `STEPControl_Reader`
pipeline 17 times — slow enough in practice to look completely hung (confirmed via direct
worker-console instrumentation: the 17th re-parse's `Transfer`/`Write` calls were still running
well past a minute). Fixed by grouping bodies by their owning import's source *before* any
fetch/worker call (`StepExportSource`: one entry per unique source, carrying every solid index to
pull from it), so each unique source is read and parsed exactly once no matter how many of its
bodies are exported — this cut a 17-body export from "effectively hung" to a few seconds.

**STL export** (`utils/stl-export.util.ts`, `buildBinaryStl`) needs no OCCT/worker round-trip at
all and works for **every** body regardless of origin (STEP-imported, sketch-extruded, primitive,
or fillet/chamfered) — STL is a pure mesh format, and every `CadBody` already carries a ready
Three.js `geometry` in memory. Builds a binary (not ASCII) STL directly from each body's render
triangulation in world space (`mesh.matrixWorld` applied per-vertex, so multiple bodies combine
correctly at their real assembly positions), computing each triangle's normal via a cross product
rather than trusting stored vertex normals (STL wants one flat face-normal per triangle, not
smoothed vertex normals).

**Bug found and fixed while building this: `TreeService` had no way to distinguish "a body that
came from a STEP import" from "a body that just happens to sit under the same import node in the
tree."** `registerBody` always parents new nodes under `this.importId` (whatever import was most
recently registered) — true for real STEP-import bodies, but *also* true for every primitive,
sketch/extrude result, and Duplicate added afterward, since none of them call `registerImport`
again. `TreeService.getImportSource` (used by `SketchService`'s cut-target resolution,
`FilletChamferToolService`, and now `ExportService`) climbed a body's `parentId` chain to find its
*import's* retained source with no check on the *body* itself — so a primitive added after a STEP
import was indistinguishable from a real STEP-sourced body, and would have silently resolved to
the STEP file's source bytes at that primitive's `solidIndex` (a nonsensical/wrong solid, or a
crash if the index was out of range). This exact bug is what first surfaced as `ExportService`'s
"skipped" list staying empty for a primitive that should have been excluded — traced via a
`nodeId`/`hasStepSource` check by hand, then fixed properly rather than patched around locally,
since `FilletChamferToolService.resolveTargetBody` and `SketchService.resolveCutTarget` had the
identical latent bug (never triggered end-to-end before, since nobody had tried Fillet/Chamfer-ing
a primitive sitting under an imported assembly's node until this pass's testing incidentally set
that scene up).

**Fix:** new `TreeNode.hasStepSource: boolean`, true only for bodies registered straight from
`Viewport.addLoadedBodies` (the STEP-import path, the only caller that now passes
`registerBody(body, true)`) — every other `registerBody` call site (`PrimitiveToolService`,
`SketchService`'s non-replace path, `Viewport.contextMenuDuplicate`) keeps the default `false`.
`TreeService.replaceBody` (used by both the cut-into-existing-body path and Fillet/Chamfer) always
resets it to `false` on replacement — a filleted/cut body's `solidIndex` no longer corresponds to
the original untouched STEP solid at that index, so a *second* Fillet/Chamfer or a later export
must not treat it as STEP-sourced again. `getImportSource` now checks the body node's own
`hasStepSource` before climbing to the import at all, so this fix applies uniformly to every
caller (`ExportService`, `SketchService`, `FilletChamferToolService`) with no per-caller special
casing needed.

**UI**: two new File-menu items next to "Open STEP…" (`Export STEP…`, `Export STL…`), matching the
menu-bar-item convention every other File action already uses — no new ribbon/panel chrome. A
plain `alert()` reports outcomes (nothing-to-export, partial-export with the skipped-body list, or
a hard failure), matching the existing `showAbout`/`showShortcuts` one-off-dialog convention
rather than introducing a new dialog component. `AppChrome.exportBusy` is a simple boolean guard
(not a signal — there's no visible in-progress UI for this one-shot menu action, unlike
Fillet/Chamfer's panel) preventing a double-click from spinning up two overlapping worker
instances.

**Deliberately not done / open for a future pass**: no per-part export (always exports every
loaded/visible body), no IGES/OBJ/glTF, no export of the structural (FEA) model, and — per the
still-open "parametric feature tree" gap — no way to re-import an exported STEP file and continue
editing it with its Fillet/Chamfer history intact (re-opening it is a fresh import like any other
STEP file, with no memory of how it was produced).

**Verified end-to-end via Playwright against the running dev server**: nothing-loaded export shows
the correct warning with no crash; full 17-body STEP export produces a valid file (confirmed via
direct byte inspection — correct `ISO-10303-21` header, exactly 17 `MANIFOLD_SOLID_BREP` entities);
full-assembly STL export produces a valid binary STL (exact expected file size for its triangle
count, computed independently); adding a primitive then exporting STEP correctly shows "Exported
17 of 18 bodies... Skipped: Box" and the file still contains exactly 17 solids (Box correctly
excluded); STL export of that same 18-body scene correctly includes the Box (triangle count
increases by exactly the box's 12 triangles); Fillet/Chamfer on a real STEP-sourced edge re-tested
after the `hasStepSource` fix and confirmed still working with zero regressions; zero console
errors throughout. Cold-start OCCT WASM init (a fresh worker's first STEP re-read) reliably takes
30-40+ seconds under sandboxed test conditions — not a bug, but worth knowing if a future
verification pass's own timeout looks like a hang.

## Future roadmap (as of 2026-08-17, §2 refreshed 2026-09-13) — full gap list against a professional 3D mechanical CAD suite

A full capability audit was run against everything a professional 3D mechanical CAD product
(SolidWorks/Fusion 360/Onshape/NX/Creo-class) actually ships — not just core solid modeling, but
every functional domain a full suite covers. This section is the complete list of what's missing,
organized by domain, kept here so future planning starts from this list rather than re-deriving it
from scratch. Items already shipped (see the dated entries above) are not repeated here. §2 (Solid
modeling features) was re-audited and edited in place on 2026-09-13 after Sweep/Loft/Draft all
shipped since this list was first written — the other sections (§1, §3–§15) still reflect their
original 2026-08-17 audit and may also be stale in the same way; treat every item here as
"probably still true" rather than "confirmed current" until it's re-checked the same way §2 was.

**Root-cause note, read this first:** most of the gaps in Sketch/2D, Solid Features, Assembly, 2D
Drawings, and Data/Persistence below trace back to one missing piece — **there is no parametric
feature history tree** (§7 in the list below). Patterns, mates, drawings, and configuration tables
all need something to reference and re-drive a feature after the fact, and there is currently
nothing to point at. Building the feature tree is very likely the highest-leverage single piece of
future work, even though it's also the largest/riskiest (needs a worker-side shape-history
redesign — deferred GPU disposal, a persistent OCCT document across features, not a quick add).

### 1. Sketch & 2D geometry
- Freeform line/polyline drawing (today: only fixed 2-click rectangle/circle/polygon/slot)
- Spline/bezier curves
- Ellipse
- Arc (tangent / 3-point / centerpoint) — only full circles exist today
- Construction/centerline geometry (non-solid reference entities inside a sketch)
- Sketch-level 2D corner fillet/chamfer (distinct from the 3D edge Fillet/Chamfer that exists)
- Trim / extend / offset sketch entities
- Mirror sketch entities
- Geometric constraints: coincident, parallel, perpendicular, tangent, horizontal, vertical,
  concentric, equal, symmetric, fixed
- Numeric/editable sketch dimensions (type a value, geometry updates)
- Fully-defined / under-defined sketch state indication (needs a constraint solver first)
- Live dimension preview while drawing
- User-toggled "convert edge to sketch reference" (references today are auto-populated,
  read-only — explicitly deferred in the 2026-08-06 face-sketch pass)

### 2. Solid modeling features (re-audited 2026-09-13 after Sweep/Loft/Draft shipped)
- Revolve/Sweep/Loft into/against an existing part (cut or boss-{revolve,sweep,loft}, each
  needing a `targetBody` STEP-source re-read the way Fillet/Chamfer/Shell/Hole-Wizard/Draft
  already have) — today, since 2026-09-10/09-11/09-13 respectively: Revolve, Sweep, and Loft all
  exist for a standalone new body only, never cutting into or fusing onto an existing part (see
  each one's own dated entry)
- Revolving around a separately-drawn axis line (today: only the sketch plane's own U/V axis —
  see the 2026-09-10 Revolve dated entry)
- Sweep along a curved path — a picked edge or a second path sketch (today, since 2026-09-11:
  Sweep is straight-line-only, tilted away from the sketch plane's own normal — see that dated
  entry)
- Loft guide curves and closed loops (blending the last profile back to the first, e.g. a
  torus-like shape) — today, since 2026-09-13: Loft blends straight through 2+ profiles in order,
  no guide rail, no closing the loop — see that dated entry
- Extrude options: up-to-surface, up-to-body, mid-plane (today: fixed numeric depth only)
- Radius that continuously tapers along a single edge (today, since 2026-09-14: Fillet/Chamfer
  supports per-edge values in a multi-edge operation — different edges can each have their own
  radius/distance — see that dated entry; no single edge's own radius can vary along its length)
- Face fillet / full-round fillet
- Variable wall thickness (today, since 2026-09-10: Shell exists — one uniform thickness per
  operation, STEP-imported bodies only — see that dated entry)
- User-picked Draft pull direction and/or neutral plane, and per-face draft angle (today, since
  2026-09-11: Draft exists — fixed world +Z pull direction, one shared angle across all picked
  faces, STEP-imported bodies only — see that dated entry)
- Rib
- Hole Wizard counterbore/countersink and tapped/threaded holes (today, since 2026-08-25: standard
  metric/inch clearance-hole through-hole presets exist — see that dated entry — but counterbore/
  countersink need a second cut into the same body, which the cut pipeline can't do yet; tapped
  holes need thread modeling, which doesn't exist anywhere in this app)
- Mirror across an offset/angled custom plane or a picked face (today, since 2026-08-24: Mirror
  exists but only across the 3 fixed global datum planes — see that dated entry)
- Pattern along curve / fill pattern
- Direct "combine body A with body B" boolean tool (today: only reachable indirectly through
  sketch/extrude's boss-or-cut against one target body)
- Direct-edit / push-pull on existing faces

### 3. Surfacing (entirely absent as a discipline)
- Extruded / revolved / swept / lofted surfaces (non-solid equivalents of §2's features)
- Boundary / fill surface
- Offset surface
- Knit surfaces into a solid
- Trim / untrim surface
- (Bridge Mesh, which already exists, is a display-only visual overlay between two picked
  faces — not a selectable/measurable/exportable surface feature; noted here as the closest
  existing capability, not a substitute for real surfacing tools)

### 4. Assembly
- Mate types: coincident, concentric, distance/angle, gear/cam/belt/rack-pinion
- Degrees-of-freedom indicator (needs mates to exist first)
- Interference / collision detection
- Motion study / mechanism simulation (needs mates first)
- Sub-assemblies (nested groups) — today's tree is a fixed Assembly → Import → Body depth
- Bill of Materials (BOM)
- Component patterning (pattern a whole part N times in assembly context)
- Flexible/rigid sub-component states
- True side-by-side multi-file "Import" UI, distinct from "Open" (today: opening a second STEP
  file always replaces the scene; `TreeService.registerImport` already supports appending
  internally, but no UI action exposes it — see the 2026-08-13 dated entry)

### 5. Reference geometry
- User-defined angled/tilted or 3-point-defined reference planes (today, since 2026-09-10:
  user-defined OFFSET reference planes exist — offset from a datum or a picked face, named,
  persisted, selectable as a Sketch target — see that dated entry; no rotation/tilt or
  arbitrary-3-point definition yet)
- Reference axis (today: only the implicit world X/Y/Z)
- Reference point (today's snap-reference points are transient, sketching-only)
- User-relocatable coordinate system (today: one fixed world origin/orientation)

### 6. Viewport & interaction
- Box-select / lasso-select — box-select was built once, then removed after user feedback (see
  the 2026-08-07 dated entry); if revisited, don't default to "any left-drag on empty space"
- Snap-to-grid UI for the transform gizmo (`TransformControls` already supports
  `setTranslationSnap`/`setRotationSnap`/`setScaleSnap`; no UI wires it up)
- Arbitrary-angle section plane (today: axis-aligned X/Y/Z only)
- Hidden-line-removed display mode
- Undo/redo for delete and every geometry-creating operation (STEP import, sketch/extrude,
  primitive creation, Fillet/Chamfer) — needs the same deferred-disposal/worker-side
  shape-history design the feature tree (§ above) needs, flagged as a shared prerequisite since
  2026-07-31

### 7. Inspection & documentation
- Angle measurement
- Radius / diameter measurement
- Face-to-face / edge-to-face distance (Distance tool is point-to-point only)
- Mass / center of gravity / moment of inertia (density-driven — today's Volume/Surface Area are
  geometric only, no material density model to compute real mass)
- Material assignment / library (today: color + opacity only, no material presets like
  steel/aluminum/plastic)
- Appearance / texture mapping
- **Parametric feature history tree** — the single largest gap; see the root-cause note above
- Roll-back bar / suppress feature (needs the feature tree to exist first)

### 8. 2D drawings & documentation output (entirely absent)
- 2D drawing sheet / view generation — no drawing document type exists at all
- Orthographic / section / detail / auxiliary drawing views
- Model-driven drawing dimensions
- GD&T annotation (datums, feature control frames)
- Title blocks / drawing templates
- BOM table on a drawing
- Balloon / item-number callouts

### 9. Data, import/export, persistence
- IGES / Parasolid / SAT import
- Native-format import (SLDPRT, F3D, etc.)
- Mesh import (OBJ/STL as an input format — STL exists only as an export format today)
- IGES / OBJ / glTF export (STEP and STL are the only export formats today — see the 2026-08-17
  entry above)
- Project save / re-openable working session — export produces a model file, not a resumable
  session; no project-file concept exists
- Auto-save / crash recovery — closing/reloading the tab loses all in-session work with no prompt
- Design tables / configurations (part variants)

### 10. Simulation & analysis
- Solid-body FEA — stress/strain/displacement on 3D solids; a materially different and much
  larger capability than the beam/frame linear-elastic solver that already exists (§7 in the
  "Feature work" entries above)
- Thermal analysis
- Modal / vibration / fatigue analysis
- Nonlinear / dynamic analysis
- Motion / kinematic simulation (needs assembly mates, §4, first)
- Tolerance / stack-up analysis
- CFD (flow simulation) — a different product tier even inside most professional CAD suites,
  usually a separate specialized add-on

### 11. Manufacturing (entirely absent — different product tier even in full CAD suites)
- CAM / toolpath generation
- 3D-print prep (supports, orientation, slicing) — STL export is the current handoff point to an
  external slicer
- Mold/die design (core-cavity split, draft check, shrinkage)
- Nesting / material-utilization tools

### 12. Sheet metal & weldments (entirely absent)
- Sheet metal features (base flange, edge flange, hem, bend)
- Flat-pattern / bend-table export
- Weldment structural-member tool — a profile-library-driven modeled solid frame, distinct from
  the analytical line-element beam members the structural (FEA) workflow already has
- Weld bead / cut-list documentation

### 13. Visualization & rendering
- Photorealistic / path-traced rendering
- Material/appearance library with PBR textures
- Animation / walkthrough export/recording (the exploded-view slider is interactive-only today,
  not recordable to video/GIF)

### 14. PDM / PLM / collaboration
- Revision / version control
- Check-in/check-out, file locking — a different product tier: this app is explicitly
  client-side-only with no backend, so this needs a server component to exist first
- Real-time multi-user co-editing — same reason
- Approval / release workflow
- Where-used / dependency tracking

### 15. Automation, scripting & extensibility (entirely absent)
- Macro recording / scripting API
- Third-party plugin ecosystem
- Design-table / spreadsheet-driven parametrics (overlaps §4/§9's design-table entries — needs
  the feature tree regardless)

**How to use this list:** when picking up new feature work on this project, treat §1–§9 as the
"same product tier" backlog — genuinely expected of a browser CAD/solid-modeling tool and worth
prioritizing by real mechanical-design-workflow frequency (patterns and Hole Wizard are
historically higher-value quick wins; the feature tree is the highest-leverage but largest single
effort). Treat §10–§15 as adjacent-product-category work — real, but each is close to its own
separate product even in incumbent CAD suites, and shouldn't be picked up opportunistically without
an explicit scoping conversation first.

## Feature work (2026-08-24) — Linear/Circular Pattern, plus a real empty-scene tree bug fix

Per this roadmap's own "how to use this list" guidance above (§2, flagged alongside Hole Wizard as
a high-value quick win), implemented Linear and Circular Pattern: array-copy an existing body along
a direction or around an axis.

**Design decision: no worker/OCCT round-trip, unlike Fillet/Chamfer.** A pattern is a rigid-body
duplication, not a topology change — new `PatternToolService` extends `Viewport.
contextMenuDuplicate`'s existing shape (shared immutable geometry reference, cloned material)
directly rather than following `FilletChamferToolService`'s STEP-source-re-read pattern. Practical
consequence: unlike Fillet/Chamfer (STEP-imported bodies only), Pattern works uniformly on **any**
body regardless of origin — STEP-imported, sketch-extruded, primitive, or already-filleted/
patterned — since there's no STEP source to gate it on.

**Not wired into `ToolService`'s click-driven interaction shape**, even though it gets an
`ActiveTool` value (`'pattern'`) purely to reuse `ToolPanels`' existing open/close/dock machinery.
Sketch/BridgeMesh/Fillet-Chamfer all need a viewport picking phase before their panel is useful;
Pattern needs only a target body (read once from `SelectionService` when the tool activates,
deliberately not read live thereafter, so a stray selection change can't retarget a half-configured
pattern) and numeric fields, so it's driven entirely by the panel — the same "selection-gated"
shape `AppChrome`'s Transform (Move/Rotate/Scale) ribbon buttons already use (`hasSelection()`-
gated), just also getting its own dockable panel like the click-driven tools.

**Undoable as a single step, unlike Fillet/Chamfer/sketch-extrude/primitive creation.** Because
this is pure tree/mesh registration with no OCCT/GPU-disposal involvement, all `count - 1` copies
from one Apply are registered inside one `HistoryService.run()` call — undo removes every copy in
one step, redo restores all of them, matching how the section-offset slider coalesces a whole drag
into one entry rather than one per tick. This does NOT extend the documented delete/geometry-
creation undo gap (still open since 2026-07-31) — Pattern was never inside that gap to begin with.

**Bug found and fixed while verifying this end-to-end: registering a body before any STEP import
ever ran left it invisible in the model tree.** `TreeService.registerBody` has always parented new
body nodes under `this.importId` — populated by `registerImport`, `null` at construction/`reset()`.
Before this fix, `registerBody(body)` with `importId === null` called `findNode(clone, this.
importId!)`, which resolves to `findNode(clone, null)` and matches nothing, so `importNode?.
children.push(node)` was a silent no-op: the mesh was added to the 3D scene and `nodeIdToBody`/
`meshToNodeId` were populated correctly (so the status bar's body count and the 3D view were both
right), but the tree's `nodes` signal never gained a row for it — the body was unselectable via the
tree and had no visibility/delete/rename affordances. This bug predates Pattern (it affects
`PrimitiveToolService`, `SketchService`, and `Viewport.contextMenuDuplicate` identically) but had
never been reachable/noticed before: every previous manual/Playwright verification pass happened
to create a primitive or sketch body only *after* a STEP import had already run in the same
session (which sets `importId`), and the 2026-08-13 "no auto-load" pass is what first made a truly
empty starting scene the default, so "primitive/sketch as the very first action" only recently
became a real user path.

Fix: new private `TreeService.ensureRoot()`, called from `registerBody` when `importId` is still
`null` — lazily creates an assembly root plus one import-less "Modeling" import node to parent
standalone bodies under, mirroring `registerImport`'s own root-creation branch minus a real STEP
source (so `getImportSource`/`hasStepSource` correctly still report "no source" for anything
registered under it — consistent with every non-STEP-import caller already passing `hasStepSource:
false`). `registerImport` itself is unchanged; a STEP import happening after some standalone bodies
already exist still appends as a sibling `import` node under the same assembly root exactly as
before.

**UI**: new "Pattern" ribbon button in the existing "Features" group next to "Fillet / Chamfer"
(`app-chrome.html/ts`), gated on `hasSelection()`; new panel in `tool-panels.html/css/ts` (Linear/
Circular kind toggle, axis/direction select, spacing-or-total-angle field depending on kind, count
field inclusive of the original, Apply button) — same drag/dock machinery every other panel already
has. New `ToolPanelId` entry `'pattern'` in `panel-layout.model.ts`/`panel-layout.service.ts`.

**Circular pattern angle convention**: a full 360° sweep divides evenly by `count` (so the last
copy doesn't land back on the original); a partial sweep divides by `count - 1` (so the last copy
lands exactly at the configured angle) — matches mainstream CAD circular-pattern behavior for the
two cases, and is the one piece of this feature with real geometric-convention judgment involved.

**Deliberately not done / open for a future pass**: pattern-along-curve, fill/rectangular-grid (2D)
patterns, pattern-driven-by-an-existing-pattern (patterning a pattern's own output works today
since it's just "any body," but there's no notion of a pattern *instance group* to re-edit as one
unit afterward), and skip-instance (omit specific positions from the array) — all deferred as
smaller follow-on scope, not needed to ship the core linear/circular capability. Also still open:
the same "parametric feature tree" gap noted throughout this roadmap — a pattern here is a one-time
array-copy, not a re-drivable feature that updates if the source body later changes.

**Verified end-to-end via Playwright against the running dev server** (`ng build` still fails on
the same pre-existing, unrelated `opencascade.js`/esbuild `fs`-resolution error confirmed unchanged
by this pass): primitive box created as the very first action in an empty scene now correctly shows
up in the tree (bug fix confirmed — previously the tree stayed empty while the status bar/3D view
both showed 1 body); Pattern button correctly enabled only once a body is selected; linear pattern
of 4 produces exactly 4 bodies; undo removes all 3 copies in one step back to 1, redo restores all 3
back to 4 in one step; circular pattern of 6 applied on top of that (re-opening the tool re-
snapshots the then-current selection as target) correctly produces 9 total; a separate 8-instance
360° circular pattern screenshot-confirmed fanning out around the origin with correctly-labeled
tree entries ("Box (Pattern 2)" … "Box (Pattern 8)"); Fillet/Chamfer panel opens/closes normally
afterward with zero regressions; zero console errors throughout.

## Feature work (2026-08-24) — Mirror, plus a pre-existing ribbon-group overlap bug fix

Per this session's own instruction to read this file first and pick the next item off the roadmap's
priority list (§2, "Mirror feature" — explicitly missing, pairs naturally with the just-shipped
Pattern), implemented Mirror: reflects an existing body across a fixed global datum plane (XY/YZ/
XZ, through the world origin), adding one reflected copy and leaving the original untouched.

**Design decision: built as Pattern's direct sibling, not Fillet/Chamfer's.** Same reasoning as the
2026-08-24 Pattern entry above — a mirror is a rigid-body transform, not a topology change, so
`MirrorToolService` copies `PatternToolService`'s exact shape: shared immutable geometry reference,
cloned material, no OCCT/worker round-trip, one `HistoryService.run()` entry per Apply (undo/redo
the copy as a single step), and a selection-gated panel (`ActiveTool: 'mirror'`, snapshotted target
body read once at activation, no viewport click phase) rather than `FilletChamferToolService`'s
click-to-pick/STEP-source-re-read shape. Practical consequence, same as Pattern: Mirror works on
**any** body regardless of origin (STEP-imported, sketch-extruded, primitive, fillet/chamfered, or
already-patterned/mirrored) — there's no STEP source to gate it on.

**The reflection itself is a negative-determinant scale, not a geometry-buffer edit.** Position is
reflected through the plane (component along the plane's normal negated, since all three datum
planes pass through the world origin); orientation/scale is reflected by negating whichever local
axis (after the mesh's own rotation) points most nearly along the world-space mirror normal
(`worldNormalToDominantLocalAxis`, new in `mirror-tool.service.ts`). This is the same "mirror via
negative scale" technique every mainstream 3D engine uses — three.js's renderer automatically flips
triangle winding whenever a mesh's world matrix has negative determinant, so front-facing normals
stay correct with **no need to clone or edit the shared geometry buffer**, consistent with how
Pattern also never mutates the geometry it shares with the original. Verified visually via
Playwright screenshot: an 80×40×20mm box mirrored across YZ (X=0) landed with a fully mirrored
bounding box on the opposite side of the origin, correctly solid-shaded with no inside-out/flipped-
normal artifacts; mirroring the same box across XY and XZ in sequence (3 bodies total) also
rendered correctly with zero console errors. **Known limitation, noted in the new service's own
docstring rather than silently assumed away:** the dominant-local-axis approach is exact for
axis-aligned/unrotated bodies (the common case, and the only case exercised by today's UI, since
nothing yet rotates a body before offering Mirror as a next step other than the general-purpose
Rotate gizmo) but is an approximation — not an exact oblique reflection — for a body already
rotated to an arbitrary, non-axis-aligned orientation. A future pass wanting exact-for-any-rotation
mirroring would need to decompose the reflection as a proper Householder matrix rather than a
per-local-axis scale flip; not needed for v1 per the same "don't build past what today's UI actually
exercises" judgment call `IDLE_MIRROR_TOOL`'s dropped `keepOriginal` field (considered, then removed
as speculative) also reflects.

**Scoped down from a full face-pick mirror plane, deliberately.** Sketch's face-pick machinery
(`getFacePlane`/camera auto-orient/reference points) was available to reuse, but Mirror v1 only
offers the 3 fixed datum planes — the same convention Sketch's own datum option, Section, and now
Mirror all share (`DATUM_NORMALS`, duplicated locally in `mirror-tool.service.ts` rather than
importing `SketchService`'s private, unexported copy — matching how `PatternToolService` already
keeps its own `AXIS_VECTORS` rather than reaching into another tool's internals). An offset/
arbitrary-angle or face-derived mirror plane is a real, still-open gap (folds into the roadmap's
existing §5 "user-defined offset/angled reference planes" and §2 "Mirror" entries, now partially
addressed) but wasn't needed to ship the core reflect-across-a-global-plane capability, matching how
Pattern shipped axis-aligned-only before this pass too.

**Real bug found and fixed while wiring up the 9th ribbon button: `.ribbon-group` had no
`flex-shrink`/intrinsic-width floor, so a crowded ribbon row silently overlapped instead of
overflowing.** `.ribbon` already had `overflow-x: auto` for genuine overflow, but `.ribbon-group`
(the Selection/Transform/.../Features/... columns) had only `min-width: 110px` with default flex
shrink behavior — once total content (11 groups, several holding 2-4 buttons each) exceeded the
ribbon's available width, flex's default "shrink siblings to fit" behavior compressed a group's own
box *narrower than its buttons' actual rendered width* instead of leaving it full width and letting
the row overflow/scroll as a unit. The buttons visually escaped their own group's box into the
neighboring group's screen space — confirmed via direct Playwright bounding-box measurement before
the fix (`Features` group box measured 127px wide while its 3 buttons rendered across ~222px,
letting `Mirror`'s clickable area bleed ~44px into `Structural`'s box and swallow clicks meant for
it: `Add Node` intercepted every attempted `Mirror` click in initial verification, a real,
user-facing hit-testing bug, not just a visual overlap). This was already latent with 8 buttons
across the existing 11 groups before this pass (Features held Fillet/Chamfer + Pattern, right at
the edge) — adding Mirror as a 3rd button in that same group is what pushed it from
"visually tight" to "functionally overlapping and un-clickable," which is how it was caught.

**Fix:** `.ribbon-group` (`app-chrome.css`) gained `flex-shrink: 0; width: max-content;` — a group
now always renders at its true content width; the ribbon's pre-existing `overflow-x: auto` handles
the resulting (correct, expected) horizontal scroll once total content exceeds the viewport, the
same way a real CAD tool's ribbon scrolls/overflows rather than compressing buttons into each other.
Verified via the same bounding-box measurement technique: post-fix, every group's box matches its
content width exactly and no two groups' boxes overlap, confirmed at 1280px width (11 groups now
total ~1682px, correctly scrollable) — re-ran the full Mirror verification afterward with the click
landing correctly on the first try.

**UI**: new "Mirror" ribbon button in the existing "Features" group next to "Pattern"
(`app-chrome.html/ts`), gated on `hasSelection()` exactly like Pattern; new panel in
`tool-panels.html/css/ts` (plane select XY/YZ/XZ, target-name hint, Apply button) — same drag/dock
machinery every other panel already has, cloned from Pattern's own panel markup/CSS. New
`ToolPanelId` entry `'mirror'` in `panel-layout.model.ts`/`panel-layout.service.ts`. No keyboard
shortcut, matching Pattern's own precedent (a selection-gated panel tool, not a click-driven one —
see the 2026-08-07 keyboard-shortcuts entry for which tools got dedicated keys and why).

**Deliberately not done / open for a future pass**: mirroring across a picked face or an
offset/angled custom plane (see the scoping note above), a "mirror the whole feature" concept tied
to the still-open parametric feature tree gap (today's Mirror, like Pattern, is a one-time reflected
copy — it doesn't stay linked to the original if the original later changes), and exact-for-any-
rotation reflection math (see the known-limitation note above). Also still open: every item the
roadmap's own root-cause note already explains (feature tree) plus everything else still listed
under §1-§15 that this pass didn't touch.

**Verified end-to-end via Playwright against the running dev server**: primitive box created as the
first action, selected via the tree, Mirror button correctly enabled only once selected and
disabled again after Escape-clearing selection; Mirror panel opens showing the correct target name,
plane select works, Apply creates exactly one new tree row named "Box (Mirror)" and auto-closes the
panel; undo removes it in one step, redo restores it in one step; visual screenshot confirms a
correctly-reflected, correctly-shaded copy across YZ, then XY and XZ in sequence (3 bodies, zero
console errors); Pattern/Fillet-Chamfer/Sketch panels all confirmed opening normally afterward with
zero regressions. `ng build` was not re-attempted (same pre-existing, unrelated `opencascade.js`/
esbuild gap noted in every prior pass); `npx tsc --noEmit` passed cleanly both before and after the
ribbon CSS fix.

## Feature work (2026-08-25) — Hole Wizard (through-holes only), scoped down after a real blocker found in the cut pipeline

Per the roadmap's own "how to use this list" guidance (§2, Hole Wizard named alongside Pattern as a
historically high-value quick win), started implementing Hole Wizard. Before writing code, traced
the existing cut pipeline (`SketchService.finishAndExtrude` → `ModelingSessionService.extrude` →
`handleFeatureExtrude`) to check whether counterbore/countersink (which need TWO sequential cuts
into the same body — a through-bore plus a shallower, wider counterbore/countersink recess) were
buildable, and found a real, pre-existing blocker: a `targetBody` cut always re-reads from the
body's **original raw STEP bytes** (`FeatureCutTarget.bytes`), never from the result of a prior cut,
and `TreeService.replaceBody` clears `hasStepSource` to `false` on the body's node the moment it's
cut once (see the 2026-08-17 export-bug-fix entry above for why that flag exists). So a *second*
targeted cut into an already-cut body doesn't compound — it silently degrades to "no retained STEP
source," the exact same limitation `SketchService`'s own docstring and the user manual §5.1 already
document for cutting into a sketch/primitive-created body, just newly discovered to also apply to
cutting into a body that's already been cut once via any path. Surfaced this to the user before
scoping rather than building counterbore/countersink and finding out it silently didn't work; the
user chose **through-holes only for v1**, with counterbore/countersink deferred as a named follow-on
that needs the deeper fix (chaining a cut against an evolving in-worker shape, not raw re-read
bytes) first.

**Design decision: new `HoleWizardService`, not a driver of `SketchService`'s own state machine.**
`SketchService`'s phases (`picking-plane` → `picking-face` → `drawing` → extrude) are shaped around
interactive 2-click freeform profile drawing, not a single preset-driven placement — forcing Hole
Wizard through that machinery would mean either widening `SketchState` with hole-specific fields it
doesn't otherwise need, or faking two clicks per hole. Instead, `HoleWizardService` is its own
service with its own two-phase state (`picking-face` → `picking-point` → `configuring`), directly
reusing the same already-proven, already-decoupled pieces `SketchService`'s face-pick phase uses:
`face-geometry.util.ts`'s `getFacePlane`/`extractFaceReferencePoints`/`pickUAxis` (zero-OCCT-
round-trip face-plane resolution, identical to Sketch's own Phase-1 approach from the 2026-08-06
face-sketch pass), `SketchRendererService` for the face highlight/reference-point markers/live
circle preview (already scene-agnostic by its own docstring, and already builds a preview from an
arbitrary `SketchEntity` list — a hole's preset-sized circle needed zero renderer changes), and
`ModelingSessionService.commitSketch`/`.extrude(cut: true, targetBody)` — the exact same two worker
calls `SketchService.finishAndExtrude` makes internally, just with a circle entity built from a
preset diameter instead of two freeform clicks. `HoleWizardService.replaceBodyInScene`/
`resolveCutTarget` are small local duplicates of `SketchService`'s equivalents (same STEP-source
re-read, same dispose/select-clear/replace-in-place sequence) rather than reaching into
`SketchService`'s private internals — the same "duplicate a small helper locally" precedent
`FilletChamferToolService` already established for its own `resolveTargetBody`/
`replaceBodyInScene`, chosen over a shared-utility refactor to avoid touching `SketchService`'s
proven code for a feature that doesn't need to change it.

**No OCCT/worker changes at all.** Every worker-side request type (`sketch.commit`, `feature.
extrude`) and message shape (`PlaneRef`, `SketchEntity`, `FeatureCutTarget`) was already exactly
what Hole Wizard needed — a circle `SketchEntity` at a preset radius, on a `PlaneRef` of kind
`'face'` built the identical way Sketch's own face-pick phase builds one. This is the payoff of
scoping down to through-holes only: a compound counterbore/countersink tool solid would have needed
new worker-side geometry (two coaxial prisms of different radii, or two sequential cuts against an
evolving shape); a single circular cut needed none.

**Fastener size presets** (`models/hole-wizard.model.ts`): `METRIC_HOLE_PRESETS` (M3–M12, ISO 273
clearance-hole diameters) and `INCH_HOLE_PRESETS` (#4-40 through 3/8-16, ANSI B18.2.8 clearance
diameters converted to mm since the app's units are fixed at mm throughout), each with close/
normal/loose fit classes — the same three-tier clearance convention SolidWorks/Fusion's own Hole
Wizard metric presets use, rather than a single fixed diameter per size. `HoleWizardService.
currentDiameter()` reads the active `{standard, presetIndex, fit}` combination; changing any one of
the three live-updates the preview circle via `SketchRendererService.showPreview` (reusing the same
technique `Viewport`'s own sketch live-preview already established) before the user commits.

**Through-hole depth is computed automatically, not asked of the user.** Unlike `SketchService`'s
generic Sketch tool (where the user types a Depth in mm and the manual's own guidance tells them to
overshoot the part's thickness manually — see §5.1 Example B), `HoleWizardService.commit` derives
depth from the target body's own bounding-box diagonal (`Math.max(size.x, size.y, size.z) * 1.25`)
so a through-hole reliably punches all the way through regardless of the picked face's local
thickness, with no user-guessed number and no risk of a too-shallow cut. This relies on the
worker's existing "extrude the tool solid symmetrically both directions from the sketch plane"
construction (the 2026-08-06 cut-direction bug fix) — the same mechanism that already guarantees a
cut punches through regardless of face-normal direction now also means overshooting the depth on
either side is safe, not just tolerated.

**Verified end-to-end via Playwright against the running dev server**, using the bundled sample
STEP file (`DM556MotorDriverAssembly.STEP`, 17 bodies) since Hole Wizard requires a real
`hasStepSource` body: face pick → point pick (with live snap-indicator against the face's own
reference points, identical mechanism to Sketch) → preset/fit changes correctly update the shown
diameter (6.60mm at the M6/normal default → 9.00mm on switching to M8) → Apply → panel auto-closes →
body count stays at 17 (replaced in place, not appended). **Rigorously confirmed the cut actually
removed material** (not a silent no-op, the same class of bug the 2026-08-06 cut-direction fix
caught) by reading the target body's Volume property before and after via the Properties panel: an
M12-diameter (13.50mm) through-hole reduced Body 1's volume from 4,955,011.65 mm³ to 4,954,295.96
mm³ — a 715.69 mm³ reduction, matching the expected math for a clean through-cut (π×6.75² × ~5.0mm
of local wall thickness) almost exactly, confirming a genuine full-depth cut rather than a
symmetric-tool near-miss or a shallow scratch. Zero console errors throughout; Pattern/Mirror/
Fillet-Chamfer/Sketch panels all confirmed opening and closing normally afterward with zero
regressions, and the ribbon (now 4 buttons in the Features group) still renders with no overlap,
confirming the 2026-08-24 `.ribbon-group` fix holds at this button count too.

**Deliberately not done / open for a future pass**: counterbore and countersink (the actual reason
this pass started — see the blocker note above; needs the cut pipeline to support a second cut
against an evolving shape rather than always re-reading raw STEP bytes), tapped/threaded holes (no
thread modeling exists anywhere in this app), a bolt-pattern/multi-hole-at-once mode (today: one
hole per Apply — chain with Pattern for repeated holes, though pattern-then-hole-wizard and
hole-wizard-then-pattern both still only produce independent, non-linked copies per the existing
Pattern limitations), and re-editing a placed hole's size after the fact (falls under the still-open
parametric feature tree gap, same as every other feature in this app). Also still scoped out, same
as `SketchService`'s own cut path: Hole Wizard only works on STEP-imported, not-yet-cut bodies
(`hasStepSource: true`) — a sketch/primitive-created body, or a body already cut/filleted once,
surfaces a clear error rather than a silent failure.

## Planning note (2026-09-10) — capability estimate vs. a full professional CAD suite, and the phased roadmap to close it

The user asked how this project compares, in percentage terms, to a full professional 3D mechanical
CAD suite (SolidWorks/CATIA-class), and what to build next to close that gap toward full
equivalence. Recorded here since it's a planning artifact the next several passes should be picked
from, the same way the 2026-08-17 roadmap and its "how to use this list" guidance already work —
this note supersedes neither, it prioritizes within it.

**Honest framing given first, before any number:** 100% functional equivalence to SolidWorks/CATIA
is not a realistic target for this codebase — those are commercial products built by hundreds of
engineers over 20-30 years, with proprietary geometry kernels, licensed fastener/standards
libraries, and entire adjacent subsystems (PDM, CAM, full simulation suites) that are separate paid
products even for their own vendors. The estimate below is deliberately given as a range with the
reasoning shown, not a single fake-precise figure.

**Per-domain estimate, using this file's own §1-15 gap list as source of truth (not re-derived):**

| Domain | Coverage | Why |
|---|---|---|
| Viewport/navigation | ~90% | Orbit/pan/zoom, view presets, nav cube, ortho/perspective, shading, section planes — professional-grade already |
| Selection & interaction | ~85% | Multi-select, transform gizmo, snapping, context menus, undo/redo w/ history dropdown |
| Basic solid modeling | ~35% | Extrude+cut solid; no Revolve/Sweep/Loft, no variable-radius fillet, no Shell/Draft |
| Sketching / 2D constraints | ~10% | Fixed-click shapes only, **no constraint solver, no editable dimensions, no freeform lines/splines** — the single biggest sketching gap |
| Feature-specific tools | ~30% | Fillet/Chamfer, Pattern, Mirror (datum-only), Hole Wizard (through-holes only) all shipped; no Shell/Draft/Rib/Sweep-based features |
| Parametric feature tree | **0%** | Every operation is final on Apply — no edit-after-the-fact, no suppress/roll-back. The deepest structural gap (root-cause note in the 2026-08-17 roadmap entry already called this out) |
| Assembly (mates/constraints) | **0%** | Parts positioned manually via the transform gizmo; no mates, no DOF tracking, no interference detection |
| 2D drawings/documentation | **0%** | No drawing-sheet document type, no GD&T, no BOM |
| Measurement/inspection | ~20% | Point-to-point distance only; no angle/radius/diameter/face-to-face |
| Import/export | ~25% | STEP+STL only; no IGES/Parasolid, no project save/resume |
| Simulation | Narrow but real | A genuine linear-elastic beam/frame FEA solver exists (§7 in the Feature-work entries) — a different discipline from solid-body stress/strain FEA, which is 0% |
| Manufacturing/sheet metal/PDM | **0%** | Entirely absent — a different product tier even inside real CAD suites, per §11-15 of the 2026-08-17 roadmap |

**Overall estimate: ~15-20%** weighted the way a mechanical designer actually uses a CAD tool
day-to-day (sketch → model → assemble → drawing → check) — dragged down almost entirely by the
three structural zeros (feature tree, assembly mates, 2D drawings), each of which is its own large
subsystem in a real CAD suite. Narrowed to just "interactive solid-modeling viewer with light
feature-modeling" (excluding assemblies/drawings/PDM entirely), coverage is closer to **50-60%** —
the viewport UX and the handful of shipped features are not toy implementations.

**Phased roadmap toward the realistic ceiling** (recorded as the priority order for future passes,
supplementing rather than replacing the 2026-08-17 roadmap's §1-15 list):

**Phase 1 — the three structural zeros (highest leverage, ~90% of the real gap):**
1. **Parametric feature tree** — redesign the worker session to keep a persistent OCCT document
   with a feature history instead of one accumulated shape; every feature becomes a re-editable
   node. Unlocks, as direct consequences: undo for geometry creation/deletion (open since
   2026-07-31), counterbore/countersink in Hole Wizard (blocked on this exact gap per the
   2026-08-25 entry above), and Pattern/Mirror instances that stay linked to their source instead
   of being one-time copies. Highest-leverage, largest-effort item on the entire list — most other
   Phase 1/2 items are better, some are only fully correct, once this exists.
2. **Sketch constraints and dimensions** — 2D constraint solver (coincident/parallel/perpendicular/
   tangent/horizontal/vertical/concentric/equal/symmetric/fixed), editable numeric dimensions,
   freeform line/polyline/arc/spline drawing (today: fixed-click rectangle/circle/polygon/slot
   only), fully-defined/under-defined sketch state indicator.
3. **Assembly mates** — coincident/concentric/distance/angle mates, per-part DOF tracking, basic
   interference/collision detection, real sub-assemblies (today's tree is a fixed 3-level
   Assembly→Import→Body depth).
4. **2D drawings** — a drawing-sheet document type distinct from the 3D model, orthographic/
   section/detail views generated from the model, model-driven dimensions, basic GD&T, title
   blocks, BOM table.

**Phase 2 — round out solid modeling (medium effort, high daily-use value):**
5. Revolve, Sweep, Loft — feature types beyond straight extrude.
6. Shell (hollow with wall thickness) and Draft (molding angle).
7. Counterbore/countersink/tapped holes in Hole Wizard — needs Phase 1 item 1 to support a second
   cut into the same body correctly (the exact blocker the 2026-08-25 entry scoped around).
8. Variable-radius and face fillets (today: one fixed radius per Fillet/Chamfer operation).
9. User-defined reference planes/axes (offset, angled, 3-point) — today: only the 3 fixed global
   datum planes plus face-picked planes.

**Phase 3 — inspection, materials, import/export:**
10. Angle, radius/diameter, face-to-face measurement (today: point-to-point distance only).
11. Material library + real density-driven mass/CG/moment-of-inertia (today: geometric
    Volume/Surface Area only).
12. IGES/Parasolid import, project save/resume (today: STEP/STL export only, no session
    persistence — closing the tab loses everything, per §3.11 in the user manual).

**Phase 4 — adjacent product tiers, each needing its own separate scoping conversation:**
13. Solid-body FEA (stress/strain on 3D parts — a different discipline from the existing beam/frame
    solver).
14. Sheet metal & weldments.
15. CAM/manufacturing prep.
16. PDM/version control/multi-user collaboration.

**The honest ceiling:** Phases 1-3 done well could realistically reach **~55-65%** functional
equivalence — a genuinely professional single-user parametric CAD tool, comparable to a mid-tier
product. Phase 4 and the remaining gap to 100% (photorealistic rendering, CAM, PDM, multi-CAD
interop, decades of accumulated edge-case robustness) are a different scale of effort than
incrementally extending this codebase can reach — recorded here so a future session doesn't
re-promise 100% equivalence as an achievable target.

**Status as of this note: planning only, nothing in this section has been implemented.** The next
feature pass should be picked from Phase 1 item 1 (parametric feature tree) if the user wants the
single highest-leverage change, or from Phase 2 (items 5-9) if a series of smaller, lower-risk wins
is preferred first — both are legitimate paths and the choice was left open pending the user's
direction, the same way Mirror vs. Hole Wizard vs. Shell was left open before the 2026-08-24/
2026-08-25 passes.

## Feature work (2026-09-10) — User-Defined Reference Planes, plus a real latent raycast bug found and fixed

Per the 2026-09-10 planning note above, the user chose a Phase 2 quick win over starting the
parametric feature tree. Of the three lowest-risk candidates offered (Shell, Revolve, user-defined
reference planes), the user picked reference planes — confirmed as lowest-risk before starting
because the worker's existing `PlaneRef` (kind `'face'`) already accepts an arbitrary origin/normal
with **zero opinion about where it came from** (`planeFromFace` in `step-loader.worker.ts` just
builds a `Geom_Plane` from whatever origin/normal/uAxis it's handed) — so this feature needed no
OCCT/worker changes at all, unlike Shell (`BRepOffsetAPI_MakeThickSolid`) or Revolve
(`BRepPrimAPI_MakeRevol`), both genuinely new OCCT primitives.

**Scoped to offset-only, per explicit user choice** (offered offset-only vs. offset+rotation vs.
3-point plane definition): pick a base — a fixed datum plane (XY/YZ/XZ) or a picked face on an
existing part — type an offset distance along its normal, optionally name it, Create. No tilt/
rotation, no 3-point definition; both remain open follow-ons (folds into the roadmap's existing §5
"user-defined offset/angled reference planes" entry, now partially addressed).

**New `ReferencePlaneService` — NOT stored in `TreeService`.** A reference plane has no solid
geometry to select/measure/export the way a `CadBody` does, so it doesn't belong in the model tree.
The precedent for "plane state that isn't a tree body" already existed in this codebase:
`SectionService`'s own per-axis clipping-plane config, which owns its own signal-based collection
with zero `TreeService` involvement. `ReferencePlaneService` follows that shape exactly — its own
`planes` signal (the persisted, named list) and `toolState` signal (the in-progress creation flow,
mirroring `PatternToolState`/`MirrorToolState`'s own IDLE_* snapshot-not-live-synced convention).
`resolveFrame(base, offset)` is the one function every consumer (live preview, stored-plane
rendering, Sketch) calls to turn a base+offset into a world-space `{origin, normal, uAxis, vAxis}`
frame — guaranteeing the preview and the committed result can never disagree, since both go through
the identical code path.

**New `ReferencePlaneRendererService`** mirrors `SketchRendererService`/`BridgeMeshRendererService`'s
own group-ownership shape: owns a `"ReferencePlaneOverlay"` scene group, draws one translucent quad
+ wireframe border per stored, visible plane (oriented via the frame's own `uAxis`/`vAxis`/`normal`
basis, not a `lookAt`, so the drawn edges align with what a sketch on that plane would actually use),
plus a live yellow preview quad while the creation tool is active (reruns via a new `Viewport`
`effect()` watching `ReferencePlaneService.toolState()`, rebuilt on every base/offset change — same
"cheap enough to fully rebuild, no diffing" tradeoff `SketchRendererService`'s own per-move preview
already makes, just firing far less often here since this only reacts to discrete picks/field edits,
not `pointermove`).

**`SketchService.beginFromCustomPlane(frame)`, new entry point, zero worker changes.** Converges on
the exact same `phase: 'drawing'` state shape `begin()`/`beginFromFace()` already produce, and posts
the identical `PlaneRef(kind: 'face')` wire format the worker already accepts — the worker has no
way to tell a picked-face plane from a reference plane apart, and doesn't need to. `pickedFace` is
left `null` (this is a standalone plane, not a face on an existing part), which correctly routes
`finishAndExtrude` to the same "no cut target, boss/fuse a fresh standalone body" path a datum-plane
sketch already takes — no new branching needed there either.

**UI:** new "Reference Plane" ribbon button in its own new "Reference Geometry" group (between
Features and Structural — the first new top-level ribbon group added since the original build,
everything since Fillet/Chamfer having slotted into an existing group), a floating/dockable panel
(pick base via datum buttons or a face click → offset/name fields → Create) reusing the same
drag/dock machinery every other panel already has, and a persisted list of created planes inside
that same panel (rename inline, toggle visibility, delete, and a "sketch on this plane" action that
jumps straight into Sketch's drawing phase — skipping the pick-a-plane step entirely, since the
plane is already resolved). New `ToolPanelId` entry `'referencePlane'`; `ActiveTool` entry
`'reference-plane'`, using the same "click a face clears stale selection" `ToolService.activate()`
branch Sketch/Fillet-Chamfer/Hole-Wizard already share.

**Real bug found and fixed during verification: `Ray.intersectPlane` returning `null` (a genuine
miss, not a degenerate zero-point) for a full class of camera angles this feature made newly
reachable, silently stranding the Primitive tool with no error.** Playwright testing the natural
next-step workflow — create a reference plane on YZ or XZ, click "Sketch on this plane" (which
calls `CameraService.animateToFace`, orienting the camera normal to the plane), cancel with Escape,
then place a Box in empty space — found the "Add Box" panel got stuck forever on "Click the
viewport to place the base point…" with zero console errors and no visible cause. Root cause,
found by adding temporary trace logging (removed before commit) directly to
`Viewport.handlePrimitiveClick`: `raycaster.ray.intersectPlane(groundPlane, worldPoint)` was
returning `null`, not because nothing was there, but because THREE.js's own `Ray.intersectPlane`
correctly returns `null` whenever **the ray is parallel to the plane** — which happens for real
whenever the active camera is looking exactly horizontally at the Z=0 ground plane, since the
screen-center ray then has zero Z-component too. `animateToFace` produces exactly that camera
orientation for *any* vertical sketch plane (the YZ/XZ datums, or — newly reachable — a Reference
Plane built on either) whose origin sits at Z=0: the camera ends up looking dead-level along the
plane's normal, at ground height. This was always latent in `handlePrimitiveClick`'s existing
ground-plane fallback (added well before this pass, for placing primitives in empty space) — it
just had no way to be triggered before, since nothing previously moved the camera to that exact
orientation and then handed control back to a tool with an empty-space fallback. Reference Planes'
"sketch on this plane" is the first workflow in this app that does both in sequence.

**Fix, scoped to only the case that needs it:** `handlePrimitiveClick`'s ground-plane fallback now
falls through to a second fallback — intersecting the camera's own view plane (normal = camera's
look direction, through the world origin) — whenever the ground-plane ray is parallel. The view
plane's normal is derived directly from `activeCamera.getWorldDirection()`, so it can never be
parallel to a ray the same camera just cast (the two are always perpendicular by construction),
guaranteeing a hit. The ordinary case (camera looking down/across at any normal angle) is
completely unchanged — this only engages in the specific parallel-ray edge case, verified via the
same Playwright reproduction that found it (isolated down to a minimal repro before fixing, to rule
out several other hypotheses — stale `ToolService.activeTool` state, a lingering `TransformControls`
drag lock, `pointerDownPos` drag-threshold miscalculation, and a `PrimitiveToolService.state().phase`
that had silently drifted — each checked and ruled out via direct signal/DOM inspection before the
actual cause was found).

**Deliberately not done / open for a future pass:** rotation/tilt and 3-point plane definition (see
the scoping note above), user-relocatable coordinate systems and reference axes/points (separate
roadmap §5 entries, not touched by this pass), and a live-linked relationship between a Reference
Plane and anything sketched on it (today, like every other feature in this app, a sketch built on a
reference plane has no ongoing tie back to it — deleting or moving the reference plane afterward
does not affect the sketch's already-committed geometry; this falls under the same still-open
parametric feature tree gap noted throughout this roadmap).

**Verified end-to-end via Playwright against the running dev server**: Reference Plane panel opens,
YZ datum pick shows the correct base label, offset/name fields work, Create Plane closes the panel
and adds exactly one entry to the persisted list with the correct name; visibility toggle clicked
twice with no crash; "Sketch on this plane" correctly jumps Sketch straight to its drawing phase
(shape buttons visible, no re-pick step) — confirmed only after correcting the test's own
assumption that `beginFromCustomPlane` resolves synchronously (it awaits `ModelingSessionService.
start()`, the same async gap `begin()`/`beginFromFace()` already have); Pattern/Mirror/
Fillet-Chamfer/Hole-Wizard/Sketch(datum) panels all confirmed opening normally afterward with zero
regressions; deleting the plane removes it from the list; the primitive-placement raycast bug found
above is confirmed fixed (Box correctly reaches its dimension-entry phase and creates a real body,
tree count updated) after the `handlePrimitiveClick` fix; zero console errors throughout the full
run. Ribbon layout re-confirmed clean with no overlap at 12 groups total (one more than the
2026-08-24 fix's own 11-group check), via the same bounding-box measurement technique used then.
`npx tsc --noEmit` passed cleanly both before and after the raycast fix.

## Feature work (2026-09-10) — Shell (hollow-out), a genuinely new OCCT primitive requiring three runtime-verified fixes

Per the user's Phase-2-quick-win choice (offered Shell vs. Revolve vs. starting the parametric
feature tree), implemented Shell: pick one or more faces on a STEP-imported part to remove/open,
set a wall thickness, apply — the standard hollow-out operation for enclosures/housings. Unlike
Reference Plane and Hole Wizard (both zero-OCCT-change passes), Shell is the first genuinely new
OCCT primitive added since Fillet/Chamfer's `BRepFilletAPI_MakeFillet`/`MakeChamfer` calls back in
2026-08-16, and needed the same category of runtime-only API discovery that pass first established
— no `.d.ts` exists for this WASM build, so embind overload names/argument counts/orders are only
ever knowable by calling them and reading the error.

**Client-side: entirely built by direct analogy to `FilletChamferToolService`/
`FilletChamferRendererService`, just picking faces instead of edges.** New `ShellToolService`
(click-to-select-faces, wall-thickness config, one-shot worker call, replace-in-place) and
`ShellRendererService` (multi-face highlight overlay — deliberately its own service rather than
reusing `SketchRendererService.highlightFace`, since that one only tracks a single highlight at a
time and Shell needs several simultaneous picks) mirror their Fillet/Chamfer counterparts field-
for-field. **No new client-side picking primitive was needed at all** — `faceIndices` reuses the
exact same face-index space `SelectionService.pickFace` has resolved clicks into since the
2026-08-06 face-sketch pass (the same index space Sketch/Reference-Plane/Hole-Wizard already
share), unlike Fillet/Chamfer's edge-picking, which needed a brand-new `extractEdges`/`pickEdge`
primitive built from scratch.

**Worker-side: three separate runtime-verified fixes were needed before Shell produced correct
geometry, not just "no exception thrown."** Each wrong guess below returned `IsDone() === true`
with silently wrong output rather than failing loudly, so each was only caught by sanity-checking
real numbers (Volume/Faces/Edges/Surface Area) from an actual Playwright run against the bundled
sample STEP file, not by trusting a clean run:

1. **Constructor overload.** `new occt.BRepOffsetAPI_MakeThickSolid()` throws `"BRepOffsetAPI_
   MakeThickSolid has no accessible constructor"` — `BRepOffsetAPI_MakeThickSolid_1` is the correct
   no-arg overload (confirmed by brute-force trying every symbol matching `MakeThickSolid*` on the
   `occt` module and catching each constructor attempt individually).
2. **Argument order.** `MakeThickSolidByJoin` (the method itself carries no `_N` suffix, unlike the
   constructors) rejects anything but exactly 9 positional arguments with an arg-count
   `BindingError` — discovered by walking the instance's full prototype chain (`Object.
   getPrototypeOf` repeatedly; the method isn't on the derived class's own prototype, only
   inherited ones, so a shallow `Object.keys(instance)` check found nothing) and reading the
   `BindingError`'s own "expected N args" text. The first attempt guessed the parameter order from
   memory rather than OCCT's real C++ signature and put `BRepOffset_Mode` into the slot real OCCT
   uses for `Intersection` (a boolean) — it still returned `IsDone() === true` with **no thrown
   error**, but the resulting box's Volume read back as **-88,193,692.35 mm³** (both wrong sign
   and 18x too large) while Faces/Edges/Surface Area/bounding box all *looked* like a real hollowed
   shape at a glance, which is exactly why this needed numeric sanity-checking, not just visual
   inspection, to catch. The real order: `(shape, closingFaces, offset, tolerance, mode,
   intersection, selfInter, joinType, removeIntEdges)`.
3. **Join type and tolerance.** Fixing the argument order alone still wasn't enough — with the
   correct order but `GeomAbs_Arc` (meant for curved/organic corner joins) and a 1e-3mm tolerance,
   the same box shelled to a positive-but-still-wrong **88,193,692.35 mm³** (an 18x-too-large
   result, just no longer negative — this WASM build's STEP-import geometry apparently doesn't
   resolve reliably at micron tolerance for this operation). Switching to `GeomAbs_Intersection`
   (OCCT's own documented recommendation for sharp/polyhedral corners — a box is exactly that case)
   with a looser 0.1mm tolerance brought the result to **7,380,530.84 mm³** for a 3mm-thick shell
   on a body with 1,993,994.41 mm² of surface area — verified as physically sane by comparing
   against a `surfaceArea × thickness` thin-shell estimate (5,981,983 mm³), landing at a 1.23x
   ratio, well within reason once you account for the one opened face and real corner geometry.
   **A defensive orientation fix was kept even after this**: `BRepOffsetAPI_MakeThickSolid`'s
   output can still come back with globally-reversed face orientation (a documented, separate OCCT
   quirk from the two fixes above) — `handleShell` now checks the raw `BRepGProp` volume sign and
   calls `resultShape.Complemented()` if negative, before tessellating.

**A real, important lesson from step 2 above, worth restating:** *"my sanity check itself was
wrong, not just the code"* also happened once during verification — an initial assertion that
"shelled volume must be less than the original solid's volume" **failed on genuinely correct
output**, because this particular body's proportions (a large, comparatively thin box) mean a
full-surface 3mm shell's volume legitimately exceeds the original solid's own volume. The
`surfaceArea × thickness` thin-shell estimate is the right sanity check for an arbitrary body
shape; "smaller than the original" only holds for "fat" solids like a cube and would have wrongly
failed correct Shell output on this body if trusted.

**UI:** new "Shell" ribbon button in the existing "Features" group next to Hole Wizard
(`app-chrome.html/ts`), and a floating/dockable panel (`tool-panels.html/css/ts`) — face-pick-list
(each removable individually, toggle-to-remove convention matching Fillet/Chamfer's own pick list),
wall-thickness field, Apply button, error display — reusing the same drag/dock machinery every
other panel already has, styled identically to the Fillet/Chamfer panel's `.pick-list` block. New
`ToolPanelId` entry `'shell'`; `ActiveTool` entry `'shell'`, wired into the same "click a face
clears stale selection" branch Sketch/Fillet-Chamfer/Hole-Wizard/Reference-Plane already share, plus
a new pointer-move hover-highlight branch in `Viewport.onCanvasPointerMove` mirroring Fillet/
Chamfer's own edge-hover branch exactly, just calling `pickFace` instead of `pickEdge`.

**Deliberately scoped like Fillet/Chamfer before it**: only STEP-imported, not-yet-cut bodies
(`hasStepSource: true`) support Shell — same restriction and same reasoning (needs a real,
re-readable STEP solid; a sketch/primitive-created body surfaces a clear error instead). No
variable wall thickness (one uniform thickness per operation, matching how Fillet/Chamfer uses one
radius per operation across all picked edges), no feature-tree re-edit-after-the-fact (falls under
the still-open parametric feature tree gap, same as every other feature in this app), and not on
the Undo stack (geometry-creating operation, same documented exclusion since 2026-07-31).

**Verified end-to-end via Playwright against the running dev server**, using the bundled sample
STEP file: face-pick with live hover highlight (yellow picked / blue hover, matching Fillet/
Chamfer's own color convention) → wall-thickness field → Apply → panel auto-closes → body count
unchanged at 17 (replaced in place). The isolated-box case above confirmed genuinely correct
geometry via Faces (16→28), Edges (72→120), Surface Area (1,993,994.41→3,869,609.13 mm²), and a
physically-sane Volume ratio against the thin-shell estimate — not just "no error shown." A
second, harder face (picked without isolating a specific body first, landing on a more complex
part elsewhere in the 17-body assembly) correctly **failed with a clean, user-facing error**
("not geometrically valid — try a smaller thickness or fewer removed faces") rather than hanging
or crashing — the same graceful-failure convention Fillet/Chamfer's own too-large-radius case
already established, confirming Shell's error path works as designed, not just its happy path.
Pattern/Mirror/Fillet-Chamfer/Hole-Wizard/Reference-Plane/Sketch panels all confirmed opening
normally afterward with zero regressions; zero console errors throughout every run. `npx tsc
--noEmit` passed cleanly on the final code. All temporary runtime-symbol-probing debug code
(`console.log` calls used to discover the constructor/method names and argument counts above) was
removed before this pass's code was considered done — none of it shipped.

## Planning note (2026-09-10) — next steps, updated after Reference Plane + Shell

Four Phase 2 items have now shipped in quick succession (Mirror and Hole Wizard on 2026-08-24/25;
Reference Plane and Shell in this same day's later passes above) — this note re-reads the
2026-09-10 roadmap note's own Phase list against what actually landed, so the next session picks
up from the real current state instead of re-deriving it.

**Phase 2 status, item by item (see that note above for full descriptions):**
- Item 5 (Revolve/Sweep/Loft) — still open, not started.
- Item 6 (Shell) — **shipped** (this same day, see the dated entry directly above). Draft (molding
  angle), the other half of that original item, is still open.
- Item 7 (counterbore/countersink/tapped holes) — still blocked on Phase 1 item 1 (needs the
  cut pipeline to support a second cut into an already-cut body — the exact gap Hole Wizard's own
  2026-08-25 entry scoped around).
- Item 8 (variable-radius/face fillet) — still open, not started.
- Item 9 (user-defined reference planes) — **shipped** (offset-only; angled/3-point definition
  remains open, same as recorded in that dated entry).

**What's left in Phase 2, concretely: Revolve, Draft, variable-radius fillet, face fillet.** Of
these, **Revolve** is the highest-value pick — per the original Phase 2 framing, it's a genuinely
new feature *type* (not yet reachable any other way in this app, unlike Draft/variable fillet which
refine existing tools), and unlocks an entire class of real mechanical parts (shafts, flanges,
knobs, any part of revolution) that extrude-only modeling cannot produce at all today. It also
reuses real existing machinery — Sketch's profile-picking UI and plane-resolution code — the same
way Shell reused Fillet/Chamfer's worker-round-trip shape rather than starting from zero.

**Cost/risk note for whoever picks up Revolve next:** it needs one genuinely new OCCT call
(`BRepPrimAPI_MakeRevol`), which — per this same day's Shell pass — should be expected to need
runtime-only API discovery (no `.d.ts` exists for this WASM build) and real numeric sanity-checking
of the result, not just "no exception thrown." Budget for that the same way the Shell pass needed
three separate runtime-verified fixes (constructor overload, argument order, join-type/tolerance)
before the geometry was actually correct, not just plausible-looking.

**If a larger, non-Phase-2 move is preferred instead:** Phase 1 item 1 (parametric feature tree)
remains the single highest-leverage change on the entire roadmap and is now blocking more
individually-shipped features than when it was first flagged (Hole Wizard's counterbore/
countersink, Pattern/Mirror/Shell all producing one-time non-relinked copies) — it has not gotten
any smaller by deferring it, only more clearly the load-bearing gap. Still the largest, riskiest
single change to this codebase, likely spanning several sessions — the same tradeoff noted in the
2026-09-10 capability-estimate entry above, restated here because four more Phase 2 wins later, it
still applies.

**Recorded state: planning only, nothing in this note has been implemented.** Next feature pass
should be Revolve if continuing the Phase 2 quick-wins pattern, or the feature tree if the user
wants to commit to the larger structural change — the choice should be confirmed with the user
first, the same way Mirror vs. Hole Wizard vs. Shell vs. Reference Plane were each confirmed before
starting.

## Feature work (2026-09-10) — Revolve, the first new geometry-creating feature type since extrude itself

Per this same day's own next-steps note above, implemented Revolve: spin a completed sketch
profile around the sketch plane's own U or V in-plane axis to produce a solid of revolution
(shafts, flanges, knobs — any part of revolution, unreachable by extrude alone). This is the first
genuinely new *feature type* added since the original extrude pipeline, not a refinement of an
existing tool the way Fillet/Chamfer, Pattern, Mirror, Hole Wizard, and Shell all were.

**Scoping, confirmed with the user before starting:** v1 always produces a **standalone new body**
— no cut/fuse into an existing part, no `targetBody` — deliberately avoiding the STEP-source
re-read complexity Hole Wizard/Shell both needed, so this pass's risk stayed contained to the one
genuinely new OCCT call. The revolve **axis** is the sketch plane's own U or V in-plane direction
(picked via a 2-option dropdown after the profile is complete), not a separately-drawn axis line —
offered against that alternative and chosen specifically because it needs zero new picking
primitive and reuses the exact plane basis every sketch already computes for point placement.

**UI: a finish-mode toggle inside the existing Sketch panel, not a new tool.** Once a profile is
complete, the panel now shows an Extrude/Revolve toggle (same `.kind-toggle`/`.kind-btn` visual
language Pattern's Linear/Circular and Fillet/Chamfer's Fillet/Chamfer toggles already use,
duplicated into `.sketch-panel` per this codebase's per-panel CSS-scoping convention) before either
mode's own fields appear — Depth/Cut for Extrude (unchanged), Axis/Angle for Revolve (new). This
keeps Revolve inside Sketch's existing pick-plane → draw-profile flow rather than inventing a
second entry point, and confirms the addition doesn't regress plain Extrude (verified explicitly,
see below) since both modes now share one profile-drawing phase that was previously
extrude-only.

**Client-side additions, each a close parallel of the extrude path they sit beside:**
- `RevolveAxis` type (`sketch.model.ts`) — `'u' | 'v'`, documented as deliberately not a drawn
  line (see the scoping note above).
- `SketchService.finishAndRevolve(axis, angleDeg)` — mirrors `finishAndExtrude`'s shape (commit
  sketch → call worker → `addResultToScene` → reset state → clear renderer) but simpler: no
  `pickedFace`/cut-target branch at all, since v1 Revolve never targets an existing body.
- `ModelingSessionService.revolve(sketchId, axis, angleDeg)` — mirrors `extrude()`'s shape exactly,
  reusing the same `feature.result` response type (no new response type needed) since both
  ultimately produce the same `WorkerTessellatedBody[]` shape.
- New `feature.revolve` request type (`step-worker-messages.model.ts`) alongside the existing
  `feature.extrude`.

**Worker-side: `handleFeatureRevolve` reuses `buildFaceFromSketch` unchanged** (the exact same
function `handleFeatureExtrude` already uses to turn committed sketch entities into a face) —
only the final solid-construction call differs, `BRepPrimAPI_MakeRevol` in place of
`BRepPrimAPI_MakePrism`. **One runtime-verified fix was needed, found and fixed on the first
attempt** (no `.d.ts` exists for this WASM build, same situation every new OCCT call in this
worker has needed): `geomPlane.XAxis()`/`.YAxis()` don't exist — `Geom_Plane` only exposes
`Axis()` (its normal) and `Location()` (origin). The in-plane U/V directions live one level down,
on the underlying `gp_Pln` (`geomPlane.Pln()`) — `pln.XAxis()`/`pln.YAxis()` are the correct calls,
found via the same runtime prototype-chain-walking technique the Shell pass established
(`Object.getOwnPropertyNames` repeated up the prototype chain, since embind methods aren't always
on an object's own shallow keys). `gp_Ax1_2(origin, direction)` (the axis constructor) and
`BRepPrimAPI_MakeRevol_1(face, axis, angle, copy)` both worked on the **first** attempt with no
further fixes needed — unlike Shell's three-round journey, this pass needed exactly one runtime
correction before producing correct geometry.

**Verified as genuinely correct geometry, not just "no error thrown," via Pappus's theorem — the
same rigor standard every prior pass in this roadmap has held to.** A circle profile (radius ≈
74.4mm) sketched offset from a datum plane's axis, revolved 360° around it, produced a torus with
reported Volume 10,334,461.17 mm³. Pappus's centroid theorem (torus volume = 2π²·R²·D, where R is
the profile radius and D is the axis-to-profile-center distance) predicts 10,330,533.35 mm³ for
the same measured dimensions — a **0.04% match**, confirming the OCCT call produced exact, correct
revolution geometry on the first fully-fixed attempt, not an approximately-plausible shape.

**Verified no regression to plain Extrude**, which now shares the same profile-drawing phase with
Revolve for the first time: a rectangle sketched on XY, left on the default Extrude mode (confirmed
the toggle defaults correctly), extruded to a real body exactly as before the Revolve toggle was
added. Pattern/Mirror/Fillet-Chamfer/Hole-Wizard/Shell/Reference-Plane panels all confirmed opening
normally afterward with zero regressions; zero console errors throughout every run. `npx tsc
--noEmit` passed cleanly on the final code. All temporary runtime-symbol-probing debug code was
removed before this pass's code was considered done.

**Deliberately not done / open for a future pass**: revolving into/against an existing part (cut or
boss-revolve targeting a `targetBody`, the same STEP-source-re-read complexity Hole Wizard/Shell
both already carry — deferred here specifically to keep this pass's risk to one new OCCT call),
revolving around a separately-drawn axis line rather than the plane's own U/V direction (the
alternative offered and not chosen — see the scoping note above), partial-sweep angle validation
beyond the UI's 1-360° input clamp (the worker's own `IsDone()` check is the real validity gate;
no client-side pre-check for a profile that crosses the axis — it surfaces as a worker error
instead, matching every other feature's error-handling convention in this app), and no feature-tree
re-edit-after-the-fact (same still-open gap every feature in this app has). Sweep and Loft, the
other two Phase 2 item 5 feature types, remain entirely unstarted.

## Feature work (2026-09-11) — Draft (mold-pull angle), the hardest single OCCT call this app has integrated so far

Implemented Draft: pick one or more faces on an existing STEP-imported body, set a draft angle,
and taper those faces along a pull direction so the part releases cleanly from an injection mold
or casting tool — a standard requirement for any part destined for molding/casting, and the next
item picked off this app's own Phase 2 roadmap after Revolve. Chosen over variable-radius fillet
and Sweep when offered as the next roadmap item.

**Scoping, confirmed with the user before starting:** v1 fixes the pull direction to world **+Z**
and needs no user-picked neutral plane — offered against a full direction-and-plane picker and not
chosen, the same "don't build UI for parameters today's tool doesn't need to expose yet" judgment
call Shell's fixed-offset-sign and Hole Wizard's fixed-cut-sign already made. Only STEP-imported
bodies are supported (same `FeatureCutTarget`/STEP-source-re-read dependency Fillet/Chamfer, Shell,
and Hole Wizard already carry, including the same `hasStepSource` one-feature-per-body ceiling).

**Client-side additions are a close, direct parallel of Shell's** (own model, own renderer, own
tool service, own panel) — no new picking primitive needed, since Draft reuses the exact
`TopExp_Explorer_2` TopAbs_FACE walk order `faceIdMap`/Shell's own `faceIndices` already
established:
- `DraftToolState`/`PickedDraftFace`/`IDLE_DRAFT_TOOL` (`draft-tool.model.ts`) — phase
  (`picking-faces`/`configuring`), an ordered pick list, and an angle in degrees.
- `DraftRendererService` — duplicates `ShellRendererService`'s multi-face highlight-mesh technique
  exactly, its own "DraftOverlay" scene group.
- `DraftToolService` — duplicates `ShellToolService`'s shape exactly: toggle-pick a face (same-body
  constraint), validate the angle (0–90° exclusive), resolve the target body's STEP source,
  one-shot worker spin-up/terminate, replace the body in the scene on success.
- Ribbon button ("Draft" in the Features group, next to Shell) and a `.draft-panel` floating panel
  (pick list of "Face N" entries, removable; angle input; Apply/error display) — CSS cloned from
  `.shell-panel`'s exact rules per this codebase's per-panel CSS-scoping convention.

**Worker-side (`handleDraft`, `step-loader.worker.ts`) was, by a wide margin, the hardest single
OCCT integration this app has done — roughly 10 distinct hypotheses tried before landing on a
working one, spanning two separate debugging sessions.** `BRepOffsetAPI_DraftAngle`'s
`Add(Face, Direction, Angle, NeutralPlane, Flag)` call has no `.d.ts` (as with every new OCCT call
in this codebase) and, worse than prior features, its failure mode wasn't a thrown exception or a
`false` from `IsDone()` — every wrong hypothesis below reported a clean `AddDone()==true`,
`IsDone()==true`, `Status().value==0` ("success"), while silently producing **bit-identical,
zero-effect geometry**. That combination — "the API insists it succeeded" plus "nothing happened"
— is what made this pass take so much longer than Shell's three-round journey: every other
feature's debugging loop could trust `IsDone()` as the signal of whether an attempt worked, but
Draft's required checking the actual before/after **volume** (via `GProp_GProps`/
`BRepGProp.VolumeProperties_1`) after every single trial, since a clean "success" status meant
nothing on its own. This reinforces this project's existing verification rule (never trust
"no exception" or `IsDone()` alone — always sanity-check real numeric output) even more strongly
than any prior feature did.

The hypotheses tried, in order, and what each one actually revealed:
1. **Premature `IsDone()` check placed inside the per-face `Add()` loop** — reported failure for
   every face regardless of which one was picked. Fixed by discovering (via the
   `Object.getOwnPropertyNames`-up-the-prototype-chain technique established in earlier passes)
   that `Add`, `AddDone`, `Build`, `IsDone` are four distinct methods: `AddDone()` is the correct
   per-`Add()` status, `IsDone()` only reflects the final `Build()`.
2. **Neutral plane fixed at world Z=0, normal=Z** — failed outright (`IsDone()==false`) for any
   body not literally straddling the origin; this app's real STEP-imported bodies commonly sit
   well above/below Z=0 (the test body's own bounding box: Z from -132.52 to 467.48).
3. **Neutral plane at the target solid's own volumetric centroid, normal=Z** — a clean, fully
   "successful"-looking `AddDone()`/`IsDone()`/`Status()==0`, but a bit-identical, zero-volume-
   change no-op. This looked like the "IsDone lies" trap described above for the first time.
4. **Combinatorial sweep of angle sign × `Flag` (true/false)**, still at the centroid plane — all
   4 combinations gave the exact same no-op, ruling out sign/flag as the missing piece.
5. **Neutral plane normal swapped to X or Y** (still at the centroid) — normal=X threw outright;
   normal=Y produced a real, nonzero volume change but of wildly wrong magnitude and sign
   (-64,193,716 mm³) — the same "garbage-but-real" class of bug Shell's own early attempts hit,
   confirming the shape was becoming genuinely invalid, not just failing to change.
6. **Face-normal downcast** (`BRep_Tool.Surface_2` → `Handle_Geom_Plane_DownCast` to get the
   picked face's own real normal for the neutral plane) — `Handle_Geom_Plane_DownCast` does not
   exist as a symbol in this WASM build; this path was abandoned before producing any result.
7. **Translate-solid-to-origin-then-draft-then-translate-back** (sidestepping the neutral-plane
   placement question by construction) — first with `BRepBuilderAPI_Transform`'s default lazy
   `Copy=false` (a `TopLoc_Location`-only move, no real geometry rebake): no-op. Then with
   `Copy=true` (forcing real translated geometry): still an exact no-op. This ruled out "the
   transform is lazy and `BRep_Tool::Surface` ignores Location" as the explanation.
8. **Found the real face normal via `GeomLProp_SLProps`** (probed constructor overloads at
   runtime — `GeomLProp_SLProps_1(Surface, U, V, Degree, Tolerance)` is the correct 5-argument
   overload in this build) and used it directly as the neutral plane's normal — this **threw**
   outright, the same failure normal=X had produced earlier, strongly suggesting a neutral plane
   whose normal is *perpendicular* to the pull direction (i.e., a plane that *contains* the pull
   axis) is what's actually expected, not a plane perpendicular to pull.
9. **Ground-truth isolation test**: built a fresh, simple in-memory 100×100×100 box
   (`BRepPrimAPI_MakeBox_1`) directly in the worker (no STEP round-trip, no ambiguity about which
   face is which) and tried the exact same `Add()` call against it. **A neutral plane at the box's
   own base face (Z=0 — a real, literal boundary face of that box) worked correctly on the first
   try**: volume dropped from 1,000,000 to 956,255.67 mm³, matching a hand-computed estimate for a
   5° taper on a 100×100 face over a 100mm height almost exactly. This was the first hypothesis
   that produced genuinely correct geometry, and it isolated the actual root cause: **the neutral
   plane must coincide with a real geometric boundary of the solid, not merely pass through an
   arithmetic point (a centroid) that happens to satisfy the right coordinates but touches no
   actual face or edge.**
10. **Applied that finding to the real STEP body**: instead of the volumetric centroid, the
    neutral plane's origin is now the solid's own **minimum-Z bounding extreme** (found by walking
    every `TopAbs_VERTEX` via `TopExp_Explorer_2` and taking the lowest Z), normal=Z — guaranteed
    to coincide with real boundary geometry (every solid has some vertex touching its own bbox
    extreme) without needing to identify which specific face that is. This produced a real,
    substantial, correctly-signed volume change on the actual STEP body (see verification below)
    — no solid translation needed at all, unlike the abandoned hypothesis 7.

**One more fix needed after the neutral-plane fix**: the first working result reported a
**negative** volume (-8,534,775.17 mm³) — a real, correctly-shaped drafted solid, just
orientation-inverted, the same class of bug Shell's `MakeThickSolidByJoin` hit early in its own
pass. Same fix reused verbatim: check the drafted shape's volume via `GProp_GProps`, and call
`.Complemented()` on it when negative (flips face orientation back the right way without altering
the geometry itself).

**Verified end-to-end via Playwright against the real dev server** (STEP-load → Isolate Body 1 →
Draft → pick the large side face at viewport center → 5° angle → Apply), with real numeric
before/after checks, not just "no error thrown":
- Faces: 16 → 16, Edges: 72 → 72 (draft tapers existing faces, it doesn't add/remove topology)
- Volume: 4,955,011.65 mm³ → 8,534,775.17 mm³ (delta +3,579,763.52 mm³ — a large, real,
  correctly-signed change; the picked face spans the body's full ~590mm Z range at ~348,402 mm²
  area, so a 5° taper redistributing that much material over that height is the expected order of
  magnitude)
- Body count unchanged at 17 (in-place replace, not an added/duplicated body)
- Panel auto-closes with no error surfaced; zero console errors throughout
- Re-ran after a full dev-server restart to confirm the result is reproducible, not a fluke of one
  process's warm state — identical numbers both times.

All `[DRAFT DEBUG]` console logging and every abandoned-hypothesis code path (the centroid-plane
computation, the translate-to-origin/back transform pair, the face-normal-downcast attempt, the
combinatorial flag/sign/normal-axis trial loops, the in-worker ground-truth box test) were removed
before this pass's code was considered done — `handleDraft` now contains only the working
neutral-plane-at-minimum-Z construction, the `Add`/`Build`/`IsDone` call, and the
`Complemented()` orientation fix, matching every other feature's "no debug scaffolding ships"
convention. `npx tsc --noEmit` passes cleanly.

**Deliberately not done / open for a future pass**: user-picked pull direction and/or neutral
plane (the alternative scoping offered and not chosen — see above), draft on sketch/primitive-
created bodies (blocked on the same `hasStepSource` STEP-source dependency every STEP-source-
dependent feature in this app already has), per-face draft angle (all picked faces currently share
one angle), and no feature-tree re-edit-after-the-fact (same still-open gap every feature in this
app has).

## Feature work (2026-09-11) — Sweep, plus a real geometry bug caught only by checking the actual number

Implemented Sweep: a 3rd finish mode alongside Extrude and Revolve inside the existing Sketch
panel, producing an oblique/angled prism a plain Extrude can't reach. Picked as the next Phase 2
roadmap item after Draft.

**Scoping, worked out with the user across two rounds before landing on something both buildable
and geometrically real:**
- Round 1 considered three path sources for a general Sweep tool (straight line along a datum
  axis, along a picked edge, or along a second path sketch) and the user picked the
  straight-datum-axis option as lowest-risk v1 scope.
- That scoping turned out to be **already exactly what Extrude does** — Extrude has always
  extruded along the sketch plane's own normal axis, so "sweep along a datum axis" would have
  shipped a relabeled duplicate. Caught this before writing any worker code by re-reading
  `handleFeatureExtrude`'s own existing `geomPlane.Axis().Direction()` call.
- Round 2 re-scoped to the actual gap: a straight path in a direction OTHER than the sketch
  plane's own normal (an oblique/angled extrude). The user picked "sweep along one of the sketch
  plane's own other two axes (U/V)" over "pick an arbitrary edge's direction vector" — no new
  picking primitive, reuses the exact U/V axis pair Revolve's own axis dropdown already
  established.

**Round 2's own scoping turned out to be a second, more serious problem: a real geometry bug, not
just a naming collision.** Implemented first as `axis: 'u' | 'v'` — sweep purely along the plane's
own U or V axis, no normal component at all. This shipped, typechecked clean, and the panel
appeared to work end-to-end (profile drawn, Sweep applied, panel closed with no error, a new body
appeared in the tree with the topologically-correct 6 faces of a swept rectangle). **The actual
Volume, when checked, was exactly 0.00mm³.** This is the same failure class Draft's neutral-plane
bug hit repeatedly (see that dated entry above): a clean, error-free "success" that silently
produced no real geometry — here for a more fundamental reason than Draft's, once the root cause
was seen: `BRepPrimAPI_MakePrism` sweeping a planar profile along a direction that lies IN that
profile's own plane is mathematically degenerate — there is no out-of-plane extent to sweep
through, so the "prism" has zero thickness by construction, regardless of what OCCT parameters are
passed. Caught immediately (this was the first thing checked, not a multi-round debugging arc like
Draft's) precisely because this project's standing convention is to check the real number, not
just "no exception thrown" — a screenshot or a "panel closed successfully" check alone would have
shipped this silently broken.

**Corrected model, confirmed with the user:** sweep along the plane's own **normal**, rotated by a
user-set **tilt angle** (0–89°) toward the chosen U or V axis — at 0° this is identical to plain
Extrude (by construction, not by coincidence), and at higher angles it's a genuinely new,
non-degenerate oblique prism. Implemented via a manual rotation: build the rotation axis as
`normal × tiltAxis` (the cross product, giving the one direction perpendicular to both, so the
rotation tips the normal purely toward the tilt axis with no other skew), then
`gp_Trsf.SetRotation_1` + `gp_Vec.Transformed(rotation)` to get the tilted sweep direction, fed
into the exact same `BRepPrimAPI_MakePrism_1` call Extrude/Revolve/the broken v1 all already used
— no new OCCT primitive needed for this feature at any point, unlike Shell/Draft.

**Client-side additions are a close parallel of Revolve's own 3rd-mode integration** (the same
pass that added Revolve as a 2nd mode alongside Extrude): `SweepAxis` type (`sketch.model.ts`),
`SketchService.finishAndSweep(axis, tiltDeg, distance)`, `ModelingSessionService.sweep(...)`, a new
`feature.sweep` request type, and a 3rd `.kind-btn` in the Sketch panel's existing toggle row
(Extrude / Revolve / Sweep) with its own Tilt-axis dropdown / Tilt-angle / Distance fields — same
`.kind-toggle`/`.kind-btn` visual language and "shared profile-drawing phase, mode-specific finish
fields" structure Revolve's own addition established, extended from 2 modes to 3.

**Verified via Playwright against the real dev server, with a rigorous geometric sanity check, not
just a nonzero volume:** a rectangle profile sketched on the XY datum plane (read back from its
own bounding box as 347.560 × 111.970mm, rather than assumed from screen pixels) swept 25mm at a
20° tilt produced Volume 914,190.48 mm³. The general oblique-prism formula (volume = base area ×
sweep distance × cos(tilt), a direct application of Cavalieri's principle — the same "base area ×
perpendicular height" relationship used to previously sanity-check Extrude) predicts 914,233.84
mm³ for the same measured profile — a **0.005% match**. A second run at tiltDeg=0 produced
972,861.19 mm³ against a predicted plain-extrude-equivalent 972,907.33 mm³ (25mm depth, no cos()
factor) — a **0.0047% match**, confirming tiltDeg=0 genuinely degenerates to Extrude's own
behavior rather than merely looking similar. Regression-checked Extrude and Revolve still work
correctly inside the now-3-way toggle; zero console errors throughout every run. `npx tsc
--noEmit` passes cleanly.

**Deliberately not done / open for a future pass**: sweeping along a picked edge's direction or a
curved path (the alternatives offered and not chosen at each scoping round — see above), sweep
into/against an existing part (same `targetBody`/STEP-source-re-read scope-out every other
standalone-new-body feature in this app has made), and no feature-tree re-edit-after-the-fact
(same still-open gap every feature in this app has).

## Feature work (2026-09-13) — Loft, the first feature to need its own multi-step tool outside the Sketch panel

Implemented Loft: blend between 2 or more profiles (each drawn on its own plane) into one solid —
the standard "cross-section changes shape along its length" operation (a bottle: round base, oval
body, narrow neck; a duct transitioning round-to-rectangular). Picked as the next Phase 2 roadmap
item after Sweep.

**Scoping, confirmed with the user before starting:** Loft needs 2+ profiles, which doesn't fit
the existing "draw one profile, then pick a finish mode" shape Extrude/Revolve/Sweep all share
inside the Sketch panel — offered two shapes and the user picked the fuller one: a dedicated Loft
tool where the user draws a profile (same plane-pick/shape-draw phases Sketch already has), clicks
**Add to Loft**, repeats for a 2nd/3rd/etc. profile, then clicks **Finish Loft** — over a
fixed-2-profile-only alternative that would have capped out at a single loft segment.

**Client-side: `LoftToolService` DRIVES `SketchService`'s existing state rather than
reimplementing plane-picking/shape-drawing a second time.** This is architecturally different from
every other tool in this app, which are each either fully independent (Shell, Draft, Hole Wizard)
or a finish-mode toggle living entirely inside Sketch's own panel (Revolve, Sweep). Loft is
neither: it's a separate top-level tool (own ribbon button, own `ActiveTool` value, own floating
panel) that, while active, reads and writes `SketchService.state` directly — the viewport's own
click routing (`viewport.ts`) sends clicks to the exact same `handleSketchClick` method regardless
of whether `'sketch'` or `'loft'` is the active tool, since that method already reads
`sketch.state().phase` rather than checking which tool is active. Two small, deliberate additions
to `SketchService` made this possible without duplicating any drawing logic:
- `commitCurrentProfile()` — commits the in-progress profile (via the same `session.commitSketch`
  every other finish method already calls) WITHOUT building a feature from it, returning the
  committed `sketchId` so a caller can hold onto it. Every existing finish method
  (`finishAndExtrude`/`Revolve`/`Sweep`) commits and immediately builds one feature from that one
  sketch; none had ever needed to expose the bare commit step on its own before Loft.
- `resetForNextProfile()` — resets back to `'picking-plane'` for the next profile without tearing
  down the modeling session (`cancel()` would end the session Loft needs to keep running across
  all its profiles) and without touching `lastError` (`LoftToolService` owns its own error signal,
  surfaced separately from Sketch's).

`LoftToolService` itself (`loft-tool.service.ts`) then just tracks the growing list of committed
`{sketchId, label}` profiles (`LoftToolState`, `loft-tool.model.ts`) and, on Finish, calls
`ModelingSessionService.loft(sketchIds)` — added alongside `extrude()`/`revolve()`/`sweep()`,
reusing the exact same `feature.result` response shape all of them share.

**Worker-side (`step-loader.worker.ts`): two changes, one a refactor, one genuinely new.**
1. **Refactor**: `buildFaceFromSketch` (used by Extrude/Revolve/Sweep) was split into
   `buildWireFromSketch` (builds the bare closed wire from committed sketch entities) plus a thin
   wrapper that adds `BRepBuilderAPI_MakeFace` on top. Necessary because `BRepOffsetAPI_ThruSections`
   (Loft's own maker class) wants one WIRE per cross-section, not a filled face — the solid comes
   from blending BETWEEN cross-sections, not from any single one of them. Verified this refactor
   changed nothing observable: re-ran the Sweep verification script afterward and got the exact
   same volume (914,190.48 mm³) as before the refactor, bit-for-bit.
2. **New**: `handleFeatureLoft` re-walks each of the request's `sketchIds` through the session's
   own `sketches` map (the same one every other feature handler already reads from — Loft is
   simply the first feature to read MORE THAN ONE committed sketch in a single request), builds
   each one's wire via `buildWireFromSketch`, then feeds them all into
   `BRepOffsetAPI_ThruSections.AddWire()` before `Build()`/`IsDone()`/`Shape()` — the same
   `Add`/`Build`/`IsDone`/`Shape()` shape Fillet/Chamfer/Shell/Draft's own maker classes all
   already needed. **One runtime-discovery finding, different from every prior feature's own
   `.d.ts`-less discovery story**: unlike every other new OCCT class integrated into this app so
   far, `BRepOffsetAPI_ThruSections` has NO numbered overload suffix in this WASM build (no `_1`/
   `_2` variants) — it's a single un-suffixed constructor, found by probing arg counts against the
   `BindingError` messages the same way every other constructor-overload discovery in this app has
   worked, landing on the correct 3-argument shape `(isSolid, isRuled, precision)` on the first
   correctly-shaped attempt once the argument count was known. `isSolid=true` caps the result
   (covers the first/last cross-sections into a genuine solid rather than an open shell);
   `isRuled=false` lets `ThruSections` build a smoothly interpolated blend rather than a
   straight-line-per-segment one.

**Verified via Playwright against the real dev server**, with the same "check the real number"
discipline the Sweep bug/fix reinforced: drew a small circle on the XY datum plane, added it to
the Loft; drew a larger circle on the XZ datum plane (a genuine 3D twist between non-parallel
planes, not a simple coaxial frustum), added it; clicked Finish Loft. Result: Volume
9,425,951.55 mm³, Faces=4, Edges=12, panel auto-closed with no error, exactly one new body in the
tree. A visual screenshot confirmed a smooth, continuous, correctly-shaped tapered/twisted blend
between the two circles — no gaps, self-intersections, or degenerate patches. Sanity-checked the
volume against its own bounding box (a real solid must occupy strictly less than its full bbox
volume, and a plausible, non-trivial fraction of it) rather than assuming an exact hand-derived
number, since the two profiles' non-parallel planes make a simple closed-form volume formula
inapplicable here: bbox volume 35,414,278.97 mm³, loft volume 9,425,951.55 mm³ — a 26.6% fill
ratio, consistent with a genuinely tapered/twisted solid rather than degenerate or inflated
geometry. (An initial test assumption of "exactly 3 faces" for a 2-circle loft turned out to be
naive rather than a real bug: a ruled surface twisting between two perpendicular-plane circles can
legitimately need more than one B-spline patch to represent — confirmed correct via the visual
check above, not just accepted on faith.) Regression-checked Sweep and Draft both still produce
their exact same previously-verified numbers after the `buildWireFromSketch` refactor and this
session's other worker-file changes; zero console errors throughout every run. `npx tsc --noEmit`
passes cleanly. No debug scaffolding (the `BRepOffsetAPI_ThruSections` constructor-overload probe
used to find the working 3-argument shape) remained in the shipped code.

**Deliberately not done / open for a future pass**: closed lofts (blending back to the first
profile to close the loop, e.g. a torus-like shape), guide curves (a rail the blend follows beyond
simple linear/smoothed interpolation between cross-sections), Loft into/against an existing part
(deferred here, closed in the very next dated entry below), reordering profiles in the panel's
list without removing and re-adding them, and no feature-tree re-edit-after-the-fact (same
still-open gap every feature in this app has).

## Feature work (2026-09-13) — Revolve/Sweep/Loft into an existing part, and a real geometry bug found in Revolve's own cut path

Closed the single most-repeated deferral from the last three feature passes: Revolve, Sweep, and
Loft each shipped standalone-new-body-only, explicitly deferring cut/fuse into an existing part
"for a future pass" every time. This pass closes that gap for all three at once, reusing the exact
`targetBody`/STEP-source-re-read machinery Extrude, Fillet/Chamfer, Shell, Hole Wizard, and Draft
already share — chosen as the next roadmap item specifically because it was low-risk (an existing,
proven pipeline) while closing three separate "deliberately not done" lines simultaneously.

**Shared worker-side refactor**: extracted `cutOrFuseAgainstTarget(occt, session, newSolid, cut,
targetBody)` out of what used to be `handleFeatureExtrude`'s own inline targetBody-resolution +
`BRepAlgoAPI_Cut`/`Fuse` logic — the exact same boolean-op sequence Revolve/Sweep/Loft's own new
cut/fuse support all needed too. Extrude's own behavior is provably unchanged: it now calls this
helper instead of the code it used to have inline, and its own dated-entry verification numbers
were unaffected by the extraction.

**Client-side**: `ModelingSessionService.revolve/sweep/loft` all gained optional `cut`/`targetBody`
params (mirroring `extrude()`'s own shape exactly, transferring `targetBody.bytes.buffer` the same
way). `SketchService.finishAndRevolve`/`finishAndSweep` gained a `cut` param and now resolve
`targetBody` from `st.pickedFace` via the same `resolveCutTarget`/`findNodeIdForBody` helpers
`finishAndExtrude` already used — plus a new public wrapper,
`resolveCutTargetForPickedFace(pickedFace)`, added specifically for `LoftToolService` (see below).
A shared "Cut (remove material)" checkbox was added to the Sketch panel's Revolve and Sweep modes,
and a separate one to the Loft panel — all following the same "only has an effect if you sketched
on an existing part's face" convention Extrude's own Cut checkbox already established.

**Loft's own multi-profile ambiguity, resolved per the user's own choice before implementation**:
since Loft has 2+ profiles (possibly on different bodies' faces, unlike Revolve/Sweep's single
profile), "which body does Cut/Fuse target" needed its own rule — resolved as: **only the FIRST
profile's `pickedFace`** ever drives the cut/fuse target; every later profile just shapes the
blend. `LoftToolState`'s `CommittedLoftProfile` gained a `pickedFace` field, snapshotted at
`addCurrentProfile()` time (since `SketchService.resetForNextProfile()` clears its own `pickedFace`
before the next profile begins, this would otherwise be lost by Finish-Loft time).
`LoftToolService.finishLoft(cut)` resolves the target via the new
`resolveCutTargetForPickedFace(profiles[0].pickedFace)` and gained its own `replaceBodyInScene`
(mirroring `SketchService`'s exactly) for the in-place-replace path a targeted cut/fuse needs.

**A real, separate geometry bug was found and fixed in Sweep's own new cut path** (not shared with
Revolve/Loft, which didn't have it): `handleFeatureSweep`'s prism only ever swept in ONE direction
(`sweepDirVec` scaled by distance) — fine for a standalone body, but when cutting into an existing
part the tool solid, built only outward from the sketch plane, barely touches the target and never
actually overlaps its interior — the exact same bug `handleFeatureExtrude`'s own targetBody branch
had already hit and fixed (see its own long-standing comment). Fixed identically: when
`req.cut && req.targetBody`, sweep the tool solid symmetrically BOTH ways from the sketch plane and
fuse the two halves together first, guaranteeing it punches through the material regardless of
which way the picked face's normal happens to point.

**A second, more serious geometry bug was found in Revolve's own new cut path — this one took
real debugging to find, not caught by any error or `IsDone()` check.** First attempt (reusing
`cutOrFuseAgainstTarget` with no further changes) shipped clean — typechecked, ran with no thrown
error, `BRepAlgoAPI_Cut`'s own `IsDone()` reported true — but produced a **bit-identical,
zero-volume-change result** on every test, the same "the API insists it succeeded" failure class
Draft's own neutral-plane bug hit repeatedly (see that dated entry). Debugged by logging the tool
solid's own volume/bounding box alongside the target's: the tool solid was real and substantial
(confirmed once with a tool solid ~4x the target's own volume) but its bounding box barely
overlapped the target's at all — a revolved profile, drawn on a face-picked plane whose normal
points OUTWARD from the body (the same convention Extrude/Sweep's own docstrings describe), stays
almost entirely on that OUTWARD side once revolved, regardless of angle or which way the axis
points, since a revolve is centered on its axis rather than translated like a prism — so
Extrude/Sweep's own "sweep it both ways" fix doesn't translate to Revolve at all.

**Fix**: mirror the revolved tool solid across the plane that CONTAINS the revolve axis and has
the picked face's own normal as ITS normal. That mirror plane is fixed in space by construction
(the axis lies IN it, since the axis is one of the picked face's own in-plane U/V directions and
the face's normal is perpendicular to that whole plane by definition) — so reflecting across it
flips the tool solid from the face's outward side to its inward side without moving the axis, or
any part of the profile that touches the axis, at all. Implemented via `gp_Ax2_3(axisOrigin,
faceNormalDir)` (the 2-argument overload — confirmed via the same runtime-probing technique every
new OCCT call in this worker has needed; a first attempt at 3 arguments, and then at
`gp_Ax2_2`, both threw `BindingError`s naming the correct arg count before landing on the right
combination) + `gp_Trsf.SetMirror_3` + `BRepBuilderAPI_Transform_2`, applied only when
`req.cut && req.targetBody` (the standalone-body path is completely unaffected).

**Verified via Playwright against the real dev server, for all three features, with real
before/after numeric checks — never trusting a clean panel-close or a thrown-error check alone,
per this app's own standing convention (reinforced yet again by Revolve's own "IsDone lies"
discovery above):**
- **Sweep-into-existing-part**: a small circle profile face-picked on the bundled sample body,
  swept 100mm as a Cut. Faces 16→17 (one new cylindrical wall face, exactly as expected for a
  single through-cut), Volume 4,955,011.65 → 4,948,930.99 mm³ (delta -6,080.66 mm³ — real,
  correctly negative). Cross-checked the magnitude against a hand-derived cylindrical-cut estimate
  (πr²×depth using the profile's own measured radius) and found it ~77x smaller than that naive
  estimate — investigated rather than dismissed, and traced to the target body being a large, thin
  wedge (Volume/bbox-volume ratio ≈ 5%) rather than a thick block at the exact click location, so
  a 100mm-deep tool cylinder only ever intersects the body's real local wall thickness, not its
  full nominal depth — a real, explainable result, not a code defect.
- **Revolve-into-existing-part**: same body, a rectangle profile revolved 90° as a Cut. Volume
  4,955,011.65 → 4,484,633.97 mm³ (delta -470,377.68 mm³). A second, larger-profile trial run
  produced a cut delta EXACTLY equal to the tool solid's own independently-measured volume
  (21,752.865866417604 mm³, matched to 8 significant figures) — strong confirmation the mirrored
  tool solid ended up FULLY CONTAINED within the target, not partially clipped, exactly as a
  correct cut should behave.
- **Loft-into-existing-part**: profile 1 face-picked on the body (a circle), profile 2 a
  differently-sized circle on the XZ datum plane (profiles on the SAME plane were tried first and
  produced a genuine geometric no-op — a near-zero-thickness degenerate loft, unrelated to this
  feature's own cut/fuse wiring — investigated and correctly attributed to test setup, not a code
  bug, before moving to a proper two-plane profile pair). Volume 4,955,011.65 → 4,759,281.98 mm³
  (delta -195,729.67 mm³).
- All three: body count stayed at 17 (in-place replace, not an added body), panels auto-closed
  with no error, zero console errors throughout every run.
- Regression-checked standalone (non-cut) Sweep and Loft afterward and got bit-identical volumes
  to their own original dated entries (914,190.48 mm³ and 9,425,951.55 mm³ respectively) —
  confirms the shared-helper refactor and Sweep/Revolve's own new cut-path changes didn't disturb
  the standalone path at all. Draft (unrelated to this pass but sharing the same worker file) also
  re-verified bit-identical to its own prior numbers.
- A genuinely separate bug was caught and fixed during this pass unrelated to the cut/fuse work
  itself: `step-loader.worker.ts` was missing its own `FeatureCutTarget` import — `npx tsc --noEmit`
  did NOT catch this (passed clean), but `ng serve`'s own Angular-compiler-plugin build did, output
  as a real `TS2304: Cannot find name 'FeatureCutTarget'` error. This is now a known gap in this
  project's own verification habit: `tsc --noEmit` alone is not a fully reliable gate for this
  codebase — `ng serve`'s own build output should be checked too, not just typecheck, before
  considering a worker-file change verified.

All debug logging (the tool-solid/target-solid volume-and-bbox dumps used to diagnose Revolve's
own bug) was removed before this pass's code was considered done — confirmed via a final grep for
stray `console.log`/DEBUG markers in the worker file. `npx tsc --noEmit` passes cleanly, and `ng
serve` itself was re-confirmed compiling with zero errors (the actual gate this pass's own finding
says to trust going forward).

**Deliberately not done / open for a future pass**: Loft's own remaining scope gaps (closed loops,
guide curves — unaffected by this pass), user-picked pull direction for Draft (unrelated, from an
earlier pass), and no feature-tree re-edit-after-the-fact (same still-open gap every feature in
this app has). Variable-radius fillet was picked up and closed in the very next dated entry below;
Hole Wizard counterbore/countersink is the next concrete item on the roadmap after that one.

## Feature work (2026-09-14) — Variable-radius fillet, a real memory leak found and fixed, and a genuinely edge-specific OCCT crash logged

Implemented per-edge radius/distance for Fillet/Chamfer: a multi-edge operation can now mix
different values per edge (e.g. 5mm/8mm/3mm across 3 picked edges) instead of every picked edge
sharing one shared value. Picked as the next roadmap item after Revolve/Sweep/Loft-into-existing-
part, per the scoping choice made before starting: real CAD tools use "variable-radius fillet" to
mean two different things (per-edge radius in a multi-edge operation, or a radius that tapers
continuously along a single edge) — the user picked the former as lower-risk v1 scope, since
`BRepFilletAPI_MakeFillet`/`MakeChamfer`'s own `Add()` call already takes one value per call
(no new OCCT primitive needed), where a continuously-tapering radius would need a materially
different, unprobed multi-parameter `Add()` overload.

**Shape of the change**: `FilletChamferRequest.edgeIndices: number[] + value: number` (one shared
value) became `edges: FilletChamferEdgeValue[]` (`{edgeIndex, value}` pairs, one per pick) — a
worker-message-model shape change, not a new OCCT call. `PickedEdge` (client-side) gained its own
`value` field, defaulted from a renamed `FilletChamferState.defaultValue` (was a plain shared
`value`) at pick time and independently editable afterward via a new `setEdgeValue(bodyId,
edgeIndex, value)` method — mirroring the exact "each pick keeps its own state" shape Loft's own
`CommittedLoftProfile.pickedFace` snapshot established the day before. The panel's pick-list now
shows a small radius/distance input inline per picked edge (`.edge-value-input`), plus a
"New edges start at" field for the shared default new picks begin from. Worker-side, `handleFilletChamfer`
now maps `req.edges` to `{edge, value}` pairs before the identical `Add_2(value, edge)` loop it
already had — genuinely no new OCCT primitive, just per-call values instead of one shared value.

**A real, pre-existing memory leak was found and fixed while investigating unrelated test
instability** (see below): `disposeObject3D` (`disposal.util.ts`, used by every overlay renderer
in this app to clean up highlight/preview geometry) only checked `instanceof THREE.Mesh ||
instanceof THREE.LineSegments` — `FilletChamferRendererService`'s own hover-preview line is a
plain `THREE.Line` (not `LineSegments`), so its `BufferGeometry`/`LineBasicMaterial` (and their
GPU buffers) were never actually disposed, despite `showHoverEdge` disposing-then-rebuilding a new
line on every single `pointermove` while Fillet/Chamfer is active — a leak accumulating on every
mouse movement near an edge, for as long as the tool stays open. Fixed by adding `|| obj
instanceof THREE.Line` to the same check. Confirmed this is the ONLY affected call site in the app
(searched all `new THREE.Line(...)` construction sites; `measurement.service.ts`'s own line
disposal is hand-rolled, not routed through `disposeObject3D`, so it was never affected).

**A separate, genuinely edge-specific OCCT crash was found and is logged as an open issue, not
fixed in this pass**: one specific real edge on the bundled sample STEP assembly's Body 1
(screen-picked as "Edge 25" at a fixed camera framing) throws an unhandled, uncatchable native
exception inside `BRepFilletAPI_MakeFillet`/`Build()` at ANY radius tried, down to 0.5mm — surfacing
client-side as a raw WASM exception pointer (`err instanceof Error` is false for it, so
`String(err)` on the caught value is just a memory address like `21716072`, not a readable
message) rather than the normal "Fillet failed — ... not geometrically valid" error this feature's
own `IsDone()` check produces for ordinary invalid inputs. A different edge on the exact same body,
picked with the identical mechanism and radius, filets cleanly with a real, correctly-signed volume
change — ruling out this pass's own per-edge-value logic as the cause and narrowing it to that one
specific edge's own real geometry (very likely a very short or otherwise degenerate edge somewhere
in this assembly's STEP data). Worth a future pass: harden `handleFilletChamfer`'s own catch block
to detect and surface non-`Error` WASM exceptions with at least a generic-but-honest message,
rather than leaking a raw pointer value to the UI.

**Verified via Playwright against the real dev server, with real numeric before/after checks**:
picked a real edge (Edge 19) on the bundled sample STEP body's Body 1, set its own radius to 3mm,
applied. Faces 16 → 17 (one new rounding face, exactly as expected for a single filleted edge),
Volume 4,955,011.65 → 4,953,852.80 mm³ (delta -1,158.85 mm³ — real, correctly negative, a fillet
always removes material). The 2-different-edges-with-2-different-independently-read-back-values
scenario (the actual "variable-radius" input this pass exists for) was separately confirmed via a
standalone probe script: picking a 2nd real edge correctly ADDS it alongside the first rather than
replacing it (pick list showed both, e.g. "Edge 25 Edge 19"), each with its own value (3 and 7),
independently settable and independently read back without cross-contamination — exact pixel
coordinates for a reliably-reproducible 2-edge pair inside one single continuous script turned out
to vary run-to-run (this app's own edge-picking has always been pixel-precise, an established,
pre-existing characteristic unrelated to this pass), so the shipped verify script keeps to the
single-edge case for a stable, always-reproducible check, with the 2-edge mechanism's correctness
documented here from the standalone probe's own real output. Regression-checked Chamfer separately
(same per-edge-value refactor applies to both kinds) — a real -1,200mm³ delta on a different edge,
zero console errors. Also regression-checked Sweep/Loft/Draft (all sharing the same worker file
and, for Sweep/Loft, the same `disposal.util.ts` this pass touched) — all three reproduced their
own exact prior dated-entry numbers, bit-for-bit. `npx tsc --noEmit` and `ng serve`'s own build
both pass cleanly (per the previous dated entry's own finding, both are checked — `tsc --noEmit`
alone is not fully reliable for this project).

**A large amount of this pass's own time went into test-environment instability that turned out
to be unrelated to the feature itself** — worth recording so a future pass doesn't re-diagnose the
same thing: right-click → Isolate on a body, followed by opening Fillet/Chamfer and clicking the
viewport, reproducibly crashed the test browser outright (not a JS error — an actual renderer
crash), on every body tried including tiny ones, regardless of the memory-leak fix above (one
hover doesn't leak enough to crash). Confirmed NOT a general environment problem (Shell/Draft/
Sweep/Revolve/Loft all click-pick fine immediately after the identical Isolate step, in the same
session) and NOT caused by this pass's own code changes (reproduces via the ribbon button alone,
with zero of this pass's edits present). Root cause not found; worked around by skipping Isolate
in this feature's own verify script (Fillet/Chamfer's click-to-pick works reliably without it) —
logged here as a real, separate, still-open bug for whoever next touches Fillet/Chamfer's
interaction code.

**Deliberately not done / open for a future pass**: radius that continuously tapers along a single
edge (the alternative "variable-radius" scoping offered and not chosen — see above), the Isolate +
Fillet/Chamfer crash and the raw-WASM-exception UI message (both logged above), and no
feature-tree re-edit-after-the-fact (same still-open gap every feature in this app has). Hole
Wizard counterbore/countersink remains the next concrete item on the roadmap after this one.

## Feature work (2026-09-14) — Parametric feature tree, Slice 1: Extrude, end-to-end

Per the 2026-09-10 planning note's own Phase 1 framing (the single highest-leverage, largest/
riskiest item on the whole roadmap — no parametric feature history, so no operation is editable
after Apply), started the feature-tree redesign. Scoped to **one representative tool taken fully
end-to-end — Extrude only** — rather than migrating every tool at once, per explicit user decision
(custom shape-history graph, not OCCT's OCAF/XCAF document framework; one tool first, not a
big-bang migration). Revolve/Sweep/Loft/Fillet-Chamfer/Shell/Draft/Hole-Wizard are all completely
untouched by this pass and keep working exactly as before — none of them have a Feature Tree entry
yet, only Extrude does.

**Core design: a per-session, worker-side ordered feature-record list, not an OCAF document.**
`step-loader.worker.ts`'s `Session` interface gained `features: SessionFeatureRecord[]` — additive
alongside the pre-existing `shape: OcctModule | null` scalar, which Revolve/Sweep/Loft still
exclusively read/write exactly as before (their own session-shape-chaining behavior is untouched;
the two mechanisms coexist without interfering, since `feature.extrude` only touches `shape` on the
old unmigrated no-`producesBodyId` path). Each `SessionFeatureRecord` retains everything needed to
replay it from scratch (`sketchId`, `params: {depth, cut}`, `targetRef`) plus its own last-built
OCCT shape handle (`resultShape`) so an edit only needs to rebuild what actually changed, not every
feature ever built in the session. New `feature.edit` worker request: updates one record's params,
then replays it **and every feature after it in array order** — a deliberately simple, conservative
stand-in for a real multi-input dependency graph (documented in `Session.features`'s own docstring
as an explicit v1 simplification, correct for this slice since no feature here can depend on more
than one prior feature).

**The structural piece that makes chaining possible: `DocBodyRef`.** Every existing cut/fuse target
in this codebase (`FeatureCutTarget`) could only ever be a re-read of a body's *original* STEP
source bytes — structurally incapable of targeting a body a `feature.extrude` itself produced (a
feature-tree body has no STEP bytes; it isn't STEP-imported). New `DocBodyRef` union type =
`{kind:'imported', bytes, solidIndex}` (exactly `FeatureCutTarget`, renamed into the union) OR
`{kind:'feature', featureId}` (new — resolves to a prior `SessionFeatureRecord`'s own cached
`resultShape` instead of any STEP re-read). Only `feature.extrude`'s `targetBody` was widened to
accept a `DocBodyRef`; Revolve/Sweep/Loft keep the plain `FeatureCutTarget`-only shape, unmigrated.
Client-side, `SketchService.resolveExtrudeCutTarget` (Extrude-only, sitting alongside the
pre-existing `resolveCutTarget` that Revolve/Sweep/Loft still use unchanged) checks
`TreeService.getFeatureId(nodeId)` first — a new `TreeNode.featureId` field, parallel to the
existing `hasStepSource` flag but deliberately NOT cleared by `TreeService.replaceBody` (a
feature-produced body is supposed to keep pointing at the same feature record across an edit, since
that's the whole point of an edit) — before falling back to the STEP-source path. This is what
makes "Extrude A, then cut into A" constructible in the UI at all; without it, a feature-tree body
could never be a cut/fuse target (same `hasStepSource`-gated limitation Fillet/Chamfer/Shell/Draft/
Hole-Wizard already have), and the worker's downstream-dependent-replay code would have been
unreachable through any click sequence — a real gap caught during this pass's own scoping, not
assumed away.

**Real bug found and fixed during verification: client/worker feature-identity mismatch.**
`ModelingSessionService.extrude()` originally always minted its own internal `featureId` via
`generateId('feature')`, separate from the `featureId` `SketchService.finishAndExtrude` generated
for its own `TreeService.linkFeature`/`FeatureTreeService.register` bookkeeping — two different
strings for what was supposed to be the same feature's identity. The worker stored the internally-
generated id in `session.features[].featureId`; the client tracked a different id entirely. The
mismatch was invisible for single-feature editing (edit always passes the client's own id straight
through to `feature.edit`, which happened to still resolve since nothing else needed to match it),
but broke immediately the moment a SECOND extrude tried to target the first one via
`{kind:'feature', featureId}` — surfaced as "Feature <id> not found in this session's history"
on the cut-into-A step, caught via a live user test run before being fixed. Fix: `extrude()` gained
an optional `featureId` parameter, used as-is instead of generating a fresh one when the caller
already needs to know it up front (exactly `finishAndExtrude`'s case); every other caller
(`HoleWizardService`, which doesn't pass `producesBodyId` either) is unaffected.

**New client-side pieces**: `models/feature-record.model.ts` (`ClientFeatureRecord` — a lightweight
shadow copy of the worker's record, minus the live OCCT handle, which can never leave the worker),
`services/feature-tree.service.ts` (`FeatureTreeService` — read-oriented registry + panel
open/closed state + in-progress-edit state, justified the same way `StructuralModelService` was:
"parallel to TreeService's CAD tree but its own domain"). New Feature Tree tool panel
(`tool-panels.html/css/ts`, same drag/dock machinery every other panel already has) lists every
feature-tree-aware Extrude as one row; double-click opens an inline depth/cut edit form. Unlike
every other tool panel in this app, Feature Tree deliberately has **no `ActiveTool` entry and no
activate/cancel semantics** in `ToolService` — it's a persistent browser/list (the feature-tree
analogue of the Model Tree), not a click-driven or selection-gated action, so it's just a plain
`panelOpen` boolean toggled from a new ribbon button (Display group, next to Mesh View).

**Disposal correctness, addressed proactively rather than left as a new leak.** The 2026-07-31
undo/redo scoping note already flagged that this worker does zero explicit disposal of intermediate
OCCT shapes — tolerable when only one `shape` scalar existed at a time, but a real leak risk once
`session.features` can retain many long-lived `resultShape` handles across a session. Fixed at both
points where this matters: `handleSessionDispose` now disposes every retained feature's
`resultShape` (previously only the bare `shape` scalar), and `handleFeatureEdit`'s replay loop
explicitly `.delete()`s each feature's OLD `resultShape` before overwriting it with the replayed
one.

**Verified end-to-end via a Playwright driver script against the running dev server** (`ng serve`,
not `ng build` — same pre-existing, unrelated `opencascade.js`/esbuild gap noted in every prior
entry): standalone Extrude (20mm) → Feature Tree panel shows exactly one row, 12 triangles, 1 body;
Sketch on that body's own face → small rectangle → Cut checked → Extrude → **real material removal
confirmed** (a genuine through-hole, 12→32 triangles, not a disconnected added shape) → Feature Tree
shows 2 rows; double-click the FIRST row (the base extrude, not the cut) → change depth 20→60 →
Apply → body height updates AND the notch from the second feature is correctly preserved at the
same relative position (32→40 triangles, a real re-tessellation, not a no-op) → confirmed via an
orbited camera screenshot showing a genuinely taller, non-degenerate solid with the cut boundary
still present. Zero console errors and zero page errors across the entire run. Cold-start OCCT WASM
init reliably took under Playwright's default timeouts once polled for correctly (a fixed
short-wait wildly undershot it, same "30-40+ seconds under sandboxed test conditions" cold-start
cost already documented in the 2026-08-17 export entry — this pass's own first verification attempt
tripped on exactly that, not a real app bug, and was fixed by polling for the drawing-phase UI
element instead of a fixed delay).

**Deliberately not done / open for a future pass** (per this slice's own explicit scoping,
supplementing rather than replacing the 2026-09-10 planning note's phase list):
- **Every other geometry tool is unmigrated** — Revolve, Sweep, Loft, Fillet/Chamfer, Shell, Draft,
  Hole Wizard all still use their original one-shot, re-read-from-STEP-bytes model with no Feature
  Tree entry. Migrating each is real, separate work — this slice deliberately proved the pipeline on
  one tool first rather than attempting a big-bang migration.
- **No undo/redo for feature edits.** `HistoryService`'s `{label, undo, redo}` shape is mechanically
  reusable (a plain reversible-command interface, not property-diff-specific) but wiring it up needs
  a durable "OCCT state before this edit" snapshot strategy designed together with the `resultShape`
  caching this slice added, not bolted on after — recorded as a deliberate follow-up, not an
  oversight.
- **No sketch-geometry re-editing** — a feature-tree edit changes depth/cut only; the underlying 2D
  profile (points, shape kind) is fixed at creation time, matching the "don't build past what
  today's UI exercises" precedent this codebase repeatedly follows (e.g. Draft's fixed pull
  direction). Re-editing the actual sketch shape is a larger, separate feature.
- **Dependency tracking is "everything after me in array order," not a real DAG.** Correct for this
  slice (Extrude can depend on at most one prior feature) but would over-replay unrelated sibling
  features once a tool with multiple independent inputs (e.g. Loft, which already references
  multiple sketch ids) is migrated onto this model — flagged in `Session.features`'s own docstring
  as a known simplification to revisit then, not now.
- **Counterbore/countersink in Hole Wizard remains blocked**, same as before this slice — Hole
  Wizard itself was not migrated onto the feature-tree model (still calls `session.extrude()` with
  no `producesBodyId`), so this slice doesn't unblock that specific gap yet, even though the
  underlying `DocBodyRef`/chaining mechanism it needed now exists for Extrude.

## Feature work (2026-09-14) — Parametric feature tree, Slice 2: migrate Revolve

Per Slice 1's own "deliberately not done" list, migrated Revolve onto the feature-tree model next —
the concrete pick that entry itself flagged, since `handleFeatureRevolve`'s pre-existing shape
(build a raw solid, then call the shared `cutOrFuseAgainstTarget` against an optional
`targetBody: FeatureCutTarget`) was already structurally identical to what `handleFeatureExtrude`
looked like before Slice 1 — the same migration pattern (extract a pure solid-builder, resolve via
`DocBodyRef`/`resolveDocBodyRef`, append a session feature record, widen `feature.edit`) transferred
directly. Sweep/Loft/Fillet-Chamfer/Shell/Draft/Hole-Wizard remain completely unmigrated.

**`FeatureRecord` (and its client-side shadow `ClientFeatureRecord`) became a discriminated union
by `kind`.** Slice 1 shipped it as a single fixed-shape interface (`kind: 'extrude'` always); adding
Revolve's genuinely different params (`axis`, `angleDeg`, `cut` vs. `depth`, `cut`) forced the real
union. One real TypeScript wrinkle this surfaced: `SessionFeatureRecord` (the worker-only type that
adds the live `resultShape` OCCT handle) was originally `interface X extends FeatureRecord` — once
`FeatureRecord` became a union, that stopped compiling (`extends` doesn't distribute over a union,
TS2312). Fixed by switching to `type SessionFeatureRecord = FeatureRecord & { resultShape }`, an
intersection applied to each union member individually, which does distribute correctly and
preserves the discriminant everywhere `record.kind` is checked. `feature.edit`'s own params gained
a matching `kind`-tagged union (`{kind:'extrude', depth, cut} | {kind:'revolve', axis, angleDeg,
cut}`) so the worker validates an edit's kind against the target record's own kind before mutating
anything, rather than trusting the caller — a mismatch (impossible through the UI today, but not
through the message type alone) surfaces as a clear error instead of silently corrupting a record
into a shape its own `kind` doesn't match.

**Shared boolean-op logic factored out a second time, once Revolve needed it too.** The Cut/Fuse-
against-a-resolved-target logic was inline in `handleFeatureExtrude` (Slice 1) and duplicated again
in `handleFeatureEdit`'s replay loop — tolerable at one duplicate, not at a third once Revolve's own
handler needed the identical thing. New `cutOrFuseNewSolid(occt, newSolid, cut, cutFuseTarget)` — a
pure "boolean op or passthrough" helper — is now the single implementation all three call sites
share (`handleFeatureExtrude`, `handleFeatureRevolve`, `handleFeatureEdit`'s replay loop). Kept
deliberately separate from the pre-existing `cutOrFuseAgainstTarget` (which also resolves a plain
`FeatureCutTarget` internally, a responsibility these three callers already handle themselves via
`resolveDocBodyRef`/`session.shape` fallback) — merging the two would have forced Sweep/Loft (still
unmigrated, still calling `cutOrFuseAgainstTarget` as-is) to change shape for no benefit to them.

**`buildRevolveToolSolid`** was extracted the same way `buildExtrudeToolSolid` was in Slice 1 —
face-build → axis/angle → `BRepPrimAPI_MakeRevol` → the pre-existing conditional mirror-across-
axis-plane step (unchanged from its original 2026-09-13 fix, moved verbatim) — so both the create
path and the replay path build this identical solid from one shared implementation. `handleFeatureEdit`'s
replay loop now branches on `record.kind` to call the matching builder
(`buildExtrudeToolSolid`/`buildRevolveToolSolid`) before running the shared cut/fuse step.

**Client-side, `resolveExtrudeCutTarget` was renamed `resolveFeatureAwareCutTarget`** (in
`sketch.service.ts`) since it's no longer Extrude-specific — `finishAndRevolve` now calls the exact
same method `finishAndExtrude` does to resolve a feature-tree-aware target. New sibling
`commitEditOfRevolveFeature` (alongside Slice 1's `commitEditOfFeature`) — kept as a separate method
rather than one generic one, matching this file's own established "small sibling methods over one
generic one when call-site shapes differ" precedent (`resolveCutTarget`/`resolveCutTargetForPickedFace`).
`FeatureTreeService.update` gained a second overload for Revolve's params shape, with the actual
runtime dispatch branching on the record's own `kind` (not the caller's claimed intent) as a quiet
guard — mirrors the worker's own kind-validation, just non-fatal here since this is UI-list
bookkeeping, not the source of truth. The Feature Tree panel's row label and inline edit form both
gained a `@if (feature.kind === 'extrude')`/`@else` branch (depth-only fields vs. axis-select +
angle-input fields, both sharing the existing Cut checkbox).

**Verified end-to-end via Playwright driver scripts against the running dev server** (`ng serve`,
same pre-existing unrelated `opencascade.js`/esbuild build gap as every prior entry):
- Standalone Revolve (360°, rectangle profile on an XZ datum sketch, drawn in Front view for
  predictable click-to-world-coordinate geometry — Iso view made it too easy to accidentally draw a
  profile that crosses the revolve axis, itself confirmed as a correctly-surfaced, non-fatal error
  with the tool staying open for retry) → Feature Tree shows one "Revolve — 360°" row → double-click,
  edit angle to 180°, Apply → triangle count roughly halves (1148→580, consistent with half the
  curved surface), body count stays at 1 (in-place replace, not duplicated), zero console errors.
- **Downstream-dependent replay across the generalized `DocBodyRef`/`{kind:'feature'}` mechanism**:
  built a 360° cylinder (F1), then a SECOND Revolve (F2 — a full circular hole, drawn on F1's own
  flat end-cap face, targeting F1 via `{kind:'feature', featureId: F1}`, Cut checked) → confirmed a
  correctly cut-through hole in a full cylinder → edited F1's angle 360°→270° → confirmed the SAME
  hole stayed correctly cut through the now-pie-wedge-shaped 270° partial revolution, at the same
  relative position, with the body count still at 1 and zero console errors throughout. This is a
  same-kind chain (Revolve targeting a prior Revolve), not the cross-kind case the original test
  plan called for (Revolve targeted by an Extrude) — but since target resolution
  (`resolveDocBodyRef`/`cutOrFuseNewSolid`) has no kind-specific logic at all, this equally exercises
  the exact code path a cross-kind chain would use; the only kind-specific branching anywhere in the
  replay loop is which solid-builder function runs for the record actually being replayed, which is
  independently proven correct by the two single-kind (Extrude, Revolve) create+edit tests. A
  literal cross-kind (Extrude-into-Revolve or vice versa) run was attempted but not completed in
  this pass — abandoned only because of Playwright click-precision on a cylinder's end-cap face at
  different camera angles, not because of any app-side failure; picking up that literal combination
  is a reasonable quick follow-up check, not a real open risk given the above.
- A real error path (profile crossing the revolve axis) was hit unintentionally during test-script
  iteration and confirmed to surface its existing, correct, pre-Slice-2 error message with no
  crash and the tool left open for retry — an incidental regression check on unrelated,
  pre-existing behavior.

**Deliberately not done / open for a future pass** (same list Slice 1's own entry already carries,
now shared by two feature kinds instead of one):
- Sweep, Loft, Fillet/Chamfer, Shell, Draft, Hole Wizard remain unmigrated.
- No undo/redo for feature edits (same durable-snapshot design gap Slice 1 already flagged).
- No sketch-geometry re-editing (axis/angle/depth/cut only, not the profile itself).
- Dependency tracking is still "everything after me in array order" — Loft, when eventually
  migrated, is the concrete case that will need this revisited, since it references multiple
  sketch ids and could have independent (not just linearly-chained) inputs.
- Hole Wizard counterbore/countersink still blocked (unmigrated).
- A literal cross-kind chain (Extrude targeting a Revolve's output, or vice versa) was not run to
  completion this pass — see the verification note above for why that's a low-risk gap, not an
  open question about correctness.

## Feature work (2026-09-14) — Parametric feature tree, Slice 3: migrate Sweep

Third instance of the pattern Slices 1/2 established. Picked next because `handleFeatureSweep`
(`step-loader.worker.ts`) had the exact same pre-migration shape Extrude and Revolve both had
before their own migrations: build a raw solid (here: a prism along a tilted direction, with the
same symmetric-both-directions trick Extrude/Revolve use for a cut), then call the shared
`cutOrFuseAgainstTarget` against a plain `FeatureCutTarget`. No new design questions — a mechanical
repeat of the same five changes (widen the message-model union, extract a pure solid-builder,
resolve `targetBody` via `resolveDocBodyRef`, branch `handleFeatureEdit`'s replay loop, thread the
client-side opt-in through `finishAndSweep`/`FeatureTreeService`/the Feature Tree panel's edit form)
now applied a third time, with `FeatureRecord`/`ClientFeatureRecord`/`feature.edit`'s params all
growing a third `kind: 'sweep'` union member (`{axis, tiltDeg, distance, cut}`).

**One real cleanup found and fixed while touching this code, unrelated to Sweep itself: a stale,
orphaned docstring.** Slice 2's own refactor left behind the ORIGINAL pre-migration docstring for
`handleFeatureRevolve` (describing the old `cutOrFuseAgainstTarget`-based implementation) sitting
immediately above the NEW docstring for the extracted `buildRevolveToolSolid` — two docstring
blocks back to back, the first one now describing code that no longer exists at that location.
Harmless at runtime but actively misleading to read; removed while adding Sweep's own third
solid-builder extraction, so the pattern doesn't get copied a third time by accident.

**`handleFeatureEdit`'s kind-validation and solid-builder dispatch both grew their third branch**
the same way `cutOrFuseNewSolid`'s design already anticipated: the edit-params kind-check became a
3-way `if/else if/else if/else` (was 2-way in Slice 2), and the replay loop's solid-builder
selection switched from a ternary (2 branches, `record.kind === 'extrude' ? ... : ...`) to an
explicit `if/else if/else` chain, since a ternary doesn't scale past two branches without nesting
that gets hard to read. `cutOrFuseNewSolid` itself (the shared boolean-op helper Slice 2 factored
out) needed zero changes — it was already kind-agnostic by design, taking a plain resolved
`OcctModule` target regardless of which builder produced the tool solid.

**Verified end-to-end via a Playwright driver script against the running dev server**: standalone
Sweep (30° tilt, 80mm distance, rectangle profile on an XY datum) → confirmed visually as a genuine
oblique prism (tilted parallelogram side faces, clearly distinct from a plain vertical Extrude) →
Feature Tree shows one "Sweep — 30° tilt, 80mm" row → double-click, edit distance to 150mm, Apply →
prism visibly lengthens along its tilted axis while keeping the same 30° tilt, body count stays at
1 (in-place replace), triangle count unchanged at 12 (same topology, different dimensions), zero
console errors. **Regression-checked both prior slices immediately after**: Slice 1's own Extrude
create+edit+dependent-cut scenario and Slice 2's own Revolve create+edit scenario both re-ran
byte-for-byte identical to their own original verified results, confirming the three feature kinds
now coexist in the same `session.features[]`/Feature Tree without cross-contamination.

**Test-environment note, same lesson as Slice 2's own entry:** hit the identical transient
`vite-error-overlay`-blocks-clicks artifact from a mid-edit save race during iteration (Vite's dev
server catches an intermediate, not-yet-complete save as a real compile error, shows the overlay,
then resolves cleanly once the file settles) — confirmed via a direct overlay-count check on a
fresh page load before retrying, not a real app-side regression. Worth remembering for whoever next
iterates against this dev server: a failed Playwright run right after an edit is worth one retry
before assuming the app broke.

**Deliberately not done / open for a future pass** (same list Slices 1/2's own entries already
carry, now shared by three feature kinds instead of two):
- Loft, Fillet/Chamfer, Shell, Draft, Hole Wizard remain unmigrated.
- No undo/redo for feature edits (same durable-snapshot design gap flagged since Slice 1).
- No sketch-geometry re-editing (numeric params only, not the profile itself).
- Dependency tracking is still "everything after me in array order" — unchanged risk profile from
  Slice 2's own note; Loft remains the concrete case that will need this revisited when it's
  eventually migrated.
- Hole Wizard counterbore/countersink still blocked (unmigrated).
- A literal cross-kind chain was verified for Revolve→Revolve (Slice 2) but not run end-to-end for
  Extrude↔Sweep or Revolve↔Sweep specifically this pass — same low-risk reasoning as Slice 2's own
  note applies (target resolution has no kind-specific logic; only the solid-builder dispatch does,
  and that's independently proven correct per-kind by each slice's own single-kind tests).

## Feature work (2026-09-14) — Undo/Redo for Feature Tree edits

Closed the gap every Slice 1-3 entry flagged and deferred: a Feature Tree edit (Extrude/Revolve/
Sweep's depth/axis/angle/tilt/distance/cut) is now on `HistoryService`'s Ctrl+Z/Ctrl+Y stack.

**No new snapshot mechanism needed — the key design insight.** The worker's replay machinery
(`handleFeatureEdit`) already rebuilds any feature's geometry from just its own `FeatureRecord` at
any time — that's what makes editing work at all. So "undo an edit" is just **another edit, back to
the old params**; `ClientFeatureRecord.params` (already tracked per feature since Slice 1) *is* the
snapshot. No worker changes, no message-model changes — this landed as a purely client-side wiring
change layered on infrastructure the last three slices already built and proved correct.

**Reused an existing precedent for wrapping an already-applied async operation in one undo step**,
rather than inventing a new shape: `ObjectTransformService.commitDrag()` already established this —
a drag has already moved the mesh to its end transform before `commitDrag()` runs, yet
`history.run({ redo: () => apply(end), undo: () => apply(start) })` works correctly because
`apply(end)` is idempotent (re-applying a state you're already in is harmless, not a double-apply
bug). `ToolPanels.applyFeatureEdit()` now follows the identical shape: it still calls
`commitEditOf*Feature` directly once (applying the edit, exactly as before this pass), and only
AFTER that resolves does it call `history.run()` — whose own internal `redo()` invocation re-runs
the same new params, a harmless idempotent replay, while `undo()` re-runs the OLD params (captured
from `record.params` before the edit, read inside each `record.kind`-narrowed branch so TypeScript
can verify the params shape matches — a hoisted single `oldParams` binding captured before the
branch does NOT narrow correctly through `record.kind` checks later, confirmed by a real compile
error caught during this pass; fixed by re-reading `record.params` inside each branch instead).

**A real, previously-latent gap found and closed while tracing this, not part of the original
ask:** `commitEditOfFeature`/`commitEditOfRevolveFeature`/`commitEditOfSweepFeature` each set
`busy.set(true)` for the Feature Tree panel's own Apply-button-disabling but never guarded against
a SECOND call for the same feature arriving while the first was still in flight. Harmless before
this pass (nothing could realistically fire two overlapping edit calls — the panel's own Apply
button is `[disabled]`-gated on `busy()`), but Ctrl+Z/Ctrl+Y are global keyboard shortcuts that
bypass any panel-level UI guard entirely, and a rapid Ctrl+Z-Ctrl+Z is an entirely normal user
gesture — exactly the scenario this pass makes newly reachable. Two overlapping `feature.edit`
requests against the same feature would have raced on the worker's own
`session.features[i].resultShape` dispose-then-overwrite (`record.resultShape?.delete?.()` followed
by a reassignment — a classic use-after-free/double-free shape if two replays interleave on the
same record). Fixed with a plain `private readonly pendingFeatureEdits = new Set<string>()` in
`SketchService`, checked at each `commitEditOf*Feature`'s entry (early-return if already pending
for that `featureId`) and cleared in each method's `finally`. Scoped per-`featureId`, not global —
editing two DIFFERENT features concurrently is unaffected, since the worker's own per-feature
replay is already independent.

**The "still working" UX gap flagged during planning turned out to already be covered by existing
wiring, once traced precisely** — no new signal or binding was needed. The Feature Tree panel's
Apply/Cancel buttons were already bound to `featureEditBusy()`, itself a direct alias of
`sketch.busy` (`this.featureEditBusy = this.sketch.busy` in `ToolPanels`'s constructor, pre-existing
since Slice 1) — and `commitEditOf*Feature` already sets that same `busy` signal regardless of
whether the call originated from the panel's own Apply click or from an undo/redo-triggered
`history.run()` closure. So the edit form correctly shows "Applying…" and disables its buttons
during an undo/redo-triggered replay too, for free, with zero additional code.

**Verified end-to-end via a Playwright driver script against the running dev server**: Extrude F1
(20mm) → Extrude-cut F2 into F1's face (Slice 1's own proven chain) → edit F1's depth to 60mm,
confirmed via the Feature Tree row and a screenshot → **Ctrl+Z**: row correctly reverts to "20mm"
(not just relabeled — a follow-up screenshot confirms 32 triangles, matching Slice 1's own original
20mm+cut scenario's verified triangle count exactly, with the cut hole still visibly present through
the shorter box — proving the FULL downstream replay re-ran, not a partial/stale revert) → **Ctrl+Y**:
row correctly returns to "60mm" → **rapid Ctrl+Z Ctrl+Z with no wait between them**: ends cleanly at
"20mm" (the single edit's only undo step, consumed once; the second Ctrl+Z had nothing further on
the stack, matching `HistoryService.undo()`'s own existing no-op-on-empty-stack behavior — not a
crash, not a corrupted intermediate state) — zero console errors across the entire run. The Undo
history dropdown element was also confirmed present (would show the new `"Edit Extrude: <name>"`-
style label for free, since it already renders `HistoryCommand.label` generically with no
Feature-Tree-specific code needed).

**Deliberately not done / open for a future pass:**
- **No more prominent "still working" indicator** (e.g. a toolbar spinner, or disabling the
  Undo/Redo toolbar buttons themselves during the async tail of an undo/redo-triggered replay) —
  the Feature Tree panel's own Apply/Cancel buttons correctly reflect busy state (see above), but
  the global toolbar Undo/Redo buttons and Ctrl+Z/Ctrl+Y remain clickable immediately, even mid-
  replay. Not a correctness bug (the in-flight guard makes a second same-feature call a safe no-op,
  and a different-feature undo/redo is genuinely independent and fine to allow concurrently) — a
  smaller, separate polish item if the async tail's latency ever becomes a real user complaint.
- **`HistoryCommand`'s type stays `(): void`, not `Promise<void>`** — the async closures here work
  structurally (TypeScript allows it, `HistoryService` doesn't await), but this is a general-purpose
  interface every other undo-covered operation also implements synchronously; widening it project-
  wide was considered and not done, since it isn't needed for correctness and would touch every
  existing `history.run()` call site's types for no behavioral gain.
- Everything Slice 3's own "deliberately not done" list already carries is still true and unrelated
  to this pass — this closes exactly one item from that list (Feature Tree undo/redo) and nothing
  else.

## Feature work (2026-09-14) — Parametric feature tree, Slice 4: migrate Loft

Loft was the last sketch-based geometry tool not yet on the Feature Tree (Extrude/Revolve/Sweep in
Slices 1-3, undo/redo in the pass right before this one). Confirmed harder than a fourth repeat of
the same pattern by reading `handleFeatureLoft`/`LoftToolService` directly before starting: Loft
references 2+ committed sketch profiles at once (`sketchIds: string[]`), not one — every other
migrated kind's `FeatureRecord` had a singular `sketchId` field, read unconditionally by
`handleFeatureEdit`'s replay loop. A `kind: 'loft'` member needed its OWN `sketchIds: string[]`
field (deliberately not reusing `sketchId` for a plural value, so any code still written against
the singular field for a loft record fails to compile instead of silently reading `undefined`), and
the replay loop needed a real kind-aware branch at the SKETCH-RESOLUTION step, not just at the
solid-builder-choice step the way Slices 2/3 only needed.

**What turned out NOT to be true, on closer inspection before implementing:** the concern (recorded
in Slices 2/3's own "deliberately not done" notes) that Loft would force solving a real multi-input
DEPENDENCY graph turned out to be narrower than it looked from the outside. Loft's multiple sketches
are multiple PROFILES of the SAME feature, not multiple prior FEATURES it depends on — it still
depends on at most one prior feature for its own cut/fuse target (`targetRef`, from profile 1's
face), exactly like Extrude/Revolve/Sweep. "Everything after me in array order" stayed a correct
replay strategy without any redesign.

**v1 Loft editing is deliberately Cut-only** (`params: {cut: boolean}`, no numeric field at all —
the smallest of the four kinds' edit surfaces) — re-adding/removing/reordering a Loft's profiles
after the fact is out of scope, matching the "don't build past what today's UI exercises" precedent
every other tool in this app already follows for its own sketch profile. This also meant
`FeatureTreeService.update`'s existing per-kind discriminant-checking pattern (`'depth' in params`,
`'angleDeg' in params`, `'tiltDeg' in params`) couldn't extend the same way a fourth time — Loft's
`{cut}` params has no field unique to it, since `cut` alone is a subset of every other kind's own
params too. Fixed by checking by EXCLUSION for the loft case (`!('depth' in params) &&
!('axis' in params)`) rather than trying to find a field that doesn't exist.

**Two real bugs found and fixed during this pass's own verification, both real, neither obvious
from just re-reading the code:**

1. **A stale, orphaned docstring** from Slice 2's own refactor, structurally identical to the one
   found and removed during Slice 3 — confirms this is a recurring class of small cleanup that's
   worth checking for whenever touching a function that was itself extracted from a larger one in
   an earlier slice.

2. **A genuine race in the undo/redo pass's own in-flight guard, exposed specifically by Loft's
   slower replay.** The guard added in the undo/redo pass (`pendingFeatureEdits: Set<string>`,
   early-return if a call for the same `featureId` was already in flight) was built to prevent a
   real race — but as a hard DROP, not a queue, it could also silently eat a legitimate next call:
   confirmed via a live Playwright run that pressing Ctrl+Z shortly after a Loft Apply (whose
   `BRepOffsetAPI_ThruSections` worker round-trip is slow enough — 5+ seconds observed — to make the
   race window easy to hit in practice, unlike Extrude/Revolve/Sweep's much faster replay, which
   made the same underlying bug essentially unreachable in those slices' own testing) could leave
   the guard still set when a subsequent Ctrl+Y arrived, silently dropping the redo — Undo/Redo
   toolbar buttons stayed correctly enabled throughout, giving no visible sign anything was wrong,
   which is exactly why this needed an actual multi-step Playwright run (not just a single edit
   check) to surface at all. Root cause: `history.run()`'s own internal `redo()` call is fired
   synchronously but wraps an async `commitEditOf*Feature` call, so a fast-enough subsequent
   keypress could arrive before that call's own `finally` block had cleared the guard.

   Fixed by replacing the `Set<string>`-based drop-on-conflict guard with a proper per-`featureId`
   promise queue (`pendingFeatureEdits: Map<string, Promise<void>>`, new private
   `runSerializedFeatureEdit(featureId, fn)` helper all four `commitEditOf*Feature` methods now
   route through): a call arriving while one is already in flight for the SAME `featureId` now
   chains onto and awaits it (via `.catch(() => {})` so a prior call's rejection never blocks or
   fails a later one queued behind it) instead of being silently discarded — every call still runs,
   in the order issued, none lost. A different `featureId`'s edit is completely unaffected, same as
   before. Re-verified after the fix: Loft's own undo→redo sequence, pressed with only a 300ms gap
   (deliberately tight, to keep exercising the same race window rather than waiting around it),
   now correctly completes both steps; re-ran Slice 1/2/3's own undo/redo scenarios (including the
   original rapid-double-Ctrl+Z Extrude test) and confirmed byte-for-byte identical results to their
   own prior verified runs — the fix closes a real bug without changing behavior for the three kinds
   whose speed had been masking it.

**Verified end-to-end via Playwright against the running dev server**: 2-profile Loft (square on
XY, circle on XZ, both drawn in the SAME Iso camera view — a debug detour during this pass confirmed
Front view makes the XY datum plane edge-on to the camera, producing a degenerate click-to-world-ray
intersection that reproduces identically with plain Sketch+Extrude too, confirming it's a pre-
existing camera/plane interaction unrelated to this slice's own code, not a regression) → confirmed
a genuine smooth blended solid (9290 triangles, visibly a square-to-circle transition, not a flat
extrude) → Feature Tree shows "Loft — 2 profiles" → toggle Cut, Apply → row updates to "(cut)",
worker round-trip confirmed via the edit form's own "Applying…" state and a state-based (not fixed-
delay) wait for the form to close → Ctrl+Z reverts the row and geometry → Ctrl+Y (pressed
immediately after, no settling wait) correctly restores "(cut)" — proving the queue fix. Zero
console errors across the entire run, including through the two debugging detours (camera-plane
interaction, then the race) that preceded the clean final run.

**Deliberately not done / open for a future pass:**
- Sweep-into-Loft/Loft-into-Sweep and other literal cross-kind chains involving Loft specifically
  weren't run to completion this pass (same scoping as Slice 2/3's own notes — the mechanism is
  kind-agnostic by construction, independently proven correct per-kind).
- No profile-level re-editing (add/remove/reorder a cross-section after the Loft is built) — Cut
  only, per this entry's own scoping section above.
- Fillet/Chamfer, Shell, Draft, Hole Wizard remain unmigrated — genuinely different design shape
  (edge/face picks on an existing body, not a sketch profile), not a fifth repeat of this pattern.
- No closed-loft or guide-curve support — unchanged pre-existing Loft v1 scope, untouched by this
  migration.

## Attempted (2026-09-14/15) — Parametric feature tree, Slice 5: migrate Fillet/Chamfer — BLOCKED, left unresolved

> **Update 2026-09-21:** the "works once per page load" blocker described below did **not** reproduce — two fillets on two bodies in one page load both succeeded. See the final entry of this file. The Slice 5 code is still partly live in the working tree (the Feature Tree lists fillets); whether to finish or remove it is still undecided.

Attempted to extend the parametric feature tree (Slices 1-4 above) to Fillet/Chamfer, following the
identical pattern: widen `FilletChamferRequest.targetBody` to `DocBodyRef`, add a `'filletChamfer'`
`FeatureRecord`/`ClientFeatureRecord` member, make `FilletChamferToolService.commit()` go through
`ModelingSessionService`'s persistent session instead of a one-shot `Worker`, register into
`FeatureTreeService`, and add a `handleFeatureEdit` replay branch plus Feature Tree panel UI (a
repeating per-edge value list — the first kind needing that, since Fillet/Chamfer has no flat
scalar params). All of that plumbing was built and is still present in the working tree
(`step-worker-messages.model.ts`, `step-loader.worker.ts`, `modeling-session.service.ts`,
`fillet-chamfer-tool.service.ts`, `feature-tree.service.ts`, `feature-record.model.ts`,
`tool-panels.ts/html`) — **but the pass did not ship**, because it surfaced a real, pre-existing
defect in this app's compiled OpenCascade.js WASM build that blocks it, not a bug in this slice's
own code. Left in place, uncommitted, rather than hand-reverted — see the "why not reverted" note
at the end of this entry.

**The blocking discovery, in the order it was found:**

1. Fillet/Chamfer's pre-Slice-5 design was session-LESS: every call spun up a brand-new one-shot
   `Worker` (`FilletChamferToolService.runWorker`), unlike Extrude/Revolve/Sweep/Loft's shared
   persistent `ModelingSessionService` session. Making it feature-tree-aware (so `handleFeatureEdit`
   can replay it) requires it to run through that same persistent session/worker instead.

2. Doing so exposed that **`BRepFilletAPI_MakeFillet`/`BRepFilletAPI_MakeChamfer`'s `.Build()`
   throws an uncatchable raw WASM error (`___cxa_is_pointer_type is not defined`, not a catchable
   JS `Error`) the SECOND time either class is constructed within the same Worker's lifetime** —
   isolated precisely via step-by-step `console.log` instrumentation around every line of
   `buildFilletChamferToolSolid` (the exact call: `maker.Build()` on the second construction,
   confirmed working fine through construction and `Add_2` on that same second call — only `Build()`
   itself throws). A fresh `initOcct()` module instance created in the SAME Worker does NOT avoid
   this (tried and confirmed still fails identically) — this is why the pre-Slice-5 one-shot-
   Worker-per-call design never hit it: every call got an entirely fresh Worker, so this class was
   always "first use" for its own Worker's lifetime, by construction, not by design intent.

3. The fix attempted: isolate the fillet/chamfer build itself in a genuinely fresh Worker, spawned
   per call. First tried spawning that fresh Worker FROM the primary session worker (nested
   Worker-in-Worker) — this failed outright in this dev environment: `new Worker(new URL(...),
   {type:'module'})` called from inside a Worker's own module scope fires `onerror` immediately
   with no diagnostic detail (empty message/filename/lineno), and the nested worker never receives
   even its first `postMessage`. Confirmed via instrumented logging this is a module-resolution/
   spawn failure, not a runtime error inside the nested worker's own code.

4. Redesigned to spawn the fresh Worker from the MAIN THREAD instead (`ModelingSessionService`),
   which is a proven-working pattern (every one-shot tool, including the pre-Slice-5 Fillet/Chamfer
   itself, already does exactly this). Added a `filletChamfer.needsBuild` / `.needsBuild.result`
   message round-trip so the primary session worker can ask the main thread to do the isolated
   build and relay the answer back — plus a `writeShapeToStepBytes` helper (factored from
   `handleExportStep`'s existing writer logic) so a target that's a PRIOR feature's own live
   `resultShape` (not just a STEP-imported body) can cross the Worker boundary as bytes, then get
   re-imported into the session's own `occt` module afterward for future chaining. This got the
   FIRST fillet/chamfer of a page session working end-to-end (verified via Playwright: edge picked,
   applied, Feature Tree row appeared).

5. **A second, deeper problem surfaced immediately after: the SECOND fillet/chamfer create — on a
   completely different body, going through a completely fresh Worker spawned fresh from the main
   thread, with no relationship to the first call's Worker, session, or replay machinery — also
   hangs indefinitely** (no error, no reply, confirmed via a standalone Playwright script applying
   two separate fillets to two different bodies with no edit/replay involved at all). This proves
   the WASM limitation is NOT "reused within one Worker" as first diagnosed in step 2 above — it's
   something that persists ACROSS Worker instances within the same page/tab lifetime (a cached
   compiled `WebAssembly.Module`, or some shared linear-memory/RTTI table at the browser or V8
   level — not yet root-caused further). Concretely: **this means `BRepFilletAPI_MakeFillet`/
   `MakeChamfer` can only ever be successfully built ONCE per page load, full stop** — not once per
   session, not once per Worker — a ceiling no Worker-isolation strategy from application code can
   work around.

**This is a pre-existing defect, not a regression introduced by this slice.** The second-fillet
hang reproduces with a Worker-spawn pattern structurally identical to the ORIGINAL, already-shipped
one-shot `FilletChamferToolService.runWorker` design — meaning a user applying Fillet/Chamfer twice
in the same page session (to two different parts, with no relation to Feature Tree editing at all)
would hit this exact same hang today, before this slice's changes, too. It was never caught before
because no prior manual testing or verify script (`verify-variable-fillet.mjs` included) ever
exercised a second fillet/chamfer in one page load — every existing test applies exactly one.

**Why the in-progress code was left in place rather than reverted:** the working tree already had
substantial legitimate uncommitted work from Slices 2-4 layered into several of the same files this
attempt touched (`step-worker-messages.model.ts` especially), with no clean commit boundary to
`git checkout` back to without also discarding that prior work. Hand-reverting only this slice's own
additions across ~8 interleaved files was judged too error-prone to do safely/automatically — left
in place, uncommitted, for direct review instead. The broken code paths are self-contained (inside
`handleFeatureFilletChamfer`/`buildFilletChamferToolSolid`/`runFilletChamferViaMainThread` in the
worker, `FilletChamferToolService.commit`/`commitEditOfFilletChamferFeature`, and the Feature Tree
panel's `filletChamfer` UI cases) and inert unless a user actually opens Fillet/Chamfer — nothing
else in the app depends on or is affected by them.

**Open questions for whoever picks this up next:**
- Root-cause the cross-Worker WASM persistence itself (try an opencascade.js version bump; check
  whether the issue is specific to `BRepFilletAPI` or affects other "Make*" builder classes too;
  check whether closing/reopening the actual browser TAB — not just the Worker — resets it, which
  would confirm it's tied to the page's own WASM module cache rather than something unrecoverable).
- If unfixable at the WASM/library level: the pre-Slice-5 one-shot design already silently has this
  "works once per page load" ceiling too — worth its own bug report/fix independent of Feature Tree
  work, since it affects today's shipped Fillet/Chamfer tool, not just this attempted migration.
- The rest of this slice's plumbing (STEP-bytes cross-Worker bridge, main-thread relay pattern,
  Feature Tree per-edge-list edit UI) is sound and reusable once/if the underlying WASM ceiling is
  resolved or worked around (e.g. if a real fix requires a full page reload between fillet/chamfer
  operations, the UI/message-passing layer built here would still mostly apply).

## Fixes and findings (2026-09-21) — production build, moved-body defects, multi-solid feature edits, and a corrected picture of what composes

Started from a gap analysis of this file and the user manual against professional mechanical CAD
(now in `context/cad-gap-analysis.md`), then ran the app to check the claims that were only ever
written down. Several statements in this file and in the manual turned out to be stale or wrong;
they are corrected here and in the manual.

**Production build fixed.** `ng build` failed with `Could not resolve "fs"` from
`opencascade.js/dist/opencascade.wasm.js` (a Node-only `require("fs")` branch that never runs in a
browser). Fix in `angular.json`: `externalDependencies: ["fs", "path"]` under the **production**
configuration only. Putting it in the base `options` breaks `ng serve` (Vite leaves a bare
`import "path"` in the worker and the browser can't resolve it), so it must stay production-only.
The `anyComponentStyle` budget was also raised to 24 kB warning / 32 kB error because
`tool-panels.css` is 19.5 kB (a symptom of the ~17-panel `ToolPanels` component). Verified: the
production bundle, served statically, loads the sample STEP (17 bodies, 51,002 triangles, ~16 s) with
zero console/page errors. Earlier entries' note that "`ng build` still fails for an unrelated
reason" no longer applies.

**Runtime results that correct earlier claims** (Playwright against the dev server and the production
bundle, using installed Chrome; Playwright's own bundled Chromium is not installed on this machine, so
the new scripts honour `PW_CHANNEL=chrome`):
- **Fillet works twice in one page load** (two different bodies, ~14 s each, no hang). The Slice 5
  blocker ("`MakeFillet/MakeChamfer.Build()` succeeds only once per page load") did not reproduce.
  Why it was seen earlier is unknown.
- **The "one feature per STEP body" ceiling no longer holds for sketch cuts and fillets.** Cut, cut,
  fillet on one imported body works and compounds (4,955,011 → 4,925,362 → ~4,919,792 → ~4,919,775 mm³).
  `hasStepSource` is still cleared by `replaceBody`, but these paths no longer depend on it being true.
  Shell, Draft, Hole Wizard, primitives and Loft targets were not re-tested.
- **A boss fuses correctly** when it actually touches the target (one solid, 11 faces). A fuse of two
  solids that only touch along a face also merges correctly in raw OCCT (checked in Node).

**Bug 1 — feature edits could destroy a body (fixed).** `handleFeatureEdit` returns every replayed
solid tagged with its feature's `producesBodyId`. A feature can yield more than one solid (a boss
that misses its target; a cut that splits a part). The client's four `commitEditOf*Feature` methods
mapped each result to a node with `findNodeIdForFeatureProduct(producesBodyId)`, so every solid of one
feature landed on the same node and the last overwrote the first — the block disappeared. Fix, in
`SketchService`: `addResultToScene` now records the node ids of non-first solids in
`extraNodeIdsByFeatureBody`; new `applyFeatureEditResult` groups results by `producesBodyId`, replaces
the primary node with the first solid, and `syncExtraSolids` updates/adds/removes the extra nodes.
Extras keep their own body ids so they never collide with the primary's. All four edit methods now go
through it. `FilletChamferToolService.commitEditOfFilletChamferFeature` has its own copy of the loop
and was left alone (a fillet yields one solid).

**Bug 2 — moved bodies (fixed).** A Move/Rotate/Scale gizmo drag changes only the Three.js mesh
transform; the kernel keeps the solid in its **original frame**. Three separate consequences:
1. `TreeService.replaceBody` dropped the transform, so any replace-in-place (Fillet, cut, Shell,
   feature edit) snapped a moved body back (position 400 → 0). It now copies position/quaternion/scale
   from the old mesh and recomputes the world-space `boundingBox`.
2. Face planes are picked in **world** space but were sent to the kernel as-is, so a cut on a moved
   body built its tool solid where the body used to be and removed nothing (silently: delta 0.0, no
   error). New `utils/body-frame.util.ts` `planeRefInBodyFrame(planeRef, mesh)` converts the plane
   into the body's own frame (sketch points are plane-local (u, v), so only the frame needs
   converting). It is applied in `SketchService.finishAndExtrude/Revolve/Sweep` (via
   `planeRefForTarget`) and `HoleWizardService`. Unmoved bodies and datum planes pass through
   unchanged, so their results are bit-identical.
3. Two call sites, `SketchService.beginFromFace` and `HoleWizardService`, passed
   `body.boundingBox.clone().applyMatrix4(body.mesh.matrixWorld)` to `CameraService.animateToFace`.
   `CadBody.boundingBox` is **already world-space**, so a moved body's offset was counted twice and the
   camera aimed 400 mm off. Also `extractFaceReferencePoints` read raw local geometry while the plane
   is world-space, so snap points sat at the body's old position; it now transforms boundary edges by
   `mesh.matrixWorld`.

**Frame conventions to keep straight** (no type distinguishes them, and this is where the bugs above
came from): `CadBody.boundingBox` = world space. `CadBody.geometry`/`edges`/`faceIdMap` = the body's local
(original) frame. `getFacePlane` = world space. Anything sent to the worker for a body = that body's
local frame. Verified for translation; rigid rotation is correct by construction but not tested;
non-uniform scale is not a rigid transform and is not handled.

**Was open at the time of this entry (fixed later the same day — see the face-anchoring entry at the end of this file): features did not follow the face they were sketched on.** Sketch
planes are sent as fixed origin/normal/uAxis numbers. Extrude a block 20 mm, fuse a boss on its top
face, then edit the block to 60 mm: the replay returns a plain 60 mm block (6 faces, z-max 60), and the
boss stays at the old plane and is absorbed. A cut is only less affected because its tool is built in
both directions. Fixing this needs persistent face/edge identity (record `Modified/Generated` per
operation and reference faces through that history) rather than raw numbers. Also untested: Loft's
first profile on a moved body, rotated bodies, Hole Wizard/Loft after a move.

**Testing.** New regression scripts in the repo root (need `ng serve --port 4300`;
`PW_CHANNEL=chrome` to use installed Chrome): `verify-moved-body-fillet.mjs`,
`verify-moved-body-cut.mjs`, `verify-feature-edit-multi-solid.mjs`. Pitfall found twice while writing
them: **a face pick starts a camera animation** (`animateToFace`), so profile clicks made straight after
the "drawing" hint land on the wrong spot; wait about 2.5 s before drawing. `verify-feature-edit-multi-solid.mjs`
depends on that same effect to place its boss off the block, so it is somewhat fragile. Separately, the
OCCT WASM runs in plain Node (the glue is an ES module using `__dirname`, so it needs a CommonJS copy and
the `.wasm` passed as `wasmBinary`), which is the natural basis for a kernel-level test harness that
doesn't need a browser.

## Feature work (2026-09-21) — Material assignment and mass properties, plus a working `ng test`

The cheapest high-value gap from `context/cad-gap-analysis.md`: until now a body only had geometric
Volume/Surface Area, with no density, mass, centre of gravity or inertia.

**Where the numbers come from — the world-space mesh, not a kernel round-trip.**
`utils/mass-properties.util.ts` `computeMassProperties(geometry, matrixWorld, referenceVolume?)` sums
signed tetrahedra to the origin over the body's triangles (divergence theorem; Eberly's polyhedral mass
properties): volume, centroid, and the second moments of volume about the centroid, then the inertia
tensor per unit density and its principal moments (closed-form symmetric 3×3 eigenvalues). Reasons for
this design over `BRepGProp` in the worker:
- it works for **every** body kind (STEP, primitive, feature, copy) — the kernel only holds a shape for
  some of them, and re-reading STEP bytes costs ~14 s of worker start-up per call;
- it is instant, so the Properties panel can recompute on every selection/transform refresh;
- it is evaluated in **world space** using `mesh.matrixWorld`, so a moved/rotated/mirrored body reports its
  real position (the frame convention recorded in the previous entry: geometry is local, this reads it
  through the world matrix).
Precision details that matter: accumulation is relative to the first vertex (models far from the origin
otherwise lose precision to cancellation when the centroid is subtracted — tested at 1e6 mm offset); an
inside-out mesh or a negative-determinant world matrix (Mirror uses negative scale) gives a negative signed
volume, so everything is flipped and reported positive; results are null for an empty/degenerate mesh.
Accuracy is that of the display tessellation, so the caller passes the kernel's exact `body.volume` as
`referenceVolume` and the result (volume and inertia) is scaled to it; mass uses the exact volume.
Checked on the sample assembly: mesh volume is within −0.5 % … +0.02 % of the kernel volume for all 17
bodies, i.e. every tessellation is watertight and the scaling is a small correction, not a cover-up.

**Materials.** `models/engineering-material.model.ts`: `EngineeringMaterial` (SI units — density kg/m³,
E and yield in Pa, ν) and `MATERIAL_LIBRARY` with 8 typical handbook materials (A36 steel, 304 stainless,
6061-T6 and 7075-T6 aluminium, Ti-6Al-4V, C11000 copper, grey cast iron, ABS). Values are for quick
estimates and are documented as such in the model and the manual; they have not been checked against a
standard. Deliberately separate from `MaterialProperties` (render appearance only), but in the same SI
units as the structural solver's `Material` so the two can be joined later. `CadBody.materialId?`
(unset = no density known, so no mass is invented). Copies made by Duplicate/Pattern/Mirror build their
`CadBody` with `...original`, so they inherit the material for free.

**Wiring.** `PropertyService`'s snapshot gained `mass` and `engineeringMaterial`, computed in
`showProperties` (so they refresh with every existing refresh path, including after a gizmo move);
`setMaterial(body, id | null)` follows the `setColor` shape. `SidePanels` has a "Mass Properties"
section (material dropdown; density, mass, centre of gravity, Ixx/Iyy/Izz, Ixy/Ixz/Iyz, principal
moments) and `onMaterialChange` goes through `HistoryService.run` like colour/opacity, so assignment is
undoable. Products of inertia below 1e-9 of the largest diagonal are shown as 0 (symmetric bodies
otherwise display ~1e-13 noise). Inertia is reported about the centre of gravity in world axes, in kg·mm².
One body at a time; there is no multi-selection or assembly roll-up yet, and principal-axis directions
are not exposed.

**`ng test` now works.** The Karma target bundled the worker and failed with the same `fs` resolution
error as the production build, so the unit-test target had never actually run. Fixed by adding the same
`externalDependencies: ["fs", "path"]` to the `test` target in `angular.json`. With
`CHROME_BIN` pointing at installed Chrome, `ng test --watch=false --browsers=ChromeHeadless` runs all
24 specs (the 11 new mass-properties tests, the structural solver and bridge-mesh specs, and
`app.spec.ts`) green. The new spec checks closed-form cases: box volume/centroid/inertia, a 50 mm steel
cube (0.98125 kg, I = m·a²/6), translation and 90° rotation, 1e6 mm offset, a mirrored matrix, a sphere
approaching 2/5·m·r², reference-volume scaling, and principal moments of a tilted body.

**Verified end to end** with `verify-mass-properties.mjs` (needs `ng serve --port 4300`;
`PW_CHANNEL=chrome`): no material shows only the centroid; steel 50 mm cube → 981.25 g, Ixx 408.9
kg·mm², products exactly 0; switching to 6061 aluminium scales mass to 337.5 g; a +400 mm move shifts the
centre of gravity from x=25 to x=425; Ctrl+Z removes the assignment; zero console errors.

**Not done / open:** roll-up for a multi-selection or an assembly; principal axes; custom materials; using
`youngsModulus`/`poissonsRatio`/`yieldStrength` in any calculation (stored only); linking a material to
the body's colour; a kernel `BRepGProp` cross-check for parts where the display mesh is coarse.

## Feature work (2026-09-21) — Measure tool: angle, face-to-face, radius/diameter

The Distance tool was the only measurement (the `MeasurementType` union already listed `angle`,
`radius`, `diameter` but nothing produced them). It is now one tool with four modes.

**Design: client-side, on top of picking that already existed — no kernel round-trip.**
`MeasureMode` = `'distance' | 'angle' | 'face' | 'circle'` (`models/measurement.model.ts`).
`MeasurementService` owns the mode, the in-progress picks (`pendingPoints`, `pendingFace`), a computed
`hint` (what to click next), and `lastError`. `Viewport.handleMeasureClick` routes by mode:
distance/angle raycast a point as before; face mode calls `SelectionService.pickFace`; circle mode calls
`SelectionService.pickEdge` (the same face/edge pickers Sketch, Shell, Draft and Fillet already use).
`Measurement` gained `text` (ready-to-display) and `anchor` (label position) so `labelPositions` no
longer assumes a two-point midpoint; its `distance` field is the primary value (mm, or degrees for an
angle). The `pendingPoint` signal was removed (`ToolPanels` now binds `mode`/`hint`/`lastError`).

**Pure geometry in `utils/measure-geometry.util.ts`** (13 unit tests, closed-form cases):
- `angleAtVertexDeg`: angle between two rays, null for a zero-length ray.
- `measurePlanes`: acute angle between two planes (|cos| folds opposite-facing normals together) and the
  perpendicular distance. Faces within `PARALLEL_TOLERANCE_DEG` = 0.5° count as parallel and report the
  distance; otherwise the angle is reported. Uses `getFacePlane` (world-space, area-weighted origin), so a
  non-planar face is rejected with a message.
- `fitCircle`: Kåsa algebraic least-squares circle in the points' best-fit plane (normal from summed
  cross products, in-plane basis, 3×3 normal equations). Returns null for collinear/too-few points or when
  the rms deviation exceeds 0.5 % of the radius, which is how an ellipse or a straight edge is refused
  instead of returning a nonsense radius. Edge polylines are 12 samples per edge (`WorkerEdge`), local
  frame, so they are transformed by `mesh.matrixWorld` first (per the frame convention in the 2026-09-21
  fixes entry). Works for full circles and arcs.

**Verified end to end** with `verify-measure-types.mjs` (needs `ng serve --port 4300`;
`PW_CHANNEL=chrome`), deterministic via the standard views (keys 1/5/6): on a 50 mm cube, top→bottom faces
give 50.00 mm (parallel), top→front give 90.00°, a 3-point angle on the top face gives 90.00°, Clear All
works; on a 25 mm-radius cylinder the rim gives R 25.00 mm / Ø 50.00 mm and clicking the curved side in
Faces mode shows "That face is not planar…". Zero console errors.

**Not done:** edge-to-face / edge-to-edge / minimum distance (the natural tool is `BRepExtrema_DistShapeShape`
in the kernel, which needs a shape handle per body — see the shape-store discussion in the gap analysis),
vertex/midpoint snapping for point clicks, measurements that follow a moved body (markers are scene objects
at fixed positions, as the Distance tool always was), and hover preview of the face/edge about to be picked.

## Feature work (2026-09-21) — Face anchoring: features follow the face they were sketched on

Resolves the "still open" item of the earlier 2026-09-21 fixes entry (a boss sketched on a block's top face
stayed at the old plane and was absorbed when the block's depth was edited).

**Why signature matching and not OCCT history.** A replay rebuilds the parent feature's shape from scratch
(a new prism), so `BRepBuilderAPI_MakeShape::Modified/Generated` cannot link the old shape's faces to the
new one's — history only links inputs to outputs within one operation. What survives a rebuild is the
face's geometry, so the worker matches on that. Kernel calls verified in Node first (this build exposes
them without overload guessing): `BRepAdaptor_Surface_2(face, true)` → `GetType()` / `Plane().Axis().Direction()`
(flipped when `face.Orientation_1()` is `TopAbs_REVERSED`, which gives the outward normal), and
`BRepGProp.SurfaceProperties_1` for area and centroid.

**Worker (`step-loader.worker.ts`).**
- `FaceSignature` {normal, centroid, area}; `FaceAnchor` {featureId, signature}; the session's stored sketch
  (`StoredSketch`) gained an optional `faceAnchor`.
- `planarFaceSignatures(shape)` lists every planar face's signature (non-planar faces are skipped).
- `sketch.commit` takes `faceAnchorFeatureId`. `anchorSketchToFace` finds the planar face of that feature's
  `resultShape` with the sketch plane's normal that contains the plane's origin (tolerance scaled to the
  shape) and stores its signature. No match is not an error: the sketch just stays fixed (e.g. a free
  reference plane).
- `reanchorSketch` runs inside `handleFeatureEdit`'s replay for every sketch-based feature. `findAnchoredFace`
  picks, among faces facing the same way (dot ≥ 0.999), the lowest `areaChange + 2·inPlane/scale +
  0.25·|along|/scale`: movement along the normal (the face got taller) is expected and lightly penalised,
  movement within the plane is not. The plane origin is shifted by the centroid displacement. The shift is
  always computed from the ORIGINAL stored plane and signature, never the previous replay's, so repeated
  edits and undo back to the original are exact. No matching face throws a clear error instead of building
  in the wrong place.
- The replay order makes this work without extra plumbing: the anchoring feature has already been replayed
  when its dependents are, so its `resultShape` is the edited one.

**Client.** `ModelingSessionService.commitSketch` takes an optional `faceAnchorFeatureId`;
`SketchService.faceAnchorFeatureId(pickedFace)` supplies it for Extrude, Revolve and Sweep when the picked
face's body is a feature output (`TreeService.getFeatureId`). STEP-imported and primitive bodies never
change, so they need no anchor. Loft's first profile, Hole Wizard, Fillet/Chamfer, Shell and Draft are not
anchored.

**Behaviour change to be aware of.** A cut sketched on a face now keeps its depth measured from that face
after the parent is edited. Verified: 20 mm block with a 30 mm cut from the top, block edited to 60 mm →
volume is exactly the 60 mm block minus a 30 mm-deep hole (previously the fixed plane made the tool pass
through the whole block, which was accidental rather than designed). The manual's §3.13 example was
rewritten accordingly.

**Verified** with `verify-feature-follows-face.mjs` (needs `ng serve --port 4300`; `PW_CHANNEL=chrome`): a
20 mm block with a fused boss (top 30 mm), edit to 60 mm → top at 70 mm, volume = 3 × block + boss exactly
(3,954,328 mm³), Ctrl+Z restores 1,335,682 mm³ / 30 mm exactly. `verify-feature-edit-multi-solid.mjs` was
updated: its off-block boss now also follows (30 → 70). All unit tests, the production build and the other
regression scripts pass.

**Known limitations / not done.**
- Matching is geometric, not a permanent identity. Two similar parallel faces (same normal, similar area)
  can be confused; there is no ambiguity warning yet — the best-scoring face is used silently. Real
  persistent naming would record `Modified/Generated/IsDeleted` per operation and reference faces through
  that history.
- Planar faces only. Edges, vertices, cylindrical/other faces are not anchored.
- Loft, Hole Wizard, Fillet/Chamfer (edge indices), Shell and Draft (face indices) still reference geometry by
  index and are not covered.
- A refused edit is not rolled back: `handleFeatureEdit` mutates the edited record's params and replays
  features in order, so when a later feature's anchor cannot be resolved the earlier features in this call have
  already been rebuilt in the worker while the client scene is unchanged. The next valid edit re-replays from
  the edited feature and puts the two back in step. (Pre-existing for any mid-replay failure; this adds a new
  way to trigger it.)

## Feature work (2026-09-22) — Sketch: freeform Polyline (multi-segment straight-line profiles)

Started on the sketch module (the biggest remaining gap per `context/cad-gap-analysis.md`), picking the
narrowest useful slice: a fifth `SketchShape` alongside the existing fixed-2-click rectangle/circle/
polygon/slot — `'polyline'` — that accepts any number of points (minimum 3) instead of a fixed count,
so concave/L-shaped/notched profiles are now drawable without a constraint solver.

**Why this was cheap: the wire-building machinery already generalizes.** `rectangleEntities` already
builds 4 chained `'line'` `SketchEntity`s, and `buildWireFromSketch` (worker) already chains an
arbitrary-length `lines` array into one `BRepBuilderAPI_MakeWire`. `polylineEntities` (client,
`sketch.service.ts`) is the same pattern generalized to N points — **zero worker changes** were needed.
Verified the concave case specifically in Node first (an L-shape, 6 points, the case no fixed shape can
produce): wire closes, extrude volume matches the hand-computed area exactly (54,000 mm³ for a 60×60
block minus a 30×30 corner, depth 20), 8 faces as expected.

**`SketchState` gained `closed: boolean`** (default false, reset by `setShape`/`begin*`). Every other
shape keeps completing automatically once it has enough points (`canFinishSketch` unchanged for them);
polyline instead keeps accepting points until `closed` becomes true, so `canFinishSketch` special-cases it
(`st.shape === 'polyline' ? st.closed : points.length >= SKETCH_SHAPE_POINT_COUNT[st.shape]`).

**Three ways to close a polyline, all converging on one `SketchService.closePolyline()`:**
1. **Click back on the start point** (`Viewport.handleSketchClick`) — screen-space distance to the first
   point's projected position, same `SNAP_PIXEL_THRESHOLD` (12px) technique `resolveSnap` already uses.
   New `SketchService.uvToWorld` (the exact inverse of `projectToPlane`, via new `planeUAxis`/`planeVAxis`
   covering both datum and face planes) makes this projection possible without a worker round-trip.
2. **Enter key** (`Viewport`'s existing keydown switch) when 3+ points are placed.
3. **Double-click** — but the browser fires a real `click` for BOTH presses of a double-click before the
   `dblclick` event itself. Without a guard, "double-click to finish" would add a near-duplicate point at
   (almost) the same spot as the one just placed, then close — a degenerate near-zero-length edge that a
   later boolean op could choke on. Fixed by deduping: a click within `SNAP_PIXEL_THRESHOLD` of the LAST
   placed point is ignored. `onCanvasDoubleClick` (which otherwise means "zoom to fit the clicked part")
   is overridden while a polyline is ready to close, so it calls `closePolyline()` instead.
   A 4th, panel-only way exists too: a **"Finish Polyline"** button, shown once 3+ points are placed —
   for users who'd rather not rely on a keyboard/double-click gesture.

**Live preview** (`Viewport.hypotheticalPreviewEntities`, now typed over the full `SketchShape` union):
an open chain of `'line'` entities between already-placed points, plus a rubber-band segment to the
cursor — `SketchRendererService.showPreview` needed no changes at all, since it already renders `'line'`
entities generically. Preview only renders while sketching on a **face** (`st.facePlane` gated), same
pre-existing limitation every other shape already has for datum-plane sketches — not introduced here,
not fixed here.

**New icon**: `polyline` (a 4-point zigzag with vertex dots) in `icon-registry.util.ts`.

**UI**: the shape-button row and hint text are duplicated between the Sketch panel and the Loft panel
(Loft drives `SketchService`'s own state directly per the 2026-09-13 Loft dated entry) — both were
updated identically, per this codebase's own per-panel-duplication convention. The hint text branches
separately for polyline (0 points / drawing, N so far, min 3 / closed) rather than reusing the existing
0/1/else structure, which would have shown "Profile ready." as soon as 2 points existed.

**Verified end to end** with `verify-sketch-polyline.mjs` (needs `ng serve --port 4300`; `PW_CHANNEL=chrome`),
one scenario per closing gesture: (1) a 6-point concave L-shape closed by clicking back on the start
point, extruded, 8 faces (2 caps + 6 sides) confirmed; (2) a 3-point triangle — confirmed it does NOT
auto-finish at exactly 3 points, then closed via **Enter**, extruded, 5 faces; (3) a 4-point quadrilateral
closed via **double-click**, extruded with no error and exactly 6 faces (2 caps + 4 sides — confirms the
double-click's own second click was correctly deduped, not left as a spurious 5th point). All 37 unit
tests, the production build, and every other regression script pass unchanged.

**Not done:** arcs/splines/ellipses/construction geometry within a polyline (straight segments only);
editing a committed polyline's points after the fact (same "draw again from scratch" limitation every
sketch tool has, pending the parametric feature tree covering sketches); a self-intersecting polyline is
not validated client-side — it surfaces as a worker boolean-operation error, same convention as every
other invalid-profile case in this app; live preview while sketching on a datum plane (pre-existing gap,
inherited, not fixed). The real prerequisite for the next sketch-module slice (a 2D constraint solver) is
unaffected either way — Polyline is pure geometry, no relationships.
