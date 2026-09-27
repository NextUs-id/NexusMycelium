import { resolve } from "node:path";
import type {
  AgentLimits,
  AgentResult,
  AgentRunner,
  AgentRunnerFactory,
  AgentStepRecord,
  BudgetPolicy,
  BudgetStopReason,
} from "../kernel/src/agent.js";
import { BUDGET_STOP_REASONS, resolveBudgetPolicy } from "../kernel/src/agent.js";
import { permissionConfig, pluginConfig, type ResolvedConfig, resolveConfig } from "../kernel/src/config.js";
import { discoverPlugins, type PermissionAsk, PermissionGate, Registry } from "../kernel/src/index.js";
import type { ModelMessage, ModelProvider, ModelUsage } from "../kernel/src/model.js";
import type { ToolRegistry } from "../kernel/src/tools.js";
import { type RunStartRecord, type SessionStore, sessionMessages } from "./session.js";
import { createTraceWriter, type TraceInput, type TraceUsage, type TraceWriter } from "./trace.js";

const logger = {
  info: (message: string, meta?: unknown): void => console.info(message, meta ?? ""),
  warn: (message: string, meta?: unknown): void => console.warn(message, meta ?? ""),
  error: (message: string, meta?: unknown): void => console.error(message, meta ?? ""),
};

/**
 * The budget a run is held to, or `undefined` when the guard is off — so an off config leaves the run
 * options byte-for-byte as they were. The price map is passed through as configured, already keyed by
 * exact model identity: the runtime names no model of its own and prices nothing, so a cost ceiling is
 * enforceable for every model the map names and refuses, rather than silently skipping, the rest. An
 * absent map stays empty, which makes an armed cost ceiling stop as unpriced instead of being free.
 */
export function configBudget(config: ResolvedConfig): BudgetPolicy | undefined {
  if (config.budget.enabled !== true) return undefined;
  const { maxTotalTokens, maxCostUsd, maxElapsedMs, prices } = config.budget;
  return resolveBudgetPolicy({
    enabled: true,
    maxTotalTokens,
    maxCostUsd,
    maxElapsedMs,
    ...(prices === null ? {} : { prices }),
  });
}

const budgetReasons = new Set<string>(BUDGET_STOP_REASONS);

function isBudgetReason(value: string): value is BudgetStopReason {
  return budgetReasons.has(value);
}

/**
 * The runtime's one writer, or `undefined` for every config that does not ask for one. Off is the
 * absence of the call rather than an off writer: nothing is built, no root is resolved, and no file
 * is touched, so a default run is byte-identical to the run before tracing existed. Where the log
 * lands is the log's own business, the way the session store picks its own scope, so the runtime
 * names no path and passes only the switch and the already-bounded cap.
 */
function openTrace(
  config: ResolvedConfig,
  host: typeof createTraceWriter = createTraceWriter,
): TraceWriter | undefined {
  return config.trace.enabled === true ? host({ enabled: true, maxBytes: config.trace.maxBytes }) : undefined;
}

/**
 * Every record the runtime produces goes through here. An append never decides a run: the log counts
 * what it could not write and answers false, so the record is dropped and reported once per record
 * type rather than retried, thrown at the loop, or silently lost.
 */
function traceSink(writer: TraceWriter | undefined): (record: TraceInput) => Promise<void> {
  const reported = new Set<string>();
  return async (record) => {
    if (writer === undefined) return;
    try {
      if (await writer.append(record)) return;
    } catch (error) {
      logger.warn(`trace write failed: ${record.type}`, error);
      return;
    }
    if (reported.has(record.type)) return;
    reported.add(record.type);
    logger.warn(`trace log refused a ${record.type} record; the run is unaffected`);
  };
}

/** The counters a run was actually billed for, and nothing derived from a report that never came. */
function usageFields(usage: ModelUsage | undefined): { usage?: TraceUsage } {
  if (usage === undefined) return {};
  return {
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
    },
  };
}

