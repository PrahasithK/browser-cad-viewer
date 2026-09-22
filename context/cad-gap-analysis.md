# Gap Analysis: Browser CAD Viewer vs. a Professional 3D Mechanical CAD Platform

Sources: `context/architecture.md` (2,998 lines) and `context/user-manual.md` (1,721 lines), both read in full.
Plus a handful of direct code/repo checks (section 0.2) where the docs alone were not enough.
Reference class: SolidWorks / CATIA / STAAD.Pro-style scope, as requested.

---

## 0. How to read this document

### 0.1 Status vocabulary (as requested, with the rule I applied)

| Status | Rule used |
|---|---|
| **Implemented** | Docs describe it as shipped **and** describe a concrete verification (Playwright run, numeric before/after check). I did not re-run the app; runtime claims are the docs' claims. |
| **Partially implemented** | Shipped, but a material sub-capability is missing, or it only works on a subset of bodies. |
| **Planned** | Named in `architecture.md` "Future roadmap" / planning notes or `user-manual.md` §11 as a known gap, **nothing built**. Planned means "someone wrote it down", not "designed". |
| **Missing** | Not mentioned in either document. |
| **Unclear from documentation** | Docs are silent, contradictory, or the claim can't be judged without running the code. |

Priority: **P0** = blocks everything else / must precede feature work · **P1** = core professional-CAD capability · **P2** = expected in a mid-tier product · **P3** = differentiator / later tier.
Complexity: Low / Medium / High / Very High.

### 0.2 Facts I verified directly (not taken from the docs)

| Check | Result |
|---|---|
| `ng build` (production) | Initially **failed** (`Could not resolve "fs"` from `opencascade.js`). **Fixed during this session**: `externalDependencies: ["fs","path"]` added to the **production** configuration in `angular.json` (adding it to the base options breaks `ng serve`), and the component-style budget raised to 24/32 kB because `tool-panels.css` is 19.5 kB. The production bundle then loaded the sample STEP file (17 bodies, 51,002 triangles) in Chrome with 0 console/page errors. |
| Service count | **39** `*.service.ts` files. `architecture.md` says 24 in one place, 25 in another. |
| Automated tests | Originally **3 spec files, and `ng test` could not run** (same `fs` error as the production build). **Fixed 2026-09-21**: `externalDependencies` added to the `test` target; with `CHROME_BIN` set, `ng test --watch=false --browsers=ChromeHeadless` runs 24 specs green (added `mass-properties.util.spec.ts`, 11 tests). Kernel verification is still mostly hand-run `verify-*.mjs` Playwright scripts at the repo root (12 now). |
| Kernel result validation | Grep for `BRepCheck`, `ShapeFix`, `ShapeUpgrade`, `BOPAlgo`, `Precision`, `SetTolerance` in `src/app`: **zero hits.** |
| Persistence | Only `localStorage` for panel layout. No IndexedDB, no File System Access API, no `beforeunload` guard. |
| Workers | `new Worker(step-loader.worker.ts)` appears at **7 call sites** (draft, export, modeling-session ×2, shell, step-loader ×2); each spawn is a fresh OCCT WASM init (docs: 30–40+ s cold start). The worker file is **2,090 lines** in one module. |
| Rendering scale features | No `three-mesh-bvh`, `InstancedMesh`, `LOD`, `OffscreenCanvas`, or WebGPU anywhere. |
| Kernel/lib versions | `opencascade.js ^1.1.1`, `three ^0.185.1`, Angular 20.3, TS strict. `opencascade.d.ts` in `models/` exists but the docs say no usable typings exist for overload names. |
| "Material" model | `MaterialProperties = {color, opacity, metalness, roughness, wireframe}`: a render material. **No density, modulus, or any engineering property.** |

### 0.3 Where the two documents contradict each other or reality

These matter because they change what a reader would conclude is "implemented".

| # | Contradiction | Consequence |
|---|---|---|
| C1 | Manual **Example B step 7** (cut a hole, then Fillet its edges) and **Example C step 4** (box → cut → fillet) contradict the manual's own limits (§5.3, §3.11: Fillet only on pristine STEP bodies). **Runtime test: cut → cut → fillet on one imported STEP body works in the current code**, and each step compounds (volume 4,955,011 → 4,925,362 → 4,919,792 → 4,919,775 mm³). So the manual's restriction is **stale** and Example B is achievable. Example C (primitive) was not tested. | The manual's limitation text and the code have drifted: users are told they can't do things they can. |
| C2 | Architecture (2026-09-14/15, Slice 5) says `MakeFillet/MakeChamfer.Build()` works **once per page load** and that a second use hangs. **Not reproduced**: two fillets on two different bodies in one page load both completed (production bundle, current working tree, stable Chrome), each ~14 s. Why the docs saw a hang is unknown (environment, dev server, or earlier code state). | Slice 5's stated blocker is unproven. |
| C3 | Manual Example C step 5: "remember: there is no model export yet." Export STEP/STL shipped 2026-08-17. | Stale text. |
| C4 | Manual §1 says "Section 12 lists everything planned". The manual ends at §11. | Broken reference. |
| C5 | Architecture intro says undo "deliberately does NOT cover … geometry-creating operations" and that there are "only 4 components". Later entries add Pattern/Mirror/Feature-tree-edit undo and 15+ panels inside one component. | Intro is stale; a reader of the first 50 lines gets a wrong picture. |
| C6 | Architecture repeatedly cites "§7 in the Feature work entries" (structural solver), "the plan doc", "conversation history". **No dated entry describing the structural solver or Bridge Mesh design exists in the file.** | FEA claims rest on the manual + one spec file; the solver's element formulation, DOF model, units and section/material handling are undocumented. |
| C7 | Manual §7.1 workflow never mentions assigning a **section** or **material** to a member, yet the architecture says the model has "sections". | Either an undocumented default is used silently or the workflow is incomplete. **Unclear.** |
| C8 | Manual says a Loft-produced body cannot be a cut target; architecture Slice 4 gives Loft a `featureId`. | Whether other features can target a Loft's output is **unclear**. |
| C9 | Architecture's own roadmap says §1 and §3–§15 "may be stale"; several items in them shipped afterwards. | The roadmap is not a reliable current-state list. This document supersedes it. |

---

### 0.4 Runtime test results (run this session)

Tests were Playwright scripts against the dev server and the production bundle, using installed Chrome. Scripts are in the session scratchpad, not in the repo.

| # | Question | Result |
|---|---|---|
| T1 | Does the production bundle load a STEP file? | **Yes.** 16.4 s, 17 bodies, 0 errors. |
| T2 | Does Fillet work twice in one page load? | **Yes.** Two fillets on two bodies; Body 1 volume matches the docs' verified 4,953,852.80 mm³. ~14 s each. Second body's geometry change was not measured. |
| T3 | Is a gizmo-style move honoured by later kernel operations? | **No, and it also broke cuts. Fixed this session.** Before: after moving Body 1 +400 mm and filleting, position returned to 0.0; a face-sketch cut on a moved body was a **silent no-op** (volume delta 0.0). Three causes: `TreeService.replaceBody` dropped the mesh transform; the sketch plane was sent to the kernel in world space while the kernel holds the solid in its original frame; and `beginFromFace`/Hole Wizard applied the body transform twice to the bounding box (camera aimed 400 mm off) while snap reference points stayed in local space. After: position stays 400, and the cut on the moved body matches the unmoved control exactly (−29,649.1 mm³). |
| T4 | Does a boss sketched on a block's top face follow the block when its depth is edited? | **Was no; fixed 2026-09-21.** Before: block 20→60 mm left the boss at its old plane and it was absorbed (top at 60, not 70). After face anchoring: top at **70 mm**, volume exactly 60 mm block + boss (3,954,328 mm³), and Ctrl+Z restores 30 mm / 1,335,682 mm³ exactly. A cut now follows its face too and keeps its depth from that face. Also fixed earlier: a feature yielding several solids overwrote the block on edit. *(An earlier "unfused boss" claim was a test error and is retracted.)* |
| T5 | After one cut on a STEP body, can a second cut and a fillet act on it? | **Yes.** Cut #2 compounded on cut #1; a fillet afterwards changed volume by only −16.5 mm³ (both cuts kept). The docs' "one feature per body" restriction no longer holds for these tools. Shell, Draft, Hole Wizard, Pattern, Mirror were not re-tested. |

---

## 1. Gap analysis tables

Legend for "Recommended architecture": the module names refer to the target structure in §7.5.

### 1.1 3D modeling

| Area | Capability | Existing implementation | Status | Missing functionality | Pri | Recommended architecture |
|---|---|---|---|---|---|---|
| Modeling | Sketcher | 4 fixed 2-click shapes plus a freeform straight-line **Polyline** (any point count, concave allowed; added 2026-09-22), **one closed profile per sketch**, on datum/face/offset planes, snap to face reference points | **Partial** | Arcs, splines, ellipse, construction geometry, trim/extend/offset/mirror, multi-loop profiles, re-editing a sketch after use; sketch is not a persistent object | P0 | `sketch` module: entity graph + solver adapter; sketch = a node in the feature DAG |
| Modeling | 2D constraints & dimensions | None | **Planned** | Whole constraint system, driving dimensions, fully/under/over-defined state | P0 | Use an existing solver (planegcs / SolveSpace); do not write one |
| Modeling | Parametric modeling | Feature Tree for **Extrude, Revolve, Sweep, Loft**, numeric params only; suffix replay; edit is undoable | **Partial** | Sketch editing, all other features, DAG, rollback, suppress, reorder, persistent references | P0 | Feature DAG + regeneration engine in `document`/`kernel` |
| Modeling | Extrude | Blind depth, boss or cut, both-way tool for cuts | **Partial** | Mid-plane, up-to-surface/body/next, offset start, draft angle, thin-wall, multi-profile/contour selection, "merge result" option | P1 | Feature-type registry with declarative parameter schema |
| Modeling | Revolve | Sketch-plane U or V axis, 1–360°, boss/cut, into existing body | **Partial** | Drawn centerline or edge as axis, two-direction, thin revolve | P1 | Same |
| Modeling | Sweep | **Straight, tilted path only** (0–89°); effectively an oblique extrude | **Partial** | Path along curve/edge/sketch, guide curves, twist, orientation control, profile-on-face. A real sweep does not exist yet | P1 | OCCT `BRepOffsetAPI_MakePipeShell` behind a feature type |
| Modeling | Loft | 2+ profiles via `ThruSections`, boss/cut into existing body; edit = Cut checkbox only | **Partial** | Guide curves, closed loop, end tangency, profile add/remove/reorder after creation, centerline loft | P2 | Feature type with profile list as references |
| Modeling | Boolean operations | Only implicit: a cut/fuse against **one** target body inside Extrude/Revolve/Sweep/Loft | **Partial** | Combine (add/subtract/intersect) between arbitrary bodies, split body, keep-tools, multi-body scope | P1 | `Combine`/`Split` feature types; body-ref inputs |
| Modeling | Fillet / Chamfer | Edge picking, radius or distance **per edge**, multi-edge, STEP-imported bodies, including ones already cut in-session (verified); Feature Tree lists fillets in the working tree | **Partial** | Docs' once-per-page hang **not reproduced (C2)**; ~14 s per fillet (fresh worker + OCCT init); radius tapering along an edge, face fillet, full-round, setback, tangent propagation, two-distance/angle chamfer; behaviour on primitives untested | P1 | Kernel adapter + persistent naming so edge refs survive; feature type |
| Modeling | Shell | Uniform thickness, remove picked faces, STEP pristine bodies only; positive-volume `Complemented()` repair | **Partial** | Multi-thickness, outward shell, in-app bodies, feature tree, robust failure modes | P1 | Feature type + validation gate |
| Modeling | Patterns | Linear/Circular, axis-aligned, count incl. original; **creates transform-only mesh clones**, not B-Rep | **Partial** | Pattern of a *feature*, curve/table/fill/sketch-driven, skip instances, linked instances, arbitrary axis/direction. Copies cannot be cut, filleted, exported to STEP | P1 | Pattern as feature operating on B-Rep, instances share definition |
| Modeling | Mirror | 3 datum planes; negative-scale mesh clone; exact only for unrotated bodies (documented approximation) | **Partial** | Arbitrary plane/face mirror, mirror-of-features, exact reflection for any pose, real B-Rep result | P1 | `BRepBuilderAPI_Transform` with mirror `gp_Trsf` in kernel |
| Modeling | Hole features | Through-hole clearance presets: metric M3–M12, inch #4-40…3/8-16, close/normal/loose | **Partial** | Counterbore, countersink, tapped/threaded, blind, hole series, multiple holes, cosmetic threads, hole table | P1 | Hole feature (composite tool solid) + standards library |
| Modeling | Draft | Faces on STEP pristine body; **world +Z pull only**; neutral plane placed at min-Z vertex (found after ~10 failed hypotheses) | **Partial** | User pull direction, neutral plane / parting line, per-face angle, draft analysis | P2 | Feature type; requires validation gate (Draft "succeeded" with no-op geometry repeatedly) |
| Modeling | Direct modeling | None | **Planned** (push/pull) | Move/offset/delete face, replace face, defeature | P2 | Kernel adapter ops (`BRepOffsetAPI_MakeOffset`, `BRepAlgoAPI`, `BRepFeat`) |
| Modeling | Surface modeling | None (Bridge Mesh is a display-only overlay) | **Planned** | Extruded/revolved/swept/lofted/boundary/fill/offset surfaces, knit, trim | P2 | Non-solid feature outputs in the same DAG |
| Modeling | Sheet-metal modeling | None | **Planned** | See §1.5 | P2 | `sheetmetal` module |
| Modeling | Weldments / structural members | None as solids. The structural (FEA) workflow has analytical line members only | **Planned** | Profile-driven solid members, trim/extend, gussets, cut list, weld beads | P2 | `weldment` feature family over sketches/edges + profile library |
| Modeling | Multi-body modeling | Many bodies in a scene/tree; no operations between them except one-target cut/fuse | **Partial** | Body-level booleans, body ownership per feature, merge/keep, bodies-as-tools | P1 | Bodies become first-class document objects with owner feature |
| Modeling | Primitives | Box/cylinder/sphere/cone, click-to-place | **Partial** | No history, not a cut target, no fillet/shell/etc. | P2 | Same feature registry (primitive = feature) |
| Modeling | Reference geometry | Offset reference planes (datum or face base), named | **Partial** | Angled / 3-point planes, axes, points, user coordinate systems | P2 | `document` reference objects |
| Modeling | Body transforms | Move/Rotate/Scale gizmo on the **Three.js mesh**; kernel keeps the solid in its original frame | **Partial (defects fixed this session, T3)** | Fillet, cut and feature-edit on a moved body used to teleport it back or silently do nothing; fixed for translation (verified) and by construction for rigid rotation (not tested). Non-uniform scale on a B-Rep is still not a rigid transform. Hole Wizard, Loft first-profile and datum-plane sketches on moved bodies were not re-tested | P1 | Kernel owns placement; view transform derived from it (long-term) |
| Modeling | Part and feature history | Feature Tree panel (4 kinds), undoable edits | **Partial** | See "Parametric" §1.9 | P0 | as above |

