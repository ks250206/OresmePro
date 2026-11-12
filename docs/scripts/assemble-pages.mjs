import { cp, writeFile } from "node:fs/promises";

const docs = new URL("../dist/", import.meta.url);
const pages = new URL("../../.pages/", import.meta.url);

await cp(docs, new URL("docs/", pages), { recursive: true });
await writeFile(new URL(".nojekyll", pages), "");
