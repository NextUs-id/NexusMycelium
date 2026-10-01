import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunOptions, BudgetPolicy } from "../kernel/src/agent.js";
import type { ModelMessage } from "../kernel/src/model.js";
import {
  createRuntimeRoot,
  stubOpenAIFetch,
  stubTraceHost,
  type TraceFixture,
  writeDummyApiKey,
} from "./runtime.fixtures.js";
import { createRuntime, runSession, type SessionAgent } from "./runtime.js";
import { runInSandbox } from "./sandbox.js";
import { withSessionStore } from "./session.fixtures.js";
import { fillTraceFile } from "./trace.fixtures.js";
import { createTraceWriter, type TraceInput, type TraceWriterOptions } from "./trace.js";

const mockConfig = "permissions:\n  fs.read: allow\n  fs.write: allow\n  shell: deny\n  network: deny\n";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("budget config", () => {
  const enabledYaml = [
    "budget:",
    "  enabled: true",
    "  maxTotalTokens: 1000",
    "  maxCostUsd: 0.25",
    "  maxElapsedMs: 5000",
    "  prices:",
    "    mock:",
    "      inputUsdPerMillionTokens: 1",
    "      outputUsdPerMillionTokens: 2",
    "",
  ].join("\n");

  it("resolves a configured budget into the policy a run is held to", async () => {
    const root = await createRuntimeRoot(enabledYaml);
    const runtime = await createRuntime({ root });
    try {
      expect(runtime.budget).toEqual({
        enabled: true,
        maxTotalTokens: 1000,
        maxCostUsd: 0.25,
        maxElapsedMs: 5000,
        // The price map passes through keyed by the exact model identity, unchanged.
        prices: { mock: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 } },
      });
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keys a price to the model it is configured for, so only that model is priced", async () => {
    const root = await createRuntimeRoot(
      "model:\n  model: oc/custom\nbudget:\n  enabled: true\n  prices:\n    oc/custom:\n      inputUsdPerMillionTokens: 1\n      outputUsdPerMillionTokens: 2\n    gpt-4o-mini:\n      inputUsdPerMillionTokens: 0.15\n      outputUsdPerMillionTokens: 0.6\n",
    );
    const runtime = await createRuntime({ root });
    try {
      expect(runtime.modelIdentity).toEqual({ provider: "mock", model: "oc/custom" });
      // Both survive, because the runtime prices nothing itself: the loop looks up its own model.
      expect(Object.keys(runtime.budget?.prices ?? {})).toEqual(["oc/custom", "gpt-4o-mini"]);
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("is off by default, and off for a disabled budget that still carries caps", async () => {
    for (const yaml of [mockConfig, "budget:\n  enabled: false\n  maxTotalTokens: 5\n"]) {
      const root = await createRuntimeRoot(yaml);
      const runtime = await createRuntime({ root });
      try {
        expect(runtime.budget).toBeUndefined();
      } finally {
        await runtime.close();
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("leaves every cap null when the block only enables the guard", async () => {
    const root = await createRuntimeRoot("budget:\n  enabled: true\n");
    const runtime = await createRuntime({ root });
    try {
      expect(runtime.budget).toEqual({
        enabled: true,
        maxTotalTokens: null,
        maxCostUsd: null,
        maxElapsedMs: null,
        prices: {},
      });
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a half-written price pair instead of pricing a dimension as free", async () => {
    const root = await createRuntimeRoot(
      "budget:\n  enabled: true\n  maxCostUsd: 1\n  prices:\n    mock:\n      inputUsdPerMillionTokens: 1\n",
    );
    try {
      // The closed config shape refuses a one-sided pair, so a cost cap is never half enforced.
      await expect(createRuntime({ root })).rejects.toThrow(/budget\.prices\.mock/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("builds the runtime runner with the resolved model name, so a cost cap is priceable", async () => {
    const root = await createRuntimeRoot(
      "model:\n  model: oc/custom\nbudget:\n  enabled: true\n  maxCostUsd: 0.5\n  prices:\n    oc/custom:\n      inputUsdPerMillionTokens: 0.15\n      outputUsdPerMillionTokens: 0.6\n",
    );
    const runtime = await createRuntime({ root });
    try {
      expect(runtime.modelIdentity).toEqual({ provider: "mock", model: "oc/custom" });
      // A caller forwards the runtime's own budget, the way the CLI and `runSession` do. The mock
      // reports no usage, which an armed cost ceiling fails closed on — an unpriced stop here would
      // mean the model name never reached the loop and the cap could never be enforced.
      const result = await runtime.runner.run("say hello", { budget: runtime.budget });
      expect(result).toMatchObject({ status: "stopped", error: "budget:usage-unavailable" });
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("createRuntime", () => {
  it("bootstraps the canonical required plugin set and resolves its capabilities", async () => {
    const root = await createRuntimeRoot(mockConfig);
    const runtime = await createRuntime({ root });
    try {
      expect(runtime.config.model.provider).toBe("mock");
      expect(runtime.config.model.model).toBe("mock");
      expect(runtime.modelIdentity).toEqual({ provider: "mock", model: "mock" });
      expect(runtime.registry.loadedNames()).toEqual(["model-mock", "tools-basic", "loop-react"]);
      expect(runtime.registry.services.owner("model:mock")).toBe("model-mock");
      expect(runtime.registry.services.owner("tool:core")).toBe("tools-basic");
      expect(runtime.registry.services.owner("agent:runner-factory")).toBe("loop-react");
      expect(runtime.tools.has("write_text")).toBe(true);
      const result = await runtime.runner.run("write file notes.txt with content hello");
      expect(result.status).toBe("completed");
      expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("hello");
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when a required plugin cannot load", async () => {
    const root = await createRuntimeRoot("tools:\n  root: not-a-directory\n");
    await writeFile(join(root, "not-a-directory"), "not a directory", "utf8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(createRuntime({ root })).rejects.toThrow(/tools root must be a directory/);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("isolates a failing optional sibling and keeps the required capabilities", async () => {
    const root = await createRuntimeRoot(`${mockConfig}plugins:\n  tools-core:\n    root: .\n`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = await createRuntime({ root });
    try {
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/optional plugin not loaded: tools-core/);
      expect(runtime.registry.isLoaded("tools-core")).toBe(false);
      expect(runtime.registry.services.owner("tool:core")).toBe("tools-basic");
      expect(runtime.tools.has("read_text")).toBe(true);
      expect((await runtime.runner.run("say hello")).status).toBe("completed");
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves services live across unload, reload, and close instead of keeping a snapshot", async () => {
    const root = await createRuntimeRoot(mockConfig);
    const runtime = await createRuntime({ root });
    try {
      await runtime.registry.unload("model-mock");
      expect(runtime.registry.isLoaded("model-mock")).toBe(false);
      expect(() => runtime.model).toThrow(/required capability is unavailable: model:mock/);
      expect(() => runtime.runner).toThrow(/required capability is unavailable: model:mock/);
      expect(runtime.tools.has("read_text")).toBe(true);

      await runtime.registry.load("model-mock");
      await expect(runtime.model.complete([{ role: "user", content: "hello" }], [])).resolves.toEqual({
        type: "final",
        text: "Completed deterministic mock task.",
      });
      expect((await runtime.runner.run("say hello")).status).toBe("completed");

      // A dependent pins its dependency, which is why the runtime exposes no naive reload handle.
      await expect(runtime.registry.unload("tools-basic")).rejects.toThrow(/loop-react depends on it/);
      await runtime.registry.unload("loop-react");
      expect(() => runtime.runner).toThrow(/required capability is unavailable: agent:runner-factory/);
      await runtime.registry.unload("tools-basic");
      expect(() => runtime.tools).toThrow(/required capability is unavailable: tool:core/);
      await runtime.registry.loadAll(["tools-basic", "loop-react"]);
      expect((await runtime.runner.run("say hello")).status).toBe("completed");
    } finally {
      await runtime.close();
    }
    expect(runtime.registry.loadedNames()).toEqual([]);
    expect(runtime.registry.services.has("tool:core")).toBe(false);
    expect(() => runtime.tools).toThrow(/required capability is unavailable: tool:core/);
    expect(() => runtime.runner).toThrow(/required capability is unavailable: agent:runner-factory/);
    await rm(root, { recursive: true, force: true });
  });

  it("uses the OpenAI plugin with a stubbed transport when config selects openai", async () => {
    const root = await createRuntimeRoot(
      "model:\n  provider: openai\n  apiKeyFile: user/secrets/provider.key\npermissions:\n  network: allow\n",
    );
    await writeDummyApiKey(root);
    const fetchProbe = stubOpenAIFetch();
    const runtime = await createRuntime({ root });
    try {
      expect(runtime.config.model.provider).toBe("openai");
      expect(runtime.config.model.model).toBe("gpt-4o-mini");
      expect(runtime.modelIdentity).toEqual({ provider: "openai", model: "gpt-4o-mini" });
      expect(runtime.registry.isLoaded("model-openai")).toBe(true);
      await expect(runtime.model.complete([{ role: "user", content: "hello" }], [])).resolves.toEqual({
        type: "final",
        text: "ok",
      });
      expect(fetchProbe.body()).toMatchObject({ model: "gpt-4o-mini" });
      expect(fetchProbe.authorization()).toMatch(/^Bearer /);
    } finally {
      await runtime.close();
      fetchProbe.restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads a user apiKeyFile and enforces the model prefix through runtime", async () => {
    const root = await createRuntimeRoot(
      "model:\n  provider: openai\n  model: oc/space-bunny-free\n  apiKeyFile: user/secrets/provider.key\n  allowedModelPrefixes:\n    - oc/\npermissions:\n  network: allow\n",
    );
    await writeDummyApiKey(root, "test-runtime-key");
    const fetchProbe = stubOpenAIFetch();
    const runtime = await createRuntime({ root });
    try {
      expect(runtime.config.model).toMatchObject({
        provider: "openai",
        model: "oc/space-bunny-free",
        allowedModelPrefixes: ["oc/"],
      });
      await expect(runtime.model.complete([{ role: "user", content: "hello" }], [])).resolves.toEqual({
        type: "final",
        text: "ok",
      });
      expect(fetchProbe.authorization()).toBe("Bearer test-runtime-key");
    } finally {
      await runtime.close();
      fetchProbe.restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a null root instead of falling back to cwd", async () => {
    await expect(createRuntime({ root: null as unknown as string })).rejects.toThrow(/root/);
  });
});

describe("runSession", () => {
  it("stamps a new session with the current identity, records every step, and leaves the root clean", async () => {
    const root = await createRuntimeRoot(mockConfig);
    const runtime = await createRuntime({ root });
    await withSessionStore(async ({ store }) => {
      try {
        const run = await runSession(runtime, { task: "say hello", store });
        const records = await store.load(run.sessionId);
        expect(records[0]).toMatchObject({
          type: "run-start",
          provider: "mock",
          model: "mock",
          task: "say hello",
        });
        expect(records.filter((record) => record.type === "run-step")).toHaveLength(1);
        expect(records.at(-1)).toMatchObject({ type: "run-end", status: "completed" });
        expect(run.result.status).toBe("completed");
        // Session state belongs to the store scope; the runtime root keeps no session data.
        expect((await readdir(root)).sort()).toEqual(["config", "user"]);
      } finally {
        await runtime.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it("resumes the stored transcript and continues under the limits its last run recorded", async () => {
    const root = await createRuntimeRoot(mockConfig);
    const runtime = await createRuntime({ root });
    await withSessionStore(async ({ store }) => {
      try {
        const id = await store.appendStart({
          provider: "mock",
          model: "mock",
          task: "write file notes.txt with content hello",
        });
        await store.appendStep(id, {
          step: 1,
          messages: [{ role: "user", content: "write file notes.txt with content hello" }],
        });
        await store.appendEnd(id, {
          status: "completed",
          text: "done",
          limits: { maxSteps: 1, maxToolCalls: 12, timeoutMs: 15000 },
        });

        const run = await runSession(runtime, { task: "say hello", store, sessionId: id });
        // The replayed transcript is what makes the mock call write_text, and maxSteps 1 stops there.
        expect(run.sessionId).toBe(id);
        expect(run.result.status).toBe("stopped");
        expect(run.result.error).toBe("step limit reached");
        expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("hello");
        const records = await store.load(id);
        expect(records.filter((record) => record.type === "run-end")).toHaveLength(2);
        expect(records.at(-1)).toMatchObject({
          type: "run-end",
          status: "stopped",
          limits: { maxSteps: 1 },
        });
      } finally {
        await runtime.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it("fails closed on a transcript stored against another provider or model", async () => {
    const root = await createRuntimeRoot(mockConfig);
    const runtime = await createRuntime({ root });
    await withSessionStore(async ({ store }) => {
      try {
        const id = await store.appendStart({
          provider: "openai",
          model: "gpt-4o-mini",
          task: "say hello",
        });
        await store.appendStep(id, { step: 1, messages: [{ role: "user", content: "say hello" }] });
        await store.appendEnd(id, { status: "completed", text: "done" });
        await expect(runSession(runtime, { task: "say hello", store, sessionId: id })).rejects.toThrow(
          /cannot resume session \w+: stored openai:gpt-4o-mini differs from current mock:mock/,
        );
        expect(await store.load(id)).toHaveLength(3);
      } finally {
        await runtime.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it("hands history, limits, signal, and the step hook to the runner and the store unchanged", async () => {
    const seen: AgentRunOptions[] = [];
    const steps: number[] = [];
    const history: ModelMessage[] = [{ role: "user", content: "earlier task" }];
    const controller = new AbortController();
    const agent: SessionAgent = {
      modelIdentity: { provider: "mock", model: "mock" },
      runner: {
        run: async (task, options) => {
          seen.push(options ?? {});
          await options?.onStep?.({ step: 1, messages: history });
          return { status: "completed", text: task, steps: 1, toolCalls: 0, observations: [] };
        },
      },
    };
    await withSessionStore(async ({ store }) => {
      const id = await store.appendStart({ provider: "mock", model: "mock", task: "earlier task" });
      await store.appendStep(id, { step: 1, messages: history });
      await store.appendEnd(id, { status: "completed", text: "done", limits: { maxSteps: 3 } });
      const run = await runSession(agent, {
        task: "next task",
        store,
        sessionId: id,
        signal: controller.signal,
        onStep: (record) => {
          steps.push(record.step);
        },
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]?.history).toEqual(history);
      expect(seen[0]?.limits).toEqual({ maxSteps: 3 });
      expect(seen[0]?.signal).toBe(controller.signal);
      // The guard is off, so the runner sees no budget key at all: parity, not an empty one.
      expect(seen[0]).not.toHaveProperty("budget");
      expect(steps).toEqual([1]);
      expect(run.sessionId).toBe(id);
      const records = await store.load(id);
      expect(records.filter((record) => record.type === "run-step")).toHaveLength(2);
      expect(records.at(-1)).toMatchObject({
        type: "run-end",
        status: "completed",
        limits: { maxSteps: 3 },
      });
    });
  });

  it("forwards the configured budget on a new run and on a resume, and never stores it", async () => {
    const budget: BudgetPolicy = {
      enabled: true,
      maxTotalTokens: 1000,
      maxCostUsd: 0.25,
      maxElapsedMs: 5000,
      prices: { mock: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 } },
    };
    const seen: AgentRunOptions[] = [];
    const agent: SessionAgent = {
      modelIdentity: { provider: "mock", model: "mock" },
      budget,
      runner: {
        run: async (task, options) => {
          seen.push(options ?? {});
          return { status: "completed", text: task, steps: 0, toolCalls: 0, observations: [] };
        },
      },
    };
    await withSessionStore(async (fixture) => {
      const first = await runSession(agent, { task: "say hello", store: fixture.store });
      const resumed = await runSession(agent, {
        task: "say hello again",
        store: fixture.store,
        sessionId: first.sessionId,
      });
      expect(seen).toHaveLength(2);
      expect(seen[0]?.budget).toEqual(budget);
      expect(seen[1]?.budget).toEqual(budget);
      // The store schema is closed: a budget is a run input, never a persisted record.
      expect((await fixture.store.load(first.sessionId)).at(-1)).toMatchObject({
        type: "run-end",
        status: "completed",
      });
      expect(await fixture.bytes(first.sessionId)).not.toMatch(/budget|maxTotalTokens|maxCostUsd/);
      expect(resumed.sessionId).toBe(first.sessionId);
    });
  });

  it("resolves the live runner, so an unloaded loop fails closed before the store is touched", async () => {
    const root = await createRuntimeRoot(mockConfig);
    const runtime = await createRuntime({ root });
    await withSessionStore(async ({ store }) => {
      try {
        await runtime.registry.unload("loop-react");
        await expect(runSession(runtime, { task: "say hello", store })).rejects.toThrow(
          /required capability is unavailable: agent:runner-factory/,
        );
        expect(await store.list()).toEqual([]);
      } finally {
        await runtime.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});

describe("structured trace host", () => {
  const enabled = "trace:\n  enabled: true\n";
  const tracedConfig = (extra = "") => `${mockConfig}${extra}${enabled}`;
  const typed = (trace: TraceFixture, type: string): TraceInput[] =>
    trace.records().filter((record) => record.type === type);

  it("is off by default and for an explicit false: no writer, no file, no record", async () => {
    for (const yaml of [mockConfig, `${mockConfig}trace:\n  enabled: false\n`]) {
      const root = await createRuntimeRoot(yaml);
      const trace = stubTraceHost();
      const runtime = await createRuntime({ root, traceHost: trace.host });
      try {
        expect(runtime.trace).toBeUndefined();
        // Off is the absence of the call, not an off writer: no writer is ever built.
        expect(trace.writers()).toBe(0);
        const result = await runtime.runner.run("say hello");
        expect(result).toMatchObject({ status: "completed", text: "Completed deterministic mock task." });
        expect(trace.records()).toEqual([]);
        // The runtime root is left exactly as a pre-trace run left it: no data/, no log file.
        expect((await readdir(root)).sort()).toEqual(["config", "user"]);
      } finally {
        await runtime.close();
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("creates one writer per runtime and writes run-start, run-step, then run-end", async () => {
    const root = await createRuntimeRoot(tracedConfig());
    const trace = stubTraceHost();
    const runtime = await createRuntime({ root, traceHost: trace.host });
    try {
      expect(runtime.trace?.enabled).toBe(true);
      expect(trace.writers()).toBe(1);
      const boot = typed(trace, "plugin-load");
      expect(boot).toHaveLength(3);

      expect((await runtime.runner.run("say hello")).status).toBe("completed");
      const run = trace.records().slice(boot.length);
      expect(run.map((record) => record.type)).toEqual(["run-start", "run-step", "run-end"]);
      expect(run[0]).toEqual({ type: "run-start", provider: "mock", model: "mock" });
      expect(run[1]).toEqual({ type: "run-step", steps: 1 });
      expect(run[2]).toEqual({ type: "run-end", status: "completed", steps: 1, toolCalls: 0 });

      // A second run reuses that one writer rather than asking for another.
      await runtime.runner.run("say hello again");
      expect(trace.writers()).toBe(1);
      expect(
        trace
          .records()
          .slice(boot.length + run.length)
          .map((record) => record.type),
      ).toEqual(["run-start", "run-step", "run-end"]);
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records a budget stop as a vocabulary scalar and never as prose", async () => {
    const root = await createRuntimeRoot(tracedConfig("budget:\n  enabled: true\n  maxTotalTokens: 1000\n"));
    const trace = stubTraceHost();
    const runtime = await createRuntime({ root, traceHost: trace.host });
    try {
      const result = await runtime.runner.run("say hello", { budget: runtime.budget });
      expect(result).toMatchObject({ status: "stopped", error: "budget:usage-unavailable" });
      const ends = typed(trace, "run-end");
      expect(ends).toHaveLength(1);
      expect(ends[0]).toEqual({
        type: "run-end",
        status: "stopped",
        steps: 1,
        toolCalls: 0,
        budgetReason: "budget:usage-unavailable",
      });
      // The stop text is the loop's, not the log's: only the reason travels.
      expect(JSON.stringify(ends[0])).not.toMatch(/budget reached/i);
      // Nothing was reported, so nothing is claimed about what the run spent.
      expect(ends[0]).not.toHaveProperty("usage");
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records the usage a gateway reported as three scalars", async () => {
    const root = await createRuntimeRoot(
      [
        "model:",
        "  provider: openai",
        "  model: gpt-4o-mini",
        "  apiKeyFile: user/secrets/provider.key",
        "permissions:",
        "  network: allow",
        "budget:",
        "  enabled: true",
        "  maxTotalTokens: 100000",
        "  prices:",
        "    gpt-4o-mini:",
        "      inputUsdPerMillionTokens: 0.15",
        "      outputUsdPerMillionTokens: 0.6",
        enabled,
      ].join("\n"),
    );
    await writeDummyApiKey(root);
    const fetchProbe = stubOpenAIFetch("ok", {
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
    });
    const trace = stubTraceHost();
    const runtime = await createRuntime({ root, traceHost: trace.host });
    try {
      expect((await runtime.runner.run("say hello", { budget: runtime.budget })).status).toBe("completed");
      const ends = typed(trace, "run-end");
      expect(ends).toHaveLength(1);
      expect(ends[0]).toMatchObject({
        type: "run-end",
        status: "completed",
        usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
      });
    } finally {
      await runtime.close();
      fetchProbe.restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records host-known plugin outcomes, including one optional failure", async () => {
    const root = await createRuntimeRoot(`${tracedConfig()}plugins:\n  tools-core:\n    root: .\n`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const trace = stubTraceHost();
    const runtime = await createRuntime({ root, traceHost: trace.host });
    try {
      expect(
        typed(trace, "plugin-load")
          .flatMap((record) => (record.type === "plugin-load" ? [record.name] : []))
          .sort(),
      ).toEqual(["loop-react", "model-mock", "tools-basic"]);
      // Host-known: the name, and that the required set never needed it. Never the load error.
      expect(typed(trace, "plugin-load-failed")).toEqual([
        { type: "plugin-load-failed", name: "tools-core", required: false },
      ]);
      // The record costs the run nothing: the required capabilities are still the official ones.
      expect(runtime.registry.services.owner("tool:core")).toBe("tools-basic");
    } finally {
      warn.mockRestore();
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records a required plugin failure as a scalar and still fails closed", async () => {
    const root = await createRuntimeRoot(`tools:\n  root: not-a-directory\n${enabled}`);
    await writeFile(join(root, "not-a-directory"), "not a directory", "utf8");
    const trace = stubTraceHost();
    try {
      await expect(createRuntime({ root, traceHost: trace.host })).rejects.toThrow(
        /tools root must be a directory/,
      );
      // The rejection names nothing, so the record names the required plugin the registry lost.
      expect(typed(trace, "plugin-load-failed")).toEqual([
        { type: "plugin-load-failed", name: "loop-react", required: true },
      ]);
      // No run ever started, so no run record claims otherwise.
      expect(typed(trace, "run-start")).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("emits no task text, model text, tool output, key, header, or absolute path", async () => {
    const task = "write file notes.txt with content hello";
    const root = await createRuntimeRoot(tracedConfig("model:\n  apiKeyFile: user/secrets/provider.key\n"));
    await writeDummyApiKey(root, "test-trace-key");
    vi.stubEnv("OPENAI_API_KEY", "dummy-trace-key");
    vi.stubEnv("NEXUS_TRACE_KEY", "dummy-trace-key");
    vi.stubEnv("SECRET_HEADER", "Bearer eyJhbGciOiJIUzI1NiJ9.dGVzdC1wYXlsb2Fk.c2ln");
    const trace = stubTraceHost();
    const runtime = await createRuntime({ root, traceHost: trace.host });
    try {
      // A run with a tool call, so there is a written file and tool output to leak, and neither does.
      expect((await runtime.runner.run(task)).status).toBe("completed");
      expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("hello");
      const json = JSON.stringify(trace.records());
      for (const forbidden of [
        task,
        "hello",
        "test-trace-key",
        "dummy-trace-key",
        "sk-",
        "Bearer",
        "apiKey",
        "apiKeyFile",
        "provider.key",
        "OPENAI_API_KEY",
        "SECRET_HEADER",
        "notes.txt",
        root,
        "/",
      ]) {
        expect(json, `the trace must not contain ${forbidden}`).not.toContain(forbidden);
      }
      // A closed field set per record: a transcript, a path, or a config field has no slot at all.
      for (const record of trace.records()) {
        const fields = Object.keys(record).sort();
        expect(fields).toEqual(
          record.type === "plugin-load" || record.type === "plugin-load-failed"
            ? ["name", "required", "type"]
            : record.type === "run-start"
              ? ["model", "provider", "type"]
              : record.type === "run-step"
                ? ["steps", "type"]
                : ["status", "steps", "toolCalls", "type"],
        );
      }
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a refused write out of the run's result and its exit", async () => {
    const root = await createRuntimeRoot(tracedConfig());
    const trace = stubTraceHost();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = await createRuntime({ root, traceHost: trace.host });
    try {
      const before = await runtime.runner.run("say hello");
      expect(trace.stats()).toMatchObject({ written: 6, failures: 0 });
      trace.refuse();
      const steps: number[] = [];
      await withSessionStore(async ({ store }) => {
        const run = await runSession(runtime, {
          task: "say hello",
          store,
          onStep: (record) => {
            steps.push(record.step);
          },
        });
        // Observability must never be the reason a task fails: same status, same text, same steps.
        expect(run.result).toMatchObject(before);
        expect(run.result.status).toBe("completed");
        expect(steps).toEqual([1]);
        expect((await store.load(run.sessionId)).at(-1)).toMatchObject({ type: "run-end" });
      });
      // The refusals are counted and reported, never thrown at the loop.
      expect(trace.stats().failures).toBeGreaterThan(0);
      expect(warn.mock.calls.some((call) => String(call[0]).includes("refused"))).toBe(true);
      await expect(runtime.close()).resolves.toBeUndefined();
    } finally {
      warn.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves the session transcript and the sandbox run as they were", async () => {
    const root = await createRuntimeRoot(tracedConfig());
    const trace = stubTraceHost();
    const runtime = await createRuntime({ root, traceHost: trace.host });
    try {
      await withSessionStore(async ({ store }) => {
        const steps: number[] = [];
        const run = await runSession(runtime, {
          task: "say hello",
          store,
          onStep: (record) => {
            steps.push(record.step);
          },
        });
        // The store still owns the transcript: tracing hooks in after it, never instead of it.
        expect((await store.load(run.sessionId)).map((record) => record.type)).toEqual([
          "run-start",
          "run-step",
          "run-end",
        ]);
        expect(steps).toEqual([1]);
        // One run-step per recorded step, and the transcript text stayed in the session store.
        expect(typed(trace, "run-step")).toEqual([{ type: "run-step", steps: 1 }]);
        expect(JSON.stringify(trace.records())).not.toContain("say hello");
      });
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
    // The sandbox builds its own offline config, which carries no trace block, so it is untraced.
    const sandboxed = await runInSandbox("say hello");
    expect(sandboxed.status).toBe("completed");
    expect(sandboxed.workspaceCleaned).toBe(true);
    expect(JSON.stringify(sandboxed)).not.toMatch(/trace/i);
  });

  it("hands the real log every host record, plugin lifecycle included", async () => {
    const root = await createRuntimeRoot(`${tracedConfig()}plugins:\n  tools-core:\n    root: .\n`);
    const logRoot = await mkdtemp(join(tmpdir(), "nexus-trace-log-"));
    // The real writer, pinned to a temp root: production takes its own default, which is its business.
    const writer = createTraceWriter({ enabled: true, root: logRoot });
    const runtime = await createRuntime({ root, traceHost: () => writer });
    try {
      expect((await runtime.runner.run("say hello")).status).toBe("completed");
      const text = await readFile(join(logRoot, "trace.jsonl"), "utf8");
      const lines = text
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      // Every record the host produced is stored, plugin lifecycle included, in the order it happened.
      expect(lines.map((line) => line.type)).toEqual([
        "plugin-load",
        "plugin-load",
        "plugin-load",
        "plugin-load-failed",
        "run-start",
        "run-step",
        "run-end",
      ]);
      expect(lines[0]).toMatchObject({ schemaVersion: 1, name: "model-mock", required: true });
      expect(lines[3]).toMatchObject({ name: "tools-core", required: false });
      expect(lines[4]).toMatchObject({ schemaVersion: 1, provider: "mock", model: "mock" });
      expect(lines[6]).toMatchObject({ status: "completed" });
      expect(lines.every((line) => typeof line.runId === "string" && typeof line.ts === "string")).toBe(true);
      // A plugin record is a name and a boolean: no load error, no manifest path, no version.
      expect(Object.keys(lines[3] ?? {}).sort()).toEqual([
        "name",
        "required",
        "runId",
        "schemaVersion",
        "seq",
        "ts",
        "type",
      ]);
      for (const leaked of [
        "tools root must be a directory",
        "not-a-directory",
        "manifest",
        "plugins/tools-core",
        join(root, "user", "config.yaml"),
      ]) {
        expect(text, `the trace must not contain ${leaked}`).not.toContain(leaked);
      }
      expect(writer.stats()).toMatchObject({ written: 7, failures: 0 });
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
      await rm(logRoot, { recursive: true, force: true });
    }
  });

  it("passes config.trace.maxBytes to the writer, so the cap is the configured one", async () => {
    const root = await createRuntimeRoot(`${mockConfig}trace:\n  enabled: true\n  maxBytes: 4096\n`);
    const logRoot = await mkdtemp(join(tmpdir(), "nexus-trace-cap-"));
    const seen: TraceWriterOptions[] = [];
    const runtime = await createRuntime({
      root,
      // The real writer, so the cap is proven on the file rather than on a double's options bag.
      traceHost: (options) => {
        seen.push(options ?? {});
        return createTraceWriter({ ...options, root: logRoot });
      },
    });
    try {
      expect(seen).toEqual([{ enabled: true, maxBytes: 4096 }]);
      const writer = runtime.trace;
      // Only the boot records so far, and no rotation: the cap is in force before the first run.
      expect(writer?.stats()).toMatchObject({ written: 3, failures: 0, rotations: 0 });
      await fillTraceFile(join(logRoot, "trace.jsonl"), 4096);
      await chmod(join(logRoot, "trace.jsonl"), 0o600);
      // Over the configured cap, not the old 4 MiB constant: one append is enough to rotate.
      await runtime.runner.run("say hello");
      expect(writer?.stats().rotations).toBe(1);
      const lines = (await readFile(join(logRoot, "trace.jsonl"), "utf8")).split("\n").filter(Boolean);
      expect(lines).toHaveLength(3);
      expect(lines.map((line) => (JSON.parse(line) as { type: string }).type)).toEqual([
        "run-start",
        "run-step",
        "run-end",
      ]);
      expect(await readdir(logRoot)).toEqual(["trace.jsonl", "trace.jsonl.1"]);
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
      await rm(logRoot, { recursive: true, force: true });
    }
  });

  it("tells the model about the repo skills in a real run, without storing the index in the transcript", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-runtime-skills-"));
    try {
      await mkdir(join(root, "skills", "house-style"), { recursive: true });
      await writeFile(
        join(root, "skills", "house-style", "SKILL.md"),
        "---\nname: house-style\ndescription: How this repo writes prose.\n---\nBe plain.\n",
        "utf8",
      );
      await mkdir(join(root, "config"), { recursive: true });
      await mkdir(join(root, "user"), { recursive: true });
      await writeFile(
        join(root, "config", "default.yaml"),
        [
          "model:",
          "  provider: openai",
          "  model: gpt-4o-mini",
          "  apiKeyFile: user/secrets/provider.key",
        ].join("\n"),
        "utf8",
      );
      await writeFile(join(root, "user", "config.yaml"), "permissions:\n  network: allow\n", "utf8");
      await writeDummyApiKey(root);
      const fetchProbe = stubOpenAIFetch("done");
      const runtime = await createRuntime({ root });
      const transcripts: ModelMessage[][] = [];
      try {
        const result = await runtime.runner.run("say hello", {
          onStep: (record) => {
            transcripts.push(record.messages.slice());
          },
        });
        expect(result.status).toBe("completed");
        // The gateway request is the proof the model was told: the index rides the system message.
        const sent = fetchProbe.body() as { messages: { role: string; content: string }[] };
        const system = sent.messages.find((message) => message.role === "system");
        expect(system?.content).toContain("Available skills");
        expect(system?.content).toContain(
          "- house-style — How this repo writes prose. (skills/house-style/SKILL.md)",
        );
        // The body is never inlined, and the stored transcript stays free of the index.
        expect(JSON.stringify(sent)).not.toContain("Be plain.");
        expect(JSON.stringify(transcripts)).not.toContain("Available skills");
      } finally {
        await runtime.close();
        fetchProbe.restore();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("tells the model about the repo skills on the routed path too", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-runtime-skills-route-"));
    try {
      await mkdir(join(root, "skills", "house-style"), { recursive: true });
      await writeFile(
        join(root, "skills", "house-style", "SKILL.md"),
        "---\nname: house-style\ndescription: How this repo writes prose.\n---\nBe plain.\n",
        "utf8",
      );
      await mkdir(join(root, "config"), { recursive: true });
      await mkdir(join(root, "user"), { recursive: true });
      await writeFile(
        join(root, "config", "default.yaml"),
        ["model:", "  provider: openai", "  model: cheap-1", "  apiKeyFile: user/secrets/provider.key"].join(
          "\n",
        ),
        "utf8",
      );
      await writeFile(
        join(root, "user", "config.yaml"),
        [
          "permissions:",
          "  network: allow",
          "plugins:",
          "  model-openai:",
          "    router:",
          "      enabled: true",
          "      strong: strong-1",
          "      maxTaskChars: 10",
        ].join("\n"),
        "utf8",
      );
      await writeDummyApiKey(root);
      const fetchProbe = stubOpenAIFetch("done");
      const runtime = await createRuntime({ root });
      try {
        // A task past the threshold routes to the strong model; the index must ride that run too.
        expect((await runtime.runner.run("x".repeat(20))).status).toBe("completed");
        const sent = fetchProbe.body() as { model: string; messages: { role: string; content: string }[] };
        expect(sent.model).toBe("strong-1");
        expect(sent.messages.find((message) => message.role === "system")?.content).toContain(
          "- house-style — How this repo writes prose.",
        );
      } finally {
        await runtime.close();
        fetchProbe.restore();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
