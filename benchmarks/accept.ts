#!/usr/bin/env node

/**
 * Task 2.6 acceptance harness.
 *
 * Runs the same canonical 20 mock tasks as `bench:20` through the whole product path —
 * config -> plugin discovery -> react loop -> tool call -> written artifact -> verifier — and
 * applies the acceptance gate: at least `MIN_SUCCEEDED` tasks complete end to end, all 20 are
 * planned and attempted, no harness error is reported, and every success is backed by real work
 * (`steps > 0` and `toolCalls > 0`).
 *
 * The gate counts `success`, which the canonical runner only sets when the runner completed *and*
 * the artifact verifier matched the expected files. A `status: "completed"` result whose artifact
 * is wrong therefore never counts, so status alone can never satisfy this gate. `run.ts` and its
 * report, `taskSetHash`, and `reproducibilityHash` stay the single source of truth; this file only
 * runs the canonical task set and judges its report.
 *
 * Mock only. `runBenchmark` pins the mock provider, writes its own benchmark config into a fresh
 * temp root per task, and removes that root afterwards, so no live provider, user config, API key,
 * or network access is involved.
 *
 * Report: exactly one `AcceptanceReport` JSON line on stdout, the same one-line contract as
 * `run.ts`. Violations are fixed codes, so the line carries no prompt, path, secret, or task output.
 *
 * Exit: 0 when `status` is `accepted`; 1 when any violation is reported, and also when the harness
 * itself fails — a failure is reported as a rejected report with `harness-error`, never as a pass.
 * There is no report-only mode: a rejection is a failure, and no option can turn one into a pass.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type BenchmarkReport, runBenchmark } from "./run.js";

/** Task 2.6: at least 5 of the canonical 20 tasks must complete end to end. */
export const MIN_SUCCEEDED = 5;

/** The canonical set is fixed at 20; a shorter run is not an acceptance run. */
const CANONICAL_TASKS = 20;

export const ACCEPTANCE_VIOLATIONS = [
  "harness-error",
  "report-error",
  "provider-not-mock",
  "planned-not-canonical",
  "attempt-mismatch",
  "summary-mismatch",
  "below-minimum-succeeded",
  "success-without-work",
] as const;

export type AcceptanceViolation = (typeof ACCEPTANCE_VIOLATIONS)[number];

export interface AcceptanceReport {
  schemaVersion: "1.0";
  scope: "acceptance";
  status: "accepted" | "rejected";
  minSucceeded: number;
  provider: "mock";
  summary: { planned: number; attempted: number; succeeded: number; failed: number };
  /** Per-phase evidence of the canonical run. Reported for diagnosis, never a substitute for the gate. */
  phases: {
    config: { provider: string; model: string; configHash: string };
    discovery: { tools: string[]; tasksWithTools: number };
    loop: { steps: number; tasksWithSteps: number };
    tool: { toolCalls: number; tasksWithToolCalls: number };
    verifier: { verified: number; rejected: number };
  };
  taskSetHash: string;
  reproducibilityHash: string;
  violations: AcceptanceViolation[];
}

export interface AcceptanceOptions {
  /** Parent for the per-task temp roots; the default is the OS temp dir, as in `run.ts`. */
  root?: string;
}

const NO_PHASES: AcceptanceReport["phases"] = {
  config: { provider: "mock", model: "mock", configHash: "" },
  discovery: { tools: [], tasksWithTools: 0 },
  loop: { steps: 0, tasksWithSteps: 0 },
  tool: { toolCalls: 0, tasksWithToolCalls: 0 },
  verifier: { verified: 0, rejected: 0 },
};

export function evaluateAcceptance(report: BenchmarkReport): AcceptanceReport {
  const successes = report.results.filter((item) => item.success);
  const violations: AcceptanceViolation[] = [];

  if (report.harnessError !== undefined) violations.push("harness-error");
  if (report.status !== "completed") violations.push("report-error");
  if (report.provider !== "mock" || report.model !== "mock") violations.push("provider-not-mock");
  if (report.summary.planned !== CANONICAL_TASKS) violations.push("planned-not-canonical");
  if (
    report.summary.attempted !== report.summary.planned ||
    report.totals.tasks !== report.results.length ||
    report.results.length !== report.summary.attempted
  ) {
    violations.push("attempt-mismatch");
  }
  if (report.summary.succeeded !== successes.length) violations.push("summary-mismatch");
  if (successes.length < MIN_SUCCEEDED) violations.push("below-minimum-succeeded");
  if (successes.some((item) => item.steps <= 0 || item.toolCalls <= 0)) {
    violations.push("success-without-work");
  }

  return {
    schemaVersion: "1.0",
    scope: "acceptance",
    status: violations.length === 0 ? "accepted" : "rejected",
    minSucceeded: MIN_SUCCEEDED,
    provider: "mock",
    summary: {
      planned: report.summary.planned,
      attempted: report.summary.attempted,
      succeeded: successes.length,
      failed: report.results.length - successes.length,
    },
    phases: {
      config: {
        provider: report.provider,
        model: report.model,
        configHash: report.reproducibility.config.hash,
      },
      discovery: {
        tools: report.totals.tools,
        tasksWithTools: report.results.filter((item) => item.tools.length > 0).length,
      },
      loop: {
        steps: report.totals.steps,
        tasksWithSteps: report.results.filter((item) => item.steps > 0).length,
      },
      tool: {
        toolCalls: report.totals.toolCalls,
        tasksWithToolCalls: report.results.filter((item) => item.toolCalls > 0).length,
      },
      verifier: { verified: successes.length, rejected: report.results.length - successes.length },
    },
    taskSetHash: report.taskSetHash,
    reproducibilityHash: report.reproducibilityHash,
    violations,
  };
}

function harnessFailure(): AcceptanceReport {
  return {
    schemaVersion: "1.0",
    scope: "acceptance",
    status: "rejected",
    minSucceeded: MIN_SUCCEEDED,
    provider: "mock",
    summary: { planned: 0, attempted: 0, succeeded: 0, failed: 0 },
    phases: NO_PHASES,
    taskSetHash: "",
    reproducibilityHash: "",
    violations: ["harness-error"],
  };
}

export async function main(options: AcceptanceOptions = {}): Promise<number> {
  if (options === null || typeof options !== "object")
    return Promise.reject(new Error("invalid acceptance options"));
  try {
    const report = await runBenchmark({
      provider: "mock",
      ...(options.root === undefined ? {} : { root: options.root }),
    });
    const acceptance = evaluateAcceptance(report);
    process.stdout.write(`${JSON.stringify(acceptance)}\n`);
    return acceptance.status === "accepted" ? 0 : 1;
  } catch {
    process.stdout.write(`${JSON.stringify(harnessFailure())}\n`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
