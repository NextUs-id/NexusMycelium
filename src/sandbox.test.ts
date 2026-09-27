import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ResolvedConfig, resolveConfig } from "../kernel/src/config.js";
import { main, type SandboxHost } from "./cli.js";
import { createRuntimeRoot } from "./runtime.fixtures.js";
import {
  createOutsideDir,
  denyNetwork,
  gitOut,
  gitStatus,
  listRoot,
  ownTempRoot,
  plantEscapeLink,
  plantGitfile,
  protectedTrees,
  readSandboxConfig,
  removeTree,
  snapshotTrees,
  writeFileIn,
} from "./sandbox.fixtures.js";
import { assertSandboxEnforced, createSandbox, runInSandbox, type SandboxRequest } from "./sandbox.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const writeTask = "write file notes.txt with content hello";
const scratch: string[] = [];

/** The request the CLI seam builds: the offline defaults, never a caller-widened one. */
function offlineRequest(task: string, root = repoRoot): SandboxRequest {
  return { root, task, provider: "mock", permissions: { network: "deny", shell: "deny" } };
}

// Compile-time proof that this module is what `loadSandboxHost` casts to: if the seam drifts, tsc fails.
const host = { runInSandbox } satisfies SandboxHost;

afterEach(async () => {
  const pending = scratch.splice(0, scratch.length);
  await Promise.all(pending.map((path) => removeTree(path)));
});

function track<T extends string>(path: T): T {
  scratch.push(path);
  return path;
}

