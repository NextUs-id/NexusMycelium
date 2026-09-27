import {
  type AgentLimits,
  type AgentResult,
  type AgentRunner,
  type AgentRunnerFactory,
  type AgentStepRecord,
  BUDGET_COST,
  BUDGET_COST_UNPRICED,
  BUDGET_STOP_REASONS,
  BUDGET_STOP_TEXT,
  BUDGET_TIME,
  BUDGET_TOKENS,
  BUDGET_USAGE_UNAVAILABLE,
  type BudgetPolicy,
} from "../../../kernel/src/agent.js";
import { definePlugin } from "../../../kernel/src/index.js";
import type {
  ModelMessage,
  ModelPrice,
  ModelProvider,
  ModelResult,
  ModelToolCall,
  ModelUsage,
} from "../../../kernel/src/model.js";
import type { ToolRegistry } from "../../../kernel/src/tools.js";

export type { BudgetStopReason } from "../../../kernel/src/agent.js";
export type { ModelPrice, ModelUsage } from "../../../kernel/src/model.js";
export type { AgentLimits, AgentResult, AgentRunner, AgentRunnerFactory, AgentStepRecord, BudgetPolicy };

/**
 * The kernel owns the stop vocabulary, so a stop here can only ever report one of the constants it
 * publishes. These are re-exported under the names this plugin has always used — a re-export, not a
 * second copy, so a reason a consumer matches on cannot drift from the one emitted below.
 */
export {
  BUDGET_COST,
  BUDGET_COST_UNPRICED,
  BUDGET_STOP_REASONS,
  BUDGET_STOP_TEXT as BUDGET_TEXT,
  BUDGET_TIME,
  BUDGET_TOKENS,
  BUDGET_USAGE_UNAVAILABLE,
};

/** Membership in the kernel vocabulary is what makes a string a budget stop, not a name match. */
const budgetStops = new Set<string>(BUDGET_STOP_REASONS);
const MAX_USAGE_SOURCE = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  const message =
    typeof error === "string" ? error : error instanceof Error ? error.message : "operation failed";
  return Array.from(message, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  })
    .join("")
    .slice(0, 1000);
}

function tokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** A cache-read count is a whole number of tokens, or the whole usage block is dropped with it. */
function cacheReadCount(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  return tokenCount(value) && Number.isInteger(value) ? (value as number) : null;
}

/** Provider counts cross a trust boundary here: only three finite numbers and a short label survive. */
function parseUsage(value: unknown): ModelUsage | undefined {
  if (!isRecord(value)) return undefined;
  if (!tokenCount(value.inputTokens) || !tokenCount(value.outputTokens) || !tokenCount(value.totalTokens)) {
    return undefined;
  }
  const cachedTokens = cacheReadCount(value.cachedTokens);
  if (cachedTokens === null) return undefined;
  if (typeof value.source !== "string" || value.source.length === 0) return undefined;
  const source = Array.from(value.source, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  })
    .join("")
    .trim()
    .slice(0, MAX_USAGE_SOURCE);
  if (source.length === 0) return undefined;
  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    totalTokens: value.totalTokens,
    source,
    ...(cachedTokens === undefined ? {} : { cachedTokens }),
  };
}

function normalizeLimits(base: AgentLimits, override?: Partial<AgentLimits>): AgentLimits {
  const limits = { ...base, ...override };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  }
  if (limits.maxSteps < 1) throw new Error("maxSteps must be at least 1");
  if (limits.timeoutMs < 1) throw new Error("timeoutMs must be positive");
  return limits;
}

function parseCall(value: unknown): ModelToolCall | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    !isRecord(value.arguments)
  ) {
    return undefined;
  }
  return { id: value.id, name: value.name, arguments: value.arguments };
}

