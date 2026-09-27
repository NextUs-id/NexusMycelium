import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { ConfigSchema, pluginConfig, resolveConfig } from "./config.js";

async function configuredRoot(defaults = "model:\n  provider: mock\n"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nexus-kernel-config-"));
  await mkdir(join(root, "config"), { recursive: true });
  await writeFile(join(root, "config", "default.yaml"), defaults, "utf8");
  return root;
}

async function fakeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "nexus-kernel-home-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  return home;
}

const configOptions = { defaultsPath: "config/default.yaml", userPath: "user.yaml" };

describe("kernel config path boundary", () => {
  it("canonicalizes relative secret paths against the runtime root", async () => {
    const root = await configuredRoot();
    try {
      await writeFile(join(root, "user.yaml"), "model:\n  apiKeyFile: user/secrets/provider.key\n", "utf8");
      const config = await resolveConfig(root, {
        defaultsPath: "config/default.yaml",
        userPath: "user.yaml",
      });
      expect(config.model.apiKeyFile).toBe(join(root, "user/secrets/provider.key"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects traversal and parent symlink escapes", async () => {
    const root = await configuredRoot();
    const outside = await mkdtemp(join(tmpdir(), "nexus-kernel-outside-"));
    try {
      await writeFile(join(root, "user.yaml"), "model:\n  apiKeyFile: user/secrets/../key\n", "utf8");
      await expect(
        resolveConfig(root, { defaultsPath: "config/default.yaml", userPath: "user.yaml" }),
      ).rejects.toThrow(/apiKeyFile/);

      await writeFile(join(root, "user.yaml"), "model:\n  provider: mock\n", "utf8");
      await symlink(outside, join(root, "user"), "dir");
      await expect(
        resolveConfig(root, { defaultsPath: "config/default.yaml", userPath: "user/config.yaml" }),
      ).rejects.toThrow(/symlink/);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects a secret symlink escape", async () => {
    const root = await configuredRoot();
    const outside = await mkdtemp(join(tmpdir(), "nexus-kernel-secret-outside-"));
    try {
      await mkdir(join(root, "user"), { recursive: true });
      await symlink(outside, join(root, "user", "secrets"), "dir");
      await writeFile(join(root, "user.yaml"), "model:\n  apiKeyFile: user/secrets/key\n", "utf8");
      await expect(
        resolveConfig(root, { defaultsPath: "config/default.yaml", userPath: "user.yaml" }),
      ).rejects.toThrow(/symlink/);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("retains the approved home user secret scope without reading it", async () => {
    const root = await configuredRoot();
    const home = await fakeHome();
    const homeSecret = join(home, ".config", "nexus", "user", "secrets", "9router.key");
    try {
      await writeFile(join(root, "user.yaml"), `model:\n  apiKeyFile: ${homeSecret}\n`, "utf8");
      const config = await resolveConfig(root, configOptions);
      expect(config.model.apiKeyFile).toBe(homeSecret);
      expect(config.runtimeUserRoot).toBe(join(root, "user"));
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects a fake absolute user path that only looks like the user scope", async () => {
    const root = await configuredRoot();
    const home = await fakeHome();
    const fake = await mkdtemp(join(tmpdir(), "nexus-kernel-fake-"));
    try {
      const fakeSecret = join(fake, "user", "secrets", "9router.key");
      await writeFile(join(root, "user.yaml"), `model:\n  apiKeyFile: ${fakeSecret}\n`, "utf8");
      await expect(resolveConfig(root, configOptions)).rejects.toThrow(
        /apiKeyFile must be under the approved user scope/,
      );
      await writeFile(join(root, "user.yaml"), "model:\n  provider: mock\n", "utf8");
      const config = await resolveConfig(root, configOptions);
      expect(config.model.apiKeyFile).toBeUndefined();
      expect(fakeSecret).toMatch(/\/user\/secrets\//);
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
      await rm(fake, { recursive: true, force: true });
    }
  });

  it("rejects absolute traversal out of the home user scope", async () => {
    const root = await configuredRoot();
    const home = await fakeHome();
    try {
      const scope = join(home, ".config", "nexus", "user", "secrets");
      for (const candidate of [`${scope}/../secrets/key`, `${scope}/../../escape.key`]) {
        await writeFile(join(root, "user.yaml"), `model:\n  apiKeyFile: ${candidate}\n`, "utf8");
        await expect(resolveConfig(root, configOptions)).rejects.toThrow(/apiKeyFile/);
      }
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects a home user scope that escapes through a symlink", async () => {
    const root = await configuredRoot();
    const home = await fakeHome();
    const outside = await mkdtemp(join(tmpdir(), "nexus-kernel-home-outside-"));
    try {
      await mkdir(join(home, ".config", "nexus"), { recursive: true });
      await symlink(outside, join(home, ".config", "nexus", "user"), "dir");
      await writeFile(
        join(root, "user.yaml"),
        `model:\n  apiKeyFile: ${join(home, ".config", "nexus", "user", "secrets", "key")}\n`,
        "utf8",
      );
      await expect(resolveConfig(root, configOptions)).rejects.toThrow(/symlink/);
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("kernel config tool root boundary", () => {
  const toolRoot = (value: string) => `tools:\n  root: ${JSON.stringify(value)}\n`;

  it("resolves the relative and dot tool roots to the canonical runtime root", async () => {
    const root = await configuredRoot();
    try {
      expect((await resolveConfig(root, configOptions)).tools.root).toBe(root);

      await writeFile(join(root, "user.yaml"), toolRoot("."), "utf8");
      expect((await resolveConfig(root, configOptions)).tools.root).toBe(root);

      await mkdir(join(root, "workspace"), { recursive: true });
      await writeFile(join(root, "user.yaml"), toolRoot("workspace"), "utf8");
      expect((await resolveConfig(root, configOptions)).tools.root).toBe(join(root, "workspace"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("canonicalizes a runtime root reached through a symlink", async () => {
    const root = await configuredRoot();
    try {
      await symlink(root, join(root, "alias"), "dir");
      const config = await resolveConfig(join(root, "alias"), configOptions);
      expect(config.tools.root).toBe(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an absolute tool root outside the runtime root", async () => {
    const root = await configuredRoot();
    const outside = await mkdtemp(join(tmpdir(), "nexus-kernel-outside-"));
    const home = await fakeHome();
    try {
      for (const candidate of ["/", "/etc", "/usr", outside, home, join(root, "..")]) {
        await writeFile(join(root, "user.yaml"), toolRoot(candidate), "utf8");
        await expect(resolveConfig(root, configOptions)).rejects.toThrow(
          /tools\.root escapes the runtime root/,
        );
      }
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects an absolute tool root that leaves the runtime root through a symlinked parent", async () => {
    const root = await configuredRoot();
    const outside = await mkdtemp(join(tmpdir(), "nexus-kernel-symlink-parent-"));
    try {
      await symlink(outside, join(root, "escape"), "dir");
      for (const candidate of [join(root, "escape"), join(root, "escape", "nested")]) {
        await writeFile(join(root, "user.yaml"), toolRoot(candidate), "utf8");
        await expect(resolveConfig(root, configOptions)).rejects.toThrow(
          /tools\.root escapes through a symlink/,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("accepts an absolute sandbox temp root inside the runtime root and canonicalizes a symlink", async () => {
    const root = await configuredRoot();
    try {
      const sandbox = join(root, "worktree");
      await mkdir(sandbox, { recursive: true });
      await writeFile(join(root, "user.yaml"), toolRoot(sandbox), "utf8");
      const config = await resolveConfig(root, configOptions);
      expect(config.tools.root).toBe(sandbox);
      expect(pluginConfig(config, "tools-core").root).toBe(sandbox);

      const real = join(root, "real-sandbox");
      await mkdir(real, { recursive: true });
      await symlink(real, join(root, "linked-sandbox"), "dir");
      await writeFile(join(root, "user.yaml"), toolRoot(join(root, "linked-sandbox", "nested")), "utf8");
      expect((await resolveConfig(root, configOptions)).tools.root).toBe(join(real, "nested"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("confines an absolute plugin tool root to the runtime root too", async () => {
    const root = await configuredRoot();
    const home = await fakeHome();
    try {
      for (const name of ["tools-core", "tools-basic"]) {
        for (const candidate of ["/", home]) {
          await writeFile(
            join(root, "user.yaml"),
            `plugins:\n  ${name}:\n    root: ${JSON.stringify(candidate)}\n`,
            "utf8",
          );
          await expect(resolveConfig(root, configOptions)).rejects.toThrow(
            new RegExp(`plugins\\.${name}\\.root escapes the runtime root`),
          );
        }
      }
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("still refuses a relative tool root that traverses out", async () => {
    const root = await configuredRoot();
    try {
      for (const candidate of ["../escape", "workspace/../../escape", "..\\escape"]) {
        await writeFile(join(root, "user.yaml"), toolRoot(candidate), "utf8");
        await expect(resolveConfig(root, configOptions)).rejects.toThrow(
          /tools\.root must be a canonical path/,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never leaks secret or config material when it refuses a tool root", async () => {
    const root = await configuredRoot();
    const home = await fakeHome();
    const secret = "sk-live-must-never-appear-in-an-error";
    try {
      await mkdir(join(root, "user", "secrets"), { recursive: true });
      const keyFile = join(root, "user", "secrets", "provider.key");
      await writeFile(keyFile, `${secret}\n`, "utf8");
      await writeFile(
        join(root, "user.yaml"),
        `model:\n  apiKeyFile: user/secrets/provider.key\ntools:\n  root: "/"\n`,
        "utf8",
      );

      const error = await resolveConfig(root, configOptions).then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(Error);
      const reported = [String(error), (error as Error).message, (error as Error).stack ?? ""].join("\n");
      expect(reported).toMatch(/tools\.root escapes the runtime root/);
      expect(reported).not.toContain(secret);
      expect(reported).not.toContain(keyFile);
      expect(reported).not.toContain(home);
      expect(reported).not.toContain("apiKeyFile");

      await writeFile(
        join(root, "user.yaml"),
        `model:\n  apiKeyFile: user/secrets/provider.key\ntools:\n  root: ${JSON.stringify(join(root, "workspace"))}\n`,
        "utf8",
      );
      const config = await resolveConfig(root, configOptions);
      expect(JSON.stringify(config)).not.toContain(secret);
      expect(config.model.apiKeyFile).toBe(keyFile);
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("keeps the shell and network defaults at deny", async () => {
    const root = await configuredRoot();
    try {
      const config = await resolveConfig(root, configOptions);
      expect(config.permissions).toMatchObject({ shell: "deny", network: "deny", "fs.write": "deny" });
      expect(config.tools.shell).toMatchObject({ allow: [], deny: [], timeoutMs: 5000 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const offBudget = {
  enabled: false,
  maxTotalTokens: null,
  maxCostUsd: null,
  maxElapsedMs: null,
  prices: null,
};

/** What `sandbox.ts` writes: mock model, workspace tool root, no `user/` and no budget block. */
const sandboxYaml = [
  "model:",
  "  provider: mock",
  "  model: mock",
  "tools:",
  "  root: workspace",
  "  shell:",
  "    allow: []",
  '    deny: ["*"]',
  "    timeoutMs: 100",
  "permissions:",
  "  fs.read: allow",
  "  fs.write: allow",
  "  shell: deny",
  "  network: deny",
  "",
].join("\n");

describe("kernel config budget", () => {
  async function budgetFrom(defaults: string, user: string): Promise<unknown> {
    const root = await configuredRoot(defaults);
    try {
      await writeFile(join(root, "user.yaml"), user, "utf8");
      return (await resolveConfig(root, configOptions)).budget;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it("is off with every dimension unbounded when the block is absent, never Infinity", async () => {
    const root = await configuredRoot();
    try {
      const config = await resolveConfig(root, configOptions);
      expect(config.budget).toEqual(offBudget);
      expect(Object.values(config.budget)).not.toContain(Infinity);
      expect(JSON.stringify(config.budget)).not.toContain("Infinity");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves an enabled budget with per-model prices", async () => {
    expect(
      await budgetFrom(
        "model:\n  provider: mock\n",
        [
          "budget:",
          "  enabled: true",
          "  maxTotalTokens: 120000",
          "  maxCostUsd: 0.75",
          "  maxElapsedMs: 90000",
          "  prices:",
          "    gpt-4o-mini:",
          "      inputUsdPerMillionTokens: 0.15",
          "      outputUsdPerMillionTokens: 0.6",
          "    oc/space-bunny-free:",
          "      inputUsdPerMillionTokens: 1",
          "      outputUsdPerMillionTokens: 2",
          "",
        ].join("\n"),
      ),
    ).toEqual({
      enabled: true,
      maxTotalTokens: 120000,
      maxCostUsd: 0.75,
      maxElapsedMs: 90000,
      // One entry per model the run can be billed under, keyed by the exact identity, in kernel units.
      prices: {
        "gpt-4o-mini": { inputUsdPerMillionTokens: 0.15, outputUsdPerMillionTokens: 0.6 },
        "oc/space-bunny-free": { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 },
      },
    });
  });

  it("keeps a cap unbounded when the user writes an explicit null", async () => {
    expect(
      await budgetFrom(
        "budget:\n  enabled: true\n  maxTotalTokens: 5000\n",
        "budget:\n  maxTotalTokens: null\n",
      ),
    ).toMatchObject({ enabled: true, maxTotalTokens: null });
  });

  it("rejects zero, negative, NaN, and non-finite caps", async () => {
    for (const [field, value] of [
      ["maxTotalTokens", "0"],
      ["maxTotalTokens", "-1"],
      ["maxTotalTokens", "1.5"],
      ["maxTotalTokens", "!!float .nan"],
      ["maxTotalTokens", "1e999"],
      ["maxCostUsd", "0"],
      ["maxCostUsd", "-0.01"],
      ["maxCostUsd", "!!float .nan"],
      ["maxElapsedMs", "0"],
      ["maxElapsedMs", "-15000"],
      ["maxElapsedMs", "!!float .nan"],
    ] as const) {
      await expect(
        budgetFrom("model:\n  provider: mock\n", `budget:\n  enabled: true\n  ${field}: ${value}\n`),
      ).rejects.toThrow(new RegExp(`budget\\.${field}`));
    }
  });

  it("rejects zero, negative, and NaN prices", async () => {
    for (const [field, value] of [
      ["inputUsdPerMillionTokens", "0"],
      ["inputUsdPerMillionTokens", "-0.15"],
      ["inputUsdPerMillionTokens", "!!float .nan"],
      ["outputUsdPerMillionTokens", "0"],
      ["outputUsdPerMillionTokens", "-0.6"],
      ["outputUsdPerMillionTokens", "!!float .nan"],
    ] as const) {
      await expect(
        budgetFrom(
          "model:\n  provider: mock\n",
          `budget:\n  prices:\n    gpt-4o-mini:\n      ${field}: ${value}\n`,
        ),
      ).rejects.toThrow(new RegExp(`budget\\.prices\\.gpt-4o-mini\\.${field}`));
    }
  });

  it("rejects a half-written price pair instead of pricing a dimension as free", async () => {
    for (const prices of [
      // One side only: the other dimension would be silently free.
      "budget:\n  enabled: true\n  prices:\n    gpt-4o-mini:\n      inputUsdPerMillionTokens: 0.15\n",
      // A bare pair with no model to bind it to prices nothing.
      "budget:\n  enabled: true\n  prices:\n    inputUsdPerMillionTokens: 0.15\n    outputUsdPerMillionTokens: 0.6\n",
    ]) {
      await expect(budgetFrom("model:\n  provider: mock\n", prices)).rejects.toThrow(/budget\.prices/);
    }
  });

  it("rejects an unknown key anywhere in the block", async () => {
    for (const [user, expected] of [
      ["budget:\n  maxToken: 10\n", /maxToken/],
      [
        "budget:\n  prices:\n    gpt-4o-mini:\n      cachedUsdPerMillionTokens: 0.1\n",
        /cachedUsdPerMillionTokens/,
      ],
    ] as const) {
      await expect(budgetFrom("model:\n  provider: mock\n", user)).rejects.toThrow(expected);
    }
  });

  it("lets the user overlay tighten a cap and keep the prices it did not touch", async () => {
    expect(
      await budgetFrom(
        [
          "budget:",
          "  enabled: true",
          "  maxTotalTokens: 500000",
          "  maxCostUsd: 5",
          "  maxElapsedMs: 600000",
          "  prices:",
          "    gpt-4o-mini:",
          "      inputUsdPerMillionTokens: 0.25",
          "      outputUsdPerMillionTokens: 2",
          "    oc/space-bunny-free:",
          "      inputUsdPerMillionTokens: 1",
          "      outputUsdPerMillionTokens: 2",
          "",
        ].join("\n"),
        [
          "budget:",
          "  maxTotalTokens: 1000",
          "  maxElapsedMs: 5000",
          "  prices:",
          "    gpt-4o-mini:",
          "      inputUsdPerMillionTokens: 0.1",
          "      outputUsdPerMillionTokens: 3",
          "",
        ].join("\n"),
      ),
    ).toEqual({
      enabled: true,
      maxTotalTokens: 1000,
      maxCostUsd: 5,
      maxElapsedMs: 5000,
      // Per-model overlay: the tightened pair replaces the default one, the other model survives.
      prices: {
        "gpt-4o-mini": { inputUsdPerMillionTokens: 0.1, outputUsdPerMillionTokens: 3 },
        "oc/space-bunny-free": { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 },
      },
    });
  });

  it("drops every price when the overlay writes an explicit null", async () => {
    expect(
      await budgetFrom(
        "budget:\n  enabled: true\n  prices:\n    gpt-4o-mini:\n      inputUsdPerMillionTokens: 0.15\n      outputUsdPerMillionTokens: 0.6\n",
        "budget:\n  prices: null\n",
      ),
    ).toEqual({ enabled: true, maxTotalTokens: null, maxCostUsd: null, maxElapsedMs: null, prices: null });
  });

  it("stays compatible with a sandbox mock config that has no budget and no user file", async () => {
    const root = await configuredRoot(sandboxYaml);
    try {
      const workspace = join(root, "workspace");
      await mkdir(workspace, { recursive: true });
      const config = await resolveConfig(root, {
        defaultsPath: "config/default.yaml",
        userPath: "user/config.yaml",
      });
      expect(config.budget).toEqual(offBudget);
      expect(config.model.provider).toBe("mock");
      expect(config.tools.root).toBe(workspace);
      // The runtime reads the budget off the resolved config; the plugin merge stays as narrow as it was.
      expect(pluginConfig(config, "tools-core").root).toBe(workspace);
      expect(pluginConfig(config, "loop-react")).toEqual({
        maxSteps: 8,
        maxToolCalls: 12,
        timeoutMs: 15000,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts the shipped default and user example configs", async () => {
    for (const file of ["../../config/default.yaml", "../../user/config.example.yaml"]) {
      const parsed = parseYaml(await readFile(new URL(file, import.meta.url), "utf8")) as unknown;
      const result = ConfigSchema.safeParse(parsed);
      expect(result.error?.message, file).toBeUndefined();
      expect(result.data?.budget, file).toEqual(offBudget);
    }
  });
});

/** What an absent `trace` block resolves to: off, with the conservative cap already in place. */
const offTrace = { enabled: false, maxBytes: 1_048_576 };
const traceMaxBytesCeiling = 67_108_864;

describe("kernel config trace", () => {
  async function traceFrom(defaults: string, user: string): Promise<unknown> {
    const root = await configuredRoot(defaults);
    try {
      await writeFile(join(root, "user.yaml"), user, "utf8");
      return (await resolveConfig(root, configOptions)).trace;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  async function traceRejected(defaults: string, user: string, expected: RegExp): Promise<void> {
    const root = await configuredRoot(defaults);
    try {
      await writeFile(join(root, "user.yaml"), user, "utf8");
      await expect(resolveConfig(root, configOptions), user).rejects.toThrow(expected);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it("is off with the conservative cap when the block is absent, and writes no file", async () => {
    const root = await configuredRoot();
    try {
      const before = await readdir(root, { recursive: true });
      const config = await resolveConfig(root, configOptions);
      expect(config.trace).toEqual(offTrace);
      // Off means off: resolving a config creates no trace, no log, and no data directory.
      expect(await readdir(root, { recursive: true })).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves an enabled trace with a bounded cap and still writes nothing itself", async () => {
    const root = await configuredRoot();
    try {
      await writeFile(join(root, "user.yaml"), "trace:\n  enabled: true\n", "utf8");
      const before = await readdir(root, { recursive: true });
      const config = await resolveConfig(root, configOptions);
      // The block decides whether a writer runs and how much it may keep; the writer is not the config.
      expect(config.trace).toEqual({ enabled: true, maxBytes: 1_048_576 });
      expect(await readdir(root, { recursive: true })).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts the cap bounds and a cap-only block", async () => {
    for (const maxBytes of [1, 4096, traceMaxBytesCeiling]) {
      expect(await traceFrom("model:\n  provider: mock\n", `trace:\n  maxBytes: ${maxBytes}\n`)).toEqual({
        enabled: false,
        maxBytes,
      });
    }
    expect(
      await traceFrom("model:\n  provider: mock\n", `trace:\n  enabled: true\n  maxBytes: 4096\n`),
    ).toEqual({ enabled: true, maxBytes: 4096 });
  });

  it("rejects zero, negative, fraction, NaN, non-finite, and out-of-bounds caps", async () => {
    for (const value of [
      "0",
      "-1",
      "1.5",
      "!!float .nan",
      "!!float .inf",
      "1e999",
      '"1024"',
      "true",
      "null",
      String(traceMaxBytesCeiling + 1),
    ]) {
      await traceRejected(
        "model:\n  provider: mock\n",
        `trace:\n  enabled: true\n  maxBytes: ${value}\n`,
        /trace\.maxBytes/,
      );
    }
  });

  it("rejects a non-boolean enabled and a null block", async () => {
    for (const value of ["yes", '"true"', "1", "null", "[]"]) {
      await traceRejected("model:\n  provider: mock\n", `trace:\n  enabled: ${value}\n`, /trace\.enabled/);
    }
    // A null block is not "off by omission" either: it is a broken shape, not a request to skip tracing.
    await traceRejected("model:\n  provider: mock\n", "trace: null\n", /expected object/);
  });

  it("rejects a path, root, or secret lever anywhere in the block", async () => {
    for (const [field, value] of [
      ["path", "/tmp/trace.jsonl"],
      ["dir", "/tmp"],
      ["root", "."],
      ["file", "trace.jsonl"],
      ["apiKeyFile", "user/secrets/provider.key"],
      ["includeContent", "true"],
      ["maxSize", "4096"],
      ["level", "debug"],
    ] as const) {
      // A strict block reports the whole `trace` object and names the key it refused.
      await traceRejected(
        "model:\n  provider: mock\n",
        `trace:\n  enabled: true\n  ${field}: ${value}\n`,
        new RegExp(`"${field}"`),
      );
    }
    // A typo is refused too, so a misspelled block cannot read as "off" forever.
    await traceRejected("model:\n  provider: mock\n", "traces:\n  enabled: true\n", /traces/);
  });

  it("refuses prototype pollution and keeps the block unreachable from a plugin overlay", async () => {
    await traceRejected(
      "model:\n  provider: mock\n",
      "trace:\n  __proto__:\n    enabled: true\n",
      /unsafe configuration key/,
    );
    for (const plugin of ["loop-react", "tools-core", "example-hello"] as const) {
      await traceRejected(
        "model:\n  provider: mock\n",
        `plugins:\n  ${plugin}:\n    trace:\n      enabled: true\n`,
        new RegExp(`plugins\\.${plugin}`),
      );
    }
  });

  it("lets the user overlay enable tracing and tighten the cap, keeping what it did not touch", async () => {
    const defaults = [
      "trace:",
      "  enabled: false",
      "  maxBytes: 8388608",
      "model:",
      "  provider: mock",
      "",
    ].join("\n");
    // Enabling alone leaves the default cap standing: an overlay replaces keys, it does not reset the block.
    expect(await traceFrom(defaults, "trace:\n  enabled: true\n")).toEqual({
      enabled: true,
      maxBytes: 8_388_608,
    });
    // A smaller cap is the user tightening the same lever every other cap follows here, and it
    // applies whether or not tracing is on, so a later enable keeps the tighter cap.
    expect(await traceFrom(defaults, "trace:\n  maxBytes: 262144\n")).toEqual({
      enabled: false,
      maxBytes: 262_144,
    });
    expect(await traceFrom(defaults, "trace:\n  enabled: true\n  maxBytes: 262144\n")).toEqual({
      enabled: true,
      maxBytes: 262_144,
    });
  });

  it("stays compatible with a sandbox mock config that has no trace and no user file", async () => {
    const root = await configuredRoot(sandboxYaml);
    try {
      const workspace = join(root, "workspace");
      await mkdir(workspace, { recursive: true });
      const config = await resolveConfig(root, {
        defaultsPath: "config/default.yaml",
        userPath: "user/config.yaml",
      });
      expect(config.trace).toEqual(offTrace);
      expect(config.model.provider).toBe("mock");
      expect(config.tools.root).toBe(workspace);
      // The trace block is not a plugin section, so no plugin merge can pick it up either.
      expect(pluginConfig(config, "tools-core").root).toBe(workspace);
      expect(pluginConfig(config, "loop-react")).toEqual({
        maxSteps: 8,
        maxToolCalls: 12,
        timeoutMs: 15000,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts the shipped default and user example configs with trace off", async () => {
    for (const file of ["../../config/default.yaml", "../../user/config.example.yaml"]) {
      const parsed = parseYaml(await readFile(new URL(file, import.meta.url), "utf8")) as unknown;
      const result = ConfigSchema.safeParse(parsed);
      expect(result.error?.message, file).toBeUndefined();
      expect(result.data?.trace, file).toEqual(offTrace);
    }
  });
});
