import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Permission } from "./manifest.js";
import type { PermissionPolicy } from "./permissions.js";

const unsafeConfigurationKeys = new Set(["__proto__", "prototype", "constructor"]);
const pluginNameSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be a canonical kebab-case plugin name");

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

const safeTextSchema = z
  .string()
  .min(1)
  .refine(
    (value) => value.trim() === value && !value.includes("\0") && !hasControlCharacter(value),
    "must be non-empty text without NUL, control characters, or surrounding whitespace",
  );
const httpUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
    } catch {
      return false;
    }
  }, "must be an HTTP(S) URL without embedded credentials");

const PermissionPolicySchema = z.enum(["allow", "ask", "deny"]);
const modelFields = {
  provider: z.enum(["mock", "openai"]),
  model: safeTextSchema,
  baseUrl: httpUrlSchema,
  timeoutMs: z.number().int().min(100).max(120000),
};
const modelSecretPathSchema = safeTextSchema.refine((value) => {
  const parts = value.split("/").slice(isAbsolute(value) ? 1 : 0);
  const userIndex = parts.lastIndexOf("user");
  const validSegments = parts.every((part) => part.length > 0 && part !== "." && part !== "..");
  const validRoot = isAbsolute(value) || parts[0] === "user";
  return (
    !value.includes("\\") &&
    validSegments &&
    validRoot &&
    userIndex >= 0 &&
    parts.length > userIndex + 2 &&
    (parts[userIndex + 1] === "secrets" || parts[userIndex + 1] === "providers") &&
    parts[userIndex + 2] !== undefined
  );
}, "must be a file under user/secrets or user/providers");
const modelPrefixSchema = z.array(safeTextSchema).min(1);
const ModelConfigSchema = z
  .object({
    provider: modelFields.provider.default("mock"),
    model: modelFields.model.default("mock"),
    baseUrl: modelFields.baseUrl.default("https://api.openai.com/v1"),
    timeoutMs: modelFields.timeoutMs.default(5000),
    apiKeyFile: modelSecretPathSchema.optional(),
    allowedModelPrefixes: modelPrefixSchema.optional(),
  })
  .strict();
const ModelOverlaySchema = z
  .object({
    provider: modelFields.provider.optional(),
    model: modelFields.model.optional(),
    baseUrl: modelFields.baseUrl.optional(),
    timeoutMs: modelFields.timeoutMs.optional(),
    apiKeyFile: modelSecretPathSchema.optional(),
    allowedModelPrefixes: modelPrefixSchema.optional(),
  })
  .strict();
const agentFields = {
  maxSteps: z.number().int().min(1).max(50),
  maxToolCalls: z.number().int().min(1).max(100),
  timeoutMs: z.number().int().min(100).max(120000),
};
const AgentConfigSchema = z
  .object({
    maxSteps: agentFields.maxSteps.default(8),
    maxToolCalls: agentFields.maxToolCalls.default(12),
    timeoutMs: agentFields.timeoutMs.default(15000),
  })
  .strict();
const AgentOverlaySchema = z
  .object({
    maxSteps: agentFields.maxSteps.optional(),
    maxToolCalls: agentFields.maxToolCalls.optional(),
    timeoutMs: agentFields.timeoutMs.optional(),
  })
  .strict();
/**
 * A budget cap is either a positive number or `null` for "no cap on this dimension" — never
 * `Infinity`, so a runtime can tell unbounded apart from a real number without inventing one.
 */
const budgetFields = {
  maxTotalTokens: z.number().int().positive(),
  maxCostUsd: z.number().positive(),
  maxElapsedMs: z.number().int().positive(),
};
/**
 * One model's price, in the kernel's own units and field names, so the config layer never has to
 * translate a price before an enforcement path can read it. Both sides are required and positive:
 * a missing or zero side would price a whole dimension as free and leave the cap looking enforced.
 */
const BudgetPriceSchema = z
  .object({
    inputUsdPerMillionTokens: z.number().positive(),
    outputUsdPerMillionTokens: z.number().positive(),
  })
  .strict();
