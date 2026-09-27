import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AgentRunnerFactory,
  BUDGET_STOP_REASONS,
  type BudgetPolicy,
  DEFAULT_BUDGET_POLICY,
  resolveBudgetPolicy,
} from "../kernel/src/agent.js";
import { resolveConfig } from "../kernel/src/config.js";
import { PermissionGate, Registry } from "../kernel/src/index.js";
import type { ModelPrice, ModelProvider, ModelResult, ModelUsage } from "../kernel/src/model.js";
import { ToolRegistry } from "../kernel/src/tools.js";
import loopReact, {
  BUDGET_COST,
  BUDGET_COST_UNPRICED,
  BUDGET_TIME,
  BUDGET_TOKENS,
  BUDGET_USAGE_UNAVAILABLE,
  createAgentRunner,
} from "../plugins/loop-react/src/index.js";
import toolsBasic from "../plugins/tools-basic/src/index.js";
import { createRuntimeRoot } from "./runtime.fixtures.js";
import { configBudget, createRuntime, runSession } from "./runtime.js";
import { createSandbox } from "./sandbox.js";
import { withSessionStore } from "./session.fixtures.js";

/**
 * Security contract for the Task 3.3 budget guard (token, cost, time), written against the real
 * types in `kernel/src/agent.ts` and the real enforcement in `plugins/loop-react`. Independent of
 * `kernel/src/budget.test.ts`, which covers the policy value object; this file covers what the guard
 * does to a run that is already in flight.
 *
 * `createAgentRunner` is the enforcement point, so every arm below drives that function with a fake
 * provider, a fake clock, and temp roots. Nothing here reaches a socket, a real key, or the host.
 */

/** The stop text the loop uses for every budget stop, so a reason can never ride out in prose. */
const budgetText = "Agent stopped: budget reached.";

/** The five constants a stop may report. No count, price, model, path, or provider text rides along. */
const budgetReasons = [
  BUDGET_TIME,
  BUDGET_TOKENS,
  BUDGET_COST,
  BUDGET_USAGE_UNAVAILABLE,
  BUDGET_COST_UNPRICED,
] as const;

/** $0.15 in / $0.60 out per million tokens, keyed by the model name the runner is told about. */
const mockPrice: ModelPrice = { inputUsdPerMillionTokens: 0.15, outputUsdPerMillionTokens: 0.6 };

/** Same shape as the loop's own defaults, so a run is never stopped for an unrelated reason. */
const loopLimits = { maxSteps: 8, maxToolCalls: 12, timeoutMs: 15_000 };

function usage(inputTokens: number, outputTokens: number, source = "provider"): ModelUsage {
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, source };
}

interface FakeModel {
  readonly model: ModelProvider;
  readonly calls: number;
  readonly signals: readonly (AbortSignal | undefined)[];
}

/** Fake provider: serves the answers in order, counts calls, keeps the signal it was handed. */
function fakeModel(...answers: ModelResult[]): FakeModel {
  if (answers.length === 0) throw new Error("a fake model needs at least one answer");
  const signals: (AbortSignal | undefined)[] = [];
  let calls = 0;
  return {
    model: {
      complete: async (_incoming, _tools, signal) => {
        signals.push(signal);
        const answer = answers[Math.min(calls, answers.length - 1)] ?? answers[0];
        calls += 1;
        return answer as ModelResult;
      },
    },
    get calls() {
      return calls;
    },
    get signals() {
      return signals;
    },
  };
}

