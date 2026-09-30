import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  type BudgetPolicy,
  PermissionGate,
  Registry,
  resolveBudgetPolicy,
} from "../../../kernel/src/index.js";
import type {
  ModelMessage,
  ModelProvider,
  ModelResult,
  ModelToolDefinition,
  ModelUsage,
} from "../../../kernel/src/model.js";
import { ToolRegistry } from "../../../kernel/src/tools.js";
import { createRuntime } from "../../../src/runtime.js";
import { createSessionStore } from "../../../src/session.js";
import { createMockModel } from "../../model-openai/src/index.js";
import toolsBasic from "../../tools-basic/src/index.js";
import loopReact, {
  type AgentRunnerFactory,
  type AgentStepRecord,
  BUDGET_COST,
  BUDGET_COST_UNPRICED,
  BUDGET_TEXT,
  BUDGET_TIME,
  BUDGET_TOKENS,
  BUDGET_USAGE_UNAVAILABLE,
  type CompactionPolicy,
  createAgentRunner,
} from "./index.js";

const silent = { info() {}, warn() {}, error() {} };

function sequence(results: readonly ModelResult[]): ModelProvider {
  let index = 0;
  return {
    async complete() {
      const result = results[Math.min(index, results.length - 1)];
      index += 1;
      if (!result) throw new Error("test model has no result");
      return result;
    },
  };
}

function recorder(results: readonly ModelResult[]): {
  model: ModelProvider;
  seen: ModelMessage[][];
  seenTools: ModelToolDefinition[][];
} {
  const seen: ModelMessage[][] = [];
  const seenTools: ModelToolDefinition[][] = [];
  let index = 0;
  return {
    seen,
    seenTools,
    model: {
      async complete(messages, tools) {
        seen.push(messages.slice());
        seenTools.push(tools.map((tool) => ({ ...tool })));
        const result = results[Math.min(index, results.length - 1)];
        index += 1;
        if (!result) throw new Error("test model has no result");
        return result;
      },
    },
  };
}

function echoTools(): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register({
    name: "echo",
    description: "echo",
    inputSchema: { type: "object" },
    execute: async () => "two",
  });
  return tools;
}

const storedHistory: ModelMessage[] = [
  { role: "system", content: "stored system prompt" },
  { role: "user", content: "first task" },
  {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "call-1", name: "echo", arguments: { value: 1 } }],
  },
  { role: "tool", content: '{"ok":true,"output":"one"}', toolCallId: "call-1" },
];

