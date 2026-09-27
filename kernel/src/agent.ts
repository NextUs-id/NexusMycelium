import type { ModelMessage, ModelPrice, ModelProvider, ModelUsage } from "./model.js";

export interface AgentLimits {
  maxSteps: number;
  maxToolCalls: number;
  timeoutMs: number;
}

/**
 * Why a budgeted run stopped. The kernel owns the vocabulary, and these are the exact constants a
 * loop reports in `AgentResult.error` — no count, price, model name, path, or provider text is ever
 * interpolated into one, so a stop cannot leak what the run spent. `budget:usage-unavailable` and
 * `budget:cost-unpriced` are the fail-closed pair: a meter that cannot be read, or a cost ceiling
 * whose model carries no price, stops the run rather than continuing unmeasured or unpriced.
 */
export const BUDGET_TIME = "budget:time";
export const BUDGET_TOKENS = "budget:tokens";
export const BUDGET_COST = "budget:cost";
export const BUDGET_USAGE_UNAVAILABLE = "budget:usage-unavailable";
export const BUDGET_COST_UNPRICED = "budget:cost-unpriced";

/** The whole vocabulary, in one list, so a consumer can switch on it without a second copy. */
export const BUDGET_STOP_REASONS = [
  BUDGET_TIME,
  BUDGET_TOKENS,
  BUDGET_COST,
  BUDGET_USAGE_UNAVAILABLE,
  BUDGET_COST_UNPRICED,
] as const;

export type BudgetStopReason = (typeof BUDGET_STOP_REASONS)[number];

/** The one text every budget stop carries, so a stop cannot leak its numbers in prose either. */
export const BUDGET_STOP_TEXT = "Agent stopped: budget reached.";

export interface BudgetPolicy {
  /** A disabled policy never stops a run, whatever limits it carries. */
  enabled: boolean;
  /** `null` means the limit is unset, not zero. */
  maxTotalTokens: number | null;
  maxCostUsd: number | null;
  maxElapsedMs: number | null;
  /**
   * USD per million tokens, keyed by the exact model identity a run is billed under. Empty means cost
   * cannot be bounded, and an armed cost ceiling on a model this map does not name is unenforceable.
   */
  prices: Readonly<Record<string, ModelPrice>>;
}

export const DEFAULT_BUDGET_POLICY: BudgetPolicy = Object.freeze({
  enabled: false,
  maxTotalTokens: null,
  maxCostUsd: null,
  maxElapsedMs: null,
  prices: Object.freeze({}),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** A zero price would price a whole dimension as free, so it is refused rather than accepted. */
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function countLimit(value: unknown, name: string): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || !nonNegative(value)) {
    throw new Error(`budget ${name} must be a non-negative integer or null`);
  }
  return value;
}

function costLimit(value: unknown): number | null {
  if (value === null) return null;
  if (!nonNegative(value)) throw new Error("budget maxCostUsd must be a non-negative number or null");
  return value;
}

function priceMap(value: unknown): Readonly<Record<string, ModelPrice>> {
  if (value === undefined) return Object.freeze({});
  if (!isRecord(value)) throw new Error("budget prices must be a record keyed by model name");
  const prices: Record<string, ModelPrice> = {};
  for (const [model, price] of Object.entries(value)) {
    if (
      !isRecord(price) ||
      !positive(price.inputUsdPerMillionTokens) ||
      !positive(price.outputUsdPerMillionTokens)
    ) {
      throw new Error(
        `budget prices.${model} must carry positive inputUsdPerMillionTokens and outputUsdPerMillionTokens`,
      );
    }
    prices[model] = {
      inputUsdPerMillionTokens: price.inputUsdPerMillionTokens,
      outputUsdPerMillionTokens: price.outputUsdPerMillionTokens,
    };
  }
  return Object.freeze(prices);
}

/**
 * Fills in the missing fields of a partial policy. Every limit is optional in, and an absent one
 * becomes `null` rather than a zero that would stop a run on its first step.
 */
export function resolveBudgetPolicy(overrides?: Partial<BudgetPolicy>): BudgetPolicy {
  if (overrides === undefined) return DEFAULT_BUDGET_POLICY;
  if (!isRecord(overrides)) throw new Error("budget policy must be an object");
  return Object.freeze({
    enabled: overrides.enabled === undefined ? DEFAULT_BUDGET_POLICY.enabled : overrides.enabled === true,
    maxTotalTokens:
      overrides.maxTotalTokens === undefined ? null : countLimit(overrides.maxTotalTokens, "maxTotalTokens"),
    maxCostUsd: overrides.maxCostUsd === undefined ? null : costLimit(overrides.maxCostUsd),
    maxElapsedMs:
      overrides.maxElapsedMs === undefined ? null : countLimit(overrides.maxElapsedMs, "maxElapsedMs"),
    prices: priceMap(overrides.prices),
  });
}

export interface AgentResult {
  status: "completed" | "stopped" | "error";
  text: string;
  steps: number;
  toolCalls: number;
  observations: string[];
  error?: string;
  /** Sum of the model turns of the run. Absent when no provider reported tokens. */
  usage?: ModelUsage;
}

export interface AgentStepRecord {
  step: number;
  messages: readonly ModelMessage[];
}

export interface AgentRunOptions {
  limits?: Partial<AgentLimits>;
  signal?: AbortSignal;
  /** Transcript of a previous run, replayed verbatim before the new task. */
  history?: readonly ModelMessage[];
  /** Called after every completed step with a snapshot of the transcript so far. */
  onStep?: (record: AgentStepRecord) => void | Promise<void>;
  /** Optional token, cost, and time ceilings for the run. */
  budget?: BudgetPolicy;
}

export interface AgentRunner {
  run(task: string, options?: AgentRunOptions): Promise<AgentResult>;
}

/**
 * A runner bound to one model. `modelName` is the resolved model identity a per-model price map is
 * keyed by, so a caller cannot hand a loop a model it has no name for and silently leave an armed
 * cost ceiling unpriceable. The loop receives it as its `modelIdentity`.
 */
export type AgentRunnerFactory = (model: ModelProvider, modelName: string) => AgentRunner;
