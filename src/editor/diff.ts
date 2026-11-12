import type { TextChange } from "./ruffSettings";

/** Lines with their line breaks, so that offsets are the sums of their lengths. */
function linesOf(text: string): string[] {
  return text === "" ? [] : text.split(/(?<=\n)/);
}

/**
 * The pairs of lines that stay, by Myers' algorithm, or null if the texts
 * differ in more than `limit` lines (then it is not worth the time).
 */
function matchingLines(a: readonly string[], b: readonly string[], limit: number) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= Math.min(max, limit); d += 1) {
    // What the furthest paths were before this round, for k from -d-1 to d+1.
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m);
    }
  }
  return null;
}

function backtrack(trace: readonly Int32Array[], n: number, m: number): [number, number][] {
  const pairs: [number, number][] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const before = trace[d]!;
    const at = (k: number) => before[k + d + 1]!;
    const k = x - y;
    const previousK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const previousX = at(previousK);
    const previousY = previousX - previousK;
    // The run of equal lines that followed this round's insertion or deletion.
    while (x > previousX && y > previousY) {
      x -= 1;
      y -= 1;
      pairs.push([x, y]);
    }
    x = previousX;
    y = previousY;
  }
  return pairs.reverse();
}

/**
 * The changes that turn `a` into `b`, as few and as small as is cheap to
 * find: lines that are the same are left alone, and within the lines that
 * change, what they start and end with in common is too. Applied as one
 * edit, they keep the cursor and the folds in the lines that did not change
 * where they were.
 */
export function diffText(a: string, b: string, limit = 1000): TextChange[] {
  if (a === b) return [];
  const linesA = linesOf(a);
  const linesB = linesOf(b);
  const pairs = matchingLines(linesA, linesB, limit);
  const hunks: [number, number, number, number][] = [];
  if (pairs === null) {
    hunks.push([0, linesA.length, 0, linesB.length]);
  } else {
    let lineA = 0;
    let lineB = 0;
    for (const [x, y] of [...pairs, [linesA.length, linesB.length] as [number, number]]) {
      if (x > lineA || y > lineB) hunks.push([lineA, x, lineB, y]);
      lineA = x + 1;
      lineB = y + 1;
    }
  }
  const startsA = [0];
  for (const line of linesA) startsA.push(startsA.at(-1)! + line.length);
  const startsB = [0];
  for (const line of linesB) startsB.push(startsB.at(-1)! + line.length);
  return hunks.map(([fromA, toA, fromB, toB]) => {
    let from = startsA[fromA]!;
    let to = startsA[toA]!;
    let insertFrom = startsB[fromB]!;
    let insertTo = startsB[toB]!;
    while (from < to && insertFrom < insertTo && a[from] === b[insertFrom]) {
      from += 1;
      insertFrom += 1;
    }
    while (to > from && insertTo > insertFrom && a[to - 1] === b[insertTo - 1]) {
      to -= 1;
      insertTo -= 1;
    }
    return { from, to, insert: b.slice(insertFrom, insertTo) };
  });
}
