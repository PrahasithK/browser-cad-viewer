# Browser CAD Viewer

A 3D mechanical CAD tool that runs entirely in the browser — no install, no account, no server.
Everything you open, draw, and analyze stays on your own machine for the life of the tab.

You can open and inspect STEP files, build parts from scratch (sketch + extrude/revolve/sweep/loft,
primitives), modify existing parts (cut, boss, fillet/chamfer, shell, draft, hole wizard, pattern,
mirror), inspect and measure a model (distance, angle, face-to-face, radius/diameter, mass
properties), and run a basic structural (beam/frame) analysis — all client-side.

For what you can do in the app, see **[context/user-manual.md](context/user-manual.md)**.
For how it's built internally, see **[context/architecture.md](context/architecture.md)**.
For a gap analysis against professional mechanical CAD suites and the development roadmap, see
**[context/cad-gap-analysis.md](context/cad-gap-analysis.md)**.

## Stack

Angular 20 (standalone components, signals), Three.js for rendering, OpenCascade.js (the OCCT
geometry kernel, compiled to WASM) running in a Web Worker for all solid modelling.

## Development

```bash
npm install
npm start        # ng serve — http://localhost:4200 by default (printed on start)
```

```bash
npm run build     # production build, output in dist/
npm test          # unit tests (Karma + Jasmine); needs a Chrome/Chromium binary —
                   # set CHROME_BIN if it isn't auto-detected
npx tsc --noEmit -p tsconfig.app.json     # typecheck the app
npx tsc --noEmit -p tsconfig.worker.json  # typecheck the OCCT worker
```

End-to-end / kernel-level verification lives in the `verify-*.mjs` scripts at the repo root —
Playwright drivers against a running `ng serve` instance, exercising real geometry operations with
numeric before/after checks (not just "no error thrown"). Run `ng serve --port 4300` in one
terminal, then e.g. `node verify-measure-types.mjs` in another (`PW_CHANNEL=chrome` if Playwright's
own bundled browser isn't installed).

## Sample files

`public/assets/*.STEP` are example parts you can open via **File → Open STEP…** inside the app —
they are not loaded automatically.
