import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { definePlugin } from "../../../kernel/src/index.js";
import type { PermissionGate } from "../../../kernel/src/permissions.js";
import { type Tool, ToolRegistry } from "../../../kernel/src/tools.js";

const readInputSchema = z.object({ path: z.string().min(1) });
const writeInputSchema = z.object({ path: z.string().min(1), content: z.string().max(1_000_000) });
const shellInputSchema = z.object({
  executable: z.string().min(1),
  args: z.array(z.string()).max(100).default([]),
  cwd: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(100).max(30000).optional(),
});
const maxOutput = 64_000;
const terminationGraceMs = 100;

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function inside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

function assertRelativePath(value: string): void {
  if (value.includes("\0") || isAbsolute(value))
    throw new Error("tool path must be relative to the configured root");
}

async function resolveExisting(root: string, requested: string): Promise<string> {
  assertRelativePath(requested);
  const lexical = resolve(root, requested);
  if (!inside(root, lexical)) throw new Error("tool path escapes the configured root");
  const real = await realpath(lexical);
  if (!inside(root, real)) throw new Error("tool path escapes the configured root through a symlink");
  return real;
}

async function ensureParent(root: string, requested: string): Promise<string> {
  assertRelativePath(requested);
  const lexical = resolve(root, requested);
  if (!inside(root, lexical)) throw new Error("tool path escapes the configured root");
  const missing: string[] = [];
  let current = dirname(lexical);
  while (true) {
    try {
      let real = await realpath(current);
      if (!inside(root, real)) throw new Error("tool path escapes the configured root through a symlink");
      for (const segment of missing.reverse()) {
        const next = resolve(real, segment);
        await mkdir(next);
        real = await realpath(next);
        if (!inside(root, real)) throw new Error("tool path escapes the configured root through a symlink");
      }
      return real;
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(pathBasename(current));
      current = parent;
    }
  }
}

function pathBasename(value: string): string {
  const parts = value.split(/[\\/]/);
  return parts.at(-1) ?? value;
}

async function resolveForWrite(root: string, requested: string): Promise<string> {
  const parent = await ensureParent(root, requested);
  const lexical = resolve(root, requested);
  const candidate = resolve(parent, pathBasename(lexical));
  if (!inside(root, candidate)) throw new Error("tool path escapes the configured root");
  try {
    const real = await realpath(candidate);
    if (!inside(root, real)) throw new Error("tool path escapes the configured root through a symlink");
    return real;
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    return candidate;
  }
}

