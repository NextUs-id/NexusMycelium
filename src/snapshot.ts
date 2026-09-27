import { type ChildProcess, spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

/**
 * Past 20s so a real `git` on a slow mount is never mistaken for a wedged one, and under 45s so a
 * wedged one is still cut off well inside a caller's patience. A child that ignores SIGTERM gets
 * SIGKILL after the grace, and a child that somehow survives that is reported anyway.
 */
const gitTimeoutMs = 30_000;
const killGraceMs = 500;
/** Bytes of stdout+stderr one git child may produce before it is stopped. */
const gitMaxOutput = 8 * 1024 * 1024;
/**
 * A child's own words help once. Kept well under 200 characters so a flooding child cannot smuggle
 * its payload into an error message, which is the one place a caller is guaranteed to read.
 */
const reasonLimit = 160;

const commitPattern = /^[0-9a-f]{7,40}$/i;

/** No git verb used here touches the network; these only keep a child from being hijacked. */
const gitPrefix = ["-c", `core.hooksPath=${devNull}`, "-c", "commit.gpgsign=false"] as const;

export type SnapshotResult = {
  /** Commit sha the workspace now sits on. A sha, never a path. */
  commit: string;
  restored: true;
  /**
   * Workspace-relative paths the restore changed or removed, sorted. Ignored files never appear:
   * they are outside the snapshot, so a restore cannot claim to have touched them.
   */
  changedFiles: string[];
};

export interface SnapshotOptions {
  root: string;
  /** Ceiling on one git child. Overridable so a caller can prove the ceiling exists. */
  timeoutMs?: number;
  /** Bytes of stdout+stderr one git child may produce before it is stopped. */
  maxOutput?: number;
}

export interface SnapshotSession {
  /** Record the current workspace state as a restorable commit, and return its ref. */
  take(): Promise<string>;
  /** One call back to that state. */
  restore(ref: string): Promise<SnapshotResult>;
}

// ponytail: PATH and LC_ALL are the whole environment. No HOME, no API keys, and GIT_CONFIG_*
// point git's own config lookup at nothing, so a developer's ~/.gitconfig cannot set an identity, a
// clean/smudge filter, a hook path, or a credential helper. Add a key only if git truly cannot start.
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
  const path = process.env.PATH;
  if (typeof path === "string" && path.length > 0) env.PATH = path;
  return env;
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    // A negative pid targets the whole process group `detached: true` created, so a shell wrapper's
    // own children die with it. Killing only the wrapper leaves its `sleep` holding the pipes open,
    // and the caller would wait on a child that is already gone.
    process.kill(-pid, signal);
  } catch {
    // Group already reaped, or the platform has no group semantics.
  }
}

type Outcome = { ok: true; stdout: string } | { ok: false; message: string };

function reason(text: string, code: number | null): string {
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  const found = line ?? `exited with code ${code ?? "unknown"}`;
  return found.length > reasonLimit ? `${found.slice(0, reasonLimit)}…` : found;
}

type Limits = { timeoutMs: number; maxOutput: number };

function limitsOf(options: Partial<SnapshotOptions>): Limits {
  const { timeoutMs, maxOutput } = options;
  return {
    timeoutMs:
      typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : gitTimeoutMs,
    maxOutput:
      typeof maxOutput === "number" && Number.isFinite(maxOutput) && maxOutput > 0 ? maxOutput : gitMaxOutput,
  };
}

/** One git child: `shell: false` and a fixed argv, so a workspace name can never become a command, and
 * every outcome bounded — deadline, output cap, error text. Nothing resolves until the child and its
 * pipes are gone, so a caller never races a dying process.
 */
