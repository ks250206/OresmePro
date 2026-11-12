import { applyCommand, isTransient, type Command } from "./commands";
import { dictFrom, filterDict, type Dict } from "./dict";
import { emptyDoc, type DocState } from "./types";

interface UndoEntry {
  state: DocState;
  /** Commands sharing a group (one Python execution, say) undo together. */
  group: string | null;
}

/** A record as it must be in the document: itself if it has no prototype, else a copy that has none. */
const asDict = <T>(record: Dict<T>): Dict<T> =>
  Object.getPrototypeOf(record) === null ? record : dictFrom(record);

/**
 * A document whose records kept by name all have no prototype (see ./dict):
 * the same document if that already holds. The commands build them so, but
 * nothing in the types says a record must be one, so every state that enters
 * the document passes through here rather than trusting each command.
 */
function withDicts(state: DocState): DocState {
  let graphs = asDict(state.graphs);
  for (const [name, graph] of Object.entries(graphs)) {
    const axes = asDict(graph.axes);
    const cursors = asDict(graph.cursors);
    if (axes === graph.axes && cursors === graph.cursors) continue;
    if (graphs === state.graphs) graphs = dictFrom(graphs);
    (graphs as Record<string, typeof graph>)[name] = { ...graph, axes, cursors };
  }
  let tables = asDict(state.tables);
  for (const [name, table] of Object.entries(tables)) {
    const widths = asDict(table.widths);
    if (widths === table.widths) continue;
    if (tables === state.tables) tables = dictFrom(tables);
    (tables as Record<string, typeof table>)[name] = { ...table, widths };
  }
  const waves = asDict(state.waves);
  const procedures = asDict(state.procedures);
  const pages = asDict(state.pages);
  const same =
    graphs === state.graphs &&
    tables === state.tables &&
    waves === state.waves &&
    procedures === state.procedures &&
    pages === state.pages;
  return same ? state : { ...state, waves, graphs, tables, procedures, pages };
}

const UNDO_LIMIT = 100;
/**
 * How much wave data the undo history may keep alive beyond what the
 * document itself holds. Editing a large wave leaves a copy behind with every
 * step; past this, the oldest steps are forgotten.
 */
const UNDO_BYTES = 512 * 1024 * 1024;

export interface DispatchOptions {
  group?: string;
}

/**
 * Holds the document and is the only way to change it. Snapshots are
 * immutable, so undo is a stack of earlier states; unchanged waves are shared
 * between snapshots and cost nothing.
 */
export class Doc {
  private readonly undoBytes: number;

  constructor(options: { undoBytes?: number } = {}) {
    this.undoBytes = options.undoBytes ?? UNDO_BYTES;
  }

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
    const applied = applyCommand(before, command);
    const { result } = applied;
    if (applied.state === before) return result;
    const state = withDicts(applied.state);
    if (isTransient(command)) {
      this.state = state;
    } else {
      const group = options.group ?? null;
      const last = this.undoStack.at(-1);
      if (!(group !== null && last?.group === group)) {
        this.undoStack.push({ state: before, group });
        if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
        this.trimUndo(state);
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
    this.state = withDicts(state);
    this.undoStack = [];
    this.redoStack = [];
    this.emit();
  }

  /**
   * Forgets the oldest undo steps while the wave data that only they keep
   * alive is more than the limit. Arrays are shared between snapshots, so
   * each is counted once, and those of the current document not at all.
   */
  private trimUndo(current: DocState): void {
    const live = new Set<unknown>();
    for (const wave of Object.values(current.waves)) {
      live.add(wave.data);
      if (wave.imag) live.add(wave.imag);
    }
    // Newest first: an array is charged to the most recent step that needs it.
    const seen = new Set<unknown>(live);
    let bytes = 0;
    for (let index = this.undoStack.length - 1; index >= 0; index -= 1) {
      for (const wave of Object.values(this.undoStack[index]!.state.waves)) {
        for (const array of [wave.data, wave.imag]) {
          if (!array || seen.has(array)) continue;
          seen.add(array);
          bytes += array.byteLength;
        }
      }
      // The latest step is always kept: one undo must always be possible.
      if (bytes > this.undoBytes && index < this.undoStack.length - 1) {
        this.undoStack.splice(0, index + 1);
        return;
      }
    }
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
    const tables = dictFrom(target.tables);
    for (const [name, table] of Object.entries(tables)) {
      const widths = now.tables[name]?.widths;
      if (!widths || widths === table.widths) continue;
      tables[name] = {
        ...table,
        widths: filterDict(widths, (_, wave) => table.columns.includes(wave)),
      };
    }
    const procedures = dictFrom(target.procedures);
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
