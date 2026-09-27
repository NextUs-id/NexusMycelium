import { describe, expect, it } from "vitest";
import type { AgentResult } from "./agent.js";
import {
  BUDGET_STOP_REASONS,
  BUDGET_STOP_TEXT,
  type BudgetPolicy,
  type BudgetStopReason,
  DEFAULT_BUDGET_POLICY,
  resolveBudgetPolicy,
} from "./agent.js";
import type { ModelResult, ModelUsage } from "./model.js";

const usage: ModelUsage = { inputTokens: 10, outputTokens: 5, totalTokens: 15, source: "provider" };

describe("budget policy", () => {
  it("is disabled by default with every limit unset", () => {
    expect(DEFAULT_BUDGET_POLICY).toEqual({
      enabled: false,
      maxTotalTokens: null,
      maxCostUsd: null,
      maxElapsedMs: null,
      prices: {},
    });
    expect(resolveBudgetPolicy()).toBe(DEFAULT_BUDGET_POLICY);
  });

  it("leaves absent limits null instead of zero", () => {
    const policy = resolveBudgetPolicy({ enabled: true });
    expect(policy).toEqual({ ...DEFAULT_BUDGET_POLICY, enabled: true });
    expect(policy.maxTotalTokens).toBeNull();
  });

  it("keeps explicit limits and prices", () => {
    const policy: BudgetPolicy = resolveBudgetPolicy({
      enabled: true,
      maxTotalTokens: 1000,
      maxCostUsd: 0.25,
      maxElapsedMs: 5000,
      prices: { "gpt-4o-mini": { inputUsdPerMillionTokens: 0.15, outputUsdPerMillionTokens: 0.6 } },
    });
    expect(policy.maxTotalTokens).toBe(1000);
    expect(policy.maxCostUsd).toBe(0.25);
    expect(policy.maxElapsedMs).toBe(5000);
    expect(policy.prices["gpt-4o-mini"]?.inputUsdPerMillionTokens).toBe(0.15);
  });

  it("refuses a non-integer token or time limit", () => {
    expect(() => resolveBudgetPolicy({ maxTotalTokens: 1.5 })).toThrow(/maxTotalTokens/);
    expect(() => resolveBudgetPolicy({ maxElapsedMs: -1 })).toThrow(/maxElapsedMs/);
  });

  it("refuses a negative or non-finite cost limit", () => {
    expect(() => resolveBudgetPolicy({ maxCostUsd: -0.01 })).toThrow(/maxCostUsd/);
    expect(() => resolveBudgetPolicy({ maxCostUsd: Number.NaN })).toThrow(/maxCostUsd/);
  });

  it("refuses a malformed price entry instead of guessing one", () => {
    expect(() =>
      resolveBudgetPolicy({ prices: { m: { inputUsdPerMillionTokens: -1, outputUsdPerMillionTokens: 1 } } }),
    ).toThrow(/prices\.m/);
    expect(() => resolveBudgetPolicy({ prices: { m: { inputUsdPerMillionTokens: 1 } } as never })).toThrow(
      /prices\.m/,
    );
    // A zero price would price a whole dimension as free and leave the cost cap looking enforced.
    expect(() =>
      resolveBudgetPolicy({ prices: { m: { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 1 } } }),
    ).toThrow(/prices\.m/);
  });

  it("keeps the stop reason vocabulary closed and constant", () => {
    // The kernel publishes the only names a run may stop with, and the loop reports these exact ones.
    expect([...BUDGET_STOP_REASONS]).toEqual([
      "budget:time",
      "budget:tokens",
      "budget:cost",
      "budget:usage-unavailable",
      "budget:cost-unpriced",
    ]);
    for (const reason of BUDGET_STOP_REASONS) expect(reason).toMatch(/^budget:[a-z-]+$/);
    // A stop reports the reason in `error`; the text is one constant, so nothing numeric rides out.
    expect(BUDGET_STOP_TEXT).toBe("Agent stopped: budget reached.");
    const reason: BudgetStopReason = "budget:cost";
    expect(reason).toBe("budget:cost");
  });
});

describe("usage is additive", () => {
  it("carries tokens on a model result", () => {
    const result: ModelResult = { type: "final", text: "done", usage };
    expect(result).toEqual({ type: "final", text: "done", usage });
  });

  it("leaves results without a report free of a usage field", () => {
    const result: ModelResult = { type: "final", text: "done" };
    const agent: AgentResult = {
      status: "completed",
      text: "done",
      steps: 1,
      toolCalls: 0,
      observations: [],
    };
    expect("usage" in result).toBe(false);
    expect("usage" in agent).toBe(false);
  });

  it("sums the turns of a run onto the agent result", () => {
    const agent: AgentResult = {
      status: "stopped",
      text: "stopped",
      steps: 2,
      toolCalls: 1,
      observations: [],
      error: "budget reached",
      usage,
    };
    expect(agent.usage?.totalTokens).toBe(15);
  });
});