describe("createSandbox", () => {
  it("confines every tool root to its own temp workspace and reads no user state", async () => {
    const sandbox = await createSandbox();
    const root = track(sandbox.root);
    expect(root.startsWith(tmpdir())).toBe(true);
    expect(await listRoot(root)).toEqual(["config", "user", "workspace"]);
    expect(sandbox.config.tools.root).toBe(sandbox.workspace);
    expect(sandbox.config.permissions.network).toBe("deny");
    expect(sandbox.config.permissions.shell).toBe("deny");
    expect(sandbox.config.model.provider).toBe("mock");
    expect(sandbox.config.model.apiKeyFile).toBeUndefined();
    // No overlay is copied in, so no base URL, key path, or network grant can arrive from the host.
    expect(await listRoot(join(root, "user"))).toEqual([]);
    const written = await readSandboxConfig(root);
    expect(written).toContain("root: workspace");
    expect(written).toContain("network: deny");
    expect(written).not.toMatch(/apiKey|9router|baseUrl|oc\//);
    expect(await sandbox.dispose()).toBe(true);
    expect(existsSync(root)).toBe(false);
    await expect(sandbox.run(writeTask)).rejects.toThrow(/sandbox is disposed/);
  });

  it("runs a task into the workspace and reports a result that carries no path", async () => {
    const result = await runInSandbox(offlineRequest(writeTask));
    expect(result).toEqual({
      status: "completed",
      steps: 2,
      toolCalls: 1,
      workspaceCleaned: true,
    });
    expect(JSON.stringify(result)).not.toContain("/");
  });

  it("refuses a request that widens the provider or the permissions", async () => {
    const live = { ...offlineRequest(writeTask), provider: "openai" } as unknown as SandboxRequest;
    await expect(runInSandbox(live)).rejects.toThrow(/offline; provider openai is refused/);
    const networked = {
      ...offlineRequest(writeTask),
      permissions: { network: "allow", shell: "deny" },
    } as unknown as SandboxRequest;
    await expect(runInSandbox(networked)).rejects.toThrow(/deny network and shell/);
    const shelled = {
      ...offlineRequest(writeTask),
      permissions: { network: "deny", shell: "allow" },
    } as unknown as SandboxRequest;
    await expect(runInSandbox(shelled)).rejects.toThrow(/deny network and shell/);
    await expect(runInSandbox({ ...offlineRequest(""), root: repoRoot })).rejects.toThrow(
      /task must be a non-empty string/,
    );
    await expect(runInSandbox({ ...offlineRequest(writeTask), root: "" })).rejects.toThrow(
      /requires a root path/,
    );
    // A refused request never reaches a run, so it never creates a temp root to clean up.
    expect(host.runInSandbox).toBe(runInSandbox);
  });

  it("never reads the requested root, so a repo root cannot leak user config or a key", async () => {
    const trees = protectedTrees(repoRoot);
    const before = await snapshotTrees(trees);
    // The CLI passes the repository root as `root`; the sandbox builds its own offline config anyway,
    // so the path resolves inside the temp workspace and simply is not there.
    const result = await runInSandbox(offlineRequest("read user/config.yaml", repoRoot));
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/ENOENT|no such file/);
    const envelope = JSON.stringify(result);
    for (const forbidden of [repoRoot, homedir(), "apiKey", "OPENAI_API_KEY", "9router"]) {
      expect(envelope, `report must not carry ${forbidden}`).not.toContain(forbidden);
    }
    expect(await snapshotTrees(trees)).toEqual(before);
  });

  it("refuses traversal, absolute, and symlink escapes without writing outside", async () => {
    const outside = track(await createOutsideDir());
    await writeFileIn(outside, "secret.txt", "top-secret");
    const sandbox = await createSandbox();
    const root = track(sandbox.root);
    await plantEscapeLink(sandbox.workspace, outside);

    const traversal = await sandbox.run("write file ../escape.txt with content x");
    expect(traversal.status).toBe("error");
    expect(traversal.error).toMatch(/escapes the configured root/);
    expect(existsSync(join(root, "escape.txt"))).toBe(false);

    const absolute = await sandbox.run(`write file ${join(outside, "absolute.txt")} with content x`);
    expect(absolute.status).toBe("error");
    expect(absolute.error).toMatch(/escapes the configured root/);
    expect(existsSync(join(outside, "absolute.txt"))).toBe(false);

    const symlinked = await sandbox.run("read escape/secret.txt");
    expect(symlinked.status).toBe("error");
    expect(symlinked.error).toMatch(/through a symlink/);
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("top-secret");
    expect(await listRoot(outside)).toEqual(["secret.txt"]);

    expect(await sandbox.dispose()).toBe(true);
  });

  it("denies every shell executable unless the policy configures one", async () => {
    const denied = await createSandbox();
    track(denied.root);
    const config = await readSandboxConfig(denied.root);
    expect(config).toContain("allow: []");
    expect(config).toContain('deny: ["*"]');
    await expect(
      denied.tools.get("shell").execute({ executable: process.execPath, args: ["-e", "0"] }),
    ).rejects.toThrow(/permission denied: shell/);

    const allowed = await createSandbox({ shell: { allow: [process.execPath] } });
    track(allowed.root);
    expect(allowed.config.permissions.shell).toBe("allow");
    const output = await allowed.tools
      .get("shell")
      .execute({ executable: process.execPath, args: ["-e", "0"] });
    expect(JSON.parse(output)).toMatchObject({ ok: true, code: 0 });
    // The allowlist is the only widening: nothing outside it runs, even with shell permission allowed.
    await expect(
      allowed.tools.get("shell").execute({ executable: "/bin/sh", args: ["-c", "true"] }),
    ).rejects.toThrow(/not allowlisted/);
    await allowed.dispose();
    await denied.dispose();
  });

  it("makes no network call and loads no key", async () => {
    const network = denyNetwork();
    try {
      const result = await runInSandbox(offlineRequest(writeTask));
      expect(result.status).toBe("completed");
      expect(result.workspaceCleaned).toBe(true);
      expect(network.calls()).toBe(0);
    } finally {
      network.restore();
    }
  });

  it("leaves the repo, user, and home trees byte-identical", async () => {
    const trees = protectedTrees(repoRoot);
    const before = await snapshotTrees(trees);
    // A real digest, not an absent-path shortcut, so the comparison below can actually fail.
    expect(before["repo/user"]).not.toBe("absent");
    expect(before["repo/data"]).not.toBe("absent");

    const shell = await createSandbox();
    track(shell.root);
    await expect(
      shell.tools.get("shell").execute({ executable: process.execPath, args: ["-e", "0"] }),
    ).rejects.toThrow(/permission denied: shell/);
    await runInSandbox(offlineRequest(writeTask));
    await runInSandbox(offlineRequest("write file ../escape.txt with content x"));
    await shell.dispose();

    expect(await snapshotTrees(trees)).toEqual(before);
  });

  it("fails closed when the resolved config cannot confine the workspace", async () => {
    const outside = track(await createOutsideDir());
    const sandbox = await createSandbox();
    track(sandbox.root);
    const base = sandbox.config;
    try {
      // Positive control: what createSandbox resolves and enforces passes.
      expect(() => assertSandboxEnforced(base, sandbox.workspace)).not.toThrow();

      // A root inside the runtime root but outside the workspace is schema-legal, so the guard owns it.
      const widened: ResolvedConfig = { ...base, tools: { ...base.tools, root: outside } };
      expect(() => assertSandboxEnforced(widened, sandbox.workspace)).toThrow(
        /not enforceable: tools\.root is outside the workspace/,
      );

      // So does a plugin override, which the owning plugin reads in place of the tools block.
      for (const name of ["tools-basic", "tools-core"]) {
        const overridden: ResolvedConfig = {
          ...base,
          plugins: { ...base.plugins, [name]: { root: outside } },
        };
        expect(() => assertSandboxEnforced(overridden, sandbox.workspace)).toThrow(
          new RegExp(`not enforceable: plugins\\.${name}\\.root is outside the workspace`),
        );
      }

      const networked: ResolvedConfig = { ...base, permissions: { ...base.permissions, network: "allow" } };
      expect(() => assertSandboxEnforced(networked, sandbox.workspace)).toThrow(/network is not denied/);

      // Outside the runtime root the kernel refuses on its own, which is why the sandbox root is relative.
      const escaping = track(
        await createRuntimeRoot("model:\n  provider: mock\n", `tools:\n  root: ${JSON.stringify(outside)}\n`),
      );
      await expect(resolveConfig(escaping)).rejects.toThrow(/tools\.root escapes the runtime root/);
      expect(existsSync(outside)).toBe(true);
    } finally {
      await sandbox.dispose();
    }
  });

  it("cleans the temp tree on success, on error, and on a stopped run", async () => {
    const succeeded = await runInSandbox(offlineRequest(writeTask));
    expect(succeeded.workspaceCleaned).toBe(true);

    const failed = await runInSandbox(offlineRequest("write file ../escape.txt with content x"));
    expect(failed.status).toBe("error");
    expect(failed.error).toMatch(/escapes the configured root/);
    expect(failed.workspaceCleaned).toBe(true);

    const limited = await runInSandbox(offlineRequest(writeTask), { limits: { maxSteps: 1 } });
    expect(limited.status).toBe("stopped");
    expect(limited.error).toBe("step limit reached");
    expect(limited.workspaceCleaned).toBe(true);

    const cancelled = await runInSandbox(offlineRequest(writeTask), { signal: AbortSignal.abort() });
    expect(cancelled.status).toBe("stopped");
    expect(cancelled.error).toBe("agent cancelled");
    expect(cancelled.workspaceCleaned).toBe(true);

    // A run that throws rather than reports still has to tear the temp tree down: the finally owns it.
    await expect(runInSandbox("")).rejects.toThrow(/task must be a non-empty string/);
  });
});

