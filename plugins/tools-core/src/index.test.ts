import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PermissionGate, Registry } from "../../../kernel/src/index.js";
import type { ToolRegistry } from "../../../kernel/src/tools.js";
import toolsPlugin from "./index.js";

const silent = { info() {}, warn() {}, error() {} };

async function setupTools(
  root: string,
  allow: string[] = [],
): Promise<{ registry: Registry; tools: ToolRegistry }> {
  const permissions = new PermissionGate({ "fs.read": "allow", "fs.write": "allow", shell: "allow" });
  const registry = new Registry(
    silent,
    (name) => (name === "tools-core" ? { root, shell: { allow, deny: [], timeoutMs: 1000 } } : {}),
    permissions,
  );
  registry.register(toolsPlugin);
  await registry.load("tools-core");
  return { registry, tools: registry.services.get<ToolRegistry>("tool:core") };
}

describe("tools-core", () => {
  it("round-trips root-confined text and rejects symlink escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-tools-"));
    const outside = await mkdtemp(join(tmpdir(), "nexus-outside-"));
    const { registry, tools } = await setupTools(root);
    try {
      await tools.get("write_text").execute({ path: "nested/value.txt", content: "hello" });
      expect(await tools.get("read_text").execute({ path: "nested/value.txt" })).toBe("hello");
      await writeFile(join(outside, "secret.txt"), "secret", "utf8");
      await symlink(outside, join(root, "escape"), "dir");
      await expect(tools.get("read_text").execute({ path: "escape/secret.txt" })).rejects.toThrow(/escapes/);
      await expect(
        tools.get("write_text").execute({ path: "escape/new.txt", content: "no" }),
      ).rejects.toThrow(/escapes/);
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("denies shell unless the executable is explicitly allowlisted", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-shell-"));
    const { registry, tools } = await setupTools(root);
    try {
      await expect(
        tools.get("shell").execute({ executable: process.execPath, args: ["-e", ""] }),
      ).rejects.toThrow(/not allowlisted/);
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses explicit arguments for an allowlisted executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-shell-"));
    const { registry, tools } = await setupTools(root, [process.execPath]);
    try {
      const output = await tools
        .get("shell")
        .execute({ executable: process.execPath, args: ["-e", "process.stdout.write('ok')"] });
      expect(JSON.parse(output)).toMatchObject({ ok: true, stdout: "ok" });
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a nonzero shell exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-shell-"));
    const { registry, tools } = await setupTools(root, [process.execPath]);
    try {
      await expect(
        tools.get("shell").execute({ executable: process.execPath, args: ["-e", "process.exitCode = 7"] }),
      ).rejects.toThrow(/failed with code 7/);
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("waits for the child to close after SIGTERM", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-shell-"));
    const marker = join(root, "closed");
    const { registry, tools } = await setupTools(root, [process.execPath]);
    const script = [
      `import { writeFileSync } from "node:fs";`,
      `process.on("SIGTERM", () => setTimeout(() => {`,
      `writeFileSync(${JSON.stringify(marker)}, "closed");`,
      `process.exit(0);`,
      `}, 50));`,
      `setInterval(() => {}, 1000);`,
    ].join("");
    try {
      await expect(
        tools.get("shell").execute({ executable: process.execPath, args: ["-e", script], timeoutMs: 100 }),
      ).rejects.toThrow(/timed out/);
      expect(await readFile(marker, "utf8")).toBe("closed");
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
