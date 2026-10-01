#!/usr/bin/env node

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentLimits, AgentStepRecord } from "../kernel/src/agent.js";
import { resolveBudgetPolicy } from "../kernel/src/agent.js";
import { resolveConfig } from "../kernel/src/config.js";
import type { ModelMessage } from "../kernel/src/model.js";
import { readCostReport, renderReport } from "./report.js";
import { createRuntime, type Runtime } from "./runtime.js";
import { createSessionStore, type SessionRecord, type SessionStore, sessionMessages } from "./session.js";

interface CliOptions {
  help: boolean;
  root?: string;
  model?: "mock" | "openai";
  session?: string;
  /** Opt-in: `run --sandbox <task>` hands the task to the sandbox host instead of the local runtime. */
  sandbox: boolean;
  /** Opt-in with --sandbox: ask the host for a baseline snapshot and a restore once the run is over. */
  snapshot?: boolean;
  task: string[];
  /** Test-only: read this trace file instead of the writer's default path. The CLI never sets it. */
  tracePath?: string;
}

/** The stored session a run appends to. `provider`/`model` come from history and must still match. */
interface SessionTarget {
  store: SessionStore;
  id: string;
  history?: ModelMessage[];
  provider?: string;
  model?: string;
  /** Limits the session's last run recorded; a resume continues under them, as `runSession` does. */
  limits?: Partial<AgentLimits>;
}

interface DashboardModule {
  startDashboardServer(options: { root: string }): Promise<{ url: string; close(): Promise<void> }>;
}

async function loadDashboardModule(): Promise<DashboardModule> {
  const path = import.meta.url.endsWith(".ts")
    ? "../scripts/dashboard-server.mjs"
    : "../../scripts/dashboard-server.mjs";
  return (await import(new URL(path, import.meta.url).href)) as DashboardModule;
}

/** Everything the sandbox host is asked for. The provider and the permissions are not caller-settable. */
export interface SandboxRequest {
  root: string;
  task: string;
  /** Always the offline mock: a sandbox run never reaches a live provider, so it never needs a key. */
  provider: "mock";
  permissions: { network: "deny"; shell: "deny" };
  /** Requested only by `--sandbox --snapshot`. The host owns the baseline and the restore; the CLI just asks. */
  snapshot?: true;
}

/** The host owns the result shape; the CLI only reads `status` and passes the envelope through. */
export interface SandboxResult {
  status: string;
  [key: string]: unknown;
}

export interface SandboxHost {
  runInSandbox(request: SandboxRequest): Promise<SandboxResult>;
}

async function loadSandboxHost(): Promise<SandboxHost> {
  // Resolved through a URL so the CLI compiles before the host module lands; the same seam `serve` uses.
  return (await import(new URL("./sandbox.js", import.meta.url).href)) as SandboxHost;
}

const helpText = `NexusMycelium CLI (command: nexus)

Usage:
  node dist/src/cli.js run [task] [--root PATH] [--model mock|openai] [--session ID]
  node dist/src/cli.js run --sandbox <task> [--root PATH]
  node dist/src/cli.js run --sandbox --snapshot <task> [--root PATH]
  node dist/src/cli.js session list
  node dist/src/cli.js session resume <id> <task> [--root PATH] [--model mock|openai]
  node dist/src/cli.js session fork <id> <newId> [atStep]
  node dist/src/cli.js serve [--root PATH]
  node dist/src/cli.js report [--root PATH]
  node dist/src/cli.js --help

Commands:
  run      Run one bounded agent task and print a JSON result.
  session  list, resume, or fork the stored sessions. Omitting atStep forks the whole session.
  serve    Serve the realtime task dashboard on 127.0.0.1:18765.
  report   Print the cost and token report read from the trace log.

The default model is offline mock. Network and shell permissions deny by default.

run --sandbox is opt-in and hands the task to the isolated sandbox host. It prints the same
one-line JSON result and uses the same exit codes as run. A sandbox run is offline by contract:
the mock provider, network, and shell are all denied, so it reads no user config, no provider
key, and no session store, and it rejects --model openai and --session.
run --sandbox --snapshot adds one request field: the host takes a baseline snapshot before the
run and restores it afterwards, so the command returns the workspace to its pre-run state. The
flag is refused without --sandbox, and a host that cannot snapshot still answers normally; only
its own status decides the exit code.
`;

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { help: false, sandbox: false, task: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) throw new Error("missing argument");
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--mock") {
      options.model = "mock";
      continue;
    }
    if (argument === "--sandbox") {
      options.sandbox = true;
      continue;
    }
    if (argument === "--snapshot") {
      options.snapshot = true;
      continue;
    }
    if (argument === "--model" || argument === "--root" || argument === "--session") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === "--root") options.root = value;
      else if (argument === "--session") options.session = value;
      else if (value === "mock" || value === "openai") options.model = value;
      else throw new Error("--model must be mock or openai");
      continue;
    }
    if (argument.startsWith("--root=")) {
      options.root = argument.slice("--root=".length);
      if (!options.root) throw new Error("--root requires a value");
      continue;
    }
    if (argument.startsWith("--session=")) {
      options.session = argument.slice("--session=".length);
      if (!options.session) throw new Error("--session requires a value");
      continue;
    }
    if (argument.startsWith("--model=")) {
      const value = argument.slice("--model=".length);
      if (value !== "mock" && value !== "openai") throw new Error("--model must be mock or openai");
      options.model = value;
      continue;
    }
    if (argument.startsWith("-")) throw new Error(`unknown option: ${argument}`);
    options.task.push(argument);
  }
  return options;
}