function run(args: readonly string[], cwd: string, limits: Limits): Promise<Outcome> {
  return new Promise((resolve) => {
    const verb = args[0] ?? "child";
    const child = spawn("git", [...gitPrefix, ...args], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: gitEnv(),
    });
    const timers: ReturnType<typeof setTimeout>[] = [];
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let overflow = false;
    let timedOut = false;
    let settled = false;
    const finish = (outcome: Outcome): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      resolve(outcome);
    };
    const collect =
      (target: "stdout" | "stderr") =>
      (chunk: Buffer): void => {
        bytes += chunk.length;
        if (bytes > limits.maxOutput) {
          // Stop the flood before it can exhaust this process's memory or an error message.
          overflow = true;
          signalGroup(child, "SIGKILL");
          return;
        }
        if (target === "stdout") stdout += chunk.toString("utf8");
        else stderr += chunk.toString("utf8");
      };
    timers.push(
      setTimeout(() => {
        timedOut = true;
        signalGroup(child, "SIGTERM");
        timers.push(setTimeout(() => signalGroup(child, "SIGKILL"), killGraceMs));
        timers.push(
          setTimeout(
            () => finish({ ok: false, message: `git ${verb} timed out after ${limits.timeoutMs}ms` }),
            2000,
          ),
        );
      }, limits.timeoutMs),
    );
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    child.on("error", (error) => {
      finish({
        ok: false,
        message:
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? "git is not available on PATH"
            : `git ${verb} could not start: ${error.message}`,
      });
    });
    child.on("close", (code) => {
      if (timedOut) finish({ ok: false, message: `git ${verb} timed out after ${limits.timeoutMs}ms` });
      else if (overflow)
        finish({ ok: false, message: `git ${verb} exceeded its ${limits.maxOutput} byte output cap` });
      else if (code === 0) finish({ ok: true, stdout });
      else finish({ ok: false, message: `git ${verb} failed: ${reason(stderr, code)}` });
    });
  });
}

/** Fail closed: any non-zero exit, a timeout, an overflow, or a missing binary is an error. */
async function git(args: readonly string[], cwd: string, limits: Limits): Promise<string> {
  const outcome = await run(args, cwd, limits);
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome.stdout;
}

/** The one lookup whose failure is allowed to be swallowed: it only ever adds a refusal. */
async function tryGit(args: readonly string[], cwd: string, limits: Limits): Promise<string | undefined> {
  const outcome = await run(args, cwd, limits);
  return outcome.ok ? outcome.stdout : undefined;
}

function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * The canonical workspace root, or a refusal. Two rules, each closing a different door:
 *  1. an existing absolute directory strictly inside the OS temp dir, which is what makes `..`
 *     traversal, `/`, `$HOME`, and the developer repo itself unusable as a target — realpath'ing
 *     first means a symlink aimed at any of them is refused by the same comparison;
 *  2. git must place the root's own `.git` as the repository's git dir, or report no repository at
 *     all. A root that is genuinely its own repository is allowed — it is the caller's own
 *     workspace, and git is initialized only when the root has none.
 *
 * Rule 2 compares git's answer, because a `.git` *file* is enough to point a root at somebody else's
 * object store: a planted worktree pointer reports the developer's git dir while the directory itself
 * looks like an ordinary repo, and committing through it would write the developer's history. Nothing
 * here creates the root, so a refusal cannot leave a directory behind on its way out.
 */
async function canonicalRoot(root: string, limits: Limits): Promise<string> {
  if (typeof root !== "string" || root.length === 0 || root.includes("\0")) {
    throw new Error("snapshot root must be a path");
  }
  if (!isAbsolute(root)) throw new Error("snapshot root must be an absolute path");
  if (!(await stat(root).catch(() => undefined))?.isDirectory()) {
    throw new Error("snapshot root must be an existing directory");
  }
  const canonical = await realpath(root);
  // Strictly inside: the temp dir itself is a shared parent, never a workspace to `git init`.
  const fromTemp = relative(await realpath(tmpdir()), canonical);
  if (fromTemp === "" || fromTemp.startsWith("..") || isAbsolute(fromTemp)) {
    throw new Error("snapshot root must be an existing directory inside the OS temp directory");
  }
  // Always asked, even when a `.git` is already here: a planted pointer is a `.git` *file*, and only
  // git can tell a real repository from one whose object store lives somewhere else.
  const reported = await tryGit(["rev-parse", "--absolute-git-dir"], canonical, limits);
  if (reported === undefined) return canonical;
  const resolved = await realpath(reported.trim()).catch(() => undefined);
  const own = await realpath(join(canonical, ".git")).catch(() => undefined);
  if (resolved === undefined || resolved !== own) {
    throw new Error("snapshot refuses a git checkout; pass a workspace that is not a repository");
  }
  return canonical;
}

