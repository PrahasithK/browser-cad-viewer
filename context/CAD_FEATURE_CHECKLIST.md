# 3D Mechanical CAD Feature Checklist

This is a living tracker for `browser-cad-viewer`'s progress toward professional-grade 3D mechanical
CAD parity (CATIA / SOLIDWORKS / Siemens NX / Autodesk Inventor / Fusion 360). Every item below was
verified against the actual codebase as of **2026-09-24** — not assumed from the presence of a UI
button. See `context/cad-gap-analysis.md` for the deeper architectural analysis behind these findings
(risks, priorities, effort estimates) and `context/architecture.md` for the dated history of what's
been built and fixed.

**Status legend:**
- `[x]` — fully working: verified end-to-end, not just "a button exists"
- `[ ] — PARTIAL` — real implementation exists but is limited, narrower than the professional-CAD
  version, or only reachable through one specific tool rather than as a general capability
- `[ ] — BROKEN` — implemented but has a known, reproducible defect
- `[ ]` (no suffix) — no real implementation found

## Progress

```
Total tracked features: 227

Fully working (x):     77
Partial:                33
Broken:                  3
Missing:               114

Weighted progress: 41.5% (working=1, partial=0.5, broken=0.25, missing=0)
Strictly "complete" (x only): 33.9%
```

*(Recomputed by counting every `- [x]` / `- [ ]` line in this file directly — not an estimate. Cross-
reference bullets like "Translate — same feature as Move above" intentionally use a plain `-` with no
checkbox, so they aren't double-counted. Recompute this block whenever items change status — see
§"Keeping this document current" at the bottom; the counting command is a one-liner over this file's
own `- [x]`/`- [ ]` lines, checking for the `PARTIAL`/`BROKEN` markers.)*

---

## A. 3D Navigation & View

- [x] Orbit / Rotate — `camera.service.ts:41,53`, real `OrbitControls`
- [x] Pan — `camera.service.ts:53` (middle-drag, `screenSpacePanning`)
- [x] Zoom — `camera.service.ts:41-45` (scroll wheel, works in persp + ortho)
- [x] Fit to View / Fit All — `camera.service.ts:77-124` (`fitAll`/`fitToBox`), bound to **F** key and toolbar
- [x] Front / Back / Left / Right / Top / Bottom — `view-preset.model.ts:8-16`, `camera.service.ts:169-185`, keys **1-6**, nav-cube face clicks
- [x] Isometric View — `view-preset.model.ts:15`, key **7**
- [x] Perspective View — real `THREE.PerspectiveCamera`, default camera
- [x] Orthographic View + switching — real `THREE.OrthographicCamera`, `setProjection()` toggles and preserves position/up
- [x] View Cube / Nav Cube — `viewport.ts:930-997`, real separate mini-scene, orientation-synced, clickable
- [ ] — PARTIAL Camera Controls (named presets) — only `resetCamera()` beyond the 6 standard + iso; no dimetric/trimetric/saved custom views
- [ ] — PARTIAL Section View — real GPU clipping (`section.service.ts`, `renderer.clippingPlanes`), but only axis-aligned (X/Y/Z world planes, no arbitrary/offset plane) and **no solid cap fill** at the cut surface (hollow interior, not a filled cross-section)
- Clipping — same mechanism as Section View above, not a distinct feature (not counted separately)
- [x] Grid — `viewer.service.ts:76-80`, real `THREE.GridHelper`, toggleable
- [ ] — PARTIAL Snap — real snap-to-geometry during sketch/hole-wizard drawing (`viewport.ts:637-660`), but **no general snap-to-grid** for transforms/gizmo drags
- [x] Axis Indicators — `viewer.service.ts:82-85`, real `THREE.AxesHelper`, toggleable

## B. Sketching

- [x] Create Sketch — real sketch-mode entry via Sketch/Loft panels
- [x] Select Sketch Plane — datum (XY/YZ/XZ) or a picked face, with body-frame conversion for moved bodies
- [x] Line — 2-click rectangle uses lines internally; standalone line entities supported
- [x] Polyline — freeform multi-segment straight-line profile (added 2026-09-22), any point count, concave allowed, close via click-on-start/Enter/double-click
- [x] Circle
- [ ] Arc — no arc entity type exists in `sketch.model.ts`
- [x] Rectangle
- [x] Polygon
- [ ] Ellipse — not in `sketch.model.ts`
- [ ] Spline — not in `sketch.model.ts`
- [ ] Point — no standalone sketch point entity
- [ ] Construction Geometry — no non-solid reference-only sketch geometry concept
- [ ] Offset — no offset-curve operation on sketch entities
- [ ] Trim — not implemented
- [ ] Extend — not implemented
- [ ] Mirror (sketch-entity mirror, distinct from body Mirror in §E) — not implemented
- [ ] Pattern (sketch-entity pattern, distinct from body Pattern in §E) — not implemented
- [ ] Project Geometry — cannot project an existing edge/face onto a sketch plane

