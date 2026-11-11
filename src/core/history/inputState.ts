/**
 * Decides what the Enter key means in the command line: run the code, or
 * start a new line because the statement is not finished yet. This mirrors
 * the behaviour of the Python REPL without asking the interpreter.
 */
export function isCompleteInput(code: string): boolean {
  if (code.trim() === "") return false;

  let depth = 0;
  let quote: string | null = null;
  let lineContinues = false;
  for (let index = 0; index < code.length; index += 1) {
    const char = code[index]!;
    if (quote) {
      if (char === "\\") index += 1;
      else if (code.startsWith(quote, index)) {
        index += quote.length - 1;
        quote = null;
      } else if (char === "\n" && quote.length === 1) {
        // An unterminated single-quoted string: a syntax error, let Python say so.
        quote = null;
      }
      continue;
    }
    if (char === "#") {
      const end = code.indexOf("\n", index);
      index = end === -1 ? code.length : end - 1;
    } else if (char === '"' || char === "'") {
      quote = code.startsWith(char.repeat(3), index) ? char.repeat(3) : char;
      index += quote.length - 1;
    } else if ("([{".includes(char)) depth += 1;
    else if (")]}".includes(char)) depth = Math.max(0, depth - 1);
    else if (char === "\\" && (index === code.length - 1 || code[index + 1] === "\n")) {
      lineContinues = index === code.length - 1 || code.slice(index + 1).trim() === "";
    }
  }
  if (quote?.length === 3 || depth > 0 || lineContinues) return false;

  const lines = code.split("\n");
  const last = lines.at(-1)!;
  const lastCode = stripComment(last).trimEnd();
  if (lines.length === 1) return !lastCode.endsWith(":") && !lastCode.trimStart().startsWith("@");

  // A multi-line block runs once the user leaves an empty line at the end.
  if (last.trim() === "") return true;
  const isBlock = lines.some((line) => {
    const text = stripComment(line).trimEnd();
    return text.endsWith(":") || text.trimStart().startsWith("@");
  });
  if (!isBlock) return true;
  return false;
}

function stripComment(line: string): string {
  let quote: string | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "#") return line.slice(0, index);
  }
  return line;
}