/**
 * The one seam both run paths already go through: `runSession` and the CLI read `runtime.runner`, so
 * tracing the runner traces them both without either of them knowing. The caller's `onStep` still
 * runs first and still owns the run, the result comes back exactly as it went in, and only the
 * kernel's own budget vocabulary travels — any other error text stays out of the log, as do the
 * task, the transcript, the tool output, and every path.
 */
function tracedRunner(
  runner: AgentRunner,
  record: (record: TraceInput) => Promise<void>,
  identity: ModelIdentity,
): AgentRunner {
  return {
    async run(task, options) {
      await record({ type: "run-start", ...identity });
      const onStep = options?.onStep;
      // Always supplied, so a run nobody handed a hook to still reports its steps. Awaited inline on
      // purpose: a step record that could land after the run-end would make the log lie about order.
      const traced = async (step: AgentStepRecord): Promise<void> => {
        await onStep?.(step);
        await record({ type: "run-step", steps: step.step });
      };
      const result = await runner.run(task, { ...options, onStep: traced });
      const reason = result.error;
      await record({
        type: "run-end",
        status: result.status,
        steps: result.steps,
        toolCalls: result.toolCalls,
        ...usageFields(result.usage),
        ...(reason !== undefined && isBudgetReason(reason) ? { budgetReason: reason } : {}),
      });
      return result;
    },
  };
}

export interface Runtime {
  root: string;
  config: ResolvedConfig;
  registry: Registry;
  permissions: PermissionGate;
  /** The runtime's one trace writer, or `undefined` when `trace.enabled` is off. */
  readonly trace: TraceWriter | undefined;
  /** The configured budget guard, or `undefined` when it is off. */
  readonly budget: BudgetPolicy | undefined;
  /** Live: re-read from the registry so a reloaded plugin is never a stale snapshot. */
  readonly model: ModelProvider;
  readonly tools: ToolRegistry;
  readonly runner: AgentRunner;
  /** Provider/model pair a session is pinned to, after the plugin config overrides are applied. */
  readonly modelIdentity: ModelIdentity;
  close(): Promise<void>;
}

/** What a session records about the model that produced it; a resume across a different pair fails closed. */
export interface ModelIdentity {
  provider: string;
  model: string;
}

type ModelProviderName = "mock" | "openai";

interface RuntimeOptions {
  root?: string;
  modelProvider?: ModelProviderName;
  askPermission?: PermissionAsk;
  /** The trace writer factory; the real one by default, a test double in a test. */
  traceHost?: typeof createTraceWriter;
}

/** Canonical provider plugin per config provider; the loop brings `tools-basic` in via `requires`. */
const modelPlugin: Record<ModelProviderName, string> = {
  mock: "model-mock",
  openai: "model-openai",
};

function runtimeRoot(value: string | undefined): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.includes("\0")) {
    throw new Error("root must be a non-empty path");
  }
  return resolve(value);
}

function applyModelProvider(config: ResolvedConfig, requested?: ModelProviderName): ResolvedConfig {
  if (requested !== undefined && requested !== "mock" && requested !== "openai") {
    throw new Error("modelProvider must be mock or openai");
  }
  const provider = requested ?? config.model.provider;
  const model =
    requested === "mock"
      ? "mock"
      : provider === "openai" && config.model.model === "mock"
        ? "gpt-4o-mini"
        : config.model.model;
  return { ...config, model: { ...config.model, provider, model } };
}

/**
 * `strict` collapses the whole per-name report into one AggregateError. Its first entry is the root
 * failure: `loadAll` walks dependency-first, so a blocked dependent is only ever recorded after the
 * plugin that blocked it. Rethrowing that entry restores the real cause a caller needs.
 */
function requiredCause(error: unknown): unknown {
  const [root] = error instanceof AggregateError ? error.errors : [];
  return root === undefined ? error : new Error(String(root), { cause: error });
}

function applyPluginModelConfig(config: ResolvedConfig): ResolvedConfig {
  const plugin = pluginConfig(config, modelPlugin[config.model.provider]);
  const configuredModel = typeof plugin.model === "string" ? plugin.model : config.model.model;
  const model =
    config.model.provider === "openai" && configuredModel === "mock" ? "gpt-4o-mini" : configuredModel;
  return { ...config, model: { ...config.model, model } };
}

