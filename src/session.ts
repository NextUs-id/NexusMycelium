import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { chmod, lstat, mkdir, open, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { AgentLimits, AgentResult, AgentStepRecord } from "../kernel/src/agent.js";
import type { ModelMessage } from "../kernel/src/model.js";

export type { AgentStepRecord } from "../kernel/src/agent.js";
export type { ModelMessage } from "../kernel/src/model.js";

/** Bump only with a migration: a stored file that carries another version is rejected, never guessed. */
export const SESSION_SCHEMA_VERSION = 1;
export const REDACTED = "[redacted]";

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TEXT = 64 * 1024;
const MAX_MESSAGES = 200;
const MAX_TOOL_CALLS = 32;
const MAX_ARGUMENT_ENTRIES = 64;
const MAX_REDACT_DEPTH = 6;
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);
/** A credential is dropped by key name, whatever value the caller put under it. */
const sensitiveKey =
  /apikey|secret|token|password|passwd|passphrase|credential|authorization|privatekey|accesskey|cookie/i;
const locationKey = /^(?:home|root|cwd|env|dir|path|pwd|userprofile|homedir|tmpdir)$/i;
/** An absolute location leaks under any innocent key, so the value itself goes, not just its name. */
const absoluteLocation = /^(?:\/|~\/|\.\.\/|[A-Za-z]:[\\/])/;

export type SessionRunStatus = AgentResult["status"];

export interface ForkParent {
  sessionId: string;
  step: number;
}

export interface RunStartInput {
  /** Generated when omitted. */
  sessionId?: string;
  provider: string;
  model: string;
  task: string;
  parent?: ForkParent;
}

export interface RunEndInput {
  status: SessionRunStatus;
  text?: string;
  error?: string;
  limits?: Partial<AgentLimits>;
}

export interface SessionSummary {
  id: string;
  bytes: number;
  updatedAt: string;
}

export interface SessionStore {
  /** Absolute, unresolved sessions root. Nothing is created until the first write. */
  readonly root: string;
  /** Returns the session id actually used. */
  appendStart(input: RunStartInput): Promise<string>;
  /** Shaped for `AgentRunOptions.onStep`, so a runner can hand its transcript straight over. */
  appendStep(sessionId: string, step: AgentStepRecord): Promise<void>;
  appendEnd(sessionId: string, end: RunEndInput): Promise<void>;
  load(sessionId: string): Promise<SessionRecord[]>;
  loadLatest(): Promise<{ id: string; records: SessionRecord[] } | undefined>;
  list(): Promise<SessionSummary[]>;
  /** Copies the transcript up to `atStep` into a new id. The source file is never opened for writing. */
  fork(sessionId: string, atStep: number, newId?: string): Promise<string>;
}

export function redactText(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, REDACTED)
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]{6,}=*/gi, (_match, scheme) => `${scheme} ${REDACTED}`);
}

/** Tool arguments are arbitrary JSON, so secrets and machine locations in them are scrubbed before disk. */
function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return absoluteLocation.test(value) ? REDACTED : redactText(value);
  if (depth >= MAX_REDACT_DEPTH) return REDACTED;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARGUMENT_ENTRIES).map((entry) => redactValue(entry, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value).slice(0, MAX_ARGUMENT_ENTRIES)) {
      if (unsafeKeys.has(key) || sensitiveKey.test(key) || locationKey.test(key)) continue;
      result[key] = redactValue(entry, depth + 1);
    }
    return result;
  }
  return value;
}

const sessionIdSchema = z.string().regex(SESSION_ID_PATTERN, "must match [A-Za-z0-9_-]{1,64}");
const redactedTextSchema = z.string().max(MAX_TEXT).transform(redactText);
const stepSchema = z.number().int().min(1);

const toolCallSchema = z
  .object({
    id: z.string().min(1).max(256),
    name: z.string().min(1).max(256),
    arguments: z
      .record(z.string(), z.unknown())
      .transform((value) => redactValue(value) as Record<string, unknown>),
  })
  .strict();

const messageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: redactedTextSchema,
    toolCallId: z.string().min(1).max(256).optional(),
    toolCalls: z.array(toolCallSchema).max(MAX_TOOL_CALLS).optional(),
  })
  .strict();

/**
 * Every record is a closed shape: no `config`, `apiKeyFile`, `headers`, `path`, or `HOME` can be
 * persisted even if a caller passes one, because a strict object rejects the unknown key.
 */
const runStartSchema = z
  .object({
    type: z.literal("run-start"),
    schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
    sessionId: sessionIdSchema,
    provider: z.string().min(1).max(256),
    model: z.string().min(1).max(256),
    task: redactedTextSchema,
    parent: z.object({ sessionId: sessionIdSchema, step: stepSchema }).strict().optional(),
  })
  .strict();

