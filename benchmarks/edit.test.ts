import { describe, expect, it } from "vitest";
import { main, runEditBenchmark } from "./edit.js";

describe("edit benchmark", () => {
  it("shows fewer argument characters for a patch and lands the same file", async () => {
    const first = await runEditBenchmark();
    const second = await runEditBenchmark();
    expect(second).toEqual(first);
    expect(first.resultIdentical).toBe(true);
    expect(first.charsSaved).toBeGreaterThan(0);
    expect(first.charsSavedPct).toBeGreaterThan(0);
    expect(first.patch.argumentChars).toBeLessThan(first.rewrite.argumentChars);
  });

  it("measures characters and refuses to report tokens or a speed claim", async () => {
    const report = await runEditBenchmark();
    expect(report.tokensMeasured).toBe(false);
    expect(report.usage.status).toBe("unavailable");
    expect(JSON.stringify(report)).not.toMatch(/"(input|output|total)Tokens":\s*\d/);
    expect(JSON.stringify(report)).not.toMatch(/elapsedMs|wallClock/i);
  });

  it("fails the gate when there is nothing to save, instead of calling it a win", async () => {
    const { exitCode, report } = await main({ internal: { scenario: "rewrite-only" } });
    expect(report.charsSaved).toBe(0);
    expect(exitCode).toBe(1);
  });

  it("passes the gate on the canonical scenario", async () => {
    const { exitCode } = await main();
    expect(exitCode).toBe(0);
  });
});