function parseResult(value: unknown): ModelResult | undefined {
  if (!isRecord(value)) return undefined;
  // A malformed usage block is dropped rather than failing the turn: bad accounting must not turn a
  // usable answer into an error. A budgeted run then stops as `budget:usage-unavailable` instead.
  const usage = parseUsage(value.usage);
  if (value.type === "final" && typeof value.text === "string") {
    return usage === undefined
      ? { type: "final", text: value.text }
      : { type: "final", text: value.text, usage };
  }
  if (value.type !== "tool_calls" || !Array.isArray(value.calls)) return undefined;
  const calls: ModelToolCall[] = [];
  for (const valueCall of value.calls) {
    const call = parseCall(valueCall);
    if (!call) return undefined;
    calls.push(call);
  }
  return usage === undefined ? { type: "tool_calls", calls } : { type: "tool_calls", calls, usage };
}

function observation(ok: boolean, output?: string, error?: string): string {
  return JSON.stringify(
    ok ? { ok: true, output: output?.slice(0, 16_000) } : { ok: false, error: error ?? "tool failed" },
  );
}

function result(
  status: AgentResult["status"],
  text: string,
  steps: number,
  toolCalls: number,
  observations: readonly string[],
  error?: string,
): AgentResult {
  const value: AgentResult = { status, text, steps, toolCalls, observations: [...observations] };
  return error === undefined ? value : { ...value, error };
}

