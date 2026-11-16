const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The Python that drops variables from the namespace, run like a typed
 * command so that it is in the history: `del a, b`. A name that is not an
 * identifier (put there through globals()) is popped instead.
 */
export function dropCode(names: readonly string[]): string {
  const plain = names.filter((name) => IDENTIFIER.test(name));
  const odd = names.filter((name) => !IDENTIFIER.test(name));
  return [
    ...(plain.length > 0 ? [`del ${plain.join(", ")}`] : []),
    ...odd.map((name) => `globals().pop(${JSON.stringify(name)}, None)`),
  ].join("\n");
}
