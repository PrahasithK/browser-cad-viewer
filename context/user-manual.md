# User Manual: Browser CAD Viewer

This is the end-user guide to the Browser CAD Viewer. It explains how to use the application
to view, build, and analyze 3D mechanical parts and assemblies — no programming or developer
knowledge required.

If you're looking for how the application is built internally, see `context/architecture.md`
instead. This document only covers what you see and click.

---

## 1. What this application is

Browser CAD Viewer is a 3D mechanical CAD tool that runs entirely in your web browser — there is
no install, no account, and no server: everything you open, draw, and analyze stays on your own
computer for the life of the browser tab.

With it you can:

- **Open and inspect STEP files** (`.step`/`.stp`), the standard neutral CAD exchange format used
  by SolidWorks, Fusion 360, Inventor, Creo, and most other professional CAD tools.
- **Build simple geometry from scratch** using 2D sketches extruded into solids, or by dropping in
  primitive shapes (box, cylinder, sphere, cone).
- **Modify existing parts** — cut holes/pockets into an imported part, add bosses, round or bevel
  edges (fillet/chamfer), move/rotate/scale, rename, recolor, hide, or delete.
- **Inspect and document** a model — measure distances, read dimensions, view section (cutaway)
  cuts, generate an exploded view, and capture screenshots.
- **Build and run a basic structural (beam/frame) analysis** — a separate, secondary workflow from
  the solid-modeling tools, for simple linear-elastic frame calculations (nodes, members,
  supports, loads).

**What it is not, today:** a full parametric-history CAD system — an editable Feature Tree exists,
but only for **Extrude, Revolve, Sweep, and Loft** and only their numeric parameters (depth,
axis/angle, tilt/distance, or — for Loft — just the Cut checkbox), never the sketch profile itself;
every other tool (Fillet/Chamfer, Shell, Draft, Hole Wizard, primitives) is still final-once-applied
(see §3.9 and §3.13). This is also not a drafting/2D-drawing tool, or an assembly-constraint tool
(parts don't snap or mate to each other — you position them by hand). Section 11 lists everything
that is planned but not yet available, so
you know what to expect.

All dimensions in the application are in **millimeters (mm)**, shown in the status bar as
"Units: mm".

---

## 2. The screen layout

When you open the application you'll see five regions:

```
┌───────────────────────────────────────────────────────────────────────────┐
│  Menu bar  (File · Edit · View · Tools · Help)                            │
├───────────────────────────────────────────────────────────────────────────┤
│  Ribbon  (grouped buttons: Selection, Transform, Measure, Design, ...)    │
├───────────────────────────────────────────────────────────────────────────┤
│  View toolbar  (Undo/Redo, Fit All, view presets, shading, grid, ...)     │
├───────────┬───────────────────────────────────────────────┬───────────────┤
│  Model    │                                                │  Properties  │
│  Tree     │              3D Viewport (canvas)               │  Panel       │
│ (left)    │        + floating tool panels + nav cube        │  (right)     │
├───────────┴───────────────────────────────────────────────┴───────────────┤
│  Status bar  (selection · body count · triangle count · coordinates · FPS)│
└───────────────────────────────────────────────────────────────────────────┘
```

- **Menu bar** — traditional drop-down menus (File, Edit, View, Tools, Help) for actions used
  less often, or that have no natural toolbar home.
- **Ribbon** — the main toolbar, organized into labeled groups (Selection, Transform, Measure,
  Design, Add Shape, Features, Structural, Meshing, Display, Section, Exploded View). This is
  where you activate tools.
- **View toolbar** — a second, denser row just below the ribbon: Undo/Redo (with history
  dropdowns), camera framing, view presets (Front/Back/Left/Right/Top/Bottom/Iso), shading mode,
  grid/axes toggles, screenshot, fullscreen, and dark mode.
- **Model Tree** (left panel) — a hierarchical list of everything in your assembly: the
  Assembly root, each imported file, and each individual solid body inside it.
- **3D Viewport** (center) — the interactive 3D scene. This is where you orbit, pan, zoom, click
  to select, sketch, and place geometry. A small navigation cube sits in its top-right corner.
- **Properties panel** (right) — shows detailed information and editable fields for whatever is
  currently selected.
- **Status bar** (bottom) — live read-outs: current selection name, total body count, total
  triangle count, cursor's 3D world coordinates, frames-per-second, camera projection mode, and
  the unit system (mm).
- **Floating tool panels** — when you activate a tool (Sketch, Measure, Fillet/Chamfer, etc.), a
  small panel appears over the viewport with that tool's controls. These panels can be dragged
  around, or dropped near the left/right edge of the viewport to **dock** them into a fixed
  column (see §4.6).

---

## 3. The complete workflow, start to finish

This section walks through a full session in order — this is the path most users will follow.

### 3.1 Starting the application

The application always starts **empty**: no model is auto-loaded. The viewport shows just a grid
and axes, the Model Tree reads "No model loaded," and the status bar reads "0 bodies." This is
intentional — every session starts from a blank scene, and you choose what to load or build.

### 3.2 Opening a STEP file

This is the normal way to bring an existing CAD part or assembly into the application.

1. Click **File → Open STEP…** in the menu bar.
2. Your operating system's normal file picker opens. Navigate to and select a `.step` or `.stp`
   file (case-insensitive extension).
3. A loading dialog appears over the viewport with a progress spinner and status text (parsing →
   tessellating body 1 of N → …). Large or complex files can take several seconds to tens of
   seconds — this is normal; the file is being parsed by a real CAD geometry kernel running in
   your browser, not a lightweight preview format.
4. When loading finishes, every solid body in the file appears in the 3D viewport, the Model Tree
   populates with an Assembly → (file name) → Body 1, Body 2, … hierarchy, and the camera
   automatically frames the whole model.

**Important — "Open" replaces, it does not add.** Opening a second STEP file clears whatever is
currently loaded (geometry, selection, tree, Feature Tree and the Undo list) before loading the new
one. This matches the
"Open a document" convention in most desktop software — think of it like opening a new file in a
text editor, not inserting into the current one. If you need multiple separate parts in one
scene, build them up using the in-app creation tools (Sketch/Extrude, primitives) rather than by
opening several STEP files in sequence, since a second "Open" will discard the first file's
bodies.

**Sample files:** `public/assets/*.STEP` on disk are just example files provided for you to try —
they are not loaded automatically and behave exactly like any file you'd pick from your own
computer.

**Large files:** files in the 100+ MB range (a full or partial assembly with many parts) can take
several minutes to load — the loading dialog's status text will keep updating through parsing and
tessellation, so a long wait with active progress is normal, not a hang. Very large, deeply
detailed individual bodies within such a file may show a slightly coarser wireframe in Mesh View
(§6.4) than smaller bodies do, as a deliberate tradeoff to keep memory usage manageable; the
normal shaded view is unaffected.

### 3.3 Looking around the model (camera navigation)

Once something is loaded (or even on the empty grid), you can navigate freely:

| Action | Mouse | Purpose |
|---|---|---|
| Orbit/rotate | **Left-click + drag** | Rotate the camera around the model |
| Pan | **Middle-click + drag** | Slide the camera sideways/up/down |
| Zoom | **Scroll wheel** | Move the camera closer/farther |
| Right-click | **Right-click** | Opens the context menu (see §4.5) — this button is not used for camera control |

Additional framing tools, all in the **view toolbar**:

- **Fit All** (or press **F**) — frames the camera on the entire visible model.
- **Reset Camera** — returns to the default starting view.
- **Toggle Projection** — switches between Perspective (realistic, vanishing-point) and
  Orthographic (flat, true-to-scale) camera modes. The current mode is shown in the status bar.
- **View presets** (Front/Back/Left/Right/Top/Bottom/Iso, or keys **1–7**) — jumps the camera to a
  standard orthogonal or isometric viewing angle, matching the seven standard CAD viewpoints.
- **Navigation cube** (top-right of the viewport) — click any face of the small 3D cube to jump to
  that view; double-click it to return to the isometric view.
- **Double-click** any part in the viewport — zooms the camera to fit just that part.

### 3.4 Selecting things

Selection is the starting point for almost every other action (viewing properties, deleting,
measuring, moving, applying a fillet, etc.).

- **Click a part** in the viewport, or **click its row** in the Model Tree, to select it. The
  part highlights with an orange outline box and a small 3-axis gizmo at its center; the
  Properties panel fills in with its details; and — automatically, with no extra step — its
  overall Length/Width/Height appear as blue labels directly on the model in the 3D view.
- **Ctrl+Click** (or **Shift+Click**) a part to add it to the current selection (multi-select).
  Clicking an already-selected part this way removes it from the selection. Ctrl/Shift-clicking
  empty space does **not** clear your selection — it's a no-op, matching professional CAD
  convention (only a plain click on empty space clears).
- **Ctrl+A** — selects every body in the scene.
- **Click empty space** (no modifier key) — clears the selection.
- **Escape** — clears the selection and also cancels whatever tool is currently active.
- **"Clear Selection"** button (ribbon, Selection group) — same as clicking empty space.
- **Double-click a tree row's label**, or **right-click → Rename**, or **click the Name field**
  in the Properties panel — renames the part in place.

### 3.5 Understanding the Model Tree

The tree shows your assembly's structure:

```
Assembly
  └─ MyPart.STEP            (an "import" — one Open STEP… action)
       ├─ Body 1
       ├─ Body 2
       └─ Body 3
```

- **Assembly** — the root node, created automatically the first time you load or create anything.
- **Import nodes** (folder icon) — one per STEP file you've opened. Note: since "Open" now
  replaces rather than adds (§3.2), you will normally only ever see one import node, unless a
  future version reintroduces an explicit multi-file "Import" action.
- **Body nodes** (solid icon) — one per individual solid inside the file, or one per body you
  created via Sketch+Extrude or a primitive shape.
- Each body row has:
  - An **eye icon** — click to toggle that part's visibility on/off in the viewport.
  - A **trash icon** — click to delete that part (with a confirmation prompt — deletion cannot
    be undone).
  - Click the **expand/collapse chevron** on the Assembly or import row to show/hide its
    children.
- **Filter box** at the top of the tree — type any text to filter the tree down to matching part
  names (case-insensitive); ancestors of a match stay visible so you can see where it sits in
  the hierarchy. Press **Escape** while the filter box is focused to clear it.

**Note:** Reference Planes (§5.7) and Section (clipping) planes (§6.2) are **not** shown in the
Model Tree — both are managed from their own dedicated panels, the same way they're not solid
bodies with volume/faces/edges to browse.

### 3.6 Reading and editing part properties

Select a body, then look at the **Properties panel** (right side). It's organized into five
sections:

1. **General** — **Name** (click the value to rename in place), **Visible** (checkbox),
   **Color** (color swatch — click to open a color picker), **Opacity** (slider, 0 = fully
   transparent, 1 = fully opaque).
2. **Geometry** (read-only) — Volume, Surface Area, Faces (count), Edges (count).
3. **Mass Properties** — a **Material** dropdown plus the part's center of gravity, mass and
   moments of inertia (see §3.6.1 below).
4. **Bounding Box** (read-only) — the Min and Max corner coordinates of the part's axis-aligned
   bounding box.
5. **Transform** (read-only display; use the Move/Rotate/Scale gizmo in §3.7 to change these) —
   current Position, Rotation, and Scale.

Rename, visibility, color, opacity and material edits are all recorded in **Undo history** (§4.3).

#### 3.6.1 Material, mass, center of gravity and inertia

Every part starts with **no material**. In that state the panel shows only the part's **centroid**
(its geometric center), because mass needs a density. Pick a material from the **Material**
dropdown and the panel adds:

- **Density** (kg/m³) and **Mass** (shown in kg, g or mg, whichever reads best).
- **Center of gravity** (mm, world coordinates) — for a uniform-density part this is the same point as
  the centroid.
- **Ixx, Iyy, Izz** and **Ixy, Ixz, Iyz** — the moment and products of inertia in kg·mm², taken
  **about the center of gravity, in the world X/Y/Z axes**.
- **Principal I1, I2, I3** — the three principal moments (the tensor's eigenvalues, smallest first).
  Their directions (the principal axes) are not shown.

The library has eight materials: structural steel (A36), stainless steel 304, aluminium 6061-T6 and
7075-T6, titanium Ti-6Al-4V, copper C11000, grey cast iron and ABS plastic. The density, stiffness and
strength figures are **typical handbook values for quick estimates** — real alloys, tempers and plastics
vary, so check your specific grade before relying on a number. You cannot add your own materials yet.

Things worth knowing:
- The values update as you move or rotate the part: the center of gravity and the inertia are computed
  in world space from the part's current position and orientation.
- **Mass** uses the exact volume from the geometry kernel. The center of gravity and inertia are computed
  from the part's display mesh and scaled to that exact volume, so they are accurate to the
  tessellation (on the sample assembly the mesh volume is within 0.5 % of the exact volume for all 17
  bodies; a very coarsely tessellated curved part will be slightly less accurate).
- It works on every kind of part — STEP-imported, sketched, primitives, and copies — because it doesn't
  need the original file.
- The panel reports **one part at a time**. There is no total for a multi-selection or a whole
  assembly yet, and copies made by Duplicate/Pattern/Mirror keep the material of the original.
- The material is only used for mass properties today. It does not change the on-screen color, and the
  structural (beam) analysis in §7 has its own separate materials.
- A part with a mirrored or inside-out mesh still reports a positive volume and mass.

### 3.7 Moving, rotating, and scaling parts

Select a part, then use the **Transform group** in the ribbon (or keyboard shortcuts) to attach
an interactive on-screen gizmo:

| Mode | Button | Shortcut |
|---|---|---|
| Move | Move icon | **G** |
| Rotate | Rotate icon | **R** |
| Scale | Scale icon | **Y** |

- Click the mode button (or press the key) with a part selected — colored drag handles (arrows
  for Move, rings for Rotate, boxes for Scale) appear on the part.
- **Drag a handle** with the mouse to move/rotate/scale along that axis.
- Click the same mode button again (or press its key again) to turn the gizmo off.
- **Escape** also turns the gizmo off.
- These buttons are disabled whenever nothing is selected.
- Every drag is recorded as one Undo step (see §4.3) — a drag that doesn't actually move anything
  doesn't create an extra Undo entry.
- If you have multiple parts selected (multi-select), the gizmo only moves the "primary"
  (most-recently-clicked) one — the rest of the selection stays highlighted but isn't
  transformed.
- **A moved part stays where you put it.** Tested: Move followed by Fillet/Chamfer, and Move
  followed by a sketch cut — both keep the part at its moved position and cut in the right place.
  Hole Wizard, Feature Tree edits, Revolve and Sweep are built the same way but were not tested
  after a move. Rotate and Scale followed by any of these tools were **not** tested; if a part
  jumps or a cut lands in the wrong place after you rotate or scale it, undo the transform
  (Ctrl+Z) and apply the tool first.

### 3.8 Duplicating, hiding, isolating, deleting

**Right-click any part** in the viewport for a context menu:

| Menu item | What it does |
|---|---|
| Hide | Hides the selected part |
| Isolate | Hides everything **except** the selected part |
| Show All | Makes every part visible again |
| Toggle Transparent | Toggles the selected part's opacity between 1.0 and 0.4 |
| Zoom to Fit | Frames the camera on just the selected part |
| Rename | Opens the inline rename field |
| Duplicate | Creates a single copy of the selected part, offset +20 mm on X, as a new tree entry |
| Properties | Flashes the Properties panel header (a highlight cue — the panel is always visible, so this just draws your attention to it) |
| Delete Part | Deletes the selected part, after a confirmation prompt |

You can also delete a part via its **trash icon** in the Model Tree row, or by selecting it and
pressing **Delete** or **Backspace**.

A confirmation dialog appears first. **Deletion is undoable** (since 2026-09-24): **Ctrl+Z** puts
the part back exactly where it was in the Model Tree. It's still usable for everything it was
before: a STEP-imported part can still be cut or filleted, and a feature-tree part can still be
edited in the Feature Tree. **Ctrl+Y** deletes it again.

**Need more than one copy, arranged in a row or a circle?** Duplicate above only ever makes a
single offset copy. For several evenly-spaced copies at once — a row of bolt holes, a bolt
circle — use **Pattern** instead (§5.4), which creates all the copies in one operation and undoes
them all together as one step.

### 3.9 Building new geometry

There are ten ways to add or modify solid geometry: **Sketch + Extrude/Revolve/Sweep**, **Loft**,
**direct primitives**, (for existing parts) **Fillet/Chamfer**, **Hole Wizard**, **Shell**, and
**Draft**, **Pattern** (array-copying a part you already have), and **Mirror** (a reflected copy
of a part you already have). See §5 for full details on each tool. In short:

- Use **Sketch** when you need a custom 2D profile (rectangle, circle, polygon, or slot) turned
  into a 3D solid — either **extruded** into a brand-new standalone body or cut/added directly
  into an existing part by sketching on one of its faces, **revolved** around the sketch plane's
  own axis into a standalone part of revolution (a shaft, flange, or knob), or **swept** along a
  straight, tilted path into a standalone oblique prism (an angled rib or wall).
- Use **Loft** when a part's cross-section genuinely changes shape along its length (not just
  grows/shrinks in a straight line) — blend between 2 or more profiles, each on its own plane,
  into one smooth solid.
- Use **Box / Cylinder / Sphere / Cone** (in the ribbon's Add Shape group) when you just need a
  simple primitive solid, positioned by a single click, with no sketching involved.
- Use **Fillet / Chamfer** on an existing STEP-imported part to round or bevel one or more of its
  edges.
- Use **Hole Wizard** on an existing STEP-imported part when you need a standard fastener-size
  through-hole (metric or inch) without sketching a circle or looking up a clearance diameter
  yourself.
- Use **Shell** on an existing STEP-imported part when you need to hollow it out to a wall
  thickness, opening one or more picked faces — turning a solid block into an enclosure or
  housing.
- Use **Draft** on an existing STEP-imported part when you need to taper one or more picked faces
  by a mold-pull angle so it releases cleanly from an injection mold or casting tool.
- Use **Pattern** on any existing part when you need several evenly-spaced copies of it at once —
  in a straight line or around a circle — instead of positioning each copy by hand.
- Use **Mirror** on any existing part when you need a reflected copy across the assembly's X, Y, or
  Z center plane — a symmetric bracket or an opposite-handed part — instead of modeling the
  mirrored half by hand.

**Important limitation to understand up front:** this application has only a **partial** parametric
feature history — see §3.13 for the full picture. **Extrude, Revolve, Sweep, and Loft** (only these
four) can be double-clicked in a new **Feature Tree** panel afterward to edit their parameters
(depth, axis/angle, or tilt/distance for the first three; just the Cut checkbox for Loft) and
re-apply — the closest thing this app has to SolidWorks/Fusion 360's feature-editing workflow,
though the sketch profile itself still can't be changed, only those parameters. Every other
operation — placing a primitive, Fillet/Chamfer, Hole Wizard, Shell, Draft, Pattern, Mirror — is
still final the moment you apply it, with no later "double-click and edit" step at all. If you need
a different result from one of those, delete the
body (if undoable, via Undo — otherwise via the trash icon; deleting is itself undoable, but
geometry creation mostly isn't on the Undo stack — see §4.3, though Pattern and Mirror are both
**notable exceptions**: both are undoable — see §5.4/§5.5) and redo the operation with new inputs.

### 3.10 Reviewing your work: measuring, sectioning, exploding

- **Measure tool** — distance between two points, angle from three points, distance or angle between
  two flat faces, and radius/diameter of a circular edge, each shown in the side panel and as a live
  label in the viewport (§6.1).
- **Section (clipping) planes** — slice through the model along X, Y, or Z to see inside it
  (§6.2).
- **Exploded view** — pull all bodies apart radially to see how an assembly is composed (§6.3).
- **Mesh View** — toggle a wireframe overlay showing the underlying triangulated surface mesh
  (§6.4).

### 3.11 Saving your work / exporting

**Saving a project (since 2026-09-24).** Use **File → Save Project** or **Ctrl+S** to download
your whole document as a `.cadproj` file. Use **File → Open Project…** to pick one and carry on
exactly where you left off. The file name comes from your STEP file (e.g.
`DM556MotorDriverAssembly.cadproj`), or `untitled.cadproj`. The browser saves it to your normal
Downloads folder.

What a project keeps:
- Every part, whatever made it, with its name, color, transparency, material, position and
  visibility, and the Model Tree as it was.
- The **Feature Tree**, still editable. Opening rebuilds each feature's history in the geometry
  kernel (a "Rebuilding feature history…" dialog shows while it runs), so you can double-click a
  feature and change it exactly as before saving.
- The original STEP file, so you can still cut into, fillet or put a hole in imported parts.

What a project doesn't keep yet: reference planes, the structural model, measurements, section
planes, the undo history (a reopened project starts with an empty Undo list), and Mesh View
overlays (re-open the STEP file if you need Mesh View).

Saving waits for any operation that's still running (for example a Feature Tree edit on a large
part) to finish first, with a "Saving project…" dialog in the meantime.

**File → New** clears everything and starts an empty document, asking first if there are parts
loaded. **Closing or reloading the tab still discards unsaved work without a prompt**, and there's
no autosave yet, so save before you close.

You can also export your model as a CAD file for use in other programs:

- **File → Export STEP…** — writes every currently-loaded body that qualifies (see below) into
  one combined STEP file and downloads it as `export.step`. This is a real, re-openable CAD file
  — you (or anyone else, in any STEP-capable CAD tool) can open it again later.
- **File → Export STL…** — writes **every** currently-loaded body, regardless of how it was
  created, into one combined binary STL file and downloads it as `export.stl`. STL is a
  triangulated-mesh format, standard for 3D printing and widely readable, but it has no true
  solid/BRep geometry — just a surface mesh.
- **File → Save Screenshot** (or the camera icon in the view toolbar) — captures the current 3D
  view as a PNG image and downloads it as `cad-viewport.png`. This is a picture of the screen,
  not a CAD file — it cannot be re-opened or edited as a model.

**The STEP export limitation to understand:** only bodies that still have a real, re-readable
original STEP solid can be included in a STEP export — in practice, this means bodies that came
from an opened STEP file **and have not since been cut, filleted, or chamfered**. A body created
by Sketch/Extrude, a primitive shape, or one that's already been through Fillet/Chamfer or a
face-sketch cut, has no BRep solid to write into a STEP file — only a triangulated mesh exists for
it. If you export STEP with any such bodies in the scene, the application **does not fail or
silently drop them without telling you** — it exports every body that does qualify, then shows a
summary listing exactly which bodies were left out and why, so you always know what you got. If
you need every body included regardless of origin, use **Export STL…** instead — it has no such
restriction.

If nothing is loaded, or nothing qualifies for STEP export, you'll see a clear message instead of
a downloaded file.

### 3.12 Undo / Redo

Almost every property-style edit can be undone. See §4.3 for exactly what is and isn't covered.

### 3.13 The Feature Tree: editing Extrude, Revolve, Sweep, and Loft after the fact

Every other section of this manual describes geometry tools as final-once-applied. **Extrude,
Revolve, Sweep, and Loft are the four exceptions** — after you create one, you can come back later
and change its parameters, and the model updates accordingly.

**Where to find it:** Ribbon → Display group → **Feature Tree**. This opens a dockable panel (same
drag/dock behavior as every other tool panel — see §4.6) listing every Extrude, Revolve, Sweep, and
Loft you've created in the current session, in the order you created them.

**Editing a feature:**

1. Open the Feature Tree panel.
2. **Double-click** a row — an inline edit form appears in its place, pre-filled with that
   feature's current values (Depth + Cut for an Extrude row; Axis + Angle + Cut for a Revolve row;
   Tilt axis + Tilt angle + Distance + Cut for a Sweep row; just the **Cut** checkbox for a Loft
   row — see the Loft-specific limitation below for why).