/** Keyed by the exact model identity a run is billed under; the kernel matches it by exact key. */
const BudgetPricesSchema = z.record(safeTextSchema, BudgetPriceSchema);
const BudgetConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    maxTotalTokens: budgetFields.maxTotalTokens.nullable().default(null),
    maxCostUsd: budgetFields.maxCostUsd.nullable().default(null),
    maxElapsedMs: budgetFields.maxElapsedMs.nullable().default(null),
    prices: BudgetPricesSchema.nullable().default(null),
  })
  .strict();
const BudgetOverlaySchema = z
  .object({
    enabled: z.boolean().optional(),
    maxTotalTokens: budgetFields.maxTotalTokens.nullable().optional(),
    maxCostUsd: budgetFields.maxCostUsd.nullable().optional(),
    maxElapsedMs: budgetFields.maxElapsedMs.nullable().optional(),
    prices: BudgetPricesSchema.nullable().optional(),
  })
  .strict();
/**
 * Trace is a debugging aid, not an archive: 1 MiB by default and 64x that as a hard ceiling, so an
 * enabled trace can never grow without bound. The block carries no path, directory, or secret
 * field — where a trace lands is the writer's business, config only says whether to write and how
 * much to keep — and an absent block resolves to off, so nothing is written until it is asked for.
 */
export const DEFAULT_TRACE_MAX_BYTES = 1_048_576;
/** The hard bound on the cap. Exported so the writer enforces the same one instead of a second number. */
export const MAX_TRACE_MAX_BYTES = DEFAULT_TRACE_MAX_BYTES * 64;
const traceFields = {
  maxBytes: z.number().int().min(1).max(MAX_TRACE_MAX_BYTES),
};
const TraceConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    maxBytes: traceFields.maxBytes.default(DEFAULT_TRACE_MAX_BYTES),
  })
  .strict();
const TraceOverlaySchema = z
  .object({
    enabled: z.boolean().optional(),
    maxBytes: traceFields.maxBytes.optional(),
  })
  .strict();
const shellFields = {
  allow: z.array(safeTextSchema),
  deny: z.array(safeTextSchema),
  timeoutMs: z.number().int().min(100).max(30000),
};
const ShellConfigSchema = z
  .object({
    allow: shellFields.allow.default([]),
    deny: shellFields.deny.default([]),
    timeoutMs: shellFields.timeoutMs.default(5000),
  })
  .strict();
const ShellOverlaySchema = z
  .object({
    allow: shellFields.allow.optional(),
    deny: shellFields.deny.optional(),
    timeoutMs: shellFields.timeoutMs.optional(),
  })
  .strict();
const toolsFields = {
  root: safeTextSchema,
  shell: ShellConfigSchema,
};
const ToolsConfigSchema = z
  .object({
    root: toolsFields.root.default("."),
    shell: toolsFields.shell.default(() => ({ allow: [], deny: [], timeoutMs: 5000 })),
  })
  .strict();
const ToolsOverlaySchema = z
  .object({
    root: toolsFields.root.optional(),
    shell: ShellOverlaySchema.optional(),
  })
  .strict();
const permissionFields = {
  read: PermissionPolicySchema,
  write: PermissionPolicySchema,
  shell: PermissionPolicySchema,
  network: PermissionPolicySchema,
};
const PermissionsConfigSchema = z
  .object({
    "fs.read": permissionFields.read.default("allow"),
    "fs.write": permissionFields.write.default("deny"),
    shell: permissionFields.shell.default("deny"),
    network: permissionFields.network.default("deny"),
  })
  .strict();
const PermissionsOverlaySchema = z
  .object({
    "fs.read": permissionFields.read.optional(),
    "fs.write": permissionFields.write.optional(),
    shell: permissionFields.shell.optional(),
    network: permissionFields.network.optional(),
  })
  .strict();
const dashboardFields = {
  host: z.literal("127.0.0.1"),
  port: z.literal(18765),
  tasksFile: z.literal("TASKS.md"),
};
const DashboardConfigSchema = z
  .object({
    host: dashboardFields.host.default("127.0.0.1"),
    port: dashboardFields.port.default(18765),
    tasksFile: dashboardFields.tasksFile.default("TASKS.md"),
  })
  .strict();
