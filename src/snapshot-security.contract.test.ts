import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOutsideDir,
  denyNetwork,
  type ProtectedTree,
  removeTree,
  snapshotTrees,
} from "./sandbox.fixtures.js";

/** The checkout this suite runs in. Its real state is a target a snapshot must never touch. */
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const posix = process.platform !== "win32";

/** Probed once, so `skipIf` can be honest about which evidence is missing on which host. */
const gitAvailable = await new Promise<boolean>((resolve) => {
  execFile("git", ["--version"], { timeout: 10_000 }, (error) => resolve(error === null));
});

/** A `/bin/sh` shim, a `sleep`, and a `head -c /dev/zero` flood all need a posix host. */
const shellShim = posix && gitAvailable;

/**
 * The surface under test. Held as a type rather than imported, so this file keeps describing the
 * Task 3.2 contract instead of drifting into whatever the module happens to export today.
 */
interface SnapshotContract {
  createSnapshot(options: { root: string; timeoutMs?: number; maxOutput?: number }): Promise<{
    take(): Promise<string>;
    restore(ref: string): Promise<Record<string, unknown>>;
  }>;
}

/**
 * Resolved at runtime: a static import would hard-fail `tsc --noEmit` on a host without
 * `src/snapshot.ts`, and a test file that cannot compile says nothing about the contract.
 */
const specifier = "./snapshot.js";

let contract: SnapshotContract | undefined;

async function snapshots(): Promise<SnapshotContract> {
  if (contract === undefined) {
    let loaded: unknown;
    try {
      loaded = await import(specifier);
    } catch (error) {
      throw new Error("src/snapshot.ts is not available, so the Task 3.2 contract is unmet", {
        cause: error,
      });
    }
    const candidate = loaded as Partial<SnapshotContract>;
    if (typeof candidate.createSnapshot !== "function") {
      throw new Error("src/snapshot.ts must export createSnapshot() for the Task 3.2 contract");
    }
    contract = candidate as SnapshotContract;
  }
  return contract;
}

/** Host trees a snapshot must leave alone: the repo overlay, its data mount, and the home scope. */
function hostTrees(): readonly ProtectedTree[] {
  return [
    { label: "repo/user", path: join(repoRoot, "user") },
    { label: "repo/data", path: join(repoRoot, "data") },
    { label: "repo/config", path: join(repoRoot, "config") },
    { label: "home/nexus-user", path: join(homedir(), ".config", "nexus", "user") },
  ];
}

const scratch: string[] = [];
const stubbedHomes: string[] = [];

async function scratchDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/** A throwaway HOME holding a dummy key, so "no key in the git child" has teeth. */
async function stubbedHome(): Promise<string> {
  const home = await scratchDir("nexus-snapshot-home-");
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("OPENAI_API_KEY", "dummy-snapshot-key");
  return home;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const home of stubbedHomes.splice(0)) await rm(home, { recursive: true, force: true });
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

function gitIn(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (error, stdout) => {
        if (error === null) resolve(stdout);
        else reject(new Error(`git ${args.join(" ")} failed in ${cwd}: ${String(error.stderr)}`));
      },
    );
  });
}

/** Absolute path of the real git, so a PATH shim can still forward a working git child. */
async function realGitPath(): Promise<string> {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, "git");
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking down PATH.
    }
  }
  throw new Error("no executable git on PATH");
}

/** An empty workspace under the OS temp dir: the one shape `createSnapshot` is meant to accept. */
async function withWorkspace(
  run: (workspace: { parent: string; root: string }) => Promise<void>,
): Promise<void> {
  const parent = await scratchDir("nexus-snapshot-sec-");
  const root = join(parent, "workspace");
  await mkdir(root, { recursive: true });
  await run({ parent, root });
}

type ShimMode = "record" | "hang" | "flood";

interface GitShim {
  dir: string;
  /** The environment handed to the most recent git child, parsed from the shim's own `env` dump. */
  env(): Promise<Record<string, string>>;
}

