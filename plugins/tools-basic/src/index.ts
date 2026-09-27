import { type ChildProcess, spawn } from "node:child_process";
import { constants, realpathSync } from "node:fs";
import { lstat, mkdir, open, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { definePlugin } from "../../../kernel/src/index.js";
import type { PermissionGate } from "../../../kernel/src/permissions.js";
import { type Tool, ToolRegistry } from "../../../kernel/src/tools.js";

const defaultMaxBytes = 1_000_000;
const maxOutput = 64_000;
const terminationGraceMs = 1000;
const truncationMarker = "\n[output truncated]";
const envAllowlist = ["PATH", "LANG", "LC_ALL", "TMPDIR"] as const;
const readInputSchema = z.object({ path: z.string().min(1) }).strict();
const writeInputSchema = z.object({ path: z.string().min(1), content: z.string() }).strict();
const shellInputSchema = z
  .object({
    executable: z.string().min(1),
    args: z.array(z.string()).max(100).default([]),
    cwd: z.string().min(1).optional(),
    timeoutMs: z.number().int().min(100).max(30_000).optional(),
  })
  .strict();

type ShellOptions = {
  allow: readonly string[];
  deny: readonly string[];
  timeoutMs: number;
};

type BasicToolsOptions = {
  root: string;
  permissions: PermissionGate;
  maxBytes?: number;
  shell?: Partial<ShellOptions>;
};

type ProcessResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function inside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

function assertPath(root: string, requested: string): string {
  if (requested.includes("\0")) throw new Error("tool path cannot contain NUL");
  const candidate = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
  if (!inside(root, candidate)) throw new Error("tool path escapes the configured root");
  return candidate;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("tool cancelled");
}

async function resolveExisting(root: string, requested: string): Promise<string> {
  const candidate = assertPath(root, requested);
  const real = await realpath(candidate);
  if (!inside(root, real)) throw new Error("tool path escapes the configured root through a symlink");
  return real;
}

async function nearestExistingParent(
  root: string,
  candidate: string,
): Promise<{ real: string; missing: string[] }> {
  let current = dirname(candidate);
  const missing: string[] = [];
  while (true) {
    try {
      const real = await realpath(current);
      if (!inside(root, real)) throw new Error("tool path escapes the configured root through a symlink");
      return { real, missing };
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(basename(current));
      current = parent;
    }
  }
}

async function createParent(root: string, candidate: string): Promise<string> {
  const parent = await nearestExistingParent(root, candidate);
  let real = parent.real;
  for (const segment of parent.missing.reverse()) {
    const next = resolve(real, segment);
    await mkdir(next);
    const nextReal = await realpath(next);
    if (!inside(root, nextReal)) throw new Error("tool path escapes the configured root through a symlink");
    real = nextReal;
  }
  return real;
}

async function resolveForWrite(root: string, requested: string): Promise<string> {
  const candidate = assertPath(root, requested);
  const parent = await createParent(root, candidate);
  const file = resolve(parent, basename(candidate));
  if (!inside(root, file)) throw new Error("tool path escapes the configured root");
  try {
    if ((await lstat(file)).isSymbolicLink()) {
      throw new Error("tool path cannot write through a symlink");
    }
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  return file;
}

function readSchema(): Readonly<Record<string, unknown>> {
  return {
    type: "object",
    properties: { path: { type: "string", minLength: 1 } },
    required: ["path"],
    additionalProperties: false,
  };
}

function writeSchema(): Readonly<Record<string, unknown>> {
  return {
    type: "object",
    properties: { path: { type: "string", minLength: 1 }, content: { type: "string" } },
    required: ["path", "content"],
    additionalProperties: false,
  };
}

function shellSchema(): Readonly<Record<string, unknown>> {
  return {
    type: "object",
    properties: {
      executable: { type: "string", minLength: 1 },
      args: { type: "array", items: { type: "string" }, maxItems: 100 },
      cwd: { type: "string", minLength: 1 },
      timeoutMs: { type: "integer", minimum: 100, maximum: 30_000 },
    },
    required: ["executable"],
    additionalProperties: false,
  };
}

function readTextTool(root: string, permissions: PermissionGate, maxBytes: number): Tool {
  return {
    name: "read_text",
    description: "Read a UTF-8 text file inside the configured root.",
    inputSchema: readSchema(),
    async execute(input, signal) {
      throwIfAborted(signal);
      const parsed = readInputSchema.parse(input);
      await permissions.check("fs.read", `read ${parsed.path}`);
      throwIfAborted(signal);
      const file = await resolveExisting(root, parsed.path);
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (info.size > maxBytes) throw new Error(`file exceeds the ${maxBytes}-byte limit`);
        const content = await handle.readFile({ encoding: "utf8" });
        if (Buffer.byteLength(content, "utf8") > maxBytes) {
          throw new Error(`file exceeds the ${maxBytes}-byte limit`);
        }
        return content;
      } finally {
        await handle.close();
      }
    },
  };
}

function writeTextTool(root: string, permissions: PermissionGate, maxBytes: number): Tool {
  return {
    name: "write_text",
    description: "Write a UTF-8 text file inside the configured root.",
    inputSchema: writeSchema(),
    async execute(input, signal) {
      throwIfAborted(signal);
      const parsed = writeInputSchema.parse(input);
      await permissions.check("fs.write", `write ${parsed.path}`);
      throwIfAborted(signal);
      const bytes = Buffer.byteLength(parsed.content, "utf8");
      if (bytes > maxBytes) throw new Error(`content exceeds the ${maxBytes}-byte limit`);
      const file = await resolveForWrite(root, parsed.path);
      throwIfAborted(signal);
      const handle = await open(
        file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(parsed.content, "utf8");
      } finally {
        await handle.close();
      }
      return JSON.stringify({ ok: true, path: parsed.path, bytes });
    },
  };
}

type OutputBuffer = {
  chunks: string[];
  bytes: number;
  truncated: boolean;
};

function createOutputBuffer(): OutputBuffer {
  return { chunks: [], bytes: 0, truncated: false };
}

function pushOutput(buffer: OutputBuffer, chunk: unknown): void {
  if (buffer.truncated) return;
  const text = typeof chunk === "string" ? chunk : String(chunk);
  const size = Buffer.byteLength(text, "utf8");
  if (buffer.bytes + size <= maxOutput) {
    buffer.chunks.push(text);
    buffer.bytes += size;
    return;
  }
  buffer.truncated = true;
  const room = maxOutput - buffer.bytes;
  if (room > 0) {
    const kept = Buffer.from(text, "utf8").subarray(0, room).toString("utf8");
    buffer.chunks.push(kept);
    buffer.bytes += Buffer.byteLength(kept, "utf8");
  }
}

function renderOutput(buffer: OutputBuffer): string {
  const text = buffer.chunks.join("");
  return buffer.truncated ? text + truncationMarker : text;
}

// ponytail: only PATH/LANG/LC_ALL/TMPDIR cross the boundary; the child sees no
// API keys, no HOME, and nothing else from the host. Add a key here only if a
// child genuinely cannot start without it.
function buildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of envAllowlist) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  return env;
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    // negative pid targets the whole process group created by detached: true
    process.kill(-pid, signal);
  } catch {
    // group already reaped, or the platform has no group semantics
  }
}

function runProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  return new Promise((resolveProcess, reject) => {
    if (signal?.aborted) {
      reject(new Error("shell tool cancelled"));
      return;
    }
    const child = spawn(executable, [...args], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: buildEnv(),
    });
    const stdout = createOutputBuffer();
    const stderr = createOutputBuffer();
    let settled = false;
    let terminationError: unknown;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    const clearTimers = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (hardTimer) clearTimeout(hardTimer);
    };
    const finish = (error?: unknown, value?: ProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else if (value) resolveProcess(value);
      else reject(new Error("shell process ended without a result"));
    };
    const destroyIo = (): void => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    // A child that keeps the stdout pipe open never emits "close", so the hard
    // timer settles the promise on its own and stops waiting for the pipe.
    const hardKill = (error: unknown): void => {
      destroyIo();
      signalGroup(child, "SIGKILL");
      finish(error);
    };
    const terminate = (error: unknown): void => {
      if (settled || terminationError !== undefined) return;
      terminationError = error;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      signalGroup(child, "SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled) {
          destroyIo();
          signalGroup(child, "SIGKILL");
        }
      }, terminationGraceMs);
      hardTimer = setTimeout(() => {
        if (!settled) hardKill(error);
      }, terminationGraceMs * 2);
    };
    const abort = (): void => terminate(new Error("shell tool cancelled"));
    child.stdout?.on("data", (chunk: unknown) => {
      pushOutput(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: unknown) => {
      pushOutput(stderr, chunk);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code, closeSignal) => {
      if (terminationError !== undefined) {
        // the group leader is gone but descendants may still be running, and the
        // group is the unit of cleanup, so escalate even though the leader closed
        hardKill(terminationError);
        return;
      }
      finish(undefined, {
        code,
        signal: closeSignal,
        stdout: renderOutput(stdout),
        stderr: renderOutput(stderr),
      });
    });
    timeoutTimer = setTimeout(() => {
      terminate(new Error(`shell tool timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function shellTool(root: string, permissions: PermissionGate, options: ShellOptions): Tool {
  const allowed = new Set(options.allow);
  const denied = new Set(options.deny);
  return {
    name: "shell",
    description: "Run an allowlisted executable with explicit arguments and no shell interpolation.",
    inputSchema: shellSchema(),
    async execute(input, signal) {
      throwIfAborted(signal);
      const parsed = shellInputSchema.parse(input);
      if (parsed.executable.includes("\0") || parsed.args.some((arg) => arg.includes("\0"))) {
        throw new Error("shell executable and arguments cannot contain NUL");
      }
      await permissions.check("shell", `run ${parsed.executable}`);
      throwIfAborted(signal);
      if (denied.has("*") || denied.has(parsed.executable)) {
        throw new Error(`shell executable is denied: ${parsed.executable}`);
      }
      if (!allowed.has(parsed.executable)) {
        throw new Error(`shell executable is not allowlisted: ${parsed.executable}`);
      }
      const cwd = parsed.cwd === undefined ? root : await resolveExisting(root, parsed.cwd);
      if (!(await stat(cwd)).isDirectory()) throw new Error("shell cwd must be a directory");
      const timeoutMs = Math.min(parsed.timeoutMs ?? options.timeoutMs, 30_000);
      throwIfAborted(signal);
      const result = await runProcess(parsed.executable, parsed.args, cwd, timeoutMs, signal);
      if (result.code !== 0) {
        throw new Error(`shell command failed: ${result.signal ?? `exit code ${result.code}`}`);
      }
      return JSON.stringify({ ok: true, ...result });
    },
  };
}

function configRecord(config: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = config[key];
  return isRecord(value) ? value : {};
}

function configRoot(config: Record<string, unknown>): string {
  const tools = configRecord(config, "tools");
  const value = tools.root ?? config.root;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("tools-basic root is required");
  }
  return value;
}

function configMaxBytes(config: Record<string, unknown>): number {
  const limits = configRecord(config, "limits");
  const value = config.maxBytes ?? config.maxSize ?? limits.maxBytes;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : defaultMaxBytes;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function configShell(config: Record<string, unknown>): ShellOptions {
  const shell = configRecord(config, "shell");
  const tools = configRecord(config, "tools");
  const nested = configRecord(tools, "shell");
  const source = Object.keys(shell).length > 0 ? shell : nested;
  const timeout = source.timeoutMs;
  return {
    allow: stringList(source.allow),
    deny: stringList(source.deny),
    timeoutMs:
      typeof timeout === "number" && Number.isInteger(timeout) && timeout >= 100
        ? Math.min(timeout, 30_000)
        : 5000,
  };
}

export function createBasicTools(options: BasicToolsOptions): ToolRegistry {
  if (typeof options.root !== "string" || options.root.length === 0) {
    throw new Error("tools-basic root is required");
  }
  const root = realpathSync(resolve(options.root));
  const maxBytes =
    options.maxBytes !== undefined && Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0
      ? options.maxBytes
      : defaultMaxBytes;
  const shellTimeout =
    options.shell?.timeoutMs !== undefined &&
    Number.isSafeInteger(options.shell.timeoutMs) &&
    options.shell.timeoutMs >= 100
      ? Math.min(options.shell.timeoutMs, 30_000)
      : 5000;
  const tools = new ToolRegistry();
  tools.register(readTextTool(root, options.permissions, maxBytes));
  tools.register(writeTextTool(root, options.permissions, maxBytes));
  tools.register(
    shellTool(root, options.permissions, {
      allow: options.shell?.allow ?? [],
      deny: options.shell?.deny ?? [],
      timeoutMs: shellTimeout,
    }),
  );
  return tools;
}

export default definePlugin({
  manifest: {
    name: "tools-basic",
    version: "0.1.0",
    apiVersion: 1,
    description: "Root-confined file tools and an allowlisted explicit-argument shell tool.",
    provides: ["tool:core"],
    permissions: ["fs.read", "fs.write", "shell"],
  },
  async setup({ config, permissions, services }) {
    const root = await realpath(resolve(configRoot(config)));
    if (!(await stat(root)).isDirectory()) throw new Error("tools root must be a directory");
    services.register(
      "tool:core",
      createBasicTools({ root, permissions, maxBytes: configMaxBytes(config), shell: configShell(config) }),
      "tools-basic",
    );
  },
});
