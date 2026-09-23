import { Injectable, signal } from '@angular/core';
import { generateId } from '../utils/id-generator.util';
import { sha256Hex } from '../utils/hash.util';
import { DocBodyRef, FilletChamferEdgeValue, FilletChamferKind, HoleFeatureParams, PlaneRef, SketchEntity, StepWorkerRequest, StepWorkerResponse, WorkerTessellatedBody } from '../workers/step-worker-messages.model';
import { FeatureCreateRequest, FeatureEditRequest, LoggedBodyRef, LoggedFeatureCreate, SessionLogEntry } from '../models/project.model';

export interface FeatureResult {
  featureId: string;
  bodies: WorkerTessellatedBody[];
}

type EditParams = FeatureEditRequest['params'];

/**
 * Owns a single long-lived worker + OCCT session for interactive sketch/feature authoring,
 * as opposed to StepLoaderService's one-shot worker-per-load used for viewing STEP imports.
 * The worker keeps its OCCT shape alive across calls so features can build on one another.
 *
 * Every sketch commit, feature creation and feature edit is also appended to a session log
 * (`exportLog`), in the order the worker receives them. A saved project stores that log, and
 * `replay` feeds it into a fresh session on open, rebuilding the worker's feature history exactly
 * so features stay editable (see `SessionLogEntry` for why edits are replayed, not collapsed).
 */
@Injectable({ providedIn: 'root' })
export class ModelingSessionService {
  readonly sessionId = signal<string | null>(null);

  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;

  private pendingSketch = new Map<string, { resolve: (ok: boolean, error?: string) => void }>();
  private pendingFeature = new Map<string, { resolve: (r: FeatureResult) => void; reject: (err: Error) => void }>();

  private log: SessionLogEntry[] = [];

