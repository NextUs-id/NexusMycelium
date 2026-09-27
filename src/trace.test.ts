import { chmod, lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUDGET_TOKENS } from "../kernel/src/agent.js";
import { DEFAULT_TRACE_MAX_BYTES, MAX_TRACE_MAX_BYTES } from "../kernel/src/config.js";
import { fillTraceFile, stubbedHome, withTraceWriter } from "./trace.fixtures.js";
import {
  createTraceWriter,
  TRACE_FILE,
  TRACE_SCHEMA_VERSION,
  type TraceInput,
  traceRecordSchema,
} from "./trace.js";

/** Deliberate type-system bypass: the writer must reject these at runtime, not at compile time. */
const smuggle = <T>(value: unknown): T => value as T;

/** 1 MiB, the cap the writer rotates at when told nothing — the number `config.trace.maxBytes` defaults to. */
const fileCap = DEFAULT_TRACE_MAX_BYTES;

const octal = (stats: { mode: number }): string => (stats.mode & 0o777).toString(8);

const homes: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const home of homes.splice(0, homes.length)) await rm(home, { recursive: true, force: true });
});

async function tempHome(): Promise<string> {
  const home = await stubbedHome();
  homes.push(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  return home;
}

const start: TraceInput = { type: "run-start", provider: "openai", model: "gpt-4o-mini" };
const end: TraceInput = {
  type: "run-end",
  status: "stopped",
  steps: 4,
  toolCalls: 2,
  budgetReason: BUDGET_TOKENS,
  usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
};

describe("createTraceWriter", () => {
  it("writes nothing at all while disabled", async () => {
    await withTraceWriter(
      async ({ root, parent, file, bytes, writer }) => {
        expect(writer.enabled).toBe(false);
        expect(writer.root).toBe(root);

        await expect(writer.append(start)).resolves.toBe(false);
        await expect(
          writer.append(smuggle<TraceInput>({ type: "run-end", status: "error", steps: 0, toolCalls: 0 })),
        ).resolves.toBe(false);
        expect(writer.stats()).toEqual({ enabled: false, written: 0, failures: 0, rotations: 0 });

        // A disabled writer is not a quiet one: no directory, no file, not even a count for a bad record.
        expect(await readdir(parent)).toEqual([]);
        await expect(lstat(root)).rejects.toThrow();
        expect(await bytes()).toBe("");
        await expect(lstat(file)).rejects.toThrow();
      },
      { enabled: false },
    );
  });

  it("defaults to disabled when told nothing", async () => {
    const home = await tempHome();
    const writer = createTraceWriter();
    expect(writer.enabled).toBe(false);
    await expect(writer.append(start)).resolves.toBe(false);
    expect(await readdir(home)).toEqual([]);
  });

  it("defaults the root to HOME/.config/nexus/user/traces once enabled", async () => {
    const home = await tempHome();
    const writer = createTraceWriter({ enabled: true });
    expect(writer.root).toBe(join(home, ".config", "nexus", "user", "traces"));

    await expect(writer.append(start)).resolves.toBe(true);
    const file = join(home, ".config", "nexus", "user", "traces", TRACE_FILE);
    expect(octal(await lstat(file))).toBe("600");
    expect(octal(await lstat(join(home, ".config", "nexus", "user", "traces")))).toBe("700");
    expect(writer.stats().written).toBe(1);
  });
});

describe("append", () => {
  it("round-trips a run with monotonic sequence numbers", async () => {
    await withTraceWriter(async ({ writer, lines, records, bytes }) => {
      await expect(writer.append(start)).resolves.toBe(true);
      await expect(writer.append({ type: "run-step", steps: 1 })).resolves.toBe(true);
      await expect(writer.append(end)).resolves.toBe(true);

      const text = await bytes();
      expect(text.endsWith("\n")).toBe(true);
      expect(await lines()).toHaveLength(3);

      const written = await records();
      expect(written.map((record) => record.type)).toEqual(["run-start", "run-step", "run-end"]);
      expect(written.map((record) => record.seq)).toEqual([1, 2, 3]);
      for (const record of written) {
        expect(record.runId).toBe(written[0]?.runId);
        expect(record.runId).toMatch(/^[0-9a-f]{16}$/);
        expect(record.schemaVersion).toBe(1);
        expect(Number.isNaN(Date.parse(record.ts))).toBe(false);
        expect(record.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      }
      expect(written[0]).toMatchObject({ provider: "openai", model: "gpt-4o-mini" });
      expect(written[1]).toMatchObject({ steps: 1 });
      expect(written[2]).toMatchObject({
        status: "stopped",
        steps: 4,
        toolCalls: 2,
        budgetReason: BUDGET_TOKENS,
        usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
      });
      expect(writer.stats()).toEqual({ enabled: true, written: 3, failures: 0, rotations: 0 });
    });
  });

  it("gives two writers of one run their own run id and sequence", async () => {
    await withTraceWriter(async ({ writer, records }) => {
      const other = createTraceWriter({ enabled: true, root: writer.root });
      await writer.append(start);
      await other.append(start);

      const written = await records();
      expect(written).toHaveLength(2);
      expect(written[0]?.runId).not.toBe(written[1]?.runId);
      expect(written.map((record) => record.seq)).toEqual([1, 1]);
    });
  });

  it("strips control characters so a record never spans lines", async () => {
    await withTraceWriter(async ({ writer, records, lines }) => {
      await expect(
        writer.append(
          smuggle<TraceInput>({ type: "run-start", provider: "op\u0000en\nai\t", model: "gpt\u001b4" }),
        ),
      ).resolves.toBe(true);

      expect(await lines()).toHaveLength(1);
      expect(await records()).toMatchObject([{ provider: "openai", model: "gpt4" }]);
    });
  });

  it("refuses every field that is not a scalar the schema names", async () => {
    const forbidden = [
      { type: "run-start", provider: "openai", model: "gpt-4o-mini", task: "fix the failing test" },
      { type: "run-start", provider: "openai", model: "gpt-4o-mini", text: "done" },
      { type: "run-step", steps: 1, observations: ["read the file"] },
      { type: "run-step", steps: 1, arguments: { path: "/etc/shadow" } },
      { type: "run-end", status: "error", steps: 1, toolCalls: 0, path: "/home/dev/app" },
      { type: "run-end", status: "error", steps: 1, toolCalls: 0, config: { model: "gpt-4o-mini" } },
      { type: "run-end", status: "error", steps: 1, toolCalls: 0, env: { OPENAI_API_KEY: "sk-live" } },
      { type: "run-end", status: "error", steps: 1, toolCalls: 0, headers: { authorization: "Bearer x" } },
      { type: "run-end", status: "error", steps: 1, toolCalls: 0, usage: { inputTokens: 1, totalTokens: 1 } },
      {
        type: "run-end",
        status: "error",
        steps: 1,
        toolCalls: 0,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cost: 3 },
      },
      { type: "plugin-load", name: "tools-basic", required: true, error: "boom" },
      { type: "plugin-load-failed", name: "tools-core", required: false, path: "/plugins/tools-core" },
      { type: "plugin-load", name: "tools-basic", required: "true" },
      { type: "plugin-load", name: "/etc/shadow", required: false },
      { type: "plugin-load", name: "tools-basic" },
      { type: "plugin-unload", name: "tools-basic", required: true },
    ];

    for (const [index, input] of forbidden.entries()) {
      await withTraceWriter(async ({ writer, bytes }) => {
        await expect(writer.append(smuggle<TraceInput>(input)), `case ${index}`).resolves.toBe(false);
        expect(await bytes(), `case ${index}`).toBe("");
        expect(writer.stats(), `case ${index}`).toEqual({
          enabled: true,
          written: 0,
          failures: 1,
          rotations: 0,
        });
      });
    }
  });

  it("refuses a scalar that is a secret or a location, and keeps it off the disk", async () => {
    const leaks = [
      { provider: "sk-live-abcd1234efgh", model: "gpt-4o-mini" },
      { provider: "openai", model: "Bearer abcd1234efgh" },
      { provider: "openai", model: "api_key=abcd1234" },
      { provider: "/home/dev/.config/nexus", model: "gpt-4o-mini" },
      { provider: "openai", model: "~/secrets/model.bin" },
      { provider: "../../etc/passwd", model: "gpt-4o-mini" },
      { provider: "C:\\Users\\dev\\model.bin", model: "gpt-4o-mini" },
      { provider: "\u0000\u0001", model: "gpt-4o-mini" },
    ];

    for (const [index, scalars] of leaks.entries()) {
      await withTraceWriter(async ({ writer, bytes, file }) => {
        const written = await writer.append(smuggle<TraceInput>({ type: "run-start", ...scalars }));
        expect(written, `case ${index}`).toBe(false);
        const text = await bytes();
        expect(text, `case ${index}`).toBe("");
        // The refused value is not on disk in any shape, not even redacted, and no file was created.
        for (const value of Object.values(scalars)) {
          expect(text, `case ${index}`).not.toContain(value);
        }
        expect(text, `case ${index}`).not.toContain("[redacted]");
        await expect(lstat(file), `case ${index}`).rejects.toThrow();
        expect(writer.stats().failures).toBe(1);
      });
    }
  });

  it("counts every failure instead of throwing into the run", async () => {
    await withTraceWriter(async ({ root, outside, writer, file }) => {
      await mkdir(root, { recursive: true, mode: 0o700 });
      await mkdir(outside, { recursive: true, mode: 0o700 });
      const planted = join(outside, "planted.jsonl");
      await writeFile(planted, "untouched\n", "utf8");
      await symlink(planted, file);

      // lstat refuses the symlink before the open; O_NOFOLLOW is the backstop for a swap in between.
      await expect(writer.append(start)).resolves.toBe(false);
      await expect(writer.append(start)).resolves.toBe(false);
      expect(writer.stats()).toEqual({ enabled: true, written: 0, failures: 2, rotations: 0 });
      expect(await readFile(planted, "utf8")).toBe("untouched\n");
    });
  });

  it("refuses a dangling symlink, a directory, and a widened file at the trace path", async () => {
    await withTraceWriter(async ({ parent, root, writer, file }) => {
      await mkdir(root, { recursive: true, mode: 0o700 });
      await symlink(join(parent, "missing.jsonl"), file);
      await expect(writer.append(start)).resolves.toBe(false);

      await rm(file, { force: true });
      await mkdir(file, { recursive: true });
      await expect(writer.append(start)).resolves.toBe(false);

      await rm(file, { recursive: true, force: true });
      await writeFile(file, "someone else's line\n", { encoding: "utf8", mode: 0o600 });
      await chmod(file, 0o644);
      await expect(writer.append(start)).resolves.toBe(false);
      // A widened mode means the contents are already readable, so the writer stops and says so.
      expect(octal(await lstat(file))).toBe("644");
      expect(writer.stats().failures).toBe(3);
    });
  });

  it("keeps the root 0700 and the file 0600, tightening a loosened root", async () => {
    await withTraceWriter(async ({ root, file, writer }) => {
      await mkdir(root, { recursive: true, mode: 0o755 });
      await expect(writer.append(start)).resolves.toBe(true);
      expect(octal(await lstat(root))).toBe("700");
      expect(octal(await lstat(file))).toBe("600");

      await chmod(root, 0o777);
      await expect(writer.append({ type: "run-step", steps: 2 })).resolves.toBe(true);
      expect(octal(await lstat(root))).toBe("700");
    });
  });

  it("rotates one generation at the file cap", async () => {
    await withTraceWriter(async ({ root, file, rotated, writer, records, lines }) => {
      await mkdir(root, { recursive: true, mode: 0o700 });
      await writeFile(rotated, "an older generation\n", "utf8");
      const filled = await fillTraceFile(file, fileCap);
      expect(filled).toBeGreaterThanOrEqual(fileCap);

      await expect(writer.append(start)).resolves.toBe(true);
      expect(writer.stats().rotations).toBe(1);
      // The previous generation replaced the older one rather than stacking beside it.
      expect(await lstat(rotated).then((stats) => stats.size)).toBe(filled);
      expect(await readdir(root)).toEqual([TRACE_FILE, "trace.jsonl.1"]);
      expect(octal(await lstat(rotated))).toBe("600");
      expect(await lines()).toHaveLength(1);
      expect((await records())[0]?.type).toBe("run-start");
    });
  });

  it("rotates at the cap it was given, not at a constant of its own", async () => {
    await withTraceWriter(
      async ({ root, file, rotated, writer, records }) => {
        await mkdir(root, { recursive: true, mode: 0o700 });
        // Filled to exactly the cap. The record is ~130 bytes, so a 2 KiB cap rotates here and the
        // 1 MiB default would not: the rotation itself is the proof of which cap is in force.
        const filled = await fillTraceFile(file, 2048);
        expect(filled).toBeGreaterThanOrEqual(2048);
        await expect(writer.append(start)).resolves.toBe(true);
        expect(writer.stats()).toEqual({ enabled: true, written: 1, failures: 0, rotations: 1 });
        expect(await lstat(rotated).then((stats) => stats.size)).toBe(filled);

        // Still one generation: a second append into the fresh file does not rotate again, so the cap
        // did not collapse into a rotate-per-record.
        await expect(writer.append({ type: "run-step", steps: 1 })).resolves.toBe(true);
        expect(await lstat(file).then((stats) => stats.size)).toBeLessThan(2048);
        expect(await readdir(root)).toEqual([TRACE_FILE, "trace.jsonl.1"]);
        expect(await records()).toMatchObject([{ seq: 1 }, { seq: 2 }]);
        expect(writer.stats()).toMatchObject({ written: 2, rotations: 1 });
      },
      { maxBytes: 2048 },
    );
  });

  it("refuses a cap that is not a bounded whole number of bytes", () => {
    for (const maxBytes of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      MAX_TRACE_MAX_BYTES + 1,
      "4096",
      null,
    ]) {
      expect(() =>
        createTraceWriter({ enabled: true, root: "/nowhere", maxBytes: maxBytes as number }),
      ).toThrow(/maxBytes/);
    }
    // Both ends of the range are values, not fences: they are what `config.trace.maxBytes` accepts.
    for (const maxBytes of [1, DEFAULT_TRACE_MAX_BYTES, MAX_TRACE_MAX_BYTES]) {
      expect(() => createTraceWriter({ enabled: true, root: "/nowhere", maxBytes })).not.toThrow();
    }
  });

  it("stores a plugin outcome as a name and a boolean, and nothing else", async () => {
    await withTraceWriter(async ({ writer, records, lines }) => {
      await expect(writer.append({ type: "plugin-load", name: "tools-basic", required: true })).resolves.toBe(
        true,
      );
      await expect(
        writer.append({ type: "plugin-load-failed", name: "tools-core", required: false }),
      ).resolves.toBe(true);

      expect(await lines()).toHaveLength(2);
      const written = await records();
      expect(written).toMatchObject([
        { type: "plugin-load", name: "tools-basic", required: true, seq: 1 },
        { type: "plugin-load-failed", name: "tools-core", required: false, seq: 2 },
      ]);
      // The closed envelope plus the two fields, so there is no slot for a path, a version, or an error.
      for (const record of written) {
        expect(Object.keys(record).sort()).toEqual([
          "name",
          "required",
          "runId",
          "schemaVersion",
          "seq",
          "ts",
          "type",
        ]);
        expect(record.schemaVersion).toBe(TRACE_SCHEMA_VERSION);
        expect(record.runId).toBe(written[0]?.runId);
      }
      expect(writer.stats()).toEqual({ enabled: true, written: 2, failures: 0, rotations: 0 });
    });
  });

  it("refuses a plugin record that carries anything but a name and a boolean", async () => {
    const refused = [
      // The load error, its cause, and the manifest it came from are all text the log has no slot for.
      {
        type: "plugin-load-failed",
        name: "tools-core",
        required: false,
        error: "tools root is not a directory",
      },
      { type: "plugin-load-failed", name: "tools-core", required: false, cause: "ENOENT" },
      { type: "plugin-load", name: "tools-basic", required: true, path: "/plugins/tools-basic" },
      { type: "plugin-load", name: "tools-basic", required: true, manifest: { version: "1.0.0" } },
      { type: "plugin-load", name: "tools-basic", required: "true" },
      { type: "plugin-load", name: "tools-basic" },
      { type: "plugin-load", name: "", required: true },
      // A name is an identifier, so prose is not a name: the canonical kebab-case rule the plugin
      // API enforces is the same one the log applies.
      { type: "plugin-load", name: "tools root must be a directory", required: false },
      { type: "plugin-load", name: "tools_basic", required: true },
      // A name is a label, not a location and not a credential.
      { type: "plugin-load", name: "/plugins/tools-basic", required: true },
      { type: "plugin-load", name: "../tools-basic", required: true },
      { type: "plugin-load", name: "sk-live-0123456789abcdefghij", required: true },
      { type: "plugin-load", name: "token=abcd1234efgh", required: false },
    ];

    for (const [index, input] of refused.entries()) {
      await withTraceWriter(async ({ writer, bytes }) => {
        await expect(writer.append(smuggle<TraceInput>(input)), `case ${index}`).resolves.toBe(false);
        expect(await bytes(), `case ${index}`).toBe("");
        expect(writer.stats(), `case ${index}`).toEqual({
          enabled: true,
          written: 0,
          failures: 1,
          rotations: 0,
        });
      });
    }
  });

  it("serializes concurrent appends into whole lines in order", async () => {
    await withTraceWriter(async ({ writer, records, lines }) => {
      const appends = Array.from({ length: 64 }, (_unused, index) =>
        writer.append({ type: "run-step", steps: index + 1 }),
      );
      await expect(Promise.all(appends)).resolves.toEqual(Array.from({ length: 64 }, () => true));

      expect(await lines()).toHaveLength(64);
      const written = await records();
      expect(written.map((record) => record.seq)).toEqual(
        Array.from({ length: 64 }, (_u, index) => index + 1),
      );
      expect(written.map((record) => (record.type === "run-step" ? record.steps : -1))).toEqual(
        Array.from({ length: 64 }, (_unused, index) => index + 1),
      );
      expect(writer.stats()).toEqual({ enabled: true, written: 64, failures: 0, rotations: 0 });
    });
  });

  it("trims a torn tail instead of splicing onto it", async () => {
    await withTraceWriter(async ({ root, file, writer, records, lines }) => {
      await mkdir(root, { recursive: true, mode: 0o700 });
      await writeFile(file, '{"type":"run-step","schemaVer', { encoding: "utf8", mode: 0o600 });

      await expect(writer.append({ type: "run-step", steps: 7 })).resolves.toBe(true);
      expect(await lines()).toHaveLength(1);
      expect((await records())[0]).toMatchObject({ type: "run-step", steps: 7, seq: 1 });
    });
  });

  it("runs a whole lifecycle without any network access", async () => {
    const calls: string[] = [];
    const refuse =
      (name: string) =>
      async (input: unknown): Promise<never> => {
        calls.push(`${name}:${String(input)}`);
        throw new Error("trace writing must not perform network access");
      };
    vi.stubGlobal("fetch", refuse("fetch"));
    vi.stubGlobal("WebSocket", refuse("WebSocket"));

    await withTraceWriter(async ({ writer, records }) => {
      await writer.append(start);
      await writer.append({ type: "run-step", steps: 1 });
      await writer.append(end);
      expect((await records()).map((record) => record.type)).toEqual(["run-start", "run-step", "run-end"]);
      expect(writer.stats().written).toBe(3);
    });
    expect(calls).toEqual([]);
  });
});

