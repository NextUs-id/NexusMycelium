import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The dashboard renders whatever `TASKS.md` says, so a checklist that lists the same task twice shows
 * the same task twice — one pending, one done. That happened once, so it is a test now: a task id is
 * unique in the file, and it lives under the phase its number belongs to.
 */
// `src/` is one level under the repo root, so the checklist is the parent of this file's directory.
const tasksPath = fileURLToPath(new URL("../TASKS.md", import.meta.url));

interface Row {
  phase: string;
  id: string;
  mark: string;
}

async function rows(): Promise<Row[]> {
  const text = await readFile(tasksPath, "utf8");
  const found: Row[] = [];
  let phase = "";
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^## Fase (\d+) /);
    if (heading) {
      phase = heading[1] ?? "";
      continue;
    }
    const task = line.match(/^- \[(.)\] \*\*(\d+\.\d+[a-z]?)[ *]/);
    if (task) found.push({ phase, id: task[2] ?? "", mark: task[1] ?? "" });
  }
  return found;
}

describe("TASKS.md integrity", () => {
  it("lists every task id exactly once", async () => {
    const found = await rows();
    const seen = new Set<string>();
    const repeated = found.map((row) => row.id).filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
    expect(repeated).toEqual([]);
  });

  it("keeps every task under the phase its number belongs to", async () => {
    for (const row of await rows()) {
      expect(`${row.id}`.startsWith(`${row.phase}.`), `${row.id} sits under Fase ${row.phase}`).toBe(true);
    }
  });

  it("has at least one task per phase, so a phase is never an empty heading", async () => {
    const found = await rows();
    const phases = new Set(found.map((row) => row.phase));
    expect(phases.size).toBeGreaterThan(5);
    for (const phase of phases) {
      expect(found.filter((row) => row.phase === phase).length).toBeGreaterThan(0);
    }
  });
});
