import { dict, type Dict } from "./dict";
import { DocError, type DocState, type Formula, type Wave } from "./types";

/*
 * The language of wave formulas (Set Wave Values): arithmetic on waves,
 * point by point, read by a parser of its own. It is neither Python nor
 * JavaScript, and nothing in it reaches anything but the waves it names:
 * there is no attribute access, no indexing and no call of anything outside
 * the fixed list of functions below, because the grammar has no way to say
 * them.
 *
 *   expression := test ("?" expression ":" expression)?
 *   test       := and ("||" and)*
 *   and        := equality ("&&" equality)*
 *   equality   := comparison (("==" | "!=") comparison)*
 *   comparison := sum (("<" | "<=" | ">" | ">=") sum)*
 *   sum        := product (("+" | "-") product)*
 *   product    := unary (("*" | "/") unary)*
 *   unary      := ("-" | "+" | "!") unary | power
 *   power      := atom ("^" unary)?            right to left: 2^3^2 is 2^9
 *   atom       := number | name | function "(" expression ("," expression)* ")"
 *               | "(" expression ")"
 *
 * As in mathematics, -2^2 is -(2^2) and 2^-1 is a half. A name is a wave,
 * with ":" between data folders ("run1:V", "root:run1:V"), or one of `p`
 * (the point number), `x` (its X value), `pi`, `e`, `nan` and `inf`. A wave
 * whose name is one of those is written in single quotes: 'x'. Any wave may
 * be written so, which also keeps a folder path apart from the ":" of
 * `? :` when there is no space before it.
 */

/** The fixed functions: how many arguments each takes, and what it does. */
const FUNCTIONS: Readonly<
  Record<string, { min: number; max: number; apply: (...args: number[]) => number }>
> = {
  abs: { min: 1, max: 1, apply: Math.abs },
  sqrt: { min: 1, max: 1, apply: Math.sqrt },
  exp: { min: 1, max: 1, apply: Math.exp },
  ln: { min: 1, max: 1, apply: Math.log },
  // As in Igor, log is the common logarithm; ln is the natural one.
  log: { min: 1, max: 1, apply: Math.log10 },
  log10: { min: 1, max: 1, apply: Math.log10 },
  sin: { min: 1, max: 1, apply: Math.sin },
  cos: { min: 1, max: 1, apply: Math.cos },
  tan: { min: 1, max: 1, apply: Math.tan },
  asin: { min: 1, max: 1, apply: Math.asin },
  acos: { min: 1, max: 1, apply: Math.acos },
  atan: { min: 1, max: 1, apply: Math.atan },
  atan2: { min: 2, max: 2, apply: Math.atan2 },
  sinh: { min: 1, max: 1, apply: Math.sinh },
  cosh: { min: 1, max: 1, apply: Math.cosh },
  tanh: { min: 1, max: 1, apply: Math.tanh },
  floor: { min: 1, max: 1, apply: Math.floor },
  ceil: { min: 1, max: 1, apply: Math.ceil },
  // Halves away from zero, as Igor rounds; Math.round takes -2.5 to -2.
  round: { min: 1, max: 1, apply: (value) => Math.sign(value) * Math.round(Math.abs(value)) },
  min: { min: 2, max: Infinity, apply: Math.min },
  max: { min: 2, max: Infinity, apply: Math.max },
  pow: { min: 2, max: 2, apply: Math.pow },
  hypot: { min: 2, max: 2, apply: Math.hypot },
  sign: { min: 1, max: 1, apply: Math.sign },
  isnan: { min: 1, max: 1, apply: (value) => (Number.isNaN(value) ? 1 : 0) },
};

/** The functions a formula can call, in the order they are documented. */
export const FORMULA_FUNCTIONS: readonly string[] = Object.keys(FUNCTIONS);

const CONSTANTS: Readonly<Record<string, number>> = {
  pi: Math.PI,
  e: Math.E,
  nan: Number.NaN,
  NaN: Number.NaN,
  inf: Infinity,
  Inf: Infinity,
};

/** Names that mean something else than a wave unless quoted. */
const RESERVED = new Set(["p", "x", ...Object.keys(CONSTANTS)]);

