import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BudgetPolicy } from "../kernel/src/agent.js";
import type { ModelUsage } from "../kernel/src/model.js";
import type { AgentResult, AgentStepRecord } from "../plugins/loop-react/src/index.js";
import { main, type SandboxHost, type SandboxRequest, type SandboxResult } from "./cli.js";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const mocks = vi.hoisted(() => ({
  createRuntime: vi.fn(),
  startDashboardServer: vi.fn(),
  createSessionStore: vi.fn(),
}));

vi.mock("./runtime.js", () => ({ createRuntime: mocks.createRuntime }));
vi.mock("../scripts/dashboard-server.mjs", () => ({ startDashboardServer: mocks.startDashboardServer }));
vi.mock("./session.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session.js")>()),
  createSessionStore: mocks.createSessionStore,
}));

function agentResult(status: AgentResult["status"]): AgentResult {
  return { status, text: status, steps: 1, toolCalls: 0, observations: [] };
}

interface FakeStore {
  appendStart: ReturnType<typeof vi.fn>;
  appendStep: ReturnType<typeof vi.fn>;
  appendEnd: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  fork: ReturnType<typeof vi.fn>;
}

const runStart = { type: "run-start", sessionId: "s1", provider: "mock", model: "mock", task: "first" };

const store: FakeStore = {
  appendStart: vi.fn(async () => "s1"),
  appendStep: vi.fn(async () => {}),
  appendEnd: vi.fn(async () => {}),
  load: vi.fn(async () => [runStart, { type: "run-step", sessionId: "s1", step: 1, messages: [] }]),
  list: vi.fn(async () => []),
  fork: vi.fn(async () => "s2"),
};

function fakeRuntime(
  run: ReturnType<typeof vi.fn> = vi.fn(async () => agentResult("completed")),
  budget?: BudgetPolicy,
) {
  mocks.createRuntime.mockResolvedValueOnce({
    root: projectRoot,
    config: { model: { provider: "mock", model: "mock" } },
    budget,
    runner: { run },
    close: vi.fn(async () => {}),
  });
  return run;
}

async function stdoutOf(argv: string[]): Promise<string> {
  const chunks: string[] = [];
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    await expect(main(argv)).resolves.toBe(0);
    return chunks.join("");
  } finally {
    write.mockRestore();
  }
}

async function exitCode(status: AgentResult["status"]): Promise<number> {
  const close = vi.fn(async () => {});
  mocks.createRuntime.mockResolvedValueOnce({
    runner: { run: vi.fn(async () => agentResult(status)) },
    close,
  });
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    return await main(["run", "test"]);
  } finally {
    write.mockRestore();
  }
}

