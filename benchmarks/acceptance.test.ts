import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type AcceptanceOptions,
  type AcceptanceReport,
  evaluateAcceptance,
  MIN_SUCCEEDED,
  main,
} from "./accept.js";
import { type BenchmarkReport, benchmarkTasks, runBenchmark } from "./run.js";

const SECRET = "acceptance-secret-canary";
const HASH_PATTERN = /^[a-f\d]{64}$/u;

let root = "";
let report: BenchmarkReport;
let acceptance: AcceptanceReport;

async function captureMain(options: AcceptanceOptions): Promise<{ code: number; output: string }> {
  let output = "";
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  try {
    const code = await main(options);
    return { code, output };
  } finally {
    writeSpy.mockRestore();
  }
}

/** The cast is the seam a test needs to forge what a real run can never emit. */
function reportWith(patch: Record<string, unknown>): BenchmarkReport {
  return { ...structuredClone(report), ...patch } as unknown as BenchmarkReport;
}

/** Same canonical report with a doctored success count, so the gate is exercised at its boundary. */
function withSuccesses(count: number): BenchmarkReport {
  return reportWith({
    results: report.results.map((item, index) =>
      index < count ? item : { ...item, success: false, status: "stopped", error: "runner-stopped" },
    ),
    summary: { planned: 20, attempted: 20, succeeded: count, failed: 20 - count, successRate: count / 20 },
  });
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "nexus-acceptance-"));
  report = await runBenchmark({ provider: "mock", root });
  acceptance = evaluateAcceptance(report);
}, 30_000);

afterAll(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true });
});

