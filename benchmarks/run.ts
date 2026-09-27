#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import loopReactPlugin from "../plugins/loop-react/src/index.js";
import modelMockPlugin from "../plugins/model-mock/src/index.js";
import toolsBasicPlugin from "../plugins/tools-basic/src/index.js";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { type BenchmarkTask, benchmarkTasks as taskDefinitions } from "./tasks.js";

export type BenchmarkRunnableTask = BenchmarkTask & {
  expectedVerifier?: (root: string) => Promise<boolean>;
};

export interface BenchmarkInternalOptions {
  tasks?: readonly BenchmarkRunnableTask[];
}

export interface BenchmarkRunOptions {
  tasks?: readonly BenchmarkTask[];
  provider?: "mock";
  root?: string;
  internal?: BenchmarkInternalOptions;
}

export interface BenchmarkMainOptions extends BenchmarkRunOptions {
  reportOnly?: boolean;
}

export interface BenchmarkTaskResult {
  id: string;
  success: boolean;
  status: "completed" | "stopped" | "error";
  elapsedMs: number;
  steps: number;
  toolCalls: number;
  tools: string[];
  error?: string;
}

export interface BenchmarkUsage {
  status: "unavailable";
  source: "model-mock";
  method: "provider-does-not-report";
  version: "1";
  inputTokens: null;
  outputTokens: null;
  totalTokens: null;
}

export interface BenchmarkCost {
  amount: 0;
  currency: "USD";
  source: "mock-not-billed";
}

export interface BenchmarkTotals {
  tasks: number;
  succeeded: number;
  failed: number;
  successRate: number;
  elapsedMs: number;
  steps: number;
  toolCalls: number;
  tools: string[];
}

export interface BenchmarkSummary {
  planned: number;
  attempted: number;
  succeeded: number;
  failed: number;
  successRate: number;
}

export interface BenchmarkComponentVersion {
  name: string;
  version: string;
}

export interface BenchmarkReproducibility {
  schemaVersion: "1.0";
  runner: BenchmarkComponentVersion;
  config: { version: "1"; hash: string };
  tasks: { manifestHash: string; verifierHash: string };
  provider: BenchmarkComponentVersion;
  model: BenchmarkComponentVersion;
  tool: BenchmarkComponentVersion;
  agent: BenchmarkComponentVersion;
}

export interface BenchmarkReport {
  schemaVersion: "1.0";
  scope: "benchmark";
  status: "completed" | "error";
  provider: "mock";
  model: "mock";
  elapsedMs: number;
  totals: BenchmarkTotals;
  summary: BenchmarkSummary;
  successRate: number;
  usage: BenchmarkUsage;
  cost: BenchmarkCost;
  results: BenchmarkTaskResult[];
  taskSetHash: string;
  reproducibility: BenchmarkReproducibility;
  reproducibilityHash: string;
  harnessError?: string;
}

