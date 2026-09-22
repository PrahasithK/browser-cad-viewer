export interface HistoryCommand {
  label: string;
  undo(): void;
  redo(): void;
}
