import { Injectable, signal } from '@angular/core';
import { HistoryCommand } from '../models/history-command.model';

const MAX_HISTORY = 100;

/**
 * Generic undo/redo command stack. Scope (v1): trivially-reversible property edits only
 * (rename, visibility, color, opacity, position, section plane config) — each command
 * captures the old/new value itself, so undo/redo here is just re-invoking the same setter
 * with the other value. Deletes and OCCT feature creation (sketch extrude, primitives) are
 * NOT wrapped: those dispose GPU resources / mutate the worker's OCCT shape in place with no
 * snapshot to restore, and need their own design (see architecture.md's undo/redo scoping note).
 */
@Injectable({ providedIn: 'root' })
export class HistoryService {
  readonly canUndo = signal(false);
  readonly canRedo = signal(false);
  readonly undoLabel = signal<string | null>(null);
  readonly redoLabel = signal<string | null>(null);

  private readonly undoStack: HistoryCommand[] = [];
  private readonly redoStack: HistoryCommand[] = [];

  /** Runs a command's `redo()` as the initial "do", then pushes it onto the undo stack (clearing any redo branch). */
  run(command: HistoryCommand): void {
    command.redo();
    this.undoStack.push(command);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack.length = 0;
    this.syncSignals();
  }

  undo(): void {
    const command = this.undoStack.pop();
    if (!command) return;
    command.undo();
    this.redoStack.push(command);
    this.syncSignals();
  }

  redo(): void {
    const command = this.redoStack.pop();
    if (!command) return;
    command.redo();
    this.undoStack.push(command);
    this.syncSignals();
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.syncSignals();
  }

  /** Recent undo-stack labels, most-recent first — for the toolbar's history dropdown. Purely additive read access; doesn't change undo/redo semantics or the stack's internal privacy. */
  undoEntries(): string[] {
    return this.undoStack.map((c) => c.label).reverse();
  }

  /** Recent redo-stack labels, most-recent first (i.e. the next redo is index 0) — same shape as undoEntries. */
  redoEntries(): string[] {
    return this.redoStack.map((c) => c.label).reverse();
  }

  private syncSignals(): void {
    this.canUndo.set(this.undoStack.length > 0);
    this.canRedo.set(this.redoStack.length > 0);
    this.undoLabel.set(this.undoStack.at(-1)?.label ?? null);
    this.redoLabel.set(this.redoStack.at(-1)?.label ?? null);
  }
}