describe("CLI", () => {
  it("returns zero only for a completed run", async () => {
    await expect(exitCode("completed")).resolves.toBe(0);
    await expect(exitCode("stopped")).resolves.toBe(1);
    await expect(exitCode("error")).resolves.toBe(1);
  });

  it("returns nonzero when runtime close fails", async () => {
    mocks.createRuntime.mockResolvedValueOnce({
      runner: { run: vi.fn(async () => agentResult("completed")) },
      close: vi.fn(async () => {
        throw new Error("close failed");
      }),
    });
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(main(["run", "test"])).resolves.toBe(1);
      expect(error).toHaveBeenCalledOnce();
    } finally {
      write.mockRestore();
      error.mockRestore();
    }
  });

  it("returns nonzero when dashboard close fails", async () => {
    mocks.startDashboardServer.mockResolvedValueOnce({
      url: "http://127.0.0.1:18765",
      close: vi.fn(async () => {
        throw new Error("close failed");
      }),
    });
    const before = new Set(process.listeners("SIGINT"));
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const serving = main(["serve"]);
      const shutdown = await vi.waitFor(() => {
        const listener = process.listeners("SIGINT").find((candidate) => !before.has(candidate));
        expect(listener).toBeTypeOf("function");
        return listener as () => void;
      });
      shutdown();
      await expect(serving).resolves.toBe(1);
      expect(error).toHaveBeenCalledOnce();
    } finally {
      write.mockRestore();
      error.mockRestore();
    }
  });

  it("serves the repository root instead of the working directory", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "nexus-cwd-"));
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(elsewhere);
    mocks.startDashboardServer.mockResolvedValueOnce({
      url: "http://127.0.0.1:18765/task-dashboard.html",
      close: vi.fn(async () => {}),
    });
    const before = new Set(process.listeners("SIGINT"));
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const serving = main(["serve"]);
      const shutdown = await vi.waitFor(() => {
        const listener = process.listeners("SIGINT").find((candidate) => !before.has(candidate));
        expect(listener).toBeTypeOf("function");
        return listener as () => void;
      });
      expect(mocks.startDashboardServer).toHaveBeenLastCalledWith({ root: projectRoot });
      shutdown();
      await expect(serving).resolves.toBe(0);
    } finally {
      write.mockRestore();
      cwd.mockRestore();
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("CLI sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createSessionStore.mockResolvedValue(store);
  });

  it("documents the session commands in help", async () => {
    const out = await stdoutOf(["--help"]);
    expect(out).toContain("session list");
    expect(out).toContain("session resume <id> <task>");
    expect(out).toContain("session fork <id> <newId> [atStep]");
  });

  it("rejects a session flag without a value", async () => {
    await expect(main(["run", "--session"])).rejects.toThrow("--session requires a value");
  });

  it("creates a session, persists every step, and prints only the result", async () => {
    const step = (n: number): AgentStepRecord => ({
      step: n,
      messages: [{ role: "assistant", content: `s${n}` }],
    });
    fakeRuntime(
      vi.fn(async (_task: string, options?: { onStep?: (record: AgentStepRecord) => unknown }) => {
        await options?.onStep?.(step(1));
        await options?.onStep?.(step(2));
        return agentResult("completed");
      }),
    );
    const out = await stdoutOf(["run", "do", "it", "--session", "s1"]);
    expect(JSON.parse(out)).toEqual(agentResult("completed"));
    expect(store.appendStart).toHaveBeenCalledWith({
      sessionId: "s1",
      provider: "mock",
      model: "mock",
      task: "do it",
    });
    expect(store.appendStep).toHaveBeenNthCalledWith(1, "s1", step(1));
    expect(store.appendStep).toHaveBeenNthCalledWith(2, "s1", step(2));
    expect(store.appendEnd).toHaveBeenCalledWith("s1", {
      status: "completed",
      text: "completed",
      error: undefined,
    });
  });

  it("never opens a store for a plain run", async () => {
    fakeRuntime();
    await stdoutOf(["run", "test"]);
    expect(mocks.createSessionStore).not.toHaveBeenCalled();
  });

  it("lists stored sessions in one envelope", async () => {
    store.list.mockResolvedValueOnce([
      { id: "b", bytes: 2, updatedAt: "later" },
      { id: "a", bytes: 1, updatedAt: "now" },
    ]);
    const out = await stdoutOf(["session", "list"]);
    expect(JSON.parse(out)).toEqual({
      sessions: [
        { id: "b", bytes: 2, updatedAt: "later" },
        { id: "a", bytes: 1, updatedAt: "now" },
      ],
    });
    expect(mocks.createRuntime).not.toHaveBeenCalled();
  });

  it("replays stored history on resume and appends to the same id", async () => {
    const run = fakeRuntime();
    const out = await stdoutOf(["session", "resume", "s1", "keep", "going"]);
    expect(JSON.parse(out)).toEqual(agentResult("completed"));
    expect(store.load).toHaveBeenCalledWith("s1");
    expect(run.mock.calls[0]?.[1]?.history).toEqual([]);
    expect(store.appendStart).toHaveBeenCalledWith({
      sessionId: "s1",
      provider: "mock",
      model: "mock",
      task: "keep going",
    });
    expect(store.appendEnd).toHaveBeenCalledOnce();
  });

  it("refuses an unknown session", async () => {
    store.load.mockRejectedValueOnce(new Error("unknown session: nope"));
    await expect(main(["session", "resume", "nope", "task"])).rejects.toThrow("unknown session: nope");
    expect(mocks.createRuntime).not.toHaveBeenCalled();
  });

  it("refuses a resume whose stored model no longer matches the runtime", async () => {
    store.load.mockResolvedValueOnce([{ ...runStart, provider: "openai", model: "gpt-4o-mini" }]);
    fakeRuntime();
    await expect(main(["session", "resume", "s1", "task"])).rejects.toThrow(
      "session s1 used openai/gpt-4o-mini, runtime is mock/mock",
    );
    expect(store.appendStart).not.toHaveBeenCalled();
  });

  it("surfaces a stopped store instead of printing a result", async () => {
    store.appendEnd.mockRejectedValueOnce(new Error("session store is stopped"));
    fakeRuntime();
    await expect(main(["session", "resume", "s1", "task"])).rejects.toThrow("session store is stopped");
  });

  it("forks a prefix without a runtime", async () => {
    const out = await stdoutOf(["session", "fork", "s1", "s2", "1"]);
    expect(JSON.parse(out)).toEqual({ session: { id: "s2", atStep: 1 } });
    expect(store.fork).toHaveBeenCalledWith("s1", 1, "s2");
    expect(mocks.createRuntime).not.toHaveBeenCalled();
  });

  it("forks the last step when atStep is omitted", async () => {
    store.load.mockResolvedValueOnce([
      runStart,
      { type: "run-step", sessionId: "s1", step: 1, messages: [] },
      { type: "run-step", sessionId: "s1", step: 4, messages: [] },
    ]);
    const out = await stdoutOf(["session", "fork", "s1", "s2"]);
    expect(JSON.parse(out)).toEqual({ session: { id: "s2", atStep: 4 } });
    expect(store.fork).toHaveBeenCalledWith("s1", 4, "s2");
  });

  it("rejects an unknown session subcommand", async () => {
    await expect(main(["session", "replay", "s1"])).rejects.toThrow("unknown session command: replay");
  });
});

