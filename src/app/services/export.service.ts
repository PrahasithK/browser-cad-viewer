import { Injectable } from '@angular/core';
import { TreeService } from './tree.service';
import { generateId } from '../utils/id-generator.util';
import { buildBinaryStl } from '../utils/stl-export.util';
import { StepExportRequest, StepExportSource, StepWorkerRequest, StepWorkerResponse } from '../workers/step-worker-messages.model';

export interface StepExportOutcome {
  /** Number of bodies actually written into the STEP file. */
  exportedCount: number;
  /** Names of bodies that could not be included (no retained STEP source — see docstring below), so the caller can warn the user. */
  skipped: string[];
}

/**
 * Orchestrates "Export STEP…" / "Export STL…" (File menu) — the two model-file output paths this
 * app has, as opposed to RenderService's screenshot capture (a picture of the screen, not a CAD
 * file). Deliberately its own service rather than folded into StepLoaderService: that service's
 * existing methods are both about turning worker output INTO a CadBody for the scene; export runs
 * the opposite direction (CadBody/TreeService data OUT to a downloadable file) and needs none of
 * StepLoaderService's geometry-building code, only its "spin up a one-shot worker" shape, which is
 * simple enough to not justify a shared base.
 */
@Injectable({ providedIn: 'root' })
export class ExportService {
  constructor(private readonly tree: TreeService) {}

  /**
   * STEP export can only include bodies that still have a retained original STEP source to
   * re-read (see `TreeService.getImportSource`) — a body created in-session by Sketch/Extrude, a
   * primitive shape, or Fillet/Chamfer has no BRep solid anywhere to write out; only a
   * tessellated triangle mesh exists for it (fine for STL, not a real STEP solid). Rather than
   * fail the whole export over that, this collects whichever bodies DO qualify, exports just
   * those, and reports which ones were skipped so the caller can warn the user — the same
   * "clear about a real limitation instead of silently doing the wrong thing" approach
   * Fillet/Chamfer already uses for the identical underlying constraint.
   *
   * Bodies are grouped by their owning import's source (`groupBySource` below) before the source
   * bytes are ever fetched — the common case is one multi-solid STEP import exploding into many
   * bodies that all share the exact same source `File`/URL, and fetching+transferring that same
   * multi-megabyte buffer once per body (an earlier version of this method did) made a 17-body
   * assembly's export effectively hang. Grouping first means each unique source is fetched, and
   * later re-parsed by the worker, exactly once.
   */
  async exportStep(): Promise<{ blob: Blob; outcome: StepExportOutcome } | null> {
    const bodies = this.tree.allBodies();
    const skipped: string[] = [];

    // Group bodies by their owning import's source value first (cheap, synchronous) — a Map key
    // can be a string (two equal URL strings) or an object reference (the same File instance is
    // retained once per import and handed back identically for every one of that import's
    // bodies), so this needs no string coercion to correctly de-duplicate either kind.
    const groups = new Map<string | File, { solidIndex: number; nodeLabel: string }[]>();
    for (const body of bodies) {
      const nodeId = this.tree.getNodeIdForMesh(body.mesh);
      const source = nodeId ? this.tree.getImportSource(nodeId) : undefined;
      if (!nodeId || !source) {
        skipped.push(body.name);
        continue;
      }
      const entries = groups.get(source) ?? [];
      entries.push({ solidIndex: body.solidIndex, nodeLabel: body.name });
      groups.set(source, entries);
    }

    if (groups.size === 0) return null;

    const sources: StepExportSource[] = [];
    let exportedCount = 0;
    for (const [source, entries] of groups) {
      const buffer = typeof source === 'string' ? await (await fetch(source)).arrayBuffer() : await source.arrayBuffer();
      sources.push({ bytes: new Uint8Array(buffer), solids: entries });
      exportedCount += entries.length;
    }

    const bytes = await this.runExportWorker({ requestId: generateId('export'), sources });
    return {
      // Slice to a plain ArrayBuffer (Blob's typings reject the wider ArrayBufferLike a transferred
      // Uint8Array carries, which could in principle be backed by a SharedArrayBuffer).
      blob: new Blob([bytes.slice().buffer], { type: 'application/step' }),
      outcome: { exportedCount, skipped }
    };
  }

  /**
   * STL export needs no OCCT/worker round-trip — every body already has a ready Three.js
   * `geometry` in memory (see `buildBinaryStl`'s docstring), so this runs synchronously on the
   * main thread. Works for every body regardless of origin, unlike STEP export above.
   */
  exportStl(): Blob | null {
    const bodies = this.tree.allBodies();
    if (bodies.length === 0) return null;
    const buffer = buildBinaryStl(bodies);
    return new Blob([buffer], { type: 'model/stl' });
  }

  /** One-shot worker call, same shape as PrimitiveToolService.commit / FilletChamferToolService.runWorker — spin up a worker, post one request, resolve/reject on the matching response, terminate. */
  private runExportWorker(req: StepExportRequest): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      const worker = new Worker(new URL('../workers/step-loader.worker.ts', import.meta.url), { type: 'module' });

      worker.onmessage = (event: MessageEvent<StepWorkerResponse>) => {
        const msg = event.data;
        if (msg.type !== 'exportStep.result' || msg.requestId !== req.requestId) return;
        worker.terminate();
        if (!msg.success || !msg.bytes) {
          reject(new Error(msg.error ?? 'STEP export failed'));
          return;
        }
        resolve(msg.bytes);
      };
      worker.onerror = (event: ErrorEvent) => {
        worker.terminate();
        reject(new Error(event.message));
      };

      const request: StepWorkerRequest = { type: 'model.exportStep', ...req };
      const transfer = req.sources.map((s) => s.bytes.buffer);
      worker.postMessage(request, transfer);
    });
  }
}

/** Triggers a browser download of the given blob with the given filename — shared by both export paths, same download-link-click technique RenderService.downloadScreenshot already uses. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
