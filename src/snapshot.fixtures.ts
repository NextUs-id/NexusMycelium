import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";

/** Prefix every snapshot workspace carries, so a leaked root is recognizable in the OS temp dir. */
export const snapshotPrefix = "nexus-snapshot-";

const gitTimeoutMs = 10_000;

/** A fresh temp workspace outside the repo `data/` mount, so no test ever sees real user state. */
export function createWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), snapshotPrefix));
}

export async function plantFile(root: string, name: string, content: string): Promise<string> {
  const file = join(root, ...name.split("/"));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  return file;
}

export type TreeBytes = Readonly<Record<string, string>>;

/**
 * Every file in the workspace as base64, keyed by its workspace-relative path. `.git` is skipped so
 * the same tree can be compared before and after a commit. Byte-exact, so a restore that rewrote a
 * file with the same length still fails the comparison.
 */
export async function treeBytes(root: string): Promise<TreeBytes> {
  const files: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      files[relative(root, full).split(sep).join("/")] = (await readFile(full)).toString("base64");
    }
  };
  await walk(root);
  return Object.freeze(files);
}

/** Whether a real `git` is on PATH, so the suite skips instead of failing on a machine without it. */
export async function gitAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("git", ["--version"], { shell: false, timeout: 5000 }, (error) => resolve(error === null));
  });
}

/**
 * Test-only `git` with the host's own environment, so an assertion can read what the module did
 * (author, config, remote) without the module's scrubbing getting in the way.
 */
export function gitOut(root: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { cwd: root, shell: false, timeout: gitTimeoutMs },
      (error, stdout, stderr) => {
        if (error !== null) reject(new Error(String(stderr ?? error.message)));
        else resolve(stdout);
      },
    );
  });
}
