import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "../kernel/src/model.js";
import { seedRun } from "./session.fixtures.js";
import {
  createSessionStore,
  REDACTED,
  type RunStartInput,
  type SessionStore,
  sessionMessages,
} from "./session.js";

const permissionsSupported = process.platform !== "win32" && process.getuid?.() !== 0;
/** Deliberate type-system bypass: the store must reject these at runtime, not at compile time. */
const smuggle = <T>(value: object): T => value as T;

interface Boundary {
  store: SessionStore;
  parent: string;
  root: string;
  outside: string;
  file(sessionId: string): string;
}

const stubbedHomes: string[] = [];

/** A temp sessions root with a sibling `outside/` escape target, so nothing ever touches real user state. */
async function withBoundary(run: (boundary: Boundary) => Promise<void>): Promise<void> {
  const parent = await mkdtemp(join(tmpdir(), "nexus-session-sec-"));
  try {
    const root = join(parent, "sessions");
    const store = await createSessionStore({ root });
    await run({
      store,
      parent,
      root,
      outside: join(parent, "outside"),
      file: (id) => join(root, `${id}.jsonl`),
    });
  } finally {
    vi.unstubAllEnvs();
    for (const home of stubbedHomes.splice(0)) await rm(home, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
}

function only<T>(values: readonly T[], label: string): T {
  if (values.length !== 1) throw new Error(`expected exactly one ${label}, found ${values.length}`);
  const [value] = values;
  if (value === undefined) throw new Error(`missing ${label}`);
  return value;
}

/** A throwaway HOME, so any real user state stays unreachable. Cleaned up by `withBoundary`. */
async function stubbedHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "nexus-session-home-"));
  stubbedHomes.push(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  return home;
}

async function snapshot(path: string): Promise<{ bytes: string; size: number; mtimeMs: number }> {
  const [bytes, stats] = await Promise.all([readFile(path, "utf8"), lstat(path)]);
  return { bytes, size: stats.size, mtimeMs: stats.mtimeMs };
}

const octal = (stats: { mode: number }): string => (stats.mode & 0o777).toString(8);

