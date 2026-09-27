import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TRACE_MAX_BYTES, MAX_TRACE_MAX_BYTES } from "../kernel/src/config.js";
import { denyNetwork, type ProtectedTree, snapshotTrees } from "./sandbox.fixtures.js";
import { fillTraceFile, withTraceWriter } from "./trace.fixtures.js";
import type { TraceRecord, TraceWriter } from "./trace.js";

/**
 * Security contract for the Task 3.4 structured trace log. Independent of `src/trace.test.ts`, which
 * covers what the writer does; this file covers what it must never do — carry a credential, a
 * filesystem location, or a free-text field into the bytes, follow a planted symlink, widen a mode,
 * splice onto a torn record, and take a run down with its own diagnostics.
 *
 * Nothing here reaches a socket, a real key, or real user state: every root is a fresh temp dir,
 * HOME is a throwaway, and the repo `user/`, `data/`, and `config/` are digested before and after.
 */

/** The checkout this suite runs in. Its real trees are targets a trace must never reach. */
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** Captured before any test stubs HOME, so the digest below watches the real home and not the stub. */
const realHome = homedir();

const posix = process.platform !== "win32";
/** The mode rules need a posix host and a real uid: as root, a 0o644 file is nobody else's problem. */
const permissionsSupported = posix && process.getuid?.() !== 0;

const fdRoot = "/proc/self/fd";
/** Probed once, so `skipIf` can be honest about what is missing on this host. */
const fdProbeSupported = await readdir(fdRoot).then(
  () => true,
  () => false,
);

/** The writer's cap when it is told nothing: the number `config.trace.maxBytes` defaults to. */
const capBytes = DEFAULT_TRACE_MAX_BYTES;

/** Deliberate type-system bypass: the writer must refuse these at runtime, not at compile time. */
const smuggle = <T>(value: object): T => value as T;

/** A canary that exists only in the environment: it can only reach a record if something copies it in. */
const canaryKey = "dummy-trace-key-0123456789";
/** Credential-shaped canaries, so a scalar is caught by shape and not by the field it arrived under. */
const canarySecret = "sk-live-0123456789abcdefghij";
const canaryBearer = "Bearer eyJhbGciOiJIUzI1NiJ9.dGVzdC1wYXlsb2Fk.c2ln";

const stubbedHomes: string[] = [];

/** A throwaway HOME carrying credential-shaped canaries, so a leak has something to leak. */
async function stubbedHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "nexus-trace-sec-home-"));
  stubbedHomes.push(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("OPENAI_API_KEY", canarySecret);
  vi.stubEnv("NEXUS_API_KEY", canaryKey);
  vi.stubEnv("ANTHROPIC_API_KEY", canarySecret);
  return home;
}

/** Host trees the trace must leave byte-identical: the repo overlay, its data mount, and the home scope. */
function hostTrees(): readonly ProtectedTree[] {
  return [
    { label: "repo/user", path: join(repoRoot, "user") },
    { label: "repo/data", path: join(repoRoot, "data") },
    { label: "repo/config", path: join(repoRoot, "config") },
    { label: "home/nexus-user", path: join(realHome, ".config", "nexus", "user") },
  ];
}

/** Where every open fd points right now, so "no handle" can be checked instead of assumed. */
async function openFdPaths(): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(fdRoot)) {
    // An fd can be recycled between the listing and the read; that one simply has no path.
    paths.push(await readlink(join(fdRoot, entry)).catch(() => ""));
  }
  return paths;
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

function octal(stats: { mode: number }): string {
  return (stats.mode & 0o777).toString(8);
}

/** A refusal is signalled, never thrown: `false` back, one more counted failure, no new record. */
async function expectRefused(writer: TraceWriter, input: unknown): Promise<void> {
  const before = writer.stats();
  await expect(writer.append(smuggle<Parameters<TraceWriter["append"]>[0]>(input as object))).resolves.toBe(
    false,
  );
  const after = writer.stats();
  expect(after.failures, "a refusal must be counted").toBe(before.failures + 1);
  expect(after.written, "a refused append must not be counted as written").toBe(before.written);
}

async function expectAccepted(
  writer: TraceWriter,
  input: Parameters<TraceWriter["append"]>[0],
): Promise<void> {
  const before = writer.stats();
  await expect(writer.append(input)).resolves.toBe(true);
  const after = writer.stats();
  expect(after.written, "a valid record must be counted as written").toBe(before.written + 1);
  expect(after.failures, "a valid record must not be counted as a failure").toBe(before.failures);
}