/** A provider that never answers on its own, so only a signal can end the turn. */
function hangingModel(): FakeModel {
  const signals: (AbortSignal | undefined)[] = [];
  let calls = 0;
  return {
    model: {
      complete: (_incoming, _tools, signal) => {
        signals.push(signal);
        calls += 1;
        return new Promise<ModelResult>((_resolve, reject) => {
          const abort = (): void => reject(new Error("provider call aborted"));
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      },
    },
    get calls() {
      return calls;
    },
    get signals() {
      return signals;
    },
  };
}

/** One inert tool that records that it ran, so "a stopped turn executed nothing" is falsifiable. */
function probeTools(): { tools: ToolRegistry; executed: () => number } {
  const tools = new ToolRegistry();
  let executed = 0;
  tools.register({
    name: "probe",
    description: "records that it ran",
    inputSchema: { type: "object" },
    execute: async () => {
      executed += 1;
      return '{"ok":true,"output":"probe"}';
    },
  });
  return { tools, executed: () => executed };
}

function toolCall(secret: string): ModelResult {
  return {
    type: "tool_calls",
    calls: [{ id: "call-1", name: "probe", arguments: { note: secret } }],
  };
}

const networkRestores: (() => void)[] = [];

afterEach(() => {
  for (const restore of networkRestores.splice(0)) restore();
  vi.useRealTimers();
});

/** In-process fetch stub that fails loudly: a budget guard must never reach the network. */
function denyNetwork(): () => number {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("network access is not available to a budget guard");
  }) as typeof globalThis.fetch;
  const restore = (): void => {
    globalThis.fetch = previous;
  };
  networkRestores.push(restore);
  return () => calls;
}

/** Every constant a stop may report is a fixed token: no digit can leak a measured quantity. */
function expectConstantReasons(): void {
  expect(budgetReasons.every((reason) => /^budget:[a-z-]+$/.test(reason))).toBe(true);
  expect(new Set(budgetReasons).size).toBe(budgetReasons.length);
}