export function createAgentRunner(options: {
  model: ModelProvider;
  tools: ToolRegistry;
  limits: AgentLimits;
  /** Default policy for runs that do not carry their own. A disabled policy starts no timer. */
  budget?: BudgetPolicy;
  /**
   * Exact model identity the prices map is keyed by. Absent means an armed cost cap cannot be
   * priced and stops the run as `budget:cost-unpriced`; the map is never matched loosely.
   */
  modelIdentity?: string;
}): AgentRunner {
  return {
    async run(task, runOptions) {
      const limits = normalizeLimits(options.limits, runOptions?.limits);
      const budget = runOptions?.budget ?? options.budget;
      const metered = budget?.enabled === true;
      const externalSignal = runOptions?.signal;
      if (externalSignal?.aborted) {
        return result("stopped", "Agent stopped: cancelled.", 0, 0, [], "agent cancelled");
      }
      const controller = new AbortController();
      let steps = 0;
      let toolCalls = 0;
      let lastToolFailure: string | undefined;
      const observations: string[] = [];
      let stopResult: AgentResult | undefined;
      let resolveStop: ((value: AgentResult) => void) | undefined;
      const stopped = new Promise<AgentResult>((resolve) => {
        resolveStop = resolve;
      });
      const stop = (text: string, error?: string): AgentResult => {
        stopResult ??= result("stopped", text, steps, toolCalls, observations, error);
        resolveStop?.(stopResult);
        return stopResult;
      };
      const externalAbort = (): void => {
        stop("Agent stopped: cancelled.", "agent cancelled");
        controller.abort();
      };
      externalSignal?.addEventListener("abort", externalAbort, { once: true });
      const onStep = runOptions?.onStep;
      // Resume replays the stored transcript as-is: tool call ids and message order stay untouched.
      // An empty history counts as absent so a session always starts from the system prompt.
      const history = runOptions?.history;
      const messages: ModelMessage[] =
        history && history.length > 0
          ? [...history, { role: "user", content: task }]
          : [
              {
                role: "system",
                content: "Use the available tools when needed, then return a final answer.",
              },
              { role: "user", content: task },
            ];
      // ponytail: the step hook is awaited inline, so a hook that never settles holds the run open until
      // the caller gives up; race it against `stopped` if untrusted hooks ever land here.
      const notify = async (step: number): Promise<void> => {
        if (!onStep) return;
        const record: AgentStepRecord = { step, messages: messages.slice() };
        await onStep(record);
      };
      // Usage is accumulated only while a policy is enabled, so a disabled run keeps no counters at all.
      let inputTokens = 0;
      let outputTokens = 0;
      let totalTokens = 0;
      let usageSource: string | undefined;
      // Cache reads are summed per turn and stay inside `inputTokens`, so they never charge twice.
      let cachedTokens = 0;
      let cacheReadsReported = false;
      /** Exact-key lookup: a prototype member like `constructor` is never a price. */
      const price = (): ModelPrice | undefined => {
        const identity = options.modelIdentity;
        if (identity === undefined || budget === undefined) return undefined;
        return Object.hasOwn(budget.prices, identity) ? budget.prices[identity] : undefined;
      };
      const aggregate = (): ModelUsage | undefined =>
        usageSource === undefined
          ? undefined
          : {
              inputTokens,
              outputTokens,
              totalTokens,
              source: usageSource,
              ...(cacheReadsReported ? { cachedTokens } : {}),
            };
      /**
       * Charges one model turn and reports the first breached cap, or `undefined` to keep going.
       * Unpriced cost and unreadable usage are checked before the turn is charged, so an
       * unenforceable meter stops the run on the first step instead of after spending the budget.
       */
      const budgetStop = (reported: ModelUsage | undefined): string | undefined => {
        if (!metered || budget === undefined) return undefined;
        const costCap = budget.maxCostUsd;
        const rate = costCap === null ? undefined : price();
        if (costCap !== null && rate === undefined) return BUDGET_COST_UNPRICED;
        if (budget.maxTotalTokens === null && costCap === null) return undefined;
        if (reported === undefined) return BUDGET_USAGE_UNAVAILABLE;
        inputTokens += reported.inputTokens;
        outputTokens += reported.outputTokens;
        totalTokens += reported.totalTokens;
        if (usageSource === undefined) usageSource = reported.source;
        else if (usageSource !== reported.source) usageSource = "multiple";
        if (reported.cachedTokens !== undefined) {
          cachedTokens += reported.cachedTokens;
          cacheReadsReported = true;
        }
        if (budget.maxTotalTokens !== null && totalTokens >= budget.maxTotalTokens) return BUDGET_TOKENS;
        // Both sides are integer micro-USD, so no float division can round a cap up to a pass.
        if (costCap !== null && rate !== undefined) {
          const spent =
            inputTokens * rate.inputUsdPerMillionTokens + outputTokens * rate.outputUsdPerMillionTokens;
          if (spent >= costCap * 1_000_000) return BUDGET_COST;
        }
        return undefined;
      };
      /** Answers every tool call of a budget-stopped turn so the transcript is never left unpaired. */
      const unpair = (reason: string, calls: readonly ModelToolCall[], from: number): void => {
        for (const call of calls.slice(from)) {
          const value = observation(false, undefined, reason);
          observations.push(value);
          messages.push({ role: "tool", content: value, toolCallId: call.id });
        }
      };
      const work = async (): Promise<AgentResult> => {
        try {
          for (let step = 0; step < limits.maxSteps; step += 1) {
            if (controller.signal.aborted) return stop("Agent stopped: cancelled.", "agent cancelled");
            steps = step + 1;
            const raw: unknown = await Promise.race([
              options.model.complete(messages, options.tools.definitions(), controller.signal),
              stopped.then((value) => ({ stopped: value })),
            ]);
            if (typeof raw === "object" && raw !== null && "stopped" in raw) {
              return (raw as { stopped: AgentResult }).stopped;
            }
            if (controller.signal.aborted) return stop("Agent stopped: cancelled.", "agent cancelled");
            const modelResult = parseResult(raw);
            if (!modelResult) {
              return result(
                "error",
                "Agent error: invalid model result.",
                steps,
                toolCalls,
                observations,
                "invalid model result",
              );
            }
            const overrun = budgetStop(modelResult.usage);
            if (overrun !== undefined) {
              // Charged before the turn is acted on, so a stopped run never bills for work it skipped.
              const stopped = stop(BUDGET_STOP_TEXT, overrun);
              controller.abort();
              return stopped;
            }
            if (modelResult.type === "final") {
              await notify(steps);
              return lastToolFailure === undefined
                ? result("completed", modelResult.text, steps, toolCalls, observations)
                : result(
                    "error",
                    modelResult.text || "Agent error: tool failed.",
                    steps,
                    toolCalls,
                    observations,
                    lastToolFailure,
                  );
            }
            if (modelResult.calls.length === 0) {
              await notify(steps);
              return lastToolFailure === undefined
                ? result("completed", "", steps, toolCalls, observations)
                : result(
                    "error",
                    "Agent error: tool failed.",
                    steps,
                    toolCalls,
                    observations,
                    lastToolFailure,
                  );
            }
            messages.push({ role: "assistant", content: "", toolCalls: modelResult.calls });
            for (const [index, call] of modelResult.calls.entries()) {
              if (toolCalls >= limits.maxToolCalls) {
                const limited = observation(false, undefined, "tool call limit reached");
                observations.push(limited);
                messages.push({ role: "tool", content: limited, toolCallId: call.id });
                return stop("Agent stopped: tool call limit reached.", "tool call limit reached");
              }
              toolCalls += 1;
              let output: string | undefined;
              let failure: string | undefined;
              try {
                if (!options.tools.has(call.name)) throw new Error(`unknown tool: ${call.name}`);
                output = await options.tools.get(call.name).execute(call.arguments, controller.signal);
              } catch (error) {
                failure = errorText(error);
              }
              if (controller.signal.aborted) {
                const budgeted = stopResult;
                const reason = budgeted?.error;
                if (budgeted !== undefined && reason !== undefined && budgetStops.has(reason)) {
                  unpair(reason, modelResult.calls, index);
                  return { ...budgeted, observations: [...observations] };
                }
                return stop("Agent stopped: cancelled.", "agent cancelled");
              }
              lastToolFailure = failure;
              const value =
                failure === undefined ? observation(true, output) : observation(false, undefined, failure);
              observations.push(value);
              messages.push({ role: "tool", content: value, toolCallId: call.id });
            }
            await notify(steps);
          }
          return stop("Agent stopped: step limit reached.", "step limit reached");
        } catch (error) {
          if (controller.signal.aborted) return stop("Agent stopped: cancelled.", "agent cancelled");
          const message = errorText(error);
          return result("error", `Agent error: ${message}`, steps, toolCalls, observations, message);
        }
      };
      const timer = setTimeout(() => {
        stop("Agent stopped: timeout reached.", "agent timeout");
        controller.abort();
      }, limits.timeoutMs);
      // Only an enabled policy with an elapsed cap owns a second timer, so a disabled run arms none.
      const budgetTimer =
        metered && budget?.maxElapsedMs !== null && budget?.maxElapsedMs !== undefined
          ? setTimeout(() => {
              stop(BUDGET_STOP_TEXT, BUDGET_TIME);
              controller.abort();
            }, budget.maxElapsedMs)
          : undefined;
      try {
        const finished = await work();
        // One attach point for every exit path, and only when a policy is enabled and something was
        // actually reported: a disabled run gains no `usage` key and an unreported one gains no zero.
        const spent = aggregate();
        return metered && spent !== undefined ? { ...finished, usage: spent } : finished;
      } catch (error) {
        const message = errorText(error);
        return result("error", `Agent error: ${message}`, steps, toolCalls, observations, message);
      } finally {
        clearTimeout(timer);
        if (budgetTimer !== undefined) clearTimeout(budgetTimer);
        externalSignal?.removeEventListener("abort", externalAbort);
      }
    },
  };
}

function numberConfig(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

export default definePlugin({
  manifest: {
    name: "loop-react",
    version: "0.1.0",
    apiVersion: 1,
    description: "Bounded model, tool, observation, and final-answer loop.",
    provides: ["agent:runner-factory"],
    requires: ["tools-basic"],
    permissions: [],
  },
  setup({ config, services }) {
    const tools = services.get<ToolRegistry>("tool:core");
    const limits: AgentLimits = {
      maxSteps: numberConfig(config.maxSteps, 8),
      maxToolCalls: numberConfig(config.maxToolCalls, 12),
      timeoutMs: numberConfig(config.timeoutMs, 15000),
    };
    // The factory is handed the resolved model identity the caller's price map is keyed by, so an
    // armed cost ceiling is priceable instead of refusing every run as unpriced.
    const factory: AgentRunnerFactory = (model, modelName) =>
      createAgentRunner({ model, tools, limits, modelIdentity: modelName });
    services.register("agent:runner-factory", factory, "loop-react");
  },
});