const PART = String.raw`\p{L}[\p{L}\p{N}_]*`;
const BARE_NAME = new RegExp(`^${PART}(?::${PART})*`, "u");
const WHOLE_NAME = new RegExp(`^${PART}(?::${PART})*$`, "u");
const NUMBER = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
const OPERATORS = ["&&", "||", "==", "!=", "<=", ">=", "<", ">", "!", "+", "-", "*", "/", "^"];
const PUNCTUATION = ["(", ")", ",", "?", ":"];
/** How deeply parentheses and operators may nest: enough for any formula, short of the stack. */
const MAX_DEPTH = 200;

/** A mistake in a formula, with where it is: `at` counts characters from 0. */
export class FormulaError extends DocError {
  readonly at: number;
  /** The message without the position. */
  readonly detail: string;

  constructor(detail: string, at: number) {
    super(`${detail} (at character ${at + 1})`);
    this.name = "FormulaError";
    this.at = at;
    this.detail = detail;
  }
}

type Token =
  | { kind: "number"; value: number; at: number; end: number }
  | { kind: "name"; name: string; quoted: boolean; at: number; end: number }
  | { kind: "symbol"; text: string; at: number; end: number }
  | { kind: "end"; at: number; end: number };

const withoutRoot = (path: string): string =>
  path.startsWith("root:") && path.length > 5 ? path.slice(5) : path;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < text.length) {
    const char = text[at]!;
    if (/\s/.test(char)) {
      at += 1;
      continue;
    }
    const rest = text.slice(at);
    const number = NUMBER.exec(rest);
    if (number) {
      tokens.push({ kind: "number", value: Number(number[0]), at, end: at + number[0].length });
      at += number[0].length;
      continue;
    }
    const name = BARE_NAME.exec(rest);
    if (name) {
      const end = at + name[0].length;
      tokens.push({ kind: "name", name: withoutRoot(name[0]), quoted: false, at, end });
      at = end;
      continue;
    }
    if (char === "'") {
      const close = text.indexOf("'", at + 1);
      if (close === -1) throw new FormulaError("This quote is not closed", at);
      const inside = text.slice(at + 1, close);
      if (!WHOLE_NAME.test(inside)) {
        throw new FormulaError(`'${inside}' is not a wave name`, at);
      }
      tokens.push({ kind: "name", name: withoutRoot(inside), quoted: true, at, end: close + 1 });
      at = close + 1;
      continue;
    }
    const symbol =
      OPERATORS.find((op) => rest.startsWith(op)) ?? PUNCTUATION.find((op) => op === char);
    if (symbol) {
      tokens.push({ kind: "symbol", text: symbol, at, end: at + symbol.length });
      at += symbol.length;
      continue;
    }
    if (char === "=") throw new FormulaError('Use "==" to compare', at);
    throw new FormulaError(`${JSON.stringify(char)} has no meaning in a formula`, at);
  }
  tokens.push({ kind: "end", at: text.length, end: text.length });
  return tokens;
}

/** A formula as read: a tree of these. `at` is where each starts in the text. */
export type FormulaNode =
  | { kind: "number"; value: number; at: number }
  | { kind: "wave"; name: string; at: number }
  | { kind: "point" | "x"; at: number }
  | { kind: "unary"; op: "-" | "+" | "!"; operand: FormulaNode; at: number }
  | { kind: "binary"; op: string; left: FormulaNode; right: FormulaNode; at: number }
  | { kind: "choice"; test: FormulaNode; ifTrue: FormulaNode; ifFalse: FormulaNode; at: number }
  | { kind: "call"; name: string; args: FormulaNode[]; at: number };

export interface ParsedFormula {
  readonly root: FormulaNode;
  /** The waves it reads, each once, in the order they first appear. */
  readonly inputs: readonly string[];
  /** Where each wave is named in the text, for rewriting the names. */
  readonly references: readonly { name: string; at: number; end: number; quoted: boolean }[];
}