3. Change the value(s) you want.
4. Click **Apply**. The button reads "Applying…" while it recomputes — a Loft's own recompute can
   take noticeably longer than the other three kinds (it's blending an entire surface between
   profiles, not just building a simple prism/revolve/sweep shape), so don't assume it's stuck if
   Apply takes a few seconds.
5. The affected body updates in the 3D view immediately, in place — same tree node, same position,
   not a new body. Click **Cancel** instead to close the edit form without changing anything.

**What makes this different from a simple "undo and redo with new numbers":** if you built a second
feature that cuts into or fuses onto the body an edited feature produces, that second feature is
automatically recomputed too, using the edited feature's new geometry — not the old one. For
example: extrude a block, then sketch on one of its faces and cut a hole in it (a second,
separate Extrude feature); later, go back to the Feature Tree and increase the first block's depth
— the hole is recomputed against the taller block and **moves with the face it was sketched on**,
without you having to redo the cut yourself. It keeps its own depth, measured from that face (see the
next section on features following their face). This is confirmed working between two features of the same kind
(e.g. a Revolve cutting into another Revolve's own output, or a Sweep edited with a dependent Sweep
cut into it); Extrude, Revolve, Sweep, and Loft are all built to chain into each other's output the
same way, though not every combination of two different kinds has had equally direct testing.

**What you can't do here:**

- **Only Extrude, Revolve, Sweep, and Loft appear in this panel.** Primitives, Fillet/Chamfer, Hole
  Wizard, Shell, Draft, Pattern, and Mirror never show up here — they have no Feature Tree entry,
  and stay final-once-applied exactly as described everywhere else in this manual.
- **You can't edit the sketch profile itself** — only the numeric parameters (Depth/Cut for
  Extrude, Axis/Angle/Cut for Revolve, Tilt axis/Tilt angle/Distance/Cut for Sweep). If you drew
  the rectangle in the wrong place or need a different shape entirely, the Feature Tree can't fix
  that; delete the body and redraw it.
- **A feature sketched on a face follows that face when you edit the feature that made it.**
  Example (tested): extrude a block 20 mm, fuse a boss on its top face, then edit the block to 60 mm —
  the boss moves up with the top face and ends 10 mm above it (its top goes from 30 mm to 70 mm), and
  Ctrl+Z puts everything back exactly. This applies to Extrude, Revolve and Sweep features drawn on a
  face of an earlier Extrude, Revolve, Sweep or Loft in the same session. How it works and what to
  expect:
  - The sketch remembers the face by its direction, size and position. After an edit it looks for the
    face that faces the same way and changed least, and shifts the sketch by however far that face's
    center moved.
  - **A cut keeps its own depth, measured from the face.** A 30 mm-deep cut on a 20 mm block cuts right
    through it; after you change the block to 60 mm the same cut is still 30 mm deep from the top and
    no longer goes all the way through (tested: the result is exactly the 60 mm block minus a 30 mm
    hole). If you want a through-hole that survives growing the part, give the cut a depth at least as
    large as the biggest the part will ever be.
  - If the edit removes the face — nothing faces the same way any more — the edit is refused with the
    message "The face this feature was sketched on no longer exists after the edit…". Try a smaller
    change. Note that the geometry is not rolled back automatically in this case (see Limitations
    below).
  - **Limitations:** the face is matched by direction, size and position, not by a permanent identity, so
    if several faces face the same way and look alike (for example two identical parallel faces at
    different heights) the wrong one can be chosen. Only **flat** faces are supported. It does not apply to
    Loft, Hole Wizard, Fillet/Chamfer, Shell or Draft, nor to a body imported from a STEP file (those
    never change, so nothing needs to follow). A sketch drawn on a datum plane or a reference plane stays
    where it is. If an edit is refused partway through a chain of features, the panel shows the error but
    the internal state may already reflect part of the edit; making a new valid edit puts it right.
