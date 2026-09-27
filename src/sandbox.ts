import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { AgentLimits, AgentResult } from "../kernel/src/agent.js";
import { pluginConfig, type ResolvedConfig } from "../kernel/src/config.js";
import type { ToolRegistry } from "../kernel/src/tools.js";
import { createRuntime } from "./runtime.js";
import { createSnapshot, restoreSnapshot } from "./snapshot.js";

/** Every plugin that can own `tool:core` carries its own `root`, so each one has to be confined. */
const toolPlugins = ["tools-basic", "tools-core"] as const;

/** Name of the tools root inside the temp runtime root; relative so the kernel enforces containment. */
const workspaceName = "workspace";

const defaultShellTimeoutMs = 5000;

export interface SandboxShellPolicy {
  /** Explicit allowlist. Omitted or empty means no executable may run at all. */
  allow?: readonly string[];
  deny?: readonly string[];
  timeoutMs?: number;
}

export interface SandboxOptions {
  /**
   * The only way to widen shell access. Omitted, the sandbox denies every executable twice over:
   * `permissions.shell: deny` plus a `["*"]` tools deny list.
   */
  shell?: SandboxShellPolicy;
  limits?: Partial<AgentLimits>;
  signal?: AbortSignal;
  /**
   * Opt-in: baseline the workspace before every task and restore it after, whatever the outcome was.
   * Off by default, so an existing run keeps its current result shape and costs no git child process.
   */
  snapshot?: boolean;
}

export interface SandboxRunOptions {
  limits?: Partial<AgentLimits>;
  signal?: AbortSignal;
  /** Decides this run alone, overriding the sandbox-wide choice. */
  snapshot?: boolean;
}

/**
 * What the CLI host seam hands over. `root` is validated and then deliberately never read: adopting
 * the caller's runtime root is the one route from a sandbox to `user/config.yaml` and a provider key.
 * A `type`, so it stays structurally identical to the `SandboxRequest` in cli.ts.
 *
 * `snapshot` is the one additive field: it is optional, so cli.ts's narrower request still satisfies
 * this type, and since the CLI never sets it `run --sandbox` keeps its exact four-key envelope.
 */
export type SandboxRequest = {
  root: string;
  task: string;
  provider: "mock";
  permissions: { network: "deny"; shell: "deny" };
  /** Ask for a git baseline around the task. Checked, then honored: this one really changes behavior. */
  snapshot?: boolean;
};

/** A request, or just the task: shorthand for the same offline run. */
export type SandboxRun = SandboxRequest | string;

export type SandboxOutcome = {
  status: AgentResult["status"];
  steps: number;
  toolCalls: number;
  error?: string;
  /** Only on a snapshotted run: the workspace was baselined before the task and restored after it. */
  snapshot?: boolean;
  /** Only alongside `snapshot`: false means the restore did not finish, so the workspace is not at the baseline. */
  rolledBack?: boolean;
};

/**
 * A closed envelope: no text, no path, no config rides along. A `type`, not an interface, so it keeps
 * the implicit index signature that makes it assignable to the `SandboxResult` the CLI casts to.
 */
export type SandboxResult = {
  status: AgentResult["status"];
  steps: number;
  toolCalls: number;
  error?: string;
  snapshot?: boolean;
  rolledBack?: boolean;
  /** True only after the temp tree was verified gone. */
  workspaceCleaned: boolean;
};

export interface Sandbox {
  /** Temp runtime root, for a caller that has to inspect or seed it. Never part of a result. */
  readonly root: string;
  readonly workspace: string;
  readonly config: ResolvedConfig;
  /** Live registry of the sandboxed runtime: the same tools the agent may call. */
  readonly tools: ToolRegistry;
  run(task: string, options?: SandboxRunOptions): Promise<SandboxOutcome>;
  /** Close the runtime and delete the temp tree. Single-flight and idempotent. */
  dispose(): Promise<boolean>;
}

function inside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

function yamlList(values: readonly string[], name: string): string {
  const entries = values.map((value) => {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`sandbox ${name} entries must be non-empty strings`);
    }
    return JSON.stringify(value);
  });
  return entries.length === 0 ? "[]" : `[${entries.join(", ")}]`;
}

/**
 * The whole runtime config of a sandbox: no user overlay is read, so no key, base URL, or network
 * grant from the host can reach it. An absolute `tools.root` would bypass the kernel's containment
 * check, so the root stays relative and the kernel resolves it under the temp root.
 */
function sandboxConfig(shell: SandboxShellPolicy): string {
  const allow = shell.allow ?? [];
  const deny = shell.deny ?? (allow.length === 0 ? ["*"] : []);
  return [
    "model:",
    "  provider: mock",
    "  model: mock",
    "tools:",
    `  root: ${workspaceName}`,
    "  shell:",
    `    allow: ${yamlList(allow, "shell.allow")}`,
    `    deny: ${yamlList(deny, "shell.deny")}`,
    `    timeoutMs: ${shell.timeoutMs ?? defaultShellTimeoutMs}`,
    "permissions:",
    "  fs.read: allow",
    "  fs.write: allow",
    `  shell: ${allow.length === 0 ? "deny" : "allow"}`,
    "  network: deny",
    "",
  ].join("\n");
}

/**
 * Fail closed: the kernel already confines a tool root to the runtime root, but "inside the temp
 * root" is not "is the workspace" — the runtime root also holds `config/` and the empty `user/`
 * scope. So the resolved config is verified, not trusted, before any run.
 */
