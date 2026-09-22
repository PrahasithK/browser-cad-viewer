import { Injectable, signal } from '@angular/core';
import { ClientFeatureRecord } from '../models/feature-record.model';
import { FilletChamferEdgeValue, FilletChamferKind } from '../workers/step-worker-messages.model';

/**
 * Read-oriented registry of every feature built through the new parametric-feature-tree-aware
 * flow (Slice 1 shipped Extrude only; Slice 2 added Revolve; Slice 3 added Sweep; Slice 4 added
 * Loft) — sits alongside `TreeService` the same way `StructuralModelService` sits "parallel to
 * TreeService's CAD tree but its own domain" (see that service's own docstring in
 * architecture.md). `TreeService`/`ModelingSessionService` remain the sources of truth for the
 * tree/mesh and the actual OCCT geometry respectively; this service exists only so the Feature
 * Tree panel (`tool-panels.ts`) has an ordered, displayable list to render, edit, and re-apply
 * against — filled in by `SketchService`/`LoftToolService`.
 *
 * Deliberately NOT a full mirror of the worker's `Session.features` — no `resultShape`, no
 * `targetRef` resolution logic. Just enough to list features and hand their current params back to
 * `SketchService.commitEditOfFeature`/`commitEditOfRevolveFeature`/`commitEditOfSweepFeature`/
 * `commitEditOfLoftFeature` when the user edits one.
 */
@Injectable({ providedIn: 'root' })
export class FeatureTreeService {
  private readonly featuresState = signal<ClientFeatureRecord[]>([]);

  readonly entries = this.featuresState.asReadonly();

  /**
   * Whether the Feature Tree panel is open. Unlike every other tool panel in this app, this one
   * is a persistent browser/list (the feature-tree analogue of the Model Tree), not a click-driven
   * or selection-gated action — so it deliberately has NO `ActiveTool` entry and no
   * activate/cancel semantics in `ToolService`. Just a plain open/closed flag toggled from the
   * ribbon, the same way, e.g., the Model Tree/Properties side panels have no "tool" concept
   * either.
   */
  readonly panelOpen = signal(false);

  /** The feature currently being edited (its id), or null when no edit is in progress — drives the Feature Tree panel's inline edit form. */
  readonly editingFeatureId = signal<string | null>(null);

  togglePanel(): void {
    this.panelOpen.update((v) => !v);
  }

  /** Called once when a new feature-tree-aware feature is created. */
  register(record: ClientFeatureRecord): void {
    this.featuresState.update((current) => [...current, record]);
  }

  /**
   * Called after a successful edit — updates params in place, preserving the feature's position
   * in the list. Four overloads (rather than one signature taking the full union) so a caller that
   * already knows which kind it's editing (every caller does — `commitEditOfFeature`/
   * `commitEditOfRevolveFeature`/`commitEditOfSweepFeature`/`commitEditOfLoftFeature` each only
   * ever handle their own kind) gets a precisely-typed params argument instead of having to
   * satisfy a union it doesn't need. The runtime body branches on the CURRENT record's `kind` (not
   * the caller's intent, nor a structural check on `params`'s own shape — Loft's `{cut}` params
   * has no field unique to it, since `cut` alone is a subset of every other kind's own params too,
   * so this checks `f.kind` directly rather than trying to distinguish by inspecting `params`) so
   * a caller that somehow passed a mismatched shape is a silent no-op rather than corrupting a
   * record into a shape its own `kind` doesn't match — mirrors the worker's own `handleFeatureEdit`
   * kind-check, just as a quiet guard here since this is UI-list bookkeeping, not the source of
   * truth. Slice 5 added a 5th overload for `filletChamfer`'s own `{filletChamferKind, edges}`
   * shape, distinguished from Loft's `{cut}`-only shape (the only other params with no unique
   * field of its own) by checking for `edges` specifically rather than by exclusion.
   */
  update(featureId: string, params: { depth: number; cut: boolean }): void;
  update(featureId: string, params: { axis: 'u' | 'v'; angleDeg: number; cut: boolean }): void;
  update(featureId: string, params: { axis: 'u' | 'v'; tiltDeg: number; distance: number; cut: boolean }): void;
  update(featureId: string, params: { cut: boolean }): void;
  update(featureId: string, params: { filletChamferKind: FilletChamferKind; edges: FilletChamferEdgeValue[] }): void;
  update(
    featureId: string,
    params:
      | { depth: number; cut: boolean }
      | { axis: 'u' | 'v'; angleDeg: number; cut: boolean }
      | { axis: 'u' | 'v'; tiltDeg: number; distance: number; cut: boolean }
      | { cut: boolean }
      | { filletChamferKind: FilletChamferKind; edges: FilletChamferEdgeValue[] }
  ): void {
    this.featuresState.update((current) =>
      current.map((f) => {
        if (f.featureId !== featureId) return f;
        if (f.kind === 'extrude' && 'depth' in params) return { ...f, params };
        if (f.kind === 'revolve' && 'angleDeg' in params) return { ...f, params };
        if (f.kind === 'sweep' && 'tiltDeg' in params) return { ...f, params };
        if (f.kind === 'filletChamfer' && 'edges' in params) return { ...f, params };
        if (f.kind === 'loft' && !('depth' in params) && !('axis' in params) && !('edges' in params)) return { ...f, params };
        return f;
      })
    );
  }

  find(featureId: string): ClientFeatureRecord | undefined {
    return this.featuresState().find((f) => f.featureId === featureId);
  }

  beginEdit(featureId: string): void {
    this.editingFeatureId.set(featureId);
  }

  cancelEdit(): void {
    this.editingFeatureId.set(null);
  }

  reset(): void {
    this.featuresState.set([]);
    this.editingFeatureId.set(null);
  }
}
