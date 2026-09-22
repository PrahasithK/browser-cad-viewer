import { Directive, ElementRef, EventEmitter, Input, Output } from '@angular/core';

export interface PanelDragEvent {
  x: number;
  y: number;
  clientX: number;
  clientY: number;
}

/**
 * Generic drag-handle behavior for a floating panel's title bar. Knows nothing about dock
 * zones, viewport bounds, or persistence — it only reports pointer deltas as candidate
 * top-left coordinates (viewport-relative, computed against the panel's own parent). All
 * dock-snap/persistence decisions are made by the host component (ToolPanels) from the
 * emitted events, mirroring how ToolPanels already owns section-offset drag behavior.
 */
@Directive({
  selector: '[appPanelDragHandle]',
  host: {
    '(pointerdown)': 'onPointerDown($event)',
    '(pointermove)': 'onPointerMove($event)',
    '(pointerup)': 'onPointerUp($event)',
    style: 'cursor: move;'
  }
})
export class PanelDragHandle {
  @Input('appPanelDragHandle') panelId!: string;

  @Output() dragStart = new EventEmitter<void>();
  @Output() dragMove = new EventEmitter<PanelDragEvent>();
  @Output() dragEnd = new EventEmitter<PanelDragEvent>();

  private dragging = false;
  private pointerOffsetX = 0;
  private pointerOffsetY = 0;

  constructor(private readonly host: ElementRef<HTMLElement>) {}

  onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    const panel = this.host.nativeElement.closest<HTMLElement>('.floating-panel') ?? this.host.nativeElement.parentElement;
    if (!panel) return;

    const parentRect = panel.offsetParent instanceof HTMLElement ? panel.offsetParent.getBoundingClientRect() : { left: 0, top: 0 };
    const panelRect = panel.getBoundingClientRect();
    this.pointerOffsetX = event.clientX - panelRect.left;
    this.pointerOffsetY = event.clientY - panelRect.top;
    this.dragging = true;
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    this.dragStart.emit();
    void parentRect;
    event.preventDefault();
  }

  onPointerMove(event: PointerEvent): void {
    if (!this.dragging) return;
    const panel = this.host.nativeElement.closest<HTMLElement>('.floating-panel') ?? this.host.nativeElement.parentElement;
    const parent = panel?.offsetParent as HTMLElement | null;
    const parentRect = parent?.getBoundingClientRect() ?? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    const panelWidth = panel?.offsetWidth ?? 0;
    const panelHeight = panel?.offsetHeight ?? 0;

    let x = event.clientX - parentRect.left - this.pointerOffsetX;
    let y = event.clientY - parentRect.top - this.pointerOffsetY;
    const maxX = Math.max(0, parentRect.width - panelWidth);
    const maxY = Math.max(0, parentRect.height - panelHeight);
    x = Math.min(maxX, Math.max(0, x));
    y = Math.min(maxY, Math.max(0, y));

    this.dragMove.emit({ x, y, clientX: event.clientX, clientY: event.clientY });
  }

  onPointerUp(event: PointerEvent): void {
    if (!this.dragging) return;
    this.dragging = false;
    const panel = this.host.nativeElement.closest<HTMLElement>('.floating-panel') ?? this.host.nativeElement.parentElement;
    const parent = panel?.offsetParent as HTMLElement | null;
    const parentRect = parent?.getBoundingClientRect() ?? { left: 0, top: 0 };
    const panelRect = panel?.getBoundingClientRect();
    const x = (panelRect?.left ?? 0) - parentRect.left;
    const y = (panelRect?.top ?? 0) - parentRect.top;
    this.dragEnd.emit({ x, y, clientX: event.clientX, clientY: event.clientY });
  }
}
