import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ModelPrice } from "../kernel/src/model.js";
import { TRACE_FILE, TRACE_SCHEMA_VERSION, traceRecordSchema } from "./trace.js";

/**
 * Cost and token report, Task 4.6.
 *
 * It reads the trace log 3.4 already writes and nothing else: there is no second ledger, because
 * there is nowhere else in this system that knows what a run spent. `run-start` carries the provider
 * and model, `run-end` carries the status, the step and tool-call counts, and the three token counts
 * when the provider reported them — so a per-task table is a read of records that already exist.
 *
 * Two things it refuses to do: turn a missing usage into a zero, and price a run it has no price
 * for. A run that reported no usage is counted as `unavailable`; a model with no entry in
 * `budget.prices` is counted as `unpriced`. Both are reported as themselves, never as `0`.
 */

/** Where the writer puts the log. The same default, so a report and its writer agree. */
export function defaultTracePath(): string {
  return join(homedir(), ".config", "nexus", "user", "traces", TRACE_FILE);
}

export interface ReportRow {
  index: number;
  status: string;
  provider: string;
  model: string;
  steps: number;
  toolCalls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  /** Micro-USD, an integer so no float can round a cost up or down. `null` when there is no price. */
  costMicroUsd: number | null;
  budgetReason?: string;
}

export interface CostReport {
  source: string;
  rows: ReportRow[];
  totals: {
    runs: number;
    runsWithUsage: number;
    runsWithoutUsage: number;
    runsPriced: number;
    runsUnpriced: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costMicroUsd: number;
  };
  /** Records the schema refused, counted rather than guessed at. */
  refusedRecords: number;
  runEndsWithoutStart: number;
}

export type ReportResult =
  | { ok: true; report: CostReport }
  | { ok: false; reason: "no-trace" | "no-runs"; message: string };

/** Integer micro-USD, the same arithmetic the budget guard charges with. */
export function microUsd(usage: { inputTokens: number; outputTokens: number }, price: ModelPrice): number {
  return (
    usage.inputTokens * price.inputUsdPerMillionTokens + usage.outputTokens * price.outputUsdPerMillionTokens
  );
}

export async function readCostReport(options: {
  path?: string;
  prices: Readonly<Record<string, ModelPrice>>;
}): Promise<ReportResult> {
  const path = resolve(options.path ?? defaultTracePath());
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return {
      ok: false,
      reason: "no-trace",
      message: "no trace log to report on; enable it with `trace:\n  enabled: true` and run a task first",
    };
  }
  const rows: ReportRow[] = [];
  let refusedRecords = 0;
  let runEndsWithoutStart = 0;
  // `runId` belongs to the writer, not to a run, so the pairing is positional: each `run-end` takes
  // the most recent `run-start` above it. An `run-end` with none is counted, never paired to nothing.
  let start: { provider: string; model: string } | undefined;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      refusedRecords += 1;
      continue;
    }
    const parsed = traceRecordSchema.safeParse(value);
    if (!parsed.success) {
      refusedRecords += 1;
      continue;
    }
    const record = parsed.data;
    if (record.schemaVersion !== TRACE_SCHEMA_VERSION) {
      refusedRecords += 1;
      continue;
    }
    if (record.type === "run-start") {
      start = { provider: record.provider, model: record.model };
      continue;
    }
    if (record.type !== "run-end") continue;
    if (start === undefined) runEndsWithoutStart += 1;
    const model = start?.model ?? "";
    const price = Object.hasOwn(options.prices, model) ? options.prices[model] : undefined;
    const usage = record.usage;
    rows.push({
      index: rows.length + 1,
      status: record.status,
      provider: start?.provider ?? "unknown",
      model: model === "" ? "unknown" : model,
      steps: record.steps,
      toolCalls: record.toolCalls,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      totalTokens: usage?.totalTokens ?? null,
      costMicroUsd: usage === undefined || price === undefined ? null : microUsd(usage, price),
      ...(record.budgetReason === undefined ? {} : { budgetReason: record.budgetReason }),
    });
  }
  if (rows.length === 0) {
    return { ok: false, reason: "no-runs", message: `the trace log holds no finished run: ${path}` };
  }
  return {
    ok: true,
    report: {
      source: path,
      rows,
      totals: totalize(rows),
      refusedRecords,
      runEndsWithoutStart,
    },
  };
}

function totalize(rows: readonly ReportRow[]): CostReport["totals"] {
  let runsWithUsage = 0;
  let runsPriced = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let costMicroUsd = 0;
  for (const row of rows) {
    if (row.totalTokens !== null) {
      runsWithUsage += 1;
      inputTokens += row.inputTokens ?? 0;
      outputTokens += row.outputTokens ?? 0;
      totalTokens += row.totalTokens;
    }
    if (row.costMicroUsd !== null) {
      runsPriced += 1;
      costMicroUsd += row.costMicroUsd;
    }
  }
  return {
    runs: rows.length,
    runsWithUsage,
    runsWithoutUsage: rows.length - runsWithUsage,
    runsPriced,
    runsUnpriced: rows.length - runsPriced,
    inputTokens,
    outputTokens,
    totalTokens,
    costMicroUsd,
  };
}

const unavailable = "unavailable";
const unpriced = "unpriced";

/** Plain text, no dependency: a table, the totals, and the two counts that are not measurements. */
export function renderReport(report: CostReport): string {
  const header = [
    "#",
    "status",
    "provider",
    "model",
    "steps",
    "tools",
    "input",
    "output",
    "total",
    "cost usd",
    "note",
  ];
  const body = report.rows.map((row) => [
    String(row.index),
    row.status,
    row.provider,
    row.model,
    String(row.steps),
    String(row.toolCalls),
    row.inputTokens === null ? unavailable : String(row.inputTokens),
    row.outputTokens === null ? unavailable : String(row.outputTokens),
    row.totalTokens === null ? unavailable : String(row.totalTokens),
    row.costMicroUsd === null ? unpriced : (row.costMicroUsd / 1_000_000).toFixed(6),
    row.budgetReason ?? "",
  ]);
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...body.map((line) => line[column]?.length ?? 0)),
  );
  const line = (cells: string[]): string =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? cell.length))
      .join("  ")
      .trimEnd();
  const totals = report.totals;
  const lines = [
    `cost and token report — ${report.source}`,
    "",
    line(header),
    line(widths.map((width) => "-".repeat(width))),
    ...body.map(line),
    "",
    `runs ${totals.runs} · usage reported ${totals.runsWithUsage} · usage ${unavailable} ${totals.runsWithoutUsage}`,
    `tokens in ${totals.inputTokens} · out ${totals.outputTokens} · total ${totals.totalTokens}`,
    `cost $${(totals.costMicroUsd / 1_000_000).toFixed(6)} across ${totals.runsPriced} priced run(s); ${totals.runsUnpriced} ${unpriced}`,
  ];
  if (totals.runsWithoutUsage > 0) {
    lines.push(
      "a run marked `unavailable` reported no usage: its tokens are unknown, not zero, and it is left out of the totals above",
    );
  }
  if (totals.runsUnpriced > 0) {
    lines.push(
      "a run marked `unpriced` has no entry in budget.prices for its model: its cost is unknown, not free",
    );
  }
  if (report.refusedRecords > 0 || report.runEndsWithoutStart > 0) {
    lines.push(
      `${report.refusedRecords} record(s) refused by the schema and ${report.runEndsWithoutStart} run-end without a run-start were counted, not repaired`,
    );
  }
  lines.push("cache reads are not in the trace schema, so no cached-token column exists to report");
  return lines.join("\n");
}