describe("snapshot and rollback", () => {
  const overwrite = "write file notes.txt with content tampered";

  it("restores the pre-task bytes and a clean status, and stacks on a second run", async () => {
    const sandbox = await createSandbox();
    track(sandbox.root);
    const seeded = await writeFileIn(sandbox.workspace, "notes.txt", "original bytes");

    const first = await sandbox.run(overwrite, { snapshot: true });
    expect(first).toEqual({ status: "completed", steps: 2, toolCalls: 1, snapshot: true, rolledBack: true });
    expect(await readFile(seeded, "utf8")).toBe("original bytes");
    expect(await gitStatus(sandbox.workspace)).toBe("");

    // Control: the same task with no baseline does overwrite, so the restore above was the git baseline.
    const bare = await sandbox.run(overwrite);
    expect(bare).toEqual({ status: "completed", steps: 2, toolCalls: 1 });
    expect(await readFile(seeded, "utf8")).toBe("tampered");

    // A second baseline on the restored workspace stacks on the first: rollback is not one-shot.
    const second = await sandbox.run(overwrite, { snapshot: true });
    expect(second).toMatchObject({ snapshot: true, rolledBack: true });
    expect(await readFile(seeded, "utf8")).toBe("tampered");
    expect(await gitStatus(sandbox.workspace)).toBe("");
    await sandbox.dispose();
  });

  it("removes a file the task created, and leaves the workspace a repository with nothing pending", async () => {
    const sandbox = await createSandbox();
    track(sandbox.root);
    const out = await sandbox.run("write file created.txt with content new", { snapshot: true });
    expect(out.rolledBack).toBe(true);
    expect(existsSync(join(sandbox.workspace, "created.txt"))).toBe(false);
    expect(await gitStatus(sandbox.workspace)).toBe("");
    // The baseline repository survives the restore, so the workspace can be snapshotted again.
    expect((await gitOut(sandbox.workspace, "rev-parse", "--show-toplevel")).trim()).toBe(sandbox.workspace);
    await sandbox.dispose();
  });

  it("restores after a failed task and after a stopped one", async () => {
    const sandbox = await createSandbox();
    track(sandbox.root);
    const failed = await sandbox.run("write file ../escape.txt with content x", { snapshot: true });
    expect(failed).toMatchObject({ status: "error", snapshot: true, rolledBack: true });
    expect(failed.error).toMatch(/escapes the configured root/);
    expect(await gitStatus(sandbox.workspace)).toBe("");

    const stopped = await sandbox.run(writeTask, { snapshot: true, limits: { maxSteps: 1 } });
    expect(stopped).toMatchObject({ status: "stopped", snapshot: true, rolledBack: true });
    expect(stopped.error).toBe("step limit reached");
    expect(await gitStatus(sandbox.workspace)).toBe("");
    await sandbox.dispose();
  });

  it("adds only the two closed flags, and only when a snapshot was asked for", async () => {
    // The default is byte-for-byte the envelope it was before snapshots existed, and no git repo.
    const plain = await runInSandbox(offlineRequest(writeTask));
    expect(plain).toEqual({ status: "completed", steps: 2, toolCalls: 1, workspaceCleaned: true });

    for (const result of [
      await runInSandbox({ ...offlineRequest(writeTask), snapshot: true }),
      await runInSandbox(offlineRequest(writeTask), { snapshot: true }),
    ]) {
      expect(Object.keys(result).sort()).toEqual([
        "rolledBack",
        "snapshot",
        "status",
        "steps",
        "toolCalls",
        "workspaceCleaned",
      ]);
      expect(result).toMatchObject({ snapshot: true, rolledBack: true, workspaceCleaned: true });
      expect(JSON.stringify(result)).not.toContain("/");
    }

    // The one field that changes behavior is checked, not coerced: a string is a refusal, not a truthy.
    await expect(
      runInSandbox({ ...offlineRequest(writeTask), snapshot: "yes" } as unknown as SandboxRequest),
    ).rejects.toThrow(/snapshot must be a boolean/);
  });

  it("reports a restore that could not finish as rolledBack false, never as a thrown error", async () => {
    // The task breaks the very repository the baseline was recorded in, so the restore cannot finish.
    // `restoreQuietly` exists for this: the run already has an outcome, so the flag is the report and
    // the error — which could carry a path — never leaves the closed envelope.
    const result = await runInSandbox({
      ...offlineRequest("write file .git/HEAD with content garbage"),
      snapshot: true,
    });
    expect(result).toEqual({
      status: "completed",
      steps: 2,
      toolCalls: 1,
      snapshot: true,
      rolledBack: false,
      workspaceCleaned: true,
    });
  });

  it("fails closed when the baseline cannot be taken, and still tears the temp tree down", async () => {
    // A real missing binary rather than a stub: an empty directory on PATH, so git cannot start.
    const noGit = track(await mkdtemp(join(tmpdir(), "nexus-no-bin-")));
    const own = await ownTempRoot();
    const previous = process.env.PATH;
    process.env.PATH = noGit;
    try {
      await expect(runInSandbox({ ...offlineRequest(writeTask), snapshot: true })).rejects.toThrow(
        /git is not available on PATH/,
      );
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
      own.restore();
    }
    // No task ran without a baseline, and the temp root the refused run made is gone.
    expect(await own.entries()).toEqual([]);
  });

  it("never adopts the developer repo, not even when the workspace is planted as its worktree", async () => {
    const developerGitDir = (await gitOut(repoRoot, "rev-parse", "--absolute-git-dir")).trim();
    const head = (await gitOut(repoRoot, "rev-parse", "HEAD")).trim();
    const sandbox = await createSandbox();
    track(sandbox.root);
    await plantGitfile(sandbox.workspace, developerGitDir);

    // Positive control: plain git does adopt the planted pointer, which is why the baseline refuses it.
    expect((await gitOut(sandbox.workspace, "rev-parse", "--absolute-git-dir")).trim()).toBe(developerGitDir);
    await expect(sandbox.run(writeTask, { snapshot: true })).rejects.toThrow(/refuses a git checkout/);
    // The task never ran and the pointer never became a repository in the workspace.
    expect(await listRoot(sandbox.workspace)).toEqual([".git"]);
    expect((await gitOut(repoRoot, "rev-parse", "HEAD")).trim()).toBe(head);
    await sandbox.dispose();

    // And the same for the request path: the caller's root is never the snapshot target.
    const trees = protectedTrees(repoRoot);
    const before = await snapshotTrees(trees);
    const result = await runInSandbox({ ...offlineRequest(writeTask, repoRoot), snapshot: true });
    expect(result).toMatchObject({ status: "completed", snapshot: true, rolledBack: true });
    expect(await snapshotTrees(trees)).toEqual(before);
    expect((await gitOut(repoRoot, "rev-parse", "HEAD")).trim()).toBe(head);
  });
});