const runStepSchema = z
  .object({
    type: z.literal("run-step"),
    schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
    sessionId: sessionIdSchema,
    step: stepSchema,
    messages: z.array(messageSchema).max(MAX_MESSAGES),
  })
  .strict();

const runEndSchema = z
  .object({
    type: z.literal("run-end"),
    schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
    sessionId: sessionIdSchema,
    status: z.enum(["completed", "stopped", "error"]),
    text: redactedTextSchema.optional(),
    error: redactedTextSchema.optional(),
    limits: z
      .object({
        maxSteps: z.number().int().min(0).optional(),
        maxToolCalls: z.number().int().min(0).optional(),
        timeoutMs: z.number().int().min(0).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const recordSchema = z.discriminatedUnion("type", [runStartSchema, runStepSchema, runEndSchema]);

export type RunStartRecord = z.infer<typeof runStartSchema>;
export type RunStepRecord = z.infer<typeof runStepSchema>;
export type RunEndRecord = z.infer<typeof runEndSchema>;
export type SessionRecord = RunStartRecord | RunStepRecord | RunEndRecord;

/** The flat transcript a resume needs: every step's messages in append order. */
export function sessionMessages(records: readonly SessionRecord[]): ModelMessage[] {
  return records.filter((record) => record.type === "run-step").flatMap((record) => record.messages);
}

function assertSessionId(value: unknown): string {
  const parsed = sessionIdSchema.safeParse(value);
  if (!parsed.success) throw new Error(`invalid session id: ${String(value)}`);
  return parsed.data;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

function inside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""}${issue.message}`)
    .join("; ");
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
 * The real sessions root, created and tightened on every write. The parent is canonicalized and a
 * symlinked root is followed to its own target first, because `mkdir` refuses a link that has no
 * target yet; `mkdir` also leaves an existing directory's mode alone, so a loose store is re-tightened.
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

async function regularFileStats(path: string): Promise<Stats | undefined> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile()) throw new Error(`session path is not a regular file: ${path}`);
    return stats;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function readSessionFile(path: string): Promise<string> {
  const text = await readFile(path, "utf8");
  if (text.length > MAX_FILE_BYTES) throw new Error(`session file exceeds ${MAX_FILE_BYTES} bytes: ${path}`);
  return text;
}

/** Canonical sessions root; symlinked parents (a temp dir, say) are resolved once per operation. */
async function canonicalRoot(root: string): Promise<string> {
  return realpath(resolve(root));
}

async function sessionPath(root: string, sessionId: string): Promise<string> {
  const boundary = await canonicalRoot(root);
  const candidate = join(boundary, `${assertSessionId(sessionId)}.jsonl`);
  if (!inside(boundary, candidate)) throw new Error("session path escapes the sessions root");
  const canonical = await realpath(candidate);
  if (!inside(boundary, canonical)) {
    throw new Error("session path escapes the sessions root through a symlink");
  }
  return canonical;
}

/** Drop everything after the last newline: only a torn tail is lost, every whole record survives. */
async function truncateTornTail(handle: FileHandle, path: string): Promise<void> {
  const { size } = await handle.stat();
  if (size === 0) return;
  const text = await readSessionFile(path);
  if (text.endsWith("\n")) return;
  await handle.truncate(text.lastIndexOf("\n") + 1);
}

async function appendRecord(root: string, sessionId: string, record: SessionRecord): Promise<void> {
  const line = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(line) > MAX_RECORD_BYTES) {
    throw new Error(`session record exceeds ${MAX_RECORD_BYTES} bytes`);
  }
  const boundary = await ensureRoot(root);
  const path = join(boundary, `${sessionId}.jsonl`);
  if (!inside(boundary, path)) throw new Error("session path escapes the sessions root");
  await regularFileStats(path);
  const handle = await open(
    path,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await truncateTornTail(handle, path);
    await handle.chmod(0o600);
    await handle.write(line, null, "utf8");
  } finally {
    await handle.close();
  }
}

function parseRecords(sessionId: string, text: string): SessionRecord[] {
  const lines = text.split("\n");
  lines.pop();
  const records: SessionRecord[] = [];
  for (const [index, line] of lines.entries()) {
    const last = index === lines.length - 1;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      if (last) return records;
      throw new Error(`corrupt session record at line ${index + 1} in ${sessionId}`, { cause: error });
    }
    const parsed = recordSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error(
        `invalid session record at line ${index + 1} in ${sessionId}: ${formatIssues(parsed.error)}`,
      );
    }
    if (parsed.data.sessionId !== sessionId) {
      throw new Error(
        `session record at line ${index + 1} claims ${parsed.data.sessionId} inside ${sessionId}`,
      );
    }
    records.push(parsed.data);
  }
  return records;
}

async function loadRecords(root: string, sessionId: string): Promise<SessionRecord[]> {
  const id = assertSessionId(sessionId);
  let path: string;
  try {
    path = await sessionPath(root, id);
  } catch (error) {
    if (hasCode(error, "ENOENT")) throw new Error(`unknown session: ${id}`);
    throw error;
  }
  const stats = await regularFileStats(path);
  // A store is only ever written 0600, so a wider mode means someone else can read the transcript.
  if (stats !== undefined && (stats.mode & 0o777) !== 0o600) {
    throw new Error(`session file mode must be 0600: ${path}`);
  }
  const records = parseRecords(id, await readSessionFile(path));
  if (records.length === 0) throw new Error(`session ${id} holds no record`);
  return records;
}

async function listSessions(root: string): Promise<SessionSummary[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
  const summaries: SessionSummary[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const id = name.slice(0, -".jsonl".length);
    if (!SESSION_ID_PATTERN.test(id)) continue;
    const stats = await lstat(join(root, name));
    if (!stats.isFile()) continue;
    summaries.push({ id, bytes: stats.size, updatedAt: stats.mtime.toISOString() });
  }
  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

function newSessionId(): string {
  return randomBytes(8).toString("hex");
}

function forkSessionId(source: string): string {
  return `${source.slice(0, 40)}-fork-${randomBytes(6).toString("hex")}`;
}

export async function createSessionStore(options: { root?: string } = {}): Promise<SessionStore> {
  if (options !== undefined && (options === null || typeof options !== "object")) {
    throw new Error("session store options must be an object");
  }
  // Secure home scope by default: the repo `data/` mount is a shared fuseblk volume, not user state.
  const root = resolve(options.root ?? join(homedir(), ".config", "nexus", "user", "sessions"));
  if (root.length === 0 || root.includes("\0")) throw new Error("session store root must be a real path");

  return {
    root,
    async appendStart(input: RunStartInput): Promise<string> {
      if (input === null || typeof input !== "object") throw new Error("run start must be an object");
      const sessionId = assertSessionId(input.sessionId ?? newSessionId());
      const record = runStartSchema.safeParse({
        type: "run-start",
        schemaVersion: SESSION_SCHEMA_VERSION,
        sessionId,
        provider: input.provider,
        model: input.model,
        task: input.task,
        ...(input.parent === undefined ? {} : { parent: input.parent }),
      });
      if (!record.success) throw new Error(`invalid run start: ${formatIssues(record.error)}`);
      await appendRecord(root, sessionId, record.data);
      return sessionId;
    },
    async appendStep(sessionId: string, step: AgentStepRecord): Promise<void> {
      const id = assertSessionId(sessionId);
      const record = runStepSchema.safeParse({
        type: "run-step",
        schemaVersion: SESSION_SCHEMA_VERSION,
        sessionId: id,
        step: step?.step,
        messages: step?.messages,
      });
      if (!record.success) throw new Error(`invalid run step: ${formatIssues(record.error)}`);
      await appendRecord(root, id, record.data);
    },
    async appendEnd(sessionId: string, end: RunEndInput): Promise<void> {
      const id = assertSessionId(sessionId);
      const record = runEndSchema.safeParse({
        type: "run-end",
        schemaVersion: SESSION_SCHEMA_VERSION,
        sessionId: id,
        status: end?.status,
        ...(end?.text === undefined ? {} : { text: end.text }),
        ...(end?.error === undefined ? {} : { error: end.error }),
        ...(end?.limits === undefined ? {} : { limits: end.limits }),
      });
      if (!record.success) throw new Error(`invalid run end: ${formatIssues(record.error)}`);
      await appendRecord(root, id, record.data);
    },
    load: (sessionId: string) => loadRecords(root, sessionId),
    async loadLatest() {
      const [summary] = await listSessions(root);
      if (summary === undefined) return undefined;
      return { id: summary.id, records: await loadRecords(root, summary.id) };
    },
    list: () => listSessions(root),
    async fork(sessionId: string, atStep: number, newId?: string): Promise<string> {
      const source = assertSessionId(sessionId);
      const target = assertSessionId(newId ?? forkSessionId(source));
      if (target === source) throw new Error("fork target must differ from the source session");
      const records = await loadRecords(root, source);
      const start = records.find((record) => record.type === "run-start");
      if (start === undefined) throw new Error(`session ${source} has no run-start record`);
      const steps = records.filter(
        (record): record is RunStepRecord => record.type === "run-step" && record.step <= atStep,
      );
      if (steps.at(-1)?.step !== atStep) throw new Error(`session ${source} has no step ${atStep}`);
      await appendRecord(root, target, {
        ...start,
        sessionId: target,
        parent: { sessionId: source, step: atStep },
      });
      for (const step of steps) {
        await appendRecord(root, target, { ...step, sessionId: target });
      }
      return target;
    },
  };
}