export function assertSandboxEnforced(config: ResolvedConfig, workspace: string): void {
  const refuse = (reason: string): never => {
    throw new Error(`sandbox configuration is not enforceable: ${reason}`);
  };
  if (typeof workspace !== "string" || !isAbsolute(workspace)) refuse("workspace is not an absolute path");
  if (config.permissions.network !== "deny") refuse("network is not denied");
  if (config.model.provider !== "mock") refuse("provider is not the hermetic mock");
  if (!inside(workspace, config.tools.root)) refuse("tools.root is outside the workspace");
  for (const name of toolPlugins) {
    const root = pluginConfig(config, name).root;
    if (typeof root !== "string" || !isAbsolute(root) || !inside(workspace, root)) {
      refuse(`plugins.${name}.root is outside the workspace`);
    }
  }
}

function outcome(result: AgentResult): SandboxOutcome {
  return {
    status: result.status,
    steps: result.steps,
    toolCalls: result.toolCalls,
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

/**
 * Never throws. The run already has an outcome, so a restore that cannot finish is reported as
 * `rolledBack: false` — the one thing the caller needs to know — rather than as a thrown error whose
 * message could carry a path out of the closed envelope. Not silent: the flag is the report.
 */
async function restoreQuietly(workspace: string, commit: string): Promise<boolean> {
  try {
    return (await restoreSnapshot(workspace, commit)).restored;
  } catch {
    return false;
  }
}

export async function createSandbox(options: SandboxOptions = {}): Promise<Sandbox> {
  if (options === null || typeof options !== "object") throw new Error("sandbox options must be an object");
  // OS temp, never the repo `data/` mount: a run cannot read or overwrite host state.
  const root = await mkdtemp(join(tmpdir(), "nexus-sandbox-"));
  const remove = async (): Promise<boolean> => {
    await rm(root, { recursive: true, force: true });
    return stat(root).then(
      () => false,
      () => true,
    );
  };
  let disposal: Promise<boolean> | undefined;
  try {
    await mkdir(join(root, "config"), { recursive: true });
    // An empty user scope, so the repo overlay and the home secret scope are both out of reach.
    await mkdir(join(root, "user"), { recursive: true });
    await mkdir(join(root, workspaceName), { recursive: true });
    // Canonical, so containment is compared through any symlink the temp path itself contains.
    const workspace = await realpath(join(root, workspaceName));
    await writeFile(join(root, "config", "default.yaml"), sandboxConfig(options.shell ?? {}), "utf8");
    const runtime = await createRuntime({ root, modelProvider: "mock" });
    try {
      assertSandboxEnforced(runtime.config, workspace);
    } catch (error) {
      await runtime.close();
      throw error;
    }
    const dispose = (): Promise<boolean> =>
      (disposal ??= (async () => {
        await runtime.close();
        return remove();
      })());
    const run = async (task: string, runOptions: SandboxRunOptions = {}): Promise<SandboxOutcome> => {
      if (disposal !== undefined) throw new Error("sandbox is disposed");
      if (typeof task !== "string" || task.length === 0) throw new Error("task must be a non-empty string");
      // Always the temp workspace, never `request.root`: the baseline git repository is the only
      // repository a sandbox may own, and the snapshot module refuses a checkout outright.
      const commit =
        (runOptions.snapshot ?? options.snapshot) === true ? await createSnapshot(workspace) : undefined;
      // Forwarded as-is: the agent owns its own timeout, the caller owns its own signal.
      const result = await runtime.runner.run(task, {
        limits: { ...options.limits, ...runOptions.limits },
        signal: runOptions.signal ?? options.signal,
      });
      const base = outcome(result);
      if (commit === undefined) return base;
      // Every reported outcome is restored — completed, error, stopped — and always before dispose.
      return { ...base, snapshot: true, rolledBack: await restoreQuietly(workspace, commit) };
    };
    return { root, workspace, config: runtime.config, tools: runtime.tools, run, dispose };
  } catch (error) {
    await remove();
    throw error;
  }
}

/**
 * Checked, never honored. Every field is validated so a malformed or widened request fails closed at
 * the seam, and none of them can grant access: the sandbox builds its own offline config instead.
 */
function offlineTask(request: SandboxRun): string {
  if (typeof request === "string") return request;
  if (request === null || typeof request !== "object") {
    throw new Error("sandbox request must be an object or a task string");
  }
  if (request.provider !== "mock") {
    throw new Error(`sandbox runs are offline; provider ${String(request.provider)} is refused`);
  }
  if (request.permissions?.network !== "deny" || request.permissions?.shell !== "deny") {
    throw new Error("sandbox runs deny network and shell; a request cannot widen them");
  }
  if (typeof request.root !== "string" || request.root.length === 0 || request.root.includes("\0")) {
    throw new Error("sandbox request requires a root path");
  }
  if (typeof request.task !== "string" || request.task.length === 0) {
    throw new Error("task must be a non-empty string");
  }
  // The only request field that changes what runs, so it is checked instead of coerced: a caller that
  // passes a string here gets a refusal rather than a silent truthy.
  if (request.snapshot !== undefined && typeof request.snapshot !== "boolean") {
    throw new Error("sandbox request snapshot must be a boolean");
  }
  return request.task;
}

/** One hermetic run: create, run, then close and delete the temp tree whatever the outcome was. */
export async function runInSandbox(
  request: SandboxRun,
  options: SandboxOptions = {},
): Promise<SandboxResult> {
  const task = offlineTask(request);
  // A request that asks for a snapshot wins over the sandbox default; a silent one leaves it alone.
  const snapshot = typeof request === "string" ? undefined : request.snapshot;
  const sandbox = await createSandbox({ ...options, snapshot: snapshot ?? options.snapshot });
  try {
    return { ...(await sandbox.run(task, options)), workspaceCleaned: await sandbox.dispose() };
  } finally {
    await sandbox.dispose();
  }
}
