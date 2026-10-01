import { DEFAULT_ROUTER_MAX_TASK_CHARS } from "../kernel/src/config.js";

/**
 * Which model a run uses, decided before it starts (Task 4.5).
 *
 * The rule is one measurement on the task text and nothing else: no model call, no heuristic score,
 * no hidden state. That is deliberate. A router whose decision cannot be explained from the task
 * text is a router nobody can debug, and this codebase would rather be predictable than clever.
 *
 * `ponytail:` the ceiling is a character count, not a difficulty estimate. A 3.000-character task that
 * is trivial still goes to the strong model, and a 10-character task that is subtle still goes to the
 * cheap one. Replace it when there is a real difficulty signal to replace it with — measured
 * accuracy per bucket, from 4.6's report — and not before.
 */

export interface RouterPolicy {
  /** The model every run starts on. */
  cheapModel: string;
  /** The model a long task escalates to. */
  strongModel: string;
  /** Over this many task characters, the strong model runs instead. */
  maxTaskChars: number;
}

export interface RouterDecision {
  model: string;
  reason: "cheap" | "strong";
  taskChars: number;
}

/** The policy a resolved config carries, or `undefined` when routing is off or impossible. */
export function routerPolicy(config: {
  model: { model: string };
  plugin: Record<string, unknown>;
}): RouterPolicy | undefined {
  const block = config.plugin.router;
  if (!isRecord(block) || block.enabled !== true) return undefined;
  const strong = block.strong;
  if (typeof strong !== "string" || strong.length === 0) return undefined;
  if (strong === config.model.model) return undefined;
  const maxTaskChars =
    typeof block.maxTaskChars === "number" ? block.maxTaskChars : DEFAULT_ROUTER_MAX_TASK_CHARS;
  return { cheapModel: config.model.model, strongModel: strong, maxTaskChars };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pure and total: the same task text always decides the same model, for every caller. */
export function chooseRouterModel(task: string, policy: RouterPolicy): RouterDecision {
  const taskChars = task.trim().length;
  const strong = taskChars > policy.maxTaskChars;
  return {
    model: strong ? policy.strongModel : policy.cheapModel,
    reason: strong ? "strong" : "cheap",
    taskChars,
  };
}