describe("CLI budget", () => {
  const budget: BudgetPolicy = {
    enabled: true,
    maxTotalTokens: 1000,
    maxCostUsd: 0.25,
    maxElapsedMs: 5000,
    prices: { mock: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 } },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createSessionStore.mockResolvedValue(store);
  });

  it("forwards the configured budget on a plain run and on a resume", async () => {
    const run = fakeRuntime(undefined, budget);
    await stdoutOf(["run", "test"]);
    expect(run.mock.calls[0]?.[1]?.budget).toEqual(budget);

    const resumed = fakeRuntime(undefined, budget);
    await stdoutOf(["session", "resume", "s1", "keep", "going"]);
    expect(resumed.mock.calls[0]?.[1]?.budget).toEqual(budget);
  });

  it("leaves a default run with no budget key and an unchanged result line", async () => {
    const run = fakeRuntime();
    const out = await stdoutOf(["run", "test"]);
    expect(run.mock.calls[0]?.[1]).not.toHaveProperty("budget");
    expect(out).toBe(`${JSON.stringify(agentResult("completed"))}\n`);
  });

  it("reports usage on stdout only, never in the persisted run end", async () => {
    const usage: ModelUsage = {
      inputTokens: 120,
      outputTokens: 40,
      totalTokens: 160,
      source: "provider-reported",
    };
    const result: AgentResult = { ...agentResult("completed"), usage };
    fakeRuntime(
      vi.fn(async () => result),
      budget,
    );
    const out = await stdoutOf(["run", "do", "it", "--session", "s1"]);
    expect(JSON.parse(out)).toEqual(result);
    expect(store.appendEnd).toHaveBeenCalledWith("s1", {
      status: "completed",
      text: "completed",
      error: undefined,
    });
  });

  it("keeps a sandbox run off the budget, and off the local runtime that would read config", async () => {
    const { host, requests } = fakeSandbox();
    await sandboxStdout(["run", "--sandbox", "task"], host);
    expect(requests[0]).not.toHaveProperty("budget");
    expect(mocks.createRuntime).not.toHaveBeenCalled();
  });
});