function addAbortSignal(controller: AbortController): () => void {
  const abort = (): void => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  return () => {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  };
}

/** Records the run header, refusing a stored session the runtime can no longer reproduce. */
async function startSession(session: SessionTarget, runtime: Runtime, task: string): Promise<string> {
  const { provider, model } = runtime.config.model;
  if (session.provider !== undefined && (session.provider !== provider || session.model !== model)) {
    throw new Error(
      `session ${session.id} used ${session.provider}/${session.model}, runtime is ${provider}/${model}`,
    );
  }
  return session.store.appendStart({ sessionId: session.id, provider, model, task });
}

async function runTask(options: CliOptions, session?: SessionTarget): Promise<number> {
  // Only the sandbox host can snapshot, so the flag is refused here instead of being ignored silently.
  if (options.snapshot) throw new Error("--snapshot requires --sandbox");
  // `--root` is optional in the usage line, so a run without one serves the repository, not the cwd.
  const runtime = await createRuntime({ root: options.root ?? repoRoot(), modelProvider: options.model });
  const controller = new AbortController();
  const removeSignalHandlers = addAbortSignal(controller);
  const task = options.task.join(" ") || "Summarize the NexusMycelium MVP in one sentence.";
  let code = 1;
  try {
    const id = session ? await startSession(session, runtime, task) : "";
    // The runner awaits `onStep` inline, so appends land in step order and a failed one stops the run.
    const result = await runtime.runner.run(task, {
      signal: controller.signal,
      history: session?.history,
      limits: session?.limits,
      onStep:
        session === undefined ? undefined : (record: AgentStepRecord) => session.store.appendStep(id, record),
      // Absent without a configured budget, so a default run keeps exactly the options it always had.
      ...(runtime.budget === undefined ? {} : { budget: runtime.budget }),
    });
    if (session) {
      await session.store.appendEnd(id, {
        status: result.status,
        text: result.text,
        error: result.error,
        ...(session.limits === undefined ? {} : { limits: session.limits }),
      });
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    code = result.status === "completed" ? 0 : 1;
  } finally {
    removeSignalHandlers();
    try {
      await runtime.close();
    } catch (error) {
      console.error(error);
      code = 1;
    }
  }
  return code;
}

/**
 * The sandbox path never builds a runtime: the local runtime resolves `user/` config, and that is the
 * only route to a provider key. The host is given the offline defaults instead, so a sandbox run
 * cannot reach a live provider no matter what the user config or the flags say.
 */
async function runSandbox(options: CliOptions, host?: SandboxHost): Promise<number> {
  if (options.model === "openai") throw new Error("--sandbox runs offline; --model openai is refused");
  if (options.session) throw new Error("--sandbox does not support --session");
  const task = options.task.join(" ");
  if (!task) throw new Error("run --sandbox requires a task");
  const { runInSandbox } = host ?? (await loadSandboxHost());
  const result = await runInSandbox({
    root: resolve(options.root ?? repoRoot()),
    task,
    provider: "mock",
    permissions: { network: "deny", shell: "deny" },
    // Absent for a plain `run --sandbox`, so that request is byte-for-byte what it always was.
    ...(options.snapshot ? { snapshot: true as const } : {}),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.status === "completed" ? 0 : 1;
}

async function sessionList(): Promise<number> {
  const sessions = await (await createSessionStore()).list();
  process.stdout.write(`${JSON.stringify({ sessions })}\n`);
  return 0;
}

async function sessionResume(options: CliOptions): Promise<number> {
  const id = options.task.shift();
  if (!id) throw new Error("session resume requires <id> <task>");
  const store = await createSessionStore();
  const records = await store.load(id);
  const start = records.find((record) => record.type === "run-start");
  if (!start) throw new Error(`session ${id} has no run-start record`);
  const lastEnd = records.filter((record) => record.type === "run-end").at(-1);
  return runTask(options, {
    store,
    id,
    history: sessionMessages(records),
    provider: start.provider,
    model: start.model,
    limits: lastEnd?.limits,
  });
}

function lastStep(records: readonly SessionRecord[]): number {
  return records.reduce(
    (highest, record) => (record.type === "run-step" ? Math.max(highest, record.step) : highest),
    0,
  );
}

async function sessionFork(options: CliOptions): Promise<number> {
  const id = options.task.shift();
  const newId = options.task.shift();
  if (!id || !newId) throw new Error("session fork requires <id> <newId> [atStep]");
  const store = await createSessionStore();
  const raw = options.task.shift();
  const atStep = raw === undefined ? lastStep(await store.load(id)) : Number(raw);
  const forked = await store.fork(id, atStep, newId);
  process.stdout.write(`${JSON.stringify({ session: { id: forked, atStep } })}\n`);
  return 0;
}

async function sessionCommand(options: CliOptions): Promise<number> {
  const subcommand = options.task.shift();
  if (subcommand === "list") return sessionList();
  if (subcommand === "resume") return sessionResume(options);
  if (subcommand === "fork") return sessionFork(options);
  throw new Error(`unknown session command: ${subcommand ?? "(missing)"}`);
}

function repoRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(directory, "package.json"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("cannot derive the repository root; pass --root PATH");
    directory = parent;
  }
}

async function serve(options: CliOptions): Promise<number> {
  const root = resolve(options.root ?? repoRoot());
  await resolveConfig(root);
  const { startDashboardServer } = await loadDashboardModule();
  const dashboard = await startDashboardServer({ root });
  process.stdout.write(`Dashboard ready: ${dashboard.url}\n`);
  return new Promise<number>((resolveShutdown) => {
    const shutdown = (): void => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      void Promise.resolve()
        .then(() => dashboard.close())
        .then(
          () => resolveShutdown(0),
          (error: unknown) => {
            console.error(error);
            resolveShutdown(1);
          },
        );
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

/**
 * The report is a read: it resolves config for the price map, then reads the trace log. It never
 * starts a runtime, never appends a record, and never runs a model.
 */
async function report(options: CliOptions, tracePath?: string): Promise<number> {
  const root = resolve(options.root ?? repoRoot());
  const config = await resolveConfig(root);
  // Priced through the kernel's own policy builder, so a price the report applies is one the guard
  // would have accepted. Read whether or not the guard is armed: the question is asked after the fact.
  const prices = resolveBudgetPolicy({
    enabled: true,
    ...(config.budget.prices === null ? {} : { prices: config.budget.prices }),
  }).prices;
  const result = await readCostReport({ ...(tracePath === undefined ? {} : { path: tracePath }), prices });
  if (!result.ok) {
    process.stderr.write(`${result.message}\n`);
    return 1;
  }
  process.stdout.write(`${renderReport(result.report)}\n`);
  return 0;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  host?: SandboxHost,
): Promise<number> {
  const options = parseArgs(argv);
  if (options.help || argv.length === 0) {
    process.stdout.write(helpText);
    return 0;
  }
  const command = options.task.shift();
  if (command === "run") {
    if (options.sandbox) return runSandbox(options, host);
    if (!options.session) return runTask(options);
    return runTask(options, { store: await createSessionStore(), id: options.session });
  }
  if (command === "session") return sessionCommand(options);
  if (command === "serve") return serve(options);
  if (command === "report") return report(options, options.tracePath);
  throw new Error(`unknown command: ${command ?? "(missing)"}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