describe("loop-react", () => {
  it("turns an unknown tool into a safe observation and reaches final", async () => {
    const model = sequence([
      { type: "tool_calls", calls: [{ id: "1", name: "missing", arguments: {} }] },
      { type: "final", text: "finished safely" },
    ]);
    const runner = createAgentRunner({
      model,
      tools: new ToolRegistry(),
      limits: { maxSteps: 3, maxToolCalls: 3, timeoutMs: 1000 },
    });
    const result = await runner.run("test");
    expect(result.status).toBe("error");
    expect(result.text).toBe("finished safely");
    expect(result.error).toContain("unknown tool");
    expect(result.observations[0]).toContain("unknown tool");
  });

  it("turns permission errors into safe observations", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "write_text",
      description: "blocked",
      inputSchema: { type: "object" },
      execute: async () => {
        throw new Error("permission denied: fs.write");
      },
    });
    const runner = createAgentRunner({
      model: sequence([
        { type: "tool_calls", calls: [{ id: "1", name: "write_text", arguments: {} }] },
        { type: "final", text: "stopped safely" },
      ]),
      tools,
      limits: { maxSteps: 3, maxToolCalls: 3, timeoutMs: 1000 },
    });
    const result = await runner.run("write");
    expect(result.status).toBe("error");
    expect(result.error).toContain("permission denied");
    expect(result.observations[0]).toContain("permission denied");
    expect(result.text).toBe("stopped safely");
  });

  it("reports completion after a tool failure is successfully recovered", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "recover",
      description: "recover",
      inputSchema: { type: "object" },
      execute: async () => "ok",
    });
    const runner = createAgentRunner({
      model: sequence([
        { type: "tool_calls", calls: [{ id: "1", name: "missing", arguments: {} }] },
        { type: "tool_calls", calls: [{ id: "2", name: "recover", arguments: {} }] },
        { type: "final", text: "recovered" },
      ]),
      tools,
      limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 1000 },
    });
    const result = await runner.run("recover");
    expect(result.status).toBe("completed");
    expect(result.text).toBe("recovered");
    expect(result.error).toBeUndefined();
  });

  it("enforces tool-call and timeout limits", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "echo",
      description: "echo",
      inputSchema: { type: "object" },
      execute: async () => "ok",
    });
    const model: ModelProvider = {
      complete: async () => ({ type: "tool_calls", calls: [{ id: "1", name: "echo", arguments: {} }] }),
    };
    const limited = await createAgentRunner({
      model,
      tools,
      limits: { maxSteps: 4, maxToolCalls: 1, timeoutMs: 1000 },
    }).run("repeat");
    expect(limited.status).toBe("stopped");
    expect(limited.toolCalls).toBe(1);
    expect(limited.text).toContain("tool call limit");
    let modelSignal: AbortSignal | undefined;
    const waiting: ModelProvider = {
      complete: (_messages, _tools, signal) => {
        modelSignal = signal;
        return new Promise<ModelResult>(() => {});
      },
    };
    const timedOut = await createAgentRunner({
      model: waiting,
      tools: new ToolRegistry(),
      limits: { maxSteps: 2, maxToolCalls: 2, timeoutMs: 20 },
    }).run("wait");
    expect(timedOut.status).toBe("stopped");
    expect(timedOut.error).toBe("agent timeout");
    expect(modelSignal?.aborted).toBe(true);
  });

  it("waits for a non-cancellable tool side effect after abort", async () => {
    const tools = new ToolRegistry();
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    let toolSignal: AbortSignal | undefined;
    let sideEffectFinished = false;
    tools.register({
      name: "write_once",
      description: "non-cancellable side effect",
      inputSchema: { type: "object" },
      execute: async (_input, signal) => {
        toolSignal = signal;
        await blocker;
        sideEffectFinished = true;
        return "ok";
      },
    });
    const running = createAgentRunner({
      model: sequence([{ type: "tool_calls", calls: [{ id: "1", name: "write_once", arguments: {} }] }]),
      tools,
      limits: { maxSteps: 2, maxToolCalls: 2, timeoutMs: 100 },
    }).run("write");
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(toolSignal?.aborted).toBe(true);
    let settled = false;
    void running.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    const result = await running;
    expect(sideEffectFinished).toBe(true);
    expect(result.status).toBe("stopped");
    expect(result.error).toBe("agent timeout");
  });

  it("loads tools-basic and exposes a runner factory", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-loop-"));
    const registry = new Registry(
      silent,
      (name) =>
        name === "tools-basic"
          ? { root }
          : name === "loop-react"
            ? { maxSteps: 3, maxToolCalls: 3, timeoutMs: 1000 }
            : {},
      new PermissionGate({ "fs.read": "allow", "fs.write": "allow", shell: "deny" }),
    );
    registry.register(toolsBasic);
    registry.register(loopReact);
    try {
      await registry.load("loop-react");
      const factory = registry.services.get<AgentRunnerFactory>("agent:runner-factory");
      const result = await factory(createMockModel(), "mock").run(
        'write file "note.txt" with content "hello" and read note.txt',
      );
      expect(result).toMatchObject({ status: "completed", toolCalls: 2 });
      expect(await readFile(join(root, "note.txt"), "utf8")).toBe("hello");
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("integrates through runtime plugin discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-runtime-"));
    await mkdir(join(root, "config"), { recursive: true });
    await mkdir(join(root, "user"), { recursive: true });
    await writeFile(
      join(root, "config", "default.yaml"),
      "model:\n  provider: mock\n  model: mock\n",
      "utf8",
    );
    await writeFile(join(root, "user", "config.yaml"), "permissions:\n  network: deny\n", "utf8");
    let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
    try {
      runtime = await createRuntime({
        root,
        modelProvider: "mock",
        askPermission: () => true,
      });
      expect(runtime.tools.has("read_text")).toBe(true);
      expect(runtime.tools.has("write_text")).toBe(true);
      expect(runtime.tools.has("shell")).toBe(true);
      const result = await runtime.runner.run("say hello");
      expect(result.status).toBe("completed");
    } finally {
      await runtime?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("loop-react resume hooks", () => {
  const limits = { maxSteps: 4, maxToolCalls: 4, timeoutMs: 1000 };

  it("replays a seeded history before the new task and never mutates it", async () => {
    const { model, seen } = recorder([{ type: "final", text: "resumed" }]);
    const result = await createAgentRunner({ model, tools: echoTools(), limits }).run("second task", {
      history: storedHistory,
    });
    expect(result).toMatchObject({ status: "completed", text: "resumed", steps: 1 });
    expect(seen[0]).toEqual([...storedHistory, { role: "user", content: "second task" }]);
    expect(seen[0]).not.toBe(storedHistory);
    expect(storedHistory).toHaveLength(4);
  });

  it("treats an empty history as a fresh run", async () => {
    const { model, seen } = recorder([{ type: "final", text: "fresh" }]);
    await createAgentRunner({ model, tools: echoTools(), limits }).run("task", { history: [] });
    expect(seen[0]?.[0]?.role).toBe("system");
    expect(seen[0]).toHaveLength(2);
  });

  it("keeps stored tool call ids paired and appends the resumed tool pair after them", async () => {
    const { model, seen } = recorder([
      { type: "tool_calls", calls: [{ id: "call-2", name: "echo", arguments: { value: 2 } }] },
      { type: "final", text: "done" },
    ]);
    const result = await createAgentRunner({ model, tools: echoTools(), limits }).run("second task", {
      history: storedHistory,
    });
    expect(result).toMatchObject({ status: "completed", toolCalls: 1 });
    expect(seen[1]).toEqual([
      ...storedHistory,
      { role: "user", content: "second task" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-2", name: "echo", arguments: { value: 2 } }],
      },
      { role: "tool", content: '{"ok":true,"output":"two"}', toolCallId: "call-2" },
    ]);
  });

  it("hands onStep a growing private snapshot per completed step", async () => {
    const snapshots: AgentStepRecord[] = [];
    const lengths: number[] = [];
    const { model, seen } = recorder([
      { type: "tool_calls", calls: [{ id: "call-1", name: "echo", arguments: { value: 1 } }] },
      { type: "tool_calls", calls: [{ id: "call-2", name: "echo", arguments: { value: 2 } }] },
      { type: "final", text: "done" },
    ]);
    const result = await createAgentRunner({ model, tools: echoTools(), limits }).run("task", {
      onStep: (record) => {
        lengths.push(record.messages.length);
        snapshots.push(record);
        // A hook that mutates its snapshot must not corrupt the live transcript.
        if (record.step === 1)
          (record.messages as ModelMessage[]).push({ role: "user", content: "injected" });
      },
    });
    expect(result).toMatchObject({ status: "completed", steps: 3, toolCalls: 2 });
    expect(snapshots.map((record) => record.step)).toEqual([1, 2, 3]);
    expect(lengths).toEqual([4, 6, 6]);
    expect(snapshots[0]?.messages).not.toBe(snapshots[1]?.messages);
    expect(snapshots[2]?.messages.some((message) => message.content === "injected")).toBe(false);
    expect(seen[1]).toHaveLength(4);
    expect(seen[2]).toHaveLength(6);
  });

  it("sums the cache reads a provider reports and drops the block when one is not a count", async () => {
    const cached = (value: unknown): ModelUsage => ({
      inputTokens: 1200,
      outputTokens: 80,
      totalTokens: 1280,
      source: "model-openai",
      ...(value === undefined ? {} : { cachedTokens: value as number }),
    });
    const { model } = recorder([
      {
        type: "tool_calls",
        calls: [{ id: "call-1", name: "echo", arguments: { value: 1 } }],
        usage: cached(1024),
      },
      { type: "final", text: "done", usage: cached(64) },
    ]);
    const metered = await createAgentRunner({
      model,
      tools: echoTools(),
      limits,
      budget: resolveBudgetPolicy({ enabled: true, maxTotalTokens: 100_000 }),
    }).run("cache reads");
    expect(metered.usage).toEqual({
      inputTokens: 2400,
      outputTokens: 160,
      totalTokens: 2560,
      source: "model-openai",
      cachedTokens: 1088,
    });

    for (const bad of [-1, 1.5, Number.NaN, "1024", null]) {
      const broken = createAgentRunner({
        model: sequence([{ type: "final", text: "done", usage: cached(bad) }]),
        tools: echoTools(),
        limits,
        budget: resolveBudgetPolicy({ enabled: true, maxTotalTokens: 100_000 }),
      });
      // A malformed cache-read count fails closed with the whole usage block, never as a partial one.
      const result = await broken.run("bad cache reads");
      expect(result).toMatchObject({ status: "stopped", error: BUDGET_USAGE_UNAVAILABLE });
      expect(result.usage).toBeUndefined();
    }
  });

  it("accepts usage written before the cache-read count existed", async () => {
    // Compatibility lock for the 4.1b contract change: a report shaped the way every reader wrote it
    // before `cachedTokens` existed must stay fully usable, and must not grow a fabricated zero.
    const oldShape: ModelUsage = {
      inputTokens: 900,
      outputTokens: 60,
      totalTokens: 960,
      source: "model-openai",
    };
    const result = await createAgentRunner({
      model: sequence([
        {
          type: "tool_calls",
          calls: [{ id: "call-1", name: "echo", arguments: { value: 1 } }],
          usage: oldShape,
        },
        { type: "final", text: "done", usage: oldShape },
      ]),
      tools: echoTools(),
      limits,
      budget: resolveBudgetPolicy({
        enabled: true,
        maxTotalTokens: 10_000,
        prices: { mock: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 } },
      }),
    }).run("old shape");
    expect(result).toMatchObject({ status: "completed", steps: 2, toolCalls: 1 });
    expect(result.usage).toEqual({
      inputTokens: 1800,
      outputTokens: 120,
      totalTokens: 1920,
      source: "model-openai",
    });
    // Absent stays absent: an unreported cache read is never zero-filled, which would under-report.
    expect(result.usage).not.toHaveProperty("cachedTokens");
    // A reported zero is a real report and survives as a zero.
    const zero = await createAgentRunner({
      model: sequence([{ type: "final", text: "done", usage: { ...oldShape, cachedTokens: 0 } }]),
      tools: echoTools(),
      limits,
      budget: resolveBudgetPolicy({ enabled: true, maxTotalTokens: 10_000 }),
    }).run("zero cache reads");
    expect(zero.usage).toEqual({
      inputTokens: 900,
      outputTokens: 60,
      totalTokens: 960,
      source: "model-openai",
      cachedTokens: 0,
    });
  });

  it("keeps the cacheable prefix byte-identical on every turn of a run", async () => {
    const { model, seen } = recorder([
      { type: "tool_calls", calls: [{ id: "call-1", name: "echo", arguments: { value: 1 } }] },
      { type: "tool_calls", calls: [{ id: "call-2", name: "echo", arguments: { value: 2 } }] },
      { type: "final", text: "done" },
    ]);
    const result = await createAgentRunner({ model, tools: echoTools(), limits }).run("cacheable task");
    expect(result).toMatchObject({ status: "completed", steps: 3, toolCalls: 2 });
    expect(seen).toHaveLength(3);
    // Provider-side caching only pays off while the head of the transcript stays byte-identical.
    expect(seen[0]?.slice(0, 2).map((message) => JSON.stringify(message))).toEqual([
      JSON.stringify({
        role: "system",
        content: "Use the available tools when needed, then return a final answer.",
      }),
      JSON.stringify({ role: "user", content: "cacheable task" }),
    ]);
    for (const turn of seen) {
      expect(turn.slice(0, 2)).toEqual(seen[0]?.slice(0, 2));
      // A system message after the first user turn would restart the provider cache prefix.
      expect(turn.slice(2).some((message) => message.role === "system")).toBe(false);
    }
    // Every turn only appends, so the previous turn survives verbatim as the head of the next.
    expect(seen[1]?.slice(0, seen[0]?.length ?? 0)).toEqual(seen[0]);
    expect(seen[2]?.slice(0, seen[1]?.length ?? 0)).toEqual(seen[1]);
  });

  it("sends the same tool definitions in the same order on every turn", async () => {
    const { model, seenTools } = recorder([
      { type: "tool_calls", calls: [{ id: "call-1", name: "echo", arguments: { value: 1 } }] },
      { type: "final", text: "done" },
    ]);
    const tools = new ToolRegistry();
    tools.register({
      name: "echo",
      description: "echo",
      inputSchema: { type: "object" },
      execute: async () => "two",
    });
    tools.register({
      name: "second",
      description: "second",
      inputSchema: { type: "object" },
      execute: async () => "two",
    });
    const result = await createAgentRunner({ model, tools, limits }).run("stable tools");
    expect(result).toMatchObject({ status: "completed", steps: 2, toolCalls: 1 });
    expect(seenTools).toHaveLength(2);
    // The tool block is part of the cached prefix, so its order must not drift between turns.
    expect(seenTools[0]?.map((tool) => tool.name)).toEqual(["echo", "second"]);
    for (const turn of seenTools) expect(turn).toEqual(seenTools[0]);
  });

  it("awaits an async step hook and keeps its snapshot after it resolves", async () => {
    const order: string[] = [];
    const snapshots: AgentStepRecord[] = [];
    const { model } = recorder([
      { type: "tool_calls", calls: [{ id: "call-1", name: "echo", arguments: { value: 1 } }] },
      { type: "final", text: "done" },
    ]);
    const result = await createAgentRunner({ model, tools: echoTools(), limits }).run("task", {
      onStep: async (record) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`step ${record.step}`);
        snapshots.push(record);
      },
    });
    expect(result).toMatchObject({ status: "completed" });
    expect(order).toEqual(["step 1", "step 2"]);
    expect(snapshots[1]?.messages[3]).toMatchObject({ role: "tool", toolCallId: "call-1" });
  });

  it("fails the run when the step hook throws and keeps the transcript so far", async () => {
    const modelCalls: number[] = [];
    const model: ModelProvider = {
      complete: async () => {
        modelCalls.push(1);
        return { type: "tool_calls", calls: [{ id: "call-1", name: "echo", arguments: {} }] };
      },
    };
    const result = await createAgentRunner({ model, tools: echoTools(), limits }).run("task", {
      onStep: async () => {
        throw new Error("session store write failed");
      },
    });
    expect(result.status).toBe("error");
    expect(result.error).toBe("session store write failed");
    expect(result.text).toContain("session store write failed");
    expect(result.observations).toHaveLength(1);
    expect(modelCalls).toHaveLength(1);
  });

  it("lets an external abort win over a failing step hook", async () => {
    const controller = new AbortController();
    const result = await createAgentRunner({
      model: sequence([{ type: "tool_calls", calls: [{ id: "1", name: "echo", arguments: {} }] }]),
      tools: echoTools(),
      limits,
    }).run("task", {
      signal: controller.signal,
      onStep: () => {
        controller.abort();
        throw new Error("session store write failed");
      },
    });
    expect(result).toMatchObject({ status: "stopped", error: "agent cancelled" });
  });

  it("keeps timeout semantics when the step hook fails after the deadline", async () => {
    const result = await createAgentRunner({
      model: sequence([{ type: "tool_calls", calls: [{ id: "1", name: "echo", arguments: {} }] }]),
      tools: echoTools(),
      limits: { ...limits, timeoutMs: 20 },
    }).run("task", {
      onStep: async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        throw new Error("session store write failed");
      },
    });
    expect(result).toMatchObject({ status: "stopped", error: "agent timeout" });
  });
});