function sandboxResult(status: SandboxResult["status"], extra: Record<string, unknown> = {}): SandboxResult {
  return { status, ...extra };
}

function fakeSandbox(result: SandboxResult = sandboxResult("completed")) {
  const requests: SandboxRequest[] = [];
  const hostRun = vi.fn(async (request: SandboxRequest) => {
    requests.push(request);
    return result;
  });
  return { host: { runInSandbox: hostRun } satisfies SandboxHost, requests, hostRun };
}

async function sandboxStdout(argv: string[], host: SandboxHost): Promise<{ out: string; code: number }> {
  const chunks: string[] = [];
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    const code = await main(argv, host);
    return { out: chunks.join(""), code };
  } finally {
    write.mockRestore();
  }
}

describe("CLI sandbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("documents the opt-in sandbox flag in help", async () => {
    const out = await stdoutOf(["--help"]);
    expect(out).toContain("run --sandbox <task>");
  });

  it("delegates to the host with the offline defaults and prints only its result", async () => {
    const { host, requests, hostRun } = fakeSandbox(
      sandboxResult("completed", { text: "done", steps: 1, worktree: "/tmp/nexus-sandbox-1" }),
    );
    const { out, code } = await sandboxStdout(["run", "--sandbox", "fix", "the", "flaky", "test"], host);
    expect(code).toBe(0);
    expect(out).toBe('{"status":"completed","text":"done","steps":1,"worktree":"/tmp/nexus-sandbox-1"}\n');
    expect(out.trimEnd().split("\n")).toHaveLength(1);
    expect(hostRun).toHaveBeenCalledOnce();
    expect(requests[0]).toEqual({
      root: projectRoot,
      task: "fix the flaky test",
      provider: "mock",
      permissions: { network: "deny", shell: "deny" },
    });
    expect(mocks.createRuntime).not.toHaveBeenCalled();
    expect(mocks.createSessionStore).not.toHaveBeenCalled();
  });

  it("passes --root through to the host", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "nexus-sandbox-root-"));
    try {
      const { host, requests } = fakeSandbox();
      await sandboxStdout(["run", "--root", elsewhere, "--sandbox", "task"], host);
      expect(requests[0]?.root).toBe(resolve(elsewhere));
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it("returns nonzero for a sandbox run that did not complete", async () => {
    for (const status of ["stopped", "error"]) {
      const { host } = fakeSandbox(sandboxResult(status));
      await expect(sandboxStdout(["run", "--sandbox", "task"], host)).resolves.toMatchObject({ code: 1 });
    }
  });

  it("prints nothing when the host throws, so no partial result reaches stdout", async () => {
    const { host } = fakeSandbox();
    host.runInSandbox = vi.fn(async () => {
      throw new Error("sandbox host is unavailable");
    });
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await expect(main(["run", "--sandbox", "task"], host)).rejects.toThrow("sandbox host is unavailable");
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });

  it("refuses a live provider so no sandbox run can read a user key", async () => {
    const { host, hostRun } = fakeSandbox();
    for (const argv of [
      ["run", "--sandbox", "task", "--model", "openai"],
      ["run", "--sandbox", "task", "--model=openai"],
    ]) {
      await expect(main(argv, host)).rejects.toThrow("--sandbox runs offline; --model openai is refused");
    }
    expect(hostRun).not.toHaveBeenCalled();
  });

  it("refuses --session and a missing task before touching the host", async () => {
    const { host, hostRun } = fakeSandbox();
    await expect(main(["run", "--sandbox", "task", "--session", "s1"], host)).rejects.toThrow(
      "--sandbox does not support --session",
    );
    await expect(main(["run", "--sandbox"], host)).rejects.toThrow("run --sandbox requires a task");
    expect(hostRun).not.toHaveBeenCalled();
  });

  it("leaves a plain run on the local runtime even when a host is available", async () => {
    const run = fakeRuntime();
    const { host, hostRun } = fakeSandbox();
    const out = await sandboxStdout(["run", "test"], host).then(({ out }) => out);
    expect(JSON.parse(out)).toEqual(agentResult("completed"));
    expect(run).toHaveBeenCalledOnce();
    expect(hostRun).not.toHaveBeenCalled();
  });

  it("refuses --snapshot without --sandbox instead of ignoring it", async () => {
    const run = fakeRuntime();
    const { host, hostRun } = fakeSandbox();
    await expect(main(["run", "--snapshot", "task"], host)).rejects.toThrow("--snapshot requires --sandbox");
    await expect(main(["session", "resume", "s1", "--snapshot", "task"], host)).rejects.toThrow(
      "--snapshot requires --sandbox",
    );
    expect(run).not.toHaveBeenCalled();
    expect(hostRun).not.toHaveBeenCalled();
  });
});