/** Reads a formula, or throws a {@link FormulaError} saying where it went wrong. */
export function parseFormula(text: string): ParsedFormula {
  const cached = parsed.get(text);
  if (cached) return cached;
  const tokens = tokenize(text);
  const references: { name: string; at: number; end: number; quoted: boolean }[] = [];
  let position = 0;
  let depth = 0;
  const peek = (): Token => tokens[position]!;
  const isSymbol = (token: Token, ...texts: string[]): boolean =>
    token.kind === "symbol" && texts.includes(token.text);
  const describe = (token: Token): string =>
    token.kind === "end"
      ? "the end"
      : token.kind === "number"
        ? `the number ${text.slice(token.at, token.end)}`
        : token.kind === "name"
          ? `"${text.slice(token.at, token.end)}"`
          : `"${token.text}"`;
  const expect = (symbol: string, hint = ""): Token => {
    const token = peek();
    if (!isSymbol(token, symbol)) {
      throw new FormulaError(`Expected "${symbol}" but found ${describe(token)}${hint}`, token.at);
    }
    position += 1;
    return token;
  };
  const nested = <T>(at: number, read: () => T): T => {
    depth += 1;
    if (depth > MAX_DEPTH) throw new FormulaError("The formula is nested too deeply", at);
    try {
      return read();
    } finally {
      depth -= 1;
    }
  };

  const binaryLevel =
    (operators: readonly string[], next: () => FormulaNode) => (): FormulaNode => {
      let left = next();
      while (isSymbol(peek(), ...operators)) {
        const token = peek() as Extract<Token, { kind: "symbol" }>;
        position += 1;
        const right = next();
        left = { kind: "binary", op: token.text, left, right, at: token.at };
      }
      return left;
    };

  const expression = (): FormulaNode =>
    nested(peek().at, () => {
      const test = logicalOr();
      const question = peek();
      if (!isSymbol(question, "?")) return test;
      position += 1;
      const ifTrue = expression();
      // "b:c" right after "?" is read as a wave in a data folder, which leaves no ":".
      const hint =
        ifTrue.kind === "wave" && ifTrue.name.includes(":") && !isSymbol(peek(), ":")
          ? ` (${ifTrue.name} was read as a wave in a data folder: put a space before the ":" of "? :")`
          : "";
      expect(":", hint);
      const ifFalse = expression();
      return { kind: "choice", test, ifTrue, ifFalse, at: question.at };
    });

  const atom = (): FormulaNode => {
    const token = peek();
    if (token.kind === "number") {
      position += 1;
      return { kind: "number", value: token.value, at: token.at };
    }
    if (isSymbol(token, "(")) {
      position += 1;
      const inner = expression();
      expect(")");
      return inner;
    }
    if (token.kind === "name") {
      position += 1;
      if (isSymbol(peek(), "(")) {
        const fn = token.quoted ? undefined : FUNCTIONS[token.name];
        if (!fn || !Object.hasOwn(FUNCTIONS, token.name)) {
          throw new FormulaError(
            `There is no function "${text.slice(token.at, token.end)}". Functions: ${FORMULA_FUNCTIONS.join(", ")}`,
            token.at,
          );
        }
        position += 1;
        const args: FormulaNode[] = [];
        if (!isSymbol(peek(), ")")) {
          args.push(expression());
          while (isSymbol(peek(), ",")) {
            position += 1;
            args.push(expression());
          }
        }
        expect(")");
        if (args.length < fn.min || args.length > fn.max) {
          const wanted =
            fn.max === Infinity
              ? `at least ${fn.min} arguments`
              : fn.min === 1
                ? "one argument"
                : `${fn.min} arguments`;
          throw new FormulaError(`${token.name} takes ${wanted}`, token.at);
        }
        return { kind: "call", name: token.name, args, at: token.at };
      }
      if (!token.quoted) {
        if (token.name === "p") return { kind: "point", at: token.at };
        if (token.name === "x") return { kind: "x", at: token.at };
        if (Object.hasOwn(CONSTANTS, token.name)) {
          return { kind: "number", value: CONSTANTS[token.name]!, at: token.at };
        }
      }
      references.push({ name: token.name, at: token.at, end: token.end, quoted: token.quoted });
      return { kind: "wave", name: token.name, at: token.at };
    }
    throw new FormulaError(
      token.kind === "end"
        ? "The formula ends where a value is expected"
        : `Expected a value but found ${describe(token)}`,
      token.at,
    );
  };

  const power = (): FormulaNode => {
    const base = atom();
    const token = peek();
    if (!isSymbol(token, "^")) return base;
    position += 1;
    return { kind: "binary", op: "^", left: base, right: nested(token.at, unary), at: token.at };
  };

  const unary = (): FormulaNode => {
    const token = peek();
    if (isSymbol(token, "-", "+", "!")) {
      position += 1;
      const operand = nested(token.at, unary);
      return {
        kind: "unary",
        op: (token as { text: "-" | "+" | "!" }).text,
        operand,
        at: token.at,
      };
    }
    return power();
  };

  const product = binaryLevel(["*", "/"], unary);
  const sum = binaryLevel(["+", "-"], product);
  const comparison = binaryLevel(["<", "<=", ">", ">="], sum);
  const equality = binaryLevel(["==", "!="], comparison);
  const logicalAnd = binaryLevel(["&&"], equality);
  const logicalOr = binaryLevel(["||"], logicalAnd);

  if (peek().kind === "end") throw new FormulaError("The formula is empty", 0);
  const root = expression();
  const last = peek();
  if (last.kind !== "end") {
    throw new FormulaError(`Expected an operator but found ${describe(last)}`, last.at);
  }
  const result: ParsedFormula = {
    root,
    inputs: [...new Set(references.map((reference) => reference.name))],
    references,
  };
  if (parsed.size > 200) parsed.clear();
  parsed.set(text, result);
  return result;
}

