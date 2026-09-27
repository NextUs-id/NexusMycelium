import { type Dirent, existsSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { EventBus, PluginEventMap } from "./events.js";
import { type PluginManifest, type PluginManifestInput, PluginManifestSchema } from "./manifest.js";
import type { PermissionGate } from "./permissions.js";
import type { PluginCapabilityReader, PluginServiceMap, PluginServices } from "./services.js";

export interface Logger {
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

export interface PluginContext<Services extends object = PluginServiceMap> {
  events: EventBus<PluginEventMap>;
  log: Logger;
  config: Record<string, unknown>;
  services: PluginServices<Services>;
  capabilities: PluginCapabilityReader<Services>;
  permissions: PermissionGate;
}

export type Disposer = () => void | Promise<void>;

export interface Plugin<Services extends object = PluginServiceMap> {
  readonly manifest: PluginManifest;
  setup(ctx: PluginContext<Services>): Disposer | undefined | Promise<Disposer | undefined>;
}

export interface PluginDefinition<Services extends object = PluginServiceMap> {
  manifest: PluginManifestInput;
  setup: Plugin<Services>["setup"];
}

/** Rotating `cacheKey` re-evaluates the entry; omitted keeps the plain ESM module cache. */
export interface PluginCacheOptions {
  cacheKey?: string | number;
}

export interface PluginDiscoveryError {
  directory: string;
  error: Error;
}

export interface PluginDiscoveryResult {
  plugins: Plugin[];
  errors: PluginDiscoveryError[];
}

export interface PluginModule {
  default: Plugin;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePlugin<Services extends object = PluginServiceMap>(
  value: unknown,
  source: string,
): Plugin<Services> {
  if (!isRecord(value)) throw new Error(`plugin must be an object: ${source}`);
  if (typeof value.setup !== "function") throw new Error(`plugin setup must be a function: ${source}`);
  let manifest: PluginManifest;
  try {
    manifest = PluginManifestSchema.parse(value.manifest) as PluginManifest;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid plugin manifest from ${source}: ${detail}`, { cause: error });
  }
  return { manifest, setup: value.setup as Plugin<Services>["setup"] };
}

export function definePlugin<Services extends object = PluginServiceMap>(
  def: PluginDefinition<Services>,
): Plugin<Services> {
  return normalizePlugin<Services>(def, "definition");
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

const officialPluginDirectory = fileURLToPath(new URL("../../plugins/", import.meta.url));

function inside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

async function officialPluginRoot(): Promise<string> {
  return realpath(officialPluginDirectory);
}

const CACHE_QUERY = "nexusCache";
const CACHE_TOKEN = /^[A-Za-z0-9._-]{1,128}$/;

function cacheToken(value: string | number): string {
  const token = String(value);
  if (!CACHE_TOKEN.test(token)) throw new Error(`invalid plugin cache key: ${token}`);
  return token;
}

/** The query is cache-only, so every token is validated before it is re-attached to the import. */
function validatedQuery(url: URL): URLSearchParams {
  const query = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    if (!CACHE_TOKEN.test(key) || !CACHE_TOKEN.test(value)) {
      throw new Error(`invalid plugin query token: ${key}=${value}`);
    }
    query.set(key, value);
  }
  return query;
}

interface TrustedEntry {
  url: URL;
  path: string;
}

async function trustedPluginEntry(
  specifier: string | URL,
  cacheKey?: string | number,
): Promise<TrustedEntry> {
  let spec: URL;
  try {
    spec = specifier instanceof URL ? specifier : new URL(specifier);
  } catch (error) {
    throw new Error(`invalid plugin URL: ${String(specifier)}`, { cause: error });
  }
  if (spec.protocol !== "file:") throw new Error("plugin path must use the file: protocol");
  const query = validatedQuery(spec);
  if (cacheKey !== undefined) query.set(CACHE_QUERY, cacheToken(cacheKey));
  const pathURL = new URL(spec.href);
  pathURL.search = "";
  pathURL.hash = "";
  const path = await realpath(fileURLToPath(pathURL));
  if (!inside(await officialPluginRoot(), path)) {
    throw new Error(`untrusted plugin path: ${path}`);
  }
  if (!(await stat(path)).isFile()) throw new Error(`plugin entry is not a file: ${path}`);
  const url = pathToFileURL(path);
  url.search = query.toString();
  return { url, path };
}

function pluginFromModule(value: unknown, source: string): Plugin {
  if (!isRecord(value) || !isRecord(value.default)) {
    throw new Error(`plugin module must default-export a plugin: ${source}`);
  }
  return normalizePlugin(value.default, source);
}

/** Official modules run in this process; the path allowlist is trust, not a sandbox. */
export async function loadPlugin(specifier: string | URL, options: PluginCacheOptions = {}): Promise<Plugin> {
  const entry = await trustedPluginEntry(specifier, options.cacheKey);
  return pluginFromModule((await import(entry.url.href)) as unknown, entry.path);
}

function packageTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  const root = value["."];
  if (typeof root === "string") return root;
  if (!isRecord(root)) return undefined;
  for (const condition of ["node", "import", "default"]) {
    const target = root[condition];
    if (typeof target === "string") return target;
  }
  return undefined;
}

function safeTarget(target: string): string {
  if (target.length === 0 || target.includes("\0") || !target.startsWith("./")) {
    throw new Error(`plugin export must be a safe relative path: ${target}`);
  }
  if (target.split(/[\\/]/).includes("..")) {
    throw new Error(`plugin export must stay inside its directory: ${target}`);
  }
  return target;
}

/** A compiled kernel prefers the built sibling; the source twin of the same name is the fallback. */
function entryCandidates(pluginDirectory: string, target: string): string[] {
  const safe = safeTarget(target);
  const sourceKernel = extname(fileURLToPath(import.meta.url)) === ".ts";
  const preferred = !sourceKernel && safe.endsWith(".ts") ? `${safe.slice(0, -3)}.js` : safe;
  const twin = preferred.endsWith(".ts")
    ? `${preferred.slice(0, -3)}.js`
    : preferred.endsWith(".js")
      ? `${preferred.slice(0, -3)}.ts`
      : "";
  return [...new Set([preferred, twin].filter(Boolean))].map((entry) => resolve(pluginDirectory, entry));
}

async function resolveEntryFile(pluginDirectory: string, target: string): Promise<string> {
  for (const candidate of entryCandidates(pluginDirectory, target)) {
    let canonical: string;
    try {
      canonical = await realpath(candidate);
    } catch (error) {
      if (hasCode(error, "ENOENT")) continue;
      throw new Error(`cannot read plugin entry ${candidate}`, { cause: error });
    }
    if (!inside(pluginDirectory, canonical)) {
      throw new Error(`plugin entry escapes its directory: ${target}`);
    }
    if (!(await stat(canonical)).isFile()) {
      throw new Error(`plugin entry is not a file: ${canonical}`);
    }
    return canonical;
  }
  throw new Error(`plugin entry not found: ${target} in ${pluginDirectory}`);
}

function compareBytewise(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

async function pluginEntryTarget(pluginDirectory: string, packagePath: string): Promise<string | undefined> {
  let source: string;
  try {
    const canonicalPackage = await realpath(packagePath);
    if (!inside(pluginDirectory, canonicalPackage)) {
      throw new Error(`plugin package escapes its directory: ${canonicalPackage}`);
    }
    source = await readFile(canonicalPackage, "utf8");
  } catch (error) {
    if (!hasCode(error, "ENOENT")) {
      throw new Error(`cannot read plugin package ${packagePath}`, { cause: error });
    }
    return ["./src/index.js", "./src/index.ts"].find((candidate) =>
      existsSync(resolve(pluginDirectory, candidate.slice(2))),
    );
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`invalid plugin package ${packagePath}`, { cause: error });
  }
  const target = isRecord(metadata) ? packageTarget(metadata.exports) : undefined;
  if (!target) throw new Error(`plugin package has no root export: ${packagePath}`);
  return target;
}

async function loadDiscoveredEntry(
  requestedRoot: string,
  entry: Dirent,
  cacheKey?: string | number,
): Promise<Plugin | undefined> {
  if (entry.isSymbolicLink()) throw new Error(`plugin directory cannot be a symlink: ${entry.name}`);
  const pluginDirectory = await realpath(resolve(requestedRoot, entry.name));
  if (!inside(requestedRoot, pluginDirectory)) {
    throw new Error(`plugin directory escapes the official path: ${entry.name}`);
  }
  const target = await pluginEntryTarget(pluginDirectory, resolve(pluginDirectory, "package.json"));
  if (!target) return undefined;
  return loadPlugin(pathToFileURL(await resolveEntryFile(pluginDirectory, target)), { cacheKey });
}

async function trustedPluginRoot(directory: string | URL): Promise<string> {
  const requestedRoot = await realpath(
    directory instanceof URL ? fileURLToPath(directory) : resolve(directory),
  );
  const officialRoot = await officialPluginRoot();
  if (resolve(requestedRoot) !== resolve(officialRoot)) {
    throw new Error(`plugin directory is not the official trusted path: ${requestedRoot}`);
  }
  return requestedRoot;
}

/** Root trust stays fail-closed; `isolateFailures` only downgrades per-plugin failures. */
export function discoverPlugins(directory: string | URL, options?: PluginCacheOptions): Promise<Plugin[]>;
export function discoverPlugins(
  directory: string | URL,
  options: PluginCacheOptions & { isolateFailures: true },
): Promise<PluginDiscoveryResult>;
export async function discoverPlugins(
  directory: string | URL,
  options: PluginCacheOptions & { isolateFailures?: boolean } = {},
): Promise<Plugin[] | PluginDiscoveryResult> {
  const requestedRoot = await trustedPluginRoot(directory);
  const entries = (await readdir(requestedRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .sort((left, right) => compareBytewise(left.name, right.name));
  const plugins: Plugin[] = [];
  const errors: PluginDiscoveryError[] = [];
  for (const entry of entries) {
    try {
      const plugin = await loadDiscoveredEntry(requestedRoot, entry, options.cacheKey);
      if (plugin) plugins.push(plugin);
    } catch (error) {
      if (!options.isolateFailures) throw error;
      errors.push({
        directory: entry.name,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  return options.isolateFailures ? { plugins, errors } : plugins;
}
