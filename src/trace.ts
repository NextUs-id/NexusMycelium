import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { chmod, lstat, mkdir, open, readlink, realpath, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { AgentResult, BudgetStopReason } from "../kernel/src/agent.js";
import { BUDGET_STOP_REASONS } from "../kernel/src/agent.js";
import { DEFAULT_TRACE_MAX_BYTES, MAX_TRACE_MAX_BYTES } from "../kernel/src/config.js";

/** Bump only with a migration: a record carrying another version is refused, never guessed. */
export const TRACE_SCHEMA_VERSION = 1;
export const TRACE_FILE = "trace.jsonl";
/** One generation only: the next rotation overwrites this file rather than stacking a second copy. */
export const TRACE_ROTATED = `${TRACE_FILE}.1`;

/**
 * A backstop, not a reachable ceiling: scalars are capped at 128 characters and a record is a closed
 * union of about a dozen of them, so the schema rejects anything this bound would catch. It stays
 * because raising a scalar cap is a one-line change and a multi-kilobyte single line is not a log.
 */
const MAX_RECORD_BYTES = 8 * 1024;
/** Newlines and friends are stripped, so a record never spans lines; this only bounds the strip's read. */
const MAX_TAIL_WINDOW = 64 * 1024;
const MAX_SCALAR_CHARS = 128;

/** Unicode Cc: C0, DEL, and C1. Written as a property escape so the pattern itself holds no control byte. */
const controlChars = /\p{Cc}/gu;
/** A scalar is a label, not a location: leading `/`, `~/`, `../`, or a drive letter is a path. */
const absoluteLocation = /^(?:\/|~\/|\.\.\/|[A-Za-z]:[\\/])/;
/**
 * Credential shapes, rejected whatever key they arrived under. `sk-…` and `Bearer …` are the two
 * providers really use; the rest is a key=value assignment smuggled into an innocent-looking label.
 */
const secretShape =
  /\bsk-[A-Za-z0-9_-]{6,}|\bBearer\s|-----BEGIN|\b(?:api[_-]?key|secret|token|password|passwd|credential|authorization|cookie)\b\s*[:=]/i;

export type TraceStatus = AgentResult["status"];
export type TraceBudgetReason = BudgetStopReason;

export interface TraceUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** What a caller hands over. The writer adds `ts`, `seq`, and `runId` and nothing else can be added. */
export type TraceInput =
  | { type: "run-start"; provider: string; model: string }
  | { type: "run-step"; steps: number }
  | {
      type: "run-end";
      status: TraceStatus;
      steps: number;
      toolCalls: number;
      budgetReason?: TraceBudgetReason;
      usage?: TraceUsage;
    }
  // The host knows which plugin came up and which one the required set never needed. A load error, a
  // manifest path, and a version are all deliberately absent: the name and the boolean are all that
  // survive into the schema, so a plugin lifecycle is traceable without becoming a place to hide one.
  | { type: "plugin-load"; name: string; required: boolean }
  | { type: "plugin-load-failed"; name: string; required: boolean };

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/**
 * The redaction boundary, stated as a value rule: control characters go, because a newline inside a
 * JSONL value is a framing hazard, and a secret or a filesystem location is refused outright. A
 * refused scalar loses the record rather than reaching disk in redacted form — a trace nobody can
 * read is useless, a trace that leaks is worse than no trace.
 */
const scalar = z
  .string()
  .min(1)
  .max(MAX_SCALAR_CHARS)
  .transform((value) => value.replace(controlChars, ""))
  .refine((value) => value.length > 0, "empty once control characters were stripped")
  .refine((value) => !absoluteLocation.test(value), "looks like a filesystem location")
  .refine((value) => !secretShape.test(value), "looks like a secret");

const runIdSchema = z.string().regex(/^[0-9a-f]{16}$/);
const tsSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

/** The four fields the writer owns, identical for every variant, so a variant states only its own. */
const envelope = {
  schemaVersion: z.literal(TRACE_SCHEMA_VERSION),
  ts: tsSchema,
  seq: count,
  runId: runIdSchema,
};

/** One closed record shape: the writer's own fields plus a variant's, and nothing else. */
const variant = <L extends string, Shape extends z.ZodRawShape>(type: L, shape: Shape) =>
  z.object({ type: z.literal(type), ...envelope, ...shape }).strict();

/** Every record is a closed shape: `task`, `text`, `observations`, `arguments`, `config`, `env`, `headers`,
 * and any other unknown key are refused by the strict object, so they cannot be persisted at all. */
const runStartSchema = variant("run-start", { provider: scalar, model: scalar });

const runStepSchema = variant("run-step", { steps: count });

const runEndSchema = variant("run-end", {
  status: z.enum(["completed", "stopped", "error"]),
  steps: count,
  toolCalls: count,
  budgetReason: z.enum(BUDGET_STOP_REASONS).optional(),
  usage: z.object({ inputTokens: count, outputTokens: count, totalTokens: count }).strict().optional(),
});

/** A plugin outcome is a name and a boolean, nothing else: no path, no version, no error text. */
const pluginFields = {
  // The same canonical kebab-case rule `kernel/src/manifest.ts` enforces. A plugin name is an
  // identifier, so this refuses a load error, a directory, and a credential smuggled into `name`
  // rather than storing a 30-character "label" that happens to be a message.
  name: scalar.refine((value) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value), "not a canonical plugin name"),
  required: z.boolean(),
};
const pluginLoadSchema = variant("plugin-load", pluginFields);
const pluginLoadFailedSchema = variant("plugin-load-failed", pluginFields);

