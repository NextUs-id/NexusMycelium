import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { definePlugin } from "../../../kernel/src/index.js";
import type {
  ModelMessage,
  ModelProvider,
  ModelResult,
  ModelToolCall,
  ModelUsage,
} from "../../../kernel/src/model.js";
import type { PermissionGate } from "../../../kernel/src/permissions.js";

/** Provenance tag: these counts are the gateway's own report, not an estimate. */
const USAGE_SOURCE = "model-openai";

const tokenCount = z.number().int().nonnegative();

/**
 * Optional `usage` block as OpenAI-compatible gateways report it. Unknown members
 * (router cost fields, `cost_details`, `is_byok`, …) are ignored, but a reported
 * counter with the wrong type is a hard error: a fabricated 0 would under-count
 * spend and defeat the budget guard. `nullish` because some gateways send
 * `"usage": null` to mean "not reported" rather than omitting the key.
 */
const OpenAIUsageSchema = z
  .object({
    prompt_tokens: tokenCount.optional(),
    completion_tokens: tokenCount.optional(),
    total_tokens: tokenCount.optional(),
    prompt_tokens_details: z.object({ cached_tokens: tokenCount.optional() }).optional(),
  })
  .nullish();

const OpenAIResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string().min(1),
                function: z.object({ name: z.string().min(1), arguments: z.string() }),
              }),
            )
            .optional(),
        }),
      }),
    )
    .min(1),
  usage: OpenAIUsageSchema,
});

/** Kernel accounting plus the cache-read count the kernel has no slot for (4.1). */
export type OpenAIUsage = ModelUsage & { readonly cachedTokens?: number };

/** `ModelResult` plus the usage the gateway actually reported. Never fabricated. */
export type OpenAICompatibleResult = ModelResult & { readonly usage?: OpenAIUsage };

type OpenAICompatibleOptions = {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  permissions: PermissionGate;
  fetcher?: typeof fetch;
  apiKeyEnv?: string;
  apiKey?: string;
  apiKeyFile?: string;
  allowedModelPrefixes?: readonly string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function endpoint(baseUrl: string): string {
  const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL("chat/completions", normalized);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("OpenAI-compatible base URL must use HTTP or HTTPS");
  }
  return url.toString();
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function pathIsInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

const outOfScope = "apiKeyFile must resolve under user/secrets or user/providers in an approved user scope";

/** Canonical trusted home user scope: `${HOME}/.config/nexus/user`. */
function homeUserRoot(): string {
  return resolve(homedir(), ".config", "nexus", "user");
}

/**
 * Lexical scope check. A `user` path segment alone proves nothing: the file must sit
 * directly under `secrets/` or `providers/` inside a scope the kernel or the home approved.
 */
function secretFile(value: string, userRoots: readonly string[]): { file: string; root: string } {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    value.includes("\0") ||
    hasControlCharacter(value)
  ) {
    throw new Error("apiKeyFile must be a non-empty path");
  }
  if (!isAbsolute(value) || value.split(/[\\/]/).includes("..")) throw new Error(outOfScope);
  const file = resolve(value);
  const root = userRoots.find((userRoot) => pathIsInside(userRoot, file));
  const [directory, name] = root === undefined ? [] : relative(root, file).split(sep);
  if (root === undefined || !name || (directory !== "secrets" && directory !== "providers")) {
    throw new Error(outOfScope);
  }
  return { file, root };
}

/** Canonical check on the scope, the parent directory, and the file itself. */
async function canonicalSecretFile(file: string, root: string): Promise<string> {
  const [scopeParent, scope, parent, canonicalFile] = await Promise.all([
    realpath(dirname(root)),
    realpath(root),
    realpath(dirname(file)),
    realpath(file),
  ]);
  if (!pathIsInside(scopeParent, scope)) throw new Error(outOfScope);
  if (dirname(parent) !== scope) throw new Error(outOfScope);
  if (!pathIsInside(parent, canonicalFile)) throw new Error(outOfScope);
  return canonicalFile;
}

