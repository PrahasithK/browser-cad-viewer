import { Injectable, signal } from '@angular/core';
import { StructuralModelService } from './structural-model.service';
import { analyzeStructure } from '../utils/structural-solver.util';
import { AnalysisResult } from '../models/structural-result.model';

/**
 * Wraps the pure structural-solver.util functions. Runs synchronously on the main thread —
 * unlike the OCCT worker, this is plain JS matrix math with no wasm involved, and completes in
 * well under 100ms at v1 model scale (see the approved plan's Phase 2 decision).
 */
@Injectable({ providedIn: 'root' })
export class StructuralSolverService {
  readonly lastResults = signal<AnalysisResult[] | null>(null);
  readonly lastError = signal<string | null>(null);

  constructor(private readonly model: StructuralModelService) {}

  analyze(): AnalysisResult[] {
    this.lastError.set(null);
    try {
      const results = analyzeStructure({
        nodes: this.model.nodes(),
        members: this.model.members(),
        sections: this.model.sections(),
        materials: this.model.materials(),
        supports: this.model.supports(),
        loadCases: this.model.loadCases(),
        loads: this.model.loads(),
        combinations: this.model.combinations()
      });
      this.lastResults.set(results);
      return results;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError.set(message);
      this.lastResults.set(null);
      throw err;
    }
  }
}
