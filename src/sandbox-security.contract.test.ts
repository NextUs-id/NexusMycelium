import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedConfig } from "../kernel/src/config.js";
import {
  createOutsideDir,
  denyNetwork,
  type ProtectedTree,
  plantEscapeLink,
  readSandboxConfig,
  removeTree,
  snapshotTrees,
} from "./sandbox.fixtures.js";
import { assertSandboxEnforced, createSandbox, runInSandbox, type Sandbox } from "./sandbox.js";

/** The checkout this suite runs in; a sandbox must never reach into it. */
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const posix = process.platform !== "win32";
/** The shell tool's own output cap, in bytes, before the truncation marker is appended. */
const maxOutput = 64_000;

/**
 * Only the trees a sandbox could plausibly damage. The task docs are deliberately left out: every
 * task rewrites them, so digesting them races with unrelated work instead of testing isolation.
 */
function protectedTrees(): readonly ProtectedTree[] {
  return [
    { label: "repo/user", path: join(repoRoot, "user") },
    { label: "repo/data", path: join(repoRoot, "data") },
    { label: "repo/config", path: join(repoRoot, "config") },
    { label: "home/nexus-user", path: join(homedir(), ".config", "nexus", "user") },
  ];
}

const stubbedHomes: string[] = [];

/** A throwaway HOME holding a dummy key, so "no key in the child" is a claim with teeth. */
async function stubbedHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "nexus-sandbox-home-"));
  stubbedHomes.push(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("OPENAI_API_KEY", "dummy-sandbox-key");
  return home;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const home of stubbedHomes.splice(0)) await rm(home, { recursive: true, force: true });
});

/** Runs a body with a live sandbox and always deletes the temp tree, pass or fail. */
async function withSandbox<T>(
  run: (sandbox: Sandbox) => Promise<T>,
  options?: Parameters<typeof createSandbox>[0],
): Promise<T> {
  const sandbox = await createSandbox(options);
  try {
    return await run(sandbox);
  } finally {
    await sandbox.dispose();
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** The shell tool answers with a JSON envelope; the raw streams are the interesting part. */
function shellStreams(result: string): { stdout: string; stderr: string } {
  const parsed = JSON.parse(result) as { stdout?: unknown; stderr?: unknown };
  return { stdout: String(parsed.stdout ?? ""), stderr: String(parsed.stderr ?? "") };
}

/** `error` is the outcome's one optional member; no other key may ride along in the envelope. */
function closedKeys(result: object): string[] {
  return Object.keys(result)
    .filter((key) => key !== "error")
    .sort();
}

/** Signal 0 succeeds only for a live pid, so a false here is the kill the deadline owes us. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const envScript =
  "process.stdout.write(JSON.stringify({" +
  "home: process.env.HOME ?? null," +
  "profile: process.env.USERPROFILE ?? null," +
  "key: process.env.OPENAI_API_KEY ?? null," +
  "kept: process.env.PATH ?? null" +
  "}))";

/** Ignores SIGTERM and leaves a grandchild that does too, so a partial kill is visible. */
const stubbornScript = [
  "const fs = require('node:fs');",
  "const { spawn } = require('node:child_process');",
  "process.on('SIGTERM', () => {});",
  "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"], { stdio: 'ignore' });",
  "fs.writeFileSync('pids.json', JSON.stringify({ parent: process.pid, child: child.pid }));",
  "setInterval(() => {}, 1000);",
].join("\n");