- If one feature produces more than one separate solid (for example a boss drawn where it doesn't
  touch the part, or a cut that splits a part in two), editing that feature updates each solid
  separately. Earlier builds overwrote the main body with the last solid; that is fixed.
- **Loft's own edit surface is narrower than the other three: only the Cut checkbox.** You can't
  add, remove, or reorder a Loft's cross-section profiles after the fact through this panel — if
  you need a different set of profiles, delete the body and redo the Loft from scratch (§5.11).
- Feature Tree entries are saved with **File → Save Project** and stay editable after **Open
  Project…** (§3.11). Closing or reloading the tab without saving loses them.

**A Feature Tree edit IS on the Undo stack** (§4.3): press **Ctrl+Z** right after clicking Apply
and the feature (and anything built on top of it) reverts to its value before that edit, with the
Feature Tree row itself updating to match. **Ctrl+Y** redoes it. This is a genuinely separate,
correctly-integrated Undo step, not just "the geometry happens to look right" — reopening the edit
form after an undo shows the reverted value too. Undo/Redo here can take a moment on a larger model
(the same worker recomputation an Apply click triggers runs again); the Apply/Cancel buttons show
"Applying…" and are disabled for that moment, whether the recompute was triggered by Apply, Undo,
or Redo.

---

## 4. Core interface concepts

### 4.1 The Ribbon groups

| Group | Contains |
|---|---|
| **Selection** | Clear Selection |
| **Transform** | Move / Rotate / Scale gizmo toggles |
| **Measure** | Measure tool (Distance / Angle / Faces / Radius modes), Clear (measurements) |
| **Design** | Sketch, Loft |
| **Add Shape** | Box, Cylinder, Sphere, Cone |
| **Features** | Fillet / Chamfer, Pattern, Mirror, Hole Wizard, Shell, Draft |
| **Reference Geometry** | Reference Plane |
| **Structural** | Add Node, Add Member |
| **Meshing** | Bridge Mesh |
| **Display** | Mesh View, Feature Tree |
| **Section** | X Plane, Y Plane, Z Plane |
| **Exploded View** | Explode-amount slider, Reset |

A ribbon button showing as "pressed"/highlighted means that tool is currently active.

### 4.2 The View toolbar

Left to right: Undo (with a history-dropdown caret), Redo (same), a separator, Fit All / Reset
Camera / Toggle Projection, a separator, the seven view-preset buttons, a separator, three
shading-mode buttons (Solid / Wireframe / Transparent), a separator, Grid toggle / Axes toggle, a
separator, Screenshot / Fullscreen / Dark Mode toggle.

### 4.3 Undo / Redo — exactly what is and isn't covered

- **Shortcuts:** **Ctrl+Z** (Undo), **Ctrl+Y** (Redo). Also available as toolbar buttons and in
  the **Edit** menu.
- **History dropdown:** click the small caret next to the Undo or Redo button to see a list of
  recent labeled steps (e.g. "Move: Body 3", "Section X offset") and jump straight to any point
  in that list, instead of clicking Undo/Redo repeatedly.
- **Covered by Undo/Redo:** rename, visibility toggle, color change, opacity change, material
  assignment, Move/
  Rotate/Scale gizmo drags, section-plane offset/enable/flip, Duplicate, Pattern (every copy from
  one Apply undoes/redoes together as a single step — see §5.4), Mirror (see §5.5), **deleting a
  part** (Undo puts it back in the same place in the Model Tree, still fully usable), and **Feature
  Tree edits** — editing an Extrude/Revolve/Sweep/Loft's parameters afterward through the Feature
  Tree panel (§3.13) is a real Undo step: Ctrl+Z reverts it (and correctly recomputes any
  downstream feature built on top of it), Ctrl+Y redoes it. A Loft's own recompute can take a few
  seconds (see §3.13) — the Undo/Redo toolbar buttons stay enabled during that time, but pressing
  either again immediately queues correctly rather than getting lost, so there's no need to wait
  for one step to visibly finish before pressing the next.
- **NOT covered by Undo/Redo** (these are permanent the moment you do them — this is about the
  CREATION of the geometry; if it's Extrude, Revolve, Sweep, or Loft, a later edit of its params
  through the Feature Tree panel is still a separate, undoable action, per the bullet above):
  - Opening a STEP file (replaces the whole scene)
  - Sketch → Extrude, Revolve, Sweep, or Loft (creating new geometry — editing an already-created
    one afterward is covered, see above)
  - Placing a primitive shape (Box/Cylinder/Sphere/Cone)
  - Fillet / Chamfer
  - Hole Wizard
  - Shell
  - Draft
  - Bridge Mesh generation
  - Structural model edits (nodes, members, loads, supports, analysis)

  If you make a mistake with one of these, your only recovery is to manually delete the resulting
  body/data and redo the operation — **except Extrude, Revolve, Sweep, and Loft**, which
  additionally have the Feature Tree panel (§3.13) to change their parameters afterward, undoably,
  as just described.

### 4.4 Keyboard shortcuts (full list)

| Key | Action |
|---|---|
| **Esc** | Clear selection and cancel the active tool |
| **Delete** / **Backspace** | Delete the selected part (asks for confirmation) |
| **F** | Fit All (frame the whole model) |
| **1–7** | Jump to view preset: Front / Back / Left / Right / Top / Bottom / Iso |
| **M** | Toggle the Distance (Measure) tool |
| **S** | Toggle the Sketch tool |
| **Enter** | While drawing a Polyline sketch profile (3+ points placed): close it |
| **G** | Toggle the Move gizmo (on current selection) |
| **R** | Toggle the Rotate gizmo (on current selection) |
| **Y** | Toggle the Scale gizmo (on current selection) |
| **Ctrl+A** | Select all bodies |
| **Ctrl+Z** | Undo |
| **Ctrl+Y** | Redo |
| **Ctrl+S** | Save Project (§3.11) |

Shortcuts are disabled while you're typing in any text field, number field, or rename box (so
typing "s" into a name field doesn't accidentally toggle Sketch). You can also open this same list
in-app via **Help → Keyboard Shortcuts**.

### 4.5 Mouse interactions (full list)

| Mouse action | Effect |
|---|---|
| Left-click (empty space, no tool active) | Clear selection |
| Left-click (on a part, no tool active) | Select that part |
| Ctrl/Shift + left-click (on a part) | Add/remove that part from a multi-select |
| Left-click + drag | Orbit the camera |
| Middle-click + drag | Pan the camera |
| Scroll wheel | Zoom in/out |
| Right-click | Open the context menu at the cursor |
| Double-click (on a part) | Zoom camera to fit that part |
| Double-click (while drawing a Polyline sketch profile, 3+ points placed) | Place a final point at the cursor and close the profile |
| Double-click (navigation cube) | Jump to isometric view |
| Left-click (while a tool like Sketch/Measure/Fillet-Chamfer is active) | Performs that tool's click action (place a point, pick a face, pick an edge, etc. — see each tool's section) |

### 4.6 Floating & dockable tool panels

Every tool (Measure, Section, Sketch, Structural, Analysis Results, Bridge Mesh, Add Shape,
Fillet/Chamfer, and others — Pattern, Mirror, Hole Wizard, Reference Plane, Shell, Draft, Loft all
follow the same panel behavior described here) opens a small panel over the viewport when active.
The **Feature Tree** panel (§3.13) works the same way but isn't tied to an active tool — it stays
open until you close it, the same way the Model Tree/Properties panels have no "active" state.

- **Move a panel:** click-drag its title bar.
- **Dock a panel:** drag it within about 40 px of the viewport's left or right edge and release —
  a highlighted drop zone appears while you're close enough. Docking turns the panel into a fixed
  column that actually **shrinks the 3D viewport** to make room (not just an overlay).
- **Undock:** drag a docked panel's title bar back out into the open canvas area.
- Multiple panels docked to the same side stack vertically.
- **Close a panel** with its **×** button — this deactivates that tool (equivalent to clicking its
  ribbon button again, or pressing Escape).