describe("budget guard security contract", () => {
  it("keeps the default policy off, with every limit unset rather than zero", () => {
    expect(DEFAULT_BUDGET_POLICY).toEqual({
      enabled: false,
      maxTotalTokens: null,
      maxCostUsd: null,
      maxElapsedMs: null,
      prices: {},
    });
    expect(resolveBudgetPolicy()).toBe(DEFAULT_BUDGET_POLICY);
    // A cap of zero would stop a run on its first turn; absent has to mean "no cap".
    expect(resolveBudgetPolicy({ enabled: true }).maxTotalTokens).toBeNull();
    expectConstantReasons();
  });

  it("arms no budget timer, keeps no usage, and stops nothing on the disabled default path", async () => {
    vi.useFakeTimers();
    const provider = fakeModel({ type: "final", text: "done", usage: usage(9_999, 9_999) });

    // Omitted policy: the loop's own timeout is the only timer a run may hold.
    const before = vi.getTimerCount();
    const running = createAgentRunner({
      model: provider.model,
      tools: new ToolRegistry(),
      limits: loopLimits,
    }).run("go");
    expect(vi.getTimerCount() - before).toBe(1);
    await vi.runAllTimersAsync();
    const result = await running;
    expect(result.status).toBe("completed");
    // A run nobody budgeted gains no `usage` key at all, not a fabricated zero.
    expect(result).not.toHaveProperty("usage");
    expect(provider.calls).toBe(1);
    expect(provider.signals[0]?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    // Explicitly disabled with the tightest caps possible: still one timer, still no stop, no usage.
    const off = resolveBudgetPolicy({
      enabled: false,
      maxTotalTokens: 1,
      maxCostUsd: 0.000_001,
      maxElapsedMs: 1,
      prices: { mock: mockPrice },
    });
    const armed = fakeModel({ type: "final", text: "done", usage: usage(9_999, 9_999) });
    const offCount = vi.getTimerCount();
    const offRun = createAgentRunner({
      model: armed.model,
      tools: new ToolRegistry(),
      limits: loopLimits,
      budget: off,
      modelIdentity: "mock",
    }).run("go");
    expect(vi.getTimerCount() - offCount).toBe(1);
    await vi.runAllTimersAsync();
    const offResult = await offRun;
    expect(offResult.status).toBe("completed");
    expect(offResult).not.toHaveProperty("usage");
    expect(offResult.error).toBeUndefined();
    expect(armed.calls).toBe(1);
    expect(armed.signals[0]?.aborted).toBe(false);
  });

  it("adds a second timer only for an enabled policy that carries an elapsed cap", async () => {
    vi.useFakeTimers();
    const withoutElapsed = createAgentRunner({
      model: fakeModel({ type: "final", text: "done", usage: usage(1, 1) }).model,
      tools: new ToolRegistry(),
      limits: loopLimits,
      budget: resolveBudgetPolicy({ enabled: true, maxTotalTokens: 1_000_000 }),
    });
    const first = vi.getTimerCount();
    const running = withoutElapsed.run("go");
    expect(vi.getTimerCount() - first).toBe(1);
    await vi.runAllTimersAsync();
    await running;

    const withElapsed = createAgentRunner({
      model: fakeModel({ type: "final", text: "done", usage: usage(1, 1) }).model,
      tools: new ToolRegistry(),
      limits: loopLimits,
      budget: resolveBudgetPolicy({ enabled: true, maxTotalTokens: 1_000_000, maxElapsedMs: 60_000 }),
    });
    const second = vi.getTimerCount();
    const elapsedRun = withElapsed.run("go");
    expect(vi.getTimerCount() - second).toBe(2);
    await vi.runAllTimersAsync();
    await elapsedRun;
  });

  it("stops on the token ceiling with the constant reason, and aborts the provider it called", async () => {
    const provider = fakeModel({ type: "final", text: "done", usage: usage(60, 60) });
    const runner = createAgentRunner({
      model: provider.model,
      tools: new ToolRegistry(),
      limits: loopLimits,
      budget: resolveBudgetPolicy({ enabled: true, maxTotalTokens: 100 }),
    });
    const result = await runner.run("go");
    expect(result.status).toBe("stopped");
    expect(result.error).toBe(BUDGET_TOKENS);
    expect(result.text).toBe(budgetText);
    expect(result.steps).toBe(1);
    // The turn that breached the cap is charged, and the provider is told to stop.
    expect(result.usage).toMatchObject({ totalTokens: 120, source: "provider" });
    expect(provider.calls).toBe(1);
    expect(provider.signals[0]?.aborted).toBe(true);
  });

  it("stops on the cost ceiling at the boundary and lets a turn under it through", async () => {
    const price: BudgetPolicy = resolveBudgetPolicy({
      enabled: true,
      maxCostUsd: 0.5,
      prices: { mock: mockPrice },
    });
    const under = probeTools();
    const cheap = fakeModel(
      { ...toolCall("cheap"), usage: usage(3_000_000, 0) },
      // The second turn still has to report usage, or an armed cost cap refuses it as unmetered.
      { type: "final", text: "done", usage: usage(0, 0) },
    );
    const underResult = await createAgentRunner({
      model: cheap.model,
      tools: under.tools,
      limits: loopLimits,
      budget: price,
      modelIdentity: "mock",
    }).run("go");
    // $0.45 of a $0.50 cap: the turn is answered and its tool runs.
    expect(underResult.status).toBe("completed");
    expect(under.executed()).toBe(1);

    const over = probeTools();
    const dear = fakeModel({ ...toolCall("expensive"), usage: usage(4_000_000, 0) });
    const overResult = await createAgentRunner({
      model: dear.model,
      tools: over.tools,
      limits: loopLimits,
      budget: price,
      modelIdentity: "mock",
    }).run("go");
    expect(overResult.status).toBe("stopped");
    expect(overResult.error).toBe(BUDGET_COST);
    expect(overResult.text).toBe(budgetText);
    // A stopped turn is charged before it is acted on, so it bills for nothing it skipped.
    expect(over.executed()).toBe(0);
    expect(dear.signals[0]?.aborted).toBe(true);
    for (const observation of overResult.observations) {
      // The only observation a stop may add is the constant reason, never the call's arguments.
      expect(observation).toBe('{"ok":false,"error":"budget:cost"}');
      expect(observation).not.toContain("expensive");
    }
  });

  it("stops on the elapsed ceiling with a fake clock and cancels the turn in flight", async () => {
    vi.useFakeTimers();
    const provider = hangingModel();
    const runner = createAgentRunner({
      model: provider.model,
      tools: new ToolRegistry(),
      limits: loopLimits,
      budget: resolveBudgetPolicy({ enabled: true, maxElapsedMs: 1, maxTotalTokens: 1_000_000 }),
      // No model identity is needed: a token-only policy must not be blocked by a missing price.
    });
    const running = runner.run("go");
    await vi.advanceTimersByTimeAsync(1);
    const result = await running;
    expect(result.status).toBe("stopped");
    expect(result.error).toBe(BUDGET_TIME);
    expect(result.text).toBe(budgetText);
    expect(provider.calls).toBe(1);
    expect(provider.signals[0]?.aborted).toBe(true);
  });

  it("returns one constant reason per arm, whatever the overrun and whatever the transcript held", async () => {
    const secret = "sk-live-0123456789abcdefghij";
    const bearer = "Bearer [REDACTED:jwt].c2ln";
    const baseUrl = "https://provider.invalid/v1/chat";
    const task = `rotate ${secret} for ${bearer} at ${baseUrl}`;

    for (const payload of ["say hello", task]) {
      for (const factor of [1, 1_000]) {
        const byTokens = fakeModel({ type: "final", text: payload, usage: usage(50, 50 * factor) });
        const tokenResult = await createAgentRunner({
          model: byTokens.model,
          tools: new ToolRegistry(),
          limits: loopLimits,
          budget: resolveBudgetPolicy({ enabled: true, maxTotalTokens: 100 }),
        }).run(payload);
        expect(tokenResult.error).toBe(BUDGET_TOKENS);

        const byCost = fakeModel({ type: "final", text: payload, usage: usage(4_000_000 * factor, 0) });
        const costResult = await createAgentRunner({
          model: byCost.model,
          tools: new ToolRegistry(),
          limits: loopLimits,
          budget: resolveBudgetPolicy({ enabled: true, maxCostUsd: 0.5, prices: { mock: mockPrice } }),
          modelIdentity: "mock",
        }).run(payload);
        expect(costResult.error).toBe(BUDGET_COST);
      }
    }
    expectConstantReasons();
  });

  it("fails closed when a provider reports no usage instead of counting zero", async () => {
    const silent = fakeModel({ type: "final", text: "done" });
    const silentResult = await createAgentRunner({
      model: silent.model,
      tools: new ToolRegistry(),
      limits: loopLimits,
      budget: resolveBudgetPolicy({ enabled: true, maxTotalTokens: 1_000_000 }),
    }).run("go");
    expect(silentResult.status).toBe("stopped");
    expect(silentResult.error).toBe(BUDGET_USAGE_UNAVAILABLE);
    expect(silentResult.text).toBe(budgetText);
    // Nothing is invented: no usage key, and no accumulated tokens.
    expect(silentResult).not.toHaveProperty("usage");
    expect(silent.signals[0]?.aborted).toBe(true);

    // Counts that cross a trust boundary are dropped rather than trusted, which is the same refusal.
    for (const bad of [
      { inputTokens: -1, outputTokens: 1, totalTokens: 0, source: "provider" },
      { inputTokens: 1, outputTokens: 1, totalTokens: 2, source: "" },
      { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      { inputTokens: 1, outputTokens: 1, totalTokens: Number.NaN, source: "provider" },
    ]) {
      const lying = fakeModel({ type: "final", text: "done", usage: bad as unknown as ModelUsage });
      const result = await createAgentRunner({
        model: lying.model,
        tools: new ToolRegistry(),
        limits: loopLimits,
        budget: resolveBudgetPolicy({ enabled: true, maxTotalTokens: 1_000_000 }),
      }).run("go");
      expect(result.status).toBe("stopped");
      expect(result.error).toBe(BUDGET_USAGE_UNAVAILABLE);
    }

    // An enabled policy with no cap at all has nothing to enforce, so absent usage is not a stop.
    const uncapped = fakeModel({ type: "final", text: "done" });
    const uncappedResult = await createAgentRunner({
      model: uncapped.model,
      tools: new ToolRegistry(),
      limits: loopLimits,
      budget: resolveBudgetPolicy({ enabled: true }),
    }).run("go");
    expect(uncappedResult.status).toBe("completed");
    expect(uncappedResult).not.toHaveProperty("usage");
  });

  it("fails closed when the model has no price instead of assuming the run is free", async () => {
    const priced: BudgetPolicy = resolveBudgetPolicy({
      enabled: true,
      maxCostUsd: 0.5,
      prices: { mock: mockPrice },
    });
    for (const modelIdentity of [undefined, "other-model", "toString", "constructor"]) {
      const provider = fakeModel({ type: "final", text: "done", usage: usage(1, 1) });
      const result = await createAgentRunner({
        model: provider.model,
        tools: new ToolRegistry(),
        limits: loopLimits,
        budget: priced,
        ...(modelIdentity === undefined ? {} : { modelIdentity }),
      }).run("go");
      expect(result.status, `identity ${String(modelIdentity)}`).toBe("stopped");
      expect(result.error, `identity ${String(modelIdentity)}`).toBe(BUDGET_COST_UNPRICED);
      expect(result.text).toBe(budgetText);
      expect(provider.signals[0]?.aborted).toBe(true);
    }

    // Scoped to the cost arm: a token-only ceiling needs no price, so an unpriced model must not stop.
    const tokensOnly = fakeModel({ type: "final", text: "done", usage: usage(1, 1) });
    const tokenResult = await createAgentRunner({
      model: tokensOnly.model,
      tools: new ToolRegistry(),
      limits: loopLimits,
      budget: resolveBudgetPolicy({ enabled: true, maxTotalTokens: 1_000_000 }),
    }).run("go");
    expect(tokenResult.status).toBe("completed");
  });

  it("refuses a half-written price pair instead of completing it with a zero", async () => {
    const root = await createRuntimeRoot(
      "budget:\n  enabled: true\n  maxCostUsd: 1\n  prices:\n    mock:\n      inputUsdPerMillionTokens: 0.15\n",
    );
    // A missing output price would price a whole dimension as free and leave the cap looking
    // enforced, so the closed config shape refuses the pair before any policy is built.
    await expect(resolveConfig(root)).rejects.toThrow(/budget\.prices\.mock/);
  });

  it("lets no overlay arm, weaken, or malformed a budget past the closed config shape", async () => {
    // Caps that are not a positive number are a refusal, so `0` and `Infinity` cannot mean "off".
    for (const cap of ["0", "-1", "1e999", "1.5", '"1"', "true"]) {
      const root = await createRuntimeRoot(`budget:\n  enabled: true\n  maxTotalTokens: ${cap}\n`);
      await expect(resolveConfig(root), `maxTotalTokens: ${cap}`).rejects.toThrow(/invalid configuration/);
    }
    for (const cap of ["0", "-0.01", "1e999", '"1"']) {
      const root = await createRuntimeRoot(`budget:\n  enabled: true\n  maxCostUsd: ${cap}\n`);
      await expect(resolveConfig(root), `maxCostUsd: ${cap}`).rejects.toThrow(/invalid configuration/);
    }
    // An unknown key under budget is not a new lever, and neither is a bare pair with no model or a
    // stale `inputUsdPerMillion` field name left over from the old flat shape.
    for (const overlay of [
      "budget:\n  enabled: true\n  maxLimit: 100\n",
      "budget:\n  enabled: true\n  prices:\n    mock:\n      inputUsdPerMillionTokens: 1\n",
      "budget:\n  enabled: true\n  prices:\n    mock:\n      inputUsdPerMillion: 1\n",
      "budget:\n  enabled: true\n  prices:\n    mock:\n      inputUsdPerMillionTokens: 0\n      outputUsdPerMillionTokens: 1\n",
      "budget:\n  enabled: true\n  prices:\n    inputUsdPerMillionTokens: 1\n",
      "budget:\n  __proto__:\n    enabled: true\n",
    ]) {
      const root = await createRuntimeRoot(overlay);
      await expect(resolveConfig(root), overlay).rejects.toThrow();
    }
    // Caps present but disabled resolve to no policy at all, so a config cannot arm itself by omission.
    const off = await resolveConfig(
      await createRuntimeRoot("budget:\n  enabled: false\n  maxTotalTokens: 10\n"),
    );
    expect(configBudget(off)).toBeUndefined();
  });

  it("takes the budget from the runtime, not from the caller, the transcript, or a plugin overlay", async () => {
    const root = await createRuntimeRoot(
      "budget:\n  enabled: true\n  maxTotalTokens: 1000000\n",
      "model:\n  provider: mock\n  model: mock\n",
    );
    const runtime = await createRuntime({ root, modelProvider: "mock" });
    try {
      expect(runtime.budget).toMatchObject({ enabled: true, maxTotalTokens: 1_000_000 });
      await withSessionStore(async ({ store }) => {
        // A caller-supplied budget is not part of the session surface, so one smuggled through the
        // options object is dropped rather than adopted. The mock provider reports no usage, which an
        // armed token cap must refuse.
        const smuggled = {
          task: "say hello",
          store,
          budget: { enabled: false, maxTotalTokens: null, maxCostUsd: null, maxElapsedMs: null, prices: {} },
        } as Parameters<typeof runSession>[1];
        const run = await runSession(runtime, smuggled);
        expect(run.result.status).toBe("stopped");
        expect(run.result.error).toBe(BUDGET_USAGE_UNAVAILABLE);
        // Nothing budget-shaped is persisted, so a stored transcript can never restore a weaker cap.
        const records = await store.load(run.sessionId);
        expect(records.at(-1)).toMatchObject({ type: "run-end", status: "stopped" });
        for (const record of records) {
          expect(Object.keys(record), "the record envelope is closed").not.toContain("budget");
        }
        expect(JSON.stringify(records)).not.toContain("maxTotalTokens");
      });
    } finally {
      await runtime.close();
    }
  });

  it("does not let a resume weaken the limits its last run recorded", async () => {
    const root = await createRuntimeRoot("permissions:\n  fs.write: allow\n");
    const runtime = await createRuntime({ root, modelProvider: "mock" });
    try {
      await withSessionStore(async ({ store }) => {
        const id = await store.appendStart({
          provider: "mock",
          model: "mock",
          task: "write file notes.txt with content hello",
        });
        await store.appendStep(id, {
          step: 1,
          messages: [{ role: "user", content: "write file notes.txt with content hello" }],
        });
        await store.appendEnd(id, { status: "completed", text: "done", limits: { maxSteps: 1 } });

        const run = await runSession(runtime, {
          task: "say hello",
          store,
          sessionId: id,
          limits: { maxSteps: 8, timeoutMs: 15_000 },
        });
        expect(run.result.status).toBe("stopped");
        expect(run.result.error).toBe("step limit reached");
        // The tighter recorded limit is what the new run is stamped with, not the caller's number.
        const ends = (await store.load(id)).filter((record) => record.type === "run-end");
        expect(ends).toMatchObject([
          { status: "completed", limits: { maxSteps: 1 } },
          { status: "stopped", limits: { maxSteps: 1 } },
        ]);

        // A later record cannot hand the session back a wider ceiling than an earlier one recorded.
        await store.appendEnd(id, { status: "completed", text: "tampered", limits: { maxSteps: 64 } });
        const again = await runSession(runtime, {
          task: "say hello again",
          store,
          sessionId: id,
          limits: { maxSteps: 64 },
        });
        expect(again.result.usage).toBeUndefined();
        expect((await store.load(id)).at(-1)).toMatchObject({ limits: { maxSteps: 1 } });
      });
    } finally {
      await runtime.close();
    }
  });

  it("leaves a sandbox with no budget and an empty overlay that could not arm one", async () => {
    const sandbox = await createSandbox();
    try {
      expect(sandbox.config.budget.enabled).toBe(false);
      // Off in config means no policy at all, so the sandbox cannot meter by accident.
      expect(configBudget(sandbox.config)).toBeUndefined();
      const written = await readFile(join(sandbox.root, "config", "default.yaml"), "utf8");
      expect(written).not.toMatch(/budget/i);
      expect(await readdir(join(sandbox.root, "user"))).toEqual([]);
      expect(sandbox.config.permissions.network).toBe("deny");
      expect(sandbox.config.model.provider).toBe("mock");

      const outcome = await sandbox.run("say hello");
      // The closed envelope gains no usage or budget key from the guard.
      expect(Object.keys(outcome).sort()).toEqual(["status", "steps", "toolCalls"]);
    } finally {
      await sandbox.dispose();
    }
  });

  it("meters a configured cost cap instead of refusing it as unpriced", async () => {
    const root = await createRuntimeRoot(
      "budget:\n  enabled: true\n  maxCostUsd: 0.5\n  prices:\n    mock:\n      inputUsdPerMillionTokens: 0.15\n      outputUsdPerMillionTokens: 0.6\n",
      "model:\n  provider: mock\n  model: mock\n",
    );
    const runtime = await createRuntime({ root, modelProvider: "mock" });
    try {
      // The config carries a price for the model this runtime calls.
      expect(runtime.budget?.prices.mock).toEqual(mockPrice);
      await withSessionStore(async ({ store }) => {
        const run = await runSession(runtime, { task: "say hello", store });
        // A runner that knows the model it calls can price the run; unpriced means the map was
        // unreachable, which would leave the cost cap unenforced while looking configured.
        expect(run.result.error).not.toBe(BUDGET_COST_UNPRICED);
        // The mock provider reports no usage, which an armed cost ceiling fails closed on instead.
        expect(run.result.error).toBe(BUDGET_USAGE_UNAVAILABLE);
      });
    } finally {
      await runtime.close();
    }
  });

  it("enforces a configured cost cap on a real loop, priced by the configured model", async () => {
    // The whole path, not one layer of it: a per-model price in config becomes a policy, the loop
    // plugin's own factory receives the model name, and the cap fires on real token counts.
    const root = await createRuntimeRoot(
      [
        "budget:",
        "  enabled: true",
        "  maxCostUsd: 0.5",
        "  prices:",
        "    test/model:",
        "      inputUsdPerMillionTokens: 0.15",
        "      outputUsdPerMillionTokens: 0.6",
        "",
      ].join("\n"),
      "model:\n  provider: mock\n  model: test/model\n",
    );
    const registry = new Registry(
      { info() {}, warn() {}, error() {} },
      (name) => (name === "tools-basic" ? { root } : name === "loop-react" ? {} : {}),
      new PermissionGate({ "fs.read": "allow", "fs.write": "deny", shell: "deny", network: "deny" }),
    );
    registry.register(toolsBasic);
    registry.register(loopReact);
    try {
      const config = await resolveConfig(root);
      const budget = configBudget(config);
      expect(budget?.prices["test/model"]).toEqual(mockPrice);
      await registry.load("loop-react");
      const factory = registry.services.get<AgentRunnerFactory>("agent:runner-factory");
      const tools = probeTools();
      // $0.60 of a $0.50 cap: the turn is charged before it is acted on, so nothing runs.
      const provider = fakeModel({ ...toolCall("spend"), usage: usage(4_000_000, 0) });
      const result = await factory(provider.model, config.model.model).run("go", { budget });
      expect(result).toMatchObject({ status: "stopped", error: BUDGET_COST, text: budgetText });
      expect(tools.executed()).toBe(0);
      expect(provider.signals[0]?.aborted).toBe(true);

      // The same policy with no price for the model in play refuses instead of running unpriced.
      const unpriced = fakeModel({ ...toolCall("spend"), usage: usage(4_000_000, 0) });
      const refused = await factory(unpriced.model, "other/model").run("go", { budget });
      expect(refused).toMatchObject({ status: "stopped", error: BUDGET_COST_UNPRICED });
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports the kernel's stop reason vocabulary as the one the loop actually emits", () => {
    // The kernel publishes the reason names a caller may switch on. Set equality both ways: a reason
    // the loop emits that the kernel does not publish, or a published name nothing emits, is the same
    // dead second vocabulary this test exists to catch.
    expect([...BUDGET_STOP_REASONS].sort()).toEqual([...budgetReasons].sort());
    expectConstantReasons();
  });

  it("stops and reports across every arm with no network access at all", async () => {
    const network = denyNetwork();
    const root = await createRuntimeRoot(
      "budget:\n  enabled: true\n  maxTotalTokens: 1000000\n",
      "model:\n  provider: mock\n  model: mock\n",
    );
    const runtime = await createRuntime({ root, modelProvider: "mock" });
    try {
      await withSessionStore(async ({ store }) => {
        const run = await runSession(runtime, { task: "say hello", store });
        expect(run.result.status).toBe("stopped");
        const envelope = JSON.stringify(run.result);
        // The stop is a constant, so nothing the run touched can ride out with it.
        for (const leak of [
          "sk-live",
          "eyJhbGciOiJIUzI1NiJ9",
          "provider.invalid",
          "api.openai.com",
          "Bearer",
        ]) {
          expect(envelope, `stop output must not carry ${leak}`).not.toContain(leak);
        }
        expect(run.result.error).toBe(BUDGET_USAGE_UNAVAILABLE);
        expect(run.result.text).toBe(budgetText);
      });
    } finally {
      await runtime.close();
    }
    expect(network()).toBe(0);
  });
});