/** The module under test, loaded the same way in every case that needs the constructor directly. */
async function traceModule(): Promise<typeof import("./trace.js")> {
  return import("./trace.js");
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const home of stubbedHomes.splice(0)) await rm(home, { recursive: true, force: true });
});

describe("structured trace log security contract", () => {
  it("is off unless asked for with exactly true, and leaves no directory, file, or handle", async () => {
    const home = await stubbedHome();
    const before = await snapshotTrees(hostTrees());
    const { createTraceWriter } = await traceModule();

    for (const options of [
      undefined,
      {},
      // A truthy string is how an env var arrives. Opt-in has to be the boolean, not the coercion.
      smuggle<{ enabled: boolean }>({ enabled: "true" }),
      smuggle<{ enabled: boolean }>({ enabled: 1 }),
    ]) {
      const writer = options === undefined ? createTraceWriter() : createTraceWriter(options);
      expect(writer.enabled).toBe(false);
      expect(writer.stats()).toEqual({ enabled: false, written: 0, failures: 0, rotations: 0 });
      // A disabled writer still resolves its root, which is the user's own trace directory.
      expect(writer.root).toBe(join(home, ".config", "nexus", "user", "traces"));
      await expect(writer.append({ type: "run-start", provider: "mock", model: "mock" })).resolves.toBe(
        false,
      );
      expect(writer.stats()).toEqual({ enabled: false, written: 0, failures: 0, rotations: 0 });
    }
    // Nothing exists: resolving a path is not touching it, not even the parent chain.
    expect(await exists(join(home, ".config"))).toBe(false);
    expect(await readdir(home)).toEqual([]);
    if (fdProbeSupported) {
      const fds = await openFdPaths();
      expect(fds.filter((path) => path.startsWith(home))).toEqual([]);
      expect(fds.filter((path) => path.includes(join(".config", "nexus", "user", "traces")))).toEqual([]);
    }

    // The options bag is a trust boundary too: a non-object, or a path that is not a path, is out.
    expect(() => createTraceWriter(null as never)).toThrow();
    expect(() => createTraceWriter("on" as never)).toThrow();
    expect(() => createTraceWriter(smuggle<{ root: string }>({ root: "traces\0.jsonl" }))).toThrow(/path/);

    // Positive control: the same writer with `enabled: true` does make the tree, the file, and the
    // handle, so the assertions above are about being off and not about a probe that sees nothing.
    const on = createTraceWriter({ enabled: true });
    await expectAccepted(on, { type: "run-start", provider: "mock", model: "mock" });
    const root = on.root;
    expect(await readdir(root)).toEqual(["trace.jsonl"]);
    expect(octal(await lstat(root))).toBe("700");
    expect(octal(await lstat(join(root, "trace.jsonl")))).toBe("600");
    if (fdProbeSupported) {
      const probe = await open(join(root, "probe-handle"), "a");
      const seen = await openFdPaths();
      await probe.close();
      expect(seen.filter((path) => path.startsWith(root))).not.toEqual([]);
    }
    expect(await snapshotTrees(hostTrees())).toEqual(before);
  });

  it("refuses a path, text, argument, or secret field, and any value the schema does not name", async () => {
    await withTraceWriter(async ({ bytes, records, writer }) => {
      // Positive control first, and the closed envelope it writes: exactly the writer's own fields.
      await expectAccepted(writer, { type: "run-start", provider: "mock", model: "mock" });
      expect(Object.keys((await records())[0] ?? {}).sort()).toEqual([
        "model",
        "provider",
        "runId",
        "schemaVersion",
        "seq",
        "ts",
        "type",
      ]);
      const baseline = await bytes();
      expect(baseline).toContain('"type":"run-start"');

      // The four families a trace has no slot for: locations, free text, arguments, credentials.
      const deniedFields: ReadonlyArray<readonly [string, unknown]> = [
        ["path", "/etc/passwd"],
        ["dir", "src"],
        ["cwd", "."],
        ["home", "~"],
        ["file", "trace.jsonl"],
        ["text", "a task the user typed"],
        ["content", "assistant prose"],
        ["message", "hello"],
        ["prompt", "system prompt"],
        ["args", { command: "rm -rf /" }],
        ["arguments", ["--force"]],
        ["input", "raw input"],
        ["output", "raw output"],
        ["secret", canarySecret],
        ["apiKey", canarySecret],
        ["token", canarySecret],
        ["authorization", canaryBearer],
        ["env", { HOME: "/home/developer" }],
        ["config", { model: "mock" }],
        ["observations", ["looked at a file"]],
      ];
      for (const [field, value] of deniedFields) {
        await expectRefused(writer, { type: "run-start", provider: "mock", model: "mock", [field]: value });
      }

      // The writer's own fields are the one thing a caller cannot have refused: they are applied
      // after the caller's, so a forgery is overwritten rather than stored. Checked on the bytes,
      // because a forged identity or version that reached the file would be worse than a lost field.
      const { TRACE_SCHEMA_VERSION } = await traceModule();
      await expectAccepted(
        writer,
        smuggle<Parameters<TraceWriter["append"]>[0]>({
          type: "run-step",
          steps: 1,
          schemaVersion: 99,
          ts: "not-a-timestamp",
          seq: 9999,
          runId: "0123456789abcdef",
        }),
      );
      const forged = (await records()).at(-1);
      expect(forged?.seq).toBe(2);
      expect(forged?.runId).not.toBe("0123456789abcdef");
      expect(forged?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(forged?.schemaVersion).toBe(TRACE_SCHEMA_VERSION);
      expect(await bytes()).not.toContain("not-a-timestamp");
      // Checked as a parsed field, not as a substring: `runId` is hex, so "9999" can occur in one.
      expect(forged?.seq).not.toBe(9999);
      expect(await bytes()).not.toContain("0123456789abcdef");

      // Non-scalars, wrong types, and shapes outside the closed union.
      const malformed: readonly object[] = [
        { type: "run-start", provider: { nested: true }, model: "mock" },
        { type: "run-start", provider: ["mock"], model: "mock" },
        { type: "run-start", provider: null, model: "mock" },
        { type: "run-start", provider: 1, model: "mock" },
        { type: "run-start", provider: "", model: "mock" },
        { type: "run-start", provider: "m".repeat(4096), model: "mock" },
        { type: "run-step", steps: -1 },
        { type: "run-step", steps: 1.5 },
        { type: "run-step", steps: Number.NaN },
        { type: "run-step", steps: Number.POSITIVE_INFINITY },
        { type: "run-step", steps: "3" },
        { type: "run-step" },
        { type: "run-end", status: "unknown", steps: 1, toolCalls: 0 },
        { type: "run-end", status: "completed", steps: 1, toolCalls: 0, budgetReason: "budget:nonsense" },
        { type: "run-end", status: "completed", steps: 1, toolCalls: 0, usage: { inputTokens: -1 } },
        { type: "task", name: "something else entirely" },
        {},
        { provider: "mock", model: "mock" },
      ];
      for (const input of malformed) await expectRefused(writer, input);

      // A refused record leaves the file byte-identical: no partial line and no skipped sequence
      // beyond the one valid record the forgery check wrote.
      const after = await bytes();
      expect(after.startsWith(baseline)).toBe(true);
      expect(after.split("\n").filter((line) => line.length > 0)).toHaveLength(2);
      expect(writer.stats()).toEqual({
        enabled: true,
        written: 2,
        failures: deniedFields.length + malformed.length,
        rotations: 0,
      });
      for (const [field] of deniedFields) {
        expect(after, `the trace must not carry a ${field} field`).not.toContain(`"${field}"`);
      }
      for (const forbidden of [canaryKey, canarySecret, canaryBearer, "/etc/passwd", "rm -rf /"]) {
        expect(after, `the trace must not contain ${forbidden}`).not.toContain(forbidden);
      }
    });
  });

  it("keeps a canary API key, an absolute path, and a secret out of the bytes", async () => {
    const home = await stubbedHome();
    await withTraceWriter(async ({ bytes, records, writer }) => {
      const keyFile = join(home, ".config", "nexus", "user", "secrets", "provider.key");
      await mkdir(join(home, ".config", "nexus", "user", "secrets"), { recursive: true });
      await writeFile(keyFile, `${canarySecret}\n`, "utf8");

      // A legitimate run first, so the bytes under test are real records and not an empty file.
      await expectAccepted(writer, { type: "run-start", provider: "openai", model: "gpt-4o-mini" });
      await expectAccepted(writer, { type: "run-step", steps: 1 });
      await expectAccepted(writer, {
        type: "run-end",
        status: "completed",
        steps: 2,
        toolCalls: 0,
        usage: { inputTokens: 12, outputTokens: 34, totalTokens: 46 },
      });

      // Hostile scalars under the writer's own field names: absolute and home-relative locations, a
      // traversal, a drive letter, a key file location, and every credential shape the host uses.
      const hostile: readonly string[] = [
        keyFile,
        home,
        repoRoot,
        tmpdir(),
        "/etc/shadow",
        "~/notes.md",
        "../outside.jsonl",
        "C:\\Users\\developer",
        `${keyFile}:${canarySecret}`,
        canarySecret,
        canaryBearer,
        `api_key=${canarySecret}`,
        `token=${canaryKey}`,
        "Authorization: Bearer abcdefghijklmnop",
        "-----BEGIN PRIVATE KEY-----",
      ];
      for (const value of hostile) {
        await expectRefused(writer, { type: "run-start", provider: "mock", model: value });
        await expectRefused(writer, { type: "run-start", provider: value, model: "mock" });
      }

      const written = await bytes();
      expect(written.length).toBeGreaterThan(0);
      for (const forbidden of [
        canaryKey,
        canarySecret,
        canaryBearer,
        keyFile,
        "secrets",
        home,
        repoRoot,
        tmpdir(),
        "/etc/shadow",
        "notes.md",
        "outside.jsonl",
        "PRIVATE KEY",
        "api_key",
        "Authorization",
      ]) {
        expect(written, `the trace must not contain ${forbidden}`).not.toContain(forbidden);
      }
      // The refused scalars cost a run nothing but a counter, and the good records are still whole.
      expect((await records()).map((record: TraceRecord) => record.seq)).toEqual([1, 2, 3]);
      expect(writer.stats()).toMatchObject({ written: 3, failures: hostile.length * 2, rotations: 0 });
    });
  });

  it("strips control characters and refuses a scalar that is nothing but them", async () => {
    await withTraceWriter(async ({ bytes, lines, records, writer }) => {
      await expectAccepted(writer, {
        type: "run-start",
        provider: "open\u0000ai\u0007\u001b\u0085[31m",
        model: "gpt\n4o\rmini\tbeta",
      });
      // Nothing left after the strip is no value at all, and a record missing it is not a record.
      await expectRefused(writer, { type: "run-start", provider: "\u0000\u0007", model: "mock" });
      await expectRefused(writer, { type: "run-start", provider: "mock", model: "\u001b" });
      await expectRefused(writer, {
        type: "run-end",
        status: "stopped",
        steps: 1,
        toolCalls: 1,
        budgetReason: "\n",
      });

      const written = await bytes();
      // One newline per record — the separator — and nothing a terminal, a pager, or a log shipper
      // would read as framing inside a value.
      expect(
        [...Buffer.from(written)].filter((byte) => (byte < 0x20 && byte !== 0x0a) || byte === 0x7f),
      ).toEqual([]);
      expect(written.endsWith("\n")).toBe(true);
      // The record separator is the only control character left in the file, C0, DEL, and C1 alike.
      expect(written.replace(/\n/g, "")).not.toMatch(/\p{Cc}/u);
      expect(await lines()).toHaveLength(1);
      expect((await records())[0]).toMatchObject({
        type: "run-start",
        provider: "openai[31m",
        model: "gpt4ominibeta",
      });

      // A Unicode line or paragraph separator is not a record separator: it is a character in a
      // value, and it must not be able to add a line, forge a frame, or break the count.
      await expectAccepted(writer, { type: "run-step", steps: 1 });
      await expectAccepted(writer, {
        type: "run-start",
        provider: "before\u2028after",
        model: "u\u2029v",
      });
      const withSeparators = await bytes();
      expect(await lines()).toHaveLength(3);
      expect(
        [...Buffer.from(withSeparators)].filter((byte) => (byte < 0x20 && byte !== 0x0a) || byte === 0x7f),
      ).toEqual([]);
      expect((await records())[2]).toMatchObject({ provider: "before\u2028after", model: "u\u2029v" });
      expect(writer.stats()).toMatchObject({ written: 3, failures: 3, rotations: 0 });
    });
  });

  it.skipIf(!posix)("never appends through a symlinked trace file", async () => {
    await withTraceWriter(async ({ file, lines, outside, root, writer }) => {
      await expectAccepted(writer, { type: "run-start", provider: "mock", model: "mock" });
      const before = await lines();
      await mkdir(outside, { recursive: true });

      // A planted link where the log file belongs: every append is refused, and the file it aims at
      // — the developer's, not ours — comes out byte-identical.
      const victim = join(outside, "victim.jsonl");
      await writeFile(victim, "host only\n", "utf8");
      await rm(file);
      await symlink(victim, file);
      for (let step = 1; step <= 3; step += 1) await expectRefused(writer, { type: "run-step", steps: step });
      expect(await readFile(victim, "utf8")).toBe("host only\n");
      expect(await readdir(outside)).toEqual(["victim.jsonl"]);

      // A link with no target at all is the same refusal, not a file the writer creates through it.
      await rm(file);
      await symlink(join(outside, "never-created.jsonl"), file);
      await expectRefused(writer, { type: "run-step", steps: 4 });
      expect(await exists(join(outside, "never-created.jsonl"))).toBe(false);

      // A link that points back inside the root is refused too: the check is that the path is a
      // link, not where it happens to aim.
      await rm(file);
      await symlink(join(root, "elsewhere.jsonl"), file);
      await expectRefused(writer, { type: "run-step", steps: 5 });
      expect(await exists(join(root, "elsewhere.jsonl"))).toBe(false);

      // Nothing partial was left behind the link: once the planted path is gone the writer writes a
      // fresh file holding one whole record, not a line spliced onto a fragment.
      await rm(file);
      await expectAccepted(writer, { type: "run-step", steps: 6 });
      const restarted = await lines();
      expect(restarted).toHaveLength(1);
      expect(restarted[0]).not.toBe(before[0]);
      expect(() => JSON.parse(restarted[0] ?? "")).not.toThrow();
      expect(await readdir(root)).toEqual(["trace.jsonl"]);
      expect(writer.stats()).toMatchObject({ written: 2, failures: 5, rotations: 0 });
    });
  });

  it.skipIf(!posix)("follows a symlinked root to one real target rather than two directories", async () => {
    const holder = await mkdtemp(join(tmpdir(), "nexus-trace-sec-alias-"));
    const alias = join(holder, "alias");
    const target = join(holder, "real-target");
    await symlink(target, alias, "dir");
    const { createTraceWriter } = await traceModule();
    try {
      const writer = createTraceWriter({ enabled: true, root: alias });
      await expectAccepted(writer, { type: "run-start", provider: "mock", model: "mock" });
      await expectAccepted(writer, { type: "run-step", steps: 1 });
      // One directory, not two: the alias and its target are the same place, so a record is stored
      // once and the link is still a link rather than a copy of the tree it aimed at.
      expect((await lstat(alias)).isSymbolicLink()).toBe(true);
      expect((await lstat(target)).isDirectory()).toBe(true);
      expect(await readdir(alias)).toEqual(["trace.jsonl"]);
      expect(await readdir(target)).toEqual(["trace.jsonl"]);
      expect((await readdir(holder)).sort()).toEqual(["alias", "real-target"]);
      expect(writer.stats()).toMatchObject({ written: 2, failures: 0, rotations: 0 });
    } finally {
      await rm(holder, { recursive: true, force: true });
      expect(await exists(dirname(holder))).toBe(true);
    }
  });

  it.skipIf(!permissionsSupported)(
    "keeps the root 0700 and the file 0600, and refuses a widened one",
    async () => {
      await withTraceWriter(async ({ bytes, file, root, writer }) => {
        await expectAccepted(writer, { type: "run-start", provider: "mock", model: "mock" });
        const original = await bytes();
        expect(octal(await lstat(root))).toBe("700");
        expect(octal(await lstat(file))).toBe("600");

        // A widened file is refused rather than quietly tightened: whatever was already written is
        // already readable, and a trace that pretends otherwise is worse than no trace at all.
        for (const mode of [0o644, 0o640, 0o604, 0o666, 0o777, 0o400]) {
          await chmod(file, mode);
          await expectRefused(writer, { type: "run-step", steps: mode });
          expect(await bytes(), `mode ${mode.toString(8)} must not be written through`).toBe(original);
          await chmod(file, 0o600);
        }
        // A loosened root is re-tightened on the next append, and the trace stays inside it.
        await chmod(root, 0o777);
        await expectAccepted(writer, { type: "run-step", steps: 99 });
        expect(octal(await lstat(root))).toBe("700");
        expect(octal(await lstat(file))).toBe("600");
        expect(await bytes()).not.toBe(original);
        expect(writer.stats()).toMatchObject({ written: 2, failures: 6, rotations: 0 });
      });
    },
  );

  it("trims a torn tail instead of splicing the next record onto it", async () => {
    await withTraceWriter(async ({ file, lines, records, writer }) => {
      await expectAccepted(writer, { type: "run-start", provider: "mock", model: "mock" });
      await expectAccepted(writer, { type: "run-step", steps: 1 });
      const first = await lines();
      expect(first).toHaveLength(2);

      // A crash mid-write: the last line has no newline, so it is not a record.
      await writeFile(file, `${first.join("\n")}\n{"type":"run-step","schemaVersio`, "utf8");
      await expectAccepted(writer, { type: "run-step", steps: 2 });
      expect((await records()).map((record) => record.seq)).toEqual([1, 2, 3]);

      // Same again after a run-end, so the fragment sits against the longest record shape.
      const grown = await lines();
      await writeFile(file, `${grown.join("\n")}\n{"type":"run-end","status":"comp`, "utf8");
      await expectAccepted(writer, { type: "run-end", status: "completed", steps: 3, toolCalls: 0 });
      const kept = await records();
      expect(kept.map((record) => record.seq)).toEqual([1, 2, 3, 4]);
      expect(kept.at(-1)).toMatchObject({ type: "run-end", status: "completed" });
      // At most the partial record is lost; every whole record before it is byte-identical.
      const repaired = await lines();
      expect(repaired[0]).toBe(first[0]);
      expect(repaired[1]).toBe(first[1]);
      expect(repaired[2]).toBe(grown[2]);
      expect(writer.stats()).toMatchObject({ written: 4, failures: 0, rotations: 0 });
    });
  });

  it("rotates one generation at the cap and never stacks a second copy", async () => {
    await withTraceWriter(async ({ file, records, rotated, root, writer }) => {
      await mkdir(root, { recursive: true, mode: 0o700 });
      // Both generations pre-planted: the rotation must overwrite the previous one, not keep it.
      const planted = await fillTraceFile(file, capBytes);
      const previous = await fillTraceFile(rotated, 1024);
      await chmod(file, 0o600);
      await chmod(rotated, 0o600);

      await expectAccepted(writer, { type: "run-start", provider: "mock", model: "mock" });
      expect(writer.stats().rotations, "the planted file must exceed the writer's byte cap").toBe(1);
      expect(writer.stats()).toMatchObject({ written: 1, failures: 0, rotations: 1 });
      expect(await readdir(root)).toHaveLength(2);
      // The generation rotated away holds the old records, and only those.
      expect((await readFile(rotated)).byteLength).toBe(planted);
      expect((await readFile(rotated)).byteLength).not.toBe(previous);
      expect((await records()).map((record) => record.seq)).toEqual([1]);

      // Appends continue into the fresh generation, and the counter is the only rotation record.
      await expectAccepted(writer, { type: "run-step", steps: 1 });
      expect(await readdir(root)).toHaveLength(2);
      expect((await records()).map((record) => record.seq)).toEqual([1, 2]);
      expect((await readFile(rotated)).byteLength).toBe(planted);
      expect(writer.stats()).toMatchObject({ written: 2, failures: 0, rotations: 1 });
    });
  });

  it("serializes concurrent appends into whole lines and a single sequence", async () => {
    await withTraceWriter(async ({ lines, records, writer }) => {
      const appends = Array.from({ length: 24 }, (_unused, index) =>
        writer.append({ type: "run-step", steps: index + 1 }),
      );
      await expect(Promise.all(appends)).resolves.toEqual(Array.from({ length: 24 }, () => true));
      expect(writer.stats()).toMatchObject({ written: 24, failures: 0, rotations: 0 });

      // Every line is a whole record: an interleaved write leaves a line that does not parse.
      const written = await lines();
      expect(written).toHaveLength(24);
      for (const line of written) expect(() => JSON.parse(line)).not.toThrow();
      const kept = await records();
      // One run id, one sequence with no gap and no repeat, and every step stored exactly once.
      expect(new Set(kept.map((record) => record.runId)).size).toBe(1);
      expect(kept.map((record) => record.seq)).toEqual(Array.from({ length: 24 }, (_u, i) => i + 1));
      expect(kept.map((record) => (record.type === "run-step" ? record.steps : 0))).toEqual(
        Array.from({ length: 24 }, (_unused, index) => index + 1),
      );
    });
  });

  it("counts a write failure, stays nonfatal, and recovers when the path is usable again", async () => {
    await withTraceWriter(async ({ file, records, root, writer }) => {
      await expectAccepted(writer, { type: "run-start", provider: "mock", model: "mock" });
      await expectAccepted(writer, { type: "run-step", steps: 1 });
      await rm(file);
      await mkdir(file);

      // A directory where the log file belongs: no platform can open it, whatever the uid, and a
      // run must not die because its own diagnostics could not be written.
      for (let step = 2; step <= 5; step += 1) {
        await expect(writer.append({ type: "run-step", steps: step })).resolves.toBe(false);
      }
      expect(writer.stats()).toMatchObject({ written: 2, failures: 4 });
      expect((await lstat(file)).isDirectory()).toBe(true);
      expect(await records()).toEqual([]);

      // The failure is counted, not sticky: clearing the obstruction lets the same writer continue,
      // and the counter is history rather than a latch.
      await rm(file, { recursive: true, force: true });
      await expectAccepted(writer, { type: "run-step", steps: 6 });
      const after = writer.stats();
      expect(after).toMatchObject({ written: 3, failures: 4, rotations: 0 });
      expect(await readdir(root)).toEqual(["trace.jsonl"]);
      // The five failed writes still consumed their sequence numbers, so the recovered record
      // continues the run instead of reusing one: a gap is visible, a duplicate is not.
      expect((await records()).map((record) => record.seq)).toEqual([7]);
    });
  });

  it.skipIf(!permissionsSupported)(
    "re-tightens a root somebody loosened instead of writing into it",
    async () => {
      await withTraceWriter(async ({ file, records, root, writer }) => {
        await expectAccepted(writer, { type: "run-start", provider: "mock", model: "mock" });
        // A root left group- or world-readable by anything else is narrowed to 0700 before the record
        // lands, so a trace is never written into a directory someone else can read.
        for (const mode of [0o777, 0o705, 0o500]) {
          await chmod(root, mode);
          await expectAccepted(writer, { type: "run-step", steps: mode });
          expect(octal(await lstat(root)), `mode ${mode.toString(8)} must be re-tightened`).toBe("700");
          expect(octal(await lstat(file))).toBe("600");
        }
        expect((await records()).map((record) => record.seq)).toEqual([1, 2, 3, 4]);
        expect(writer.stats()).toMatchObject({ written: 4, failures: 0, rotations: 0 });
      });
    },
  );

  it("keeps a plugin lifecycle to a name and a boolean, never a load error or a path", async () => {
    await withTraceWriter(async ({ bytes, lines, records, writer }) => {
      const loadError = "tools root must be a directory";
      await expectAccepted(writer, { type: "plugin-load", name: "tools-basic", required: true });
      await expectAccepted(writer, { type: "plugin-load-failed", name: "tools-core", required: false });
      expect(await lines()).toHaveLength(2);

      // Every way a host might be tempted to hand over the failure instead of the outcome. A plugin
      // record is a diagnostic, not a log of what went wrong: the message, the stack, the manifest,
      // and the path are all refused, and so is a name that is really one of those things.
      for (const forbidden of [
        { type: "plugin-load-failed", name: "tools-core", required: false, error: loadError },
        { type: "plugin-load-failed", name: "tools-core", required: false, message: loadError },
        { type: "plugin-load-failed", name: "tools-core", required: false, stack: "at load (registry.ts)" },
        { type: "plugin-load-failed", name: "tools-core", required: false, path: "/plugins/tools-core" },
        { type: "plugin-load", name: "tools-core", required: false, manifest: { version: "1.0.0" } },
        { type: "plugin-load", name: loadError, required: false },
        { type: "plugin-load", name: canarySecret, required: true },
        { type: "plugin-load", name: canaryBearer, required: true },
        { type: "plugin-load", name: repoRoot, required: true },
        { type: "plugin-load", name: tmpdir(), required: true },
        { type: "plugin-load", name: "~/plugins/tools-core", required: true },
      ]) {
        await expectRefused(writer, forbidden);
      }

      const written = await bytes();
      for (const leaked of [
        loadError,
        "error",
        "message",
        "stack",
        "manifest",
        "version",
        "/plugins",
        repoRoot,
        tmpdir(),
        canaryKey,
        canarySecret,
        canaryBearer,
      ]) {
        expect(written, `the trace must not contain ${leaked}`).not.toContain(leaked);
      }
      const kept = await records();
      expect(kept).toMatchObject([
        { type: "plugin-load", name: "tools-basic", required: true, seq: 1 },
        { type: "plugin-load-failed", name: "tools-core", required: false, seq: 2 },
      ]);
      // The closed envelope plus the two fields. Nothing else has a slot to land in.
      for (const record of kept) {
        expect(Object.keys(record).sort()).toEqual([
          "name",
          "required",
          "runId",
          "schemaVersion",
          "seq",
          "ts",
          "type",
        ]);
      }
      expect(writer.stats()).toMatchObject({ written: 2, failures: 11, rotations: 0 });
    });
  });

  it("never grows a generation past the configured cap, and refuses an unbounded one", async () => {
    const { createTraceWriter } = await traceModule();
    // The cap is the one number config and the writer both enforce, so neither side can widen it:
    // the config block refuses anything past the ceiling, so the writer does too.
    for (const maxBytes of [MAX_TRACE_MAX_BYTES + 1, Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY]) {
      expect(() => createTraceWriter({ enabled: true, root: "/nowhere", maxBytes })).toThrow(/maxBytes/);
    }
    // The three values `kernel/src/config.test.ts` proves the config block accepts. The writer takes
    // every one of them, so a resolved `trace.maxBytes` can never throw while a runtime is built.
    for (const maxBytes of [1, 4096, MAX_TRACE_MAX_BYTES]) {
      expect(() => createTraceWriter({ enabled: true, root: "/nowhere", maxBytes })).not.toThrow();
    }

    const cap = 4096;
    await withTraceWriter(
      async ({ file, root, rotated, writer }) => {
        // Enough records to cross the cap several times over the configured size.
        for (let step = 1; step <= 64; step += 1) {
          await expectAccepted(writer, { type: "run-step", steps: step });
          // Rotation happens before the write that would cross the cap, so no generation ever exceeds it.
          expect((await lstat(file)).size, `after step ${step}`).toBeLessThanOrEqual(cap);
        }
        expect(writer.stats().rotations).toBeGreaterThanOrEqual(1);
        // One generation of history, never a pile of them: an enabled log is bounded by two files.
        expect(await readdir(root)).toEqual(["trace.jsonl", "trace.jsonl.1"]);
        expect((await lstat(rotated)).size).toBeLessThanOrEqual(cap);
        expect(octal(await lstat(rotated))).toBe("600");
        expect(writer.stats().failures).toBe(0);
      },
      { maxBytes: cap },
    );
  });

  it("makes no network call over a whole lifecycle, including a rotation", async () => {
    await stubbedHome();
    const network = denyNetwork();
    try {
      await withTraceWriter(async ({ file, records, root, writer }) => {
        await mkdir(root, { recursive: true, mode: 0o700 });
        await fillTraceFile(file, capBytes);
        await chmod(file, 0o600);
        await expectAccepted(writer, { type: "run-start", provider: "mock", model: "mock" });
        await expectAccepted(writer, { type: "run-step", steps: 1 });
        // A refusal is part of the lifecycle too: it must not turn into a lookup or a retry loop.
        await expect(
          writer.append(smuggle<Parameters<TraceWriter["append"]>[0]>({ type: "run-step", steps: "no" })),
        ).resolves.toBe(false);
        expect(writer.stats()).toMatchObject({ written: 2, failures: 1, rotations: 1 });
        expect(await records()).toHaveLength(2);
      });
      expect(network.calls()).toBe(0);
    } finally {
      network.restore();
    }
  });

  it("writes only inside its own root: the repo user/data/config and the real home stay identical", async () => {
    const home = await stubbedHome();
    const before = await snapshotTrees(hostTrees());
    const repoListing = await readdir(repoRoot);
    const { createTraceWriter } = await traceModule();

    // The documented default: the user's own trace directory, beside the session store.
    const defaulted = createTraceWriter({ enabled: true });
    await expectAccepted(defaulted, { type: "run-start", provider: "mock", model: "mock" });
    await expectAccepted(defaulted, { type: "run-end", status: "completed", steps: 1, toolCalls: 0 });
    expect(defaulted.root).toBe(join(home, ".config", "nexus", "user", "traces"));
    expect(await readdir(defaulted.root)).toEqual(["trace.jsonl"]);

    // An explicit temp root beside it, so the same run also proves the two never share a byte.
    await withTraceWriter(async ({ root, writer }) => {
      await expectAccepted(writer, { type: "run-start", provider: "mock", model: "mock" });
      expect(root.startsWith(tmpdir())).toBe(true);
      expect(root.startsWith(defaulted.root)).toBe(false);
      expect(await readdir(defaulted.root)).toEqual(["trace.jsonl"]);
    });

    // The trace never lands in the developer's own trees, and never reads them either.
    expect(await snapshotTrees(hostTrees())).toEqual(before);
    expect(await readdir(repoRoot)).toEqual(repoListing);
    expect(defaulted.root.startsWith(repoRoot)).toBe(false);
    expect(defaulted.root.startsWith(join(repoRoot, "user"))).toBe(false);
  });
});