const benchmarkConfig = [
  "model:",
  "  provider: mock",
  "  model: mock",
  "agent:",
  "  maxSteps: 4",
  "  maxToolCalls: 2",
  "  timeoutMs: 5000",
  "tools:",
  "  root: workspace",
  "  shell:",
  "    allow: []",
  '    deny: ["*"]',
  "    timeoutMs: 100",
  "permissions:",
  "  fs.read: allow",
  "  fs.write: allow",
  "  shell: deny",
  "  network: deny",
  "",
].join("\n");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function reproducibility(tasks: readonly BenchmarkRunnableTask[]): BenchmarkReproducibility {
  return {
    schemaVersion: "1.0",
    runner: { name: "nexus-benchmark", version: "1" },
    config: { version: "1", hash: sha256(benchmarkConfig) },
    tasks: {
      manifestHash: sha256(JSON.stringify(tasks.map(({ id, prompt }) => ({ id, prompt })))),
      verifierHash: sha256(
        JSON.stringify(
          tasks.map((task) => ({
            expected: task.expected,
            defaultVerifier: expectedFilesMatch.toString(),
            override: task.expectedVerifier?.toString() ?? null,
          })),
        ),
      ),
    },
    provider: {
      name: modelMockPlugin.manifest.name,
      version: modelMockPlugin.manifest.version,
    },
    model: { name: "mock", version: modelMockPlugin.manifest.version },
    tool: { name: toolsBasicPlugin.manifest.name, version: toolsBasicPlugin.manifest.version },
    agent: { name: loopReactPlugin.manifest.name, version: loopReactPlugin.manifest.version },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes("\0") &&
    !value.includes("\\") &&
    !isAbsolute(value) &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}

function assertTaskSet(tasks: readonly BenchmarkRunnableTask[], requireTwenty: boolean): void {
  if (tasks.length === 0) throw new Error("benchmark task set cannot be empty");
  if (requireTwenty && tasks.length !== 20) {
    throw new Error("canonical benchmark task set must contain exactly 20 tasks");
  }
  const ids = new Set<string>();
  for (const task of tasks) {
    if (
      !isRecord(task) ||
      typeof task.id !== "string" ||
      task.id.length === 0 ||
      ids.has(task.id) ||
      typeof task.prompt !== "string" ||
      task.prompt.length === 0 ||
      !isRecord(task.expected) ||
      Object.keys(task.expected).length === 0 ||
      (task.expectedVerifier !== undefined && typeof task.expectedVerifier !== "function")
    ) {
      throw new Error("invalid benchmark task set");
    }
    ids.add(task.id);
    for (const [path, content] of Object.entries(task.expected)) {
      if (!isSafeRelativePath(path) || typeof content !== "string") {
        throw new Error("invalid benchmark task expectation");
      }
    }
  }
}

function selectTasks(options?: BenchmarkRunOptions): {
  tasks: readonly BenchmarkRunnableTask[];
  requireTwenty: boolean;
} {
  if (options === undefined) return { tasks: benchmarkTasks, requireTwenty: true };
  if (options === null || typeof options !== "object") throw new Error("invalid benchmark options");
  if (options.provider !== undefined && options.provider !== "mock") {
    throw new Error("benchmark provider must be mock");
  }
  if (options.internal !== undefined) {
    if (
      options.internal === null ||
      typeof options.internal !== "object" ||
      !Array.isArray(options.internal.tasks)
    ) {
      throw new Error("internal benchmark tasks must be an array");
    }
    if (options.tasks !== undefined) throw new Error("benchmark tasks cannot be set with internal tasks");
    return { tasks: [...options.internal.tasks], requireTwenty: false };
  }
  if (options.tasks === undefined) return { tasks: benchmarkTasks, requireTwenty: true };
  if (!Array.isArray(options.tasks)) throw new Error("benchmark tasks must be an array");
  return { tasks: [...options.tasks], requireTwenty: true };
}

function taskSetHash(tasks: readonly BenchmarkRunnableTask[]): string {
  return sha256(JSON.stringify(tasks));
}

function inside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

async function expectedFilesMatch(root: string, expected: Record<string, string>): Promise<boolean> {
  try {
    for (const [requested, content] of Object.entries(expected)) {
      if (!isSafeRelativePath(requested) || typeof content !== "string") return false;
      const file = resolve(root, requested);
      if (!inside(root, file) || !(await lstat(file)).isFile()) return false;
      if ((await readFile(file, "utf8")) !== content) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export interface BenchmarkTaskWithVerifier extends BenchmarkTask {
  expectedVerifier: (root: string) => Promise<boolean>;
}

type RunnableTask = BenchmarkRunnableTask;

export const benchmarkTasks: readonly BenchmarkTaskWithVerifier[] = taskDefinitions.map((task) => ({
  ...task,
  expectedVerifier: (root: string) => expectedFilesMatch(root, task.expected),
}));

function taskParent(options?: BenchmarkRunOptions): string {
  const root = options?.root;
  if (root === undefined) return tmpdir();
  if (typeof root !== "string" || root.length === 0 || root.trim() !== root || root.includes("\0")) {
    throw new Error("invalid benchmark root");
  }
  return resolve(root);
}

function elapsedMs(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

function result(
  id: string,
  status: BenchmarkTaskResult["status"],
  started: number,
  steps: number,
  toolCalls: number,
  tools: string[],
  error?: string,
): BenchmarkTaskResult {
  const value: BenchmarkTaskResult = {
    id,
    success: status === "completed" && error === undefined,
    status,
    elapsedMs: elapsedMs(started),
    steps,
    toolCalls,
    tools,
  };
  return error === undefined ? value : { ...value, error };
}

interface TaskExecution {
  result: BenchmarkTaskResult;
  harnessError?: string;
}

async function runOneTask(task: RunnableTask, parentRoot: string): Promise<TaskExecution> {
  const started = performance.now();
  let root: string | undefined;
  let runtime: Runtime | undefined;
  let status: BenchmarkTaskResult["status"] = "error";
  let steps = 0;
  let toolCalls = 0;
  let tools: string[] = [];
  let failure: string | undefined;
  let harnessError: string | undefined;
  let phase: "workspace" | "runtime" | "runner" | "verification" = "workspace";

  try {
    root = await mkdtemp(join(parentRoot, ".nexus-benchmark-"));
    await mkdir(join(root, "config"), { recursive: true });
    const toolsRoot = join(root, "workspace");
    await mkdir(toolsRoot, { recursive: true });
    await writeFile(join(root, "config", "default.yaml"), benchmarkConfig, "utf8");

    phase = "runtime";
    runtime = await createRuntime({ root, modelProvider: "mock" });
    tools = runtime.tools
      .list()
      .map((tool) => tool.name)
      .sort();
    phase = "runner";
    const runResult = await runtime.runner.run(task.prompt);
    status = runResult.status;
    steps = runResult.steps;
    toolCalls = runResult.toolCalls;
    if (runResult.status !== "completed") failure = `runner-${runResult.status}`;
    else if (runResult.error !== undefined) failure = "runner-error";
    else {
      phase = "verification";
      const verified =
        task.expectedVerifier === undefined
          ? await expectedFilesMatch(toolsRoot, task.expected)
          : await task.expectedVerifier(toolsRoot);
      if (verified !== true) failure = "expected-files-mismatch";
    }
  } catch {
    const failureCode =
      phase === "verification"
        ? "task-verification-failed"
        : phase === "runner"
          ? "task-execution-failed"
          : phase === "runtime"
            ? "runtime-setup-failed"
            : "workspace-setup-failed";
    failure ??= failureCode;
    harnessError ??= failureCode;
  } finally {
    if (runtime !== undefined) {
      try {
        await runtime.close();
      } catch {
        failure ??= "runtime-close-failed";
        harnessError ??= "runtime-close-failed";
      }
    }
    if (root !== undefined) {
      try {
        await rm(root, { recursive: true, force: true });
      } catch {
        failure ??= "workspace-cleanup-failed";
        harnessError ??= "workspace-cleanup-failed";
      }
    }
  }

  const taskResult = result(task.id, status, started, steps, toolCalls, tools, failure);
  return harnessError === undefined ? { result: taskResult } : { result: taskResult, harnessError };
}

function createReport(
  tasks: readonly BenchmarkRunnableTask[],
  results: BenchmarkTaskResult[],
  started: number,
  harnessError?: string,
): BenchmarkReport {
  const succeeded = results.filter((item) => item.success).length;
  const failed = results.length - succeeded;
  const successRate = results.length === 0 ? 0 : succeeded / results.length;
  const reportElapsedMs = elapsedMs(started);
  const reportTools = [...new Set(results.flatMap((item) => item.tools))].sort();
  const reportReproducibility = reproducibility(tasks);
  return {
    schemaVersion: "1.0",
    scope: "benchmark",
    status: harnessError === undefined ? "completed" : "error",
    provider: "mock",
    model: "mock",
    elapsedMs: reportElapsedMs,
    totals: {
      tasks: results.length,
      succeeded,
      failed,
      successRate,
      elapsedMs: reportElapsedMs,
      steps: results.reduce((sum, item) => sum + item.steps, 0),
      toolCalls: results.reduce((sum, item) => sum + item.toolCalls, 0),
      tools: reportTools,
    },
    summary: {
      planned: tasks.length,
      attempted: results.length,
      succeeded,
      failed,
      successRate,
    },
    successRate,
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
    results,
    taskSetHash: taskSetHash(tasks),
    reproducibility: reportReproducibility,
    reproducibilityHash: sha256(JSON.stringify(reportReproducibility)),
    ...(harnessError === undefined ? {} : { harnessError }),
  };
}

export async function runBenchmark(options?: BenchmarkRunOptions): Promise<BenchmarkReport> {
  const { tasks, requireTwenty } = selectTasks(options);
  assertTaskSet(tasks, requireTwenty);
  const parentRoot = taskParent(options);
  const started = performance.now();
  const results: BenchmarkTaskResult[] = [];
  let harnessError: string | undefined;

  for (const task of tasks) {
    const execution = await runOneTask(task, parentRoot);
    results.push(execution.result);
    harnessError ??= execution.harnessError;
  }

  return createReport(tasks, results, started, harnessError);
}

function benchmarkExitCode(report: BenchmarkReport, reportOnly: boolean): number {
  if (report.status === "error" || report.harnessError !== undefined) return 1;
  if (reportOnly) return 0;
  if (
    report.summary.succeeded < 20 ||
    report.summary.planned !== report.summary.attempted ||
    report.totals.tasks !== report.results.length ||
    report.results.some((item) => !item.success || item.status !== "completed")
  ) {
    return 1;
  }
  return 0;
}

export async function main(options: BenchmarkMainOptions = {}): Promise<number> {
  const started = performance.now();
  try {
    if (options === null || typeof options !== "object") throw new Error("invalid benchmark main options");
    if (options.reportOnly !== undefined && typeof options.reportOnly !== "boolean") {
      throw new Error("reportOnly must be a boolean");
    }
    const report = await runBenchmark(options);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return benchmarkExitCode(report, options.reportOnly === true);
  } catch {
    const report = createReport([], [], started, "benchmark-harness-failed");
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
