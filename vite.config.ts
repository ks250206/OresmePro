import { createRequire } from "node:module";
import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// SharedArrayBuffer (used for the synchronous Python <-> document bridge and
// for interrupting Python) requires a cross-origin isolated page.
const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

/** Build output, downloaded packages and test reports: not ours to format or lint. */
const GENERATED = [
  "dist/**",
  "coverage/**",
  "public/pyodide/**",
  "test-results/**",
  "playwright-report/**",
];

const require = createRequire(import.meta.url);
const pyodideVersion = (require("pyodide/package.json") as { version: string }).version;

export default defineConfig({
  define: {
    // Names the service worker's caches: a new build lets go of the old one's files.
    __BUILD_ID__: JSON.stringify(Date.now().toString(36)),
    __PYODIDE_VERSION__: JSON.stringify(pyodideVersion),
  },
  staged: {
    "*": "vp check --fix",
  },
  fmt: { ignorePatterns: [...GENERATED] },
  lint: {
    ignorePatterns: [...GENERATED],
    options: { typeAware: true, typeCheck: true },
  },
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  // Tests import workbook fixtures as binary assets.
  assetsInclude: ["**/*.xlsx"],
  worker: { format: "es" },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "editor",
              test: /node_modules[\\/](?:@codemirror|@lezer|crelt|style-mod|w3c-keyname)[\\/]/,
            },
            { name: "react", test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/ },
          ],
        },
      },
    },
  },
  plugins: [react(), tailwindcss()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