describe("session store security contract", () => {
  it("confines a symlinked sessions root to its own real target", async () => {
    await withBoundary(async ({ parent, root, store }) => {
      await mkdir(root, { recursive: true });
      const alias = join(parent, "alias");
      await symlink(root, alias, "dir");
      const aliased = await createSessionStore({ root: alias });
      expect(aliased.root).toBe(alias);

      const id = await seedRun(aliased, "through the alias");
      const viaAlias = await snapshot(join(alias, `${id}.jsonl`));
      const viaRoot = await snapshot(join(root, `${id}.jsonl`));
      expect(viaAlias.bytes).toBe(viaRoot.bytes);
      expect(viaAlias.size).toBe(viaRoot.size);
      expect((await aliased.load(id)).map((record) => record.type)).toEqual([
        "run-start",
        "run-step",
        "run-step",
        "run-end",
      ]);
      expect(await readdir(parent)).toEqual(["alias", "sessions"]);

      // The store is bound to the id, not to the handle of one store object.
      await store.appendEnd(id, { status: "stopped" });
      expect((await aliased.load(id)).at(-1)).toMatchObject({ status: "stopped" });
    });
  });

  it("creates a symlinked sessions root whose target does not exist yet", async () => {
    await withBoundary(async ({ parent }) => {
      const alias = join(parent, "relocated");
      await symlink(join(parent, "not-created-yet"), alias, "dir");
      const relocated = await createSessionStore({ root: alias });
      const id = await relocated.appendStart({ provider: "mock", model: "mock", task: "relocated root" });
      expect(await readdir(parent)).toEqual(["not-created-yet", "relocated"]);
      expect((await readdir(join(parent, "not-created-yet"))).length).toBeGreaterThan(0);
      expect(await snapshot(join(alias, `${id}.jsonl`)).then((state) => state.size)).toBeGreaterThan(0);
    });
  });

  it("refuses a directory and a dangling symlink where a session file belongs", async () => {
    await withBoundary(async ({ root, outside, store }) => {
      await mkdir(outside, { recursive: true });
      const target = join(outside, "planted.jsonl");
      await writeFile(target, "", "utf8");

      await mkdir(join(root, "as-directory.jsonl"), { recursive: true });
      await expect(store.load("as-directory")).rejects.toThrow(/not a regular file/);
      await expect(store.appendStep("as-directory", { step: 1, messages: [] })).rejects.toThrow(
        /not a regular file/,
      );

      await symlink(target, join(root, "dangling.jsonl"));
      await expect(store.load("dangling")).rejects.toThrow();
      await expect(store.appendStep("dangling", { step: 1, messages: [] })).rejects.toThrow();
      expect(await readFile(target, "utf8")).toBe("");

      await symlink(join(outside, "missing.jsonl"), join(root, "broken.jsonl"));
      await expect(store.load("broken")).rejects.toThrow(/unknown session/);
      await expect(store.appendStep("broken", { step: 1, messages: [] })).rejects.toThrow();
      expect(await readdir(outside)).toEqual(["planted.jsonl"]);
    });
  });

  it.skipIf(!permissionsSupported)("refuses to load a session file others can read", async () => {
    await withBoundary(async ({ file, store }) => {
      const id = await seedRun(store);
      for (const mode of [0o644, 0o640, 0o604, 0o666, 0o777]) {
        await chmod(file(id), mode);
        await expect(store.load(id), `mode ${mode.toString(8)}`).rejects.toThrow(
          /mode|permission|private|not a regular file/i,
        );
        await expect(store.loadLatest()).rejects.toThrow(/mode|permission|private/i);
      }
      await chmod(file(id), 0o600);
      await expect(store.load(id)).resolves.toHaveLength(4);
    });
  });

  it("keeps new sessions private before any read happens", async () => {
    if (!permissionsSupported) return;
    await withBoundary(async ({ file, root, store }) => {
      const id = await seedRun(store);
      expect(octal(await lstat(root))).toBe("700");
      expect(octal(await lstat(file(id)))).toBe("600");
      const idOnly = await store.appendStart({ provider: "mock", model: "mock", task: "second" });
      expect(octal(await lstat(file(idOnly)))).toBe("600");
      const listed = await store.list();
      expect(listed.map((summary) => summary.id).sort()).toEqual([id, idOnly].sort());
      for (const summary of listed) {
        expect(summary.bytes).toBe((await lstat(file(summary.id))).size);
      }
    });
  });

  it("ignores hostile entries when listing and loading the sessions root", async () => {
    await withBoundary(async ({ root, outside, store }) => {
      const id = await seedRun(store);
      await writeFile(join(root, "notes.txt"), "not a session", "utf8");
      await writeFile(join(root, "a.b.jsonl"), "{}\n", "utf8");
      await writeFile(join(root, "..jsonl"), "{}\n", "utf8");
      await mkdir(join(root, "directory.jsonl"), { recursive: true });
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, "elsewhere.jsonl"), "{}\n", "utf8");
      await symlink(join(outside, "elsewhere.jsonl"), join(root, "linked.jsonl"));

      expect((await store.list()).map((summary) => summary.id)).toEqual([id]);
      expect(await store.loadLatest()).toMatchObject({ id });
      for (const name of ["notes", "a.b", "directory", "linked"]) {
        await expect(store.load(name), name).rejects.toThrow();
      }
      expect(await readFile(join(outside, "elsewhere.jsonl"), "utf8")).toBe("{}\n");
    });
  });

  it("leaves the session file byte-identical when an append is refused", async () => {
    await withBoundary(async ({ file, store }) => {
      const id = await seedRun(store);
      const before = await snapshot(file(id));
      const refusals: Promise<unknown>[] = [
        store.appendStep(id, { step: 0, messages: [] }),
        store.appendStep(id, {
          step: 3,
          messages: smuggle<ModelMessage[]>([{ role: "root", content: "x" }]),
        }),
        store.appendStep(id, {
          step: 3,
          messages: smuggle<ModelMessage[]>([{ role: "user", content: "x", x: 1 }]),
        }),
        store.appendStep(id, { step: 3, messages: [{ role: "user", content: "x".repeat(64 * 1024 + 1) }] }),
        store.appendEnd(id, { status: "unknown" as "completed" }),
        store.appendEnd(id, { status: "completed", limits: { maxSteps: -1 } }),
        store.appendStep("../escape", { step: 3, messages: [] }),
      ];
      for (const refusal of refusals) {
        await expect(refusal).rejects.toThrow();
      }
      expect(await snapshot(file(id))).toEqual(before);
      expect((await store.load(id)).map((record) => record.type)).toEqual([
        "run-start",
        "run-step",
        "run-step",
        "run-end",
      ]);
    });
  });

  it("accepts a record just under the byte cap and refuses one past it", async () => {
    await withBoundary(async ({ file, store }) => {
      const id = await store.appendStart({ provider: "mock", model: "mock", task: "large but legal" });
      const legal = Array.from({ length: 190 }, (_unused, index) => ({
        role: "user" as const,
        content: `${index}:${"x".repeat(20_000)}`,
      }));
      await store.appendStep(id, { step: 1, messages: legal });
      const after = await snapshot(file(id));
      expect(after.size).toBeLessThan(4 * 1024 * 1024);
      const loaded = await store.load(id);
      expect(loaded).toHaveLength(2);
      expect(sessionMessages(loaded)).toHaveLength(190);
      expect(sessionMessages(loaded)[0]?.content).toBe(`0:${"x".repeat(20_000)}`);

      const oversized = Array.from({ length: 200 }, () => ({
        role: "user" as const,
        content: "y".repeat(64 * 1024),
      }));
      await expect(store.appendStep(id, { step: 2, messages: oversized })).rejects.toThrow(
        /exceeds 4194304 bytes/,
      );
      expect(await snapshot(file(id))).toEqual(after);
    });
  });

  it("caps tool calls, argument entries, and redaction depth in stored tool calls", async () => {
    await withBoundary(async ({ file, store }) => {
      const id = await seedRun(store);
      const tooManyCalls = Array.from({ length: 33 }, (_unused, index) => ({
        id: `call-${index}`,
        name: "shell",
        arguments: { command: "true" },
      }));
      await expect(
        store.appendStep(id, {
          step: 3,
          messages: [{ role: "assistant", content: "many", toolCalls: tooManyCalls }],
        }),
      ).rejects.toThrow(/invalid run step/);

      const wideArguments = Object.fromEntries(
        Array.from({ length: 65 }, (_unused, index) => [`key-${index}`, index]),
      );
      await store.appendStep(id, {
        step: 3,
        messages: [
          {
            role: "assistant",
            content: "capped",
            toolCalls: [
              { id: "wide", name: "shell", arguments: wideArguments },
              {
                id: "keys",
                name: "shell",
                arguments: {
                  ["__proto__"]: { polluted: true },
                  prototype: { polluted: true },
                  constructor: { polluted: true },
                  kept: "yes",
                },
              },
              {
                id: "deep",
                name: "shell",
                arguments: {
                  shallow: { l1: { l2: { l3: { l4: { l5: "kept" } } } } },
                  beyond: { l1: { l2: { l3: { l4: { l5: { l6: "buried-value" } } } } } },
                },
              },
            ],
          },
        ],
      });

      const written = await readFile(file(id), "utf8");
      expect(written).not.toContain("__proto__");
      expect(written).not.toContain("buried-value");
      expect(written).not.toContain("prototype");
      expect(written).not.toContain("constructor");
      expect(smuggle<Record<string, unknown>>({}).polluted).toBeUndefined();

      const steps = (await store.load(id)).filter((record) => record.type === "run-step");
      const lastStep = only(steps.slice(-1), "run step holding the tool calls");
      const calls = sessionMessages([lastStep])[0]?.toolCalls ?? [];
      expect(calls).toHaveLength(3);
      expect(Object.keys(calls[0]?.arguments ?? {})).toHaveLength(64);
      expect(calls[0]?.arguments?.["key-0"]).toBe(0);
      expect(calls[0]?.arguments?.["key-64"]).toBeUndefined();
      expect(calls[1]?.arguments).toEqual({ kept: "yes" });
      expect(JSON.stringify(calls[2]?.arguments)).toContain("kept");
      expect(JSON.stringify(calls[2]?.arguments)).toContain(REDACTED);
    });
  });

  it("never persists provider config, secret paths, or headers in the record envelope", async () => {
    await withBoundary(async ({ root, store }) => {
      const home = await stubbedHome();
      const keyFile = join(home, ".config", "nexus", "user", "secrets", "provider.key");
      await mkdir(join(home, ".config", "nexus", "user", "secrets"), { recursive: true });
      await writeFile(keyFile, "dummy-key\n", "utf8");
      const bearer = "Bearer eyJhbGciOiJIUzI1NiJ9.dGVzdC1wYXlsb2Fk.c2ln";
      const sk = "sk-live-0123456789abcdefghij";

      const id = await store.appendStart(
        smuggle<RunStartInput>({
          provider: "openai",
          model: "gpt-4o-mini",
          task: `rotate ${sk} for ${keyFile}`,
          apiKeyFile: keyFile,
          config: { home, root },
          headers: { authorization: bearer },
        }),
      );
      await store.appendStep(id, {
        step: 1,
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: "calling a tool",
            toolCalls: [{ id: "c1", name: "shell", arguments: { command: `curl ${sk}` } }],
          },
        ],
      });
      await store.appendEnd(id, { status: "error", error: `provider rejected ${bearer}` });

      const written = await readFile(join(root, `${id}.jsonl`), "utf8");
      const envelope = written
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .map((record) => JSON.stringify(Object.keys(record).sort()))
        .join(" ");
      // The envelope is a closed shape: no configuration, credential, or location field can be stored.
      for (const forbidden of ["apiKeyFile", "config", "headers", "home", "root", "path", "cwd", "env"]) {
        expect(envelope, `record envelope must not carry ${forbidden}`).not.toContain(forbidden);
      }
      for (const secret of [bearer, "eyJhbGciOiJIUzI1NiJ9", sk]) {
        expect(written, `persisted record must not contain ${secret}`).not.toContain(secret);
      }
      expect(written).toContain(REDACTED);
      expect(store.root.startsWith(home)).toBe(false);

      // Free text is the user's own transcript, so paths survive there; only secrets are scrubbed.
      const [start] = await store.load(id);
      expect(start).toMatchObject({ task: `rotate ${REDACTED} for ${keyFile}` });
    });
  });

  it("keeps secret paths and absolute locations out of stored tool-call arguments", async () => {
    await withBoundary(async ({ root, store }) => {
      const home = await stubbedHome();
      const keyFile = join(home, ".config", "nexus", "user", "secrets", "provider.key");
      const id = await store.appendStart({ provider: "mock", model: "mock", task: "structured tool input" });
      await store.appendStep(id, {
        step: 1,
        messages: [
          {
            role: "assistant",
            content: "calling a tool",
            toolCalls: [
              {
                id: "c1",
                name: "shell",
                arguments: { apiKeyFile: keyFile, home, root, cwd: root, env: { HOME: home } },
              },
            ],
          },
        ],
      });

      const written = await readFile(join(root, `${id}.jsonl`), "utf8");
      for (const location of [keyFile, home, root, "apiKeyFile", "HOME"]) {
        expect(written, `persisted arguments must not contain ${location}`).not.toContain(location);
      }
      const steps = (await store.load(id)).filter((record) => record.type === "run-step");
      const toolArguments = only(sessionMessages([only(steps.slice(-1), "run step")]), "step message")
        .toolCalls?.[0]?.arguments;
      expect(toolArguments).toEqual({});
    });
  });

  it("forks only the steps up to atStep and never rewrites the source file", async () => {
    await withBoundary(async ({ file, store }) => {
      const source = await seedRun(store, "fix the failing test");
      const before = await snapshot(file(source));
      const target = await store.fork(source, 1);
      expect(target).not.toBe(source);
      expect(await snapshot(file(source))).toEqual(before);

      const forked = await store.load(target);
      expect(forked[0]).toMatchObject({ parent: { sessionId: source, step: 1 }, sessionId: target });
      expect(sessionMessages(forked).map((message) => message.content)).toEqual(["fix the failing test"]);
      expect(await readFile(file(source), "utf8")).toBe(before.bytes);

      await expect(store.fork(source, 0)).rejects.toThrow(/has no step 0/);
      await expect(store.fork(source, 99)).rejects.toThrow(/has no step 99/);
      await expect(store.fork(source, 1, "../escape")).rejects.toThrow(/invalid session id/);
      expect(await snapshot(file(source))).toEqual(before);
    });
  });

  it("keeps two forks of one source independent", async () => {
    await withBoundary(async ({ file, store }) => {
      const source = await seedRun(store, "shared history");
      const before = await snapshot(file(source));
      const [left, right] = await Promise.all([store.fork(source, 2), store.fork(source, 1)]);
      expect(left).not.toBe(right);
      expect(left).not.toBe(source);
      expect(right).not.toBe(source);
      expect(sessionMessages(await store.load(left))).toHaveLength(2);
      expect(sessionMessages(await store.load(right))).toHaveLength(1);

      await store.appendStep(left, { step: 3, messages: [{ role: "user", content: "left only" }] });
      await store.appendEnd(right, { status: "stopped", text: "right only" });
      expect(await readFile(file(right), "utf8")).not.toContain("left only");
      expect(await readFile(file(left), "utf8")).not.toContain("right only");
      expect(await readFile(file(source), "utf8")).toBe(before.bytes);
      expect(await store.load(source)).toHaveLength(4);
    });
  });

  it("repairs a torn tail on appendStep and keeps the session listed", async () => {
    await withBoundary(async ({ file, root, store }) => {
      const id = await seedRun(store);
      const whole = await readFile(file(id), "utf8");
      const lastNewline = whole.lastIndexOf("\n", whole.length - 2);
      await writeFile(file(id), `${whole}{"type":"run-step","sessionId":"${id}","step":3,"messa`, "utf8");

      expect((await store.load(id)).map((record) => record.type)).toEqual([
        "run-start",
        "run-step",
        "run-step",
        "run-end",
      ]);
      expect((await store.list()).map((summary) => summary.id)).toEqual([id]);
      expect(await store.loadLatest()).toMatchObject({ id });

      await store.appendStep(id, { step: 3, messages: [{ role: "user", content: "after the tear" }] });
      const repaired = await readFile(file(id), "utf8");
      expect(repaired.endsWith("\n")).toBe(true);
      expect(repaired.startsWith(whole.slice(0, lastNewline + 1))).toBe(true);
      expect(repaired).not.toContain('"messa"');
      expect((await store.load(id)).map((record) => record.type)).toEqual([
        "run-start",
        "run-step",
        "run-step",
        "run-end",
        "run-step",
      ]);
      expect(await readdir(root)).toEqual([`${id}.jsonl`]);
    });
  });

  it("neither interleaves nor loses records under concurrent appends", async () => {
    await withBoundary(async ({ file, store }) => {
      const id = await store.appendStart({ provider: "mock", model: "mock", task: "concurrent" });
      const appends = Array.from({ length: 24 }, (_unused, index) =>
        store.appendStep(id, { step: index + 1, messages: [{ role: "user", content: `step-${index + 1}` }] }),
      );
      await expect(Promise.all(appends)).resolves.toHaveLength(24);

      const written = await readFile(file(id), "utf8");
      expect(written.endsWith("\n")).toBe(true);
      const lines = written.split("\n");
      expect(lines.at(-1)).toBe("");
      for (const line of lines.slice(0, -1)) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
      const records = await store.load(id);
      expect(records).toHaveLength(25);
      expect(
        sessionMessages(records)
          .map((message) => message.content)
          .sort(),
      ).toEqual(Array.from({ length: 24 }, (_unused, index) => `step-${index + 1}`).sort());
    });
  });

  it("runs the whole lifecycle without any live network access", async () => {
    const calls: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      calls.push(String(input));
      throw new Error("session storage must not perform network access");
    };
    vi.stubGlobal("fetch", fetcher);
    try {
      await withBoundary(async ({ store }) => {
        const source = await seedRun(store, "offline only");
        const forked = await store.fork(source, 2);
        await store.appendStep(forked, { step: 3, messages: [{ role: "user", content: "still offline" }] });
        await store.appendEnd(forked, { status: "completed", text: "done" });
        expect((await store.list()).map((summary) => summary.id).sort()).toEqual([forked, source].sort());
        expect(await store.loadLatest()).toBeDefined();
        expect(calls).toEqual([]);
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
