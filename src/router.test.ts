import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readCostReport } from "./report.js";
import { chooseRouterModel, routerPolicy } from "./router.js";
import { createRuntimeRoot, writeDummyApiKey } from "./runtime.fixtures.js";
import { createRuntime, runSession } from "./runtime.js";
import { createSessionStore } from "./session.js";

const policy = { cheapModel: "cheap-1", strongModel: "strong-1", maxTaskChars: 100 };

describe("model router", () => {
  it("keeps a short task on the cheap model and a long one on the strong model", () => {
    expect(chooseRouterModel("fix the typo", policy)).toEqual({
      model: "cheap-1",
      reason: "cheap",
      taskChars: 12,
    });
    expect(chooseRouterModel("x".repeat(101), policy).model).toBe("strong-1");
  });

  it("measures the trimmed task, so padding cannot buy the strong model", () => {
    const padded = `   ${"x".repeat(100)}   `;
    expect(chooseRouterModel(padded, policy)).toMatchObject({ model: "cheap-1", taskChars: 100 });
    // Exactly at the threshold is still the cheap model: the strong one is over it, not at it.
    expect(chooseRouterModel("x".repeat(100), policy).model).toBe("cheap-1");
    expect(chooseRouterModel("x".repeat(101), policy).model).toBe("strong-1");
  });

  it("resolves a policy only from a block that is switched on and names a different model", () => {
    const config = { model: { model: "cheap-1" }, plugin: {} };
    expect(routerPolicy(config)).toBeUndefined();
    expect(routerPolicy({ ...config, plugin: { router: { enabled: false, strong: "s" } } })).toBeUndefined();
    expect(
      routerPolicy({ ...config, plugin: { router: { enabled: true, strong: "cheap-1" } } }),
    ).toBeUndefined();
    expect(routerPolicy({ ...config, plugin: { router: { enabled: "yes", strong: "s" } } })).toBeUndefined();
    expect(routerPolicy({ ...config, plugin: { router: { enabled: true, strong: "strong-1" } } })).toEqual({
      cheapModel: "cheap-1",
      strongModel: "strong-1",
      maxTaskChars: 2000,
    });
  });

  it("runs a short task on the cheap model and a long one on the strong model, and records both", async () => {
    const bodies: Record<string, unknown>[] = [];
    const previous = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        }),
        { status: 200 },
      );
    };
    const home = await mkdtemp(join(tmpdir(), "nexus-router-home-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    const root = await createRuntimeRoot(
      [
        "model:",
        "  provider: openai",
        "  model: cheap-1",
        "  apiKeyFile: user/secrets/provider.key",
        "permissions:",
        "  network: allow",
        "trace:",
        "  enabled: true",
        "budget:",
        "  enabled: true",
        "  maxTotalTokens: 100000",
        "  prices:",
        "    cheap-1:",
        "      inputUsdPerMillionTokens: 0.15",
        "      outputUsdPerMillionTokens: 0.6",
        "    strong-1:",
        "      inputUsdPerMillionTokens: 3",
        "      outputUsdPerMillionTokens: 15",
        "plugins:",
        "  model-openai:",
        "    router:",
        "      enabled: true",
        "      strong: strong-1",
        "      maxTaskChars: 50",
      ].join("\n"),
    );
    await writeDummyApiKey(root);
    const runtime = await createRuntime({ root });
    try {
      expect((await runtime.runner.run("short")).status).toBe("completed");
      expect((await runtime.runner.run("x".repeat(51))).status).toBe("completed");
    } finally {
      await runtime.close();
      globalThis.fetch = previous;
    }
    expect(bodies.map((body) => body.model)).toEqual(["cheap-1", "strong-1"]);
    // Each run records the model it really used, so `nexus report` prices it correctly.
    const report = await readCostReport({ prices: {} });
    if (!report.ok) throw new Error(`expected a report, got ${report.reason}`);
    expect(report.report.rows.map((row) => row.model)).toEqual(["cheap-1", "strong-1"]);
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it("stops a routed run as unpriced when the strong model has no price, instead of running it free", async () => {
    const bodies: Record<string, unknown>[] = [];
    const previous = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        }),
        { status: 200 },
      );
    };
    const root = await createRuntimeRoot(
      [
        "model:",
        "  provider: openai",
        "  model: cheap-1",
        "  apiKeyFile: user/secrets/provider.key",
        "permissions:",
        "  network: allow",
        "budget:",
        "  enabled: true",
        "  maxTotalTokens: 100000",
        "  maxCostUsd: 1",
        "  prices:",
        "    cheap-1:",
        "      inputUsdPerMillionTokens: 0.15",
        "      outputUsdPerMillionTokens: 0.6",
        "plugins:",
        "  model-openai:",
        "    router:",
        "      enabled: true",
        "      strong: strong-1",
        "      maxTaskChars: 50",
      ].join("\n"),
    );
    await writeDummyApiKey(root);
    const runtime = await createRuntime({ root });
    try {
      const result = await runtime.runner.run("x".repeat(51), { budget: runtime.budget });
      expect(result.status).toBe("stopped");
      expect(result.error).toBe("budget:cost-unpriced");
    } finally {
      await runtime.close();
      globalThis.fetch = previous;
    }
    // The guard learns a model is unpriced from the first turn, so exactly one request was made and
    // the run stopped there: no second turn, and nothing reported as spent.
    expect(bodies.map((body) => body.model)).toEqual(["strong-1"]);
    await rm(root, { recursive: true, force: true });
  });

  it("pins a session to the model its task routed to, and refuses a resume that would switch models", async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        }),
        { status: 200 },
      );
    const root = await createRuntimeRoot(
      [
        "model:",
        "  provider: openai",
        "  model: cheap-1",
        "  apiKeyFile: user/secrets/provider.key",
        "permissions:",
        "  network: allow",
        "plugins:",
        "  model-openai:",
        "    router:",
        "      enabled: true",
        "      strong: strong-1",
        "      maxTaskChars: 50",
      ].join("\n"),
    );
    await writeDummyApiKey(root);
    const store = await createSessionStore({ root: join(root, "sessions") });
    const runtime = await createRuntime({ root });
    try {
      const long = await runSession(runtime, { store, task: "x".repeat(51) });
      const short = await runSession(runtime, { store, task: "tiny" });
      expect((await store.load(long.sessionId))[0]).toMatchObject({ model: "strong-1" });
      expect((await store.load(short.sessionId))[0]).toMatchObject({ model: "cheap-1" });
      // Resuming a stored strong-model session with a task that routes to the cheap model fails closed,
      // because the transcript was produced by a model this run will not use.
      await expect(runSession(runtime, { store, sessionId: long.sessionId, task: "tiny" })).rejects.toThrow(
        /differs from current/,
      );
    } finally {
      await runtime.close();
      globalThis.fetch = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
});
