import { applyCommand, isTransient, settleFormulas, type Command } from "./commands";
import { dictFrom, filterDict, type Dict } from "./dict";
import { DocError, emptyDoc, type DocState, type WindowState } from "./types";

interface UndoEntry {
  state: DocState;
  /** Commands sharing a group (one Python execution, say) undo together. */
  group: string | null;
  /** The windows as the step left them, to tell what it resized from what was dragged since. */
  after: readonly WindowState[];
}

interface RedoEntry {
  state: DocState;
  /** The windows as the undo left them. */
  after: readonly WindowState[];
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
  const panels = asDict(state.panels);
  const styles = asDict(state.styles);
  const graphTemplates = asDict(state.graphTemplates);
  const results = asDict(state.results);
  const templates = asDict(state.templates);
  const runs = asDict(state.runs);
  const same =
    graphs === state.graphs &&
    tables === state.tables &&
    waves === state.waves &&
    procedures === state.procedures &&
    pages === state.pages &&
    panels === state.panels &&
    styles === state.styles &&
    graphTemplates === state.graphTemplates &&
    results === state.results &&
    templates === state.templates &&
    runs === state.runs;
  return same
    ? state
    : {
        ...state,
        waves,
        graphs,
        tables,
        procedures,
        pages,
        panels,
        styles,
        graphTemplates,
        results,
        templates,
        runs,
      };
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

/** What a transaction is given: the document as its changes so far left it, and a way to change it further. */
export interface DocWriter {
  getState(): DocState;
  dispatch(command: Command): string | null;
}

/**
 * A document state with commands applied to it, kept apart from the document.
 * `durable` tells whether any of them is undoable (not just view state).
 */
class Working implements DocWriter {
  state: DocState;
  durable = false;

  constructor(state: DocState) {
    this.state = state;
  }

  readonly getState = (): DocState => this.state;

  dispatch(command: Command): string | null {
    const applied = applyCommand(this.state, command);
    if (applied.state !== this.state) {
      // Formulas that depend on what the command changed are computed again
      // here, so that they belong to the same step: they undo with it, go into
      // a transaction or an op.atomic() block with it, and are computed again
      // when a block's commands are replayed. Waves untouched, nothing to do.
      const settled =
        applied.state.waves === this.state.waves ? applied.state : settleFormulas(applied.state);
      this.state = withDicts(settled);
      if (!isTransient(command)) this.durable = true;
    }
    return applied.result;
  }
}

/**
 * Changes that build up over many calls and reach the document together or
 * not at all: what one `with op.atomic():` block of Python makes. Python
 * reads its own changes as it goes, while the document (and so the GUI)
 * sees none of them until {@link Stage.commit}.
 *
 * The document may change meanwhile (the GUI does not wait for Python). The
 * stage then replays its commands on the document as it is, which succeeds
 * when the changes do not meet: a moved window or an edit of another wave
 * stops nothing. It refuses when a wave it read has changed since, since
 * what it computed from it is out of date, and when a command does not come
 * out as it did (a name made unique differently, a wave since deleted).
 * Revisions are never reused, so an unchanged revision is unchanged content.
 */
export class Stage implements DocWriter {
  private readonly base: DocState;
  private readonly working: Working;
  private readonly applied: { command: Command; result: string | null }[] = [];
  /** The revision each wave had when first read, for waves read before the stage changed them. */
  private readonly reads = new Map<string, number>();
  /** Points to go back to, for blocks within blocks. */
  private readonly marks: { state: DocState; durable: boolean; count: number }[] = [];
  private closed = false;

  private readonly commitTo: (stage: Stage, options: DispatchOptions) => void;

  constructor(base: DocState, commitTo: (stage: Stage, options: DispatchOptions) => void) {
    this.base = base;
    this.working = new Working(base);
    this.commitTo = commitTo;
  }

  readonly getState = (): DocState => this.working.state;

  /** The document state the stage began from. */
  get origin(): DocState {
    return this.base;
  }

  /** Whether the stage changed anything that undo would restore. */
  get durable(): boolean {
    return this.working.durable;
  }

  /** The commands applied, with what each returned. */
  get commands(): readonly { command: Command; result: string | null }[] {
    return this.applied;
  }