async function readApiKeyFile(
  value: string,
  permissions: PermissionGate,
  userRoots: readonly string[],
): Promise<string> {
  const { file, root } = secretFile(value, userRoots);
  await permissions.check("fs.read", "read API key file");
  let canonical: string;
  try {
    const fileStat = await lstat(file);
    if (!fileStat.isFile()) throw new Error("apiKeyFile must be a regular file");
    if ((fileStat.mode & 0o777) !== 0o600) throw new Error("apiKeyFile must have permissions 600");
    canonical = await canonicalSecretFile(file, root);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("apiKeyFile")) throw error;
    throw new Error("apiKeyFile cannot be read safely", { cause: error });
  }
  try {
    const secret = (await readFile(canonical, "utf8")).trim();
    if (secret.length === 0 || hasControlCharacter(secret)) {
      throw new Error("apiKeyFile must contain a single non-empty secret");
    }
    return secret;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("apiKeyFile")) throw error;
    throw new Error("apiKeyFile cannot be read safely", { cause: error });
  }
}

function redactSecret(value: string, secret: string | undefined): string {
  return secret ? value.split(secret).join("[REDACTED]") : value;
}

function redactError(error: unknown, secret: string | undefined): unknown {
  if (secret === undefined) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new Error(redactSecret(message, secret));
}

function validateModelPrefixes(prefixes: readonly string[] | undefined): readonly string[] | undefined {
  if (prefixes === undefined) return undefined;
  if (!Array.isArray(prefixes) || prefixes.length === 0) {
    throw new Error("allowedModelPrefixes must contain at least one prefix");
  }
  for (const prefix of prefixes) {
    if (
      typeof prefix !== "string" ||
      prefix.length === 0 ||
      prefix.trim() !== prefix ||
      hasControlCharacter(prefix)
    ) {
      throw new Error("allowedModelPrefixes must contain non-empty prefixes");
    }
  }
  return [...prefixes];
}

export function isModelAllowed(model: string, allowedModelPrefixes?: readonly string[]): boolean {
  return (
    allowedModelPrefixes === undefined || allowedModelPrefixes.some((prefix) => model.startsWith(prefix))
  );
}

function openAIMessages(messages: readonly ModelMessage[]): Record<string, unknown>[] {
  return messages.map((message) => {
    const value: Record<string, unknown> = { role: message.role, content: message.content };
    if (message.toolCallId !== undefined) value.tool_call_id = message.toolCallId;
    if (message.toolCalls !== undefined) {
      value.tool_calls = message.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: "function",
        function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) },
      }));
    }
    return value;
  });
}

/**
 * Keep only what the gateway actually reported. A block that is absent, null,
 * empty, all-zero, or missing any of the three kernel counters stays
 * `undefined`: the kernel contract needs all three, and deriving or zero-filling
 * one would invent spend the budget guard then trusts. No price is computed here.
 */
function parseUsage(usage: z.infer<typeof OpenAIUsageSchema>): OpenAIUsage | undefined {
  if (usage === null || usage === undefined) return undefined;
  const { prompt_tokens: input, completion_tokens: output, total_tokens: total } = usage;
  if (input === undefined || output === undefined || total === undefined) return undefined;
  if (input === 0 && output === 0 && total === 0) return undefined;
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    source: USAGE_SOURCE,
    ...(cachedTokens === undefined ? {} : { cachedTokens }),
  };
}

function usageField(usage: OpenAIUsage | undefined): { usage?: OpenAIUsage } {
  return usage === undefined ? {} : { usage };
}

function parseResponse(body: unknown): OpenAICompatibleResult {
  const parsed = OpenAIResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`OpenAI-compatible response is invalid: ${parsed.error.message}`);
  }
  const choice = parsed.data.choices[0];
  if (!choice) throw new Error("OpenAI-compatible response has no choice");
  const usage = parseUsage(parsed.data.usage);
  const calls = choice.message.tool_calls ?? [];
  if (calls.length === 0) {
    return { type: "final", text: choice.message.content ?? "", ...usageField(usage) };
  }
  const modelCalls: ModelToolCall[] = calls.map((call) => {
    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments) as unknown;
    } catch (error) {
      throw new Error(`OpenAI-compatible tool arguments are invalid JSON: ${call.function.name}`, {
        cause: error,
      });
    }
    if (!isRecord(args)) {
      throw new Error(`OpenAI-compatible tool arguments must be an object: ${call.function.name}`);
    }
    return { id: call.id, name: call.function.name, arguments: args };
  });
  return { type: "tool_calls", calls: modelCalls, ...usageField(usage) };
}