### 1.2 Assemblies

| Area | Capability | Existing implementation | Status | Missing functionality | Pri | Recommended architecture |
|---|---|---|---|---|---|---|
| Assembly | Assembly creation | Fixed 3-level tree Assembly → Import → Body; "Open" **replaces** the scene; STEP assembly structure is flattened into "Body N" | **Partial** | Part vs assembly documents, component instances with their own transforms, insert-component, multi-file import | P0 | `assembly` module: definition/instance split |
| Assembly | Mates / constraints | None (parts positioned by hand) | **Planned** | Coincident, concentric, distance, angle, parallel, gear/cam, DOF display, drag-solve | P0 | Mate graph + geometric solver (own thin layer on a solver lib) |
| Assembly | Subassemblies | None (tree depth is fixed) | **Planned** | Nested assemblies, flexible/rigid | P0 | Recursive component tree |
| Assembly | Configurations | None | **Planned** (design tables) | Named variants, suppression per configuration, config-specific params | P2 | Configuration layer over feature params/suppression |
| Assembly | Interference detection | None | **Planned** | Static interference report, volume of overlap | P1 | OCCT `BRepAlgoAPI_Common` / `BRepExtrema`; broad-phase BVH |
| Assembly | Collision detection | None | **Missing** (only interference listed) | Dynamic collision during drag/motion | P2 | Broad-phase BVH + mesh narrow-phase |
| Assembly | Exploded views | Radial slider 0–500 from centre; display-only | **Partial** | Per-component steps/directions, explode lines, saved/named, animation export | P2 | Explode steps stored in assembly document |
| Assembly | Assembly motion | None | **Planned** | Mechanism simulation, motion study | P2 | Depends on mates; kinematic solver |
| Assembly | Large-assembly performance | 17-body sample only; FPS counter; one `Mesh` per body | **Unclear / Missing** | Instancing, LOD, culling, lightweight/resolved modes, streaming | P1 | Render module (B28) |
| Assembly | Bill of materials | None | **Planned** | Item numbers, quantities, custom properties, BOM export | P1 | Derived from assembly + properties |
| Assembly | In-context / component references | None; cross-feature refs exist only inside one Feature Tree session | **Missing** | External/in-context references, associativity, broken-reference handling | P2 | `document` reference model + persistent naming |

### 1.3 Engineering & analysis

| Area | Capability | Existing implementation | Status | Missing functionality | Pri | Recommended architecture |
|---|---|---|---|---|---|---|
| Analysis | Mass properties | **Added 2026-09-21**: per-body mass (kernel volume × density), volume-scaled inertia from the world-space mesh; plus volume, area, bbox | **Partial** | Assembly/multi-selection roll-up, principal axis directions, mass from a kernel B-Rep rather than the mesh for CoG/inertia | P2 | `utils/mass-properties.util.ts` (signed-tetrahedra, 11 unit tests); a kernel `BRepGProp` cross-check if exact inertia is needed |
| Analysis | Centre of gravity | **Added 2026-09-21**: shown per body in world coordinates (centroid without a material, CoG with one); follows moves | **Partial** | Assembly roll-up | P2 | as above |
| Analysis | Moments of inertia | **Added 2026-09-21**: Ixx/Iyy/Izz, Ixy/Ixz/Iyz about the CoG in world axes, and principal moments | **Partial** | Principal axes, inertia about arbitrary axes/points, assembly roll-up | P2 | as above |
| Analysis | Material library | **Added 2026-09-21**: 8 typical materials (density, E, ν, yield) in `models/engineering-material.model.ts`, per-body assignment with undo | **Partial** | Custom materials, thermal properties, UTS, standards designation, colour/appearance link, join with the structural solver's `Material`, licensed/verified data | P2 | `standards/materials` |
| Analysis | Mechanical properties | E, ν and yield are stored per material but not yet used by any calculation | **Partial** | Use in FEA/hand calcs, thermal/fatigue data | P2 | same |
| Analysis | Basic motion analysis | None | **Planned** | Needs mates | P2 | after `assembly` |
| Analysis | FEA / structural | **Frame/beam linear-elastic** solver: nodes, members, pinned/fixed supports, member UDL, load cases + combinations, deflected shape / reactions / BMD / SFD / axial / torsion diagrams. Runs synchronously on the main thread | **Partial** (1D only) | **Solid** FEA (0% today). For STAAD-class: plates/shells, nodal/point/area loads, self-weight, section & material database, member releases, springs, P-Δ, modal/response-spectrum, design-code checks | P1 | `analysis/beam` hardened; `analysis/fem` new (§3 B17–B18) |
| Analysis | Thermal analysis | None | **Planned** | Steady/transient conduction | P3 | FEM pipeline |
| Analysis | Fatigue | None | **Planned** | S-N / strain-life, load histories | P3 | Post-processor over FEM |
| Analysis | Buckling | None | **Planned** | Linear buckling (eigen) | P3 | FEM |
| Analysis | Contact analysis | None | **Missing** | Nonlinear contact | P3 | Server-side FEM |
| Analysis | Meshing | Render tessellation (`BRepMesh_IncrementalMesh`) plus a fine "Mesh View" tessellation; Bridge Mesh overlay | **Partial** (display only) | Tet/hex FE mesh, mesh controls, quality metrics, refinement | P1 | Gmsh (WASM or server); never hand-roll |
| Analysis | Results visualisation | Beam diagrams in 3D | **Partial** | Stress/strain/displacement contours, iso-surfaces, probes, animated modes, reports | P1 | Render module colour-map overlays |

### 1.4 Drafting & documentation

| Area | Capability | Existing implementation | Status | Missing | Pri | Recommended architecture |
|---|---|---|---|---|---|---|
| Drafting | 2D drawings | **None** (screenshot PNG only) | **Planned** | Whole drawing document type | P1 | `drawing` module |
| Drafting | Orthographic views | None | **Planned** | Projected, auxiliary, isometric views; hidden-line removal | P1 | OCCT `HLRBRep_*` in kernel worker |
| Drafting | Section / detail views | 3D section planes exist (display) | **Planned** for drawings | Section/detail/broken views with hatching | P1 | as above |
| Drafting | Dimensions | 3D auto Length/Width/Height labels, point distance | **Planned** for drawings | Model-driven dimensions, ordinate/baseline/chain, tolerance display | P1 | `drawing/annotation` |
| Drafting | GD&T | None | **Planned** | Feature control frames, datums, symbol library, semantic PMI | P2 | Semantic model + ASME Y14.5 / ISO 1101 symbol set |
| Drafting | Datums / tolerances / surface finish / weld symbols | None | **Missing** | All | P2 | `standards/gdt`, `drawing/symbols` |
| Drafting | BOM tables, balloons | None | **Planned** | | P1 | Driven from assembly BOM |
| Drafting | Templates / title blocks / revision mgmt | None | **Planned** (title blocks) | Sheet formats (A0–A4, ANSI A–E), custom properties, revision table | P1 | Template files + property binding |
| Drafting | PDF / DXF / DWG export | None | **Missing** | | P1 | PDF (pdf-lib), DXF (writer lib); DWG via licensed lib |

### 1.5 Sheet metal

| Area | Capability | Existing | Status | Missing | Pri | Architecture |
|---|---|---|---|---|---|---|
| Sheet metal | Base flange, edge flange, bends, hem, bend relief | None | **Planned** | All | P2 | `sheetmetal` feature family (custom) |
| Sheet metal | Unfold / flat pattern | None | **Planned** | Flatten via face-adjacency graph and bend table | P2 | Custom on OCCT topology |
| Sheet metal | K-factor / bend allowance / bend tables | None | **Missing** | | P2 | Material + gauge tables |
| Sheet metal | Manufacturing output (DXF flat, bend list, nesting) | None | **Planned** (nesting listed under mfg) | | P3 | DXF export + nesting lib |

### 1.6 Manufacturing / CAM

| Area | Capability | Existing | Status | Missing | Pri | Architecture |
|---|---|---|---|---|---|---|
| CAM | 2.5/3/4/5-axis, milling, turning, drilling | None | **Planned** (roadmap §11: "different product tier") | All | P3 | Separate `cam` package |
| CAM | Tool libraries, toolpath generation, simulation | None | **Planned** | | P3 | OpenCAMLib-class core + custom strategies |
| CAM | Post processors / G-code | None | **Missing** | | P3 | Custom post framework |
| CAM | 3D-print prep | STL export is the hand-off | **Partial** (hand-off only) | Orientation, supports, slicing | P3 | Delegate to slicer |
| CAM | Mold/die | Draft only (partial) | **Planned** | Core/cavity split, parting line | P3 | after surfacing |

### 1.7 Data & file compatibility

| Area | Capability | Existing | Status | Missing | Pri | Architecture |
|---|---|---|---|---|---|---|
| Data | STEP import | Single file, replaces scene; solids only as "Body N" | **Partial** | Assembly structure, instance transforms, names, colours, layers, PMI (AP242), surfaces/shells, unit handling proof, healing | P1 | `io/step` using OCCT XDE (`STEPCAFControl_Reader`) |
| Data | STEP export | Only bodies retaining original STEP source; everything modelled in-app is **skipped** | **Partial** | Export of any body incl. all in-app geometry, colours, names, assembly structure | **P0** | Kernel writes from live shape handles (worker already holds them) |
| Data | IGES | None | **Planned** | | P2 | OCCT `IGESControl_*` |
| Data | STL | Export only (binary, world space, from render mesh) | **Partial** | STL import; export quality tied to *display* tessellation; ASCII option | P2 | Separate tessellation profile per output |
| Data | OBJ / glTF | None | **Planned** | | P2 | Three.js exporters/loaders |
| Data | DXF / DWG | None | **Missing** | | P2 | DXF lib; DWG needs a licensed component |
| Data | Parasolid / SAT (ACIS) | None | **Missing** | Proprietary: not obtainable from OCCT | P3 | Licensed translator (CAD Exchanger/Datakit/Spatial) |
| Data | Native project format | **None**; tab close discards everything | **Missing** (Planned as "project save") | Versioned document schema | **P0** | `document` + `io/native` |
| Data | Import/export robustness | CRLF-strip and 3-attempt virtual-path retry workarounds in reader; no healing | **Partial** | Validation/healing, size limits, progress/cancel, error taxonomy | P1 | Kernel validation layer |
| Data | Version compatibility | None | **Missing** | Schema versions + migrations | P1 | Versioned schema |
| Data | File recovery / autosave | None | **Missing** (listed as Planned) | | **P0** | IndexedDB journal |
| Data | External references | None | **Missing** | | P2 | After native format |

