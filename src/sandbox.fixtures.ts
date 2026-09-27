import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

/** Prefix `createSandbox` stamps on every temp root. */
export const sandboxPrefix = "nexus-sandbox-";

/** Temp sandbox roots that have not been disposed yet. Lets a test observe cleanup without a path. */
export async function liveSandboxRoots(): Promise<string[]> {
  const entries = await readdir(tmpdir(), { withFileTypes: true });
  return entries
    .filter((entry) => entry.name.startsWith(sandboxPrefix))
    .map((entry) => entry.name)
    .sort();
}

/** What a sandbox wrote as its runtime config, so a test can assert what was and was not granted. */
export async function readSandboxConfig(root: string): Promise<string> {
  return readFile(join(root, "config", "default.yaml"), "utf8");
}

export async function listRoot(root: string): Promise<string[]> {
  return (await readdir(root)).sort();
}

/** A directory no sandbox owns, for symlink-escape and absolute-path targets. */
export async function createOutsideDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "nexus-outside-"));
}

export async function plantEscapeLink(workspace: string, target: string, name = "escape"): Promise<string> {
  const link = join(workspace, name);
  await symlink(target, link);
  return link;
}

export interface NetworkProbe {
  calls(): number;
  restore(): void;
}

/** In-process fetch stub that fails loudly: a sandbox must never reach the network. */
export function denyNetwork(): NetworkProbe {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("network access is not available in the sandbox");
  }) as typeof globalThis.fetch;
  return {
    calls: () => calls,
    restore: () => {
      globalThis.fetch = previous;
    },
  };
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

async function digestPath(target: string, root: string, hash: ReturnType<typeof createHash>): Promise<void> {
  const info = await lstat(target);
  const label = relative(root, target);
  if (info.isSymbolicLink()) {
    hash.update(`l ${label} ${await readlink(target)}\n`);
    return;
  }
  if (info.isDirectory()) {
    hash.update(`d ${label} ${info.mode & 0o777}\n`);
    const entries = await readdir(target, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      await digestPath(join(target, entry.name), root, hash);
    }
    return;
  }
  const content = await readFile(target);
  const checksum = createHash("sha256").update(content).digest("hex");
  hash.update(`f ${label} ${info.mode & 0o777} ${content.length} ${checksum}\n`);
}

async function digest(target: string): Promise<string> {
  const hash = createHash("sha256");
  try {
    await digestPath(target, dirname(target), hash);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return "absent";
    throw error;
  }
  return hash.digest("hex");
}

export interface ProtectedTree {
  label: string;
  path: string;
}

export type TreeSnapshot = Readonly<Record<string, string>>;

/** Host trees a sandbox run must leave byte-identical: the repo overlay, its data mount, and home. */
export function protectedTrees(repoRoot: string): readonly ProtectedTree[] {
  return [
    { label: "repo/user", path: join(repoRoot, "user") },
    { label: "repo/data", path: join(repoRoot, "data") },
    { label: "repo/config", path: join(repoRoot, "config") },
    { label: "repo/AGENTS.md", path: join(repoRoot, "AGENTS.md") },
    { label: "repo/TASKS.md", path: join(repoRoot, "TASKS.md") },
    { label: "home/nexus-user", path: join(homedir(), ".config", "nexus", "user") },
  ];
}

/** Content digest per protected tree; compared before and after a run to prove nothing was touched. */
export async function snapshotTrees(trees: readonly ProtectedTree[]): Promise<TreeSnapshot> {
  const snapshot: Record<string, string> = {};
  for (const tree of trees) snapshot[tree.label] = await digest(tree.path);
  return Object.freeze(snapshot);
}

export async function writeFileIn(root: string, name: string, content: string): Promise<string> {
  await mkdir(root, { recursive: true });
  const file = join(root, name);
  await writeFile(file, content, "utf8");
  return file;
}

/** Real git, read-only: `shell: false`, fixed argv, so nothing here can act on a workspace. */
export function gitOut(root: string, ...args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", [...args], { cwd: root, shell: false, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

/** `status --porcelain`: the one command a restored workspace has to come back empty from. */
export async function gitStatus(root: string): Promise<string> {
  return gitOut(root, "status", "--porcelain", "--untracked-files=all");
}

/**
 * The adoption trap, planted for real: a gitfile makes a plain `git` treat this workspace as another
 * repository's worktree, so a naive baseline would commit into — and reset — the repository on the
 * other end of the pointer.
 */
export async function plantGitfile(workspace: string, gitDir: string): Promise<string> {
  const file = join(workspace, ".git");
  await writeFile(file, `gitdir: ${gitDir}\n`, "utf8");
  return file;
}

/**
 * Points `TMPDIR` at a directory of its own, so a test can prove that a refused sandbox left nothing
 * behind without racing the temp roots of the other suites running in parallel. `restore` is the
 * caller's to call: a leaked TMPDIR would send every later sandbox somewhere unexpected.
 */
export async function ownTempRoot(): Promise<{ entries(): Promise<string[]>; restore(): void }> {
  const dir = await mkdtemp(join(tmpdir(), "nexus-own-tmp-"));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  return {
    entries: async () => (await readdir(dir)).sort(),
    restore: () => {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    },
  };
}

export async function removeTree(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}