/** Formulas already read, by text: recomputing reads the same few again and again. */
const parsed = new Map<string, ParsedFormula>();

/** A wave's name as written in a formula: as it is when it can be, else in quotes. */
export function formulaName(name: string): string {
  return WHOLE_NAME.test(name) && !RESERVED.has(name) ? name : `'${name}'`;
}

/**
 * The formula with its waves renamed: only the names change, so the rest
 * stays as it was typed. Text that is not a formula comes back as it is.
 */
export function renameInFormula(text: string, rename: (name: string) => string): string {
  let references: ParsedFormula["references"];
  try {
    references = parseFormula(text).references;
  } catch {
    return text;
  }
  let result = text;
  for (const reference of [...references].reverse()) {
    const name = rename(reference.name);
    if (name === reference.name) continue;
    // A bare path just before ":" would run into what follows it.
    const written =
      reference.quoted || text[reference.end] === ":" ? `'${name}'` : formulaName(name);
    result = result.slice(0, reference.at) + written + result.slice(reference.end);
  }
  return result;
}

/** What evaluating a formula gives. */
export interface FormulaOutcome {
  readonly values: Float64Array;
  /** The X scaling of the result: that of its waves, or of the target when it names none. */
  readonly x0: number;
  readonly dx: number;
  readonly xUnit: string;
  readonly zeroDivisions: number;
  /** The revision of each wave it read. */
  readonly inputs: Dict<number | null>;
}

/** Whether two waves have the same X at every point, to a millionth of a step. */
function sameX(a: Wave, b: { x0: number; dx: number }, points: number): boolean {
  const step = Math.max(Math.abs(a.dx), Math.abs(b.dx));
  const tolerance = step * 1e-6;
  return (
    Math.abs(a.x0 - b.x0) <= tolerance &&
    Math.abs(a.dx - b.dx) * Math.max(points - 1, 1) <= tolerance
  );
}

/** Checks that a wave can take part in a formula; `role` says how it is named in messages. */
function checkPlain(wave: Wave, at: number, role: string): void {
  if (wave.text) throw new FormulaError(`${role} ${wave.name} is a text wave`, at);
  if (wave.imag) throw new FormulaError(`${role} ${wave.name} is complex`, at);
  if (wave.shape.length !== 1) {
    throw new FormulaError(
      `${role} ${wave.name} has ${wave.shape.length} dimensions; formulas work on 1-D waves`,
      at,
    );
  }
}

/**
 * Throws if giving `target` this formula would make waves depend on
 * themselves: the target among its own inputs, or reached from them through
 * the formulas of other waves.
 */
export function checkCycle(state: DocState, target: string, formula: ParsedFormula): void {
  const seen = new Set<string>();
  const reaches = (name: string): boolean => {
    if (name === target) return true;
    if (seen.has(name)) return false;
    seen.add(name);
    const inputs = state.waves[name]?.formula?.inputs;
    return inputs ? Object.keys(inputs).some(reaches) : false;
  };
  for (const reference of formula.references) {
    if (reference.name === target) {
      throw new FormulaError(`${target} cannot be computed from itself`, reference.at);
    }
    if (reaches(reference.name)) {
      throw new FormulaError(
        `${reference.name} is computed from ${target}, which would then be computed from it`,
        reference.at,
      );
    }
  }
}

