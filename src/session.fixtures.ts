import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore, type SessionStore } from "./session.js";

export interface SessionFixture {
  store: SessionStore;
  root: string;
  file(sessionId: string): string;
  bytes(sessionId: string): Promise<string>;
}

/** Temp sessions root outside the repo `data/` mount, so no test ever sees real user state. */
export async function withSessionStore(
  run: (fixture: SessionFixture) => Promise<void>,
  prefix = "nexus-session-",
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try {
    const store = await createSessionStore({ root });
    await run({
      store,
      root,
      file: (sessionId) => join(root, `${sessionId}.jsonl`),
      bytes: async (sessionId) => readFile(join(root, `${sessionId}.jsonl`), "utf8"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** A completed two-step run: the shape the corrupt-tail, redaction, and fork cases start from. */
export async function seedRun(store: SessionStore, task = "fix the failing test"): Promise<string> {
  const id = await store.appendStart({ provider: "mock", model: "mock", task });
  await store.appendStep(id, { step: 1, messages: [{ role: "user", content: task }] });
  await store.appendStep(id, { step: 2, messages: [{ role: "assistant", content: "done" }] });
  await store.appendEnd(id, { status: "completed", text: "done", limits: { maxSteps: 8, timeoutMs: 15000 } });
  return id;
}