**Note:** one closed profile per sketch; no dimensioning; a sketch is not a persistent, re-editable
document object (it's consumed once by the feature that uses it).

## C. Sketch Constraints

- [ ] Horizontal
- [ ] Vertical
- [ ] Coincident
- [ ] Parallel
- [ ] Perpendicular
- [ ] Tangent
- [ ] Concentric
- [ ] Equal
- [ ] Symmetric
- [ ] Collinear
- [ ] Fixed
- [ ] Distance Constraint
- [ ] Length Constraint
- [ ] Radius Constraint
- [ ] Diameter Constraint
- [ ] Angle Constraint
- [ ] Constraint Editing
- [ ] Constraint Deletion
- [ ] Fully Constrained Detection
- [ ] Under-Constrained Detection

**No constraint solver exists at all** — confirmed via direct source inspection
(`sketch.service.ts:48`'s own docstring explicitly scopes constraints out of v1). This is the single
largest gap for real parametric sketching and needs its own scoping decision (library choice,
constraint-type scope, dimension-editing UX) before implementation starts.

## D. Solid / Part Modeling

- [ ] — PARTIAL Extrude / Pad — works, boss/cut into an existing body, feature-tree editable (depth/cut), but only prismatic (no mid-plane/up-to-face end conditions), no thin-feature option
- [ ] — PARTIAL Revolve — works, boss/cut into existing body, feature-tree editable, but axis choice limited to sketch-plane U/V, no separate axis pick
- [ ] — PARTIAL Sweep — works, but it's a straight profile pulled along an axis with tilt/distance, **not a true path sweep** (no arbitrary 3D path, no guide curves)
- [ ] — PARTIAL Loft — 2+ profiles via `BRepOffsetAPI_ThruSections`, boss/cut into existing body. **Cut/Fuse coincidence bug fixed 2026-09-23** (profiles on the target's own surface used to silently remove/add ~0 volume). No guide curves, no closed-loop loft, no profile reorder/add/remove after creation, edit surface is Cut checkbox only. A separate, deeper `ThruSections` numerical instability for profiles on two adjacent perpendicular faces remains (rare, documented workaround in the user manual)
- [ ] — PARTIAL Boolean Union (Fuse) — only implicit, as the non-cut path inside Extrude/Revolve/Sweep/Loft against one target body — no standalone tool to combine two arbitrary existing bodies
- [ ] — PARTIAL Boolean Subtract / Cut — same: only implicit inside the four sketch-based features, one target body at a time
- [ ] Boolean Intersect — no intersect mode exists anywhere
- [ ] — BROKEN Fillet — works once, but editing a **second** fillet in the same session hits a real, reproducible WASM defect (`___cxa_is_pointer_type is not defined`) — pre-existing, root cause not yet found (see `context/architecture.md`'s 2026-09-14/15 entry)
- [ ] — BROKEN Chamfer — same underlying tool/service as Fillet, same defect
- [ ] — PARTIAL Shell / Thickness — works, single uniform thickness only, and **not feature-tree-aware** (can't be a target for a further cut/fillet in the same chained way Extrude/Revolve/Sweep/Loft/Hole Wizard now are)
- [ ] — PARTIAL Hole (Wizard) — real feature-tree-aware through-holes (metric/inch sizes, fit clearance), second hole on an already-modified body works (fixed 2026-09-22), **counterbore and countersink added 2026-09-24** (own `hole` feature kind; type and sizes editable in the Feature Tree, undoable; verified against analytical volumes by `verify-hole-wizard-feature-tree.mjs`). Still missing: blind (fixed-depth) and tapped/threaded holes, hole series, and a warning when a counterbore is deeper than the part (it silently becomes a wider through-hole)
- [ ] — PARTIAL Draft — works, **not feature-tree-aware**
- [ ] Rib — not implemented
- [ ] Groove — not implemented
- [ ] Thread — no real thread geometry (helical form) anywhere
- [ ] Face Offset — not implemented
- [ ] Move Face — not implemented (no direct-edit/history-free editing at all)
- [ ] Delete Face — not implemented
- [ ] Replace Face — not implemented

## E. Transform & Pattern

- [x] Move — `object-transform.service.ts`, real `TransformControls` gizmo, undoable
- [x] Rotate — same service/gizmo, undoable
- [x] Scale — same service/gizmo, undoable
- Translate — same feature as Move above, not counted separately
- [ ] — PARTIAL Mirror — real reflection math and a genuine new body, but only across fixed world-origin datum planes (XY/YZ/XZ) — no arbitrary/offset/picked-face plane. Produces a static, disconnected mesh copy (no link back to the original)
- [ ] — PARTIAL Linear Pattern — real per-instance translation math, single undo entry, but instances are **inert mesh clones**, not a real parametric feature (see Feature Pattern below)
- [ ] — PARTIAL Circular Pattern — same: real orbit/orientation math, same non-parametric caveat
- [ ] Path Pattern — `PatternKind` type only supports `'linear' | 'circular'`; no curve/path option exists
- [ ] Feature Pattern (parametric, regenerates with the original) — **not real**: pattern copies are plain `THREE.Mesh` clones registered as independent bodies with no `featureId` link back to the source. Editing the original does not propagate to its pattern copies, and there's no single pattern feature node to re-edit count/spacing/axis after the fact
- [x] Body Pattern — this is exactly what Linear/Circular Pattern above already do (pattern a whole selected body); counted as working at the "produces N new bodies" level, with the parametric caveat noted above

## F. Reference Geometry

- [x] Reference Plane — real offset-from-datum-or-face plane, live preview, feeds Sketch's plane-pick pipeline
- [x] Plane From Face — same mechanism as Reference Plane, offset=0 case
- Construction Plane — same feature as Reference Plane, not a distinct capability
- [ ] Reference Axis — no such service/model/renderer exists anywhere
- [ ] Reference Point (as a persisted, feature-tree entity) — only exists as transient snap targets during sketch/hole-wizard picking, not a real feature
- [ ] Coordinate System (custom local CSYS) — only world-fixed datum planes exist
- [ ] Center Axis (auto-derived from a cylindrical feature) — not implemented
- [ ] Axis From Geometry — no axis-construction code of any kind

## G. Selection

- [ ] Vertex Selection — no vertex-level pick method exists (`selection.service.ts` has mesh/edge/face pickers only)
- [ ] — PARTIAL Edge Selection — real (`pickEdge`), but only wired into specific tools (Fillet/Chamfer, Measure) — no general "edge select mode" toggle
- [ ] — PARTIAL Face Selection — real (`pickFace`), same caveat: only inside specific tools (Sketch, Shell, Draft, Reference Plane, Measure, Hole Wizard), not a standalone persistent-highlight mode
- [x] Body Selection — real click-to-select with highlight, `viewport.ts:432-440`
- [ ] Component Selection — no real assembly hierarchy exists to select "a component" as distinct from a body
- [ ] Box Selection — **explicitly removed** (confirmed via the code's own comment referencing "the now-removed box-select feature")
- [x] Multi-Selection — real ctrl/shift-click additive selection, Ctrl+A select-all
- [ ] Selection Filters — no entity-type restriction/mask concept exists
- [x] Selection Highlighting — real emissive tint + bounding-box helper + axis gizmo on selection and hover
- [x] Isolate Selection — real, hides every other body
- [x] Hide / Show — real, per-body visibility toggle + "Show All"

## H. Feature / Model Tree

- [x] Model Tree — real hierarchy (Assembly → import → Body N)
- [x] Part Hierarchy
- [x] Body Hierarchy
- [ ] — PARTIAL Feature History — exists as a flat, session-only list for 4 feature kinds (Extrude/Revolve/Sweep/Loft); not a full DAG, no cross-feature dependency graph
- [ ] Sketch History — a sketch is consumed once, not kept as its own persistent history entry
- [ ] Feature Dependencies — no dependency graph; features are a linear list with suffix replay
- [x] Rename Feature — `tree.service.ts:274` `renameNode`
- [ ] Suppress Feature — no suppress concept anywhere in the codebase
- [ ] Unsuppress Feature — n/a, suppress doesn't exist
- [ ] Reorder Features — confirmed absent (only code comments noting Loft profile reorder is unsupported, no feature-level reorder either)
- [x] Delete Feature — real, and undoable since 2026-09-24 (see §M Delete). Deleting a feature's body leaves its Feature Tree row in place (unchanged behavior)
- [x] Edit Feature — real, for Extrude/Revolve/Sweep/Loft via the Feature Tree panel; params re-apply and replay downstream
- [ ] Rollback (scrub the tree to an earlier point) — not implemented
- [x] Feature Visibility — same as Hide/Show above, works per body/node

## I. Assemblies

- [ ] Create Assembly — no real assembly document/component model exists
- [ ] Insert Component — n/a
- [ ] Remove Component — n/a
- [ ] Component Hierarchy — `TreeNodeType` has an `'assembly'` kind but it's just a tree grouping label, not a real component with its own transform/instance semantics
- [ ] Assembly Tree — same caveat, it's the Model Tree wearing an assembly label
- [ ] Mate — no mates/constraints between bodies exist
- [ ] Align — not implemented
- [ ] Concentric Constraint — not implemented (assembly-level; distinct from a sketch constraint, which also doesn't exist — see §C)
- [ ] Distance Constraint (assembly-level) — not implemented
- [ ] Angle Constraint (assembly-level) — not implemented
- [ ] Parallel Constraint (assembly-level) — not implemented
- [ ] Lock Component — not implemented
- [ ] Component Movement (drag with DOF, mate-constrained) — not implemented (the Move gizmo in §E moves a body freely, not with assembly DOF semantics)
- [ ] Assembly Relationships — not implemented
- [x] Exploded View — real: `exploded-view.service.ts`, radial separation from computed centroid, animated slider

## J. Measurement & Inspection

- [x] Distance Measurement — point-to-point
- [x] Angle Measurement — 3-point, vertex in the middle
- [x] Radius Measurement — circular-edge mode
- [x] Diameter Measurement — same circular-edge mode, both values shown
- [ ] Area Measurement — no interactive area-measurement tool (only passive per-body surface area in Mass Properties, not a pick-and-measure tool); note `MeasurementType` in `measurement.model.ts` declares an `'area'` variant but it's dead code — never wired into the actual `MeasureMode`/service/UI
- [ ] Volume Measurement — same: passive Mass Properties only, no interactive tool; same dead-code caveat as Area
- [x] Mass Properties — added 2026-09-21, real (kernel volume × density)
- [x] Center of Mass — added 2026-09-21, per body, follows moves
- [ ] Bounding Box (as a dedicated inspection tool) — exists as a property-panel readout, not a standalone measurement/inspection tool
- [ ] Geometry Inspection (general validity/quality check) — not implemented
- [ ] Section Analysis (measuring/annotating a section cut) — Section View itself exists (§A) but there's no analysis/measurement layered on top of it
- [ ] — PARTIAL Face-to-Face Measurement — real (parallel distance or angle between two planar faces), counted under the "face" mode above but listed here since it's its own capability

*(Face-to-face is the same underlying tool as Angle/Distance above — 4 real modes total: distance,
angle, face, circle/radius-diameter.)*

## K. Materials & Appearance

- [x] Material Selection — real engineering-material assignment (8 materials), undoable
- [x] Material Properties — density, Young's modulus, Poisson's ratio, yield strength, used for real mass computation
- [x] Color — real per-body color picker, undoable
- [x] Transparency — real opacity slider + global "Transparent" shading mode, undoable
- [ ] — PARTIAL Metallic Appearance — the value exists in the data model and is set at mesh-creation time, but there's **no user-facing slider** to change it
- [ ] — PARTIAL Roughness — same caveat as Metallic: in the model, hardcoded at creation, no UI control
- [ ] Texture — no image-texture mapping anywhere (no `TextureLoader` usage found)
- [ ] — PARTIAL Lighting — a real 3-light rig (ambient + hemisphere + directional with shadows) exists, but it's fixed at scene setup with no UI to reconfigure intensity/color/direction
- [x] Shadows — real, `PCFSoftShadowMap`, every body casts/receives
- [ ] — PARTIAL Rendering (quality settings) — antialiasing on by default, pixel ratio capped, a `setPixelRatio` method exists, but no settings panel exposes any of it to the user; shading-mode toggle (solid/wireframe/transparent) IS user-facing and works

## L. File Management

- [x] New Document — File → New (2026-09-24), clears scene, tree, Feature Tree, undo stack and modeling session; asks first if parts are loaded
- [x] Open — STEP files, and `.cadproj` projects via File → Open Project… (2026-09-24)
- [x] Save — File → Save Project / Ctrl+S downloads a `.cadproj` (2026-09-24); verified by `verify-project-save-open.mjs` (save → page reload → open → every body, the Feature Tree and the kernel feature history match; features stay editable, imported parts stay cuttable)
- [ ] Save As — n/a, Save doesn't exist
- [ ] — PARTIAL Import Model — STEP/STP only; **no IGES, OBJ, glTF, or STL import**
- [x] STEP export — real, for bodies that retained their STEP source (skips others with a reported warning)
- [x] STL export — real, works for every body regardless of origin
- [ ] IGES export — not implemented
- [ ] OBJ export — not implemented
- [ ] glTF / GLB export — not implemented
- [x] Native Project Format — `.cadproj` (2026-09-24): scene snapshot + kernel replay log + original STEP files, gzip-compressed; see `ProjectService`. Not yet saved: reference planes, structural model, measurements, section planes, undo history, Mesh View overlays
- [ ] Recent Files — not implemented
- [ ] Auto Save — not implemented

## M. Editing & History

- [ ] — PARTIAL Undo — real (`HistoryService`), but scope is limited: covers Move/Rotate/Scale, Mirror, Pattern, Duplicate, Delete (since 2026-09-24), and **Feature Tree edits** (changing an existing Extrude/Revolve/Sweep/Loft's params) — but **not** the original creation of a feature (Sketch → Extrude/etc. the first time), not Fillet/Chamfer/Shell/Draft/Hole Wizard operations, and not STEP import
- [ ] — PARTIAL Redo — same scope and same gaps as Undo (they're one mechanism)
- [x] Copy / Duplicate — real, undoable (`contextMenuDuplicate`-style flow, confirmed wrapped in `history.run`)
- [ ] Paste — no clipboard concept; Duplicate creates an offset copy directly, there's no separate copy-then-paste-elsewhere flow
- [x] Duplicate — see Copy above
- [x] Delete — undoable since 2026-09-24 (Ctrl+Z restores the same tree node, place, feature link and STEP source; verified by `verify-delete-undo.mjs`, including cutting a hole into the restored part). Previously BROKEN: **explicitly irreversible** ("This cannot be undone" — the app's own confirmation dialog says so) — not on the undo stack at all
- [x] Feature Editing — see Feature Tree §H; real for the 4 migrated feature kinds
- [x] Parameter Editing — same, via the Feature Tree edit forms
- [ ] — PARTIAL Dependency Updates (regeneration cascades to downstream features) — works for the specific, tested chains (a boss/cut following an edited parent's face — face-anchoring, fixed 2026-09-21), but there's no general dependency graph, so untested chains may not propagate correctly
- [x] Model Regeneration — real replay-from-sketch mechanism powers every Feature Tree edit
- [x] Error Handling — real, per-tool `lastError` signals surfaced as visible UI text, not just `console.error`

## N. Professional CAD UX

- [x] Main Toolbar — real ribbon, grouped buttons, wired to real tools
- [ ] — PARTIAL Contextual Toolbar — buttons enable/disable by selection and panels swap per active tool, but there's no toolbar that visually reflows its button set by selection type
- [x] Properties Panel — real, always-visible, reacts to selection, resizable
- [x] Feature Dialogs — real dedicated parameter panel per feature with live apply/commit and per-feature error state
- [x] Context Menus — real right-click menu with working actions
- [x] Keyboard Shortcuts — real (Esc/Delete/F/Enter/M/S/G/R/Y/Ctrl+Z/Ctrl+Y/1-7), guarded against input focus
- [ ] Command Search — no command palette (Ctrl+K style) exists
- [x] Tooltips — real, extensive, including shortcut hints
- [x] Status Bar — real, live selection/body-count/triangle-count/cursor/fps/projection/units
- [x] Selection Feedback — same as Selection Highlighting (§G)
- [x] Operation Preview — real, live preview geometry for Sketch, Reference Plane, Fillet/Chamfer hover
- [x] Progress Indicators — real, spinner + percent + body-count progress during STEP load
- [x] Error Messages — real, user-facing panel text and alert dialogs, not just console output
- [ ] Responsive Layout — **zero** `@media` breakpoints anywhere in the codebase; fixed-size chrome only
- [ ] — PARTIAL Dark Theme / Light Theme — a real toggle exists but only changes the 3D viewport background color; the surrounding UI chrome (toolbar/panels/menus) has no theme system at all (no CSS variables, no `.dark`/`data-theme` selectors)

## O. Advanced CAD

- [ ] — PARTIAL Parametric Modeling — real for 4 feature kinds (Extrude/Revolve/Sweep/Loft) plus Hole Wizard (its own `hole` kind since 2026-09-24), numeric params only, saved and restored with projects (§L)
- [ ] — PARTIAL Feature Dependencies — see §H, same caveat (linear list, not a DAG)
- [ ] — PARTIAL Design History — the Feature Tree is a real, replayable history for the migrated feature kinds; not all tools participate (Fillet/Chamfer/Shell/Draft/Hole Wizard's counterbore variant aren't all equally covered — see §D/§H)
- [x] Multiple Bodies — real, a scene can hold and independently address many bodies
- [ ] Surface Modeling — no surface (non-solid, open-shell) modeling tools exist
- [ ] Advanced Surfacing — n/a
- [ ] Sheet Metal — not implemented
- [ ] Weldments — not implemented
- [ ] 2D Drawings — not implemented
- [ ] Dimension Annotations (drawing-level) — not implemented (in-viewport measurement labels exist, §J — that's a different thing)
- [ ] BOM — not implemented
- [ ] Assembly Drawings — n/a, no drawings exist
- [ ] Engineering Drawings — not implemented
- [ ] GD&T — not implemented
- [ ] — PARTIAL Simulation Integration — a real frame/beam structural solver exists (static analysis, load/support definition, results rendering) but it's narrow (no solid FEA, no meshing, no contour stress results on arbitrary geometry)
- [ ] CAM / Manufacturing Integration — not implemented

---

# Implementation Roadmap

Organized by dependency order — foundational work near the top unblocks everything below it. Each
phase's own items are drawn directly from the checklist above; check them off there as they land, and
mirror the checkbox here.

## Phase 1 — Foundation
- [ ] Native document format (save/open/autosave) — see §L; save/open/New done 2026-09-24, **autosave and recovery still open**
- [ ] Undo/redo coverage extended to geometry creation and STEP import — see §M (Delete done 2026-09-24)
- [ ] Feature dependency graph (replace the linear feature list with a real DAG) — see §H/§O

## Phase 2 — Sketching
- [ ] Sketch constraint solver (needs its own scoping: library choice, constraint set, dimension UX) — see §C
- [ ] Arc, Spline, Ellipse, Point, Construction Geometry entities — see §B
- [ ] Sketch Trim/Extend/Offset/Mirror/Pattern — see §B
- [ ] Sketch as a persistent, re-editable document object

## Phase 3 — Solid Modeling
- [x] Extrude, Revolve, Sweep (straight), Loft — done, with known partial gaps noted in §D
- [ ] Fix the Fillet/Chamfer second-edit WASM defect (§D, BROKEN)
- [x] Counterbore/countersink (§D — done 2026-09-24; blind/tapped holes still open)
- [ ] Standalone Boolean Combine/Split (arbitrary bodies, not just one-target-per-feature) — §D
- [ ] True path Sweep (guide curves, arbitrary 3D path) — §D
- [ ] Rib, Groove, Thread, direct-edit (Move/Delete/Replace Face) — §D

## Phase 4 — Feature History
- [x] Feature Tree exists for 4 feature kinds + Hole Wizard — §H
- [ ] Suppress, Reorder, Rollback — §H
- [ ] Shell/Draft/Fillet-Chamfer migrated onto the feature tree (parity with Extrude/Revolve/Sweep/Loft) — §D/§H

## Phase 5 — Assemblies
- [ ] Real component model (distinct from a body) — §I
- [ ] Mates (concentric/distance/angle/parallel) — §I
- [x] Exploded View — done — §I

## Phase 6 — Advanced CAD
- [ ] Surface Modeling — §O
- [ ] Sheet Metal — §O
- [ ] 2D Drawings + BOM + GD&T — §O
- [ ] Solid FEA (beyond the existing frame/beam solver) — §O

---

# Keeping this document current

This document is not a one-time snapshot — update it whenever a feature's real status changes:

```
Implement → Test (real kernel/Playwright verification, not just "no error thrown") → Check the box → Update the Progress block
```

A feature only earns `[x]` when: the user can select valid input, enter parameters, see a preview
(where applicable), the operation produces correct geometry, the result appears in the tree, params
can be edited afterward, errors are handled visibly, undo/redo works for it (or its absence is
explicitly noted), and no existing functionality broke. A button that opens a panel is not evidence of
completion by itself — the underlying operation has to actually work, verified against the running
app.

When a new gap is discovered during future work, add it to the relevant section rather than letting it
go untracked — this checklist should always reflect the real, current state of the project, the same
discipline `context/architecture.md`'s dated entries and `context/cad-gap-analysis.md`'s own verification
appendix already use.