export const traceRecordSchema = z.discriminatedUnion("type", [
  runStartSchema,
  runStepSchema,
  runEndSchema,
  pluginLoadSchema,
  pluginLoadFailedSchema,
]);

export type TraceRecord = z.infer<typeof traceRecordSchema>;

export interface TraceWriterOptions {
  /** Off unless asked for. A disabled writer resolves its root string and never touches the disk. */
  enabled?: boolean;
  /** Defaults to `${HOME}/.config/nexus/user/traces`, beside the session store and outside the repo. */
  root?: string;
  /**
   * The byte cap a generation rotates at, from `config.trace.maxBytes`. Defaults to the same 1 MiB
   * the config block defaults to, and is refused outside `[1, ${MAX_TRACE_MAX_BYTES}]` so an enabled
   * trace can never grow without bound no matter who calls the writer.
   */
  maxBytes?: number;
}

export interface TraceStats {
  enabled: boolean;
  written: number;
  /** Appends that were refused, oversized, or could not be written. Never a throw into the run. */
  failures: number;
  rotations: number;
}

export interface TraceWriter {
  readonly enabled: boolean;
  /** Absolute traces root. Nothing exists there until the first successful append. */
  readonly root: string;
  append(input: TraceInput): Promise<boolean>;
  stats(): TraceStats;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

/** The link a path is, or `undefined` when it is not a symlink at all. */
async function readLink(path: string): Promise<string | undefined> {
  try {
    return await readlink(path);
  } catch (error) {
    if (hasCode(error, "EINVAL") || hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

/**
 * The real traces root, created and tightened on the first append. The parent is canonicalized and a
 * symlinked root is followed to its own target first, because `mkdir` refuses a link with no target
 * yet; `mkdir` also leaves an existing directory's mode alone, so a loosened one is re-tightened.
 */
async function ensureRoot(root: string): Promise<string> {
  const target = resolve(root);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const parent = await realpath(dirname(target));
  const name = basename(target);
  const link = await readLink(join(parent, name));
  const canonical = link === undefined ? join(parent, name) : resolve(parent, link);
  await mkdir(canonical, { recursive: true, mode: 0o700 });
  await chmod(canonical, 0o700);
  return canonical;
}

/**
 * Fail closed on whatever already sits at the trace path: a symlink, a directory, another user's
 * file, or a file any other user can read. A widened mode means whatever was already written is
 * already readable, which tightening afterwards cannot undo, so the writer stops instead of
 * pretending the trace is private.
 */
function refuseExisting(stats: Stats): string | undefined {
  if (!stats.isFile()) return "trace path is not a regular file";
  if ((stats.mode & 0o777) !== 0o600) return "trace file mode must be 0600";
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) return "trace file belongs to another user";
  return undefined;
}

/**
 * A crash mid-write can leave a line without its newline, and appending after that would splice the
 * next record onto the fragment. So the fragment goes first: at most one partial record is lost,
 * never a whole one. The window is wider than a record, so the last newline is always inside it.
 */
async function trimTornTail(handle: FileHandle): Promise<void> {
  const { size } = await handle.stat();
  if (size === 0) return;
  const window = Math.min(size, MAX_TAIL_WINDOW);
  const buffer = Buffer.alloc(window);
  await handle.read(buffer, 0, window, size - window);
  const lastNewline = buffer.lastIndexOf(0x0a);
  const keep = lastNewline < 0 ? 0 : size - (window - lastNewline - 1);
  if (keep !== size) await handle.truncate(keep);
}

async function writeLine(
  boundary: string,
  line: string,
  state: { rotations: number },
  capBytes: number,
): Promise<void> {
  const path = join(boundary, TRACE_FILE);
  const existing = await lstat(path).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  });
  if (existing !== undefined) {
    const refusal = refuseExisting(existing);
    if (refusal !== undefined) throw new Error(`${refusal}: ${path}`);
    if (existing.size + Buffer.byteLength(line) > capBytes) {
      // ponytail: one generation by contract. A cap per generation, not a retention policy — add a
      // numbered sweep here if an unbounded history is ever wanted.
      await rename(path, join(boundary, TRACE_ROTATED));
      state.rotations += 1;
    }
  }
  // O_NOFOLLOW is the symlink refusal, O_APPEND is what keeps two writers from overwriting each other.
  const handle = await open(
    path,
    constants.O_APPEND | constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await trimTornTail(handle);
    await handle.write(line, null, "utf8");
  } finally {
    await handle.close();
  }
}

const noop = (): void => {};

/**
 * A structured trace of one run: counters, statuses, and labels as newline-delimited JSON.
 *
 * Off by default — a disabled writer builds nothing, creates no directory, and opens no file. When it
 * is on, the root is `${HOME}/.config/nexus/user/traces` unless a caller names one, the directory is
 * 0700, the file 0600, and the file is appended to with `O_APPEND|O_NOFOLLOW` and rotated once at
 * `maxBytes`. No task text, observation, tool argument, path, config, env, or header is ever stored:
 * the record schema is a closed union of scalars, so a caller that passes one is refused.
 *
 * Appends never throw. A full disk, a symlinked path, or a schema violation counts a failure and
 * returns false, because a run must not die because its diagnostics could not be written.
 */
export function createTraceWriter(options: TraceWriterOptions = {}): TraceWriter {
  if (options === null || typeof options !== "object") {
    throw new Error("trace writer options must be an object");
  }
  const enabled = options.enabled === true;
  const root = resolve(options.root ?? join(homedir(), ".config", "nexus", "user", "traces"));
  if (root.length === 0 || root.includes("\0")) throw new Error("trace writer root must be a real path");
  // Same bounds the config block enforces, so a resolved `trace.maxBytes` always reaches the writer
  // and a value handed straight to it cannot buy a generation nobody bounded. `null` is out: only
  // "not given at all" means the default.
  if (options.maxBytes !== undefined) {
    const cap = options.maxBytes;
    if (typeof cap !== "number" || !Number.isInteger(cap) || cap < 1 || cap > MAX_TRACE_MAX_BYTES) {
      throw new Error(`trace writer maxBytes must be an integer between 1 and ${MAX_TRACE_MAX_BYTES}`);
    }
  }
  const capBytes = options.maxBytes ?? DEFAULT_TRACE_MAX_BYTES;

  const state = { runId: randomBytes(8).toString("hex"), seq: 0, written: 0, failures: 0, rotations: 0 };
  let tail: Promise<unknown> = Promise.resolve();

  async function record(input: TraceInput): Promise<boolean> {
    if (!enabled) return false;
    // The writer's own fields are applied last, so a caller cannot forge `schemaVersion`, `ts`, `seq`,
    // or `runId`; anything extra it carries survives into the candidate and the strict schema refuses it.
    const candidate = {
      ...input,
      schemaVersion: TRACE_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      seq: state.seq + 1,
      runId: state.runId,
    };
    const parsed = traceRecordSchema.safeParse(candidate);
    const line = parsed.success ? `${JSON.stringify(parsed.data)}\n` : "";
    if (!parsed.success || Buffer.byteLength(line) > MAX_RECORD_BYTES) {
      state.failures += 1;
      return false;
    }
    state.seq = parsed.data.seq;
    try {
      await writeLine(await ensureRoot(root), line, state, capBytes);
      state.written += 1;
      return true;
    } catch {
      state.failures += 1;
      return false;
    }
  }

  return {
    enabled,
    root,
    append(input: TraceInput): Promise<boolean> {
      // Appends queue behind each other: two in-flight writes to one file could interleave mid-line.
      const result = tail.then(
        () => record(input),
        () => record(input),
      );
      tail = result.then(noop, noop);
      return result;
    },
    stats: () => ({ enabled, written: state.written, failures: state.failures, rotations: state.rotations }),
  };
}