describe("task 2.6 acceptance over the canonical mock tasks", () => {
  it("accepts the 20 canonical tasks through config, discovery, loop, tool, artifact, and verifier", () => {
    expect(MIN_SUCCEEDED).toBe(5);
    expect(report.results.map((item) => item.id)).toEqual(benchmarkTasks.map((task) => task.id));
    expect(acceptance).toEqual({
      schemaVersion: "1.0",
      scope: "acceptance",
      status: "accepted",
      minSucceeded: 5,
      provider: "mock",
      summary: { planned: 20, attempted: 20, succeeded: 20, failed: 0 },
      phases: {
        config: { provider: "mock", model: "mock", configHash: expect.stringMatching(HASH_PATTERN) },
        discovery: {
          tools: expect.arrayContaining(["read_text", "write_text"]),
          tasksWithTools: 20,
        },
        loop: { steps: expect.any(Number), tasksWithSteps: 20 },
        tool: { toolCalls: expect.any(Number), tasksWithToolCalls: 20 },
        verifier: { verified: 20, rejected: 0 },
      },
      taskSetHash: report.taskSetHash,
      reproducibilityHash: report.reproducibilityHash,
      violations: [],
    });
  });

  it("emits one report line, exits 0, and touches no user config, key, or network", async () => {
    const runRoot = await mkdtemp(join(tmpdir(), "nexus-acceptance-main-"));
    await writeFile(join(runRoot, "secret.txt"), SECRET, "utf8");
    process.env.NEXUS_ACCEPTANCE_TEST_SECRET = SECRET;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network disabled in acceptance test"));
    try {
      const captured = await captureMain({ root: runRoot });
      const lines = captured.output.trim().split("\n");
      expect(captured.code).toBe(0);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "") as AcceptanceReport).toEqual(
        expect.objectContaining({ scope: "acceptance", status: "accepted", violations: [] }),
      );

      // Per-task temp roots are cleaned up and no user config directory is ever created.
      expect(await readdir(runRoot)).toEqual(["secret.txt"]);
      expect(existsSync(join(runRoot, "user"))).toBe(false);

      const serialized = lines[0] ?? "";
      expect(serialized).not.toContain(SECRET);
      expect(serialized).not.toContain(runRoot);
      expect(serialized).not.toMatch(/(?:^|[\s"'=:])\/[^\s"'`]+/u);
      for (const task of benchmarkTasks) expect(serialized).not.toContain(task.prompt);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      delete process.env.NEXUS_ACCEPTANCE_TEST_SECRET;
      await rm(runRoot, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("task 2.6 acceptance gate", () => {
  it("rejects a wrong expected artifact even when the runner status is completed", async () => {
    const negativeRoot = await mkdtemp(join(tmpdir(), "nexus-acceptance-negative-"));
    try {
      const wrong = await runBenchmark({
        root: negativeRoot,
        internal: {
          tasks: [
            {
              id: "acceptance-wrong",
              prompt: 'Write result.txt with content "ok"',
              expected: { "result.txt": "different" },
            },
          ],
        },
      });

      // The loop ran and the tool wrote a file, so status is completed and work is non-zero; only
      // the artifact check rejects it, which is what keeps the gate off `status` alone.
      expect(wrong.results).toEqual([
        expect.objectContaining({
          id: "acceptance-wrong",
          status: "completed",
          success: false,
          error: "expected-files-mismatch",
        }),
      ]);
      expect(wrong.results[0]?.steps).toBeGreaterThan(0);
      expect(wrong.results[0]?.toolCalls).toBeGreaterThan(0);

      const rejected = evaluateAcceptance(wrong);
      expect(rejected.status).toBe("rejected");
      expect(rejected.violations).toContain("below-minimum-succeeded");
      expect(rejected.phases.verifier).toEqual({ verified: 0, rejected: 1 });
    } finally {
      await rm(negativeRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("passes at exactly five end-to-end successes and fails below the floor", () => {
    expect(evaluateAcceptance(withSuccesses(5)).status).toBe("accepted");
    expect(evaluateAcceptance(withSuccesses(4)).violations).toEqual(["below-minimum-succeeded"]);
  });

  it("exits 1 and reports a rejection when the harness fails", async () => {
    const blockedRoot = await mkdtemp(join(tmpdir(), "nexus-acceptance-blocked-"));
    const notADirectory = join(blockedRoot, "not-a-directory");
    await writeFile(notADirectory, "blocked", "utf8");
    try {
      const captured = await captureMain({ root: notADirectory });
      expect(captured.code).toBe(1);
      expect(JSON.parse(captured.output.trim()) as AcceptanceReport).toEqual(
        expect.objectContaining({
          scope: "acceptance",
          status: "rejected",
          summary: { planned: 20, attempted: 20, succeeded: 0, failed: 20 },
          violations: ["harness-error", "report-error", "below-minimum-succeeded"],
        }),
      );

      // A root the harness cannot even use fails before a report exists; the line is still JSON.
      const invalid = await captureMain({ root: " " });
      expect(invalid.code).toBe(1);
      expect(JSON.parse(invalid.output.trim()) as AcceptanceReport).toEqual({
        schemaVersion: "1.0",
        scope: "acceptance",
        status: "rejected",
        minSucceeded: 5,
        provider: "mock",
        summary: { planned: 0, attempted: 0, succeeded: 0, failed: 0 },
        phases: {
          config: { provider: "mock", model: "mock", configHash: "" },
          discovery: { tools: [], tasksWithTools: 0 },
          loop: { steps: 0, tasksWithSteps: 0 },
          tool: { toolCalls: 0, tasksWithToolCalls: 0 },
          verifier: { verified: 0, rejected: 0 },
        },
        taskSetHash: "",
        reproducibilityHash: "",
        violations: ["harness-error"],
      });
    } finally {
      await rm(blockedRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects harness errors, non-mock providers, incomplete attempts, and work-free successes", () => {
    expect(evaluateAcceptance(reportWith({ harnessError: "workspace-setup-failed" })).violations).toEqual([
      "harness-error",
    ]);
    expect(evaluateAcceptance(reportWith({ status: "error" })).violations).toEqual(["report-error"]);
    expect(evaluateAcceptance(reportWith({ provider: "openai" })).violations).toEqual(["provider-not-mock"]);
    expect(
      evaluateAcceptance(reportWith({ summary: { ...report.summary, planned: 19 } })).violations,
    ).toEqual(["planned-not-canonical", "attempt-mismatch"]);
    expect(evaluateAcceptance(reportWith({ results: report.results.slice(0, 19) })).violations).toEqual([
      "attempt-mismatch",
      "summary-mismatch",
    ]);
    expect(
      evaluateAcceptance(reportWith({ summary: { ...report.summary, succeeded: 4 } })).violations,
    ).toEqual(["summary-mismatch"]);
    const noSteps = report.results.map((item, index) => (index === 0 ? { ...item, steps: 0 } : item));
    const noToolCalls = report.results.map((item, index) => (index === 0 ? { ...item, toolCalls: 0 } : item));
    expect(evaluateAcceptance(reportWith({ results: noSteps })).violations).toEqual(["success-without-work"]);
    expect(evaluateAcceptance(reportWith({ results: noToolCalls })).violations).toEqual([
      "success-without-work",
    ]);
  });
});
