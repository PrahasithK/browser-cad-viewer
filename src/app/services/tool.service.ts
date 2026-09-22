import { Injectable, Injector, signal } from '@angular/core';
import { MeasurementService } from './measurement.service';
import { SketchService } from './sketch.service';
import { SelectionService } from './selection.service';
import { PropertyService } from './property.service';
import { StructuralToolService } from './structural-tool.service';
import { BridgeMeshService } from './bridge-mesh.service';
import { PrimitiveToolService } from './primitive-tool.service';
import { FilletChamferToolService } from './fillet-chamfer-tool.service';
import { PatternToolService } from './pattern-tool.service';
import { MirrorToolService } from './mirror-tool.service';
import { HoleWizardService } from './hole-wizard.service';
import { ReferencePlaneService } from './reference-plane.service';
import { ShellToolService } from './shell-tool.service';
import { DraftToolService } from './draft-tool.service';
import { LoftToolService } from './loft-tool.service';

export type ActiveTool = 'none' | 'measure' | 'sketch' | 'structural-node' | 'structural-member' | 'bridge-mesh' | 'primitive' | 'fillet-chamfer' | 'pattern' | 'mirror' | 'hole-wizard' | 'reference-plane' | 'shell' | 'draft' | 'loft';

/**
 * Mutually-exclusive active-tool state. Measure and Sketch cannot both be active at once;
 * activating one deactivates the other. Section stays independent (it's a passive clipping
 * overlay, not a click-driven tool) and keeps its own per-axis enabled flags in SectionService.
 *
 * SketchService is resolved lazily via Injector to avoid a circular DI dependency
 * (SketchService itself does not depend on ToolService, but is constructed after it here).
 */
@Injectable({ providedIn: 'root' })
export class ToolService {
  readonly activeTool = signal<ActiveTool>('none');

  constructor(
    private readonly measurement: MeasurementService,
    private readonly injector: Injector
  ) {}

  setTool(tool: ActiveTool): void {
    const current = this.activeTool();
    if (current === tool) {
      this.deactivate(current);
      this.activeTool.set('none');
      return;
    }

    this.deactivate(current);
    this.activeTool.set(tool);
    this.activate(tool);
  }

  private activate(tool: ActiveTool): void {
    if (tool === 'measure' && !this.measurement.active()) {
      this.measurement.toggleActive();
    }
    if (tool === 'sketch' || tool === 'fillet-chamfer' || tool === 'hole-wizard' || tool === 'reference-plane' || tool === 'shell' || tool === 'draft' || tool === 'loft') {
      // A stale whole-body selection highlight (orange box + gizmo) has no code path to clear
      // itself once Sketch/Fillet-Chamfer/Hole-Wizard/Reference-Plane/Shell/Draft/Loft is active
      // — every canvas click routes through this tool's own handler, not handleSelectClick, so it
      // would otherwise sit there indefinitely. Clear it immediately. Both SelectionService
      // (highlight) and PropertyService (properties panel + the in-viewport body-size labels it
      // now also drives) need clearing — they're separate state that don't sync each other.
      this.injector.get(SelectionService).clearSelection();
      this.injector.get(PropertyService).showProperties(null);
    }
    if (tool === 'reference-plane') {
      this.injector.get(ReferencePlaneService).activate();
    }
    if (tool === 'pattern') {
      // Unlike Sketch/Fillet-Chamfer above, Pattern deliberately does NOT clear selection — it
      // has no viewport click phase to fight with, and its target body IS the current selection
      // (snapshotted once here rather than read live, so later selection changes don't retarget
      // a half-configured pattern).
      this.injector.get(PatternToolService).activate();
    }
    if (tool === 'mirror') {
      // Same selection-gated-panel shape as Pattern, for the same reason — see PatternToolService.
      this.injector.get(MirrorToolService).activate();
    }
    if (tool === 'loft') {
      this.injector.get(LoftToolService).activate();
    }
    // Note: 'hole-wizard' has no further activate() branch beyond the selection-clear above —
    // unlike Pattern/Mirror (selection-gated, no click phase) it starts in 'picking-face' with no
    // target snapshotted yet, the same shape Sketch/Fillet-Chamfer/BridgeMesh already use.
  }

  private deactivate(tool: ActiveTool): void {
    if (tool === 'measure' && this.measurement.active()) {
      this.measurement.toggleActive();
    }
    if (tool === 'sketch') {
      this.injector.get(SketchService).cancel();
    }
    if (tool === 'structural-node' || tool === 'structural-member') {
      this.injector.get(StructuralToolService).cancel();
    }
    if (tool === 'bridge-mesh') {
      this.injector.get(BridgeMeshService).cancel();
    }
    if (tool === 'primitive') {
      this.injector.get(PrimitiveToolService).cancel();
    }
    if (tool === 'fillet-chamfer') {
      this.injector.get(FilletChamferToolService).cancel();
    }
    if (tool === 'pattern') {
      this.injector.get(PatternToolService).cancel();
    }
    if (tool === 'mirror') {
      this.injector.get(MirrorToolService).cancel();
    }
    if (tool === 'hole-wizard') {
      this.injector.get(HoleWizardService).cancel();
    }
    if (tool === 'reference-plane') {
      this.injector.get(ReferencePlaneService).cancel();
    }
    if (tool === 'shell') {
      this.injector.get(ShellToolService).cancel();
    }
    if (tool === 'draft') {
      this.injector.get(DraftToolService).cancel();
    }
    if (tool === 'loft') {
      this.injector.get(LoftToolService).cancel();
    }
  }
}