### 1.8 UI / CAD interaction

| Area | Capability | Existing | Status | Missing | Pri | Architecture |
|---|---|---|---|---|---|---|
| UI | 3D viewport | Three.js, orbit/pan/zoom, ortho/perspective, shading modes, grid/axes, dark mode | **Implemented** | Edge rendering pipeline, section capping, GPU picking | P2 | Render module |
| UI | Selection system | Body, face (`pickFace`), edge (`pickEdge`, screen-space 8 px); multi-select with modifier; select-all | **Partial** | Persistent face/edge selection sets, selection filters, box/lasso with modifier (tried and removed once), select-other, named selection sets | P1 | Selection model keyed by persistent IDs |
| UI | Object tree / model browser | Assembly → Import → Body, filter, rename, hide, delete; Feature Tree is a **separate** panel; reference planes not in tree | **Partial** | Unified tree (features, sketches, planes, bodies, configs), drag-reorder, rollback bar, groups/folders | P1 | Tree = view of the document |
| UI | Property panel | Name/visibility/colour/opacity, volume/area/bbox, transform (read-only) | **Implemented** (basic) | Custom properties, material, mass | P1 | Schema-driven |
| UI | Command toolbar / ribbon | Single scrolling ribbon with 12 groups | **Implemented** | Contextual tabs, customisation, search-a-command | P2 | Command registry |
| UI | Context menus | Body-only menu | **Partial** | Face/edge/feature/sketch menus, mini-toolbar | P2 | Command registry + context filters |
| UI | Keyboard shortcuts | Fixed set | **Partial** | Rebinding, chords, per-tool | P3 | Command registry |
| UI | View cube / navigation | Nav cube, presets 1–7, fit, double-click zoom | **Implemented** | Named/saved views, walk, 3D-mouse | P3 | |
| UI | Snap systems | Sketch snap to face reference points (12 px screen); gizmo snap APIs unwired | **Partial** | Grid snap, inference lines, midpoint/centre/quadrant everywhere, 3D snaps | P1 | Snap engine service |
| UI | Dynamic input | None | **Missing** | Type-a-value while drawing | P1 | Sketch module |
| UI | Measurements | Point-to-point, **3-point angle, face-to-face (parallel distance / angle) and circular-edge radius/diameter (added 2026-09-21)**, all with in-view labels | **Partial** | Edge-to-face/edge-to-edge, minimum distance between shapes (kernel `BRepExtrema`), vertex/midpoint snapping, measurements that follow moved bodies, curvature, wall thickness | P1 | Kernel `BRepExtrema` |
| UI | Section / clipping | 3 axis-aligned planes, offset/flip, undoable; no capping | **Partial** | Arbitrary plane, capped cross-section, section views saved | P2 | Stencil capping |
| UI | Customisable workspaces | Dock/float/resize panels, persisted layout | **Partial** | Task-based workspaces, ribbon customisation | P3 | |
| UI | Undo/redo architecture | Closure stack `{label, undo, redo}` at call sites; jump-to-point dropdown; **does not cover delete, import, sketch/extrude creation, primitive creation, fillet/shell/draft/hole** | **Partial** | Document-level command model | **P0** | §3 B5 |

### 1.9 Parametric & feature system

| Area | Capability | Existing | Status | Missing | Pri | Architecture |
|---|---|---|---|---|---|---|
| Parametric | Dependency graph | **"Everything after me in array order"**; docs call it an explicit simplification | **Missing** (linear list) | True DAG with typed inputs, minimal dirty set | P0 | `document/graph` |
| Parametric | Constraint solver | None | **Planned** | 2D now; 3D assembly later | P0 | Solver adapter |
| Parametric | Feature tree | Extrude/Revolve/Sweep/Loft only, session-only | **Partial** | 8+ other tools, persistence, sketches as children | P0 | |
| Parametric | Regeneration | Replay suffix on edit; keeps last `resultShape` per feature | **Partial** | Incremental, dirty tracking, cancellable, error isolation | P1 | |
| Parametric | Design intent | None | **Missing** | Relations, symmetric refs, derived values | P2 | After sketch solver |
| Parametric | Equations / variables | None | **Missing** | Named globals, expressions, units-aware | P1 | Expression engine (use a library) |
| Parametric | Design tables | None | **Planned** | | P2 | Configs + spreadsheet import |
| Parametric | Configurations | None | **Planned** | | P2 | |
| Parametric | Suppression states | None | **Planned** (roll-back/suppress) | | P1 | DAG skip flag |
| Parametric | References / dependencies | Feature → prior feature via `DocBodyRef`; sketch planes stored as **explicit origin/normal/uAxis** (not references to faces) | **Partial** | References to faces/edges/vertices/planes that follow edits | P0 | Persistent naming |
| Parametric | Robust handling of topology changes | Face/edge identity = **traversal index** of a re-parsed STEP; docs rely on "deterministic for unchanged bytes" | **Missing** | Persistent naming; reference repair UI | **P0** | B2 |

### 1.10 Advanced CAD

| Area | Capability | Status | Notes | Pri |
|---|---|---|---|---|
| Advanced | Advanced surfacing / Class-A | **Planned** (basic surfacing only) | Class-A needs a kernel with continuity control; OCCT is weak here | P3 |
| Advanced | Generative design, topology optimisation | **Missing** | Needs FEM first; server-side | P3 |
| Advanced | Reverse engineering, point clouds, scan processing, mesh-to-solid | **Missing** | Mesh import prerequisite; use PCL/Open3D-class libs server-side | P3 |
| Advanced | Mold/tool design | **Planned** (Draft partial) | | P3 |
| Advanced | Composite design | **Missing** | | P3 |
| Advanced | Kinematic mechanisms | **Planned** | after mates | P2 |

### 1.11 Engineering standards

| Capability | Existing | Status | Missing | Pri |
|---|---|---|---|---|
| ISO / ANSI fastener clearance | ISO 273 metric and ANSI B18.2.8 inch clearance diameters (as data, converted to mm) | **Partial** | Everything else: thread data, fastener libraries, tolerance classes, profiles | P2 |
| ASME / DIN / JIS | None | **Missing** | | P3 |
| GD&T standards (Y14.5 / ISO 1101) | None | **Planned** (GD&T) | | P2 |
| Material standards | None | **Missing** | | P2 |
| Drawing standards | None | **Missing** | | P2 |
| Unit systems | Hard-wired **mm**, "Units: mm" status text; `unit-conversion.util` has a formatter only | **Missing** | Unit model, dual dimensioning, imperial documents | P1 |

### 1.12 Collaboration & project management

All **Missing** (roadmap §14 lists revision control, check-in/out, co-editing, approvals as "a different product tier" that needs a server; the app is client-only by design). No metadata, part numbering, project structure, permissions, storage, or workflow. **P3**, except metadata/part numbering (P2) which are needed by BOM/drawings.

### 1.13 API / automation

| Capability | Existing | Status | Note | Pri |
|---|---|---|---|---|
| Scripting API, macros, Python/other bindings | None | **Planned** | The only "API" is the internal worker message union in `step-worker-messages.model.ts` (unversioned, 478 lines) | P2 |
| Plugin architecture | None | **Planned** | Every new tool edits many core files today (see §7.2, risk 16) | P1 (enables everything) |
| Custom commands / feature creation API | None | **Missing** | | P2 |
| Geometry API, import/export API | None | **Missing** | | P2 |
| Headless processing | None | **Missing** | OCCT WASM can run in Node; the worker is not separable from the Angular build as written | P2 |

### 1.14 Performance & reliability

| Capability | Existing | Status | Missing | Pri |
|---|---|---|---|---|
| Large assemblies / drawings | Not addressed (doc: "large-dataset render perf work" deferred) | **Missing** | BVH, instancing, LOD, culling, streaming | P1 |
| GPU acceleration | WebGL via Three.js only | **Partial** (implicit) | GPU picking, instancing, stencil capping | P2 |
| Multithreading | OCCT in Web Workers, **single-threaded WASM**; 7 separate spawn sites, each re-inits OCCT | **Partial** | Worker pool, shared compiled module, WASM threads (needs cross-origin isolation) | P0 |
| Memory management | `disposeObject3D` util; a THREE.Line leak fixed 2026-09-14; docs admit intermediate OCCT shapes were never disposed until Feature Tree | **Partial** | Resource manager, ref-counted shape handles, memory budget, OOM handling | P1 |
| Background computation | Async worker calls with `busy` signals; per-feature edit queue | **Partial** | Job queue, progress, cancellation, priority | P1 |
| Incremental regeneration | Suffix replay | **Missing** | Dirty-set regen | P1 |
| Crash recovery / autosave | None | **Missing** | | **P0** |
| Error handling | Per-tool inline messages; `alert()` for export; raw WASM exception pointers leak to UI (`21716072`) | **Partial** | Error taxonomy, kernel-error decoding, telemetry | P1 |
| Geometry-kernel reliability | Repeated silent-wrong-result patterns ("`IsDone()` true, zero change" in Draft; negative volume in Shell; identical volume in Revolve-cut); a specific edge crashes `MakeFillet`; docs' fillet once-per-page claim not reproduced | **Missing** (no safeguards) | Validation, healing, fallbacks, regression corpus | **P0** |

---

## 2. What the project actually is today

A single-user, client-only **STEP viewer / light part editor** with a strong interaction layer. Coverage by discipline:

| Discipline | Level | Why |
|---|---|---|
| Viewport, selection, panels | Strong | Multi-select, gizmo, nav cube, docking, tree filter, history dropdown |
| Simple solid modelling | Moderate but narrow | 12 tools exist, but **one feature per STEP body**, and most tools can't act on in-app geometry |
| Parametric history | Thin | 4 feature kinds, numeric params only, session-only |
| Sketching | Minimal | No constraints, no lines/arcs |
| Assemblies, drawings, CAM, sheet metal, PDM, API | Absent | |
| FEA | Narrow but real | Frame/beam solver only |

The project's own estimate (15–20% overall, 50–60% "viewer with light feature modelling") looks about right. The structural reason it is not higher is that **the model of "what a body is" is the wrong one for a CAD system** (see §7.2, risks 3–6). That is where the leverage is.