describe("CLI sandbox snapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("documents the snapshot flag in help", async () => {
    const out = await stdoutOf(["--help"]);
    expect(out).toContain("run --sandbox --snapshot <task>");
  });

  it("asks for one snapshot request and prints only the host's result", async () => {
    const { host, requests, hostRun } = fakeSandbox(
      sandboxResult("completed", { text: "done", rolledBack: true }),
    );
    const { out, code } = await sandboxStdout(["run", "--sandbox", "--snapshot", "fix", "it"], host);
    expect(code).toBe(0);
    expect(out).toBe('{"status":"completed","text":"done","rolledBack":true}\n');
    expect(out.trimEnd().split("\n")).toHaveLength(1);
    expect(hostRun).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      root: projectRoot,
      task: "fix it",
      provider: "mock",
      permissions: { network: "deny", shell: "deny" },
      snapshot: true,
    });
    expect(mocks.createRuntime).not.toHaveBeenCalled();
    expect(mocks.createSessionStore).not.toHaveBeenCalled();
  });

  it("maps every non-completed snapshot outcome to one, on one line", async () => {
    for (const status of ["rolledBack", "stopped", "error"]) {
      const { host } = fakeSandbox(sandboxResult(status, { restored: true }));
      const { out, code } = await sandboxStdout(["run", "--sandbox", "--snapshot", "task"], host);
      expect(code).toBe(1);
      expect(out).toBe(`{"status":"${status}","restored":true}\n`);
    }
  });

  it("prints nothing when a snapshot run fails, so no partial result reaches stdout", async () => {
    const { host } = fakeSandbox();
    host.runInSandbox = vi.fn(async () => {
      throw new Error("snapshot is unavailable");
    });
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await expect(main(["run", "--sandbox", "--snapshot", "task"], host)).rejects.toThrow(
        "snapshot is unavailable",
      );
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });

  it("keeps a plain sandbox run on the same offline contract, with no snapshot field", async () => {
    const { host, requests, hostRun } = fakeSandbox();
    const { out, code } = await sandboxStdout(["run", "--sandbox", "task"], host);
    expect(code).toBe(0);
    expect(out).toBe('{"status":"completed"}\n');
    expect(hostRun).toHaveBeenCalledOnce();
    expect(requests[0]).not.toHaveProperty("snapshot");
  });

  it("refuses a live provider and a session on the snapshot path too", async () => {
    const { host, hostRun } = fakeSandbox();
    await expect(main(["run", "--sandbox", "--snapshot", "task", "--model", "openai"], host)).rejects.toThrow(
      "--sandbox runs offline; --model openai is refused",
    );
    await expect(main(["run", "--sandbox", "--snapshot", "task", "--session", "s1"], host)).rejects.toThrow(
      "--sandbox does not support --session",
    );
    await expect(main(["run", "--sandbox", "--snapshot"], host)).rejects.toThrow(
      "run --sandbox requires a task",
    );
    expect(hostRun).not.toHaveBeenCalled();
  });
});