  async start(): Promise<string> {
    if (this.sessionId()) return this.sessionId()!;

    const id = generateId('session');
    this.worker = new Worker(new URL('../workers/step-loader.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<StepWorkerResponse>) => this.handleMessage(event.data);

    this.ready = new Promise<void>((resolve) => {
      const onReady = (event: MessageEvent<StepWorkerResponse>) => {
        if (event.data.type === 'session.ready' && event.data.sessionId === id) {
          this.worker?.removeEventListener('message', onReady as EventListener);
          resolve();
        }
      };
      this.worker!.addEventListener('message', onReady as EventListener);
    });

    const request: StepWorkerRequest = { type: 'session.start', sessionId: id };
    this.worker.postMessage(request);
    await this.ready;

    this.sessionId.set(id);
    return id;
  }

  async commitSketch(sketchId: string, planeRef: PlaneRef, entities: SketchEntity[], faceAnchorFeatureId?: string): Promise<{ success: boolean; error?: string }> {
    const id = this.sessionId();
    if (!id || !this.worker) throw new Error('No active modeling session');

    const entry: SessionLogEntry = { kind: 'sketch', sketchId, planeRef, entities, faceAnchorFeatureId, status: 'pending' };
    this.log.push(entry);
    return new Promise((resolve) => {
      this.pendingSketch.set(sketchId, {
        resolve: (ok, error) => {
          entry.status = ok ? 'ok' : 'failed';
          resolve({ success: ok, error });
        }
      });
      const request: StepWorkerRequest = { type: 'sketch.commit', sessionId: id, sketchId, planeRef, entities, faceAnchorFeatureId };
      this.worker!.postMessage(request);
    });
  }

  /**
   * `targetBody`, when present, identifies an existing body whose own solid should be cut/fused
   * against instead of this session's internally-accumulated shape — either a STEP-imported body
   * (`kind: 'imported'`, structurally identical to the old plain `FeatureCutTarget`) or a prior
   * feature's own output (`kind: 'feature'`, parametric feature tree Slice 1 — see `DocBodyRef`'s
   * docstring for why this widening exists: it's what makes "cut into a body this session itself
   * built via Extrude" constructible, which is what exercises the worker's downstream-dependent
   * replay path). The bytes buffer (`kind: 'imported'` only) is transferred, not copied, since the
   * caller has no further use for it after this call.
   *
   * `producesBodyId` (parametric feature tree, Slice 1) opts this call into the worker's new
   * feature-history bookkeeping — pass one (from `generateId('body')`) to make this extrude
   * later editable via `editExtrude()`; omit it to keep today's plain one-shot behavior (used by
   * every call site not yet migrated to the feature-tree flow — unaffected by this addition).
   *
   * `featureId`, when passed, is used as-is instead of generating a fresh one internally — the
   * caller (`SketchService.finishAndExtrude`) needs to know this exact id BEFORE the call resolves,
   * so it can register the same id with `TreeService.linkFeature`/`FeatureTreeService` as the one
   * the worker actually stored in `session.features[].featureId`. Passing `producesBodyId` without
   * `featureId` (or vice versa) is a caller bug — a later `{kind:'feature', featureId}` target
   * lookup would silently fail to find the record (this is exactly the bug this parameter fixes:
   * before it, this method always minted its own internal featureId, which never matched whatever
   * id the caller separately tracked client-side, so the worker's `session.features` and the
   * client's `FeatureTreeService`/`TreeNode.featureId` disagreed on every feature's identity).
   */
  async extrude(sketchId: string, depth: number, cut: boolean, targetBody?: DocBodyRef, producesBodyId?: string, featureId?: string): Promise<FeatureResult> {
    const id = this.requireSession();
    return this.sendFeature({ type: 'feature.extrude', sessionId: id, featureId: featureId ?? generateId('feature'), sketchId, depth, cut, targetBody, producesBodyId });
  }

  /**
   * Edits a previously-created extrude feature (one built via `extrude()` with a
   * `producesBodyId`) and replays it plus every feature after it in the session's history — see
   * the worker's own `handleFeatureEdit` docstring. Resolves with one `WorkerTessellatedBody` per
   * replayed feature (the edited one plus every downstream dependent), each tagged with its own
   * `producesBodyId` so the caller can update every affected `CadBody` from one response.
   */
  async editExtrude(featureId: string, params: { depth: number; cut: boolean }): Promise<FeatureResult> {
    return this.sendEdit(featureId, { kind: 'extrude', ...params });
  }

  /** Revolve's counterpart of `editExtrude` — same shape, `params.kind` tags it for the worker's own validation. Added in Slice 2. */
  async editRevolve(featureId: string, params: { axis: 'u' | 'v'; angleDeg: number; cut: boolean }): Promise<FeatureResult> {
    return this.sendEdit(featureId, { kind: 'revolve', ...params });
  }

  /**
   * Spins the committed sketch's profile around the sketch plane's own U or V axis. `targetBody`
   * (added 2026-09-13, widened to `DocBodyRef` in Slice 2, same meaning/transfer-list treatment as
   * `extrude()`'s own) lets this cut into or fuse onto an existing body's own solid — either
   * STEP-imported or a prior feature's own output — instead of producing a standalone new one;
   * v1 (2026-09-10) shipped standalone-only; see the worker's own handleFeatureRevolve docstring.
   * `producesBodyId`/`featureId` (Slice 2) work exactly like `extrude()`'s own — see that method's
   * docstring for why passing `featureId` explicitly (rather than letting this method mint its own)
   * matters: it's what keeps the client and worker agreeing on this feature's identity.
   */
  async revolve(sketchId: string, axis: 'u' | 'v', angleDeg: number, cut?: boolean, targetBody?: DocBodyRef, producesBodyId?: string, featureId?: string): Promise<FeatureResult> {
    const id = this.requireSession();
    return this.sendFeature({ type: 'feature.revolve', sessionId: id, featureId: featureId ?? generateId('feature'), sketchId, axis, angleDeg, cut, targetBody, producesBodyId });
  }

  /**
   * Sweeps the committed sketch's profile a straight distance along a direction tilted `tiltDeg`
   * away from the sketch plane's own normal, toward its own u or v in-plane axis (tiltDeg=0 is
   * identical to extrude() — see the worker's own handleFeatureSweep docstring for the full
   * scoping/bug-fix story). `targetBody` widened to `DocBodyRef`, `producesBodyId`/`featureId`
   * added in Slice 3 — same treatment as `revolve()`'s own Slice-2 widening; see that method's
   * docstring for why passing `featureId` explicitly matters.
   */
  async sweep(sketchId: string, axis: 'u' | 'v', tiltDeg: number, distance: number, cut?: boolean, targetBody?: DocBodyRef, producesBodyId?: string, featureId?: string): Promise<FeatureResult> {
    const id = this.requireSession();
    return this.sendFeature({ type: 'feature.sweep', sessionId: id, featureId: featureId ?? generateId('feature'), sketchId, axis, tiltDeg, distance, cut, targetBody, producesBodyId });
  }

  /** Sweep's counterpart of `editRevolve`/`editExtrude` — same shape, `params.kind` tags it for the worker's own validation. Added in Slice 3. */
  async editSweep(featureId: string, params: { axis: 'u' | 'v'; tiltDeg: number; distance: number; cut: boolean }): Promise<FeatureResult> {
    return this.sendEdit(featureId, { kind: 'sweep', ...params });
  }

  /**
   * Blends between 2+ already-committed sketch profiles (in order) into one solid — see the
   * worker's own handleFeatureLoft docstring for why this is the only feature that references
   * more than one committed sketchId in a single request. `targetBody` widened to `DocBodyRef`,
   * `producesBodyId`/`featureId` added in Slice 4 — same treatment as `sweep()`'s own Slice-3
   * widening; see that method's docstring for why passing `featureId` explicitly matters.
   * `targetBody`, when present, is always resolved client-side from the FIRST profile's picked
   * face only, per `feature.loft`'s own docstring in step-worker-messages.model.ts.
   */
  async loft(sketchIds: string[], cut?: boolean, targetBody?: DocBodyRef, producesBodyId?: string, featureId?: string): Promise<FeatureResult> {
    const id = this.requireSession();
    return this.sendFeature({ type: 'feature.loft', sessionId: id, featureId: featureId ?? generateId('feature'), sketchIds, cut, targetBody, producesBodyId });
  }

  /** Loft's counterpart of `editSweep`/`editRevolve`/`editExtrude` — deliberately the smallest params shape of the four (`{cut}` only), since Loft's v1 edit surface doesn't cover re-adding/removing/reordering profiles, only the Cut checkbox. Added in Slice 4. */
  async editLoft(featureId: string, params: { cut: boolean }): Promise<FeatureResult> {
    return this.sendEdit(featureId, { kind: 'loft', ...params });
  }

  /**
   * Rounds (fillet) or bevels (chamfer) one or more edges of an existing body's own solid — the
   * first feature-tree-aware kind (Slice 5) with no sketch input at all and no optional
   * `targetBody`: fillet/chamfer always modifies a real existing solid in place, either a
   * STEP-imported body or a prior feature's own output (never a standalone new body), so
   * `targetBody` is required here, unlike `extrude()`/`revolve()`/`sweep()`/`loft()`'s own
   * optional one. `producesBodyId`/`featureId` work exactly like those methods' own — see
   * `extrude()`'s docstring for why passing `featureId` explicitly matters.
   */
  async filletChamfer(kind: FilletChamferKind, targetBody: DocBodyRef, edges: FilletChamferEdgeValue[], producesBodyId?: string, featureId?: string): Promise<FeatureResult> {
    const id = this.requireSession();
    return this.sendFeature({
      type: 'feature.filletChamfer',
      sessionId: id,
      featureId: featureId ?? generateId('feature'),
      kind,
      targetBody,
      edges,
      producesBodyId: producesBodyId ?? generateId('body')
    });
  }

  /** Fillet/Chamfer's counterpart of `editLoft`/`editSweep`/`editRevolve`/`editExtrude` — edits per-edge radius/distance values; the picked edge SET itself is fixed at creation, same restriction Loft's own profile set has. Added in Slice 5. */
  async editFilletChamfer(featureId: string, params: { filletChamferKind: FilletChamferKind; edges: FilletChamferEdgeValue[] }): Promise<FeatureResult> {
    return this.sendEdit(featureId, { kind: 'filletChamfer', ...params });
  }

  /** Cuts a Hole Wizard hole (through, counterbore or countersink) into `targetBody` at the committed sketch's circle center. `producesBodyId`/`featureId` work exactly like `extrude()`'s own. */
  async hole(sketchId: string, params: HoleFeatureParams, targetBody: DocBodyRef, producesBodyId: string, featureId: string): Promise<FeatureResult> {
    const id = this.requireSession();
    return this.sendFeature({ type: 'feature.hole', sessionId: id, featureId, sketchId, params, targetBody, producesBodyId });
  }

  /** Hole's counterpart of `editExtrude` — every size and the hole type are editable; the center and face are fixed at creation. */
  async editHole(featureId: string, params: HoleFeatureParams): Promise<FeatureResult> {
    return this.sendEdit(featureId, { kind: 'hole', ...params });
  }

  /** True while any request is still waiting on the worker — a save then would record an unfinished history. */
  hasPendingWork(): boolean {
    return this.pendingSketch.size > 0 || this.pendingFeature.size > 0;
  }

  /** Resolves once nothing is waiting on the worker (checked every 200 ms), or rejects after `timeoutMs`. */
  async whenIdle(timeoutMs = 300_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.hasPendingWork()) {
      if (Date.now() > deadline) throw new Error('an operation is still running — try again once it finishes.');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  /** A copy of the session log for saving. Failed sketch commits and creates are dropped — they left nothing in the worker. */
  exportLog(): SessionLogEntry[] {
    return structuredClone(this.log.filter((e) => e.kind === 'edit' || e.status === 'ok'));
  }

  /**
   * Rebuilds a saved session: starts a fresh one and sends every logged request again, in order.
   * `blobs` supplies the STEP bytes behind each logged imported target. The replayed requests are
   * logged again as they go, so the rebuilt session saves the same way. Results are discarded —
   * the caller has already restored the meshes from the project file. Throws if a request that
   * succeeded originally fails now, since everything after it would be built on the wrong shape.
   */
  async replay(entries: SessionLogEntry[], blobs: Map<string, Uint8Array>): Promise<void> {
    const id = await this.start();
    for (const entry of entries) {
      if (entry.kind === 'sketch') {
        const result = await this.commitSketch(entry.sketchId, entry.planeRef, entry.entities, entry.faceAnchorFeatureId);
        if (!result.success) throw new Error(`Sketch ${entry.sketchId} could not be rebuilt: ${result.error ?? 'unknown error'}`);
      } else if (entry.kind === 'create') {
        const logged = entry.request.targetBody;
        let targetBody: DocBodyRef | undefined;
        if (logged?.kind === 'imported') {
          const bytes = blobs.get(logged.blob);
          if (!bytes) throw new Error(`Feature ${entry.request.featureId} targets a STEP file that isn't in this project`);
          targetBody = { kind: 'imported', bytes: bytes.slice(), solidIndex: logged.solidIndex };
        } else {
          targetBody = logged;
        }
        await this.sendFeature({ ...entry.request, sessionId: id, targetBody } as FeatureCreateRequest, logged?.kind === 'imported' ? logged.blob : undefined);
      } else {
        try {
          await this.sendEdit(entry.request.featureId, entry.request.params);
        } catch (err) {
          if (entry.status === 'ok') throw err;
        }
      }
    }
  }

  dispose(): void {
    const id = this.sessionId();
    if (id && this.worker) {
      const request: StepWorkerRequest = { type: 'session.dispose', sessionId: id };
      this.worker.postMessage(request);
    }
    this.worker?.terminate();
    this.worker = null;
    this.sessionId.set(null);
    this.pendingSketch.clear();
    this.pendingFeature.clear();
    this.log = [];
  }

  private requireSession(): string {
    const id = this.sessionId();
    if (!id || !this.worker) throw new Error('No active modeling session');
    return id;
  }

  /**
   * Posts a feature-creation request and logs it. Imported STEP bytes are hashed BEFORE posting,
   * because posting transfers (detaches) their buffer. `knownBlob` skips that hash when the caller
   * already knows it (a replay).
   */
  private async sendFeature(request: FeatureCreateRequest, knownBlob?: string): Promise<FeatureResult> {
    const target = request.targetBody;
    let loggedTarget: LoggedBodyRef | undefined;
    if (target?.kind === 'imported') {
      loggedTarget = { kind: 'imported', blob: knownBlob ?? (await sha256Hex(target.bytes)), solidIndex: target.solidIndex };
    } else {
      loggedTarget = target;
    }
    if (!this.worker || this.sessionId() !== request.sessionId) throw new Error('No active modeling session');

    const { sessionId: _sessionId, targetBody: _targetBody, ...rest } = request;
    const entry: SessionLogEntry = { kind: 'create', request: { ...rest, ...(loggedTarget ? { targetBody: loggedTarget } : {}) } as LoggedFeatureCreate, status: 'pending' };
    this.log.push(entry);

    return new Promise((resolve, reject) => {
      this.pendingFeature.set(request.featureId, {
        resolve: (result) => {
          entry.status = 'ok';
          resolve(result);
        },
        reject: (err) => {
          entry.status = 'failed';
          reject(err);
        }
      });
      const transfer = target?.kind === 'imported' ? [target.bytes.buffer] : [];
      this.worker!.postMessage(request, transfer);
    });
  }

  /** Posts a `feature.edit` request and logs it (with its outcome — see `SessionLogStatus`). */
  private sendEdit(featureId: string, params: EditParams): Promise<FeatureResult> {
    const id = this.requireSession();
    const entry: SessionLogEntry = { kind: 'edit', request: { type: 'feature.edit', featureId, params }, status: 'pending' };
    this.log.push(entry);

    return new Promise((resolve, reject) => {
      this.pendingFeature.set(featureId, {
        resolve: (result) => {
          entry.status = 'ok';
          resolve(result);
        },
        reject: (err) => {
          entry.status = 'failed';
          reject(err);
        }
      });
      const request: StepWorkerRequest = { type: 'feature.edit', sessionId: id, featureId, params };
      this.worker!.postMessage(request);
    });
  }

  private handleMessage(msg: StepWorkerResponse): void {
    if (msg.type === 'sketch.result') {
      const pending = this.pendingSketch.get(msg.sketchId);
      if (pending) {
        pending.resolve(msg.success, msg.error);
        this.pendingSketch.delete(msg.sketchId);
      }
      return;
    }

    if (msg.type === 'feature.result') {
      const pending = this.pendingFeature.get(msg.featureId);
      if (pending) {
        if (msg.success) {
          pending.resolve({ featureId: msg.featureId, bodies: msg.bodies });
        } else {
          pending.reject(new Error(msg.error ?? 'Feature operation failed'));
        }
        this.pendingFeature.delete(msg.featureId);
      }
      return;
    }

    if (msg.type === 'filletChamfer.needsBuild') {
      void this.handleFilletChamferNeedsBuild(msg);
      return;
    }
  }

  /**
   * Answers the session worker's own `filletChamfer.needsBuild` request (see that message type's
   * docstring in step-worker-messages.model.ts for the full round-trip and why it's routed through
   * the main thread at all — a nested Worker-in-Worker spawn from inside the session worker itself
   * fails outright in this dev environment). Spawns a FRESH, throwaway Worker here — main-thread-
   * spawns-worker is exactly the same proven pattern every one-shot tool (Shell/Draft/primitives,
   * and the pre-Slice-5 Fillet/Chamfer) already uses — runs one `filletChamfer.build` request
   * against it, then relays the answer back to the session worker as `filletChamfer.needsBuild.result`
   * with the same `buildRequestId` so it can resolve the right pending promise.
   */
  private handleFilletChamferNeedsBuild(msg: Extract<StepWorkerResponse, { type: 'filletChamfer.needsBuild' }>): void {
    const sessionWorker = this.worker;
    const buildWorker = new Worker(new URL('../workers/step-loader.worker.ts', import.meta.url), { type: 'module' });

    const onMessage = (event: MessageEvent<StepWorkerResponse>) => {
      const result = event.data;
      if (result.type !== 'filletChamfer.build.result' || result.requestId !== msg.buildRequestId) return;
      buildWorker.terminate();
      const reply: StepWorkerRequest = {
        type: 'filletChamfer.needsBuild.result',
        buildRequestId: msg.buildRequestId,
        body: result.body,
        resultBytes: result.resultBytes,
        success: result.success,
        error: result.error
      };
      const transfer = result.body ? [...bodyTransferListFor(result.body), ...(result.resultBytes ? [result.resultBytes.buffer] : [])] : [];
      sessionWorker?.postMessage(reply, transfer);
    };
    buildWorker.onmessage = onMessage;
    buildWorker.onerror = (event: ErrorEvent) => {
      buildWorker.terminate();
      const reply: StepWorkerRequest = {
        type: 'filletChamfer.needsBuild.result',
        buildRequestId: msg.buildRequestId,
        body: null,
        resultBytes: null,
        success: false,
        error: event.message || 'Fillet/Chamfer build worker failed'
      };
      sessionWorker?.postMessage(reply);
    };

    const request: StepWorkerRequest = { type: 'filletChamfer.build', requestId: msg.buildRequestId, kind: msg.kind, targetBytes: msg.targetBytes, solidIndex: msg.solidIndex, edges: msg.edges };
    buildWorker.postMessage(request, [msg.targetBytes.buffer]);
  }
}

/** Same transfer-list shape `bodyTransferList` uses worker-side (positions, indices, faceIdMap, mesh-view positions/indices, edge points) — a small local copy since importing the worker's own private helper isn't possible (it isn't exported), and this is the only main-thread call site that needs it. */
function bodyTransferListFor(body: WorkerTessellatedBody): Transferable[] {
  const list: Transferable[] = [body.positions.buffer, body.indices.buffer, body.faceIdMap.buffer, body.meshViewPositions.buffer, body.meshViewIndices.buffer];
  for (const e of body.edges) list.push(e.points.buffer);
  return list;
}
