import { applyCommand, isTransient, type Command } from "./commands";
import { emptyDoc, type DocState } from "./types";

interface UndoEntry {
  state: DocState;
  /** Commands sharing a group (one Python execution, say) undo together. */
  group: string | null;
}

const UNDO_LIMIT = 100;

export interface DispatchOptions {
  group?: string;
}

/**
 * Holds the document and is the only way to change it. Snapshots are
 * immutable, so undo is a stack of earlier states; unchanged waves are shared
 * between snapshots and cost nothing.
 */
export class Doc {
  private state: DocState = emptyDoc();
  private readonly listeners = new Set<() => void>();
  private undoStack: UndoEntry[] = [];
  private redoStack: DocState[] = [];

  readonly getState = (): DocState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Applies a command and returns the name of what it created, if anything. */
  dispatch(command: Command, options: DispatchOptions = {}): string | null {
    const before = this.state;
    const { state, result } = applyCommand(before, command);
    if (state === before) return result;
    if (isTransient(command)) {
      this.state = state;
    } else {
      const group = options.group ?? null;
      const last = this.undoStack.at(-1);
      if (!(group !== null && last?.group === group)) {
        this.undoStack.push({ state: before, group });
        if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
      }
      this.redoStack = [];
      this.state = state;
    }
    this.emit();
    return result;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): boolean {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    this.redoStack.push(this.state);
    this.state = this.keepViewState(entry.state);
    this.emit();
    return true;
  }

  redo(): boolean {
    const state = this.redoStack.pop();
    if (!state) return false;
    this.undoStack.push({ state: this.state, group: null });
    this.state = this.keepViewState(state);
    this.emit();
    return true;
  }

  /** Replaces the whole document, for opening an experiment. */
  load(state: DocState): void {
    this.state = state;
    this.undoStack = [];
    this.redoStack = [];
    this.emit();
  }

  /**
   * Undo restores content, not what is outside its reach: where the user has
   * since dragged windows, column widths, and the text of procedures (their
   * editors have their own undo). Whatever exists in both states keeps its
   * current value.
   */
  private keepViewState(target: DocState): DocState {
    const now = this.state;
    const current = new Map(now.windows.map((window) => [window.name, window]));
    const tables = { ...target.tables };
    for (const [name, table] of Object.entries(tables)) {
      const widths = now.tables[name]?.widths;
      if (!widths || widths === table.widths) continue;
      const kept = Object.entries(widths).filter(([wave]) => table.columns.includes(wave));
      tables[name] = { ...table, widths: Object.fromEntries(kept) };
    }
    const procedures = { ...target.procedures };
    for (const name of Object.keys(procedures)) {
      if (now.procedures[name]) procedures[name] = now.procedures[name];
    }
    return {
      ...target,
      tables,
      procedures,
      windows: target.windows.map((window) => {
        const live = current.get(window.name);
        return live ? { ...window, x: live.x, y: live.y, w: live.w, h: live.h } : window;
      }),
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