describe("CLI host seam", () => {
  it("runs the real CLI sandbox path end to end, with no injected host", async () => {
    const trees = protectedTrees(repoRoot);
    const before = await snapshotTrees(trees);
    const network = denyNetwork();
    const chunks: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      // No host argument: the CLI resolves and imports this module itself, so the seam is the real one.
      const code = await main(["run", "--sandbox", "write file cli-seam.txt with content ok"]);
      expect(code).toBe(0);
      const out = chunks.join("");
      expect(out.trimEnd().split("\n")).toHaveLength(1);
      const envelope = JSON.parse(out) as Record<string, unknown>;
      expect(Object.keys(envelope).sort()).toEqual(["status", "steps", "toolCalls", "workspaceCleaned"]);
      expect(envelope.status).toBe("completed");
      expect(envelope.workspaceCleaned).toBe(true);
      expect(network.calls()).toBe(0);
      for (const forbidden of [repoRoot, homedir(), "apiKey", "9router"]) {
        expect(out, `CLI output must not carry ${forbidden}`).not.toContain(forbidden);
      }
      expect(await snapshotTrees(trees)).toEqual(before);
    } finally {
      write.mockRestore();
      network.restore();
    }
  });

  it("runs --sandbox --snapshot through the real seam, with no injected host", async () => {
    const trees = protectedTrees(repoRoot);
    const before = await snapshotTrees(trees);
    const network = denyNetwork();
    const chunks: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      // No host argument, so the flag has to survive the whole real chain: parse → request field →
      // dynamic import of sandbox.js → git baseline → restore → dispose. An injected host would prove
      // only that the CLI asked, never that the host answered.
      const code = await main([
        "run",
        "--sandbox",
        "--snapshot",
        "write file cli-snapshot.txt with content ok",
      ]);
      expect(code).toBe(0);
      const out = chunks.join("");
      expect(out.trimEnd().split("\n")).toHaveLength(1);
      const envelope = JSON.parse(out) as Record<string, unknown>;
      // Exactly the plain envelope plus the two flags: the request reached a real baseline, and the
      // real restore finished. An ignored `--snapshot` would print the four-key envelope above.
      expect(Object.keys(envelope).sort()).toEqual([
        "rolledBack",
        "snapshot",
        "status",
        "steps",
        "toolCalls",
        "workspaceCleaned",
      ]);
      expect(envelope).toMatchObject({
        status: "completed",
        snapshot: true,
        rolledBack: true,
        workspaceCleaned: true,
      });
      expect(network.calls()).toBe(0);
      for (const forbidden of [repoRoot, homedir(), "apiKey", "9router", "/tmp/"]) {
        expect(out, `CLI output must not carry ${forbidden}`).not.toContain(forbidden);
      }
      expect(await snapshotTrees(trees)).toEqual(before);
    } finally {
      write.mockRestore();
      network.restore();
    }
  });

  it("exits nonzero through the real seam when the run cannot complete", async () => {
    const chunks: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      const code = await main(["run", "--sandbox", "write file ../escape.txt with content x"]);
      expect(code).toBe(1);
      expect((JSON.parse(chunks.join("")) as { status: string }).status).toBe("error");
    } finally {
      write.mockRestore();
    }
  });
});