describe("loop-react budget guard", () => {
  const limits = { maxSteps: 8, maxToolCalls: 12, timeoutMs: 5000 };
  const identity = "test/model";

  /** $1.00 in and $2.00 out per million tokens. The kernel field is plain USD, not micro-USD. */
  const prices = { [identity]: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 } };
  const usage = (inputTokens: number, outputTokens: number): ModelUsage => ({
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    source: "test-provider",
  });

  const policy = (overrides: Partial<BudgetPolicy>): BudgetPolicy => resolveBudgetPolicy(overrides);

  /** Answers each turn in turn, and records the signal the provider was handed. */
  function metered(results: readonly ModelResult[]): {
    model: ModelProvider;
    signals: (AbortSignal | undefined)[];
  } {
    const signals: (AbortSignal | undefined)[] = [];
    let index = 0;
    return {
      signals,
      model: {
        async complete(_messages, _tools, signal) {
          signals.push(signal);
          const answer = results[Math.min(index, results.length - 1)];
          index += 1;
          if (!answer) throw new Error("test model has no result");
          return answer;
        },
      },
    };
  }

  it("leaves a disabled policy byte-identical to an absent one, with no timer and no usage field", async () => {
    vi.useFakeTimers();
    try {
      const scenario = async (budget?: BudgetPolicy) => {
        let armed = 0;
        const model: ModelProvider = {
          complete: async () => {
            armed = vi.getTimerCount();
            return { type: "final", text: "done", usage: usage(40, 10) };
          },
        };
        const runner = createAgentRunner({
          model,
          tools: echoTools(),
          limits,
          ...(budget === undefined ? {} : { budget }),
          modelIdentity: identity,
        });
        const result = await runner.run("task", budget === undefined ? undefined : { budget });
        return { result, armed };
      };

      const absent = await scenario();
      // One timer is the pre-existing `timeoutMs` ceiling. A disabled budget arms no second one.
      expect(absent.armed).toBe(1);
      expect(absent.result.status).toBe("completed");

      // Same input, same bytes: an explicitly disabled policy and a false one change nothing, and
      // the usage the provider reported is not surfaced either.
      for (const disabled of [policy({}), policy({ enabled: false, maxTotalTokens: 1, maxCostUsd: 0.01 })]) {
        const { result, armed } = await scenario(disabled);
        expect(armed).toBe(1);
        expect("usage" in result).toBe(false);
        expect(JSON.stringify(result)).toBe(JSON.stringify(absent.result));
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops on the token ceiling and reports the aggregated usage of the run", async () => {
    const { model, signals } = metered([
      { type: "tool_calls", calls: [{ id: "1", name: "echo", arguments: {} }], usage: usage(60, 10) },
      { type: "tool_calls", calls: [{ id: "2", name: "echo", arguments: {} }], usage: usage(20, 20) },
      { type: "final", text: "unreachable", usage: usage(1, 1) },
    ]);
    const result = await createAgentRunner({
      model,
      tools: echoTools(),
      limits,
      modelIdentity: identity,
    }).run("spend", { budget: policy({ enabled: true, maxTotalTokens: 100 }) });

    expect(result).toMatchObject({ status: "stopped", error: BUDGET_TOKENS, text: BUDGET_TEXT });
    // 60+10 then 20+20 crosses 100 on the second turn, so the tool call of that turn never ran.
    expect(result.usage).toEqual(usage(80, 30));
    expect(result.toolCalls).toBe(1);
    expect(result.steps).toBeLessThan(limits.maxSteps);
    // Every budget stop aborts the provider, including the turn that was in flight.
    for (const signal of signals) expect(signal?.aborted).toBe(true);
  });

  it("stops on the cost ceiling using the price of the exact model identity", async () => {
    // $1.00 of input on the first turn, then $0.50 of output: the cap is $1.50 and the second
    // turn lands exactly on it. Compared in micro-USD, so neither side can round the other away.
    const { model, signals } = metered([
      { type: "tool_calls", calls: [{ id: "1", name: "echo", arguments: {} }], usage: usage(1_000_000, 0) },
      { type: "tool_calls", calls: [{ id: "2", name: "echo", arguments: {} }], usage: usage(0, 250_000) },
      { type: "final", text: "unreachable", usage: usage(1, 1) },
    ]);
    const result = await createAgentRunner({
      model,
      tools: echoTools(),
      limits,
      modelIdentity: identity,
    }).run("spend", { budget: policy({ enabled: true, maxCostUsd: 1.5, prices }) });

    expect(result).toMatchObject({ status: "stopped", error: BUDGET_COST });
    expect(result.usage).toEqual(usage(1_000_000, 250_000));
    expect(result.toolCalls).toBe(1);
    for (const signal of signals) expect(signal?.aborted).toBe(true);

    // One output token short of the cap the same run completes, so the ceiling is what stopped it.
    const under = await createAgentRunner({
      model: metered([
        { type: "tool_calls", calls: [{ id: "1", name: "echo", arguments: {} }], usage: usage(1_000_000, 0) },
        { type: "final", text: "done", usage: usage(0, 249_999) },
      ]).model,
      tools: echoTools(),
      limits,
      modelIdentity: identity,
    }).run("spend", { budget: policy({ enabled: true, maxCostUsd: 1.5, prices }) });
    expect(under).toMatchObject({ status: "completed", text: "done" });
  });

  it("stops on the elapsed ceiling and aborts the provider it was waiting on", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const waiting: ModelProvider = {
      complete: (_messages, _tools, signal) => {
        signals.push(signal);
        return new Promise<ModelResult>(() => {});
      },
    };
    const result = await createAgentRunner({
      model: waiting,
      tools: echoTools(),
      // The pre-existing timeout is far away, so the budget ceiling is the one that fires.
      limits: { ...limits, timeoutMs: 60_000 },
      modelIdentity: identity,
    }).run("wait", { budget: policy({ enabled: true, maxElapsedMs: 25 }) });

    expect(result).toMatchObject({ status: "stopped", error: BUDGET_TIME, text: BUDGET_TEXT });
    expect(result.usage).toBeUndefined();
    expect(signals[0]?.aborted).toBe(true);
  });

  it("fails closed when usage is missing or the model carries no price", async () => {
    const silent = metered([{ type: "tool_calls", calls: [{ id: "1", name: "echo", arguments: {} }] }]);
    const unreported = await createAgentRunner({
      model: silent.model,
      tools: echoTools(),
      limits,
      modelIdentity: identity,
    }).run("unmetered", { budget: policy({ enabled: true, maxTotalTokens: 1000, prices }) });
    expect(unreported).toMatchObject({ status: "stopped", error: BUDGET_USAGE_UNAVAILABLE });
    expect(unreported.usage).toBeUndefined();
    expect(unreported.toolCalls).toBe(0);

    // A usage block the provider got wrong is unreadable, not an implicit zero.
    const malformed = metered([
      { type: "final", text: "hi", usage: { inputTokens: -1, outputTokens: 0, totalTokens: 0, source: "x" } },
    ]);
    const corrupt = await createAgentRunner({
      model: malformed.model,
      tools: echoTools(),
      limits,
      modelIdentity: identity,
    }).run("unmetered", { budget: policy({ enabled: true, maxTotalTokens: 1000 }) });
    expect(corrupt).toMatchObject({ status: "stopped", error: BUDGET_USAGE_UNAVAILABLE });

    // An armed cost ceiling on a model the prices map does not name stops before spending anything.
    const unpriced = metered([{ type: "final", text: "hi", usage: usage(1, 1) }]);
    for (const modelIdentity of [undefined, "test/MODEL"]) {
      const runner = createAgentRunner({
        model: unpriced.model,
        tools: echoTools(),
        limits,
        ...(modelIdentity === undefined ? {} : { modelIdentity }),
      });
      const result = await runner.run("spend", {
        budget: policy({ enabled: true, maxCostUsd: 1, prices }),
      });
      expect(result).toMatchObject({ status: "stopped", error: BUDGET_COST_UNPRICED });
      expect(result.usage).toBeUndefined();
    }

    // The same policy against the exact key prices the run, so the refusal above is a missing
    // price and not a cost ceiling that stops everything.
    const priced = await createAgentRunner({
      model: unpriced.model,
      tools: echoTools(),
      limits,
      modelIdentity: identity,
    }).run("spend", { budget: policy({ enabled: true, maxCostUsd: 1, prices }) });
    expect(priced).toMatchObject({ status: "completed", text: "hi" });

    // A token-only ceiling needs no price table, so an unpriced model must not stop on it.
    const tokensOnly = await createAgentRunner({
      model: unpriced.model,
      tools: echoTools(),
      limits,
    }).run("spend", { budget: policy({ enabled: true, maxTotalTokens: 1000 }) });
    expect(tokensOnly).toMatchObject({ status: "completed", text: "hi" });
  });

  it("never leaves the tool calls of a budget-stopped turn unpaired", async () => {
    const tools = new ToolRegistry();
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    tools.register({
      name: "slow",
      description: "blocks until released",
      inputSchema: { type: "object" },
      execute: async () => {
        await blocker;
        return "late";
      },
    });
    tools.register({
      name: "never",
      description: "must not be reached",
      inputSchema: { type: "object" },
      execute: async () => "unreached",
    });
    const seen: ModelMessage[][] = [];
    let index = 0;
    const answers: ModelResult[] = [
      {
        type: "tool_calls",
        calls: [
          { id: "call-1", name: "slow", arguments: {} },
          { id: "call-2", name: "never", arguments: {} },
        ],
      },
      { type: "final", text: "unreachable" },
    ];
    const model: ModelProvider = {
      complete: async (messages) => {
        seen.push(messages.slice());
        const answer = answers[Math.min(index, answers.length - 1)];
        index += 1;
        if (!answer) throw new Error("test model has no result");
        return answer;
      },
    };

    const running = createAgentRunner({
      model,
      tools,
      limits: { ...limits, timeoutMs: 60_000 },
      modelIdentity: identity,
    }).run("pair", { budget: policy({ enabled: true, maxElapsedMs: 25 }) });
    await new Promise((resolve) => setTimeout(resolve, 90));
    release();
    const result = await running;

    expect(result).toMatchObject({ status: "stopped", error: BUDGET_TIME });
    // The turn was interrupted inside its first call, yet both ids were answered, so the
    // assistant message is not left holding a call with no tool result after it.
    expect(result.observations).toEqual([
      '{"ok":false,"error":"budget:time"}',
      '{"ok":false,"error":"budget:time"}',
    ]);
    expect(result.toolCalls).toBe(1);
  });

  it("interpolates no secret, price, or transcript into a stop reason or its text", async () => {
    const secret = "sk-live-0123456789abcdefghij";
    const baseUrl = "https://provider.invalid/v1/chat";
    const task = `rotate ${secret} at ${baseUrl}`;
    for (const [overrides, reason] of [
      [{ enabled: true, maxTotalTokens: 100 }, BUDGET_TOKENS],
      [{ enabled: true, maxCostUsd: 0.000001, prices }, BUDGET_COST],
    ] as const) {
      const { model } = metered([
        { type: "final", text: `${task} ${secret}`, usage: usage(1_000_000, 1_000_000) },
      ]);
      const result = await createAgentRunner({
        model,
        tools: echoTools(),
        limits,
        modelIdentity: identity,
      }).run(task, { budget: policy(overrides) });

      expect(result).toMatchObject({ status: "stopped", error: reason, text: BUDGET_TEXT });
      const envelope = JSON.stringify({ result, reason: result.error, usage: result.usage });
      for (const leak of [secret, baseUrl, "provider.invalid", "sk-live"]) {
        expect(envelope, `budget output must not carry ${leak}`).not.toContain(leak);
      }
      // The reason and the text are constants, so no count, cap, or provenance can land in either.
      for (const constant of [result.error, result.text]) {
        for (const leak of [secret, baseUrl, "1000000", "1000001", "1.5", identity, "test-provider"]) {
          expect(constant, `a constant stop string must not carry ${leak}`).not.toContain(leak);
        }
      }
    }
  });

  it("keeps the reported usage out of what the session store persists", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-budget-"));
    try {
      const { model } = metered([{ type: "final", text: "done", usage: usage(40, 10) }]);
      const runner = createAgentRunner({
        model,
        tools: echoTools(),
        limits,
        modelIdentity: identity,
      });
      const store = await createSessionStore({ root: join(root, "sessions") });
      const sessionId = await store.appendStart({ provider: "test", model: identity, task: "spend" });
      const result = await runner.run("spend", {
        budget: policy({ enabled: true, maxTotalTokens: 10_000 }),
        onStep: (record) => store.appendStep(sessionId, record),
      });
      expect(result.usage).toEqual(usage(40, 10));

      // The store's closed shapes carry neither usage nor any budget limit, so a budget can only
      // ever live in the live result.
      const records = JSON.stringify(await store.load(sessionId));
      expect(records).not.toMatch(/maxTotalTokens|maxCostUsd|maxElapsedMs|inputTokens|"usage"|prices/);

      // A caller that hands the store a budget and a usage block gets neither persisted: the
      // writer copies the fields it owns, so an unknown key is dropped rather than honoured.
      await store.appendEnd(sessionId, {
        status: "stopped",
        error: BUDGET_COST,
        budget: { maxCostUsd: 1 },
        usage: usage(40, 10),
      } as never);
      const withEnd = await store.load(sessionId);
      expect(withEnd.at(-1)).toEqual({
        type: "run-end",
        schemaVersion: 1,
        sessionId,
        status: "stopped",
        error: BUDGET_COST,
      });
      expect(JSON.stringify(withEnd)).not.toMatch(
        /maxTotalTokens|maxCostUsd|maxElapsedMs|inputTokens|"usage"|prices/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("compacts a growing transcript before the next model turn, and never below the head", async () => {
    const bigTools = (): ToolRegistry => {
      const tools = new ToolRegistry();
      tools.register({
        name: "read_forever",
        description: "returns a lot of text",
        inputSchema: { type: "object" },
        execute: async () => "x".repeat(8_000),
      });
      return tools;
    };
    const turns = [
      { type: "tool_calls", calls: [{ id: "c0", name: "read_forever", arguments: {} }] },
      { type: "tool_calls", calls: [{ id: "c1", name: "read_forever", arguments: {} }] },
      { type: "tool_calls", calls: [{ id: "c2", name: "read_forever", arguments: {} }] },
      { type: "final", text: "done reading" },
    ] as const;
    const run = async (compaction: CompactionPolicy) => {
      const recorded = recorder([...turns]);
      const result = await createAgentRunner({
        model: recorded.model,
        tools: bigTools(),
        limits: { maxSteps: 6, maxToolCalls: 6, timeoutMs: 5_000 },
        compaction,
      }).run("read everything");
      return { result, seen: recorded.seen };
    };
    const compact = await run({ maxChars: 6_000, keepMessages: 4 });
    const untouched = await run({ maxChars: 5_000_000, keepMessages: 4 });

    expect(compact.result.status).toBe("completed");
    expect(untouched.result.status).toBe("completed");
    const last = compact.seen.at(-1) ?? [];
    const untouchedLast = untouched.seen.at(-1) ?? [];
    expect(last.some((message) => message.content.startsWith("compacted transcript: "))).toBe(true);
    expect(untouchedLast.some((message) => message.content.startsWith("compacted transcript: "))).toBe(false);
    // A compacted turn is strictly smaller than the same run left alone.
    expect(last.reduce((sum, message) => sum + message.content.length, 0)).toBeLessThan(
      untouchedLast.reduce((sum, message) => sum + message.content.length, 0),
    );
    // The head survives every turn: the model still knows what it was asked and how to answer.
    for (const turn of compact.seen) {
      expect(turn[0]?.role).toBe("system");
      expect(turn[1]).toEqual({ role: "user", content: "read everything" });
    }
    // And no turn ever carries a tool result whose tool call is not in the same transcript.
    for (const turn of compact.seen) {
      const answered = new Set(turn.flatMap((m) => (m.toolCalls ?? []).map((c) => c.id)));
      for (const message of turn) {
        if (message.role !== "tool") continue;
        expect(answered.has(message.toolCallId ?? "")).toBe(true);
      }
    }
  });

  it("keeps a transcript it cannot shorten instead of cutting a tool call away from its result", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "loud",
      description: "returns a lot of text",
      inputSchema: { type: "object" },
      execute: async () => "x".repeat(8_000),
    });
    const recorded = recorder([
      { type: "tool_calls", calls: [{ id: "only", name: "loud", arguments: {} }] },
      { type: "final", text: "still fine" },
    ]);
    const result = await createAgentRunner({
      model: recorded.model,
      tools,
      limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 5_000 },
      // A cap of 10 characters and a tail large enough to hold everything: no safe cut exists.
      compaction: { maxChars: 10, keepMessages: 100 },
    }).run("be loud");
    expect(result.status).toBe("completed");
    const last = recorded.seen.at(-1) ?? [];
    expect(last.some((message) => message.content.startsWith("compacted transcript: "))).toBe(false);
    expect(last.filter((message) => message.role === "tool")).toHaveLength(1);
  });

  it("takes the compaction cap from config all the way into the run", async () => {
    const payload = "y".repeat(3_000);
    const runWith = async (compaction: string) => {
      const root = await mkdtemp(join(tmpdir(), "nexus-compact-config-"));
      try {
        await mkdir(join(root, "config"), { recursive: true });
        await mkdir(join(root, "user"), { recursive: true });
        await writeFile(
          join(root, "config", "default.yaml"),
          "model:\n  provider: mock\n  model: mock\n",
          "utf8",
        );
        await writeFile(
          join(root, "user", "config.yaml"),
          `permissions:\n  fs.write: allow\nplugins:\n  loop-react:\n${compaction}`,
          "utf8",
        );
        const records: ModelMessage[][] = [];
        const runtime = await createRuntime({ root, modelProvider: "mock", askPermission: () => true });
        try {
          const result = await runtime.runner.run(
            `write file "big.txt" with content "${payload}" and read big.txt`,
            {
              // A stored transcript from an earlier run, so the span this drops is old material the
              // model is not still being asked about.
              history: [
                {
                  role: "system",
                  content: "Use the available tools when needed, then return a final answer.",
                },
                { role: "user", content: "an earlier task" },
                {
                  role: "assistant",
                  content: "",
                  toolCalls: [{ id: "old-1", name: "read_text", arguments: { path: "old.txt" } }],
                },
                { role: "tool", content: `{"ok":true,"output":"${"z".repeat(3_000)}"}`, toolCallId: "old-1" },
                {
                  role: "assistant",
                  content: "",
                  toolCalls: [{ id: "old-2", name: "read_text", arguments: { path: "old.txt" } }],
                },
                { role: "tool", content: `{"ok":true,"output":"${"z".repeat(3_000)}"}`, toolCallId: "old-2" },
              ],
              onStep: (record) => {
                records.push(record.messages.slice());
              },
            },
          );
          return { result, records };
        } finally {
          await runtime.registry.close();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    };
    const configured = await runWith("    context:\n      maxChars: 600\n      keepMessages: 2\n");
    const untouched = await runWith("    maxSteps: 8\n");

    expect(configured.result.status).toBe("completed");
    expect(untouched.result.status).toBe("completed");
    const configuredLast = configured.records.at(-1) ?? [];
    const untouchedLast = untouched.records.at(-1) ?? [];
    // The configured cap is the one that bites: the same run on the default cap never compacts.
    expect(configuredLast.some((message) => message.content.startsWith("compacted transcript: "))).toBe(true);
    expect(untouchedLast.some((message) => message.content.startsWith("compacted transcript: "))).toBe(false);
    expect(configuredLast[0]?.role).toBe("system");
  });

  it("keeps the instructions and final answers of a stored transcript when it compacts", async () => {
    const stored: ModelMessage[] = [
      { role: "system", content: "Use the available tools when needed, then return a final answer." },
      { role: "user", content: "earlier instruction" },
      {
        role: "assistant",
        content: "working",
        toolCalls: [{ id: "old-1", name: "echo", arguments: {} }],
      },
      { role: "tool", content: `{"ok":true,"output":"${"z".repeat(4_000)}"}`, toolCallId: "old-1" },
      { role: "assistant", content: "earlier final answer" },
      { role: "user", content: "earlier follow-up" },
      {
        role: "assistant",
        content: "working",
        toolCalls: [{ id: "old-2", name: "echo", arguments: {} }],
      },
      { role: "tool", content: `{"ok":true,"output":"${"z".repeat(4_000)}"}`, toolCallId: "old-2" },
    ];
    const recorded = recorder([{ type: "final", text: "done" }]);
    const result = await createAgentRunner({
      model: recorded.model,
      tools: echoTools(),
      limits: { maxSteps: 2, maxToolCalls: 2, timeoutMs: 5_000 },
      compaction: { maxChars: 3_000, keepMessages: 1 },
    }).run("new task", { history: stored });
    expect(result.status).toBe("completed");
    const sent = recorded.seen[0] ?? [];
    const contents = sent.map((message) => message.content);
    // Tool output is what pays for the cap; the instructions and the answers are not for sale.
    expect(contents).toContain("earlier instruction");
    expect(contents).toContain("earlier final answer");
    expect(contents).toContain("earlier follow-up");
    expect(contents).toContain("new task");
    expect(contents.some((content) => content.startsWith("compacted transcript: "))).toBe(true);
    expect(contents.some((content) => content.includes("zzzz"))).toBe(false);
  });

  it("runs the calls of one turn one after another by default", async () => {
    const overlap = { peak: 0, live: 0 };
    const tools = new ToolRegistry();
    tools.register({
      name: "slow",
      description: "records how many of these overlap",
      inputSchema: { type: "object" },
      execute: async () => {
        overlap.live += 1;
        overlap.peak = Math.max(overlap.peak, overlap.live);
        await new Promise((resolve) => setTimeout(resolve, 5));
        overlap.live -= 1;
        return "done";
      },
    });
    const result = await createAgentRunner({
      model: sequence([
        {
          type: "tool_calls",
          calls: [
            { id: "a", name: "slow", arguments: {} },
            { id: "b", name: "slow", arguments: {} },
          ],
        },
        { type: "final", text: "done" },
      ]),
      tools,
      limits: { maxSteps: 3, maxToolCalls: 4, timeoutMs: 2_000 },
    }).run("twice");
    expect(result.status).toBe("completed");
    expect(overlap.peak).toBe(1);
  });

  it("runs the calls of one turn together when parallel execution is asked for", async () => {
    const overlap = { peak: 0, live: 0 };
    const tools = new ToolRegistry();
    tools.register({
      name: "slow",
      description: "records how many of these overlap",
      inputSchema: { type: "object" },
      execute: async () => {
        overlap.live += 1;
        overlap.peak = Math.max(overlap.peak, overlap.live);
        await new Promise((resolve) => setTimeout(resolve, 5));
        overlap.live -= 1;
        return "done";
      },
    });
    const recorded = recorder([
      {
        type: "tool_calls",
        calls: [
          { id: "a", name: "slow", arguments: {} },
          { id: "b", name: "slow", arguments: {} },
        ],
      },
      { type: "final", text: "done" },
    ]);
    const result = await createAgentRunner({
      model: recorded.model,
      tools,
      limits: { maxSteps: 3, maxToolCalls: 4, timeoutMs: 2_000 },
      parallelToolCalls: true,
    }).run("twice");
    expect(result.status).toBe("completed");
    expect(overlap.peak).toBe(2);
  });

  it("keeps the observation order the model asked for, whatever order the tools finish in", async () => {
    const tools = new ToolRegistry();
    const delay: Record<string, number> = { first: 20, second: 10, third: 0 };
    tools.register({
      name: "step",
      description: "finishes after a per-name delay",
      inputSchema: { type: "object" },
      execute: async (args: Record<string, unknown>) => {
        const name = String(args.name ?? "");
        await new Promise((resolve) => setTimeout(resolve, delay[name] ?? 0));
        return name;
      },
    });
    const recorded = recorder([
      {
        type: "tool_calls",
        calls: [
          { id: "a", name: "step", arguments: { name: "first" } },
          { id: "b", name: "step", arguments: { name: "second" } },
          { id: "c", name: "step", arguments: { name: "third" } },
        ],
      },
      { type: "final", text: "done" },
    ]);
    const result = await createAgentRunner({
      model: recorded.model,
      tools,
      limits: { maxSteps: 3, maxToolCalls: 4, timeoutMs: 2_000 },
      parallelToolCalls: true,
    }).run("three");
    expect(result.status).toBe("completed");
    // The transcript the model sees is still call order, not finish order.
    const last = recorded.seen.at(-1) ?? [];
    const results = last.filter((message) => message.role === "tool").map((m) => m.toolCallId);
    expect(results).toEqual(["a", "b", "c"]);
    expect(result.observations.map((value) => (JSON.parse(value) as { output: string }).output)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("stops a parallel turn on the tool call limit without leaving an unanswered call", async () => {
    const tools = new ToolRegistry();
    const ran: string[] = [];
    tools.register({
      name: "note",
      description: "records that it ran",
      inputSchema: { type: "object" },
      execute: async (args: Record<string, unknown>) => {
        const name = String(args.name ?? "");
        ran.push(name);
        return name;
      },
    });
    const recorded = recorder([
      {
        type: "tool_calls",
        calls: [
          { id: "a", name: "note", arguments: { name: "one" } },
          { id: "b", name: "note", arguments: { name: "two" } },
          { id: "c", name: "note", arguments: { name: "three" } },
        ],
      },
      { type: "final", text: "never reached" },
    ]);
    const result = await createAgentRunner({
      model: recorded.model,
      tools,
      limits: { maxSteps: 3, maxToolCalls: 2, timeoutMs: 2_000 },
      parallelToolCalls: true,
    }).run("three");
    expect(result.status).toBe("stopped");
    expect(result.error).toBe("tool call limit reached");
    expect(ran).toEqual(["one", "two"]);
    const last = recorded.seen.at(-1) ?? [];
    expect(last.filter((message) => message.role === "tool")).toHaveLength(0);
  });

  it("keeps the last failure in call order, not in finish order", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "fail",
      description: "fails after a per-name delay",
      inputSchema: { type: "object" },
      execute: async (args: Record<string, unknown>) => {
        const name = String(args.name ?? "");
        await new Promise((resolve) => setTimeout(resolve, name === "slow" ? 20 : 0));
        throw new Error(`broken ${name}`);
      },
    });
    const result = await createAgentRunner({
      model: sequence([
        {
          type: "tool_calls",
          calls: [
            { id: "a", name: "fail", arguments: { name: "slow" } },
            { id: "b", name: "fail", arguments: { name: "fast" } },
          ],
        },
        { type: "final", text: "unreachable" },
      ]),
      tools,
      limits: { maxSteps: 3, maxToolCalls: 4, timeoutMs: 2_000 },
      parallelToolCalls: true,
    }).run("fail twice");
    // The later call in call order owns the reported failure, the same rule the serial loop used.
    expect(result.status).toBe("error");
    expect(result.error).toBe("broken fast");
  });

  it("takes parallel tool calls from the loop-react config", async () => {
    const runWith = async (loopConfig: Record<string, unknown>) => {
      const root = await mkdtemp(join(tmpdir(), "nexus-parallel-config-"));
      const registry = new Registry(
        silent,
        (name) => (name === "tools-basic" ? { root } : name === "loop-react" ? loopConfig : {}),
        new PermissionGate({ "fs.read": "allow", "fs.write": "allow", shell: "deny" }),
      );
      registry.register(toolsBasic);
      registry.register(loopReact);
      const overlap = { peak: 0, live: 0 };
      try {
        await registry.load("loop-react");
        const factory = registry.services.get<AgentRunnerFactory>("agent:runner-factory");
        // The runner uses the registry the plugin loaded, so the probe has to live there too.
        const tools = registry.services.get<ToolRegistry>("tool:core");
        tools.register({
          name: "overlap_probe",
          description: "records how many of these run at once",
          inputSchema: { type: "object" },
          execute: async () => {
            overlap.live += 1;
            overlap.peak = Math.max(overlap.peak, overlap.live);
            await new Promise((resolve) => setTimeout(resolve, 5));
            overlap.live -= 1;
            return "done";
          },
        });
        const model: ModelProvider = {
          async complete(): Promise<ModelResult> {
            if (overlap.peak > 0 && overlap.live === 0) {
              return { type: "final", text: "probed" };
            }
            return {
              type: "tool_calls",
              calls: [
                { id: "a", name: "overlap_probe", arguments: {} },
                { id: "b", name: "overlap_probe", arguments: {} },
              ],
            };
          },
        };
        const result = await factory(model, "mock").run("probe", { budget: undefined });
        return { result, overlap };
      } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
      }
    };
    const on = await runWith({ maxSteps: 4, maxToolCalls: 4, timeoutMs: 2_000, parallelToolCalls: true });
    const off = await runWith({ maxSteps: 4, maxToolCalls: 4, timeoutMs: 2_000 });
    expect(on.result.status).toBe("completed");
    expect(off.result.status).toBe("completed");
    expect(on.overlap.peak).toBe(2);
    expect(off.overlap.peak).toBe(1);
  });
});
