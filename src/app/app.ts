import { Component, ViewChild, computed } from '@angular/core';
import { AppChrome } from './components/app-chrome/app-chrome';
import { Viewport } from './components/viewport/viewport';
import { SidePanels } from './components/side-panels/side-panels';
import { PanelLayoutService } from './services/panel-layout.service';

@Component({
  selector: 'app-root',
  imports: [AppChrome, Viewport, SidePanels],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  @ViewChild(Viewport) viewport!: Viewport;

  /** `.cad-main`'s grid-template-columns, bound inline so SidePanels' resize handles (which only
   * emit width numbers, same as the existing deletePart bubbling) can drive App's own grid — App
   * owns .cad-main, so App is the one that writes to it. */
  readonly gridTemplateColumns;

  constructor(private readonly panelLayout: PanelLayoutService) {
    this.gridTemplateColumns = computed(
      () => `${this.panelLayout.treeWidth()}px 1fr ${this.panelLayout.propertiesWidth()}px`
    );
  }

  onOpenStepFile(): void {
    this.viewport.promptImportStepFile();
  }

  onDeletePart(nodeId: string): void {
    this.viewport.confirmAndDeletePart(nodeId);
  }

  onTreeWidthChange(px: number): void {
    this.panelLayout.setTreeWidth(px);
  }

  onPropertiesWidthChange(px: number): void {
    this.panelLayout.setPropertiesWidth(px);
  }
}
