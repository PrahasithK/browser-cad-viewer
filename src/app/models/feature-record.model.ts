import { FilletChamferEdgeValue, FilletChamferKind } from '../workers/step-worker-messages.model';

/**
 * Client-side shadow copy of the worker's `SessionFeatureRecord` (step-loader.worker.ts) — same
 * identity/replay-input fields, minus the live OCCT `resultShape` handle, which can never leave
 * the worker. The worker is the source of truth for the actual geometry; the client keeps this
 * list only so the Feature Tree panel has something to render and edit without a round-trip per
 * frame. Updated by `SketchService`/`LoftToolService`/`FilletChamferToolService` on every
 * successful feature-tree-aware `extrude`/`revolve`/`sweep`/`loft`/`filletChamfer`/`editExtrude`/
 * `editRevolve`/`editSweep`/`editLoft`/`editFilletChamfer` response — see `FeatureTreeService`.
 *
 * A discriminated union by `kind`, mirroring the worker's own `FeatureRecord` union exactly (see
 * that type's docstring in `step-worker-messages.model.ts` — the two are meant to move together:
 * adding a new feature kind means adding a matching member here too). Slice 1 shipped `'extrude'`
 * only; Slice 2 added `'revolve'`; Slice 3 added `'sweep'`; Slice 4 added `'loft'` (its own
 * `sketchIds: string[]` field, not `sketchId`, and its own narrower `{cut}`-only params — see
 * `FeatureRecord`'s own docstring for why); Slice 5 added `'filletChamfer'` (no `sketchId`/
 * `sketchIds` at all — it isn't sketch-based — and its own `edges` field instead of a flat numeric
 * `params`, since what an edit changes here is each picked edge's own radius/distance, not a
 * single scalar).
 */
export type ClientFeatureRecord =
  | { featureId: string; kind: 'extrude'; label: string; sketchId: string; params: { depth: number; cut: boolean }; nodeId: string }
  | { featureId: string; kind: 'revolve'; label: string; sketchId: string; params: { axis: 'u' | 'v'; angleDeg: number; cut: boolean }; nodeId: string }
  | { featureId: string; kind: 'sweep'; label: string; sketchId: string; params: { axis: 'u' | 'v'; tiltDeg: number; distance: number; cut: boolean }; nodeId: string }
  | { featureId: string; kind: 'loft'; label: string; sketchIds: string[]; params: { cut: boolean }; nodeId: string }
  | { featureId: string; kind: 'filletChamfer'; label: string; params: { filletChamferKind: FilletChamferKind; edges: FilletChamferEdgeValue[] }; nodeId: string };
