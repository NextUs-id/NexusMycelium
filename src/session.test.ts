import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "../kernel/src/model.js";
import { seedRun, withSessionStore } from "./session.fixtures.js";
import { createSessionStore, REDACTED, type RunStartInput, sessionMessages } from "./session.js";

const permissionsSupported = process.platform !== "win32" && process.getuid?.() !== 0;
const mode = (stats: { mode: number }): string => (stats.mode & 0o777).toString(8);
/** Deliberate type-system bypass: the store must reject these at runtime, not at compile time. */
const smuggle = <T>(value: object): T => value as T;

describe("session store", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("round trips a run as append-only JSONL", async () => {
    await withSessionStore(async ({ store, bytes }) => {
      const id = await seedRun(store, "write the report");
      const records = await store.load(id);
      expect(records.map((record) => record.type)).toEqual(["run-start", "run-step", "run-step", "run-end"]);
      expect(records[0]).toMatchObject({
        schemaVersion: 1,
        sessionId: id,
        provider: "mock",
        model: "mock",
        task: "write the report",
      });
      expect(sessionMessages(records)).toEqual([
        { role: "user", content: "write the report" },
        { role: "assistant", content: "done" },
      ]);
      expect(records.at(-1)).toMatchObject({ status: "completed", text: "done", limits: { maxSteps: 8 } });
      const lines = (await bytes(id)).split("\n");
      expect(lines.at(-1)).toBe("");
      expect(lines.slice(0, -1).map((line) => JSON.parse(line).type)).toEqual([
        "run-start",
        "run-step",
        "run-step",
        "run-end",
      ]);
    });
  });

  it("lists sessions newest first and loads the latest history", async () => {
    await withSessionStore(async ({ store, root }) => {
      await seedRun(store, "first");
      const second = await seedRun(store, "second");
      const listed = await store.list();
      expect(listed).toHaveLength(2);
      expect(listed[0]?.id).toBe(second);
      expect(listed[0]?.bytes).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(listed[0]?.updatedAt ?? ""))).toBe(false);
      const latest = await store.loadLatest();
      expect(latest?.id).toBe(second);
      expect(sessionMessages(latest?.records ?? []).at(-1)?.content).toBe("done");
      expect(await readdir(root)).toHaveLength(2);
    });
  });

  it("recovers from a torn tail but rejects corruption in the middle", async () => {
    await withSessionStore(async ({ store, file, bytes }) => {
      const id = await seedRun(store);
      const whole = await bytes(id);
      await writeFile(file(id), `${whole}{"type":"run-step","sessionId":"${id}","step":3,"messa`, "utf8");
      expect((await store.load(id)).map((record) => record.type)).toEqual([
        "run-start",
        "run-step",
        "run-step",
        "run-end",
      ]);
      // The next append repairs the file, so torn bytes never harden into a permanent mid-file hole.
      await store.appendEnd(id, { status: "error", error: "crashed" });
      expect((await bytes(id)).endsWith("\n")).toBe(true);
      expect((await store.load(id)).map((record) => record.type)).toEqual([
        "run-start",
        "run-step",
        "run-step",
        "run-end",
        "run-end",
      ]);
      const [first = "", second = ""] = (await bytes(id)).split("\n");
      await writeFile(file(id), `${first}\nnot-json\n${second}\n`, "utf8");
      await expect(store.load(id)).rejects.toThrow(/corrupt session record at line 2/);
    });
  });

  it("rejects an unknown schema version, an unknown key, and a foreign session id", async () => {
    await withSessionStore(async ({ store, file, bytes }) => {
      const id = await seedRun(store);
      const [start = ""] = (await bytes(id)).split("\n");
      const record = JSON.parse(start) as Record<string, unknown>;
      const write = (value: unknown) => writeFile(file(id), `${JSON.stringify(value)}\n`, "utf8");
      await write({ ...record, schemaVersion: 2 });
      await expect(store.load(id)).rejects.toThrow(/schemaVersion/);
      await write({ ...record, config: { apiKeyFile: "user/secrets/k" } });
      await expect(store.load(id)).rejects.toThrow(/unrecognized key/i);
      await write({ ...record, headers: { authorization: "Bearer x" } });
      await expect(store.load(id)).rejects.toThrow(/unrecognized key/i);
      await write({ ...record, apiKeyFile: "/home/dana/.config/nexus/user/secrets/provider.key" });
      await expect(store.load(id)).rejects.toThrow(/unrecognized key/i);
      await write({ ...record, ["__proto__"]: { polluted: true } });
      await expect(store.load(id)).rejects.toThrow(/unrecognized key/i);
      await write({ ...record, sessionId: "other" });
      await expect(store.load(id)).rejects.toThrow(/claims other inside/);
      await write({ type: "run-done" });
      await expect(store.load(id)).rejects.toThrow(/invalid session record/);
      expect(smuggle<Record<string, unknown>>({}).polluted).toBeUndefined();
    });
  });

  it("never persists provider config, secret paths, or headers", async () => {
    await withSessionStore(async ({ store, bytes }) => {
      const id = await store.appendStart(
        smuggle<RunStartInput>({
          provider: "openai",
          model: "gpt-4o-mini",
          task: "run it",
          apiKeyFile: "/home/dana/.config/nexus/user/secrets/provider.key",
          config: { headers: { authorization: "Bearer sk-abcdef123456" } },
        }),
      );
      await store.appendStep(id, { step: 1, messages: [{ role: "user", content: "run it" }] });
      const written = await bytes(id);
      expect(written).not.toContain("apiKeyFile");
      expect(written).not.toContain("authorization");
      expect(written).not.toContain("/home/dana");
      // The start record is an allowlist of fields, so a smuggled key is dropped; a step message is
      // validated instead, so the same smuggling is refused outright.
      await expect(
        store.appendStep(id, {
          step: 2,
          messages: smuggle<ModelMessage[]>([{ role: "user", content: "again", apiKeyFile: "leaked" }]),
        }),
      ).rejects.toThrow(/unrecognized key/i);
      expect(await bytes(id)).toBe(written);
    });
  });

  it("rejects traversal, absolute, and control-character session ids", async () => {
    const base = await mkdtemp(join(tmpdir(), "nexus-session-ids-"));
    try {
      const root = join(base, "sessions");
      const store = await createSessionStore({ root });
      for (const id of [
        "",
        ".",
        "..",
        "../escape",
        "../../etc/passwd",
        "/etc/passwd",
        "sub/dir",
        "a\0b",
        "a\nb",
        "a b",
        "a.b",
        "x".repeat(65),
      ]) {
        await expect(store.load(id)).rejects.toThrow(/invalid session id/);
        await expect(store.appendStep(id, { step: 1, messages: [] })).rejects.toThrow(/invalid session id/);
        await expect(store.appendEnd(id, { status: "completed" })).rejects.toThrow(/invalid session id/);
        await expect(
          store.appendStart({ sessionId: id, provider: "mock", model: "mock", task: "t" }),
        ).rejects.toThrow(/invalid session id/);
      }
      // Nothing was created: a rejected id never reaches mkdir, let alone the filesystem.
      expect(await readdir(base)).toEqual([]);
      const valid = await store.appendStart({ provider: "mock", model: "mock", task: "t" });
      expect(await readdir(base)).toEqual(["sessions"]);
      expect(await readdir(join(base, "sessions"))).toEqual([`${valid}.jsonl`]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("refuses a session path that leaves the root through a symlink", async () => {
    const base = await mkdtemp(join(tmpdir(), "nexus-session-link-"));
    try {
      const root = join(base, "sessions");
      const outside = join(base, "outside.jsonl");
      await writeFile(outside, "", "utf8");
      const store = await createSessionStore({ root });
      await seedRun(store);
      await symlink(outside, join(root, "escape.jsonl"));
      // Read resolves the link and refuses containment; a write refuses the link itself via lstat.
      await expect(store.load("escape")).rejects.toThrow(/escapes the sessions root through a symlink/);
      await expect(store.appendStep("escape", { step: 3, messages: [] })).rejects.toThrow(
        /not a regular file/,
      );
      expect(await readFile(outside, "utf8")).toBe("");
      expect(await readdir(base)).toEqual(["outside.jsonl", "sessions"]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("redacts obvious secrets from the task, transcript, tool arguments, and result", async () => {
    await withSessionStore(async ({ store, bytes }) => {
      const id = await store.appendStart({
        provider: "openai",
        model: "gpt-4o-mini",
        task: "deploy with sk-proj-abcdef0123456789",
      });
      await store.appendStep(id, {
        step: 1,
        messages: [
          { role: "user", content: "use Bearer ya29.A0ARrdaM9le-token-value" },
          {
            role: "assistant",
            content: "calling a tool",
            toolCalls: [
              {
                id: "call-1",
                name: "shell",
                arguments: {
                  command: "curl -H 'Authorization: Bearer sk-live-0123456789abcdef'",
                  ["__proto__"]: { x: 1 },
                },
              },
            ],
          },
        ],
      });
      await store.appendEnd(id, { status: "error", error: "provider rejected sk-proj-abcdef0123456789" });
      const written = await bytes(id);
      for (const secret of [
        "sk-proj-abcdef0123456789",
        "ya29.A0ARrdaM9le-token-value",
        "sk-live-0123456789abcdef",
      ]) {
        expect(written).not.toContain(secret);
      }
      expect(written).toContain(REDACTED);
      expect(written).not.toContain("__proto__");
      const records = await store.load(id);
      const [start, , end] = records;
      expect(start).toMatchObject({ task: `deploy with ${REDACTED}` });
      expect(sessionMessages(records)[0]?.content).toBe(`use Bearer ${REDACTED}`);
      expect(end).toMatchObject({ error: `provider rejected ${REDACTED}` });
      const assistant = sessionMessages(records)[1];
      expect(JSON.stringify(assistant?.toolCalls)).not.toContain("sk-live");
      expect(smuggle<Record<string, unknown>>({}).x).toBeUndefined();
    });
  });

  it("caps field and record sizes", async () => {
    await withSessionStore(async ({ store }) => {
      const id = await store.appendStart({ provider: "mock", model: "mock", task: "big" });
      await expect(
        store.appendStep(id, { step: 1, messages: [{ role: "user", content: "x".repeat(64 * 1024 + 1) }] }),
      ).rejects.toThrow(/invalid run step/);
      await expect(
        store.appendStep(id, {
          step: 1,
          messages: Array.from({ length: 70 }, () => ({
            role: "user" as const,
            content: "x".repeat(64 * 1024),
          })),
        }),
      ).rejects.toThrow(/exceeds 4194304 bytes/);
      await expect(store.appendStep(id, { step: 0, messages: [] })).rejects.toThrow(/invalid run step/);
      await expect(
        store.appendStep(id, {
          step: 1,
          messages: smuggle<ModelMessage[]>([{ role: "user", content: "x", x: 1 }]),
        }),
      ).rejects.toThrow(/unrecognized key/i);
      expect(await store.load(id)).toHaveLength(1);
    });
  });

  it("forks at a step, leaves the source byte-immutable, and keeps appends independent", async () => {
    await withSessionStore(async ({ store, file, bytes }) => {
      const source = await seedRun(store, "fix the failing test");
      const before = await lstat(file(source));
      const target = await store.fork(source, 1);
      expect(target).not.toBe(source);
      const after = await lstat(file(source));
      expect(after.size).toBe(before.size);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(await bytes(source)).toContain('"step":2');

      const forked = await store.load(target);
      expect(forked[0]).toMatchObject({
        type: "run-start",
        sessionId: target,
        parent: { sessionId: source, step: 1 },
      });
      expect(forked.map((record) => record.type)).toEqual(["run-start", "run-step"]);

      await store.appendStep(target, { step: 2, messages: [{ role: "user", content: "other branch" }] });
      await store.appendEnd(target, { status: "stopped", text: "branch stopped" });
      expect((await store.load(target)).map((record) => record.type)).toEqual([
        "run-start",
        "run-step",
        "run-step",
        "run-end",
      ]);
      expect((await store.load(source)).map((record) => record.type)).toEqual([
        "run-start",
        "run-step",
        "run-step",
        "run-end",
      ]);
      expect(await bytes(source)).not.toContain("other branch");

      await expect(store.fork(source, 7)).rejects.toThrow(/has no step 7/);
      await expect(store.fork(source, 1, source)).rejects.toThrow(/must differ/);
      await expect(store.fork(source, 1, "../escape")).rejects.toThrow(/invalid session id/);
      await expect(store.fork("missing", 1)).rejects.toThrow(/unknown session/);
    });
  });

  it.skipIf(!permissionsSupported)("keeps the store at 0700 and its files at 0600", async () => {
    const base = await mkdtemp(join(tmpdir(), "nexus-session-mode-"));
    try {
      const root = join(base, "sessions");
      await mkdir(root, { recursive: true, mode: 0o755 });
      await chmod(root, 0o755);
      const store = await createSessionStore({ root });
      const id = await seedRun(store);
      expect(mode(await lstat(root))).toBe("700");
      expect(mode(await lstat(join(root, `${id}.jsonl`)))).toBe("600");
      await chmod(join(root, `${id}.jsonl`), 0o644);
      await store.appendEnd(id, { status: "completed", text: "tightened" });
      expect(mode(await lstat(join(root, `${id}.jsonl`)))).toBe("600");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("defaults to the secure home scope, never the repo data mount", async () => {
    const home = await mkdtemp(join(tmpdir(), "nexus-session-home-"));
    try {
      vi.stubEnv("HOME", home);
      vi.stubEnv("USERPROFILE", home);
      const store = await createSessionStore();
      const expected = resolve(home, ".config", "nexus", "user", "sessions");
      expect(store.root).toBe(expected);
      expect(store.root.startsWith(resolve(process.cwd(), "data"))).toBe(false);
      expect(await store.list()).toEqual([]);
      expect(await store.loadLatest()).toBeUndefined();

      const id = await seedRun(store, "resume me later");
      expect((await readdir(expected)).length).toBeGreaterThan(0);
      if (permissionsSupported) {
        expect(mode(await lstat(expected))).toBe("700");
        expect(mode(await lstat(join(expected, `${id}.jsonl`)))).toBe("600");
      }
      const latest = await store.loadLatest();
      expect(latest?.id).toBe(id);
      expect(latest?.records).toHaveLength(4);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
