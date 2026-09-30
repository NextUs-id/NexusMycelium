import { describe, expect, it } from "vitest";
import { main, runCompactionBenchmark } from "./compaction.js";

describe("compaction benchmark", () => {
  it("reports the characters compaction saved and keeps the same numbers on a second run", async () => {
    const first = await runCompactionBenchmark();
    const second = await runCompactionBenchmark();
    expect(second).toEqual(first);
    expect(first.charsSaved).toBeGreaterThan(0);
    expect(first.charsSavedPct).toBeGreaterThan(0);
    expect(first.compacted.compactedTurns).toBeGreaterThan(0);
    expect(first.baseline.compactedTurns).toBe(0);
  });

  it("keeps every seeded instruction and answer while dropping tool output", async () => {
    const report = await runCompactionBenchmark();
    expect(report.retained.allRetained).toBe(true);
    expect(report.retained.instructions).toHaveLength(2);
    expect(report.retained.answers).toHaveLength(2);
    expect(report.compacted.orphanToolResults).toBe(0);
    expect(report.compacted.promptChars).toBeLessThan(report.baseline.promptChars);
  });

  it("measures characters and refuses to report tokens", async () => {
    const report = await runCompactionBenchmark();
    expect(report.tokensMeasured).toBe(false);
    expect(report.usage.status).toBe("unavailable");
    expect(report.usage.inputTokens).toBeNull();
    expect(JSON.stringify(report)).not.toMatch(/"(input|output|total)Tokens":\s*\d/);
  });

  it("fails the gate when nothing was saved, instead of reporting a success anyway", async () => {
    // A cap no run reaches: compaction never fires, so there is no saving to claim.
    const { exitCode, report } = await main({ internal: { capChars: 100_000_000 } });
    expect(report.charsSaved).toBe(0);
    expect(report.compacted.compactedTurns).toBe(0);
    expect(exitCode).toBe(1);
  });

  it("passes the gate on the canonical cap", async () => {
    const { exitCode } = await main();
    expect(exitCode).toBe(0);
  });
});