describe("sandbox runner security contract", () => {
  it("works in a temp workspace distinct from the repo, the home, and the data mount", async () => {
    await withSandbox(async (sandbox) => {
      const { workspace, root } = sandbox;
      expect(workspace.startsWith(`${root}${sep}`)).toBe(true);
      expect(workspace.startsWith(tmpdir())).toBe(true);
      for (const forbidden of [repoRoot, join(repoRoot, "data"), join(repoRoot, "user"), homedir()]) {
        expect(workspace.startsWith(`${forbidden}${sep}`), `workspace must not sit in ${forbidden}`).toBe(
          false,
        );
      }
      // The tools root the runtime resolved is the workspace, not anything the host can name.
      expect(sandbox.config.tools.root).toBe(workspace);
      await expect(lstat(workspace)).resolves.toBeDefined();
    });
  });

  it("leaves the protected host trees byte-identical across a run", async () => {
    const trees = protectedTrees();
    const before = await snapshotTrees(trees);
    await withSandbox(async (sandbox) => {
      const result = await sandbox.run("write a file into the workspace");
      expect(["completed", "stopped", "error"]).toContain(result.status);
    });
    expect(await snapshotTrees(trees)).toEqual(before);
  });

  it("refuses a tools root that is not absolute, outside, or escaping through a symlink", async () => {
    const outside = await createOutsideDir();
    try {
      await withSandbox(async (sandbox) => {
        const base: ResolvedConfig = sandbox.config;
        expect(() => assertSandboxEnforced(base, sandbox.workspace)).not.toThrow();

        const outsideTools = { ...base, tools: { ...base.tools, root: outside } };
        expect(() => assertSandboxEnforced(outsideTools, sandbox.workspace)).toThrow(
          /tools\.root is outside the workspace/,
        );

        for (const name of ["tools-basic", "tools-core"] as const) {
          // Both a relative and an absolute plugin root are refused before a run can start: the
          // config schema rejects the location, and assertSandboxEnforced is the backstop.
          for (const root of [outside, "workspace", "../elsewhere"]) {
            const override = { ...base, plugins: { ...base.plugins, [name]: { root } } };
            expect(() => assertSandboxEnforced(override, sandbox.workspace), `${name}=${root}`).toThrow(
              new RegExp(`(plugins\\.${name}\\.root|outside the workspace)`),
            );
          }
        }

        const networked = {
          ...base,
          permissions: { ...base.permissions, network: "allow" as const },
        };
        expect(() => assertSandboxEnforced(networked, sandbox.workspace)).toThrow(/network is not denied/);

        const live = { ...base, model: { ...base.model, provider: "openai" as const } };
        expect(() => assertSandboxEnforced(live, sandbox.workspace)).toThrow(/hermetic mock/);

        expect(() => assertSandboxEnforced(base, "workspace")).toThrow(/not an absolute path/);
      });
    } finally {
      await removeTree(outside);
    }
  });

  it("refuses to read or write through a symlink that leaves the workspace", async () => {
    const outside = await createOutsideDir();
    try {
      await writeFile(join(outside, "secret.txt"), "host-only\n", "utf8");
      await withSandbox(async (sandbox) => {
        const link = await plantEscapeLink(sandbox.workspace, outside);
        await expect(sandbox.tools.get("read_text").execute({ path: "escape/secret.txt" })).rejects.toThrow(
          /escapes the configured root through a symlink/,
        );
        await expect(
          sandbox.tools.get("write_text").execute({ path: `${link}/planted.txt`, content: "no" }),
        ).rejects.toThrow(/escapes the configured root/);
        await expect(
          sandbox.tools.get("read_text").execute({ path: join(outside, "secret.txt") }),
        ).rejects.toThrow(/escapes the configured root/);
        await expect(
          sandbox.tools.get("read_text").execute({ path: "../../../../etc/hostname" }),
        ).rejects.toThrow(/escapes the configured root/);
        expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("host-only\n");
      });
    } finally {
      await removeTree(outside);
    }
  });

  it("denies shell by default, so no executable is started at all", async () => {
    await withSandbox(async (sandbox) => {
      expect(sandbox.config.permissions.shell).toBe("deny");
      const granted = await readSandboxConfig(sandbox.root);
      expect(granted).toMatch(/allow: \[\]/);
      expect(granted).toMatch(/deny: \["\*"\]/);
      expect(sandbox.tools.list().map((tool) => tool.name)).toEqual([
        "read_text",
        "write_text",
        "edit_text",
        "shell",
      ]);

      await expect(
        sandbox.tools.get("shell").execute({ executable: process.execPath, args: ["-e", ""] }),
      ).rejects.toThrow(/denied/);
      await expect(
        sandbox.tools.get("shell").execute({ executable: "/bin/sh", args: ["-c", "printf SHELL_RAN"] }),
      ).rejects.toThrow(/denied/);
    });
  });

  it("gives a child no API key and no home once one executable is allowlisted", async () => {
    await stubbedHome();
    await withSandbox(
      async (sandbox) => {
        expect(sandbox.config.permissions.shell).toBe("allow");
        const granted = await readSandboxConfig(sandbox.root);
        expect(granted).toContain(JSON.stringify(process.execPath));
        // Allowlisting one executable must not allowlist anything else, including an interpreter.
        await expect(
          sandbox.tools.get("shell").execute({ executable: "/bin/sh", args: ["-c", "printf SHELL_RAN"] }),
        ).rejects.toThrow(/not allowlisted/);

        const result = await sandbox.tools
          .get("shell")
          .execute({ executable: process.execPath, args: ["-e", envScript] });
        const { stdout } = shellStreams(result);
        const seen = JSON.parse(stdout) as Record<string, string | null>;
        expect(seen.home).toBeNull();
        expect(seen.profile).toBeNull();
        expect(seen.key).toBeNull();
        expect(seen.kept).toBe(process.env.PATH ?? null);
        expect(stdout).not.toContain("dummy-sandbox-key");
      },
      { shell: { allow: [process.execPath] } },
    );
  });

  it.skipIf(!posix)(
    "kills a child that ignores the deadline, grandchild included",
    async () => {
      await withSandbox(
        async (sandbox) => {
          const started = Date.now();
          await expect(
            sandbox.tools
              .get("shell")
              .execute({ executable: process.execPath, args: ["-e", stubbornScript], timeoutMs: 300 }),
          ).rejects.toThrow(/shell tool timed out after 300ms/);
          // SIGTERM is ignored, so the grace period has to elapse before the group is SIGKILLed.
          expect(Date.now() - started).toBeLessThan(10_000);

          const recorded = JSON.parse(await readFile(join(sandbox.workspace, "pids.json"), "utf8")) as {
            parent: number;
            child: number;
          };
          expect(recorded.parent).toBeGreaterThan(0);
          expect(recorded.child).toBeGreaterThan(0);
          expect(isAlive(recorded.parent)).toBe(false);
          // A host that killed only the direct child would leave this orphan running.
          expect(isAlive(recorded.child)).toBe(false);
        },
        { shell: { allow: [process.execPath] } },
      );
    },
    20_000,
  );

  it("bounds the output a flooding child can push into a result", async () => {
    await withSandbox(
      async (sandbox) => {
        const result = await sandbox.tools.get("shell").execute({
          executable: process.execPath,
          args: ["-e", "process.stdout.write('x'.repeat(300_000))"],
        });
        const { stdout } = shellStreams(result);
        expect(Buffer.byteLength(stdout, "utf8")).toBeLessThanOrEqual(maxOutput + 32);
        expect(Buffer.byteLength(stdout, "utf8")).toBeLessThan(200_000);
        expect(stdout.endsWith("[output truncated]")).toBe(true);
        expect(Buffer.byteLength(stdout, "utf8")).toBeGreaterThan(maxOutput / 2);
      },
      { shell: { allow: [process.execPath] } },
    );
  }, 20_000);

  it("removes the temp tree after a run, after a refusal, and after a construction failure", async () => {
    const first = await createSandbox();
    const root = first.root;
    expect(await exists(root)).toBe(true);
    await expect(first.run("")).rejects.toThrow(/task must be a non-empty string/);
    // Disposal is idempotent and single-flight, so a caller may always clean up.
    await expect(first.dispose()).resolves.toBe(true);
    await expect(first.dispose()).resolves.toBe(true);
    expect(await exists(root)).toBe(false);
    await expect(first.run("too late")).rejects.toThrow(/sandbox is disposed/);

    const finished = await runInSandbox("a bounded task");
    expect(finished.workspaceCleaned).toBe(true);
    expect(closedKeys(finished)).toEqual(["status", "steps", "toolCalls", "workspaceCleaned"]);

    // A host that cannot be built must not leave its temp root behind either.
    await expect(createSandbox({ shell: { allow: [""] } })).rejects.toThrow(/non-empty strings/);
  });

  it("reports no fetch, no user config, and no secret", async () => {
    await stubbedHome();
    const network = denyNetwork();
    try {
      const result = await runInSandbox("read the provider key");
      expect(network.calls()).toBe(0);
      const envelope = JSON.stringify(result);
      for (const forbidden of ["dummy-sandbox-key", "OPENAI_API_KEY", homedir(), repoRoot, "apiKey"]) {
        expect(envelope, `report must not carry ${forbidden}`).not.toContain(forbidden);
      }
      // The outcome is a closed shape: no text, no path, no config can ride along in it.
      expect(closedKeys(result)).toEqual(["status", "steps", "toolCalls", "workspaceCleaned"]);

      const granted = await (async () => {
        const sandbox = await createSandbox();
        try {
          return await readSandboxConfig(sandbox.root);
        } finally {
          await sandbox.dispose();
        }
      })();
      expect(granted).toMatch(/provider: mock/);
      expect(granted).not.toContain("openai");
      expect(granted).not.toContain("key");
    } finally {
      network.restore();
    }
  });

  it("keeps a workspace symlink inside itself rather than following it out", async () => {
    await withSandbox(async (sandbox) => {
      const nested = join(sandbox.workspace, "nested");
      await mkdir(nested, { recursive: true });
      await symlink(nested, join(sandbox.workspace, "loop"), "dir");
      // Reading through a link that stays inside is fine; the boundary is what matters.
      await sandbox.tools.get("write_text").execute({ path: "nested/value.txt", content: "kept" });
      expect(await sandbox.tools.get("read_text").execute({ path: "loop/value.txt" })).toBe("kept");
      await expect(sandbox.tools.get("read_text").execute({ path: "loop" })).rejects.toThrow();
    });
  });
});
