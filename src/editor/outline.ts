import { pythonLanguage } from "@codemirror/lang-python";

/** A node of the parsed file (the type @lezer/common exports, without depending on it). */
type SyntaxNode = ReturnType<typeof pythonLanguage.parser.parse>["topNode"];

/** A class or function of a procedure, with what is defined inside it. */
export interface OutlineItem {
  kind: "class" | "function";
  name: string;
  /** For a function, its parameters as written ("(x, y=1)"); for a class, its bases ("(Base)" or ""). */
  signature: string;
  /** For a function, what it is annotated to return (" -> float"), or "". */
  returns: string;
  /** The line it starts on, from 1 (its decorators' line when it has some). */
  line: number;
  children: OutlineItem[];
}

/**
 * The classes and functions of a file of Python, nested as they are in it,
 * read with the editor's own parser: it needs no Python, and a file with
 * errors still gives what can be read of it.
 */
export function outlineOf(code: string): OutlineItem[] {
  const tree = pythonLanguage.parser.parse(code);
  const lineAt = (offset: number): number => {
    let line = 1;
    for (let index = code.indexOf("\n"); index !== -1 && index < offset;) {
      line += 1;
      index = code.indexOf("\n", index + 1);
    }
    return line;
  };
  const text = (node: SyntaxNode | null): string =>
    node ? code.slice(node.from, node.to).replace(/\s+/g, " ").trim() : "";

  const read = (parent: SyntaxNode): OutlineItem[] => {
    const items: OutlineItem[] = [];
    for (let node = parent.firstChild; node; node = node.nextSibling) {
      // A decorated definition starts at its first decorator.
      const decorated = node.name === "DecoratedStatement";
      const definition = decorated
        ? (node.getChild("FunctionDefinition") ?? node.getChild("ClassDefinition"))
        : node;
      if (definition?.name === "FunctionDefinition" || definition?.name === "ClassDefinition") {
        const isClass = definition.name === "ClassDefinition";
        const name = text(definition.getChild("VariableName"));
        if (!name) continue;
        const body = definition.getChild("Body");
        const returns = definition.getChild("TypeDef");
        items.push({
          kind: isClass ? "class" : "function",
          name,
          signature: text(definition.getChild(isClass ? "ArgList" : "ParamList")),
          returns: returns ? ` ${text(returns)}` : "",
          line: lineAt(node.from),
          children: body ? read(body) : [],
        });
      } else if (node.firstChild && node.name !== "Body") {
        // Definitions inside if, try, with and the like still belong to the level they are on.
        items.push(...read(node));
      } else if (node.name === "Body") {
        items.push(...read(node));
      }
    }
    return items;
  };
  return read(tree.topNode);
}