type Compiled = (point: number) => number;

/**
 * Computes a formula for `target` from the document as it is, without
 * changing anything. The waves it names must be numeric, real and 1-D,
 * with the same number of points and the same X scaling (nothing is
 * interpolated); the result has their length and scaling. An existing
 * target must have the same X scaling. A formula that names no wave takes
 * the target's points and scaling. Division by zero gives NaN and is
 * counted; NaN goes through everything but isnan().
 */
export function evaluateFormula(
  state: DocState,
  target: string,
  formula: string | ParsedFormula,
): FormulaOutcome {
  const parsedFormula = typeof formula === "string" ? parseFormula(formula) : formula;
  const inputs = dict<number | null>();
  const arrays = new Map<string, ArrayLike<number>>();
  let reference: { wave: Wave; at: number } | null = null;
  for (const { name, at } of parsedFormula.references) {
    if (arrays.has(name)) continue;
    const wave = state.waves[name];
    if (!wave) throw new FormulaError(`Missing input: there is no wave named ${name}`, at);
    checkPlain(wave, at, "Input");
    if (reference) {
      const first = reference.wave;
      if (wave.data.length !== first.data.length) {
        throw new FormulaError(
          `${name} has ${wave.data.length} points but ${first.name} has ${first.data.length}`,
          at,
        );
      }
      if (!sameX(wave, first, first.data.length)) {
        throw new FormulaError(
          `${name} has other X values than ${first.name} (x0 ${wave.x0} and ${first.x0}, dx ${wave.dx} and ${first.dx}); nothing is interpolated`,
          at,
        );
      }
    } else {
      reference = { wave, at };
    }
    inputs[name] = wave.rev;
    arrays.set(name, wave.data);
  }
  const existing = state.waves[target];
  if (existing) checkPlain(existing, 0, "The target");
  let points: number;
  let scale: { x0: number; dx: number; xUnit: string };
  if (reference) {
    const first = reference.wave;
    points = first.data.length;
    scale = { x0: first.x0, dx: first.dx, xUnit: first.xUnit };
    if (existing && !sameX(first, existing, points)) {
      throw new FormulaError(
        `${target} has other X values than ${first.name} (x0 ${existing.x0} and ${first.x0}, dx ${existing.dx} and ${first.dx}); change its scaling first`,
        reference.at,
      );
    }
  } else if (existing) {
    points = existing.data.length;
    scale = { x0: existing.x0, dx: existing.dx, xUnit: existing.xUnit };
  } else {
    throw new FormulaError(
      `The formula names no wave, so it cannot tell how many points ${target} should have. Make ${target} first`,
      0,
    );
  }
  const counter = { zero: 0 };
  const run = compile(parsedFormula.root, arrays, scale, counter);
  const values = new Float64Array(points);
  for (let point = 0; point < points; point += 1) values[point] = run(point);
  return { values, ...scale, zeroDivisions: counter.zero, inputs };
}

const isNaN = (value: number): boolean => value !== value;
const truth = (value: number): number => (isNaN(value) ? Number.NaN : value !== 0 ? 1 : 0);

