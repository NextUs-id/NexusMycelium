import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../src/runtime.js";

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "nexus-smoke-"));
  const started = performance.now();
  try {
    await mkdir(join(root, "config"), { recursive: true });
    await mkdir(join(root, "user"), { recursive: true });
    await writeFile(
      join(root, "config", "default.yaml"),
      "model:\n  provider: mock\n  model: mock\n",
      "utf8",
    );
    await writeFile(
      join(root, "user", "config.yaml"),
      "permissions:\n  fs.read: allow\n  fs.write: allow\n  shell: deny\n  network: deny\n",
      "utf8",
    );
    const runtime = await createRuntime({ root });
    try {
      if (!runtime.tools.has("write_text") || !runtime.tools.has("read_text")) {
        throw new Error("smoke failed: file tools were not loaded");
      }
      const result = await runtime.runner.run(
        'Write smoke.txt with content "hello from benchmark" and read smoke.txt',
      );
      const content = await readFile(join(root, "smoke.txt"), "utf8");
      if (result.status !== "completed" || result.toolCalls !== 2 || content !== "hello from benchmark") {
        throw new Error(`smoke failed: ${JSON.stringify(result)}`);
      }
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          scope: "single-task smoke",
          tasks: 1,
          provider: runtime.config.model.provider,
          steps: result.steps,
          toolCalls: result.toolCalls,
          tools: ["write_text", "read_text"],
          elapsedMs: Math.round(performance.now() - started),
        })}\n`,
      );
    } finally {
      await runtime.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