export function createOpenAICompatibleModel(options: OpenAICompatibleOptions): ModelProvider {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1) {
    throw new Error("OpenAI-compatible timeout must be positive");
  }
  if (typeof options.model !== "string" || options.model.trim().length === 0) {
    throw new Error("OpenAI-compatible model must be a non-empty string");
  }
  const allowedModelPrefixes = validateModelPrefixes(options.allowedModelPrefixes);
  if (!isModelAllowed(options.model, allowedModelPrefixes)) {
    throw new Error("model is not allowed by the configured prefix allowlist");
  }
  const requestUrl = endpoint(options.baseUrl);
  const fetcher = options.fetcher ?? globalThis.fetch;
  if (typeof fetcher !== "function") throw new Error("global fetch is unavailable");
  const apiKeyName = options.apiKeyEnv ?? "OPENAI_API_KEY";
  if (!/^[A-Z_][A-Z0-9_]*$/.test(apiKeyName)) throw new Error("OpenAI API key environment name is invalid");
  const configuredApiKey = options.apiKey?.trim();
  if (options.apiKey !== undefined && (!configuredApiKey || hasControlCharacter(configuredApiKey))) {
    throw new Error("OpenAI API key must be a non-empty secret");
  }
  // Direct construction has no kernel-granted runtime scope, so only the trusted home scope applies.
  const apiKeyFile =
    options.apiKeyFile === undefined ? undefined : secretFile(options.apiKeyFile, [homeUserRoot()]).file;
  let apiKeyPromise: Promise<string> | undefined;
  return {
    async complete(messages, tools, signal): Promise<OpenAICompatibleResult> {
      await options.permissions.check("network", `POST ${requestUrl}`);
      if (signal?.aborted) throw new Error("OpenAI-compatible request cancelled");
      const controller = new AbortController();
      const abortRequest = (): void => controller.abort();
      signal?.addEventListener("abort", abortRequest, { once: true });
      if (signal?.aborted) controller.abort();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, options.timeoutMs);
      let requestApiKey = configuredApiKey;
      const request = Promise.resolve().then(async () => {
        if (controller.signal.aborted) throw new Error("OpenAI-compatible request cancelled");
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (requestApiKey === undefined) {
          if (apiKeyFile === undefined) {
            requestApiKey = process.env[apiKeyName]?.trim();
          } else {
            apiKeyPromise ??= readApiKeyFile(apiKeyFile, options.permissions, [homeUserRoot()]);
            requestApiKey = await apiKeyPromise;
          }
        }
        if (requestApiKey) headers.authorization = `Bearer ${requestApiKey}`;
        const response = await fetcher(requestUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: options.model,
            messages: openAIMessages(messages),
            tools: tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
            stream: false,
          }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`OpenAI-compatible request failed: HTTP ${response.status}`);
        let body: unknown;
        try {
          body = await response.json();
        } catch (error) {
          throw new Error("OpenAI-compatible response is invalid JSON", { cause: error });
        }
        return parseResponse(body);
      });
      try {
        const result = await request.catch((error: unknown) => {
          if (timedOut) throw new Error("OpenAI-compatible request timed out");
          if (signal?.aborted) throw new Error("OpenAI-compatible request cancelled");
          throw redactError(error, requestApiKey);
        });
        if (timedOut) throw new Error("OpenAI-compatible request timed out");
        if (signal?.aborted) throw new Error("OpenAI-compatible request cancelled");
        return result;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abortRequest);
      }
    },
  };
}

interface WriteInstruction {
  path: string;
  content: string;
}

function taskText(messages: readonly ModelMessage[]): string {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n");
}

function parseInstruction(text: string): WriteInstruction | undefined {
  const match = text.match(
    /(?:write|create)\s+(?:file\s+)?["']?([^\s"']+)["']?\s+(?:with(?:\s+content)?|content)\s+(?:"([^"]*)"|'([^']*)'|(.+))/i,
  );
  if (!match) return undefined;
  return {
    path: match[1] ?? "",
    content: match[2] ?? match[3] ?? (match[4] ?? "").trim(),
  };
}