**Derived capability matrix** (from the docs' limitation statements; ✔ (verified) / ✔ / ✘ come from docs unless marked; **?** = not tested). The manual does not contain a matrix like this, and it should.

| Body origin ↓ / Operation → | Fillet/Chamfer | Shell | Draft | Hole Wizard | Extrude/Revolve/Sweep cut | Loft cut | STEP export | STL export | Pattern/Mirror | Feature Tree edit | Mesh View |
|---|---|---|---|---|---|---|---|---|---|---|---|
| STEP import, pristine | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ (mesh clone) | – | ✔ |
| STEP import after a cut (T5) | ✔ (verified) | ? | ? | ? | ✔ (verified, compounds) | ? | ? | ✔ | ✔ | ? | ✔ |
| Primitive | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ skipped | ✔ | ✔ | ✘ | ✘ |
| Extrude/Revolve/Sweep body | ✘ | ✘ | ✘ | ✘ | ✔ (via featureId) | ✘ (manual) | ✘ skipped | ✔ | ✔ | ✔ | ✘ |
| Loft body | ✘ | ✘ | ✘ | ✘ | unclear | ✘ | ✘ skipped | ✔ | ✔ | ✔ (Cut only) | ✘ |
| Duplicate/Pattern/Mirror copy | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ skipped | ✔ | ✔ | ✘ | – |

Read this with care: the manual says a cut STEP body is a dead end, but T5 showed cut → cut → fillet works on one body, so several ✘ cells above are probably stale. The practical point stands: **what works depends on how a body was made, and neither document tells the user which.** Any operation on a *moved* body loses the move (T3).

---

## 3. Briefs for every missing or partial capability

The 100+ table rows collapse into **30 capability clusters** (many rows share one root cause, and repeating the same eight answers per row would hide that). Each cluster answers: **(1)** what it does · **(2)** why it matters · **(3)** what's missing here · **(4)** owning subsystem · **(5)** dependencies · **(6)** approach · **(7)** kernel / solver / renderer / physics / CAM / library needed · **(8)** complexity.

### B1. Sketch engine: entities, constraints, dimensions
1. Lets the user draw 2D geometry whose shape is *defined by relationships* (coincident, tangent, dimension = 25) rather than by click positions; the solver keeps it valid on edit.
2. It is the parametric core of mechanical CAD. Without it there are no driving dimensions, no design intent, no meaningful feature edits, and every profile must be redrawn to change.
3. Only 4 two-click shapes, one closed profile, no constraints, no dimensions, no persistence of the sketch after extrude.
4. New `sketch` module (entities, constraint graph, solve status), UI in viewport + a sketch panel; sketch becomes a **node in the feature graph**.
5. Feature DAG (B3), persistent references (B2) for "sketch on face", units (B25).
6. Entity model (point, line, arc, circle, ellipse, spline, construction flag); constraint set as data; **delegate solving to a library**; DOF/status indicator; dimension objects with expressions; profile detection (loops → regions) for extrude.
7. **Solver library** (FreeCAD's planegcs compiled to JS/WASM, or SolveSpace's `slvs`). Renderer: overlay for constraint glyphs. Kernel: only at feature build (wire → face).
8. **Very High** (UI + interaction is the bulk; the solver itself is bought).

### B2. Persistent naming (topological references)
1. Gives faces/edges/vertices identities that survive regeneration, so "fillet this edge", "sketch on this face" still point at the right thing after an upstream edit.
2. This is what separates a history-based CAD system from a macro recorder. Without it, editing feature 1 silently breaks or mis-targets feature 5.
3. Today identity = index in a `TopExp_Explorer` walk of a re-parsed STEP (`faceIdMap`, `edgeIndex`), and sketch planes are stored as raw origin/normal/uAxis numbers (architecture 2026-08-06, Slice 1). **Runtime test T4 confirmed the consequence**: after editing a block's depth from 20 to 60 mm, a boss fused on its top face stayed at the old plane and was silently absorbed into the block (z-max 60, not 70). The boss did not follow the face it was sketched on. **Fixed for planar faces on 2026-09-21** by signature-based face anchoring (see the architecture file's final entry); permanent identity and other feature types are still open.
4. `kernel` (history capture) + `document` (reference resolver).
5. Kernel adapter that can record `Modified`/`Generated`/`IsDeleted` per operation.
6. Record `BRepBuilderAPI_MakeShape::Modified/Generated/IsDeleted` (or OCAF `TNaming`) for every feature; give each sub-shape a persistent ID derived from (creating feature, generation role, ordinal); resolve references through the history; fall back to geometric matching; surface "broken reference" to the user instead of failing silently.
7. Kernel (OCCT history APIs). No external library.
8. **Very High**. It's the hardest single item in the roadmap, and it is unavoidable.

### B3. Feature dependency graph, regeneration, rollback, suppression
1. Stores features as a graph with typed inputs; on edit, recomputes only what depends on the change; supports rollback bar, suppress, reorder, error state per feature.
2. Needed for any non-trivial part, and for configurations, design tables, and patterns of features.
3. Linear array, suffix replay, four hard-coded kinds (`extrude|revolve|sweep|loft`); each new kind edits the message union, replay loop, `FeatureTreeService.update` overloads and panel HTML (docs describe this per slice).
4. `document` (graph + regen scheduler) executing in `kernel` worker.
5. B2; a feature-type registry; expression engine (B24).
6. Feature = `{id, type, inputs (refs + params), state, cache key, result handle}`. A registry maps `type → {schema, build(ctx), editor component}` so adding a feature is one module, not eight edited files. Topological order, dirty propagation, cancellation, per-feature error containment.
7. Kernel worker; no library needed (small, but must be custom).
8. **High**.

### B4. Unified document model, native format, autosave, recovery
1. One serialisable object describing the entire design (features, sketches, bodies, references, materials, views, assembly), saved to disk and reopened losslessly.
2. Without it there is no product: closing the tab loses everything (manual §3.11, §10).
3. State is spread over ~39 singleton services plus Three.js meshes; nothing is serialisable as a whole. Only `panel-layout-v1` is persisted.
4. `document` + `io/native` + browser storage adapter.
5. B3 (what to serialise), kernel shape serialisation (`BRepTools::Write` or STEP per body as cache).
6. Versioned schema (JSON) in a zip container (features, sketches, thumbnails, optional cached B-Rep blobs); IndexedDB write-ahead journal for autosave; File System Access API for save/save-as; migration functions per schema version; `beforeunload` guard.
7. Library: fflate/JSZip, `idb`. Kernel: for optional BRep cache.
8. **High**.

### B5. Undo/redo for geometry, delete, import
1. Reverses any modelling action, including creation and deletion.
2. Users treat "Delete cannot be undone" as a defect. It is the least professional line in the manual.
3. Closure-based history wired at call sites; geometry changes dispose GPU buffers and mutate worker shapes with "no snapshot to restore".
4. `document` command bus; `render` resource manager.
5. B4 (immutable/versioned document), deferred GPU disposal.
6. Every user action = a **document command** producing a new document revision; kernel shapes are immutable handles kept per revision (cheap: shared refs); render layer diffs revisions; GPU resources are ref-counted and freed after the undo window.
7. No library; needs kernel handle lifetime discipline.
8. **High** (mostly falls out of B3+B4 if done right).

### B6. Kernel validation, healing, and reliability layer
1. After each kernel operation: verify the shape is valid, closed, positively oriented, of plausible volume; repair or reject; expose a clean error.
2. Silent wrong geometry is worse than an error. The docs list four cases where a clean "success" returned garbage (Shell volume −88 M mm³, Draft no-op, Revolve-cut no-op, Sweep volume 0), each caught only because a human checked a number.
3. Nothing: zero uses of `BRepCheck_Analyzer`, `ShapeFix_*`, `ShapeUpgrade_*`. One-off `Complemented()` patches and per-tool sanity constants remain in tool code.
4. `kernel` post-condition gate applied to *every* feature build.
5. Kernel adapter (B27) so one place wraps all ops.
6. `BRepCheck_Analyzer` → `ShapeFix_Shape` → recheck; compare volume sign/delta against expectations per feature type; check face/edge/vertex counts; tolerance policy; produce typed `KernelError` (decode raw WASM exception pointers, docs 2026-09-14).
7. Kernel (OCCT healing modules must be in the WASM build).
8. **Medium** to build, **P0** because it protects every later feature.

### B7. All existing tools onto the feature graph (Fillet/Chamfer, Shell, Draft, Hole, Pattern, Mirror, primitives)
1. Makes every operation editable, reorderable, undoable, exportable.
2. The docs describe a "one feature per STEP body" ceiling; **the current code does not enforce it for sketch cuts and fillets** (T5). Shell/Draft/Hole Wizard/Pattern/Mirror composition was not re-tested, and the docs and code disagree.
3. Only Extrude/Revolve/Sweep/Loft are fully migrated. Slice 5 (Fillet/Chamfer) is partly live in the working tree (the Feature Tree lists fillets), and its stated blocker did not reproduce (C2).
4. `kernel` feature types; `document`.
5. B2, B3, B6, and the unexplained fillet defect (below).
6. **Decide Slice 5 deliberately** (its blocker did not reproduce): finish or remove it. Then convert each tool to a registered feature type whose inputs are persistent-ID references, and remove the `hasStepSource`/re-read-original-bytes mechanism: import once, keep the shape handle in the document.
7. Kernel; possibly a rebuilt OCCT.
8. **Very High** (cumulative).

### B8. Advanced solid features
1. Real sweep (path/guides), loft guides/closed/tangency, extrude end conditions, thin features, rib, dome, wrap, combine/split, variable-radius and face fillets, direct edit.
2. Everyday part design uses these constantly; the current "Sweep" is an oblique extrude.
3. See table rows 1.1.
4. `kernel` feature types + UI editors.
5. B3, B2.
6. `BRepOffsetAPI_MakePipeShell`, `BRepFilletAPI_MakeFillet` with `SetRadius` law overloads, `BRepFeat_*`, `BRepAlgoAPI_*`, `BRepOffsetAPI_MakeThickSolid`, `BRepOffsetAPI_DraftAngle`. The docs' experience is that each new call costs several runtime-probing rounds because there are no typings → build typed bindings (B27).
7. Kernel.
8. **High** each; **Very High** in total.

### B9. Hole and fastener features
1. cbore/csink/tapped/blind holes with standard sizes and callouts.
2. Mechanical design leans on them; drawings need hole callouts.
3. Through clearance holes only. Docs correctly state counterbore was blocked by the cut pipeline's re-read-original-bytes limit, which B7 removes.
4. `kernel` hole feature + `standards`.
5. B7; standards data (B25).
6. Hole = a revolved tool profile (stepped) + position sketch points; thread as cosmetic (metadata) first, modelled thread later.
7. Kernel + data.
8. **Medium** once B7 exists.

### B10. Surface modelling
1. Non-solid faces/shells: boundary, fill, offset, trim, knit.
2. Needed for complex shapes, mold surfaces, repair of imports.
3. Nothing (Bridge Mesh is a display overlay).
4. `kernel` surface feature types.
5. B3; a body-kind concept (solid vs surface) in the document.
6. `GeomFill`, `BRepFill`, `BRepOffsetAPI_MakeOffset`, `BRepBuilderAPI_Sewing`.
7. Kernel. **Class-A** is not credible on OCCT.
8. **High**.

### B11. Multi-body modelling and body-level booleans
1. Multiple solids per part with merge/keep/combine.
2. Common in real parts (mold, weldment, multi-material).
3. Bodies have no owning feature and can't be booleaned against each other.
4. `document`.
5. B3.
6. Body = output of a feature; add Combine/Split/Intersect feature types.
7. Kernel.
8. **Medium**.

### B12. Assembly core: components, mates, subassemblies, configurations
1. Defines parts' relationships and positions by constraints, reuses parts as instances, nests assemblies.
2. Assemblies are half of mechanical CAD; every downstream deliverable (BOM, motion, interference, drawings) needs them.
3. Fixed 3-level tree; "Open" replaces; positioning by gizmo; no relationship stored.
4. New `assembly` module; `document` gets `PartDefinition` / `ComponentInstance` (definition + transform + mates).
5. B4, B2 (mates reference faces/edges), B1's solver approach.
6. Instances reference definitions (no geometry copy); mate types as constraints between references; solve with a general geometric constraint solver over rigid-body DOF (numeric solver library); DOF display; drag-solve; configurations as named overrides of params/suppression.
7. **Solver library** (numeric, e.g. planegcs-style for 2D isn't enough: 3D rigid-body needs its own formulation on top of a generic nonlinear least-squares like `ceres`-class; SolveSpace's solver covers 3D constraints). Renderer: instancing.
8. **Very High**.

### B13. Interference / collision / clearance
1. Detects overlapping or too-close components.
2. Standard design check.
3. Absent.
4. `assembly/check` running in kernel worker.
5. B12; BVH.
6. Broad phase: AABB tree (three-mesh-bvh); narrow phase: `BRepAlgoAPI_Common` volume or `BRepExtrema_DistShapeShape`; report + highlight.
7. Kernel + BVH library.
8. **Medium**.

### B14. Motion / kinematics / exploded steps
1. Simulate mechanisms, animate exploded steps.
2. Verifies function; produces assembly instructions.
3. Radial slider only.
4. `assembly/motion`.
5. B12.
6. Kinematic solve over mates with a driver; exploded steps as stored transforms.
7. Solver + rigid-body dynamics library for dynamics (Rapier/Ammo are game-grade; use for visualisation only).
8. **High**.

