import type { ParamSpec, ParamType } from "../actions";
import { DocError, type ErrorCode } from "../doc/types";

/**
 * A plugin's description of itself: oresme-plugin.json at the root of its
 * package. It lists every file of the package, the actions the plugin's
 * Python provides (with their arguments, so they can be shown and checked
 * before any of its code runs) and what it contributes as data: panels,
 * templates, graph templates and styles.
 *
 * Everything here is read from a file the app does not trust, so it is
 * checked field by field and refused whole when anything is off.
 */

export const MANIFEST_FILE = "oresme-plugin.json";

/** A plugin, its package or a call of its action is refused: PLUGIN_FAILED unless said otherwise. */
export class PluginError extends DocError {
  constructor(
    message: string,
    code: ErrorCode = "PLUGIN_FAILED",
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message, code, details);
    this.name = "PluginError";
  }
}

/** What a package may hold at most. */
export const PACKAGE_LIMITS = {
  manifestBytes: 256 * 1024,
  files: 256,
  fileBytes: 8 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
  actions: 64,
  pathLength: 200,
  pathDepth: 8,
} as const;

export interface PluginAction {
  /** Short name; its id in the app is `plugin.<plugin name>.<name>`. */
  name: string;
  title: string;
  description: string;
  /** Arguments as the app's own actions describe theirs; wave and waves are the inputs. */
  params: Record<string, ParamSpec>;
}

export interface PluginFileEntry {
  path: string;
  /** The SHA-256 the author gives, in hex; checked when given. */
  sha256: string | null;
}

export const CONTRIBUTION_KINDS = ["panels", "templates", "graphTemplates", "styles"] as const;
export type ContributionKind = (typeof CONTRIBUTION_KINDS)[number];

export interface PluginManifest {
  manifestVersion: 1;
  /** Unique among the plugins of a browser; the middle part of its action ids. */
  name: string;
  title: string;
  version: string;
  description: string;
  license: string;
  /** Present when the plugin has code: the module that registers its actions, and the packages it uses. */
  python: { entry: string; packages: string[] } | null;
  files: PluginFileEntry[];
  actions: PluginAction[];
  contributes: Record<ContributionKind, string[]>;
}

const NAME = /^[a-z][a-z0-9_]{0,39}$/;
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const MODULE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const PACKAGE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PARAM_TYPES: readonly ParamType[] = [
  "wave",
  "waves",
  "number",
  "integer",
  "string",
  "boolean",
  "choice",
  "numbers",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function text(value: unknown, what: string, limit = 200, optional = false): string {
  if (value === undefined && optional) return "";
  if (typeof value !== "string") throw new PluginError(`${what} must be text.`);
  if (value.length > limit) throw new PluginError(`${what} is longer than ${limit} characters.`);
  return value;
}

/**
 * Checks a path inside a package: relative, with plain segments (none that
 * starts with a dot, so no "..", and no backslashes), not too long or deep.
 */
export function checkPath(path: unknown, what = "A file path"): string {
  if (typeof path !== "string" || path.length === 0) throw new PluginError(`${what} is empty.`);
  if (path.length > PACKAGE_LIMITS.pathLength) {
    throw new PluginError(`${what} is longer than ${PACKAGE_LIMITS.pathLength} characters.`);
  }
  const segments = path.split("/");
  if (segments.length > PACKAGE_LIMITS.pathDepth || !segments.every((part) => SEGMENT.test(part))) {
    throw new PluginError(
      `${what} ${JSON.stringify(path.slice(0, 80))} is not a plain relative path.`,
    );
  }
  return path;
}

function param(value: unknown, where: string): ParamSpec {
  if (!isRecord(value)) throw new PluginError(`${where} is not described.`);
  const type = value.type;
  if (typeof type !== "string" || !(PARAM_TYPES as readonly string[]).includes(type)) {
    throw new PluginError(`${where} has an unknown type.`);
  }
  const spec: ParamSpec = {
    type: type as ParamType,
    optional: value.optional === true || value.default !== undefined,
  };
  if (value.title !== undefined) spec.title = text(value.title, `The title of ${where}`);
  if (value.description !== undefined) {
    spec.description = text(value.description, `The description of ${where}`, 2000);
  }
  if (value.default !== undefined) {
    const given = value.default;
    if (
      given !== null &&
      !["string", "number", "boolean"].includes(typeof given) &&
      !Array.isArray(given)
    ) {
      throw new PluginError(`The default of ${where} is not a plain value.`);
    }
    spec.default = given as ParamSpec["default"];
  }
  if (type === "choice") {
    const choices = value.choices;
    if (
      !Array.isArray(choices) ||
      choices.length === 0 ||
      choices.length > 100 ||
      !choices.every((item) => typeof item === "string" || typeof item === "number")
    ) {
      throw new PluginError(`${where} must list its choices.`);
    }
    spec.choices = [...(choices as (string | number)[])];
  }
  for (const key of ["min", "max", "length"] as const) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "number" || !Number.isFinite(value[key])) {
      throw new PluginError(`The ${key} of ${where} is not a number.`);
    }
    spec[key] = value[key];
  }
  if (value.text !== undefined) {
    if (type !== "wave" && type !== "waves") {
      throw new PluginError(`${where} is not a wave, so it cannot take text waves.`);
    }
    if (typeof value.text !== "boolean") {
      throw new PluginError(`The text of ${where} is not true or false.`);
    }
    if (value.text) spec.text = true;
  }
  return spec;
}

