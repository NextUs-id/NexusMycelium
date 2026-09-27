import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  type BenchmarkMainOptions,
  type BenchmarkReport,
  benchmarkTasks,
  main,
  runBenchmark,
} from "./run.js";

const SECRET = "benchmark-secret-canary";
const TASK_IDS = [
  "ts-constant",
  "py-add",
  "json-record",
  "yaml-settings",
  "css-grid",
  "html-main",
  "sql-filter",
  "slug-regex",
  "weekday-check",
  "markdown-note",
  "state-initial",
  "csv-header",
  "env-mode",
  "xml-record",
  "ignore-list",
  "average",
  "badge-component",
  "health-handler",
  "rust-answer",
  "jsonl-event",
] as const;

const forbiddenTaskPatterns = [
  /\b[a-z][a-z\d+.-]*:\/\//iu,
  /(?:^|[\s"'`=:])\/(?:Users|home|root|tmp|var|etc|opt|srv|data|user|mnt|media|workspace|workspaces|private)(?:\/|$)/iu,
  /(?:^|[\s"'`=:])(?:[A-Za-z]:[\\/]|\\\\)/u,
  /\b(?:bash|sh|zsh|fish|powershell|pwsh|cmd|curl|wget|ssh|scp|rsync|npm|pnpm|npx|yarn|node(?:\.js)?|python\d*|ruby|perl|php|java|javac|dotnet|git|exec|spawn|shell)\b/iu,
  /\b(?:fetch|axios|requests?|https?|sockets?|websockets?|dns|network|internet|download|upload|playwright|puppeteer|selenium|browser|9router)\b/iu,
  /\b(?:users?|usernames?|home|passwd|shadow|credentials?|secrets?|api[_ -]?keys?|database|personal|private|data)\b/iu,
] as const;

const HASH_PATTERN = /^[a-f\d]{64}$/u;
const EXPECTED_REPRODUCIBILITY = {
  schemaVersion: "1.0",
  runner: { name: "nexus-benchmark", version: "1" },
  config: { version: "1", hash: expect.stringMatching(HASH_PATTERN) },
  tasks: {
    manifestHash: expect.stringMatching(HASH_PATTERN),
    verifierHash: expect.stringMatching(HASH_PATTERN),
  },
  provider: { name: "model-mock", version: "0.1.0" },
  model: { name: "mock", version: "0.1.0" },
  tool: { name: "tools-basic", version: "0.1.0" },
  agent: { name: "loop-react", version: "0.1.0" },
} as const;
const PASSING_TASK = {
  id: "internal-pass",
  prompt: 'Write result.txt with content "ok"',
  expected: { "result.txt": "ok" },
  expectedVerifier: async () => true,
};
const FAILING_TASK = {
  ...PASSING_TASK,
  id: "internal-fail",
  expectedVerifier: async () => false,
};

function normalize(value: unknown, tempRoot: string): unknown {
  if (typeof value === "string") return value.replaceAll(tempRoot, "<temp>");
  if (Array.isArray(value)) return value.map((item) => normalize(item, tempRoot));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !/^elapsed(?:ms)?$/iu.test(key))
      .map(([key, item]) => [key, normalize(item, tempRoot)]),
  );
}

async function captureMain(
  options: BenchmarkMainOptions,
): Promise<{ code: number; report: BenchmarkReport }> {
  let output = "";
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  try {
    const code = await main(options);
    return { code, report: JSON.parse(output.trim()) as BenchmarkReport };
  } finally {
    writeSpy.mockRestore();
  }
}

function expectReport(report: BenchmarkReport): void {
  expect(report).toEqual({
    schemaVersion: "1.0",
    scope: "benchmark",
    status: "completed",
    provider: "mock",
    model: "mock",
    elapsedMs: expect.any(Number),
    totals: {
      tasks: 20,
      succeeded: 20,
      failed: 0,
      successRate: 1,
      elapsedMs: expect.any(Number),
      steps: expect.any(Number),
      toolCalls: expect.any(Number),
      tools: expect.any(Array),
    },
    summary: {
      planned: 20,
      attempted: 20,
      succeeded: 20,
      failed: 0,
      successRate: 1,
    },
    successRate: 1,
    usage: {
      status: "unavailable",
      source: "model-mock",
      method: "provider-does-not-report",
      version: "1",
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    },
    cost: {
      amount: 0,
      currency: "USD",
      source: "mock-not-billed",
    },
    results: expect.any(Array),
    taskSetHash: expect.stringMatching(HASH_PATTERN),
    reproducibility: EXPECTED_REPRODUCIBILITY,
    reproducibilityHash: expect.stringMatching(HASH_PATTERN),
  });
  expect(report.results).toHaveLength(20);
  for (const [index, result] of report.results.entries()) {
    expect(result).toEqual(
      expect.objectContaining({
        id: TASK_IDS[index],
        success: true,
        status: "completed",
        elapsedMs: expect.any(Number),
      }),
    );
  }
}

describe("benchmark contract", () => {
  it("defines exactly 20 fixed, unique, safe, and verifiable tasks", () => {
    expect(benchmarkTasks).toHaveLength(20);
    expect(benchmarkTasks.map((task) => task.id)).toEqual(TASK_IDS);
    expect(new Set(benchmarkTasks.map((task) => task.id)).size).toBe(20);

    for (const task of benchmarkTasks) {
      const content = `${task.prompt}\n${JSON.stringify(task.expected)}`;
      expect(task.expectedVerifier).toBeTypeOf("function");
      expect(Object.keys(task.expected)).not.toHaveLength(0);
      for (const [path, expected] of Object.entries(task.expected)) {
        expect(isAbsolute(path)).toBe(false);
        expect(path).not.toMatch(/^(?:[A-Za-z]:[\\/]|\\\\)/u);
        expect(path).not.toContain("\\");
        expect(path.split("/")).not.toContain(".");
        expect(path.split("/")).not.toContain("..");
        expect(expected).toBeTypeOf("string");
      }
      for (const pattern of forbiddenTaskPatterns) expect(content).not.toMatch(pattern);
    }
  });

  it("runs the mock benchmark twice without leaking artifacts or report-only data", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-benchmark-test-"));
    await writeFile(join(root, "secret.txt"), SECRET, "utf8");
    const previousSecret = process.env.NEXUS_BENCHMARK_TEST_SECRET;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network disabled in benchmark test"));
    process.env.NEXUS_BENCHMARK_TEST_SECRET = SECRET;

    try {
      const first = await runBenchmark({ provider: "mock", root });
      const second = await runBenchmark({ provider: "mock", root, tasks: benchmarkTasks });

      expectReport(first);
      expectReport(second);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await readdir(root)).toEqual(["secret.txt"]);
      expect(normalize(first, root)).toEqual(normalize(second, root));
      expect(normalize({ elapsed: 1, elapsedMs: 2, duration: 3, timestamp: 4, root }, root)).toEqual({
        duration: 3,
        timestamp: 4,
        root: "<temp>",
      });

      for (const report of [first, second]) {
        const serialized = JSON.stringify(report);
        expect(serialized).not.toContain(SECRET);
        expect(serialized).not.toContain(root);
        expect(serialized).not.toMatch(/(?:^|[\s"'=:])\/[^\s"'`]+/u);
        expect(serialized).not.toMatch(/"(?:raw)?prompt"|"(?:secret|credentials?|apiKey|authorization)"/iu);
        for (const task of benchmarkTasks) expect(serialized).not.toContain(task.prompt);
      }
    } finally {
      fetchSpy.mockRestore();
      if (previousSecret === undefined) delete process.env.NEXUS_BENCHMARK_TEST_SECRET;
      else process.env.NEXUS_BENCHMARK_TEST_SECRET = previousSecret;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("benchmark validation and exit gates", () => {
  it("rejects empty, duplicate, and non-20 canonical task sets", async () => {
    const duplicate = benchmarkTasks.at(0);
    if (duplicate === undefined) throw new Error("benchmark task fixture is empty");
    await expect(runBenchmark({ tasks: [] })).rejects.toThrow(/empty/u);
    await expect(runBenchmark({ tasks: Array.from({ length: 20 }, () => duplicate) })).rejects.toThrow(
      /invalid benchmark task set/u,
    );
    await expect(runBenchmark({ tasks: benchmarkTasks.slice(0, 19) })).rejects.toThrow(/exactly 20/u);
  });

  it("allows custom tasks only through internal options and still applies the 20-success gate", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-benchmark-internal-"));
    try {
      const custom = await runBenchmark({ root, internal: { tasks: [PASSING_TASK] } });
      expect(custom).toEqual(
        expect.objectContaining({
          summary: expect.objectContaining({ planned: 1, attempted: 1, succeeded: 1, failed: 0 }),
        }),
      );
      const gated = await captureMain({ root, internal: { tasks: [PASSING_TASK] } });
      expect(gated.code).toBe(1);
      expect(gated.report.summary.succeeded).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails verifier failures unless report-only is explicitly enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-benchmark-gate-"));
    try {
      const gated = await captureMain({ root, internal: { tasks: [FAILING_TASK] } });
      expect(gated.code).toBe(1);
      expect(gated.report.results).toEqual([
        expect.objectContaining({
          id: FAILING_TASK.id,
          success: false,
          status: "completed",
          error: "expected-files-mismatch",
        }),
      ]);
      const reportOnly = await captureMain({
        root,
        internal: { tasks: [FAILING_TASK] },
        reportOnly: true,
      });
      expect(reportOnly.code).toBe(0);
      expect(reportOnly.report.results[0]?.success).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps harness errors non-zero in report-only mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-benchmark-harness-error-"));
    const blockedRoot = join(root, "not-a-directory");
    await writeFile(blockedRoot, "blocked", "utf8");
    try {
      const captured = await captureMain({
        root: blockedRoot,
        internal: { tasks: [PASSING_TASK] },
        reportOnly: true,
      });
      expect(captured.code).toBe(1);
      expect(captured.report).toEqual(
        expect.objectContaining({
          status: "error",
          harnessError: "workspace-setup-failed",
          results: [expect.objectContaining({ success: false, status: "error" })],
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("benchmark provenance and schema", () => {
  it("hashes task, expected, verifier, config, and runtime provenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-benchmark-provenance-"));
    const manifestChanged = {
      ...PASSING_TASK,
      prompt: 'Write result.txt with content "changed"',
      expected: { "result.txt": "changed" },
    };
    const expectedChanged = { ...PASSING_TASK, expected: { "result.txt": "different" } };
    const verifierChanged = { ...PASSING_TASK, expectedVerifier: async () => false };
    try {
      const base = await runBenchmark({ root, internal: { tasks: [PASSING_TASK] } });
      const manifestReport = await runBenchmark({ root, internal: { tasks: [manifestChanged] } });
      const expectedReport = await runBenchmark({ root, internal: { tasks: [expectedChanged] } });
      const verifierReport = await runBenchmark({ root, internal: { tasks: [verifierChanged] } });
      const expectedHash = createHash("sha256").update(JSON.stringify(base.reproducibility)).digest("hex");

      expect(base.reproducibilityHash).toBe(expectedHash);
      expect(base.reproducibility.tasks.manifestHash).not.toBe(
        manifestReport.reproducibility.tasks.manifestHash,
      );
      expect(base.reproducibility.tasks.verifierHash).not.toBe(
        expectedReport.reproducibility.tasks.verifierHash,
      );
      expect(base.reproducibility.tasks.verifierHash).not.toBe(
        verifierReport.reproducibility.tasks.verifierHash,
      );
      expect(base.reproducibilityHash).not.toBe(manifestReport.reproducibilityHash);
      expect(base.reproducibilityHash).not.toBe(expectedReport.reproducibilityHash);
      expect(base.reproducibilityHash).not.toBe(verifierReport.reproducibilityHash);
      expect(base.taskSetHash).toBe(verifierReport.taskSetHash);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("emits the full report schema for a top-level harness error", async () => {
    const captured = await captureMain({ tasks: [] });
    expect(captured.code).toBe(1);
    expect(captured.report).toEqual({
      schemaVersion: "1.0",
      scope: "benchmark",
      status: "error",
      provider: "mock",
      model: "mock",
      elapsedMs: expect.any(Number),
      totals: {
        tasks: 0,
        succeeded: 0,
        failed: 0,
        successRate: 0,
        elapsedMs: expect.any(Number),
        steps: 0,
        toolCalls: 0,
        tools: [],
      },
      summary: { planned: 0, attempted: 0, succeeded: 0, failed: 0, successRate: 0 },
      successRate: 0,
      usage: {
        status: "unavailable",
        source: "model-mock",
        method: "provider-does-not-report",
        version: "1",
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
      },
      cost: { amount: 0, currency: "USD", source: "mock-not-billed" },
      results: [],
      taskSetHash: expect.stringMatching(HASH_PATTERN),
      reproducibility: EXPECTED_REPRODUCIBILITY,
      reproducibilityHash: expect.stringMatching(HASH_PATTERN),
      harnessError: "benchmark-harness-failed",
    });
  });
});