const DashboardOverlaySchema = z
  .object({
    host: dashboardFields.host.optional(),
    port: dashboardFields.port.optional(),
    tasksFile: dashboardFields.tasksFile.optional(),
  })
  .strict();
const pluginConfigRecordSchema = z.record(z.string(), z.unknown());
const PluginsConfigSchema = z
  .record(pluginNameSchema, pluginConfigRecordSchema)
  .superRefine((value, context) => {
    try {
      parsePluginConfigs(value);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
const ModelPluginConfigSchema = z
  .object({
    model: modelFields.model.optional(),
    baseUrl: modelFields.baseUrl.optional(),
    timeoutMs: modelFields.timeoutMs.optional(),
    apiKeyEnv: z.literal("OPENAI_API_KEY").optional(),
    apiKeyFile: modelSecretPathSchema.optional(),
    allowedModelPrefixes: modelPrefixSchema.optional(),
    promptCacheKey: z.string().max(256).pipe(safeTextSchema).optional(),
  })
  .strict();
/**
 * Compaction policy the loop honours. Both fields are optional, so a config written before this
 * block existed stays valid and simply carries no `context` key — the plugin then falls back to its
 * own `DEFAULT_COMPACTION`. There is no `enabled` switch: a cap large enough is how a caller turns
 * compaction off, and one more boolean is one more thing nothing reads.
 */
const ContextConfigSchema = z
  .object({
    maxChars: z.number().int().min(1).max(10_000_000),
    keepMessages: z.number().int().min(1).max(200),
  })
  .strict();
/**
 * `parallelToolCalls` is optional and defaults to nothing, so a config written before it existed is
 * unchanged. There is no top-level block for it on purpose: it is a loop behaviour rather than a
 * runtime limit, and a caller asks for it in the plugin block instead of inheriting it.
 */
const LoopPluginConfigSchema = AgentOverlaySchema.extend({
  context: ContextConfigSchema.optional(),
  parallelToolCalls: z.boolean().optional(),
}).strict();
const ToolsPluginConfigSchema = z
  .object({
    root: toolsFields.root.optional(),
    shell: ShellOverlaySchema.optional(),
    maxBytes: z.number().int().min(1).max(100_000_000).optional(),
    maxSize: z.number().int().min(1).max(100_000_000).optional(),
    limits: z
      .object({ maxBytes: z.number().int().min(1).max(100_000_000).optional() })
      .strict()
      .optional(),
  })
  .strict();
const ExampleHelloPluginConfigSchema = z.object({ who: safeTextSchema.optional() }).strict();
const EmptyPluginConfigSchema = z.object({}).strict();

export const ConfigSchema = z
  .object({
    model: ModelConfigSchema.default(() => ({
      provider: "mock" as const,
      model: "mock",
      baseUrl: "https://api.openai.com/v1",
      timeoutMs: 5000,
    })),
    agent: AgentConfigSchema.default(() => ({ maxSteps: 8, maxToolCalls: 12, timeoutMs: 15000 })),
    budget: BudgetConfigSchema.default(() => ({
      enabled: false,
      maxTotalTokens: null,
      maxCostUsd: null,
      maxElapsedMs: null,
      prices: null,
    })),
    trace: TraceConfigSchema.default(() => ({ enabled: false, maxBytes: DEFAULT_TRACE_MAX_BYTES })),
    tools: ToolsConfigSchema.default(() => ({ root: ".", shell: { allow: [], deny: [], timeoutMs: 5000 } })),
    permissions: PermissionsConfigSchema.default(() => ({
      "fs.read": "allow" as const,
      "fs.write": "deny" as const,
      shell: "deny" as const,
      network: "deny" as const,
    })),
    dashboard: DashboardConfigSchema.default(() => ({
      host: "127.0.0.1" as const,
      port: 18765 as const,
      tasksFile: "TASKS.md" as const,
    })),
    plugins: PluginsConfigSchema.default(() => ({})),
  })
  .strict();
const ConfigOverlaySchema = z
  .object({
    model: ModelOverlaySchema.optional(),
    agent: AgentOverlaySchema.optional(),
    budget: BudgetOverlaySchema.optional(),
    trace: TraceOverlaySchema.optional(),
    tools: ToolsOverlaySchema.optional(),
    permissions: PermissionsOverlaySchema.optional(),
    dashboard: DashboardOverlaySchema.optional(),
    plugins: PluginsConfigSchema.optional(),
  })
  .strict();

export type ResolvedConfig = z.infer<typeof ConfigSchema> & { runtimeUserRoot: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSafeKeys(value: unknown, location = "config", ancestors = new Set<object>()): void {
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error(`cyclic configuration at ${location}`);
    ancestors.add(value);
    value.forEach((child, index) => {
      assertSafeKeys(child, `${location}[${index}]`, ancestors);
    });
    ancestors.delete(value);
    return;
  }
  if (!isRecord(value)) return;
  if (ancestors.has(value)) throw new Error(`cyclic configuration at ${location}`);
  ancestors.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || unsafeConfigurationKeys.has(key)) {
      throw new Error(`unsafe configuration key at ${location}: ${String(key)}`);
    }
    assertSafeKeys(value[key], `${location}.${key}`, ancestors);
  }
  ancestors.delete(value);
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""}${issue.message}`)
    .join("; ");
}

function pluginSchema(name: string): z.ZodType {
  switch (name) {
    case "example-hello":
      return ExampleHelloPluginConfigSchema;
    case "model-mock":
      return EmptyPluginConfigSchema;
    case "model-openai":
      return ModelPluginConfigSchema;
    case "tools-basic":
    case "tools-core":
      return ToolsPluginConfigSchema;
    case "loop-react":
      return LoopPluginConfigSchema;
    default:
      throw new Error(`unknown plugin configuration: ${name}`);
  }
}

function parsePluginConfig(name: string, value: unknown, location: string): Record<string, unknown> {
  const result = pluginSchema(name).safeParse(value);
  if (!result.success) throw new Error(`invalid configuration at ${location}: ${formatIssues(result.error)}`);
  return isRecord(result.data) ? result.data : {};
}

function parsePluginConfigs(value: unknown, location = "plugins"): Record<string, Record<string, unknown>> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`invalid configuration at ${location}: expected an object`);
  const result: Record<string, Record<string, unknown>> = Object.create(null) as Record<
    string,
    Record<string, unknown>
  >;
  for (const [name, config] of Object.entries(value)) {
    result[name] = parsePluginConfig(name, config, `${location}.${name}`);
  }
  return result;
}

async function resolvePluginRoots(
  plugins: Record<string, Record<string, unknown>>,
  root: string,
  userRoots: readonly string[],
): Promise<Record<string, Record<string, unknown>>> {
  const result: Record<string, Record<string, unknown>> = Object.create(null) as Record<
    string,
    Record<string, unknown>
  >;
  for (const [name, config] of Object.entries(plugins)) {
    let resolved = config;
    const toolRoot = config.root;
    if ((name === "tools-core" || name === "tools-basic") && typeof toolRoot === "string") {
      const canonicalRootPath = await toolRootPath(root, toolRoot, `plugins.${name}.root`);
      resolved = { ...resolved, root: canonicalRootPath };
    }
    if (name === "model-openai" && typeof config.apiKeyFile === "string") {
      resolved = {
        ...resolved,
        apiKeyFile: await resolveSecretPath(root, config.apiKeyFile, `plugins.${name}.apiKeyFile`, userRoots),
      };
    }
    result[name] = resolved;
  }
  return result;
}

function validateConfigFile(value: unknown, file: string): Record<string, unknown> {
  const result = ConfigOverlaySchema.safeParse(value);
  if (!result.success) throw new Error(`invalid configuration in ${file}: ${formatIssues(result.error)}`);
  parsePluginConfigs(result.data.plugins, `${file}.plugins`);
  return result.data as Record<string, unknown>;
}

export function mergeConfig(base: unknown, overlay: unknown): unknown {
  assertSafeKeys(base);
  assertSafeKeys(overlay);
  if (!isRecord(base) || !isRecord(overlay)) return overlay;
  const merged: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(base)) merged[key] = value;
  for (const [key, value] of Object.entries(overlay)) {
    const current = merged[key];
    merged[key] = isRecord(current) && isRecord(value) ? mergeConfig(current, value) : value;
  }
  return merged;
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function inside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

async function canonicalRoot(value: string): Promise<string> {
  const candidate = resolve(value);
  try {
    return await realpath(candidate);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return candidate;
    throw error;
  }
}

async function canonicalizeMissing(value: string): Promise<string> {
  let current = resolve(value);
  const missing: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(current), ...missing.reverse());
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(basename(current));
      current = parent;
    }
  }
}

async function canonicalPath(root: string, candidate: string, name: string): Promise<string> {
  const boundary = resolve(root);
  const lexical = resolve(candidate);
  if (!inside(boundary, lexical)) throw new Error(`${name} escapes the runtime root`);
  const canonicalBoundary = await canonicalizeMissing(boundary);
  const canonicalCandidate = await canonicalizeMissing(lexical);
  if (!inside(canonicalBoundary, canonicalCandidate)) throw new Error(`${name} escapes through a symlink`);
  return canonicalCandidate;
}

function hasParentTraversal(value: string): boolean {
  return value.split(/[\\/]/).includes("..");
}

/** Canonical trusted home user scope: `${HOME}/.config/nexus/user`. */
function homeUserRoot(): string {
  return resolve(homedir(), ".config", "nexus", "user");
}

/** Approved `user/` scopes: the runtime root first, then the canonical home scope. */
async function approvedUserRoots(runtimeRoot: string): Promise<readonly [string, string]> {
  const runtimeUserRoot = await canonicalRoot(resolve(runtimeRoot, "user"));
  if (!inside(runtimeRoot, runtimeUserRoot)) {
    throw new Error("user scope escapes the runtime root through a symlink");
  }
  const home = homeUserRoot();
  const homeParent = await canonicalRoot(dirname(home));
  const homeScope = await canonicalRoot(home);
  if (!inside(homeParent, homeScope)) {
    throw new Error("user scope escapes the home config through a symlink");
  }
  return [runtimeUserRoot, homeScope];
}

async function resolveSecretPath(
  runtimeRoot: string,
  value: unknown,
  name: string,
  userRoots: readonly string[],
): Promise<string> {
  const requested = pathArgument(value, name);
  if (requested.includes("\\") || hasParentTraversal(requested)) {
    throw new Error(`${name} must be a canonical path`);
  }
  const candidate = isAbsolute(requested) ? resolve(requested) : resolve(runtimeRoot, requested);
  const boundary = isAbsolute(requested)
    ? userRoots.find((userRoot) => inside(userRoot, candidate))
    : userRoots[0];
  if (boundary === undefined) throw new Error(`${name} must be under the approved user scope`);
  return canonicalPath(boundary, candidate, name);
}

async function readConfigFile(file: string, required: boolean): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (!required && hasCode(error, "ENOENT")) return {};
    throw new Error(`cannot read configuration ${file}`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text) as unknown;
  } catch (error) {
    throw new Error(`invalid YAML in ${file}`, { cause: error });
  }
  assertSafeKeys(parsed);
  return parsed;
}

function pathArgument(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    value.includes("\0") ||
    hasControlCharacter(value)
  ) {
    throw new Error(`${name} must be a non-empty path`);
  }
  return value;
}

/**
 * Tool roots are confined to the runtime root and nothing else: an absolute value gets the same
 * canonical treatment as a relative one, so `/`, a home directory, a sibling temp root, and a
 * symlinked parent that points out are all refused instead of silently becoming the tool root. A
 * host that needs a root elsewhere (sandbox, worktree) passes that directory as the runtime root.
 */
async function toolRootPath(root: string, value: string, name: string): Promise<string> {
  if (value.includes("\\") || hasParentTraversal(value)) throw new Error(`${name} must be a canonical path`);
  return canonicalPath(root, isAbsolute(value) ? value : resolve(root, value), name);
}

async function configPath(root: string, value: unknown, fallback: string, name: string): Promise<string> {
  const requested = pathArgument(value === undefined ? fallback : value, name);
  if (requested.includes("\\") || hasParentTraversal(requested)) {
    throw new Error(`${name} must be a canonical path`);
  }
  const candidate = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
  return canonicalPath(root, candidate, name);
}

export async function resolveConfig(
  root: string,
  options: { defaultsPath?: string; userPath?: string } = {},
): Promise<ResolvedConfig> {
  if (options !== undefined) {
    if (
      !isRecord(options) ||
      Reflect.ownKeys(options).some(
        (key) => typeof key !== "string" || (key !== "defaultsPath" && key !== "userPath"),
      )
    ) {
      throw new Error("configuration options must contain only defaultsPath and userPath");
    }
  }
  const absoluteRoot = await canonicalRoot(pathArgument(root, "root"));
  const userRoots = await approvedUserRoots(absoluteRoot);
  const defaultsPath = await configPath(
    absoluteRoot,
    options.defaultsPath,
    join("config", "default.yaml"),
    "defaultsPath",
  );
  const userPath = await configPath(absoluteRoot, options.userPath, join("user", "config.yaml"), "userPath");
  const defaults = validateConfigFile(await readConfigFile(defaultsPath, true), defaultsPath);
  const user = validateConfigFile(await readConfigFile(userPath, false), userPath);
  const merged = mergeConfig(defaults, user);
  const result = ConfigSchema.safeParse(merged);
  if (!result.success) throw new Error(`invalid configuration: ${formatIssues(result.error)}`);
  const plugins = await resolvePluginRoots(parsePluginConfigs(result.data.plugins), absoluteRoot, userRoots);
  const modelName =
    result.data.model.provider === "openai" && result.data.model.model === "mock"
      ? "gpt-4o-mini"
      : result.data.model.model;
  const model = {
    ...result.data.model,
    ...(result.data.model.apiKeyFile !== undefined
      ? {
          apiKeyFile: await resolveSecretPath(
            absoluteRoot,
            result.data.model.apiKeyFile,
            "model.apiKeyFile",
            userRoots,
          ),
        }
      : {}),
    model: modelName,
  };
  const toolsRoot = await toolRootPath(absoluteRoot, result.data.tools.root, "tools.root");
  return {
    ...result.data,
    model,
    plugins,
    tools: { ...result.data.tools, root: toolsRoot },
    runtimeUserRoot: userRoots[0],
  };
}

export function pluginConfig(config: ResolvedConfig, name: string): Record<string, unknown> {
  const base = name.startsWith("model-")
    ? config.model
    : name === "tools-core" || name === "tools-basic"
      ? config.tools
      : name === "loop-react"
        ? config.agent
        : {};
  const override = config.plugins[name];
  const validatedOverride =
    override === undefined ? {} : parsePluginConfig(name, override, `plugins.${name}`);
  const merged = mergeConfig(base, validatedOverride);
  if (name === "tools-core" || name === "tools-basic") {
    if (!isRecord(merged) || typeof merged.root !== "string" || !isAbsolute(merged.root)) {
      throw new Error(`invalid configuration at plugins.${name}.root`);
    }
  }
  if (name === "model-openai") {
    if (!isRecord(merged)) return {};
    if (typeof merged.apiKeyFile === "string" && !isAbsolute(merged.apiKeyFile)) {
      throw new Error("invalid configuration at plugins.model-openai.apiKeyFile");
    }
    // The kernel, not user config, decides which runtime user scope is approved.
    return { ...merged, runtimeUserRoot: config.runtimeUserRoot };
  }
  return isRecord(merged) ? merged : {};
}

export function permissionConfig(config: ResolvedConfig): Record<Permission, PermissionPolicy> {
  return config.permissions;
}