/** What a restore has to undo: tracked edits, deletions, renames, and untracked files. */
async function changedFiles(root: string, limits: Limits): Promise<string[]> {
  const porcelain = await git(["status", "--porcelain", "-z", "--untracked-files=all"], root, limits);
  const files = new Set<string>();
  const entries = porcelain.split("\0");
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    // "XY path": two statuses, a space, then the path. With -z paths are raw, never quoted.
    if (entry === undefined || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    // A rename or copy is followed by its own NUL-terminated source path; only the target counts.
    if (status.startsWith("R") || status.startsWith("C")) index += 1;
    if (path.length === 0 || isAbsolute(path) || path === ".." || path.startsWith("../")) continue;
    files.add(path);
  }
  return [...files].sort();
}

/** An opened workspace: the canonical root, with git present and able to commit without a host. */
interface Context {
  workspace: string;
  limits: Limits;
}

async function open(root: string, limits: Limits): Promise<Context> {
  const workspace = await canonicalRoot(root, limits);
  if (!(await exists(join(workspace, ".git")))) {
    await git(["init", "--quiet"], workspace, limits);
    // Local identity: there is no HOME and no global config, so a commit needs nothing from the host.
    await git(["config", "user.name", "nexus"], workspace, limits);
    await git(["config", "user.email", "nexus@localhost"], workspace, limits);
  }
  return { workspace, limits };
}

/**
 * Baseline commit of a caller-supplied temp workspace, returned as a sha. `add -A` stages the whole
 * tree, nested files and deletions included, and leaves ignored files out by design. `--allow-empty`:
 * an untouched workspace is still a state worth restoring to.
 */
async function take({ workspace, limits }: Context): Promise<string> {
  await git(["add", "-A", "--", "."], workspace, limits);
  await git(["commit", "--quiet", "--allow-empty", "-m", "nexus snapshot"], workspace, limits);
  return (await git(["rev-parse", "HEAD"], workspace, limits)).trim();
}

/**
 * One command returns the workspace to a snapshot: `reset --hard` for tracked edits and deletions,
 * then `clean -fd`. The commit is verified as a real commit object *before* anything is touched and
 * the result is re-read afterwards, so a missing or corrupt commit fails closed with the workspace
 * exactly as the task left it.
 *
 * Ignored files are deliberately out of scope. `clean -fd` never takes `-x`, so build output, caches,
 * and anything a `.gitignore` names survive a restore untouched, and a file that was ignored can be
 * neither resurrected nor invented by one — exactly as a developer's own `git checkout` leaves them.
 */
async function restore({ workspace, limits }: Context, commit: string): Promise<SnapshotResult> {
  if (typeof commit !== "string" || !commitPattern.test(commit.trim())) {
    throw new Error("snapshot commit must be a hex sha");
  }
  const target = (
    await git(["rev-parse", "--verify", `${commit.trim()}^{commit}`], workspace, limits)
  ).trim();
  const before = await changedFiles(workspace, limits);
  await git(["reset", "--hard", "--quiet", target], workspace, limits);
  await git(["clean", "-fd", "-q"], workspace, limits);
  const head = (await git(["rev-parse", "HEAD"], workspace, limits)).trim();
  const after = await changedFiles(workspace, limits);
  if (head !== target || after.length > 0) {
    throw new Error("snapshot restore did not reach the requested commit");
  }
  return { commit: target, restored: true, changedFiles: before };
}

/**
 * Record the pre-task state of a temp workspace. Given a root it takes the baseline and returns its
 * sha; given options it returns a session, so a caller that wants several snapshots of one workspace
 * does not repeat the validation. One implementation, one refusal rule, both entry points.
 */
export function createSnapshot(root: string): Promise<string>;
export function createSnapshot(options: SnapshotOptions): Promise<SnapshotSession>;
export async function createSnapshot(target: string | SnapshotOptions): Promise<string | SnapshotSession> {
  if (typeof target === "string") return take(await open(target, limitsOf({})));
  if (target === null || typeof target !== "object") throw new Error("snapshot options must be an object");
  const context = await open(target.root, limitsOf(target));
  return { take: () => take(context), restore: (ref: string) => restore(context, ref) };
}

/** The flat half of the same operation: the session's `restore`, without holding a session. */
export function restoreSnapshot(root: string, commit: string): Promise<SnapshotResult> {
  return open(root, limitsOf({})).then((context) => restore(context, commit));
}