/**
 * A `git` on PATH that records the environment it was given before doing anything else. It is the
 * only way to see inside a child the module spawns, and it doubles as proof that git is resolved
 * from PATH rather than from a hardcoded absolute path.
 */
async function installGitShim(mode: ShimMode): Promise<GitShim> {
  const dir = await scratchDir(`nexus-snapshot-shim-${mode}-`);
  const log = join(dir, "env.log");
  const real = JSON.stringify(await realGitPath());
  const body = [
    "#!/bin/sh",
    `{ echo "--- ${mode}"; env; } >> ${JSON.stringify(log)}`,
    `case "${mode}" in`,
    // Only the `init` call hangs, so the module reaches the deadline on the step that must be cut off
    // instead of spending two full timeouts on a lookup whose failure it is allowed to swallow.
    ...(mode === "record" ? [`  record) exec ${real} "$@" ;;`] : []),
    ...(mode === "hang" ? [`  hang) case "$*" in *init*) sleep 30 ;; *) exec ${real} "$@" ;; esac ;;`] : []),
    // stderr, because that is the stream a failure message is built from.
    ...(mode === "flood" ? ["  flood) head -c 300000 /dev/zero | tr '\\0' 'x' >&2; exit 1 ;;"] : []),
    "esac",
    "exit 0",
    "",
  ].join("\n");
  await writeFile(join(dir, "git"), body, "utf8");
  await chmod(join(dir, "git"), 0o755);
  vi.stubEnv("PATH", [dir, process.env.PATH ?? ""].join(delimiter));
  return {
    dir,
    async env(): Promise<Record<string, string>> {
      // The last block only, so an earlier recording cannot make a later one look scrubbed.
      const text = await readFile(log, "utf8");
      const block = text.slice(text.lastIndexOf("--- "));
      const seen: Record<string, string> = {};
      for (const line of block.split("\n").slice(1)) {
        const cut = line.indexOf("=");
        if (cut > 0) seen[line.slice(0, cut)] = line.slice(cut + 1);
      }
      return seen;
    },
  };
}

/** Content digest of a tree with `.git` excluded, so only the restored state is compared. */
function digestTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (target: string): Promise<void> => {
    const info = await lstat(target);
    const label = relative(root, target);
    if (info.isSymbolicLink()) {
      hash.update(`l ${label} ${await readlink(target)}\n`);
      return;
    }
    if (info.isDirectory()) {
      // The snapshot's own storage is not the state under test, and git rewrites it constantly.
      if (label === ".git") return;
      hash.update(`d ${label} ${info.mode & 0o777}\n`);
      const entries = await readdir(target, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        await walk(join(target, entry.name));
      }
      return;
    }
    const checksum = createHash("sha256")
      .update(await readFile(target))
      .digest("hex");
    hash.update(`f ${label} ${info.mode & 0o777} ${info.size} ${checksum}\n`);
  };
  return walk(root).then(() => hash.digest("hex"));
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

interface Cycle {
  ref: string;
  result: Record<string, unknown>;
}

type Limits = { timeoutMs?: number; maxOutput?: number };

/** The full task cycle: record the pre-task state, then one command back to it. */
async function cycle(root: string, limits: Limits = {}): Promise<Cycle> {
  const { createSnapshot } = await snapshots();
  const session = await createSnapshot({ root, ...limits });
  const ref = await session.take();
  return { ref, result: await session.restore(ref) };
}

/** Runs a whole cycle and hands back the error it failed with, so a test can read the message. */
async function expectRefused(root: string, limits: Limits = {}): Promise<Error> {
  let caught: unknown;
  try {
    await cycle(root, limits);
  } catch (error) {
    caught = error;
  }
  if (caught === undefined) throw new Error(`the snapshot module accepted ${root} and completed a cycle`);
  return caught instanceof Error ? caught : new Error(String(caught));
}

