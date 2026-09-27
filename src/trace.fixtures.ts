import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTraceWriter,
  TRACE_FILE,
  TRACE_ROTATED,
  TRACE_SCHEMA_VERSION,
  type TraceRecord,
  type TraceWriter,
  traceRecordSchema,
} from "./trace.js";

export interface TraceFixture {
  writer: TraceWriter;
  /** Temp traces root outside the repo `data/` mount, so no test ever sees real user state. */
  root: string;
  /** The temp dir holding `root`, and a sibling escape target, so symlink tests have somewhere to aim. */
  parent: string;
  outside: string;
  file: string;
  rotated: string;
  /** File contents, or `""` when nothing was ever written. */
  bytes(): Promise<string>;
  /** Whole lines only, so a torn tail shows up as a partial line rather than as a short array. */
  lines(): Promise<string[]>;
  records(): Promise<TraceRecord[]>;
}

export async function withTraceWriter(
  run: (fixture: TraceFixture) => Promise<void>,
  options: { enabled?: boolean; maxBytes?: number } = {},
): Promise<void> {
  const parent = await mkdtemp(join(tmpdir(), "nexus-trace-"));
  const root = join(parent, "traces");
  try {
    const writer = createTraceWriter({ enabled: options.enabled ?? true, maxBytes: options.maxBytes, root });
    const file = join(root, TRACE_FILE);
    const bytes = async (): Promise<string> => readFile(file, "utf8").catch(() => "");
    const lines = async (): Promise<string[]> => {
      const text = await bytes();
      return text.length === 0 ? [] : text.split("\n").slice(0, -1);
    };
    await run({
      writer,
      root,
      parent,
      outside: join(parent, "outside"),
      file,
      rotated: join(root, TRACE_ROTATED),
      bytes,
      lines,
      records: async () =>
        (await lines()).map((line, index) => {
          const parsed = traceRecordSchema.safeParse(JSON.parse(line) as unknown);
          if (!parsed.success) {
            throw new Error(`invalid trace record at line ${index + 1}: ${parsed.error.message}`);
          }
          return parsed.data;
        }),
    });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

/** A throwaway HOME, so a writer that defaults its root cannot reach real user state. */
export function stubbedHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "nexus-trace-home-"));
}

/**
 * Filler that is genuinely valid: the rotation case has to cross the cap with records the writer
 * would have accepted, not with random bytes. Written straight to the file because the cap is the
 * only thing under test and a megabyte of ~100-byte records is 10k appends otherwise.
 */
export async function fillTraceFile(file: string, targetBytes: number): Promise<number> {
  const line = (seq: number): string =>
    `${JSON.stringify(
      traceRecordSchema.parse({
        type: "run-step",
        schemaVersion: TRACE_SCHEMA_VERSION,
        ts: new Date(0).toISOString(),
        seq,
        runId: "0123456789abcdef",
        steps: 1,
      }),
    )}\n`;
  const first = Buffer.byteLength(line(1));
  const text = Array.from({ length: Math.ceil(targetBytes / first) }, (_unused, index) =>
    line(index + 1),
  ).join("");
  await writeFile(file, text, { mode: 0o600 });
  return Buffer.byteLength(text);
}