- Panel positions and dock state, plus the Model Tree/Properties panel column widths, are
  **remembered across page reloads** (saved in your browser's local storage) — everything else
  (the model itself, selection, tool state) is not (§3.11).

### 4.7 Resizing the side panels

Hover over the inner edge of the Model Tree (right edge) or the Properties panel (left edge) — the
cursor changes to a resize cursor. Click and drag to widen or narrow that panel.

### 4.8 The status bar, explained

From left to right: current selection's name (or "No selection") · total body count · total
triangle count in the scene · the 3D world coordinate under your cursor (or blank over empty
space with nothing to raycast against) · rolling FPS (frames per second, a performance indicator)
· current camera projection (Perspective/Orthographic) · unit system (always "Units: mm").

---

## 5. Every geometry-creation and modification tool

### 5.1 Sketch (2D profile → 3D solid)

**What it does:** Lets you draw a closed 2D profile on a flat plane, then finish it one of three
ways: **extrude** (push) it into a 3D solid — as a new standalone body, or added to / cut from an
existing part; **revolve** (spin) it around an axis to create a solid of revolution (shafts,
flanges, knobs, and any other part shaped like something spun on a lathe); or **sweep** (push at
an angle) it along a straight, tilted path to create an oblique/angled prism (angled ribs, gussets,
or any wall that isn't perpendicular to its own base).

**Where to find it:** Ribbon → Design group → **Sketch** button, or press **S**.

**When to use it:** Whenever you need custom geometry that isn't a simple box/cylinder/sphere/
cone — a bracket outline, a slot, a custom hole shape, a boss on a specific face, etc.

**Step by step:**

1. Click **Sketch** (or press **S**). The Sketch panel opens.
2. **Choose a plane to sketch on** — either:
   - Click one of the three **datum plane buttons** (**XY**, **YZ**, **XZ**) to sketch on a
     global reference plane through the origin — use this when there's no existing geometry to
     sketch against, or when you want a plane at a fixed world orientation; or
   - **Click directly on a flat face of an existing part** in the viewport. The application
     detects the face's plane, highlights it, automatically orbits the camera to look straight
     at it, and shows small colored dots at the face's corners/midpoints/circle-centers — these
     are **snap references** your next clicks will snap to.
   - Only **flat (planar)** faces can be sketched on — clicking a curved face shows an error and
     keeps you in the picking step.
3. **Pick a shape** using the five icon buttons: **Rectangle**, **Circle**, **Polygon**, **Slot**,
   **Polyline**.
4. **Click in the viewport to draw**, per shape. Rectangle/Circle/Polygon/Slot are exactly 2 clicks;
   Polyline is any number of clicks, closed explicitly (see below):
   - **Rectangle** — click one corner, then the opposite corner.
   - **Circle** — click the center, then click again to set the radius.
   - **Polygon** — click the center, then click to set the radius; use the **Sides** number field
     (3–20) to set how many sides.
   - **Polyline** — click each corner of your shape in order, as many as you need (minimum 3). A line
     follows your cursor from the last point you placed. Finish with any one of:
     - clicking back on the **first** point you placed,
     - pressing **Enter**,
     - **double-clicking** to place the final point and close in one action, or
     - clicking the **Finish Polyline** button that appears in the panel once you have 3+ points.
     The last point always connects back to the first automatically — you don't click the first
     point again unless that's how you choose to finish. The shape can be concave (an L-bracket, a
     notched plate) — it doesn't have to be convex like the other four shapes effectively are.
   - **Slot** — click the start point, then the end point; use the **Width (mm)** field to set the
     slot's width.
   - While drawing, moving your mouse near a snap reference (highlighted dot) will snap your next
     click to it exactly, shown by a small yellow ring indicator.
   - A live preview outline follows your cursor as you draw.
5. Once the profile is complete, choose **Extrude**, **Revolve**, or **Sweep** using the toggle
   that appears (Extrude is selected by default):
   - **Extrude:**
     - **Depth (mm)** — how far to extrude.
     - **Cut (remove material)** checkbox — leave unchecked to **add** material (a "boss," fused
       onto the target part, or a new standalone solid on a datum plane); check it to **cut**
       (remove) material from the part you sketched on. (Cut only makes sense — and only appears
       meaningfully useful — when you sketched on an existing part's face, not a datum plane.)
     - Click **Extrude**. The button reads "Extruding…" while the operation runs.
   - **Revolve:**
     - **Axis** — which in-plane direction of the sketch plane to spin the profile around: the
       plane's **U axis** or **V axis** (for a datum plane, these are simply two of the world
       X/Y/Z directions; for a face-picked plane, they're the two directions in that face).
     - **Angle (°)** — how far around to sweep, from 1° up to a full 360°.
     - **Important:** the profile must not cross the chosen axis — draw it entirely to one side,
       the same way a real lathe profile never crosses the spindle centerline. If it does, Revolve
       fails with a clear error (see below).
     - **Cut (remove material)** checkbox — same meaning as Extrude's own: leave unchecked to add
       material (fused onto the part you sketched on, or a new standalone solid on a datum
       plane); check it to cut (remove) material from the part you sketched on. Only has an
       effect when you sketched on an existing part's face.
     - Click **Revolve**. The button reads "Revolving…" while the operation runs.
   - **Sweep:**
     - **Tilt toward** — which in-plane direction (the sketch plane's own **U axis** or **V
       axis**) the sweep path leans toward, away from straight-up (the plane's own normal — the
       same direction Extrude always uses).
     - **Tilt angle (°)** — how far to lean, from 0° up to 89°. At 0°, Sweep produces the exact
       same result as an Extrude of the same distance — it's only at higher angles that Sweep
       does something Extrude can't: an oblique, angled prism.
     - **Distance (mm)** — how far to push along the tilted path.
     - **Cut (remove material)** checkbox — same meaning as Extrude's own; only has an effect when
       you sketched on an existing part's face.
     - Click **Sweep**. The button reads "Sweeping…" while the operation runs.
6. Result: a new solid appears (added to the tree as "Feature Body N"), or — for any of the three
   modes with **Cut** (or, for Extrude, boss/add) targeting an existing part's face — that same
   part is **replaced in place** in the tree (same position, same name pattern) with the modified
   geometry. Sketching on a datum plane instead of a face always produces a new standalone body,
   regardless of mode or the Cut checkbox's state.

**Input required:** a plane choice, a 2-click profile, an optional shape parameter (sides/width),
then a depth + cut/add choice (Extrude), an axis + angle + cut choice (Revolve), or a tilt axis +
tilt angle + distance + cut choice (Sweep).

**Output:** one new solid body, or a modified existing body when the sketch was on a picked face
and (for Extrude) Cut/boss, or (for Revolve/Sweep) the Cut checkbox, was used.

**Limitations:**
- One closed profile per sketch — you can't combine a rectangle and a circle in the same sketch
  (Polyline is one profile too — a multi-segment outline, not multiple separate shapes).
- Polyline is straight segments only — no arcs or curves within a polyline profile, and no sketch
  dimensioning/constraints for any shape (no "make this edge exactly parallel to that one," no
  numeric dimension you can later edit) — profiles are purely geometric, defined by where you click.
- A Polyline profile that crosses or touches itself (a figure-eight, a self-intersecting outline) is
  not a valid closed loop; Extrude/Revolve/Sweep will fail with a boolean-operation error at that
  point rather than silently producing a bad shape (see §5.1's errors table).
- Cutting/adding into an existing part generally only works for parts that came from an opened
  STEP file (the tool needs to re-read the original file's geometry) — **with one exception**: a
  body an **Extrude, Revolve, or Sweep** produced earlier in the same session (visible as its own
  row in the Feature Tree, §3.13) CAN be the target of another Extrude/Revolve/Sweep cut, since the
  tool can re-derive that body's geometry from its own Feature Tree entry instead of needing
  original STEP bytes. This does not extend to a primitive, or any body from Loft/Fillet/Chamfer/
  Hole Wizard/Shell/Draft — those still can't be a cut target unless they're STEP-imported.
- **A STEP-imported part can be cut more than once in a session** (tested: two successive sketch
  cuts on one part, each removing more material than the last), and Fillet/Chamfer then works on
  the cut part. Older versions of this manual said a part could not be modified again after its
  first cut; that is no longer true for these tools. Shell, Draft and Hole Wizard were not
  re-tested after a cut.
- A boss (Extrude without Cut) drawn on a face is fixed to that face's position — see §3.13.
- **Revolve** has no way to revolve around a separately-drawn axis line — only the sketch plane's
  own U or V direction.
- **Sweep** is straight-line-only: there's no way to sweep along a curved path (a picked edge or a
  second path sketch) yet, only a straight, tilted line.
- Closing the Sketch panel (**×**) or pressing **Escape** cancels the in-progress sketch with no
  confirmation — any points you've already clicked are discarded.
- The CREATION itself is not on the Undo stack (§4.3) — **but Extrude, Revolve, and Sweep
  specifically CAN be edited afterward** through the Feature Tree panel (§3.13), and that edit
  itself IS a normal Undo/Redo step.

**Errors you might see:** "Selected face is not planar" (you clicked a curved face — pick a flat
one instead); a boolean-operation failure message if the cut/extrude geometry is invalid (e.g.
degenerate profile); or, for Revolve, "the profile/axis combination is not geometrically valid"
(your profile crosses the chosen axis — redraw it entirely to one side, or pick the other axis) —
in every case the tool stays open so you can retry.

---

### 5.2 Add Shape: Box / Cylinder / Sphere / Cone (primitives)

**What it does:** Places a simple 3D primitive solid directly into the scene — no sketching
required.

**Where to find it:** Ribbon → Add Shape group → **Box**, **Cylinder**, **Sphere**, or **Cone**.

**When to use it:** Quick reference geometry, simple mechanical stand-ins (fasteners, spacers,
shafts), or as a fast way to add test geometry without drawing a sketch.

**Step by step:**

1. Click the shape button for the primitive you want (e.g. **Cylinder**). A panel opens showing
   "Add Cylinder" and a hint to click the viewport.
2. **Click anywhere in the viewport** — on empty space (places on the Z=0 ground plane) or
   directly on an existing part's surface (places at that clicked point) — to set the base point.
3. The panel switches to a **dimensions form**, specific to the shape:
   - **Box:** Width, Depth, Height (mm).
   - **Cylinder:** Radius, Height (mm).
   - **Sphere:** Radius (mm).
   - **Cone:** Base radius, Top radius, Height (mm) — set Top radius to 0 for a true cone.
4. Adjust the numeric fields as needed (all default to sensible starting values, e.g. 50 mm for a
   box's dimensions, 25 mm radius).
5. Click **Create**. The button reads "Creating…" while the shape is generated.
6. Click **Back** instead if you want to re-pick the base point without creating anything.

**Input required:** a click point, plus shape-specific dimensions.

**Output:** one new solid body in the tree, named after its shape kind (e.g. "Cylinder").

**Limitations:**
- Placed at a fixed orientation (no rotate-while-placing) — use the Rotate gizmo afterward if you
  need a different orientation.
- Not on the Undo stack (§4.3) — delete the resulting body and re-create it if you need to change
  a mistake.

---

### 5.3 Fillet / Chamfer (round or bevel an edge)

**What it does:** Rounds (fillet) or bevels (chamfer) one or more edges of an existing solid part
— the standard "finishing" operation used to remove sharp edges, add stress relief, or ease
assembly clearance.

**Where to find it:** Ribbon → Features group → **Fillet / Chamfer**.

**When to use it:** Any time you need to soften or bevel a sharp edge on a part that came from an
opened STEP file — the most commonly used feature in real mechanical part design.

**Step by step:**

1. Click **Fillet / Chamfer**. A panel opens with a **Fillet** / **Chamfer** toggle (Fillet is
   selected by default) and the hint "Click one or more edges on a part…"
2. Choose **Fillet** (rounds the edge with a radius) or **Chamfer** (bevels the edge with a flat
   angled cut, sized by a setback distance) using the two toggle buttons at the top of the panel.
3. **Click directly on an edge** of a part in the viewport. As you move your mouse near an edge,
   it highlights in blue as a hover preview; clicking it locks it in as a bright yellow picked
   edge and adds it to a list in the panel (e.g. "Edge 16").
4. **Click more edges** on the **same part** to fillet/chamfer several edges at once in a single
   operation. Clicking an edge that's already in the list removes it (toggle behavior).
   - If you click an edge on a **different** part than your current picks, the pick list restarts
     fresh with just that new edge — one Fillet/Chamfer operation can only target a single part.
5. **Each picked edge in the list has its own Radius/Distance field** — set a different value per
   edge for a "variable-radius" fillet (e.g. 5mm on one edge, 8mm on another, 3mm on a third, all
   in one operation) instead of every edge sharing one value. A separate **"New edges start
   at"** field sets the value newly-picked edges begin at — changing it doesn't affect edges
   already in the list, and editing one edge's own value doesn't affect any other edge's.
6. Click **Apply Fillet** / **Apply Chamfer**. The button reads "Applying…" while it computes.
7. On success, the panel closes automatically and the part is updated in place in the tree (same
   name, same position — not a new body).

**Input required:** one or more edges on a single part, each with its own positive radius/distance
value.

**Output:** the target part's geometry is replaced in place with the rounded/beveled version.

**Limitations:**
- **Tested on parts from an opened STEP file, including parts already cut in the same session**
  (two cuts followed by a fillet was verified end to end). It has **not** been verified on parts
  made by Sketch/Extrude or on a primitive shape. Earlier versions of this manual said those are
  refused with a clear error; if you try one and see that error, that limit still applies to it.
- **Each Apply takes roughly 10–15 seconds**, because a fresh geometry worker is started for every
  operation. Applying Fillet/Chamfer twice in one session works (tested on two different parts).
- All picked edges in one operation must belong to the same part.
- **Only per-edge variable radius is supported** — there's no way to make a single edge's own
  radius taper continuously from one end to the other; each edge gets one fixed value along its
  whole length.
- A radius/distance that's geometrically too large for the local edge shape will fail — this is a
  real, expected outcome (not every radius is physically valid on every edge), and the tool
  reports a clear error and **keeps your edge picks and the panel open** so you can just lower the
  value and try again, rather than losing your work.
- No Feature Tree entry (§3.13 — that panel covers Extrude, Revolve, Sweep, and Loft only) — once applied, you
  can't come back later and change the radius without starting over.
- Not on the Undo stack (§4.3).

**Recovering from a failed Fillet/Chamfer:** read the error message in the panel, reduce the
radius/distance (or remove one of the picked edges), and click Apply again — no need to re-pick
the edges. Rarely, applying a fillet on a specific edge can fail with an unhelpful raw error
instead of a clear message — if that happens, try a different edge or a much smaller value; this
is a known, not-yet-fixed edge case (see the project's own architecture notes for the one specific
instance found so far).

---

### 5.4 Pattern (array-copy a part)

**What it does:** Creates several evenly-spaced copies of an existing part in one operation —
either in a straight line (**Linear**) or spaced around a circle (**Circular**) — instead of
duplicating and repositioning each copy by hand.

**Where to find it:** Ribbon → Features group → **Pattern**.

**When to use it:** Any repeating arrangement of the same part — a row of bolt holes, a line of
identical brackets along a beam, a bolt circle, spokes around a hub. Anywhere you'd otherwise use
Duplicate (§3.8) several times in a row and nudge each copy into place manually.

**Step by step:**

1. **Select the part** you want to repeat first — the Pattern button stays disabled until
   something is selected.
2. Click **Pattern**. The panel opens, showing "Target: <part name>" so you can confirm you
   selected the right part. This target is locked in the moment the panel opens — changing your
   selection afterward doesn't retarget an already-open Pattern panel; close and reopen it against
   the new selection if you picked the wrong part.
3. Choose **Linear** or **Circular** using the toggle at the top of the panel.
4. Fill in the fields, which change depending on the mode:
   - **Linear:**
     - **Direction** — which world axis (X, Y, or Z) the copies step along.
     - **Spacing (mm)** — the center-to-center distance between each copy.
   - **Circular:**
     - **Axis** — which world axis (X, Y, or Z) the copies orbit around.
     - **Total angle (°)** — the full sweep the copies are spaced across. Use **360** for copies
       evenly spaced all the way around (e.g. 6 copies at 360° land 60° apart, and the last one
       does *not* overlap the original); use a smaller value (e.g. 180°) for copies spread across
       only part of a circle (in that case the last copy lands exactly at the angle you typed).
   - **Count (incl. original)** — total number of copies in the pattern, **counting the original
     part itself** — so a count of 4 means the original plus 3 new copies, matching how
     SolidWorks/Fusion count a pattern.
5. Click **Apply Pattern**. The new copies appear immediately in the viewport and as new rows in
   the Model Tree, named after the original with a "(Pattern N)" suffix (e.g. "Bracket (Pattern
   2)", "Bracket (Pattern 3)", …).

**Input required:** a selected part, a Linear/Circular choice, an axis, a spacing or total angle,
and a count of 2 or more.

**Output:** `count - 1` new bodies in the tree, positioned (and, for Circular, rotated) relative to
the original part — the original itself is left untouched in its original position.

**On Undo — an exception worth knowing:** unlike Sketch/Extrude, primitive placement, and
Fillet/Chamfer, **Pattern is undoable**. Every copy from one Apply is grouped into a single Undo
step — pressing **Ctrl+Z** once removes *all* the copies from that pattern together, not one at a
time; **Ctrl+Y** restores all of them together. This is because a pattern is just several
positioned copies of a part you already had (the same underlying operation as Duplicate, which is
also undoable), not a new solid-modeling computation.

**Limitations:**
- Works on **any** part regardless of how it was created — STEP-imported, sketched, a primitive,
  or even a previous Pattern/Fillet/Chamfer result. Unlike Fillet/Chamfer, there's no
  STEP-source-only restriction, since patterning never re-reads or recomputes the part's geometry.
- Axis-aligned only — Linear direction and Circular axis must be world X, Y, or Z. There's no
  arbitrary custom direction/axis, and no pattern-along-a-curve.
- No fill/grid (2D) pattern, and no way to skip specific positions in the array (e.g. "every copy
  except the 3rd") — every position from 1 to Count is always filled.
- Each copy is an independent body once created — there's no ongoing link back to the original, so
  patterning is a one-time array-copy, not a re-drivable feature. If you need a different spacing
  or count later, undo and reapply with new settings rather than editing the existing copies.
- Closing the panel (**×**) without clicking Apply discards your in-progress settings with no
  confirmation (nothing has been created yet at that point, so there's nothing to lose).

---

### 5.5 Mirror (reflect a part across a plane)

**What it does:** Creates one reflected copy of an existing part across a plane — the standard way
to build a symmetric part or assembly (e.g. a left-hand and right-hand bracket) without modeling
the mirrored half by hand.

**Where to find it:** Ribbon → Features group → **Mirror**.

**When to use it:** Any time you need a mirror-image copy of a part across the assembly's X, Y, or
Z center plane — symmetric brackets, opposite-handed parts, mirrored mounting patterns.

**Step by step:**

1. **Select the part** you want to mirror first — the Mirror button stays disabled until something
   is selected.
2. Click **Mirror**. The panel opens, showing "Target: <part name>" so you can confirm you selected
   the right part — same locked-in-target convention as Pattern (§5.4): changing your selection
   after the panel is already open doesn't retarget it.
3. Choose the **Mirror plane** — **XY**, **YZ**, or **XZ** — the same three fixed global reference
   planes Sketch's datum option (§5.1) uses, all passing through the world origin.
4. Click **Apply Mirror**. The reflected copy appears immediately in the viewport and as a new row
   in the Model Tree, named after the original with a "(Mirror)" suffix (e.g. "Bracket (Mirror)").

**Input required:** a selected part and a plane choice (XY/YZ/XZ).

**Output:** one new body in the tree, reflected across the chosen plane — the original itself is
left untouched in its original position.

**On Undo:** Mirror is undoable, the same as Pattern and Duplicate — one **Ctrl+Z** removes the
reflected copy, one **Ctrl+Y** restores it.

**Limitations:**
- Works on **any** part regardless of how it was created — STEP-imported, sketched, a primitive, or
  even a previous Pattern/Fillet-Chamfer/Mirror result — same as Pattern, since mirroring never
  re-reads or recomputes the part's geometry.
- Only the three fixed global datum planes (XY/YZ/XZ) are offered — there's no mirroring across an
  offset or angled custom plane, and no mirroring across a picked face of another part.
- Always creates exactly one reflected copy and keeps the original — there's no "replace the
  original" or delete-source variant.
- Each mirrored copy is an independent body once created — there's no ongoing link back to the
  original, so if the original later changes, the mirrored copy does not update to match; delete it
  and re-apply Mirror if you need the reflection to catch up.
- Closing the panel (**×**) without clicking Apply discards your in-progress settings with no
  confirmation (nothing has been created yet at that point, so there's nothing to lose).

---

### 5.6 Hole Wizard (standard fastener-size holes)

**What it does:** Cuts a standard-size through-hole for a common metric or inch fastener directly
into a picked face — plain, **counterbored** (a wider, flat-bottomed recess for a socket head cap
screw) or **countersunk** (a conical recess for a flat head screw) — with no need to sketch a circle
by hand, look up a clearance or counterbore size, or guess a cut depth deep enough to punch all the
way through.

**Where to find it:** Ribbon → Features group → **Hole Wizard**.

**When to use it:** Any time you need a bolt/screw clearance hole sized to a real fastener standard
— mounting holes, bracket holes, anywhere you'd otherwise use Sketch's Circle tool and have to look
up or guess the right diameter yourself.

**Step by step:**

1. Click **Hole Wizard**. The panel opens with the hint "Click a flat face on a STEP-imported
   part…"
2. **Click a flat face** on a part that came from an opened STEP file. The face highlights, the
   camera orients to look straight at it, and small colored reference dots appear at its
   corners/midpoints/circle-centers — the same face-picking behavior as Sketch (§5.1).
3. **Click where the hole should be centered.** Moving your mouse near a reference dot snaps your
   click to it exactly, shown by a yellow ring indicator — same snap behavior as Sketch.
4. Once the center is set, the panel switches to a **configuration form**:
   - **Standard** — Metric or Inch.
   - **Size** — a dropdown of standard fastener sizes (Metric: M3–M12; Inch: #4-40 through
     3/8-16).
   - **Fit** — Close, Normal, or Loose, each a slightly different clearance-hole diameter for the
     same fastener size (Normal is a reasonable default for most mounting holes).
   - **Type** — Simple, Counterbore, or Countersink.
     - **Counterbore** adds **C'bore Ø** and **C'bore depth** fields, pre-filled with the usual
       socket-head-cap-screw values for the chosen size (e.g. M6: Ø11 × 6.5 mm).
     - **Countersink** adds **C'sink Ø** and **C'sink angle** fields, pre-filled for a flat head
       screw of the chosen size (e.g. M6: Ø12.6 mm at 90°; inch sizes use 82°).
     - Changing Standard or Size resets these to that size's standard values. After that you can
       type any value.
     - The counterbore/countersink diameter must be larger than the hole itself. If it isn't, a red
       message explains why and **Apply Hole** stays disabled.
   - A live readout shows the resulting **hole diameter** in mm, and a live preview circle appears
     on the part at the chosen size (two concentric circles for a counterbore/countersink).
5. Click **Apply Hole**. The button reads "Cutting…" while the operation runs.
6. On success, the panel closes automatically and the part updates in place in the tree (same name,
   same position — not a new body), with the hole cut all the way through automatically — you never
   need to specify a depth.

**Input required:** a picked face, a picked center point, and a Standard/Size/Fit combination.

**Output:** the target part's geometry is replaced in place with the hole cut through it.

**Limitations:**
- **Works on a STEP-imported part, including one that's already been cut once** (by a sketch cut,
  another Hole Wizard hole, or an Extrude/Revolve/Sweep) — earlier versions of this manual said a
  part could only take ONE such operation ever; that's no longer true for these tools. It does
  **not** yet work on a part that's been through Fillet/Chamfer, Shell, or Draft, or on a
  sketch/primitive-created part — those tools don't yet register the part as editable, so the same
  re-read-a-STEP-solid restriction still applies to them specifically.
- **Always through-all.** There are no blind (fixed-depth) holes and no tapped/threaded holes yet —
  this app has no thread modeling anywhere.
- **A counterbore deeper than the part is thick goes straight through.** The part then gets one
  wide hole instead of a stepped one, and no warning is shown. This is easy to hit on thin plates:
  the standard M6 counterbore depth is 6.5 mm, so on a 5 mm plate, lower the C'bore depth. A
  countersink that would be deeper than the whole part is rejected with an error.
- One hole per Apply, and no bolt-pattern/multi-hole mode — Hole Wizard modifies the target part in
  place rather than producing a separate body, so Pattern (§5.4) has nothing separate to array-copy
  after one hole is cut. Each hole today needs its own Hole Wizard pass.
- **Has a Feature Tree entry** (§3.13), labeled "Hole (size, fit)", "Counterbore (size, fit)" or
  "Countersink (size, fit)". Double-click it afterward to change the hole's type, its diameter,
  or its counterbore/countersink sizes; the edit is a normal Undo/Redo step. The hole's face and
  center are fixed once it's cut; to move a hole, delete the body and redo it.

**Recovering from a failed Hole Wizard cut:** if you see an error after picking a face, it means
that part doesn't have a usable STEP source (already cut/filleted once, or created via Sketch/a
primitive) — pick a different, not-yet-modified STEP-imported part instead.

---

### 5.7 Reference Plane (a named, offset sketch plane)

**What it does:** Creates a named plane offset a set distance from a datum plane or a picked face,
so you have a real, reusable sketch target other than the three fixed global datum planes — useful
when you need to sketch at a specific height/depth above or beside existing geometry, without
having to re-pick a face and estimate the offset by eye every time.

**Where to find it:** Ribbon → Reference Geometry group → **Reference Plane**.

**When to use it:** Any time you need to sketch at a set distance from an existing datum or face —
a mounting plane 25mm above a base, a parting line offset from a part's top face, or any sketch
plane you'll want to come back to and reuse later in the same session.

**Step by step:**

1. Click **Reference Plane**. The panel opens asking you to pick a base.
2. **Pick a base** — either click one of the three **datum plane buttons** (XY/YZ/XZ), or **click
   directly on a flat face** of an existing part in the viewport.
3. Once a base is picked, the panel switches to a configuration form:
   - **Offset (mm)** — the distance to offset the new plane along the base's normal direction. A
     live translucent yellow preview plane in the viewport updates as you type.
   - **Name (optional)** — leave blank for an automatic name ("Plane 1", "Plane 2", …).
   - Click **change** next to the base label if you picked the wrong base and want to re-pick.
4. Click **Create Plane**. The panel closes, and the new plane appears as a permanent translucent
   blue plane in the viewport.
5. Re-open the **Reference Plane** panel at any time to see the list of every plane you've created,
   with per-plane controls:
   - **Rename** — click into the name field and type a new name.
   - **Eye icon** — toggle that plane's visibility in the viewport.
   - **Rectangle icon** — starts a **Sketch** directly on that plane (skips the pick-a-plane step
     entirely, since the plane is already resolved).
   - **Trash icon** — deletes the plane.

**Input required:** a picked base (datum or face) and an offset distance.

**Output:** a new, named, persistent reference plane, visible in the viewport and available as a
Sketch target from then on.

**Limitations:**
- **Offset-only** — the new plane is always parallel to its base, just shifted along the normal.
  There's no tilt/rotation and no defining a plane through 3 arbitrary points.
- Reference planes are **not part of the Model Tree** — they're a separate list, managed entirely
  from the Reference Plane panel (the same way Section planes aren't in the tree either).
- A reference plane is **not linked** to whatever you later sketch on it — if you delete or move
  the reference plane afterward, anything you already sketched and extruded on it is unaffected.
  This holds even for an Extrude/Revolve that the Feature Tree (§3.13) lets you edit afterward —
  the Feature Tree tracks the feature's own params, never a reference plane it was drawn on.
- Not on the Undo stack (§4.3) — creating or deleting a reference plane is immediate and permanent
  (deleting only removes the plane itself, never anything already built from a sketch on it).

---

### 5.8 Bridge Mesh

**What it does:** Generates a connecting surface mesh (a "bridge") between two separate faces on
two different parts — useful for visualizing or roughly modeling a transition surface between two
components that don't directly touch.

**Where to find it:** Ribbon → Meshing group → **Bridge Mesh**.

**When to use it:** When you need a quick visual/geometric bridge surface spanning the gap between
two parts' faces (e.g. a duct transition, a rough fairing surface) rather than a precise
engineering feature.

**Step by step:**

1. Click **Bridge Mesh**. The panel opens with the hint "Click a face on the first part…"
2. Click a face on the first part. The hint updates to "Now click a face on a different part…"
3. Click a face on a **second, different** part. (Picking a second face on the *same* part shows
   an error — "Pick a face on a different part than the first selection.")
4. The bridge mesh generates immediately and appears as a translucent teal surface with a
   wireframe overlay connecting the two picked faces' boundaries.
5. Adjust the **Density (rows)** slider (1–30) to control how many cross-section rows the bridge
   mesh uses — higher density gives a smoother, more detailed bridge.
6. Click **Clear** to remove the current bridge and start over with a new pair of face picks.

**Input required:** two face picks on two different parts.

**Output:** a standalone visual bridge-mesh surface in the scene (not registered as a tree body —
it's a visualization overlay, not a solid you can select/measure/export like a regular part).

**Limitations:**
- Both picked faces must have an extractable boundary loop — an unusual or highly irregular face
  boundary may fail with "Could not extract a boundary loop for that face."
- The bridge is a *mesh visualization*, not a true solid feature — it doesn't appear in the Model
  Tree and can't be selected, measured, or exported as part of the assembly.
- Not on the Undo stack (§4.3); closing the tool clears the bridge.

---

### 5.9 Shell (hollow out a part)

**What it does:** Hollows out an existing solid part to a set wall thickness by removing one or
more picked faces — the standard "finishing" operation for turning a solid block into an
enclosure, housing, or container.

**Where to find it:** Ribbon → Features group → **Shell**.

**When to use it:** Any time you need a hollow part instead of a solid one — an enclosure with an
open top, a housing with an access panel removed, a container.

**Step by step:**

1. Click **Shell**. The panel opens with the hint "Click one or more faces to remove…"
2. **Click a face** on a STEP-imported part in the viewport — this is the face that will be
   opened/removed by the operation. As you move your mouse near a face, it highlights in blue as a
   hover preview; clicking it locks it in as a bright yellow picked face and adds it to a list in
   the panel (e.g. "Face 14").
3. **Click more faces** on the **same part** to remove several faces at once in a single operation
   (e.g. opening both ends of a tube). Clicking an already-picked face removes it from the list
   (toggle behavior) — same convention as Fillet/Chamfer (§5.3).
   - If you click a face on a **different** part than your current picks, the pick list restarts
     fresh with just that new face — one Shell operation can only target a single part.
4. Enter the **Wall thickness (mm)** value.
5. Click **Apply Shell**. The button reads "Applying…" while it computes.
6. On success, the panel closes automatically and the part is updated in place in the tree (same
   name, same position — not a new body), now hollow with the picked face(s) opened.

**Input required:** one or more faces on a single part, plus a positive wall thickness value.

**Output:** the target part's geometry is replaced in place with the hollowed version.

**Limitations:**
- **Only works on parts that came from an opened STEP file, and only if that part hasn't already
  been cut, filleted, chamfered, or shelled** — same restriction and reason Fillet/Chamfer (§5.3)
  and Hole Wizard already have: the tool needs to re-read a real, unmodified STEP solid.
- **One uniform wall thickness per operation** — every wall in the result is the same thickness;
  there's no per-face variable thickness.
- All picked faces in one operation must belong to the same part.
- A thickness that's geometrically too large for the part's local wall/corner geometry will fail —
  this is a real, expected outcome (not every thickness is physically valid on every part), and the
  tool reports a clear error and **keeps your face picks and the panel open** so you can lower the
  value and try again, rather than losing your work.
- No Feature Tree entry (§3.13 — that panel covers Extrude, Revolve, Sweep, and Loft only) — once applied, you
  can't come back later and change the thickness without starting over.
- Not on the Undo stack (§4.3) — same as Sketch/Fillet-Chamfer/Hole-Wizard, since it's a
  geometry-creating operation.

**Recovering from a failed Shell:** read the error message in the panel, reduce the wall thickness
(or remove one of the picked faces), and click Apply again — no need to re-pick the faces.

### 5.10 Draft (mold-pull angle)

**What it does:** Tapers one or more picked faces by an angle so the part releases cleanly from an
injection mold or casting tool — the standard "moldability" fix applied to a part's vertical walls
before it can actually be manufactured that way.

**Where to find it:** Ribbon → Features group → **Draft** (next to Shell).

**When to use it:** Any solid that will be injection-molded or cast needs a small draft angle
(typically 1–5°) on every wall roughly parallel to the direction the part is pulled out of the
mold — without it, the part can gall, scuff, or get stuck in the tool.

**Step by step:**

1. Click **Draft**. The panel opens with the hint "Click one or more faces to draft…"
2. **Click a face** on a STEP-imported part in the viewport — this is the face that will be
   tapered. As with Shell, a hover preview highlights the face in blue before you click, and a
   click locks it in yellow and adds it to a list in the panel (e.g. "Face 3").
3. **Click more faces** on the **same part** to draft several walls in one operation. Clicking an
   already-picked face removes it (toggle behavior). Picking a face on a different part restarts
   the pick list — one Draft operation can only target a single part.
4. Enter the **Draft angle (degrees)** value (0.5–89°).
5. Click **Apply Draft**. The button reads "Applying…" while it computes.
6. On success, the panel closes automatically and the part is updated in place in the tree (same
   name, same position — not a new body), with the picked face(s) tapered.

**Input required:** one or more faces on a single part, plus a draft angle between 0.5° and 89°.

**Output:** the target part's geometry is replaced in place with the drafted version.

**Pull direction and neutral plane (v1 scope — not user-adjustable yet):** the pull direction is
always the world **+Z** axis, and the geometry stays fixed at the part's own lowest Z extent while
the picked face(s) taper away from it going upward — there's no direction picker or neutral-plane
picker in this version. If your part's "up" isn't world +Z, rotate the part first so the direction
you want to draft along lines up with +Z, then apply Draft.

**Limitations:**
- **Only works on parts that came from an opened STEP file, and only if that part hasn't already
  been cut, filleted, chamfered, shelled, or drafted** — same restriction and reason Shell (§5.9),
  Fillet/Chamfer (§5.3), and Hole Wizard already have: the tool needs to re-read a real,
  unmodified STEP solid.
- **Pull direction is fixed to world +Z** — see above; no per-part custom pull direction yet.
- **One uniform draft angle per operation** — every picked face gets the same angle; there's no
  per-face variable angle.
- All picked faces in one operation must belong to the same part.
- An angle that's geometrically too large for the part's local geometry will fail — this is a
  real, expected outcome, and the tool reports a clear error and **keeps your face picks and the
  panel open** so you can lower the value and try again.
- No Feature Tree entry (§3.13 — that panel covers Extrude, Revolve, Sweep, and Loft only) — once applied, you
  can't come back later and change the angle without starting over.
- Not on the Undo stack (§4.3) — same as Sketch/Fillet-Chamfer/Hole-Wizard/Shell, since it's a
  geometry-creating operation.

**Recovering from a failed Draft:** read the error message in the panel, reduce the angle (or
remove one of the picked faces), and click Apply again — no need to re-pick the faces.

### 5.11 Loft (blend between profiles)

**What it does:** Blends between two or more 2D profiles — each drawn on its own plane — into one
smooth solid whose cross-section changes shape along its length. A bottle (round base → oval body
→ narrow neck), a duct transitioning round-to-rectangular, or any part that tapers or twists
between different shapes at different points is a Loft.

**Where to find it:** Ribbon → Design group → **Loft** (next to Sketch).

**When to use it:** Whenever a part's cross-section is genuinely different at different points
along its length — if every cross-section is the same shape just growing/shrinking in a straight
line, Sweep (§5.1) is simpler; if it's a straight extrusion of one shape, use Extrude (§5.1).

**Step by step:**

1. Click **Loft**. The panel opens.
2. **Draw your first profile** exactly like Sketch: pick a plane (**XY**, **YZ**, **XZ**, or click
   a face on an existing part), pick a shape (rectangle/circle/polygon/slot/polyline), and click in
   the viewport to draw it (Polyline: click back on the start point, press Enter, or double-click to
   finish, same as in Sketch — see §5.1).
3. Once the profile is complete, click **Add to Loft**. It's added to a list in the panel
   ("Profile 1") and you're returned to picking a plane for the **next** profile.
4. **Repeat** for a 2nd, 3rd, etc. profile — each can be on a different plane, letting the loft
   twist or bend in 3D, not just taper in a straight line. Click the **×** next to a profile in
   the list to remove it if you added it by mistake.
5. Once you have **2 or more** profiles, optionally check **Cut (remove material)** — only has an
   effect if your FIRST profile was sketched on an existing part's face, in which case it works
   just like Extrude's own Cut checkbox (remove material) vs. leaving it unchecked (add/fuse
   material onto that part). Then click **Finish Loft**. The button reads "Lofting…" while the
   operation runs.
6. Result: a new solid appears (added to the tree as "Feature Body N") that smoothly blends
   through every profile you added, in the order you added them — or, if your first profile was
   sketched on an existing part's face, that part is **replaced in place** in the tree instead
   (same position, same name pattern) with the modified geometry.

**Input required:** 2 or more completed profiles (each its own plane pick + 2-click shape draw),
plus an optional Cut checkbox.

**Output:** one new solid body, or a modified existing body when your first profile was sketched
on a picked face.

**Limitations:**
- **Only the FIRST profile's picked face drives Cut/Fuse targeting** — if you want Loft to modify
  an existing part, that part's face must be where you draw profile 1. Later profiles can be on
  any plane (that's the whole point — a different plane per profile is what lets the loft twist
  or change cross-section shape); they never redirect which part gets cut/fused.
- **Rare, occasional Loft Cut/Fuse failure** on profiles centered on two adjacent, perpendicular
  faces (e.g. a profile on a part's top face and another on the immediately adjacent side face) —
  the underlying blend calculation can be numerically sensitive for this specific arrangement and,
  very occasionally, produce a result with no real volume change. If this happens, try moving one
  of the profiles slightly off the shared corner, or picking faces that aren't directly adjacent.
- **Straight blend only** — there's no way to guide the blend along a separately-drawn rail/guide
  curve, and no way to make the loft close back on itself (blend from the last profile back to the
  first, for a closed torus-like shape).
- Profiles are used in the order you added them — there's no reordering a profile in the list
  without removing it and adding it again at the end.
- Same profile limitations as Sketch itself: one closed shape per profile, no sketch dimensioning/
  constraints.
- Cutting/adding into an existing part only works for parts that came from an opened STEP file.
  (Extrude, Revolve, and Sweep have a broader exception here — see §5.1's own limitations — but
  that exception doesn't extend to Loft.)
- The CREATION itself is not on the Undo stack (§4.3), same as Sketch's own Extrude/Revolve/Sweep
  — **but Loft specifically CAN be edited afterward** through the Feature Tree panel (§3.13), and
  that edit itself IS a normal Undo/Redo step. Loft's own edit surface there is narrower than the
  other three though — only the Cut checkbox, not the profiles themselves (see §3.13's own
  limitations for why).

**Recovering from a failed Loft:** read the error message in the panel — your already-added
profiles stay in the list, so you can remove a problematic one and re-add a replacement, or adjust
and click **Finish Loft** again without redrawing everything from scratch.

---

## 6. Inspection and documentation tools

### 6.1 Measure (Distance, Angle, Faces, Radius)

**What it does:** Measures distances, angles and circle sizes on your model. The panel has four
modes, chosen with the buttons at the top of the Measure panel:

| Mode | You click | Result |
|---|---|---|
| **Distance** | two points | straight-line distance, e.g. "12.50 mm" |
| **Angle** | three points — the **middle** click is the vertex | the angle at the vertex, e.g. "90.00°" |
| **Faces** | two flat faces | if the faces are parallel: the perpendicular distance between them, e.g. "50.00 mm (parallel faces)"; otherwise the angle between them, e.g. "90.00° between faces" |
| **Radius** | one circular edge (a hole rim, a shaft end, a fillet edge) | radius and diameter, e.g. "R 25.00 mm  Ø 50.00 mm" |

**Where to find it:** Ribbon → Measure group → **Distance**, or press **M**. Then pick a mode in the panel.

**When to use it:** Checking a dimension on a part, verifying spacing between two features, checking that
two faces are square to each other, finding a hole's diameter, sanity-checking imported geometry.

**Step by step:**

1. Click **Distance** (or press **M**). The Measure panel opens. Choose **Distance**, **Angle**, **Faces** or
   **Radius**. The line under the buttons always tells you what to click next.
2. **Distance / Angle:** click points in the viewport (on any part's surface, or empty space at the
   ground plane). **Faces:** click one flat face, then a second, different flat face. **Radius:** click on
   the edge itself, close to the line.
3. The result appears as a row in the panel **and** as a live yellow label in the 3D view, tracking
   correctly as you orbit the camera. A distance label sits at the midpoint of its line, an angle label at
   the vertex, a radius label at the circle's center (the fitted circle and its center are drawn too).
4. Repeat — you can take multiple measurements in a row; each becomes its own row/label. You can switch
   modes between measurements; switching discards a measurement you had only half finished.
5. Click **Clear All** to remove every measurement (marker spheres, connecting lines, and labels).

**Input required:** two points (Distance), three points (Angle), two flat faces (Faces), or one circular
edge (Radius).

**Output:** a value with units (mm, or degrees), both listed in the panel and shown in-viewport.

**Errors you may see** (the panel shows the message and stays in the same mode so you can retry):
- "That face is not planar — only flat faces can be measured this way." — you clicked a curved face.
- "Pick a second, different face." — you clicked the same face twice.
- "That edge is not a circle or a circular arc." — the edge is straight or freeform. Full circles and
  partial arcs both work.
- "The three points must be distinct." — two of the angle's points landed on the same spot.

**Limitations:**
- Faces mode reports a **distance only for parallel faces** (within 0.5°); for faces that are not
  parallel it reports the angle instead, not a minimum distance. The angle is the acute angle between
  the two planes (0–90°). It does not measure edge-to-face, edge-to-edge or point-to-face distances, and
  there is no minimum-distance-between-shapes measurement.
- Radius mode measures the circle **fitted** to the edge's sampled points, so it is accurate for circles and
  circular arcs; it rejects ellipses and other curves rather than guessing.
- Distance and Angle use whatever point you click, with no snapping to vertices or edge midpoints.
- Faces uses the face's average position for its marker, so the drawn line is not attached to a corner.
- Measurements do **not** follow a part if you move it afterwards — they stay where they were measured.
- Measurements **persist** even if you close the panel (×) and reopen the tool — only "Clear All"
  removes them. This is intentional, matching a running-annotation-list convention used elsewhere
  in the app.

### 6.2 Section (Clipping) Planes

**What it does:** Slices the model with an invisible plane along X, Y, or Z, hiding whatever is
on one side — useful for seeing internal structure without physically cutting the model.

**Where to find it:** Ribbon → Section group → **X Plane** / **Y Plane** / **Z Plane**.

**When to use it:** Inspecting the interior of a solid part or assembly, checking wall thickness,
verifying internal features are positioned correctly.

**Step by step:**

1. Click **X Plane** (or Y/Z) to enable clipping along that axis. The Section panel opens showing
   a row for that axis.
2. Drag the **offset slider** to move the clipping plane's position along that axis.
3. Click the **flip icon** to reverse which side of the plane is hidden vs. shown.
4. Click the **×** (turn off) icon on that axis's row to disable clipping on just that axis, or
   click its ribbon button again.
5. You can enable **all three axes at once** for a corner/octant cutaway view.
6. **Tools → Clear Section Planes** (menu bar) turns off all three at once.

**Input required:** which axis (or axes) to enable, an offset position, optional flip.

**Output:** a real-time clipped view of the model (this is a display/render effect, not a
geometry edit — the actual model data is unchanged).

**Limitations:** only three clipping planes, each aligned to a global X/Y/Z axis — no
arbitrary-angle or offset-plane clipping.

**On Undo:** section plane offset (per drag, coalesced into one Undo step per drag-release),
enable/disable, and flip are all undoable.

### 6.3 Exploded View

**What it does:** Pulls every body in the scene radially outward from the assembly's center, to
visually separate an assembly's components — similar to an exploded-view illustration in an
assembly manual.

**Where to find it:** Ribbon → Exploded View group — a slider and a **Reset** button.

**When to use it:** Visualizing how a multi-body assembly fits together, or producing a clearer
screenshot of a complex assembly's structure.

**Step by step:**

1. Drag the **explode-amount slider** (range 0–500) — every body animates outward from the
   assembly center proportionally to the slider value.
2. Click **Reset** to return every body to 0 (its original position).

**Input required:** a slider value.

**Output:** a temporary visual displacement — this does **not** change each part's actual stored
position/transform (Properties panel Position values are unaffected), it's purely a display
effect layered on top.

**Limitations:** radial-from-center explosion only; no per-part manual explode distance/direction
control, no explode-line/leader annotations.

### 6.4 Mesh View

**What it does:** Overlays a fine wireframe on top of each part's shaded surface, showing the
underlying triangulated surface mesh the CAD kernel generated — denser/finer on curved or
filleted surfaces, coarser on flat faces, since it reflects the real curvature-adaptive mesh
density.

**Where to find it:** Ribbon → Display group → **Mesh View** toggle.

**When to use it:** Inspecting tessellation quality, or for a visual "engineering drawing" look
when reviewing curved geometry.

**Step by step:** click the **Mesh View** button to toggle the wireframe overlay on/off for every
visible part.

**Limitations:** only available for parts imported from a STEP file — bodies created via Sketch or
a primitive shape do not currently generate a mesh-view wireframe.

### 6.5 Shading modes

**Where to find it:** View toolbar — **Solid**, **Wireframe**, **Transparent** buttons.

- **Solid** — normal shaded appearance (the default).
- **Wireframe** — shows parts as wireframe outlines only.
- **Transparent** — renders all parts with reduced opacity so you can see through them.

### 6.6 Grid, Axes, Dark Mode, Fullscreen

- **Grid** toggle (view toolbar) — shows/hides the reference ground grid.
- **Axes** toggle (view toolbar) — shows/hides the X/Y/Z origin axes indicator.
- **Dark Mode** toggle (view toolbar, or View menu) — switches the whole UI's color theme.
- **Fullscreen** toggle (view toolbar) — expands the browser to fullscreen for an uncluttered
  view.

### 6.7 Screenshot

**Where to find it:** View toolbar camera icon, or **File → Save Screenshot**.

Captures the current 3D view exactly as shown and downloads it as a PNG file
(`cad-viewport.png`) to your computer. A picture of the screen, not a CAD file.

### 6.8 Export STEP / Export STL

**What it does:** Writes your current model out to a downloadable CAD file, so your work leaves
the browser tab as something you (or another CAD tool) can open again later.

**Where to find it:** **File → Export STEP…** and **File → Export STL…**.

**When to use it:** Any time you want to keep or share what you've built — since there is no
project save (§3.11), exporting is the only way to preserve your work beyond the current browser
session.

**Step by step:**

1. Click **File**, then either **Export STEP…** or **Export STL…**.
2. The file downloads automatically — no dialog, no filename prompt (always `export.step` or
   `export.stl`).
3. **For STEP**, if any loaded body couldn't be included, a message appears listing exactly which
   bodies were skipped and why, after the (partial) file has already downloaded.

**Input required:** nothing — it exports whatever is currently loaded.

**Output:** one downloaded file (`export.step` or `export.stl`) containing every qualifying body,
combined into a single file at each body's real assembly position.

**Choosing which one:**

| | Export STEP | Export STL |
|---|---|---|
| Includes | Only bodies with a real, unmodified STEP-imported solid | **Every** loaded body, regardless of origin |
| Geometry type | True solid/BRep — re-editable in other CAD tools | Triangulated mesh only — no solid data |
| Re-editable later | Yes, in any STEP-capable CAD tool | Limited — mesh edits only, no parametric solid |
| Best for | Preserving/sharing an imported assembly you haven't heavily modified with new features | 3D printing, mesh viewers, getting every body out regardless of how it was made |

**Limitations:**
- **STEP export excludes any body that isn't a real, still-original STEP-imported solid** —
  specifically, a body created via Sketch/Extrude or a primitive shape, or a body that has been
  Cut into or run through Fillet/Chamfer (both of those *replace* the body with a newly-computed
  shape that no longer has a raw STEP solid backing it) cannot be included. These bodies are
  always reported by name in a summary message, never silently dropped.
- No per-part export — always exports everything currently loaded.
- No IGES/OBJ/glTF export, and the structural (FEA) model (§7) is not included in either export.
- There's no way to re-import an exported STEP file and pick up where you left off with your
  Fillet/Chamfer history intact — reopening it is a fresh import, like any other STEP file.

---

## 7. Structural (frame/beam) analysis — a separate workflow

This is a distinct engineering workflow from solid modeling above — it models an idealized
line-and-node frame/truss structure (like a simplified building or bridge frame), not the solid
parts you've imported or built. It runs independently in the same scene.

**Where to find it:** Ribbon → Structural group (**Add Node**, **Add Member**) and the
**Structural Model** panel it opens.

### 7.1 Building the structural model

1. Click **Add Node**. The Structural Model panel opens with a **Working plane elevation (Z)**
   field — set the Z-height of the horizontal plane you'll click nodes onto.
2. **Click in the viewport** to place a node at that elevation. Repeat to place as many nodes as
   you need.
3. Click **Add Member** to switch modes, then **click two existing nodes** in the viewport, one
   after another, to connect them with a structural member (a straight line element).
4. In the **Nodes & Supports** list, use each node's dropdown to assign a support condition:
   **No support**, **Pinned**, or **Fixed** — this defines how that node is restrained for the
   analysis.
5. Under **Load Cases**, type a name (e.g. "Dead Load") and click **Add** to create a load case.
6. Under **Member Load** (appears once you have at least one member and one load case), pick a
   Member, pick a Load Case, enter an intensity (N/m — a uniformly distributed load), and click
   **Add**.
7. *(Optional, once you have more than one load case)* Under **Load Combination**, pick a case,
   enter a factor, click **Add Factor** to build up a combination, name it, and click
   **Save Combo**.
8. Once you have at least one node and one member, click **Run Analysis**.
9. If the model is invalid for analysis (e.g. unstable/underconstrained), an error message
   appears in the panel instead of results.

### 7.2 Viewing analysis results

Once an analysis completes successfully, an **Analysis Results** panel opens automatically
alongside the Structural Model panel (they can be open at the same time):

1. Pick which **Result** to view from the dropdown (if you ran more than one analysis/combo).
2. Pick a **Display** mode: None, Deflected Shape, Reactions, Bending Moment, Shear Force, Axial
   Force, or Torsion — each renders a corresponding diagram directly in the 3D viewport over the
   structural model.
3. If viewing **Deflected Shape**, use the **Scale** slider (1×–200×) to exaggerate the
   deformation visually (real deflections are usually too small to see at true scale).
4. Close the panel (**×**) to clear the results display.

**Limitations:** this is a v1 linear-elastic solver for simple frame/truss analysis — it is not
a substitute for a full FEA package, and results for members carrying distributed loads use a
linear-interpolation approximation between recovered end forces (documented as an intentional,
labeled simplification, not a bug). Structural model edits and analysis are not on the Undo
stack.

---

## 8. Realistic example workflows

### Example A: Inspect an imported assembly

1. **File → Open STEP…**, pick your file. Wait for the loading dialog to finish.
2. Once loaded, click through a few rows in the **Model Tree** to get oriented — note each part's
   name and check its Properties (Volume, Bounding Box) as you go.
3. Press **F** to fit the whole model, then use view presets (**1–7**) to check it from Front,
   Top, and Iso.
4. Enable the **X Plane** section cut and drag the offset slider to look inside the assembly.
5. Use **Distance** (**M**) to check a critical dimension between two features.
6. **File → Save Screenshot** to capture a reference image.

### Example B: Cut a mounting hole into an imported bracket

1. Open the bracket's STEP file.
2. Select the bracket, orbit to see the face where the hole needs to go.
3. Click **Sketch** (**S**), then click directly on that face (not a datum plane) — the camera
   auto-orients to look straight at it.
4. Choose the **Circle** shape, click the hole's center (snapping to a reference point if one is
   nearby), then click again to set the radius.
5. Set **Depth** larger than the bracket's thickness (to guarantee it cuts all the way through),
   check **Cut (remove material)**.
6. Click **Extrude**. The bracket updates in place with the hole cut through it.
7. Optionally, click **Fillet / Chamfer** and pick the new hole's edge(s) to break the sharp edge
   left by the cut.

### Example C: Build a simple bracket from scratch

1. With an empty scene, click **Box** (Add Shape group), click anywhere on the ground plane to
   place it, set Width/Depth/Height, click **Create**.
2. Click **Sketch** (**S**), click one of the box's flat faces, draw a **Rectangle** profile for a
   mounting slot, set a **Depth** greater than the box's thickness at that face, check **Cut**,
   click **Extrude**.
3. Select the box, use the **Rotate** gizmo (**R**) if it needs reorienting.
4. Click **Fillet / Chamfer**, pick the box's top outer edges, apply a small fillet radius to
   soften them. (Fillet is verified on STEP-imported parts; on a primitive box it may report the
   error described in §5.3 — if so, do the fillet on a part you opened from a STEP file instead.)
5. **File → Save Screenshot** to document the result, and **File → Export STL…** to keep the
   model (STL includes every body; Export STEP only includes bodies with a STEP source — §6.8).

### Example D: Compare two parts visually

1. Open a STEP file containing (or build) two or more bodies.
2. Select one part, **right-click → Isolate** to hide everything else.
3. Inspect it alone; **right-click → Show All** to bring the rest back.
4. Select two parts with **Ctrl+Click** to multi-select them; check the status bar to confirm
   both are selected.
5. Use the **Exploded View** slider to visually separate every body in the scene for a clearer
   overview.

### Example E: Arrange a circle of standoffs around a hub

1. Place a **Cylinder** (Add Shape group) to represent one standoff/spacer, sized and positioned
   at the hub's edge where the first standoff should sit.
2. With that standoff selected, click **Pattern**, choose **Circular**, set **Axis** to match the
   hub's rotation axis (usually Z), **Total angle** to **360°**, and **Count** to the number of
   standoffs you need (e.g. 6).
3. Click **Apply Pattern** — the remaining standoffs appear immediately, evenly spaced around the
   hub, each as its own row in the Model Tree ("Standoff (Pattern 2)", "Standoff (Pattern 3)", …).
4. If the spacing or count looks wrong, press **Ctrl+Z** once to remove every copy together (the
   original standoff stays), adjust the axis/angle/count, and click **Apply Pattern** again.
5. For a straight row instead of a circle (e.g. mounting bosses along one edge), use the same
   steps but choose **Linear** with a **Direction** and **Spacing** instead of Axis/Total angle.

### Example F: Build a symmetric bracket using Mirror

1. Build one half of a symmetric bracket — e.g. a **Box** (Add Shape group) offset to one side of
   the origin, with a **Sketch**-cut mounting hole through it.
2. Select the finished half, click **Mirror**, choose the plane it should be symmetric across (for
   a part offset along X, that's usually **YZ** — the plane perpendicular to X through the origin).
3. Click **Apply Mirror** — the reflected other half appears immediately as "Box (Mirror)" in the
   Model Tree, correctly shaded with no flipped/inside-out faces.
4. If you picked the wrong plane, press **Ctrl+Z** once to remove the reflected copy, choose a
   different plane, and click **Apply Mirror** again.
5. Note the mirrored copy is a one-time reflected snapshot, not a live link — if you go back and
   edit the original half afterward (e.g. a different hole position), the mirrored copy does
   **not** update to match; delete it and re-apply Mirror if you need the reflection to catch up.

---

## 9. Common CAD operations — quick reference

| Operation | Where / How |
|---|---|
| **Select** | Click a part (viewport or tree row); Ctrl/Shift-click to multi-select; Ctrl+A for all |
| **Pan** | Middle-click + drag |
| **Zoom** | Scroll wheel |
| **Fit to screen** | Fit All button, or press **F** |
| **Draw/create geometry** | Sketch tool (§5.1), or Add Shape primitives (§5.2) |
| **Reference plane** | Reference Plane tool (§5.7) — offset from a datum or a picked face |
| **Edit geometry** | Fillet/Chamfer (§5.3) on existing edges, Shell (§5.9) to hollow out a part; no other direct edit — re-sketch/re-place instead |
| **Edit a past feature** | Feature Tree panel (§3.13) — Extrude, Revolve, Sweep, and Loft only; double-click a row to change its depth/axis/angle/tilt/distance/cut (or, for Loft, just Cut) and re-apply |
| **Delete** | Delete/Backspace key, tree trash icon, or right-click → Delete Part (always confirms; not undoable) |
| **Move** | Move gizmo (**G**) |
| **Copy** | Right-click → Duplicate (one copy), Pattern (§5.4) for several evenly-spaced copies at once, or Mirror (§5.5) for a reflected copy |
| **Rotate** | Rotate gizmo (**R**) |
| **Measure** | Distance tool (**M**) (§6.1) |
| **Dimension** | Automatic Length/Width/Height labels on selection; Distance tool for point-to-point |
| **Align** | Not available — position parts manually with the Move/Rotate gizmo (see §11) |
| **Group/ungroup** | Not available — the Model Tree's Assembly/Import/Body structure is fixed, not user-groupable (see §11) |
| **Layers** | Not available — this app has no layer system; use visibility toggles and Isolate/Show All instead |
| **Properties** | Right panel, auto-updates on selection (§3.6) |
| **Undo/Redo** | Ctrl+Z / Ctrl+Y, or toolbar buttons with history dropdowns (§4.3) |
| **Search** | Model Tree filter box (§3.5) |
| **Import/open files** | File → Open STEP… (§3.2) — STEP/STP only |
| **Save** | Not available — no project save; use Export to preserve your model as a real file (§3.11) |
| **Export** | File → Export STEP… / Export STL… (model files), or File → Save Screenshot (PNG image) (§3.11, §6.8) |

---

## 10. Errors, warnings, and how to recover

| Situation | What you'll see | What to do |
|---|---|---|
| STEP file fails to parse | Error message and details in the loading dialog | Confirm the file is a valid `.step`/`.stp` file; try re-exporting it from its source CAD tool |
| Clicked a curved face while sketching | "Selected face is not planar — sketching is only supported on flat faces." | Pick a flat face instead; the tool stays in picking mode |
| Sketch has no closed profile | An error at Extrude time | Make sure you completed the shape's required clicks (2 for every shape) before extruding |
| Fillet/Chamfer radius too large for the edge | A clear failure message in the panel | Lower the radius/distance and click Apply again — your edge picks are preserved |
| Fillet/Chamfer on a non-STEP-sourced body | Error explaining only STEP-imported bodies are supported | Only usable on parts that came from an opened STEP file |
| Bridge Mesh: second face on the same part | "Pick a face on a different part than the first selection." | Pick a face on a different body |
| Bridge Mesh: face has no usable boundary | "Could not extract a boundary loop for that face." | Try a different face |
| Structural analysis on an invalid model | Error message in the Structural panel | Check supports/members form a stable structure before re-running |
| Export STEP with nothing loaded, or nothing qualifies | "Nothing to export — no bodies have a retained STEP source…" | Load a STEP file first, or use Export STL… instead |
| Export STEP with some non-STEP-sourced bodies present | The file still downloads, then a message lists exactly which bodies were left out and why | Use Export STL… instead if you need every body included |
| Feature Tree edit fails (e.g. a new depth/angle produces invalid geometry) | An error message in the edit form | The form stays open with your edit still in progress — adjust the value and click Apply again |
| Deleting a part | A confirmation dialog ("Delete part "X"? (Ctrl+Z undoes this.)") | Confirm; if it was a mistake, press Ctrl+Z to put the part back |
| Attempting to Undo a create operation | Nothing happens — most geometry creation isn't tracked | See §4.3 for the exact list of what's undoable |
| Closing/reloading the browser tab | No warning — unsaved work is lost immediately (no autosave yet) | Save Project (Ctrl+S, §3.11) before closing |
| Opening a project whose feature history can't be rebuilt | "The parts opened, but their feature history couldn't be rebuilt…" | The parts are fine to view, measure and export; Feature Tree edits and cuts into feature-built parts won't work in that session |

---

## 11. What's currently implemented vs. what's planned

This section exists so you know exactly what to expect — don't assume a professional CAD
capability exists here just because it exists in SolidWorks/AutoCAD/Fusion, unless it's listed
under "Implemented" below.

### ✅ Implemented today

- STEP file import (single-document "Open," replaces on re-open)
- Full part CRUD: create (import/sketch/primitives), read (tree + properties), update
  (rename/visibility/color/opacity/transform), delete (with confirmation)
- Selection: single, multi-select (Ctrl/Shift-click), select all, automatic in-viewport
  dimension labels
- Sketch + Extrude: rectangle/circle/polygon/slot/**polyline** (freeform, any number of points,
  including concave shapes) profiles, on datum planes or picked faces, with boss (add) or cut
  (remove) — including correct material removal and camera auto-orientation, edge/vertex snapping
- **Sketch + Revolve** — spin a completed sketch profile around the sketch plane's own U or V
  axis (1°–360°) into a new standalone solid of revolution, or cut/add into an existing part's
  face
- **Sketch + Sweep** — push a completed sketch profile along a straight path tilted (0°–89°)
  away from the sketch plane's own normal, toward its U or V axis, into a new standalone oblique
  prism (0° tilt is equivalent to Extrude), or cut/add into an existing part's face
- **Loft** — blend between 2 or more profiles, each drawn on its own plane, into one new
  standalone solid whose cross-section changes shape (and can twist in 3D) along its length, or
  cut/add into an existing part's face (when the FIRST profile was sketched on it)
- Direct primitive placement: Box, Cylinder, Sphere, Cone
- **Fillet / Chamfer** on STEP-imported part edges (edge-level picking, radius or distance,
  multi-edge per operation, each picked edge independently settable — "variable-radius fillet")
- **Linear and Circular Pattern** — array-copy any part along an axis or around an axis, with a
  configurable count/spacing/angle, undoable as a single step
- **Mirror** — reflect any part across a global XY/YZ/XZ datum plane, undoable as a single step
- **Hole Wizard** — standard metric/inch fastener clearance through-holes (M3–M12, #4-40–3/8-16),
  plain, counterbored or countersunk, cut into a picked face with automatic full-depth
  punch-through; type and sizes stay editable in the Feature Tree
- **Reference Plane** — a named, offset plane from a datum or a picked face, reusable as a Sketch
  target (offset-only; no tilt or 3-point definition yet)
- **Shell** — hollow out a STEP-imported part to a wall thickness, removing one or more picked
  faces
- **Draft** — taper one or more picked faces on a STEP-imported part by a mold-pull angle (fixed
  world +Z pull direction; no user-picked direction/neutral plane yet)
- Interactive Move / Rotate / Scale gizmo
- **Material assignment and mass properties** — a per-part material (8 typical materials), with mass,
  center of gravity, moments/products of inertia and principal moments, updating as the part moves
  (§3.6.1)
- **Measure tool** — distance (two points), angle (three points), face-to-face (distance if parallel,
  otherwise angle), and radius/diameter of a circular edge, with in-viewport labels (§6.1)
- Section (clipping) planes on X/Y/Z, with offset/flip/enable
- Exploded view (radial, slider-controlled)
- Mesh View wireframe overlay (STEP-imported bodies only)
- Bridge Mesh generation between two picked faces
- Undo/Redo for property-style edits, transform drags, section-plane edits, and duplicate — with
  a jump-to-point history dropdown
- Dockable/floating tool panels with persisted layout
- Model tree search/filter
- Right-click context menu (Hide/Isolate/Show All/Transparent/Zoom to Fit/Rename/
  Duplicate/Properties/Delete)
- View presets, navigation cube, orthographic/perspective toggle, shading modes, grid/axes
  toggles, dark mode, fullscreen
- Screenshot capture/download
- **Model export**: STEP (bodies with a real, unmodified STEP-imported solid) and STL (every
  body, any origin), each as one combined file with a clear summary of anything left out
- A separate structural (beam/frame) modeling and linear-elastic analysis workflow (nodes,
  members, supports, load cases/combinations, results diagrams)
- **Feature Tree** — Extrude, Revolve, Sweep, and Loft features can be double-clicked afterward to
  edit their parameters (depth, axis/angle, or tilt/distance for the first three; just Cut for
  Loft) and re-apply — as can Hole Wizard holes (type, diameter, counterbore/countersink sizes)
  and Fillet/Chamfer (per-edge values); a downstream feature that cuts into or fuses onto an edited feature's own
  output automatically recomputes against the new geometry (§3.13). **The edit itself is a real
  Undo/Redo step** (Ctrl+Z/Ctrl+Y — see §4.3). Every other tool remains final-once-applied.

### 🚧 Planned / not yet available

Based on the project's own documented gap analysis against professional CAD tools:

- **Parametric feature tree, full coverage** — a Feature Tree exists and covers Extrude, Revolve,
  Sweep, and Loft (§3.13: edit depth/axis/angle/tilt/distance/cut — or just Cut, for Loft — after
  the fact, with correct downstream recomputation, and the edit itself is undoable — see §4.3), but
  every other tool apart from Hole Wizard and Fillet/Chamfer — primitives, Shell, Draft, Pattern,
  Mirror — is still final once applied, with no equivalent editing step at all. Extending coverage to the
  remaining tools remains
  open. This is still the single largest structural gap overall, just no longer a 0%-covered one.
  It's also why STEP export still can't include a body once it's been Cut into or run through
  Fillet/Chamfer — see §6.8 (unaffected by the Feature Tree, since STEP export reasons about the
  original STEP source, not the Feature Tree's own params).
- **Permanent face identity** — a feature drawn on a face now follows that face when its parent is edited
  (§3.13), but it finds the face by matching direction, size and position rather than by a permanent
  identity, so similar parallel faces can be confused, and it does not yet cover Loft, Hole Wizard,
  Fillet/Chamfer, Shell or Draft.
- **IGES/OBJ/glTF export**, and no export of the structural (FEA) model — STEP and STL cover
  solid/mesh output only (§6.8).
- **Mirror across an offset/angled custom plane or a picked face**, and pattern-along-a-curve/fill
  (2D) patterns — Mirror (§5.5) exists but only across the 3 fixed global datum planes, Linear and
  Circular Pattern (§5.4) are implemented, but there's no arbitrary-direction/curve-following
  pattern and no way to skip individual positions within a pattern.
- **Blind and tapped/threaded holes** — Hole Wizard (§5.6) covers through-holes (plain,
  counterbore, countersink) only; tapped holes need thread modeling, which doesn't exist anywhere
  in this app.
- **Curved-path Sweep and guide-curve/closed Loft** — Revolve, Sweep, and Loft (§5.1, §5.11) can
  all now cut into or fuse onto an existing part (via a picked-face profile + the Cut checkbox),
  but Sweep is still straight-line-only (no path along a picked edge or a second sketch yet), and
  Loft still only blends straight through its profiles in order (no guide curves, no closing the
  loft back on itself) — see each tool's own limitations in §5.1/§5.11.
- **Assembly mates/constraints** — parts don't snap or stay attached to each other; you position
  everything manually with the Move/Rotate gizmo, with no persistent relationship if you move one
  part later.
- **Sketch constraints and dimensions** — no coincident/parallel/perpendicular/tangent/etc.
  constraint solver, and no numeric sketch dimensions you can edit after drawing. Freeform straight-line
  profiles now exist (Polyline, §5.1); arcs, splines, ellipses and construction geometry still don't.
- **More measurement types** — angle, face-to-face and radius/diameter now exist (§6.1). Still missing:
  edge-to-face, edge-to-edge and minimum-distance measurements, snapping to vertices/midpoints,
  measurements that follow a moved part, curvature, and wall-thickness analysis.
- **Tilted/angled or 3-point-defined reference planes, reference axes, reference points** —
  Reference Plane (§5.7) exists but is offset-only (no rotation, no defining a plane through 3
  points); reference axes and persistent reference points don't exist at all yet.
- **2D drawing/documentation sheets** — no dimensioned drawing views, title blocks, or BOM
  generation.
- **Fuller materials and mass properties** — a per-part material and mass properties exist (§3.6.1).
  Still missing: totals for a multi-selection or whole assembly, principal axis directions, custom
  materials, and using the material for anything other than mass (color, stress analysis).
- **Multi-part "Import" (as distinct from "Open")** — today, opening a second STEP file always
  replaces the first; an explicit side-by-side multi-file import action is not currently exposed
  in the UI.
- **Undo for delete and geometry-creating operations** — see §4.3 for the current, permanent
  scope of these actions.
- **Box-select / lasso-select** — a drag-select rectangle was tried and removed after user
  feedback; only click and Ctrl/Shift-click multi-select are available today.
- **Snap-to-grid** for the transform gizmo, project versioning, and large-dataset rendering
  performance work.

If you need one of these capabilities, treat it as a known gap rather than something you're
missing in the UI — it genuinely isn't there yet.

### How this compares to a full professional CAD suite

If you're used to SolidWorks, CATIA, Fusion 360, or a similar full commercial suite, it's worth
knowing roughly where this application stands so you don't go looking for something that isn't
here yet:

- **Viewing, navigating, and inspecting a model** is close to full professional-tool territory —
  camera controls, selection, section views, measurement, and the transform gizmo all behave the
  way a desktop CAD tool's do.
- **Building and modifying simple solids** (sketches with Extrude, Revolve, or Sweep, Loft,
  primitives, Fillet/Chamfer, Pattern, Mirror, Hole Wizard, Reference Plane, Shell, Draft) covers
  real everyday modeling work — Revolve/Sweep/Loft can all now cut into or fuse onto an existing
  part, not just produce a standalone body; Sweep is still straight-line-only, Loft still has no
  guide curves or closed loops, and Draft's pull direction is fixed to world +Z. **Editable feature
  history is now partial, not entirely absent**: Extrude, Revolve, Sweep, and Loft can be
  double-clicked in the Feature Tree (§3.13) afterward to change their parameters (numeric for the
  first three; just Cut for Loft), with correct downstream recomputation — but every other tool
  (primitives, Fillet/Chamfer, Hole Wizard, Shell, Draft, Pattern, Mirror) is still final the
  instant you apply it, with no equivalent step, and even Extrude/Revolve/Sweep/Loft's own sketch
  profile can't be re-edited, only those parameters.
- **Assemblies, mates, and 2D drawings are not implemented at all today.** Parts are positioned by
  hand with the Move/Rotate/Scale gizmo rather than mated together, and there is no drawing-sheet
  output (dimensioned views, GD&T, BOM tables).

Put plainly: this is a genuinely capable tool for viewing, inspecting, and building/modifying
individual solid parts, but it is not yet a full parametric assembly-and-drawing CAD system. If
your work depends on full editable feature history (beyond Extrude/Revolve/Sweep/Loft's own
parameters), part mating, or drawing output, treat those as firm gaps rather than something to
search the UI for.