### B15. BOM, metadata, part numbering, custom properties
1. Structured data on parts/assemblies; BOM derived from assembly.
2. Drawings, procurement and PDM all key off it.
3. Nothing beyond name/colour/opacity.
4. `document` properties + `assembly/bom`.
5. B12.
6. Property schema (string/number/expression), templates, BOM aggregator with quantity roll-up, CSV/XLSX export.
7. Library for XLSX (optional).
8. **Low–Medium**.

### B16. Materials and mass properties
1. Density/E/ν/strength per body; mass, CoG, inertia tensor.
2. Fundamental engineering output; inputs to FEA and motion.
3. **Partly done 2026-09-21**: per-body material assignment, mass, CoG and inertia now exist (see the Analysis table). Still missing: roll-up, custom materials, principal axes, and using material properties in analysis.
4. `standards/materials` + `kernel` (properties) + Properties panel.
5. B25 (units).
6. Materials JSON (with units and standard designation); `BRepGProp.VolumeProperties/SurfaceProperties` for mass, CoG, inertia (principal axes).
7. Kernel; material data licensing (use open tables, cite sources).
8. **Low–Medium**.

### B17. Solid FEA (static first) and other physics
1. Meshes solids, applies loads/constraints/contacts, solves, plots stress/displacement. Extensions: modal, buckling, thermal, fatigue, nonlinear.
2. It is "Simulation" in SolidWorks; the analysis engineers expect.
3. Nothing. The beam solver isn't reusable for 3D.
4. `analysis/fem` (pre-processing in browser, solve in worker or server).
5. B16, meshing library, geometry-to-mesh association (B2 for BC faces).
6. Gmsh for tet meshing; **CalculiX / Code_Aster / Elmer** solver: not credible to write. Browser-only solving is limited by memory and single-thread WASM; realistic plan is a **solver microservice** (breaks "no backend"), or a small in-browser linear-static solver for small models.
7. Mesher + solver libs; results renderer.
8. **Very High**.

### B18. Structural (STAAD-class) extensions
1. Frame analysis with realistic loads, sections, materials, design checks.
2. The existing solver is the one place the app rivals a commercial tool's category.
3. Unknown/undocumented: nodal loads, self-weight, section/material assignment (C7). Missing: plates, releases, springs, P-Δ, dynamics, code checks (AISC/IS 800/EN 1993), section database, load generators, report output. Solver is synchronous on the main thread and likely dense.
4. `analysis/beam`.
5. Section/material DB (B16), document serialisation.
6. Move solver to worker; sparse matrices; section library from published tables; load cases with patterns; results tables + PDF report.
7. Sparse linear algebra library.
8. **High**.

### B19. Drawings engine
1. Generates 2D projected/sectioned views, dimensions, annotations, BOM/balloons, and exports PDF/DXF.
2. Manufacturing communication; contractual.
3. Nothing.
4. `drawing` module (new document type) + `kernel` HLR.
5. B4, B12 (BOM), B15, B2 (dimension references), B25 (standards).
6. Views = projection specs bound to a model revision; HLR via `HLRBRep_Algo`/`HLRBRep_PolyAlgo` in the worker; sheet canvas (SVG or Canvas2D) with annotation objects referencing model geometry through persistent IDs; templates; export.
7. Kernel (HLR), PDF library, DXF library; DWG licensed.
8. **Very High**.

### B20. Sheet metal
1. Feature family producing folded parts with a flat pattern.
2. Large share of mechanical products.
3. Nothing.
4. `sheetmetal` module.
5. B3, B2, materials/gauge tables.
6. Model as thickness + bend graph (base flange as thickened sketch, flanges as face-attached extrusions with bend radius); unfold from adjacency graph applying K-factor; DXF flat output. OCCT has no sheet-metal support.
7. Kernel; custom code.
8. **Very High**.

### B21. Weldments
1. Structural members from profile libraries along sketch lines, with trimming, gussets, weld beads, cut lists.
2. Frame fabrication.
3. Nothing (structural analysis nodes/members are line elements only).
4. `weldment`.
5. B1, B3; profile library.
6. Sweep of profile along sketch segments + miter/trim booleans; cut-list from properties.
7. Kernel; profile data.
8. **High**.

### B22. CAM
1. Toolpaths and G-code.
2. Different product tier (the docs say so; I agree).
3. Nothing.
4. `cam` package, probably worker + a server option.
5. Stock model, tool library, B12 for fixtures.
6. Use an existing toolpath core; write strategies and posts; simulate with a dexel/voxel model on GPU.
7. **CAM engine** library (OpenCAMLib-class, if it compiles to WASM: verify), custom posts.
8. **Very High**. Defer.

### B23. Data exchange
1. STEP (with structure/colour/names/PMI), IGES, STL/OBJ import, glTF, DXF/DWG, Parasolid/ACIS, native.
2. Interoperability is a purchase criterion.
3. See §1.7.
4. `io` package.
5. B4.
6. XDE-based STEP reader/writer (`STEPCAFControl_*`) instead of the plain reader; import produces a component tree, not flat bodies. Write STEP from live shape handles, never by re-reading source bytes.
7. Kernel; licensed translators for Parasolid/ACIS/DWG.
8. **High** (STEP), **Medium** (others), **Very High** (proprietary).