export async function createRuntime(options: RuntimeOptions = {}): Promise<Runtime> {
  if (options === null || typeof options !== "object") throw new Error("runtime options must be an object");
  const root = runtimeRoot(options.root);
  const resolvedConfig = await resolveConfig(root);
  const config = applyPluginModelConfig(applyModelProvider(resolvedConfig, options.modelProvider));
  const provider = config.model.provider;
  // Before the registry loads anything, so the host-known plugin outcomes below are all captured.
  const trace = openTrace(config, options.traceHost);
  const record = traceSink(trace);
  const permissions = new PermissionGate(permissionConfig(config), options.askPermission);
  const registry = new Registry(logger, (name) => pluginConfig(config, name), permissions);
  for (const plugin of await discoverPlugins(new URL("../plugins/", import.meta.url))) {
    registry.register(plugin);
  }

  /** Required capability -> the plugin that must own it. Missing means fail-closed, never a fallback. */
  const owners = new Map<string, string>([
    [`model:${provider}`, modelPlugin[provider]],
    ["tool:core", "tools-basic"],
    ["agent:runner-factory", "loop-react"],
  ]);
  const capability = <T>(service: string): T => {
    if (!registry.services.has(service)) {
      throw new Error(
        `required capability is unavailable: ${service} (expected from ${owners.get(service)})`,
      );
    }
    return registry.services.get<T>(service);
  };

  const required = [modelPlugin[provider], "loop-react"];
  // The registry's own load event, so a plugin that came up is recorded by the host and not guessed.
  // The promise is returned so the bus awaits it: the boot records are durable before the runtime is.
  registry.events.on("plugin:loaded", ({ name }) =>
    record({ type: "plugin-load", name, required: required.includes(name) }),
  );
  try {
    // Strict: a required model/loop failure is the caller's error, never a swallowed report.
    await registry.loadAll(required, { strict: true });
    for (const name of Object.keys(config.plugins)) {
      if (required.includes(name)) continue;
      try {
        await registry.load(name);
      } catch (error) {
        await record({ type: "plugin-load-failed", name, required: false });
        logger.warn(`optional plugin not loaded: ${name}`, error);
      }
    }
    for (const service of owners.keys()) capability(service);
  } catch (error) {
    // The name is not in the rejection, but the registry knows which required names never came up.
    const loaded = new Set(registry.loadedNames());
    for (const name of required) {
      if (!loaded.has(name)) {
        await record({ type: "plugin-load-failed", name, required: true });
      }
    }
    await registry.close();
    throw requiredCause(error);
  }

  let closed = false;
  return {
    root,
    config,
    registry,
    permissions,
    trace,
    budget: configBudget(config),
    modelIdentity: { provider, model: config.model.model },
    get model() {
      return capability<ModelProvider>(`model:${provider}`);
    },
    get tools() {
      return capability<ToolRegistry>("tool:core");
    },
    get runner() {
      const factory = capability<AgentRunnerFactory>("agent:runner-factory");
      // The model name travels with the provider so a per-model price map is reachable at the loop.
      const runner = factory(capability<ModelProvider>(`model:${provider}`), config.model.model);
      // Off means the very same runner the loop has always been handed: no wrapper, no extra option.
      return trace === undefined
        ? runner
        : tracedRunner(runner, record, { provider, model: config.model.model });
    },
    async close() {
      if (closed) return;
      closed = true;
      await registry.close();
    },
  };
}

/** What a session run needs from the runtime: the live runner plus the identity sessions are pinned to. */
export interface SessionAgent {
  readonly modelIdentity: ModelIdentity;
  readonly runner: AgentRunner;
  /** Forwarded to the runner when set; a session never stores it and a resume never restores it. */
  readonly budget?: BudgetPolicy;
}