/** Turns the tree into a function of the point number, so each point costs no reading of the tree. */
function compile(
  node: FormulaNode,
  arrays: ReadonlyMap<string, ArrayLike<number>>,
  scale: { x0: number; dx: number },
  counter: { zero: number },
): Compiled {
  const again = (child: FormulaNode) => compile(child, arrays, scale, counter);
  switch (node.kind) {
    case "number": {
      const { value } = node;
      return () => value;
    }
    case "wave": {
      const data = arrays.get(node.name)!;
      return (point) => data[point]!;
    }
    case "point":
      return (point) => point;
    case "x": {
      const { x0, dx } = scale;
      return (point) => x0 + point * dx;
    }
    case "unary": {
      const operand = again(node.operand);
      if (node.op === "-") return (point) => -operand(point);
      if (node.op === "+") return operand;
      return (point) => {
        const value = operand(point);
        return isNaN(value) ? Number.NaN : value === 0 ? 1 : 0;
      };
    }
    case "choice": {
      const test = again(node.test);
      const ifTrue = again(node.ifTrue);
      const ifFalse = again(node.ifFalse);
      // Only the branch taken is computed, so its divisions alone are counted.
      return (point) => {
        const value = test(point);
        return isNaN(value) ? Number.NaN : value !== 0 ? ifTrue(point) : ifFalse(point);
      };
    }
    case "call": {
      const fn = FUNCTIONS[node.name]!.apply;
      const args = node.args.map(again);
      if (args.length === 1) {
        const [only] = args as [Compiled];
        return (point) => fn(only(point));
      }
      if (args.length === 2) {
        const [first, second] = args as [Compiled, Compiled];
        return (point) => fn(first(point), second(point));
      }
      return (point) => fn(...args.map((arg) => arg(point)));
    }
    case "binary": {
      const left = again(node.left);
      const right = again(node.right);
      switch (node.op) {
        case "+":
          return (point) => left(point) + right(point);
        case "-":
          return (point) => left(point) - right(point);
        case "*":
          return (point) => left(point) * right(point);
        case "/":
          return (point) => {
            const divisor = right(point);
            const dividend = left(point);
            if (divisor === 0) {
              counter.zero += 1;
              return Number.NaN;
            }
            return dividend / divisor;
          };
        case "^":
          return (point) => left(point) ** right(point);
        case "&&":
          return (point) => {
            const first = truth(left(point));
            return first === 1 ? truth(right(point)) : first;
          };
        case "||":
          return (point) => {
            const first = truth(left(point));
            return first === 0 ? truth(right(point)) : first;
          };
        default: {
          // A comparison: 1 or 0, and NaN when either side is NaN, so that a
          // missing value is not taken for a false one.
          const compare = COMPARISONS[node.op]!;
          return (point) => {
            const a = left(point);
            const b = right(point);
            return isNaN(a) || isNaN(b) ? Number.NaN : compare(a, b) ? 1 : 0;
          };
        }
      }
    }
  }
}

const COMPARISONS: Readonly<Record<string, (a: number, b: number) => boolean>> = {
  "<": (a, b) => a < b,
  "<=": (a, b) => a <= b,
  ">": (a, b) => a > b,
  ">=": (a, b) => a >= b,
  "==": (a, b) => a === b,
  "!=": (a, b) => a !== b,
};

/** Whether a formula's values are those its inputs give now, as far as it was last told. */
export function formulaCurrent(state: DocState, name: string, formula: Formula): boolean {
  if (state.waves[name]?.rev !== formula.rev) return false;
  for (const [input, rev] of Object.entries(formula.inputs)) {
    if ((state.waves[input]?.rev ?? null) !== rev) return false;
  }
  return true;
}

export type FormulaStatus = "ok" | "stale" | "error" | "missing";

/**
 * How a wave's formula stands, for showing: "missing" when one of its waves
 * does not exist, "error" when the last computation failed, "stale" when a
 * manual formula's inputs (or the wave itself) changed since it was
 * computed, "ok" otherwise.
 */
export function formulaStatus(
  state: DocState,
  name: string,
  formula: Formula,
): { status: FormulaStatus; message: string } {
  const missing = Object.keys(formula.inputs).filter((input) => !(input in state.waves));
  if (missing.length > 0) {
    return {
      status: "missing",
      message: `Missing input: ${missing.join(", ")} ${missing.length === 1 ? "does" : "do"} not exist.`,
    };
  }
  if (formula.error !== null) return { status: "error", message: formula.error };
  if (!formulaCurrent(state, name, formula)) {
    return { status: "stale", message: "Out of date: recalculate to compute it again." };
  }
  return { status: "ok", message: formula.auto ? "Kept up to date." : "Up to date." };
}

/**
 * The waves that have formulas, inputs before the waves computed from them.
 * Formulas never form a cycle when set; one read from a damaged file that
 * does is broken where it closes, so this always ends.
 */
export function formulaOrder(state: DocState): string[] {
  const order: string[] = [];
  const done = new Set<string>();
  const visit = (name: string) => {
    if (done.has(name)) return;
    done.add(name);
    const formula = state.waves[name]?.formula;
    if (!formula) return;
    for (const input of Object.keys(formula.inputs)) visit(input);
    order.push(name);
  };
  for (const name of state.waveOrder) visit(name);
  return order;
}