describe("git snapshot and rollback security contract", () => {
  it("refuses the real repo, user, data, home, traversing, and escaping symlinked roots", async () => {
    const before = await snapshotTrees(hostTrees());
    await withWorkspace(async ({ parent, root }) => {
      const { createSnapshot } = await snapshots();
      const plainFile = join(parent, "plain.txt");
      const aliasRepo = join(parent, "alias-repo");
      const aliasHome = join(parent, "alias-home");
      const missing = join(parent, "never-created");
      await writeFile(plainFile, "not a directory\n", "utf8");
      await symlink(repoRoot, aliasRepo, "dir");
      await symlink(homedir(), aliasHome, "dir");
      // A temp directory that sits inside somebody else's repository, one level down.
      const holder = await scratchDir("nexus-snapshot-holder-");
      await gitIn(holder, ["init", "-b", "main", holder]);
      const insideRepo = join(holder, "nested");
      await mkdir(insideRepo, { recursive: true });

      const refused: string[] = [];
      const accepted: string[] = [];
      for (const candidate of [
        repoRoot,
        join(repoRoot, "user"),
        join(repoRoot, "data"),
        join(repoRoot, "config"),
        homedir(),
        join(homedir(), ".config", "nexus", "user"),
        "workspace",
        "./workspace",
        "",
        plainFile,
        // Reaches the real repo and the real home through `..`, so no path-string check can pass it.
        join(root, relative(parent, repoRoot)),
        join(root, relative(parent, homedir())),
        aliasRepo,
        aliasHome,
        // The shared temp parent itself: a parent is not a workspace, whatever else it looks like.
        tmpdir(),
        insideRepo,
        missing,
      ]) {
        try {
          await createSnapshot({ root: candidate });
          accepted.push(candidate);
        } catch {
          refused.push(candidate);
        }
      }
      expect(accepted).toEqual([]);
      // Positive control: a refusal suite that only proves "everything is refused" proves nothing.
      expect(await cycle(root).then(({ ref }) => ref)).toMatch(/^[0-9a-f]{7,40}$/i);
      // Refusing a root must not mean creating it on the way to the refusal.
      expect(await exists(missing)).toBe(false);
      expect(refused.length).toBe(17);
    });
    // The refusals above aimed at the real host trees; they must be byte-identical afterwards.
    expect(await snapshotTrees(hostTrees())).toEqual(before);
  });

  it.skipIf(!shellShim)("gives the git child no API key and no home", async () => {
    await stubbedHome();
    await withWorkspace(async ({ root }) => {
      const shim = await installGitShim("record");
      const { ref } = await cycle(root);
      const seen = await shim.env();
      // Non-empty is the control: a shim that never ran would make every assertion below vacuous.
      expect(Object.keys(seen).length).toBeGreaterThan(0);
      expect(seen.HOME).toBeUndefined();
      expect(seen.USERPROFILE).toBeUndefined();
      expect(seen.OPENAI_API_KEY).toBeUndefined();
      expect(seen.PATH).toBeTypeOf("string");
      expect(ref).toMatch(/^[0-9a-f]{7,40}$/i);
    });
  });

  it.skipIf(!gitAvailable)("makes no network call across a snapshot and a restore", async () => {
    await stubbedHome();
    const network = denyNetwork();
    try {
      await withWorkspace(async ({ root }) => {
        const { createSnapshot } = await snapshots();
        const session = await createSnapshot({ root });
        await writeFile(join(root, "tracked.txt"), "original\n", "utf8");
        const ref = await session.take();
        await writeFile(join(root, "tracked.txt"), "task edit\n", "utf8");
        await session.restore(ref);
        expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("original\n");
      });
      expect(network.calls()).toBe(0);
    } finally {
      network.restore();
    }
  });

  it.skipIf(!shellShim)(
    "stops a git child that ignores the deadline",
    async () => {
      await withWorkspace(async ({ root }) => {
        await installGitShim("hang");
        const before = await digestTree(root);
        const started = Date.now();
        const error = await expectRefused(root, { timeoutMs: 1000 });
        // The floor is the point: the child hung, so a fast failure would be a git that never ran.
        expect(Date.now() - started).toBeGreaterThan(900);
        expect(Date.now() - started).toBeLessThan(15_000);
        expect(error.message).toMatch(/tim(?:e|ed)[ -]?out|deadline/i);
        expect(await digestTree(root)).toBe(before);
      });
    },
    30_000,
  );

  it.skipIf(!shellShim)(
    "caps the output a flooding git child can push into a failure",
    async () => {
      await withWorkspace(async ({ root }) => {
        await installGitShim("flood");
        // 300000 bytes of stderr in, a small message out: the cap is the assertion, and it holds
        // even when the flood is a single unbroken line.
        const error = await expectRefused(root);
        expect(error.message.length).toBeLessThan(2000);
        // A cap small enough to bite stops the child instead of merely trimming what it said.
        const capped = await expectRefused(root, { maxOutput: 4096 });
        expect(capped.message.length).toBeLessThan(2000);
        expect(capped.message).toMatch(/exceed|cap|too much|large/i);
      });
    },
    30_000,
  );

  it("fails closed when git is unavailable", async () => {
    await withWorkspace(async ({ root }) => {
      const empty = await scratchDir("nexus-snapshot-nogit-");
      vi.stubEnv("PATH", empty);
      const error = await expectRefused(root);
      expect(error.message).toMatch(/git/i);
    });
  });

  it.skipIf(!gitAvailable)("fails closed on a corrupt commit and leaves the tree untouched", async () => {
    await withWorkspace(async ({ root }) => {
      await writeFile(join(root, "tracked.txt"), "original\n", "utf8");
      const { createSnapshot } = await snapshots();
      const session = await createSnapshot({ root });
      const ref = await session.take();
      await writeFile(join(root, "tracked.txt"), "task edit\n", "utf8");
      // The snapshot lives in the repo's own object store, so losing that store is the corruption.
      await rm(join(root, ".git", "objects"), { recursive: true, force: true });
      const before = await digestTree(root);
      await expect(session.restore(ref)).rejects.toThrow(/git/);
      // Fail closed: no half-applied tree, and the task's own edit is neither kept nor reverted.
      expect(await digestTree(root)).toBe(before);
      expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("task edit\n");
      // A ref that is not even sha-shaped is refused before git is asked anything.
      await expect(session.restore("not-a-commit")).rejects.toThrow(/hex/);
    });
  });

  it.skipIf(!gitAvailable)("keeps ignored files out of the snapshot and out of a restore", async () => {
    await withWorkspace(async ({ root }) => {
      await writeFile(join(root, ".gitignore"), "ignored.txt\nbuild/\n", "utf8");
      await writeFile(join(root, "tracked.txt"), "original\n", "utf8");
      await writeFile(join(root, "ignored.txt"), "host only\n", "utf8");
      await mkdir(join(root, "build"), { recursive: true });
      await writeFile(join(root, "build", "out.bin"), "artifact\n", "utf8");

      const { ref, result } = await cycle(root);
      const listed = (await gitIn(root, ["ls-files"])).split("\n").filter((line) => line.length > 0);
      expect(listed.sort()).toEqual([".gitignore", "tracked.txt"]);

      await rm(join(root, "ignored.txt"));
      await rm(join(root, "build"), { recursive: true, force: true });
      await writeFile(join(root, "tracked.txt"), "task edit\n", "utf8");
      const { createSnapshot } = await snapshots();
      await (await createSnapshot({ root })).restore(ref);
      expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("original\n");
      // An ignored file is not in the snapshot, so a restore can neither resurrect nor invent one.
      expect(await exists(join(root, "ignored.txt"))).toBe(false);
      expect(await exists(join(root, "build"))).toBe(false);
      expect(result.restored).toBe(true);
    });
  });

  it.skipIf(!gitAvailable)("never follows a symlink out of the workspace", async () => {
    const outside = await createOutsideDir();
    try {
      await writeFile(join(outside, "victim.txt"), "host only\n", "utf8");
      await withWorkspace(async ({ root }) => {
        await writeFile(join(root, "tracked.txt"), "original\n", "utf8");
        await symlink(outside, join(root, "escape"), "dir");
        const { ref } = await cycle(root);
        // Stored as a link, not as a copy of the directory it points at.
        const mode = (await gitIn(root, ["ls-files", "-s", "escape"])).trim().split(/\s+/)[0];
        expect(mode).toBe("120000");
        expect(await readFile(join(outside, "victim.txt"), "utf8")).toBe("host only\n");

        // A task that writes through the link lands outside; the restore must not touch that side.
        await writeFile(join(root, "escape", "planted.txt"), "planted\n", "utf8");
        await writeFile(join(root, "tracked.txt"), "task edit\n", "utf8");
        const { createSnapshot } = await snapshots();
        await (await createSnapshot({ root })).restore(ref);
        // Still a link: dereferencing it would have replaced it with a copy of the outside tree.
        expect((await lstat(join(root, "escape"))).isSymbolicLink()).toBe(true);
        expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("original\n");
        expect(await readFile(join(outside, "victim.txt"), "utf8")).toBe("host only\n");
        expect(await readFile(join(outside, "planted.txt"), "utf8")).toBe("planted\n");

        // A symlinked root that stays inside the temp dir is still usable, so the refusals above are
        // about where the link points, not about the link existing.
        const alias = join(await scratchDir("nexus-snapshot-alias-"), "workspace-alias");
        await symlink(root, alias, "dir");
        expect(await cycle(alias).then(({ ref: sha }) => sha)).toMatch(/^[0-9a-f]{7,40}$/i);
      });
    } finally {
      await removeTree(outside);
    }
  });

  it.skipIf(!gitAvailable)("restores a byte-identical tree and leaves no partial files", async () => {
    await withWorkspace(async ({ root }) => {
      await writeFile(join(root, "tracked.txt"), "original\n", "utf8");
      await mkdir(join(root, "nested"), { recursive: true });
      await writeFile(join(root, "nested", "kept.txt"), "kept\n", "utf8");
      const { ref } = await cycle(root);
      const before = await digestTree(root);
      const namesBefore = (await readdir(root)).sort();

      // A task that edits, deletes, creates, and leaves residue behind.
      await writeFile(join(root, "tracked.txt"), "task edit\n", "utf8");
      await rm(join(root, "nested", "kept.txt"));
      await writeFile(join(root, "added-by-task.txt"), "new\n", "utf8");
      await writeFile(join(root, "scratch.txt"), "residue\n", "utf8");
      await mkdir(join(root, "empty"), { recursive: true });
      expect(await digestTree(root)).not.toBe(before);

      const { createSnapshot } = await snapshots();
      await (await createSnapshot({ root })).restore(ref);
      expect(await digestTree(root)).toBe(before);
      // Byte-identical, and no `.orig`, `.rej`, or staging leftover riding along in the tree.
      expect((await readdir(root)).sort()).toEqual(namesBefore);
      expect(await readFile(join(root, "nested", "kept.txt"), "utf8")).toBe("kept\n");
      expect(await exists(join(root, "added-by-task.txt"))).toBe(false);
      expect(await exists(join(root, "scratch.txt"))).toBe(false);
      expect(await exists(join(root, "empty"))).toBe(false);
    });
  });

  it.skipIf(!gitAvailable)("reports no absolute path and no secret", async () => {
    await stubbedHome();
    await withWorkspace(async ({ parent, root }) => {
      await writeFile(join(root, "tracked.txt"), "original\n", "utf8");
      const { createSnapshot } = await snapshots();
      const session = await createSnapshot({ root });
      const ref = await session.take();
      await writeFile(join(root, "tracked.txt"), "task edit\n", "utf8");
      const result = await session.restore(ref);
      const envelope = JSON.stringify({ ref, result });
      for (const forbidden of [
        root,
        parent,
        repoRoot,
        homedir(),
        tmpdir(),
        "dummy-snapshot-key",
        "OPENAI_API_KEY",
        "/.git",
      ]) {
        expect(envelope, `the result must not carry ${forbidden}`).not.toContain(forbidden);
      }
      for (const key of Object.keys(result)) {
        expect(key).not.toMatch(/path|root|cwd|dir$|pwd|key|token|secret/i);
      }
    });
  });
});
