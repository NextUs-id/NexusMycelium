import type { ModelMessage, ModelProvider, ModelResult } from "../kernel/src/model.js";
import { ToolRegistry } from "../kernel/src/tools.js";
import { createAgentRunner } from "../plugins/loop-react/src/index.js";

/**
 * Compaction measurement, Task 4.2d.
 *
 * The canonical 20-task benchmark never trips the compactor, so it cannot say anything about
 * compaction. This harness does the opposite: it fixes one transcript shape, runs it twice — once
 * with a cap no run can reach and once with a cap that bites — and reports the characters that were
 * actually handed to the provider, plus whether the instructions and answers survived.
 *
 * What it does **not** report: tokens. The provider here is an offline stub that reports no usage,
 * so a token number would be a guess wearing a measurement's clothes. The report says
 * `tokensMeasured: false` and carries `usage.status: "unavailable"`, exactly like `bench:20`.
 */

const TOOL_RESULT_CHARS = 4_000;
const TOOL_TURNS = 8;
const CAP_CHARS = 4_000;
/** A cap no run reaches, which is how the baseline run is expressed without a second code path. */
const UNREACHABLE_CAP = 100_000_000;

const INSTRUCTIONS = ["seeded instruction one", "seeded follow-up two"] as const;
const ANSWERS = ["seeded answer one", "seeded answer two"] as const;
const SUMMARY = "compacted transcript: ";

export interface CompactionReport {
  schemaVersion: "1.0";
  scope: "compaction";
  status: "completed";
  provider: "offline-stub";
  model: "stub";
  scenario: { toolTurns: number; toolResultChars: number; capChars: number; seededMessages: number };
  baseline: { promptChars: number; compactedTurns: number };
  compacted: { promptChars: number; compactedTurns: number; orphanToolResults: number };
  charsSaved: number;
  charsSavedPct: number;
  retained: { instructions: string[]; answers: string[]; allRetained: boolean };
  usage: {
    status: "unavailable";
    source: "offline-stub";
    method: "provider-does-not-report";
    version: "1";
    inputTokens: null;
    outputTokens: null;
    totalTokens: null;
  };
  cost: { amount: 0; currency: "USD"; source: "mock-not-billed" };
  tokensMeasured: false;
  tokensNote: string;
}

function bigTool(): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register({
    name: "read_forever",
    description: "returns a fixed block of text",
    inputSchema: { type: "object" },
    execute: async () => "x".repeat(TOOL_RESULT_CHARS),
  });
  return tools;
}

/** A tool result the transcript still carries without the call it answers. */
function orphanToolResults(messages: readonly ModelMessage[]): number {
  const calls = new Set(messages.flatMap((message) => (message.toolCalls ?? []).map((call) => call.id)));
  return messages.filter((message) => message.role === "tool" && !calls.has(message.toolCallId ?? "")).length;
}

function seededHistory(): ModelMessage[] {
  const messages: ModelMessage[] = [{ role: "system", content: "You are a bounded agent." }];
  INSTRUCTIONS.forEach((instruction, index) => {
    messages.push({ role: "user", content: instruction });
    messages.push({
      role: "assistant",
      content: "",
      toolCalls: [{ id: `seed-${index}`, name: "read_forever", arguments: {} }],
    });
    messages.push({
      role: "tool",
      content: `{"ok":true,"output":"${"s".repeat(TOOL_RESULT_CHARS)}"}`,
      toolCallId: `seed-${index}`,
    });
    messages.push({ role: "assistant", content: ANSWERS[index] ?? "" });
  });
  return messages;
}

interface Measured {
  promptChars: number;
  compactedTurns: number;
  orphanToolResults: number;
  contents: string[];
}

/** The stub calls one tool per turn, always, then answers. Deterministic, offline, no usage. */
async function measure(capChars: number): Promise<Measured> {
  let turn = 0;
  let promptChars = 0;
  let compactedTurns = 0;
  const contents: string[] = [];
  let lastTranscript: ModelMessage[] = [];
  const model: ModelProvider = {
    async complete(messages): Promise<ModelResult> {
      promptChars += messages.reduce((sum, message) => sum + message.content.length, 0);
      lastTranscript = [...messages];
      if (messages.some((message) => message.content.startsWith(SUMMARY))) compactedTurns += 1;
      if (turn >= TOOL_TURNS) return { type: "final", text: "measured final answer" };
      const call = { id: `stub-${turn}`, name: "read_forever", arguments: {} };
      turn += 1;
      return { type: "tool_calls", calls: [call] };
    },
  };
  await createAgentRunner({
    model,
    tools: bigTool(),
    limits: { maxSteps: TOOL_TURNS + 2, maxToolCalls: TOOL_TURNS + 2, timeoutMs: 20_000 },
    compaction: { maxChars: capChars, keepMessages: 4 },
  }).run("measure this transcript", { history: seededHistory() });
  contents.push(...lastTranscript.map((message) => message.content));
  return { promptChars, compactedTurns, orphanToolResults: orphanToolResults(lastTranscript), contents };
}

export function runCompactionBenchmark(capChars: number = CAP_CHARS): Promise<CompactionReport> {
  return build(capChars);
}

async function build(capChars: number): Promise<CompactionReport> {
  const baseline = await measure(UNREACHABLE_CAP);
  const compacted = await measure(capChars);
  const instructions = INSTRUCTIONS.filter((value) => compacted.contents.includes(value));
  const answers = ANSWERS.filter((value) => compacted.contents.includes(value));
  const charsSaved = baseline.promptChars - compacted.promptChars;
  return {
    schemaVersion: "1.0",
    scope: "compaction",
    status: "completed",
    provider: "offline-stub",
    model: "stub",
    scenario: {
      toolTurns: TOOL_TURNS,
      toolResultChars: TOOL_RESULT_CHARS,
      capChars,
      seededMessages: seededHistory().length,
    },
    baseline: { promptChars: baseline.promptChars, compactedTurns: baseline.compactedTurns },
    compacted: {
      promptChars: compacted.promptChars,
      compactedTurns: compacted.compactedTurns,
      orphanToolResults: compacted.orphanToolResults,
    },
    charsSaved,
    charsSavedPct:
      baseline.promptChars === 0 ? 0 : Math.round((charsSaved / baseline.promptChars) * 10_000) / 100,
    retained: {
      instructions: [...instructions],
      answers: [...answers],
      allRetained: instructions.length === INSTRUCTIONS.length && answers.length === ANSWERS.length,
    },
    usage: {
      status: "unavailable",
      source: "offline-stub",
      method: "provider-does-not-report",
      version: "1",
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    },
    cost: { amount: 0, currency: "USD", source: "mock-not-billed" },
    tokensMeasured: false,
    tokensNote:
      "characters handed to the provider, not tokens: the offline stub reports no usage, so any token count here would be a guess",
  };
}

export interface MainOptions {
  /** Test-only override of the measured cap. The CLI never passes it. */
  internal?: { capChars?: number };
}

export interface MainResult {
  exitCode: number;
  report: CompactionReport;
}

export async function main(options: MainOptions = {}): Promise<MainResult> {
  const report = await runCompactionBenchmark(options.internal?.capChars ?? CAP_CHARS);
  return { exitCode: gate(report) ? 0 : 1, report };
}

/** The gate is about behaviour, not about a status field: savings, retention, and no orphan. */
function gate(report: CompactionReport): boolean {
  return report.charsSaved > 0 && report.retained.allRetained && report.compacted.orphanToolResults === 0;
}

const isCli = process.argv[1]?.endsWith("compaction.js") === true;
if (isCli) {
  const { exitCode, report } = await main();
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = exitCode;
}
