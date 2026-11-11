export type HistoryOutput =
  | { kind: "stream"; name: "stdout" | "stderr"; text: string }
  | { kind: "result"; text: string; svg?: string; png?: string }
  | { kind: "error"; name: string; message: string; traceback: string };

export interface HistoryEntry {
  id: number;
  /** user: typed in the command line; gui: echoed from a menu or dialog; system: a notice. */
  source: "user" | "gui" | "system";
  code: string;
  outputs: HistoryOutput[];
  status: "queued" | "running" | "ok" | "error";
  /** Milliseconds since the epoch. */
  startedAt: number;
  durationMs: number | null;
}

const MAX_ENTRIES = 5000;
const MAX_OUTPUT_CHARS = 200_000;

/** The command history: what was run, in order, with its output. */
export class History {
  private entries: readonly HistoryEntry[] = [];
  private nextId = 1;
  private readonly listeners = new Set<() => void>();

  readonly getEntries = (): readonly HistoryEntry[] => this.entries;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  load(entries: readonly HistoryEntry[]): void {
    // Anything still marked as running belongs to a session that is gone.
    this.entries = entries.map((entry) =>
      entry.status === "running" || entry.status === "queued"
        ? { ...entry, status: "error" as const }
        : entry,
    );
    this.nextId = entries.reduce((max, entry) => Math.max(max, entry.id), 0) + 1;
    this.emit();
  }

  add(
    source: HistoryEntry["source"],
    code: string,
    status: HistoryEntry["status"] = "ok",
    now = Date.now(),
  ): number {
    const id = this.nextId;
    this.nextId += 1;
    const entry: HistoryEntry = {
      id,
      source,
      code,
      outputs: [],
      status,
      startedAt: now,
      durationMs: null,
    };
    this.entries = [...this.entries, entry].slice(-MAX_ENTRIES);
    this.emit();
    return id;
  }

  update(
    id: number,
    change: Partial<Pick<HistoryEntry, "status" | "durationMs" | "startedAt">>,
  ): void {
    this.replace(id, (entry) => ({ ...entry, ...change }));
  }

  appendOutput(id: number, output: HistoryOutput): void {
    this.replace(id, (entry) => {
      const last = entry.outputs.at(-1);
      if (output.kind === "stream" && last?.kind === "stream" && last.name === output.name) {
        let text = last.text + output.text;
        if (text.length > MAX_OUTPUT_CHARS) {
          text = `[... earlier output dropped ...]\n${text.slice(-MAX_OUTPUT_CHARS / 2)}`;
        }
        return { ...entry, outputs: [...entry.outputs.slice(0, -1), { ...last, text }] };
      }
      return { ...entry, outputs: [...entry.outputs, output] };
    });
  }

  clear(): void {
    this.entries = [];
    this.emit();
  }

  private replace(id: number, change: (entry: HistoryEntry) => HistoryEntry): void {
    let found = false;
    const entries = this.entries.map((entry) => {
      if (entry.id !== id) return entry;
      found = true;
      return change(entry);
    });
    if (!found) return;
    this.entries = entries;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/**
 * The commands available for recall, oldest first, with repeats removed
 * (keeping the most recent occurrence), as a shell's history does.
 */
export function recallList(entries: readonly HistoryEntry[]): string[] {
  const seen = new Set<string>();
  const commands: string[] = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.source === "system") continue;
    const code = entry.code.trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    commands.push(entry.code.replace(/\s+$/, ""));
  }
  return commands.reverse();
}

/**
 * Steps through history from `from` (an index into `commands`, or
 * `commands.length` for "not in history yet") to the next command starting
 * with `prefix`. Returns the new index, or null if there is none.
 */
export function stepRecall(
  commands: readonly string[],
  prefix: string,
  from: number,
  direction: -1 | 1,
): number | null {
  for (let index = from + direction; index >= 0 && index < commands.length; index += direction) {
    if (commands[index]!.startsWith(prefix)) return index;
  }
  return null;
}

/** Commands containing every word of the query, most recent first. */
export function searchHistory(commands: readonly string[], query: string): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches: string[] = [];
  for (let index = commands.length - 1; index >= 0; index -= 1) {
    const command = commands[index]!;
    const text = command.toLowerCase();
    if (words.every((word) => text.includes(word))) matches.push(command);
  }
  return matches;
}

/**
 * The rest of the most recent command that starts with what has been typed,
 * for showing as a greyed-out suggestion. Only single-line input is completed.
 */
export function suggestCompletion(commands: readonly string[], typed: string): string {
  if (!typed.trim() || typed.includes("\n")) return "";
  for (let index = commands.length - 1; index >= 0; index -= 1) {
    const command = commands[index]!;
    if (command.length > typed.length && command.startsWith(typed)) {
      return command.slice(typed.length);
    }
  }
  return "";
}