### B24. Selection, snapping, dynamic input, measurement, workspace polish
1. The remaining interaction depth of a pro tool.
2. Daily-use ergonomics.
3. See §1.8.
4. `render`/`ui`.
5. B2 for persistent selections.
6. Selection filters and named sets; modifier-gated box/lasso (the docs' own guidance: never default drag on empty space); snap/inference engine; dynamic numeric entry; `BRepExtrema` measurements; stencil capping; command registry powering ribbon/menus/shortcut rebinding.
7. Renderer + kernel.
8. **Medium** (each), **High** together.

### B25. Units and standards
1. Unit-aware quantities, dual units, tolerance classes, standard libraries.
2. Documents must round-trip in inch or mm and drawings need standards.
3. Units hard-wired to mm; kernel scene units are mm.
4. `standards` package.
5. B4.
6. Quantity type `{value, unit}` at the document boundary; internal canonical SI or mm; ISO/ANSI/DIN/JIS drafting presets; fastener and thread data.
7. Library for unit parsing/expressions (mathjs-class).
8. **Medium**.

### B26. Collaboration, revision control, PDM
1. Multi-user, versions, locks, permissions, release workflow.
2. Enterprise adoption.
3. None; client-only by design.
4. New backend + `collab` client.
5. B4, deterministic regeneration, identity model.
6. Server with object storage + Postgres; **operation-log sequencing** (Onshape-style) is a better fit for feature-history CAD than text CRDTs; start with check-in/out + versions before real-time.
7. Backend, auth, storage.
8. **Very High**.

### B27. API, scripting, plugins, headless
1. Programmatic control, custom commands/features, batch processing.
2. Automation is how CAD gets embedded in engineering workflows.
3. Nothing. Internal worker message union only.
4. `api` + kernel adapter + feature/command registries.
5. B3 registry, B4 document, typed kernel adapter.
6. Typed **kernel adapter** first (this also fixes the runtime-probing pain), then a document/command API, then a sandboxed script host (JS in a worker; Python via Pyodide optional); publish semver'd typings; make the kernel package run in Node for headless.
7. Kernel; QuickJS/Pyodide optional.
8. **High**.

### B28. Performance at scale
1. Handles 1,000+ part assemblies and big drawings interactively.
2. Professional assemblies are large.
3. One `Mesh` per body; per-move raycast; per-frame label projection; cold OCCT init 30–40 s per spawn; two tessellations per STEP body.
4. `render`, `kernel`.
5. B12 (instancing needs definitions), B4.
6. `three-mesh-bvh` picking; GPU ID-buffer picking; instanced definitions; merged static geometry; frustum/occlusion culling; LOD tessellation; progressive load; one warm kernel worker/pool with a precompiled `WebAssembly.Module` shared to workers; consider WASM threads (COOP/COEP headers).
7. Renderer + library.
8. **High**.

### B29. Advanced CAD (generative, topology optimisation, reverse engineering, mold, composites)
1. Specialist tiers.
2. Differentiators after the core is professional.
3. All absent.
4. Separate packages/services.
5. B17, B23, mesh tooling.
6. Server-side pipelines; do not attempt in-browser first.
7. Specialised libraries.
8. **Very High**. Defer.

### B30. Kernel platform (build, typings, upgrade)
1. The compiled OCCT and its JS bindings.
2. Every capability above sits on it.
3. `opencascade.js ^1.1.1` prebuilt; no typings for embind overloads (docs: overload numbers found by trial); production bundling needed an `fs`/`path` external (fixed); cold start ~14–40 s per worker spawn; the docs' `MakeFillet` once-per-page claim did not reproduce; no threads.
4. `kernel` package.
5. Build toolchain.
6. Build a **custom OCCT WASM** with only needed modules (smaller, faster) from a current OCCT release, generate typings from the actual binding list, and wrap it in a typed adapter that no other code bypasses.
7. Kernel toolchain (Emscripten, opencascade.js custom-build tooling or equivalent; verify current maintenance status before committing).
8. **High**, and it is the cheapest way to remove several standing defects at once.

---

## 4. Architecture review of `architecture.md`

`architecture.md` is a **chronological engineering log** (about 3,000 lines) rather than an architecture description: there is no component/data-flow diagram, no statement of invariants, and its introduction is stale (C5, C6). Its greatest strength is candour (the failure stories are unusually honest and useful). The review below concerns the *design it documents*.

### 4.1 Findings by topic

| Topic | What the docs/code show | Why it will not scale | Recommendation |
|---|---|---|---|
| **Geometry kernel** | `opencascade.js ^1.1.1` prebuilt; no typings; overloads found by trial (`BRepPrimAPI_MakeBox_2` throws, `_1` works; `MakeThickSolidByJoin` 9-arg order discovered from BindingError text); unexplained fillet failures | Every new op costs a debugging cycle; upgrades are terrifying; wrong-order calls return silently wrong geometry | Custom OCCT build + generated typings + one typed kernel adapter (B30) |
| **B-Rep / topology** | Body identity = `(source STEP bytes, solidIndex)`; a body without retained source has *no* B-Rep; primitives/extrudes exist as tessellation + a session-only shape | Root cause of `hasStepSource` flags, STEP-export gaps and doc/code drift (C1) | Import once → keep a kernel shape handle per body in the document; delete the re-read-original-bytes mechanism |
| **Parametric modelling** | Params only; sketches fixed at creation; sketch planes on feature faces now follow their face (signature matching, planar faces, Extrude/Revolve/Sweep) | Still no design intent; features on Loft/Hole/Fillet/Shell/Draft faces reference by index | Sketch module + references (B1, B2) |
| **Constraint solving** | None | No dimension-driven design | Adopt a solver library |
| **Dependency graph** | "Everything after me in array order" (documented simplification); discriminated union grows per kind, with 3–5 switch sites | Over-replays; every feature = edit ~8 files | Feature-type registry + DAG (B3) |
| **Feature history** | 4 of ~12 tools; session-only; cannot survive reload | Not a history, only a partial edit list | B3, B4, B7 |
| **Assemblies** | Fixed 3-level tree, flags on tree nodes (`hasStepSource`, `featureId`) mixed into a *display* tree | No instance/definition split | `assembly` module (B12) |
| **Rendering** | One `THREE.Mesh` per body; clipping via `renderer.clippingPlanes` (no cap); per-frame label projection; picking by raycast against full meshes plus screen-space polyline scan for edges; two tessellations per STEP body | Scales to tens of parts, not hundreds/thousands | BVH, instancing, edge overlays from B-Rep, GPU picking, stencil caps |
| **GPU architecture** | Default WebGL, no instancing/OffscreenCanvas | Render and UI share the main thread | Move heavy loops to worker/Offscreen where practical; consider WebGPU later, not now |
| **Undo/redo** | `{label, undo, redo}` closures added by hand at each call site; explicit exclusions; async closures typed sync; a real race found and patched with a per-feature promise queue | A command stack that must be remembered per feature is where bugs live | Document-level commands over revisions (B5) |
| **Persistence** | `localStorage` layout only | No product without saving | B4 |
| **Serialisation** | None; state in ~39 services and mesh objects | Cannot save what isn't modelled as data | Document schema (B4) |
| **Plugin system** | None; each tool requires edits to `ToolService.ActiveTool`, `Viewport` click/hover routing, `panel-layout`, `tool-panels.ts/html/css`, `app-chrome.ts/html`, message union, worker | Adds friction to every feature and prevents third-party extension | Tool/feature/command registries with declarative contributions |
| **Threading** | One monolithic 2,090-line worker; 7 spawn sites each cold-starting WASM; nested-worker spawn failed in dev; single-thread WASM | Slow start, memory duplicated per worker, no pool/cancel/priorities | RPC layer (e.g. Comlink), worker pool, precompiled module reuse |
| **Performance** | Cold init 30–40 s per spawn; STEP export re-parsed a 2 MB file 17× before grouping fix; structural solve on main thread | Latent freezes as models grow | Warm kernel service; cache parsed shapes; move solvers off main thread |
| **Numerical robustness** | Ad-hoc constants: Shell tol 0.1 mm; through-depth `max(bbox)*1.25`; Draft neutral plane at min-Z vertex; "cut both ways" as a universal fix; no global tolerance policy; positions are float32 in world mm | Fragile on large/small/far-from-origin models | Central tolerance policy; validation gate (B6); camera-relative/RTC rendering for float32 |
| **Units / tolerances** | mm hard-wired; unit converter is a formatter; no tolerance model | Blocks inch documents, dual dimensioning, GD&T | Units and quantity model (B25) |
| **File interoperability** | Plain STEP reader; workarounds for CRLF and virtual-path collisions; export only from retained sources | Data loss on both ends | XDE-based IO; export from live handles (B23) |
| **Testing** | 3 specs; 8 manual Playwright scripts; verification relies on human-checked numbers; `tsc --noEmit` known to miss errors `ng serve` catches; production build was broken (now fixed) | Regression risk grows with each tool; none of the docs' hard-won numbers are locked in as tests | Kernel tests in Node with golden values; Playwright in CI |
| **API design** | Worker message union is the de-facto internal API; no version; no public surface | Cannot script, embed, or test headlessly | Typed kernel adapter → document API → script host (B27) |
| **Front-end structure** | Docs say "don't merge components further", yet `tool-panels.ts` now hosts ~17 panels and `viewport.ts` routes clicks for every tool | Consolidation was reasonable at 6 panels and becomes a scalability cliff at 20+ | Registry-driven panel/tool contributions; keep few *shells*, many *contributions* |

### 4.2 Top architectural changes (in order)

1. **Persistent naming, partly done (2026-09-21):** a feature sketched on a planar face of an earlier feature now follows that face (T4, verified). Still open: permanent identity (matching is geometric and can confuse similar parallel faces), edges/vertices/non-planar faces, and Loft/Hole/Fillet/Shell/Draft references. The moved-body and multi-solid-edit defects are fixed and covered by regression scripts (`verify-moved-body-fillet.mjs`, `verify-moved-body-cut.mjs`, `verify-feature-edit-multi-solid.mjs`, `verify-feature-follows-face.mjs`).
2. **Replace "body = STEP bytes + index" with a kernel-owned shape store** referenced from a Document.
3. **Introduce the Document + command bus** (undo, autosave, save all follow).
4. **Typed kernel adapter + custom OCCT build + validation gate**; move to a small worker pool.
5. **Persistent naming**, then rebase features onto **references** instead of raw numbers or indices.
6. **Feature-type and tool registries** (declarative contributions) to stop the eight-files-per-feature pattern.
7. **Sketch module with a solver library.**
8. Only then: assemblies, drawings, analysis.

The order is forced by dependencies, not taste: assemblies and drawings both consume persistent references; persistent references need history capture in the kernel adapter; the adapter needs the shape store; undo and save need the Document.

---

## 5. User-manual review

The manual is unusually thorough and honest: §11 is exemplary. It nevertheless has these gaps.

### 5.1 Documented but not (reliably) doable
- **Example B** is achievable (cut then fillet verified, T5); **Example C** (primitive → cut → fillet) was not tested. The manual's limits text is stale (C1).
- **Fillet/Chamfer** is documented as reliable and, in testing, was (two fillets in one page load, T2). The architecture doc's contrary claim is unproven (C2). Each operation takes ~14 s, which the manual doesn't mention.
- **Sketch cut / fillet chaining**: the manual says a body cannot be cut or filleted again after its first cut. In the current code cut → cut → fillet on one STEP body works and compounds (T5). Shell, Draft and Hole Wizard were not re-tested.
- **Cross-kind feature chaining** (Extrude→Sweep etc.) is described as "built to chain … not every combination has had equally direct testing" (§3.13): a hedge users can't act on.

### 5.2 Implemented but undocumented or under-documented
- The implicit **"Modeling" import node** created when you build before opening a STEP file (architecture 2026-08-24).
- **The rule "one feature per STEP body"** and the full per-origin capability matrix (§2 above).
- **Structural sections/materials**: how member properties are defined (C7); nodal loads and self-weight are not described at all.
- Cursor coordinates fall back to the Z=0 plane over empty space; FPS is a 1-second average.
- Mirror is approximate for rotated bodies (documented in the *code* docstring, not in the manual).

### 5.3 Workflows that are incomplete
- **No end-to-end "design a part" workflow** that stays within the documented limits.
- **No save/resume**: only export; and STEP export skips exactly the bodies a user has modelled.
- **No units or tolerance workflow.**
- **Structural**: no way (documented) to edit or delete nodes/members/loads once placed; no results table, no report.
- **Assembly**: no insert-component, no mating, no BOM.
- **Feature Tree**: cannot edit the sketch, cannot reorder, suppress or delete a feature.

### 5.4 Missing commands users of SolidWorks/CATIA will look for
Line/arc/spline, smart dimension, trim/offset/mirror entities, extrude end-conditions, combine/split, move face, rib, dome, wrap, mate, insert component, interference check, mass properties, materials, exploded steps, BOM, new drawing, angle/radius measurements, convert entities, equations, configurations, save/save as, print/PDF, import IGES/OBJ, rebuild/rollback/suppress, hide/show by type, named views, section capping.

### 5.5 Missing UI concepts
Document tabs (part/assembly/drawing), unified feature manager tree with rollback bar, confirmation-corner/sketch mode indicator, selection filters, mini-toolbar/heads-up toolbar, command search, rebinding, dirty-state indicator, recent files, message/log panel, task/progress panel with cancel.

### 5.6 Missing error handling (per manual §10 and architecture)
- Raw WASM exception pointer shown as an error (architecture 2026-09-14); the manual doesn't mention it.
- Loading a file is an `alert()`/dialog-level flow with no cancel; a 30–40 s WASM cold start has no distinct message.
- Tab close with unsaved work: no warning (documented).
- Out-of-memory in the WASM heap: not handled or mentioned.
- No "kernel result invalid" error class.

### 5.7 Missing tutorials/examples
The six examples are workflows, not tutorials; two are broken (C1). Missing: first-part tutorial (sketch → extrude → hole → export), structural frame tutorial (build → supports → loads → results), STEP inspection walkthrough with expected outputs, troubleshooting for cold start, and a "what works on which body" chart.

### 5.8 Features users expect but cannot currently use
Anything in §1.2–§1.14 marked Planned/Missing, plus practical ones: saving, undoing a delete, filleting a body after cutting it, exporting what they built as STEP, opening two files together, moving a part by mates.

---

## 6. Development roadmap

Sizing is relative (S/M/L/XL/XXL), not calendar time. Phases 4–7 can be reordered by market; Phases 0–3 cannot.
"Dependencies" lists what must already exist. Capability cluster IDs (B1…B30) refer to §3.

### Phase 0: Foundation  *(size: L)*
- **Features:** production `ng build` (done); moved-body and multi-solid-edit defects (done); decide Slice 5 deliberately; custom OCCT WASM build with **generated typings** and a single typed **kernel adapter**; **validation/healing gate** (B6); worker pool + RPC + cancellation/progress; **Document + command bus** with schema v1 and undo for *all existing operations*; save/open/autosave/recovery (B4); tool/feature/command **registries**; unit/quantity model (B25); error taxonomy; architecture overview doc replacing the stale intro.
- **Dependencies:** none. This phase creates the dependencies.
- **Architecture changes:** replace "body = STEP bytes + index" with a kernel **shape store**; the kernel records `Modified/Generated/IsDeleted` history for every op from day one (used later by B2); render layer becomes a view of the Document; services that own domain state become document-backed.
- **Recommended libraries/tech:** Emscripten + opencascade.js custom-build tooling (verify maintenance status first); Comlink; `idb`; fflate; Vitest (Node) for kernel tests; Playwright in CI; ESLint/Prettier; Nx or pnpm workspaces.
- **Testing requirements:** golden-geometry suite in Node encoding the numbers the docs already produced (Pappus torus 0.04 %, oblique-prism 0.005 %, shell thin-wall ratio, hole volume delta); round-trip tests for save/open; property-based tests for command undo/redo; kill-the-tab recovery test; CI runs `ng build`.
- **Performance considerations:** one warm kernel worker (compiled `WebAssembly.Module` shared), so cold start is paid once per session; cache parsed shapes; budgets for heap size.
- **Definition of done:** the app builds for production and deploys; a model built from *any* current tool can be saved, reloaded, undone/redone (including delete/import/create), and recovered after a forced tab close; every kernel op passes through the validation gate; ≥80 % of the docs' verification numbers exist as automated tests; the Slice 5 question is closed.

### Phase 1: Core CAD  *(size: XL)*
- **Features:** remaining sketch entity set (arc, spline, ellipse, construction, multi-loop — freeform straight-line Polyline shipped 2026-09-22) with sketches as persistent document objects (unconstrained at this stage); extrude end conditions (mid-plane, up-to), thin features; **true sweep** (path, guides) and loft guides/closed; fillet variants (variable, face, full-round, setback) and chamfer types; shell (multi-thickness), draft (pull direction, neutral plane), rib; **Hole Wizard v2** (cbore/csink/tapped/blind, series); combine/split/intersect and multi-body ownership; primitives, patterns and mirror as **real B-Rep features**; reference axes/points/angled planes; **basic materials + mass/CoG/inertia** (B16); STEP import via XDE (structure, names, colours), **STEP export from live handles**, IGES, STL/OBJ import, glTF export; measurement types (angle, radius, face-to-face, min distance); selection filters, snapping engine, dynamic input.
- **Dependencies:** Phase 0 complete.
- **Architecture changes:** every tool becomes a registered feature type with parameter schema + editor; references resolved by a `ReferenceService` v1 (index + geometric fingerprint), designed so Phase 2 can swap in full persistent naming; tessellation profiles per purpose (display / export / analysis).
- **Recommended libraries/tech:** OCCT modules (`MakePipeShell`, `BRepFeat`, `BRepFilletAPI`, `STEPCAFControl`); `three-mesh-bvh` for picking; Three.js exporters.
- **Testing requirements:** per-feature golden tests with volume/area/topology-count and validity checks; fuzz tests on random valid parameters; STEP round-trip compare (volume, bbox, counts) against a corpus of real files (NIST CAD models, public STEP files).
- **Performance considerations:** BVH picking; edge overlays built from B-Rep edges once; incremental re-tessellation of the changed body only.
- **Definition of done:** the "bracket workflow" (sketch → extrude → hole → fillet → shell → pattern → mirror → export STEP → re-import) works on the same body without any origin-based restriction, and the capability matrix in §2 is all ✔ except documented physical limits.

### Phase 2: Parametric modeling  *(size: XL)*
- **Features:** **2D constraint solver + driving dimensions + DOF state** (B1); edit any sketch after the fact; **feature DAG** with rollback bar, suppress, reorder, error-per-feature (B3); **persistent naming** replacing the v1 resolver (B2) with a broken-reference repair UI; equations/named variables with units; design intent tools (symmetry, derived); part-level **configurations and design tables**; feature-of-feature patterns.
- **Dependencies:** Phase 1 features on the registry; kernel history capture from Phase 0.
- **Architecture changes:** sketch node in the DAG; regeneration scheduler with dirty propagation and cancellation; references replace every raw origin/normal and every traversal index.
- **Recommended libraries/tech:** planegcs (or SolveSpace `slvs`); an expression parser (mathjs-class, with units); spreadsheet import for design tables.
- **Testing requirements:** regeneration determinism (same inputs → same IDs); "edit upstream, downstream follows" suite including **bosses on faces** whose face moves; fully-defined-sketch tests; corrupted/legacy-file migration tests.
- **Performance considerations:** minimal-dirty-set regeneration; keep last good shape per node; background regen with progress and cancel.
- **Definition of done:** a 50-feature part regenerates correctly after editing its first sketch dimension; no feature silently mis-targets; rollback/suppress/reorder work with undo.

### Phase 3: Assemblies  *(size: XL)*
- **Features:** part vs assembly documents; component instances (definition + transform); insert/replace; **mates** (coincident, concentric, distance, angle, parallel, perpendicular, tangent, lock; gear/cam later) with DOF display and drag-solve; subassemblies (flexible/rigid); configurations at assembly level; **interference and clearance checks**; exploded-view steps and lines; **BOM** and properties (B15); in-context references; lightweight/resolved modes; large-assembly optimisations.
- **Dependencies:** Phase 2 (persistent references for mates; solver experience).
- **Architecture changes:** `PartDefinition`/`ComponentInstance` model; instancing in render; assembly regeneration graph separate from part graphs; external reference manager.
- **Recommended libraries/tech:** SolveSpace solver or a nonlinear least-squares library for 3D mates; `three-mesh-bvh`; OCCT `BRepExtrema`, `BRepAlgoAPI_Common`.
- **Testing requirements:** mate solve convergence on standard mechanisms (4-bar, slider-crank); over-/under-constrained detection; reference-break and repair; 1,000-component load benchmark.
- **Performance considerations:** instancing per definition; frustum culling; LOD; lazy-load component geometry; multi-threaded interference broad phase.
- **Definition of done:** a 200-part assembly (e.g. a gearbox) opens, mates solve interactively, interferences are reported, an exploded view with steps and a BOM export are produced.

### Phase 4: Drawings & documentation  *(size: XL)*
- **Features:** drawing document type; sheet formats and title blocks/templates; base/projected/auxiliary/section/detail/broken views with **hidden-line removal**; model-driven dimensions, hole callouts, centre marks; **GD&T** (feature control frames, datums), surface finish, weld symbols; BOM table and balloons; revision table and drawing revision fields; export **PDF, DXF** (DWG via licensed component); ISO/ANSI/DIN/JIS drafting standards presets.
- **Dependencies:** Phase 3 (BOM), Phase 2 (dimension refs), B25 standards.
- **Architecture changes:** drawing views reference a model revision and update on change; annotation objects reference persistent IDs; symbol library as data.
- **Recommended libraries/tech:** OCCT `HLRBRep_*`; SVG/Canvas2D sheet renderer; pdf-lib; a DXF writer library; fonts (OpenType via `opentype.js`); DWG only via a commercial SDK (ODA, etc.).
- **Testing requirements:** visual regression on reference drawings; dimension-follows-model tests; standards conformance checklists reviewed by a drafter; PDF/DXF opened in third-party tools.
- **Performance considerations:** HLR in worker with view-level caching; incremental view refresh; lightweight views for large assemblies.
- **Definition of done:** the Phase 1 bracket yields a fully dimensioned, toleranced drawing on an A3 ISO sheet with title block, BOM and revision table, exported as PDF/DXF, that updates when a sketch dimension changes.

### Phase 5: Sheet metal (and weldments)  *(size: L)*
- **Features:** base flange, edge flange, miter, hem, jog, bends (K-factor / bend allowance / bend tables), bend relief, corner treatments, forming tools (basic), **flat pattern** with DXF output and bend lines/notes; sheet-metal drawing views; **weldments** (profile library, trim/extend, gussets, cut list, weld beads).
- **Dependencies:** Phase 2 (features + references), Phase 4 (flat-pattern DXF/drawings), material/gauge tables.
- **Architecture changes:** sheet-metal feature family with a *bend graph* model (thickness + bends + flanges) that can unfold; cut-list from body properties.
- **Recommended libraries/tech:** custom on OCCT topology (no suitable open component); DXF writer; nesting library (optional).
- **Testing requirements:** unfold/refold round-trip length checks against hand-calculated bend allowances; industry sample parts; edge cases (self-intersection, relief).
- **Performance considerations:** unfold on demand; cache flat pattern per revision.
- **Definition of done:** a folded enclosure with bends and hems produces a flat pattern whose developed length matches calculation to tolerance, exported as DXF, with correct bend table.

### Phase 6: Engineering analysis  *(size: XL)*
- **Features:** assembly mass roll-up; **beam solver hardening** (worker, sparse, nodal/point loads, self-weight, section & material DB, releases, springs, P-Δ, modal, code-check hooks, reports); **linear static solid FEA** (fixtures, loads, contacts (bonded first), mesh controls, stress/displacement contours, probes); modal and linear buckling; steady-state thermal; fatigue as post-processing; basic motion study over mates.
- **Dependencies:** Phase 1 (materials), Phase 3 (assembly/mates), Phase 2 (persistent refs for boundary conditions).
- **Architecture changes:** `analysis` package with study documents stored in the Document; a compute service abstraction that can run locally (small) or remotely (solver microservice); results as first-class renderable datasets.
- **Recommended libraries/tech:** Gmsh (meshing), CalculiX / Code_Aster / Elmer (solver, server side), a sparse linear-algebra library for the beam solver; colour-map rendering.
- **Testing requirements:** verification against closed-form cases (cantilever, plate with hole Kt), NAFEMS benchmarks, and the existing beam spec extended to STAAD-published examples; mesh-convergence tests.
- **Performance considerations:** never solve on the UI thread; stream results; decimate for display; explicit memory limits.
- **Definition of done:** a bracket under load yields stress/displacement within a documented tolerance of a reference solver; a 2-storey frame matches a published STAAD example; both survive save/reload with results cached.

### Phase 7: CAM / manufacturing  *(size: XL)*
- **Features:** stock/setup/WCS; 2.5-axis (facing, pocket, contour, drilling), 3-axis (adaptive/parallel/scallop); turning; tool and material libraries; toolpath simulation with material removal; **post processors** and G-code output; then 4/5-axis; 3D-print prep as a side track.
- **Dependencies:** Phase 1 (features), B22 core selection, Phase 4 (setup sheets).
- **Architecture changes:** `cam` package; CAM operations are document nodes referencing model faces/edges via persistent IDs; simulation uses its own voxel/dexel representation.
- **Recommended libraries/tech:** an existing toolpath core (OpenCAMLib-class; verify WASM feasibility), custom strategies and posts; WebGL simulation.
- **Testing requirements:** G-code diffed against reference controllers' expected output; simulation collision tests; machine-in-the-loop validation before any "production" claim.
- **Performance considerations:** toolpath generation in workers/server; incremental update; simulation on GPU.
- **Definition of done:** a milled bracket produces verified G-code for a specific controller (e.g., Fanuc/Haas), simulated without gouges.

### Phase 8: Advanced CAD  *(size: XXL, optional, market-driven)*
- **Features:** advanced surfacing with continuity analysis; mold/tool design (core-cavity, parting, draft analysis); mesh-to-solid, point-cloud processing, reverse engineering; topology optimisation and generative design (server); composites; advanced kinematics.
- **Dependencies:** Phases 2, 3, 6.
- **Architecture changes:** service-side compute; extended body kinds (mesh/surface/solid).
- **Recommended libraries/tech:** Open3D/PCL-class libraries (server), optimisation frameworks; consider licensing a second kernel if Class-A surfacing becomes a requirement.
- **Testing requirements:** benchmark parts; comparison against reference tools.
- **Performance considerations:** GPU or cloud compute.
- **Definition of done:** defined per module after scoping conversations; none should be started opportunistically.

### Phase 9: Collaboration & enterprise  *(size: XXL)*
- **Features:** backend (auth, storage, projects); version history; check-in/out; permissions; metadata and part numbering; approval/release workflow; where-used; cloud/local storage; comments/markups; **public scripting API, plugin host, headless mode**; optional real-time co-editing.
- **Dependencies:** Phases 0–4 stable (identity model, schema versions, deterministic regeneration).
- **Architecture changes:** server holds authoritative operation logs; client syncs; kernel package runs headless in Node for batch and validation.
- **Recommended libraries/tech:** Node/NestJS or .NET; PostgreSQL; S3-compatible storage; OIDC auth; QuickJS/Pyodide script host; OpenAPI.
- **Testing requirements:** concurrency and conflict tests; permission matrix tests; migration tests across schema versions; load tests.
- **Performance considerations:** delta sync of operations rather than files; server-side thumbnail/tessellation caches.
- **Definition of done:** two users edit different parts of one assembly with history, locks and permissions; a script builds a parametric part headlessly and produces the same B-Rep as the UI.

---

## 7. Summary lists

### 7.1 Top 20 missing capabilities (ranked)

1. Native document format: save, open, autosave, crash recovery.
2. Sketch constraint solver with driving dimensions and a real entity set.
3. Persistent topological naming and a reference model (**partly done 2026-09-21**: planar-face anchoring for sketch-based features; permanent identity, edges and other feature types remain).
4. Full parametric history: all tools, sketch editing, DAG, rollback, suppress, reorder.
5. Undo/redo for geometry, delete, import.
6. Assembly core: components, mates, DOF, subassemblies.
7. STEP export of *all* in-app geometry, and STEP import with structure/names/colours.
8. Kernel validation and healing pipeline.
9. Feature completeness for daily part design (real sweep, extrude end conditions, cbore/csink/tapped holes, variable/face fillet, combine/split, rib, direct edit).
10. Predictable, uniform behaviour of every operation on every body kind (STEP, primitive, feature, copy, moved body); today it varies by tool.
11. Mass properties, material library, units.
12. 2D drawings with dimensions, GD&T, BOM, PDF/DXF.
13. Interference/collision detection.
14. Solid FEA (static first), meshing, contour results.
15. Configurations, equations, design tables.
16. BOM, metadata, part numbering.
17. Inspection: **angle, radius and face-to-face are done (2026-09-21)**; still missing minimum distance, section capping, curvature/draft analysis.
18. IGES/OBJ/STL import/DXF/glTF and versioned schemas.
19. Scripting/plugin API and headless mode.
20. Sheet metal and surface modelling.

(Just outside the top 20: CAM, PDM/collaboration, weldments, advanced CAD.)

### 7.2 Top 20 architectural risks (ranked)

1. **Feature edits could destroy geometry (found T4; fixed)**: a feature yielding several solids had all of them applied to one node on edit, so the last overwrote the block. Fixed by grouping edit results per feature and syncing extra solids to their own nodes. The general lesson stands: one feature → many bodies is not modelled explicitly.
2. **Kernel operations ignored body placement (found T3; fixed)**: moved bodies snapped back after Fillet, and cuts on them silently did nothing. The root cause is that the kernel frame and the view frame are two coordinate systems with no type-level distinction.
3. **Body identity = STEP bytes + solid index**; there is no shape store, so operations can't compose (one feature per body).
4. **Kernel reliability**: silent wrong results, no validation, a fillet-crashing edge, raw WASM exception pointers in UI. (The docs' "MakeFillet works once per page" claim did not reproduce, T2.)
5. **Persistent naming is partial (improved 2026-09-21)**: planar-face anchoring by signature works for sketch-based features (T4 fixed), but references elsewhere are still traversal indices, and matching can confuse similar parallel faces without warning.
6. **No document model, serialisation or persistence.**
7. **Undo architecture** is per-call-site closures and cannot cover geometry.
8. **Feature history is a linear list** with suffix replay and a hard-coded discriminated union.
9. **Kernel build/typing**: old prebuilt `opencascade.js`, no typings, runtime overload probing.
10. **Worker architecture**: 2,090-line monolith; 7 spawn sites each cold-starting WASM; nested-worker spawn failed; single-thread WASM.
11. **Sketch has no domain model** (no persistence, no constraint graph).
12. **No assembly model**; tree carries state flags (`hasStepSource`, `featureId`) that belong in a document.
13. **Verification is manual**: 3 spec files, hand-run Playwright scripts, `tsc --noEmit` known unreliable.
14. **Numerical robustness is ad hoc**: hand-picked tolerances, "cut both ways" as universal fix, float32 world coordinates.
15. **Rendering doesn't scale**: mesh per body, no BVH/instancing/LOD/culling, per-frame label projection, double tessellation.
16. **Extending the product means editing ~8 core files** (no tool/feature/command registries; 15+ panels in one component).
17. **Implicit coordinate frames**: world vs body-local space was mixed across `boundingBox`, snap reference points, plane frames and camera targeting (three separate bugs found for moved bodies). Nothing in the types distinguishes the frames, so more will exist (rotated bodies, non-uniform scale, Hole Wizard/Loft on moved bodies were not tested).
18. **Units hard-wired to mm.**
19. **Documentation is a changelog with stale intro and contradictions** (C1–C9); risk of building on false premises.
20. **Heavy-compute strategy is undefined**: no backend, single-thread WASM, main-thread structural solver; FEA/CAM/generative cannot be reached without a server story.

### 7.3 Critical dependencies (chain)

```
Working build (done) + regression suite
        │
        ▼
Kernel platform (custom OCCT, typed adapter, validation) ─────────────┐
        │                                                             │
        ▼                                                             │
Shape store + Document + command bus ──► Save/autosave ──► Undo/redo  │
        │                                                             │
        ├──► History capture ──► Persistent naming ──► Reference model │
        │                              │                              │
        ▼                              ▼                              │
Feature registry + DAG ──► Sketch module + solver ──► Parametric edits│
        │                              │                              │
        ├──► Assemblies (mates need references + solver)              │
        │         │                                                   │
        │         ├──► BOM, interference, exploded, motion            │
        │         └──► Drawings (need references + BOM + HLR)         │
        ├──► Sheet metal, weldments                                   │
        ├──► Materials/mass ──► FEA (needs BC references + mesher) ◄──┘
        └──► CAM (needs references + stock model)
                     │
                     ▼
            Server/collab/PDM (needs stable schema + deterministic regen)
```

Single points of failure: **kernel platform**, **document model**, **persistent naming**. Nothing above them is safe to build at scale until they exist.

### 7.4 Recommended technology stack

| Layer | Recommendation | Note |
|---|---|---|
| UI shell | Angular 20 (keep) with signals; feature contributions via registries | Already in use; strict TS is a plus |
| 3D render | Three.js + `three-mesh-bvh` + outline/edge post-processing; stencil capping | Keep Three.js; WebGPU is optional and later |
| Kernel | **Custom OCCT WASM build** (current release, only needed modules), typed adapter | Verify the opencascade.js custom-build tooling's maintenance status before committing; alternatives are replicad-style wrappers over the same kernel |
| Kernel hosting | Worker pool + Comlink; precompiled `WebAssembly.Module` shared; optional WASM threads (COOP/COEP) | Fixes cold start and duplicated memory |
| Sketch solver | planegcs or SolveSpace `slvs` | Do not write |
| Expressions/units | mathjs-class parser with unit support | |
| Persistence | IndexedDB (`idb`) journal + File System Access API + fflate zip container | Versioned JSON schema |
| Meshing/FEA | Gmsh; CalculiX / Code_Aster / Elmer behind a compute service; small in-browser solver for tiny models | Server needed for realistic size |
| Drawings | OCCT HLR; SVG/Canvas2D; pdf-lib; DXF writer; DWG via licensed SDK | |
| CAM | OpenCAMLib-class core (verify WASM build) + custom strategies/posts | |
| Interop | OCCT XDE (STEP/IGES/glTF); licensed translators for Parasolid/ACIS/DWG | |
| Testing | Vitest (kernel in Node), Playwright (CI, visual regression), golden corpus | |
| Backend (Phase 9) | NestJS or .NET, PostgreSQL, S3-compatible storage, OIDC | |
| Scripting | JS in a sandboxed worker; Pyodide optional | |

Versions and availability of the third-party items above are from general knowledge, not verified against the registries today. Confirm before adopting.

### 7.5 Suggested project/module structure

Monorepo (Nx or pnpm workspaces). The existing `src/app` layout maps onto it as noted.

```
apps/
  web/                      Angular shell (was src/app): chrome, panels, workspace layout
packages/
  kernel/                   OCCT WASM build, generated typings, typed adapter, validation gate,
  │   worker/               history capture, tessellation profiles, worker pool + RPC
  document/                 Document model, schema + migrations, command bus, undo, feature DAG,
  │                         feature-type registry, references / persistent naming, expressions
  sketch/                   entities, constraint graph, solver adapter, profile detection
  features/                 registered feature types (extrude, revolve, sweep, loft, fillet,
  │                         shell, draft, hole, pattern, mirror, combine, ... one folder each)
  assembly/                 definitions, instances, mates, DOF, interference, BOM, exploded, motion
  render/                   scene mirror of Document, picking (BVH/GPU), overlays, section, snapping
  drawing/                  views, HLR, annotations, GD&T, sheets, templates, exporters
  sheetmetal/  weldment/
  analysis/                 beam/ (was structural-*), fem/, results, motion/
  cam/
  io/                       step/ iges/ stl/ obj/ gltf/ dxf/ native/
  standards/                units, materials, fasteners, threads, gdt, drafting presets
  api/                      public API, script host, plugin host
  ui-kit/                   icon, panel-drag-handle, tokens (was directives/ + icon/ + styles)
  test-fixtures/            golden parts, STEP corpus, expected numbers
services/                   (Phase 9) collab, pdm, compute (FEA/CAM jobs)
tools/                      verify-*.mjs scripts become e2e tests here
docs/                       architecture overview (diagrams, invariants), user manual, ADRs
```

Mapping from today: `workers/step-loader.worker.ts` → split across `kernel/worker` and `features/*`; `TreeService`/`FeatureTreeService` → `document`; `SketchService` + `sketch-renderer` → `sketch` + `render`; `structural-*` → `analysis/beam`; `*-tool.service.ts` → one `features/<name>` each; `models/*` → owned by the package that uses them.

### 7.6 Prioritised implementation roadmap (first 20 steps)

| # | Step | Unblocks | Complexity |
|---|---|---|---|
| 1 | Persistent naming design spike (boss must follow its face); extend the regression scripts to rotated bodies and Hole Wizard/Loft on moved bodies | robust history | High |
| 2 | Decide Slice 5 (its blocker did not reproduce): finish or remove it | fillet/edge tools | Medium |
| 3 | Custom OCCT build + generated typings + typed kernel adapter | 4, 5, all features | High |
| 4 | Validation/healing gate on every op | reliability | Medium |
| 5 | Worker pool + RPC + cancellation | performance, 6 | Medium |
| 6 | Golden-geometry test suite from the docs' verified numbers; CI | safe refactoring | Medium |
| 7 | Document model + shape store + command bus | 8–12 | High |
| 8 | Save/open/autosave/recovery | first real product | High |
| 9 | Undo for all ops (delete/import/create) | trust | Medium |
| 10 | Feature/tool/command registries; migrate existing tools | velocity | High |
| 11 | Units/quantities | inch docs, standards | Medium |
| 12 | Move all shipped tools onto the feature graph; remove `hasStepSource` | bracket workflow | Very High |
| 13 | STEP XDE import + export from live handles; IGES/OBJ/STL/glTF | interop | High |
| 14 | Sketch entities + persistent sketch objects | 16 | High |
| 15 | Real sweep/loft/extrude end-conditions/hole v2/variable fillet/combine | core CAD | High |
| 16 | Sketch solver + dimensions | parametrics | Very High |
| 17 | Persistent naming + reference repair | robust history | Very High |
| 18 | Rollback/suppress/reorder, equations, configurations | design intent | High |
| 19 | Assembly core + mates + interference + BOM | assemblies | Very High |
| 20 | Drawings v1 | documentation | Very High |

Materials/mass properties (B16) is cheap and high-value: slot it right after step 12 or in parallel with step 13.

### 7.7 Features that should NOT be built from scratch

- **Geometry kernel** (use OCCT; a licensed kernel only if Class-A or Parasolid fidelity becomes a hard requirement).
- **2D constraint solver** and **3D mate solver** core numerics (planegcs / SolveSpace).
- **FE mesh generator** (Gmsh) and **FE solver** (CalculiX / Code_Aster / Elmer).
- **STEP/IGES translators**; **Parasolid/ACIS/DWG** (license).
- **Sparse linear algebra**.
- **Toolpath core** (OpenCAMLib-class).
- **PDF/DXF writers**, font handling, unit/expression parsing.
- **Broad-phase collision** (BVH).
- **Auth, storage, sync transport** in Phase 9.
- **Scripting engines** (QuickJS/Pyodide).
- **PBR rendering / path tracing** if ever needed (existing libraries).

### 7.8 Features that should be custom-built

- **Document model, feature DAG, regeneration scheduler and reference/persistent-naming layer.** This is the product's actual IP.
- **Kernel adapter and validation gate.**
- **Tool/feature/command frameworks and workspace UX.**
- **Sketch UX** (interaction, dimensions, dynamic input), even if the solver is bought.
- **Assembly mate semantics and DOF UX.**
- **Sheet-metal and weldment engines** (nothing suitable exists in OSS).
- **Drawing layout, annotation, GD&T semantics.**
- **Standards data libraries** (fasteners, materials, threads) curated from open sources.
- **Configuration/design-table engine.**
- **CAM strategies, posts and simulation UX.**
- **Public API surface and the plugin host contract.**
- **Analysis pre/post-processing UX** (loads, BCs, results, reports).

### 7.9 Checklist for reaching professional CAD maturity

**Foundations**
- [ ] Production build succeeds and is deployed
- [ ] CI runs build + tests on every change
- [ ] Custom OCCT build with typed adapter; no code touches raw embind
- [ ] Every kernel op passes a validity/healing gate; typed errors only
- [ ] Automated golden-geometry suite covers every feature type
- [ ] Warm kernel worker/pool; cancellable jobs with progress
- [ ] Document schema is versioned with migrations

**Modelling**
- [ ] Any feature can act on any body, regardless of origin
- [ ] Sketch has full entity set, constraints, dimensions, DOF status
- [ ] Feature DAG with rollback, suppress, reorder, per-feature errors
- [ ] Persistent naming; broken references are reported and repairable
- [ ] Sweep, loft (guides), extrude end-conditions, hole series, fillets (variable/face), shell, draft, rib, combine/split
- [ ] Patterns and mirrors are features on real B-Rep
- [ ] Configurations, equations, design tables

**Assemblies**
- [ ] Definition/instance model; nested subassemblies
- [ ] Mates with DOF and interactive solving
- [ ] Interference/collision, exploded steps, motion study
- [ ] BOM and properties; in-context references
- [ ] 1,000-part assembly is interactive

**Data**
- [ ] Save, autosave, crash recovery, dirty-state, recent files
- [ ] STEP AP214/242 in and out with structure, names, colours; IGES; STL/OBJ/glTF; DXF; DWG (licensed)
- [ ] Round-trip fidelity tests on a public corpus

**Analysis and manufacturing**
- [ ] Materials and units in every calculation; mass/CoG/inertia
- [ ] Beam solver: worker, sparse, complete load types, section DB, reports
- [ ] Solid static FEA with contour results; modal/buckling/thermal
- [ ] Sheet metal with validated flat patterns
- [ ] CAM with verified post-processed G-code (if pursued)

**Documentation**
- [ ] Drawings with HLR views, dimensions, GD&T, BOM, balloons, title blocks
- [ ] ISO/ANSI/DIN/JIS drafting standards presets
- [ ] PDF/DXF export

**Interaction**
- [ ] Every action undoable, including delete/import/create
- [ ] Selection filters/sets; snapping/inference; dynamic input
- [ ] Angle/radius/face-to-face/min-distance measurements; capped sections
- [ ] Rebindable shortcuts; command search; workspaces

**Platform**
- [ ] Public API, plugin host, headless mode
- [ ] Multi-user, versioning, permissions, PDM workflow
- [ ] Documentation set: architecture overview, user manual with per-origin capability matrix, tutorials that are tested in CI

---

## 8. What I did and did not verify

- **Verified at runtime** (§0.4, T1–T5): production bundle loads; two fillets in one page load succeed; the moved-body and multi-solid-edit defects were reproduced, fixed, and re-verified; a boss now follows its face when the parent is edited (fixed after the initial test showed it did not); cut → cut → fillet works on one STEP body.
- **Not verified**: everything else marked Implemented is the docs' claim. Shell, Draft, Hole Wizard, Pattern, Mirror, export, Loft chaining, the structural solver, and primitive → cut → fillet were not run.
- **Fixes made this session** (all in `src/app`): `TreeService.replaceBody` keeps the mesh transform; `planeRefInBodyFrame` (new util) converts face planes into the body frame for Extrude/Revolve/Sweep/Hole Wizard; `beginFromFace`/Hole Wizard no longer double-apply the transform; `extractFaceReferencePoints` returns world-space points; `SketchService.applyFeatureEditResult` handles multi-solid edits. Not covered: Loft's first profile on a moved body, rotated bodies, non-uniform scale.
- Third-party library names and versions in §7.4 come from general knowledge, not registry checks.
- Complexity ratings are relative judgments, not schedule estimates.