function inputSchemaForRead(): Readonly<Record<string, unknown>> {
  return { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
}

function inputSchemaForWrite(): Readonly<Record<string, unknown>> {
  return {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
  };
}

function inputSchemaForShell(): Readonly<Record<string, unknown>> {
  return {
    type: "object",
    properties: {
      executable: { type: "string" },
      args: { type: "array", items: { type: "string" } },
      cwd: { type: "string" },
      timeoutMs: { type: "integer" },
    },
    required: ["executable"],
  };
}

function readTextTool(root: string, permissions: PermissionGate): Tool {
  return {
    name: "read_text",
    description: "Read a UTF-8 text file inside the configured root.",
    inputSchema: inputSchemaForRead(),
    async execute(input) {
      const parsed = readInputSchema.parse(input);
      await permissions.check("fs.read", `read ${parsed.path}`);
      return readFile(await resolveExisting(root, parsed.path), "utf8");
    },
  };
}

function writeTextTool(root: string, permissions: PermissionGate): Tool {
  return {
    name: "write_text",
    description: "Write a UTF-8 text file inside the configured root.",
    inputSchema: inputSchemaForWrite(),
    async execute(input) {
      const parsed = writeInputSchema.parse(input);
      await permissions.check("fs.write", `write ${parsed.path}`);
      const file = await resolveForWrite(root, parsed.path);
      await writeFile(file, parsed.content, "utf8");
      return JSON.stringify({ ok: true, path: parsed.path, bytes: Buffer.byteLength(parsed.content) });
    },
  };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function appendOutput(current: string, chunk: unknown): string {
  const next = current + String(chunk);
  return next.length > maxOutput ? next.slice(0, maxOutput) : next;
}

function runProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolveProcess, reject) => {
    if (signal?.aborted) {
      reject(new Error("shell tool cancelled"));
      return;
    }
    const child = spawn(executable, [...args], { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let terminationError: Error | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (
      error?: unknown,
      result?: { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string },
    ): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else if (result) resolveProcess(result);
      else reject(new Error("shell process ended without a result"));
    };
    const terminate = (error: Error): void => {
      if (settled || terminationError) return;
      terminationError = error;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, terminationGraceMs);
    };
    const abort = (): void => terminate(new Error("shell tool cancelled"));
    child.stdout?.on("data", (chunk: unknown) => {
      stdout = appendOutput(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: unknown) => {
      stderr = appendOutput(stderr, chunk);
    });
    child.once("error", (error) => {
      if (!terminationError) finish(error);
    });
    child.once("close", (code, closeSignal) => {
      finish(terminationError, { code, signal: closeSignal, stdout, stderr });
    });
    timer = setTimeout(() => terminate(new Error(`shell tool timed out after ${timeoutMs}ms`)), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function shellTool(
  root: string,
  permissions: PermissionGate,
  allow: readonly string[],
  deny: readonly string[],
  defaultTimeoutMs: number,
): Tool {
  const allowed = new Set(allow);
  const denied = new Set(deny);
  return {
    name: "shell",
    description: "Run an allowlisted executable with explicit arguments and no shell interpolation.",
    inputSchema: inputSchemaForShell(),
    async execute(input, signal) {
      const parsed = shellInputSchema.parse(input);
      if (parsed.executable.includes("\0") || parsed.args.some((arg) => arg.includes("\0"))) {
        throw new Error("shell executable and arguments cannot contain NUL");
      }
      await permissions.check("shell", `${parsed.executable} ${parsed.args.join(" ")}`);
      if (denied.has("*") || denied.has(parsed.executable) || !allowed.has(parsed.executable)) {
        throw new Error(`shell executable is not allowlisted: ${parsed.executable}`);
      }
      const cwd = parsed.cwd ? await resolveExisting(root, parsed.cwd) : root;
      const cwdStat = await stat(cwd);
      if (!cwdStat.isDirectory()) throw new Error("shell cwd must be a directory");
      const result = await runProcess(
        parsed.executable,
        parsed.args,
        cwd,
        Math.min(parsed.timeoutMs ?? defaultTimeoutMs, 30000),
        signal,
      );
      if (result.code !== 0) {
        const status = result.signal ? `signal ${result.signal}` : `code ${result.code}`;
        throw new Error(`shell tool failed with ${status}`);
      }
      return JSON.stringify({ ok: true, ...result });
    },
  };
}

function configRoot(config: Record<string, unknown>): string {
  const tools =
    typeof config.tools === "object" && config.tools !== null && !Array.isArray(config.tools)
      ? (config.tools as Record<string, unknown>)
      : {};
  const value = tools.root ?? config.root;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("tools-core root is required");
  }
  return value;
}

function configShell(config: Record<string, unknown>): Record<string, unknown> {
  const value = config.shell;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export default definePlugin({
  manifest: {
    name: "tools-core",
    version: "0.1.0",
    apiVersion: 1,
    description: "Legacy-compatible root-confined file tools and an allowlisted shell tool.",
    provides: ["tool:core"],
    permissions: ["fs.read", "fs.write", "shell"],
  },
  async setup({ config, permissions, services }) {
    const root = await realpath(configRoot(config));
    if (!(await stat(root)).isDirectory()) throw new Error("tools root must be a directory");
    const shell = configShell(config);
    const tools: ToolRegistry = new ToolRegistry();
    tools.register(readTextTool(root, permissions));
    tools.register(writeTextTool(root, permissions));
    tools.register(
      shellTool(
        root,
        permissions,
        stringList(shell.allow),
        stringList(shell.deny),
        typeof shell.timeoutMs === "number" ? shell.timeoutMs : 5000,
      ),
    );
    services.register("tool:core", tools, "tools-core");
  },
});
