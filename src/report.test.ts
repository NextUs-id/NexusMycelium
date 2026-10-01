import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ModelPrice } from "../kernel/src/model.js";
import { readCostReport, renderReport } from "./report.js";
import { createRuntimeRoot, stubOpenAIFetch, writeDummyApiKey } from "./runtime.fixtures.js";
import { createRuntime } from "./runtime.js";
import { TRACE_SCHEMA_VERSION } from "./trace.js";

const prices: Readonly<Record<string, ModelPrice>> = {
  "gpt-4o-mini": { inputUsdPerMillionTokens: 0.15, outputUsdPerMillionTokens: 0.6 },
};

/** A record with the envelope the writer itself writes, so the reader sees what it will really see. */
function record(value: Record<string, unknown>, seq = 1): string {
  return JSON.stringify({
    schemaVersion: TRACE_SCHEMA_VERSION,
    ts: "2026-09-27T00:00:00.000Z",
    runId: "0123456789abcdef",
    seq,
    ...value,
  });
}

async function writeTrace(lines: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nexus-report-"));
  const path = join(root, "trace.jsonl");
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
  return path;
}

describe("cost report", () => {
  it("prices a run with the model its own run-start recorded", async () => {
    const path = await writeTrace([
      record({ type: "run-start", provider: "openai", model: "gpt-4o-mini" }),
      record({
        type: "run-end",
        status: "completed",
        steps: 2,
        toolCalls: 1,
        usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
      }),
    ]);
    const result = await readCostReport({ path, prices });
    if (!result.ok) throw new Error("expected a report");
    expect(result.report.rows).toHaveLength(1);
    expect(result.report.rows[0]).toMatchObject({
      model: "gpt-4o-mini",
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      costMicroUsd: 450,
    });
    // 1000 * 0.15 + 500 * 0.6 = 450 micro-USD, computed as integers so no float can round it.
    expect(result.report.totals).toMatchObject({
      runs: 1,
      runsWithUsage: 1,
      runsPriced: 1,
      totalTokens: 1500,
      costMicroUsd: 450,
    });
  });

  it("counts a run that reported no usage as unavailable, never as zero", async () => {
    const path = await writeTrace([
      record({ type: "run-start", provider: "mock", model: "mock" }),
      record({ type: "run-end", status: "stopped", steps: 1, toolCalls: 0 }),
    ]);
    const result = await readCostReport({ path, prices });
    if (!result.ok) throw new Error("expected a report");
    expect(result.report.rows[0]).toMatchObject({ totalTokens: null, costMicroUsd: null });
    expect(result.report.totals).toMatchObject({
      runs: 1,
      runsWithUsage: 0,
      runsWithoutUsage: 1,
      totalTokens: 0,
    });
    const text = renderReport(result.report);
    expect(text).toContain("unavailable");
    expect(text).toMatch(/not zero/);
  });

  it("counts a model with no price as unpriced, never as free", async () => {
    const path = await writeTrace([
      record({ type: "run-start", provider: "openai", model: "unpriced-model" }),
      record({
        type: "run-end",
        status: "completed",
        steps: 1,
        toolCalls: 0,
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
      }),
    ]);
    const result = await readCostReport({ path, prices });
    if (!result.ok) throw new Error("expected a report");
    expect(result.report.rows[0]?.costMicroUsd).toBeNull();
    expect(result.report.totals.runsUnpriced).toBe(1);
    expect(renderReport(result.report)).toMatch(/not free/);
  });

  it("counts a refused record and an unpaired run-end instead of repairing either", async () => {
    const path = await writeTrace([
      "{not json",
      record({ type: "run-end", status: "completed", steps: 1, toolCalls: 0 }),
      record({
        type: "run-end",
        status: "completed",
        steps: 1,
        toolCalls: 0,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }),
    ]);
    const result = await readCostReport({ path, prices });
    if (!result.ok) throw new Error("expected a report");
    expect(result.report.refusedRecords).toBe(1);
    // Nothing above ever opened a run, so both run-ends are unpaired: counted, never guessed at.
    expect(result.report.runEndsWithoutStart).toBe(2);
    expect(result.report.rows[1]?.model).toBe("unknown");
  });

  it("refuses a log with no finished run, and a log that is not there", async () => {
    const empty = await writeTrace([record({ type: "run-start", provider: "mock", model: "mock" })]);
    const emptyResult = await readCostReport({ path: empty, prices });
    expect(emptyResult.ok).toBe(false);
    if (emptyResult.ok) throw new Error("unreachable");
    expect(emptyResult.reason).toBe("no-runs");
    const missing = await readCostReport({ path: join(empty, "absent.jsonl"), prices });
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error("unreachable");
    expect(missing.reason).toBe("no-trace");
    expect(missing.message).toContain("trace:");
  });

  it("renders a table whose numbers are the measured ones", async () => {
    const path = await writeTrace([
      record({ type: "run-start", provider: "openai", model: "gpt-4o-mini" }),
      record({
        type: "run-end",
        status: "completed",
        steps: 2,
        toolCalls: 1,
        usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
      }),
    ]);
    const result = await readCostReport({ path, prices });
    if (!result.ok) throw new Error("expected a report");
    const text = renderReport(result.report);
    expect(text).toContain("gpt-4o-mini");
    expect(text).toContain("0.000450");
    expect(text).toMatch(/runs 1/);
    expect(text).toMatch(/cache reads are not in the trace schema/);
  });

  it("reports a real run: the runtime writes the trace and the report reads it back", async () => {
    const home = await mkdtemp(join(tmpdir(), "nexus-report-home-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    const root = await createRuntimeRoot(
      [
        "model:",
        "  provider: openai",
        "  model: gpt-4o-mini",
        "  apiKeyFile: user/secrets/provider.key",
        "permissions:",
        "  network: allow",
        "trace:",
        "  enabled: true",
        "budget:",
        "  enabled: true",
        "  maxTotalTokens: 1000000",
        "  prices:",
        "    gpt-4o-mini:",
        "      inputUsdPerMillionTokens: 0.15",
        "      outputUsdPerMillionTokens: 0.6",
      ].join("\n"),
    );
    await writeDummyApiKey(root);
    const fetchProbe = stubOpenAIFetch("ok", {
      prompt_tokens: 2000,
      completion_tokens: 500,
      total_tokens: 2500,
    });
    const runtime = await createRuntime({ root });
    try {
      // The guard has to be armed: 3.3 counts usage only while a policy is on, so a run made with the
      // guard off has nothing for a report to show and reports `unavailable` rather than zero.
      expect((await runtime.runner.run("say hello", { budget: runtime.budget })).status).toBe("completed");
    } finally {
      await runtime.close();
      fetchProbe.restore();
    }
    const result = await readCostReport({ prices });
    if (!result.ok) throw new Error(`expected a report, got ${result.reason}`);
    expect(result.report.rows).toHaveLength(1);
    expect(result.report.rows[0]).toMatchObject({
      status: "completed",
      model: "gpt-4o-mini",
      inputTokens: 2000,
      outputTokens: 500,
      totalTokens: 2500,
      // 2000 * 0.15 + 500 * 0.6 = 600 micro-USD.
      costMicroUsd: 600,
    });
    expect(result.report.totals).toMatchObject({ runs: 1, runsWithUsage: 1, runsPriced: 1 });
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });
});