function readPath(text: string): string | undefined {
  return text.match(/read(?:\s+back)?\s+["']?([^\s"']+)/i)?.[1];
}

function previousToolCalls(messages: readonly ModelMessage[]): readonly ModelToolCall[] {
  return messages.flatMap((message) => message.toolCalls ?? []);
}

function mockToolCall(name: string, args: Record<string, unknown>, index: number): ModelResult {
  return {
    type: "tool_calls",
    calls: [{ id: `mock-${index + 1}`, name, arguments: args }],
  };
}

function failedObservation(messages: readonly ModelMessage[]): string | undefined {
  const last = [...messages].reverse().find((message) => message.role === "tool");
  if (!last) return undefined;
  try {
    const value: unknown = JSON.parse(last.content);
    return isRecord(value) && value.ok === false && typeof value.error === "string" ? value.error : undefined;
  } catch {
    return undefined;
  }
}

export function createMockModel(): ModelProvider {
  return {
    async complete(messages) {
      const text = taskText(messages);
      const failure = failedObservation(messages);
      if (failure) return { type: "final", text: `Tool failure: ${failure}` };
      const calls = previousToolCalls(messages);
      const instruction = parseInstruction(text);
      if (instruction && !calls.some((call) => call.name === "write_text")) {
        return mockToolCall(
          "write_text",
          { path: instruction.path, content: instruction.content },
          calls.length,
        );
      }
      const path = readPath(text);
      if (path && !calls.some((call) => call.name === "read_text")) {
        return mockToolCall("read_text", { path }, calls.length);
      }
      return {
        type: "final",
        text: instruction
          ? `Completed deterministic mock task for ${instruction.path}.`
          : "Completed deterministic mock task.",
      };
    },
  };
}

function configuredProvider(config: Record<string, unknown>): "openai" {
  if (config.provider !== "openai") {
    throw new Error("model-openai requires provider: openai");
  }
  return "openai";
}

function configString(config: Record<string, unknown>, key: string, fallback: string): string {
  const value = config[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`model-openai ${key} must be a non-empty string`);
  }
  return value;
}

function configNumber(config: Record<string, unknown>, key: string, fallback: number): number {
  return typeof config[key] === "number" ? config[key] : fallback;
}

function optionalConfigString(config: Record<string, unknown>, key: string): string | undefined {
  return config[key] === undefined ? undefined : configString(config, key, "");
}

function configPrefixes(config: Record<string, unknown>): readonly string[] | undefined {
  const value = config.allowedModelPrefixes;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((prefix) => typeof prefix !== "string")) {
    throw new Error("model-openai allowedModelPrefixes must be an array of strings");
  }
  return value as string[];
}

/** The kernel injects the approved runtime scope; user config can never set it. */
function approvedUserRoots(config: Record<string, unknown>): readonly string[] {
  const runtimeUserRoot = optionalConfigString(config, "runtimeUserRoot");
  return runtimeUserRoot === undefined ? [homeUserRoot()] : [resolve(runtimeUserRoot), homeUserRoot()];
}

export default definePlugin({
  manifest: {
    name: "model-openai",
    version: "0.1.0",
    apiVersion: 1,
    description: "OpenAI-compatible HTTP model provider.",
    provides: ["model:openai"],
    permissions: ["fs.read", "network"],
  },
  async setup({ config, permissions, services }) {
    configuredProvider(config);
    const userRoots = approvedUserRoots(config);
    const apiKeyFile = optionalConfigString(config, "apiKeyFile");
    const apiKey =
      apiKeyFile === undefined ? undefined : await readApiKeyFile(apiKeyFile, permissions, userRoots);
    const model = createOpenAICompatibleModel({
      baseUrl: configString(config, "baseUrl", "https://api.openai.com/v1"),
      model: configString(config, "model", "gpt-4o-mini"),
      timeoutMs: configNumber(config, "timeoutMs", 5000),
      apiKeyEnv: configString(config, "apiKeyEnv", "OPENAI_API_KEY"),
      apiKey,
      allowedModelPrefixes: configPrefixes(config),
      permissions,
    });
    services.register("model:openai", model, "model-openai");
  },
});