  /** The waves read from the document as it was, with their revisions then. */
  get waveReads(): ReadonlyMap<string, number> {
    return this.reads;
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  dispatch(command: Command): string | null {
    this.checkOpen();
    const result = this.working.dispatch(command);
    this.applied.push({ command, result });
    return result;
  }

  /**
   * Notes that a wave was read: the commit fails if it changes in the
   * document meanwhile. A wave the stage made or changed itself is its own.
   */
  read(name: string): void {
    const wave = this.working.state.waves[name];
    if (!wave || this.base.waves[name] !== wave || this.reads.has(name)) return;
    this.reads.set(name, wave.rev);
  }

  /** Remembers this point, for {@link rollback}: the start of a block within the block. */
  mark(): void {
    this.checkOpen();
    this.marks.push({
      state: this.working.state,
      durable: this.working.durable,
      count: this.applied.length,
    });
  }

  /** Forgets the last point marked, keeping what was done since. */
  release(): void {
    this.checkOpen();
    this.marks.pop();
  }

  /** Undoes what was done since the last point marked, and forgets the point. */
  rollback(): void {
    this.checkOpen();
    const mark = this.marks.pop();
    if (!mark) return;
    this.working.state = mark.state;
    this.working.durable = mark.durable;
    this.applied.length = mark.count;
  }

  /** How many blocks within the block are open. */
  get depth(): number {
    return this.marks.length;
  }

  /** Puts the changes into the document as one undo step, or throws and changes nothing. */
  commit(options: DispatchOptions = {}): void {
    this.checkOpen();
    this.closed = true;
    this.commitTo(this, options);
  }

  /** Drops the changes. */
  discard(): void {
    this.closed = true;
  }

  private checkOpen(): void {
    if (this.closed) throw new DocError("The changes were already put in or dropped.");
  }
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
  private redoStack: RedoEntry[] = [];
  /** True while a transaction's function runs: the document must not change under it. */
  private transacting = false;

  readonly getState = (): DocState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Applies a command and returns the name of what it created, if anything. */
  dispatch(command: Command, options: DispatchOptions = {}): string | null {
    this.checkNotTransacting();
    const working = new Working(this.state);
    const result = working.dispatch(command);
    this.adopt(working, options);
    return result;
  }

  /**
   * Applies several commands as one change: `fn` changes the document through
   * the writer it is given, and only if it returns without throwing does the
   * document take on the result, as one undo step and one notification. If it
   * throws, nothing has changed. The writer reads the changes made so far.
   */
  transact<T>(fn: (writer: DocWriter) => T, options: DispatchOptions = {}): T {
    this.checkNotTransacting();
    const working = new Working(this.state);
    this.transacting = true;
    let outcome: T;
    try {
      outcome = fn(working);
    } finally {
      this.transacting = false;
    }
    this.adopt(working, options);
    return outcome;
  }

  /** Starts changes kept apart from the document until committed (see {@link Stage}). */
  stage(): Stage {
    return new Stage(this.state, (stage, options) => this.commitStage(stage, options));
  }

  private commitStage(stage: Stage, options: DispatchOptions): void {
    // A block that only read has nothing to put in, however much changed meanwhile.
    if (stage.commands.length === 0) return;
    const current = this.state;
    if (current === stage.origin) {
      // Nothing happened meanwhile: the stage's state is the document's next state as it is.
      const working = new Working(current);
      working.state = stage.getState();
      working.durable = stage.durable;
      this.adopt(working, options);
      return;
    }
    for (const [name, rev] of stage.waveReads) {
      if (current.waves[name]?.rev !== rev) {
        throw new DocError(
          `${name} changed while this was running, so nothing it did was kept. Run it again.`,
        );
      }
    }
    this.transact((writer) => {
      for (const { command, result } of stage.commands) {
        if (writer.dispatch(command) !== result) {
          throw new DocError(
            "The experiment changed while this was running, so nothing it did was kept. Run it again.",
          );
        }
      }
    }, options);
  }

  /** Makes a working state the document's, as one step; nothing happens if it is unchanged. */
  private adopt(working: Working, options: DispatchOptions): void {
    const before = this.state;
    const state = working.state;
    if (state === before) return;
    if (working.durable) {
      const group = options.group ?? null;
      const last = this.undoStack.at(-1);
      if (group !== null && last?.group === group) {
        last.after = state.windows;
      } else {
        this.undoStack.push({ state: before, group, after: state.windows });
        if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
        this.trimUndo(state);
      }
      this.redoStack = [];
    }
    this.state = state;
    this.emit();
  }

  private checkNotTransacting(): void {
    if (this.transacting) {
      throw new Error("The document cannot change on its own while a transaction is running.");
    }
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): boolean {
    this.checkNotTransacting();
    const entry = this.undoStack.pop();
    if (!entry) return false;
    const now = this.state;
    this.state = this.keepViewState(entry.state, entry.after);
    this.redoStack.push({ state: now, after: this.state.windows });
    this.emit();
    return true;
  }

  redo(): boolean {
    this.checkNotTransacting();
    const entry = this.redoStack.pop();
    if (!entry) return false;
    const now = this.state;
    this.state = this.keepViewState(entry.state, entry.after);
    this.undoStack.push({ state: now, group: null, after: this.state.windows });
    this.emit();
    return true;
  }

  /** Replaces the whole document, for opening an experiment. */
  load(state: DocState): void {
    this.checkNotTransacting();
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
   * current value. The one exception is a window the step itself resized (a
   * style with a size does), as long as it is still as the step left it
   * (`stepWindows`): its size is part of what is undone.
   */
  private keepViewState(target: DocState, stepWindows: readonly WindowState[]): DocState {
    const now = this.state;
    const current = new Map(now.windows.map((window) => [window.name, window]));
    const left = new Map(stepWindows.map((window) => [window.name, window]));
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
        if (!live) return window;
        const step = left.get(window.name);
        const untouched = step !== undefined && step.w === live.w && step.h === live.h;
        const size = untouched ? { w: window.w, h: window.h } : { w: live.w, h: live.h };
        return { ...window, x: live.x, y: live.y, ...size };
      }),
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