export interface SessionRunOptions {
  task: string;
  store: SessionStore;
  /** Resume this session; omitted starts a new one. */
  sessionId?: string;
  limits?: Partial<AgentLimits>;
  signal?: AbortSignal;
  onStep?: (record: AgentStepRecord) => void | Promise<void>;
}

export interface SessionRun {
  sessionId: string;
  result: AgentResult;
}

interface ResumedSession {
  id: string;
  history: ModelMessage[];
  limits?: Partial<AgentLimits>;
}

/** A transcript recorded against another provider or model is refused, never silently replayed. */
async function resumeSession(
  sessionId: string,
  store: SessionStore,
  identity: ModelIdentity,
): Promise<ResumedSession> {
  const records = await store.load(sessionId);
  const start = records.find((record): record is RunStartRecord => record.type === "run-start");
  if (start === undefined) throw new Error(`cannot resume session ${sessionId}: no run-start record`);
  if (start.provider !== identity.provider || start.model !== identity.model) {
    throw new Error(
      `cannot resume session ${sessionId}: stored ${start.provider}:${start.model} differs from current ${identity.provider}:${identity.model}`,
    );
  }
  // Every run-end counts, not just the last: a later record cannot hand the session back a wider
  // ceiling than an earlier one recorded.
  const limits = records.reduce<Partial<AgentLimits> | undefined>(
    (tightest, record) => (record.type === "run-end" ? tightestLimits(tightest, record.limits) : tightest),
    undefined,
  );
  return { id: sessionId, history: sessionMessages(records), limits };
}

/**
 * Per field, the tighter of what the session recorded and what the caller asked for. A resume can
 * therefore never widen a recorded ceiling, and a caller cannot raise one either: `null` is not a
 * value here, so an absent field simply leaves the other side in force. `undefined` only when there
 * is nothing at all to hold the run to.
 */
function tightestLimits(
  recorded: Partial<AgentLimits> | undefined,
  requested: Partial<AgentLimits> | undefined,
): Partial<AgentLimits> | undefined {
  if (recorded === undefined) return requested;
  if (requested === undefined) return recorded;
  const fields = ["maxSteps", "maxToolCalls", "timeoutMs"] as const;
  const limits: Partial<AgentLimits> = {};
  for (const field of fields) {
    const stated = [recorded[field], requested[field]].filter((value) => typeof value === "number");
    if (stated.length > 0) {
      limits[field] = Math.min(...(stated as [number, ...number[]]));
    }
  }
  return limits;
}

/**
 * One bounded run, persisted through the store. A new session is stamped with the current provider
 * and model; a resume replays the stored transcript and continues under the tightest limits the
 * session ever recorded, tightened again by anything the caller asks for. The store owns paths,
 * redaction, and validation, so the runtime only sequences records.
 */
export async function runSession(agent: SessionAgent, options: SessionRunOptions): Promise<SessionRun> {
  // Live getter, resolved before any write: a missing capability leaves no orphan session behind.
  const runner = agent.runner;
  const { modelIdentity } = agent;
  const resumed =
    options.sessionId === undefined
      ? undefined
      : await resumeSession(options.sessionId, options.store, modelIdentity);
  const sessionId =
    resumed?.id ??
    (await options.store.appendStart({
      sessionId: options.sessionId,
      provider: modelIdentity.provider,
      model: modelIdentity.model,
      task: options.task,
    }));
  // A resume continues under the tighter of the recorded and the requested ceiling, so a stored
  // transcript and a caller can each lower the run's limits but neither can raise them.
  const limits = tightestLimits(resumed?.limits, options.limits);
  const onStep = async (record: AgentStepRecord): Promise<void> => {
    await options.store.appendStep(sessionId, record);
    await options.onStep?.(record);
  };
  const result = await runner.run(options.task, {
    history: resumed?.history,
    limits,
    onStep,
    signal: options.signal,
    // Last, so a stored transcript can never reintroduce it: config is the only activation surface.
    ...(agent.budget === undefined ? {} : { budget: agent.budget }),
  });
  await options.store.appendEnd(sessionId, {
    status: result.status,
    text: result.text,
    error: result.error,
    limits,
  });
  return { sessionId, result };
}
