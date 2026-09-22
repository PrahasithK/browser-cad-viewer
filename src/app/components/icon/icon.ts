import { Component, Input } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { getIconMarkup, IconName } from '../../utils/icon-registry.util';

/**
 * Renders one inline SVG icon by name from `icon-registry.util.ts`. The one reusable UI-shell
 * component this pass adds — justified the same way `PanelDragHandle` (the app's one existing
 * directive) was: a cross-cutting chrome concern with no feature-domain logic, used identically
 * by app-chrome/side-panels/tool-panels, so duplicating raw <svg> markup in 3 templates would be
 * worse than one tiny component (per architecture.md's "no thin wrapper components" guidance,
 * this is the deliberate exception — same category as PanelDragHandle).
 */
@Component({
  selector: 'app-icon',
  template: `<svg [attr.width]="size" [attr.height]="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" [innerHTML]="markup"></svg>`,
  styles: [':host { display: inline-flex; line-height: 0; }']
})
export class Icon {
  @Input() size = 14;
  markup: SafeHtml = '';

  constructor(private readonly sanitizer: DomSanitizer) {}

  @Input() set name(value: IconName) {
    // getIconMarkup only ever returns fixed strings from this file's own registry, never
    // user-supplied content, so bypassSecurityTrustHtml here can't be an injection vector.
    this.markup = this.sanitizer.bypassSecurityTrustHtml(getIconMarkup(value));
  }
}