describe("traceRecordSchema", () => {
  const valid = {
    type: "run-end",
    schemaVersion: 1,
    ts: new Date().toISOString(),
    seq: 1,
    runId: "0123456789abcdef",
    status: "completed",
    steps: 1,
    toolCalls: 0,
  } as const;

  const refusals: [string, unknown][] = [
    ["another schema version", { ...valid, schemaVersion: 2 }],
    ["a non-integer seq", { ...valid, seq: 1.5 }],
    ["a string seq", { ...valid, seq: "1" }],
    ["a negative step count", { ...valid, steps: -1 }],
    ["a run id that is not random hex", { ...valid, runId: "run-1" }],
    ["a timestamp that is not ISO", { ...valid, ts: "yesterday" }],
    ["an unknown status", { ...valid, status: "weird" }],
    ["an unknown budget reason", { ...valid, budgetReason: "budget:unknown" }],
    ["an unknown record type", { ...valid, type: "run-trace" }],
    ["an unknown key", { ...valid, task: "fix the failing test" }],
    ["an absolute path as a scalar", { ...valid, provider: "/etc/shadow" }],
    ["a secret as a scalar", { ...valid, model: "sk-live-abcd1234" }],
    ["negative usage", { ...valid, usage: { inputTokens: -1, outputTokens: 0, totalTokens: 0 } }],
    ["an over-long scalar", { ...valid, provider: "openai".repeat(64) }],
    ["a nested object where a count belongs", { ...valid, steps: { count: 1 } }],
    ["no type at all", { schemaVersion: 1, ts: valid.ts, seq: 1, runId: valid.runId }],
  ];

  const plugin = {
    type: "plugin-load",
    schemaVersion: 1,
    ts: valid.ts,
    seq: 1,
    runId: valid.runId,
    name: "tools-basic",
    required: true,
  };
  const pluginRefusals: [string, unknown][] = [
    ["the plugin name as a location", { ...plugin, name: "/plugins/tools-basic" }],
    ["the plugin name as a credential", { ...plugin, name: "sk-live-0123456789abcdefghij" }],
    ["a required flag that is not a boolean", { ...plugin, required: "true" }],
    ["a plugin load error", { ...plugin, error: "boom" }],
    ["a plugin manifest path", { ...plugin, path: "/plugins" }],
    ["a plugin name that is really a message", { ...plugin, name: "tools root must be a directory" }],
    ["a plugin name that is not canonical", { ...plugin, name: "tools_basic" }],
    [
      "no plugin name at all",
      { type: "plugin-load", schemaVersion: 1, ts: valid.ts, seq: 1, required: true },
    ],
    ["a plugin record of another type", { ...plugin, type: "plugin-unload" }],
  ];

  it("accepts a record the writer itself produces", () => {
    expect(traceRecordSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts a plugin outcome the host alone can know", () => {
    expect(traceRecordSchema.safeParse(plugin).success).toBe(true);
    expect(
      traceRecordSchema.safeParse({ ...plugin, type: "plugin-load-failed", required: false }).success,
    ).toBe(true);
  });

  for (const [label, candidate] of [...refusals, ...pluginRefusals]) {
    it(`refuses ${label}`, () => {
      expect(traceRecordSchema.safeParse(candidate).success).toBe(false);
    });
  }
});