function action(value: unknown, index: number): PluginAction {
  if (!isRecord(value)) throw new PluginError(`Action ${index + 1} is not described.`);
  const name = text(value.name, `The name of action ${index + 1}`, 40);
  if (!NAME.test(name)) {
    throw new PluginError(`${JSON.stringify(name)} is not a usable action name (a-z, 0-9 and _).`);
  }
  const params: Record<string, ParamSpec> = Object.create(null) as Record<string, ParamSpec>;
  const given = value.params ?? {};
  if (!isRecord(given)) throw new PluginError(`The arguments of ${name} are not described.`);
  for (const key of Object.keys(given)) {
    if (!NAME.test(key))
      throw new PluginError(`${JSON.stringify(key)} is not a usable argument name.`);
    params[key] = param(given[key], `argument ${key} of ${name}`);
  }
  return {
    name,
    title: text(value.title, `The title of ${name}`),
    description: text(value.description, `The description of ${name}`, 4000, true),
    params,
  };
}

/** Reads and checks a manifest from its bytes. */
export function parseManifest(bytes: Uint8Array): PluginManifest {
  if (bytes.byteLength > PACKAGE_LIMITS.manifestBytes) {
    throw new PluginError(
      `${MANIFEST_FILE} is larger than ${PACKAGE_LIMITS.manifestBytes / 1024} KiB.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new PluginError(`${MANIFEST_FILE} is not valid JSON.`);
  }
  if (!isRecord(raw)) throw new PluginError(`${MANIFEST_FILE} is not an object.`);
  if (raw.manifestVersion !== 1) {
    throw new PluginError(
      `${MANIFEST_FILE} is of a version this app does not know (manifestVersion).`,
    );
  }
  const name = text(raw.name, "The plugin's name", 40);
  if (!NAME.test(name)) {
    throw new PluginError(`${JSON.stringify(name)} is not a usable plugin name (a-z, 0-9 and _).`);
  }

  if (!Array.isArray(raw.files)) throw new PluginError(`${MANIFEST_FILE} must list its files.`);
  if (raw.files.length > PACKAGE_LIMITS.files) {
    throw new PluginError(`A plugin may have at most ${PACKAGE_LIMITS.files} files.`);
  }
  const seen = new Set<string>();
  const files = raw.files.map((entry): PluginFileEntry => {
    const path = checkPath(isRecord(entry) ? entry.path : entry);
    if (path === MANIFEST_FILE) throw new PluginError(`${MANIFEST_FILE} does not list itself.`);
    // Case is ignored: some file systems would make two such files one.
    const folded = path.toLowerCase();
    if (seen.has(folded)) throw new PluginError(`${path} is listed twice.`);
    seen.add(folded);
    let sha256: string | null = null;
    if (isRecord(entry) && entry.sha256 !== undefined) {
      if (typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256)) {
        throw new PluginError(`The SHA-256 of ${path} is not 64 hex digits.`);
      }
      sha256 = entry.sha256;
    }
    return { path, sha256 };
  });
  const listed = (path: unknown, what: string): string => {
    const checked = checkPath(path, what);
    if (!seen.has(checked.toLowerCase()))
      throw new PluginError(`${checked} is not among the files.`);
    return checked;
  };

  let python: PluginManifest["python"] = null;
  if (raw.python !== undefined && raw.python !== null) {
    if (!isRecord(raw.python)) throw new PluginError("python is not described.");
    const entry = text(raw.python.entry, "The Python entry module", 100);
    if (!MODULE.test(entry))
      throw new PluginError(`${JSON.stringify(entry)} is not a module name.`);
    const base = entry.replaceAll(".", "/");
    if (!seen.has(`${base}.py`.toLowerCase()) && !seen.has(`${base}/__init__.py`.toLowerCase())) {
      throw new PluginError(`The entry module ${entry} is not among the files.`);
    }
    const packages = raw.python.packages ?? [];
    if (
      !Array.isArray(packages) ||
      !packages.every((item) => typeof item === "string" && PACKAGE.test(item))
    ) {
      throw new PluginError("python.packages must be a list of package names.");
    }
    python = { entry, packages: [...new Set(packages as string[])] };
  }

  const actionsRaw = raw.actions ?? [];
  if (!Array.isArray(actionsRaw)) throw new PluginError("actions must be a list.");
  if (actionsRaw.length > PACKAGE_LIMITS.actions) {
    throw new PluginError(`A plugin may have at most ${PACKAGE_LIMITS.actions} actions.`);
  }
  const actions = actionsRaw.map(action);
  if (new Set(actions.map((item) => item.name)).size !== actions.length) {
    throw new PluginError("Two actions have the same name.");
  }
  if (actions.length > 0 && !python) {
    throw new PluginError("A plugin with actions must name its Python entry module.");
  }

  const contributes = Object.fromEntries(
    CONTRIBUTION_KINDS.map((kind) => [kind, [] as string[]]),
  ) as Record<ContributionKind, string[]>;
  if (raw.contributes !== undefined) {
    if (!isRecord(raw.contributes)) throw new PluginError("contributes is not described.");
    for (const key of Object.keys(raw.contributes)) {
      if (!(CONTRIBUTION_KINDS as readonly string[]).includes(key)) {
        throw new PluginError(`contributes has an unknown kind ${JSON.stringify(key)}.`);
      }
      const paths = raw.contributes[key];
      if (!Array.isArray(paths))
        throw new PluginError(`contributes.${key} must be a list of files.`);
      contributes[key as ContributionKind] = paths.map((path) =>
        listed(path, `A file of contributes.${key}`),
      );
    }
  }

  return {
    manifestVersion: 1,
    name,
    title: text(raw.title ?? name, "The plugin's title"),
    version: text(raw.version, "The plugin's version", 40),
    description: text(raw.description, "The plugin's description", 4000, true),
    license: text(raw.license, "The plugin's license", 100, true),
    python,
    files,
    actions,
    contributes,
  };
}

/** The id an action of a plugin has in the app. */
export const pluginActionId = (plugin: string, action: string): string =>
  `plugin.${plugin}.${action}`;

/** The plugin and action of a plugin action id, or null. */
export function splitPluginActionId(id: string): { plugin: string; action: string } | null {
  const match = /^plugin\.([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)$/.exec(id);
  return match ? { plugin: match[1]!, action: match[2]! } : null;
}

/** Where a plugin was installed from. */
export type PluginSource =
  | { kind: "github"; owner: string; repo: string; ref: string; path: string }
  | { kind: "local"; label: string };

const GITHUB_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;

/**
 * Reads a GitHub address: `https://github.com/owner/repo`, optionally
 * followed by `/tree/<ref>/<folder>`. A ref or folder given separately wins.
 * A ref that contains a slash cannot be told from a folder in the address,
 * so the address is read with the first segment as the ref; the separate
 * fields are there to say otherwise.
 */
export function parseGitHubSource(
  address: string,
  ref?: string,
  path?: string,
): Extract<PluginSource, { kind: "github" }> {
  let url: URL;
  try {
    url = new URL(address.trim().replace(/\.git$/, ""));
  } catch {
    throw new PluginError("That is not a web address.");
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    throw new PluginError("Plugins are installed from https://github.com/… addresses.");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const [owner, repo, tree, refInUrl, ...rest] = parts;
  if (!owner || !repo || !GITHUB_NAME.test(owner) || !GITHUB_NAME.test(repo)) {
    throw new PluginError("The address must name an owner and a repository.");
  }
  if (tree !== undefined && tree !== "tree") {
    throw new PluginError("The address must point at a repository or a folder in it (…/tree/…).");
  }
  const givenRef = ref?.trim() || refInUrl || "HEAD";
  if (
    !/^[A-Za-z0-9._/-]{1,200}$/.test(givenRef) ||
    givenRef.split("/").some((part) => part.startsWith("."))
  ) {
    throw new PluginError("The branch, tag or commit is not usable.");
  }
  const folder = (path?.trim() ?? rest.join("/")).replace(/^\/+|\/+$/g, "");
  if (folder) checkPath(folder, "The folder");
  return { kind: "github", owner, repo, ref: givenRef, path: folder };
}

/** A short text for where a plugin came from, as shown and as kept with results. */
export function describeSource(source: PluginSource): string {
  if (source.kind === "local") return `local:${source.label}`;
  const folder = source.path ? `/${source.path}` : "";
  return `github:${source.owner}/${source.repo}${folder}`;
}
