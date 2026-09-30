import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionGate } from "../kernel/src/permissions.js";
import { createBasicTools } from "../plugins/tools-basic/src/index.js";

/**
 * Edit measurement, Task 4.4.
 *
 * The same change, two ways: rewrite the whole file with `write_text`, or send a patch with
 * `edit_text`. What this reports is the characters of tool arguments the model has to hand over for
 * each strategy, and whether both strategies end with the very same file.
 *
 * What it does **not** report: tokens or wall-clock savings. The provider here is offline and reports
 * no usage, and this harness runs the tools directly, so a token count or a speed claim would be a
 * guess wearing a measurement's clothes. `tokensMeasured` is `false` and `usage.status` is
 * `unavailable`, exactly like `bench:20` and `bench:compaction`.
 */

/** A file big enough that rewriting it is expensive and patching it is not. */
const ORIGINAL = Array.from({ length: 40 }, (_unused, index) => `line ${index}: value ${index * 7}`).join(
  "\n",
);
const BEFORE = "line 3: value 21";
const AFTER = "line 3: value 21 (patched)";
const SECOND_BEFORE = "line 30: value 210";
const SECOND_AFTER = "line 30: value 210 (patched too)";

export interface EditReport {
  schemaVersion: "1.0";
  scope: "edit";
  status: "completed";
  provider: "offline-direct";
  scenario: { fileChars: number; edits: number };
  rewrite: { argumentChars: number };
  patch: { argumentChars: number };
  charsSaved: number;
  charsSavedPct: number;
  resultIdentical: boolean;
  usage: {
    status: "unavailable";
    source: "offline-direct";
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

const rewritten = ORIGINAL.replace(BEFORE, AFTER).replace(SECOND_BEFORE, SECOND_AFTER);

function argChars(value: unknown): number {
  return JSON.stringify(value).length;
}

export function runEditBenchmark(): Promise<EditReport> {
  return build();
}

async function build(): Promise<EditReport> {
  const root = await mkdtemp(join(tmpdir(), "nexus-edit-bench-"));
  try {
    const tools = createBasicTools({
      root,
      permissions: new PermissionGate({ "fs.read": "allow", "fs.write": "allow", shell: "deny" }),
    });
    const edits = [
      { oldText: BEFORE, newText: AFTER },
      { oldText: SECOND_BEFORE, newText: SECOND_AFTER },
    ];

    await writeFile(join(root, "target.txt"), ORIGINAL, "utf8");
    const rewriteArgs = { path: "target.txt", content: rewritten };
    await tools.get("write_text").execute(rewriteArgs);
    const rewriteResult = await readFile(join(root, "target.txt"), "utf8");

    await writeFile(join(root, "target.txt"), ORIGINAL, "utf8");
    const patchArgs = { path: "target.txt", edits };
    await tools.get("edit_text").execute(patchArgs);
    const patchResult = await readFile(join(root, "target.txt"), "utf8");

    const rewriteChars = argChars(rewriteArgs);
    const patchChars = argChars(patchArgs);
    const charsSaved = rewriteChars - patchChars;
    return {
      schemaVersion: "1.0",
      scope: "edit",
      status: "completed",
      provider: "offline-direct",
      scenario: { fileChars: ORIGINAL.length, edits: edits.length },
      rewrite: { argumentChars: rewriteChars },
      patch: { argumentChars: patchChars },
      charsSaved,
      charsSavedPct: Math.round((charsSaved / rewriteChars) * 10_000) / 100,
      resultIdentical: rewriteResult === patchResult,
      usage: {
        status: "unavailable",
        source: "offline-direct",
        method: "provider-does-not-report",
        version: "1",
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
      },
      cost: { amount: 0, currency: "USD", source: "mock-not-billed" },
      tokensMeasured: false,
      tokensNote:
        "characters of tool arguments, not tokens: nothing here runs a provider, so a token or wall-clock saving would be a guess",
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export interface MainOptions {
  /** Test-only override of the measured strategy. The CLI never passes it. */
  internal?: { scenario?: "patch" | "rewrite-only" };
}

export interface MainResult {
  exitCode: number;
  report: EditReport;
}

export async function main(options: MainOptions = {}): Promise<MainResult> {
  const report = await runEditBenchmark();
  if (options.internal?.scenario === "rewrite-only") {
    // A scenario with nothing to save must not be able to pass as a win, and its numbers are
    // recomputed rather than reused: a report that still claims a saving would be a lie in JSON.
    const same = { ...report, patch: { argumentChars: report.rewrite.argumentChars } };
    const flat = { ...same, charsSaved: 0, charsSavedPct: 0 };
    return { exitCode: 1, report: flat };
  }
  const rejected =
    report.charsSaved <= 0 || report.resultIdentical === false || report.tokensMeasured !== false;
  return { exitCode: rejected ? 1 : 0, report };
}

const isCli = process.argv[1]?.endsWith("edit.js") === true;
if (isCli) {
  const { exitCode, report } = await main();
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = exitCode;
}
