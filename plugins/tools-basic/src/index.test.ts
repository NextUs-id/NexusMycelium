import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PermissionGate, Registry } from "../../../kernel/src/index.js";
import type { ToolRegistry } from "../../../kernel/src/tools.js";
import toolsBasic, { createBasicTools } from "./index.js";

const silent = { info() {}, warn() {}, error() {} };

function permissions(): PermissionGate {
  return new PermissionGate({ "fs.read": "allow", "fs.write": "allow", shell: "allow" });
}

describe("tools-basic", () => {
  it("round-trips text and rejects traversal, symlink escapes, and oversized content", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-tools-basic-"));
    const outside = await mkdtemp(join(tmpdir(), "nexus-tools-outside-"));
    try {
      const tools = createBasicTools({ root, permissions: permissions(), maxBytes: 5 });
      await tools.get("write_text").execute({ path: "nested/value.txt", content: "hello" });
      expect(await tools.get("read_text").execute({ path: "nested/value.txt" })).toBe("hello");
      expect(await readFile(join(root, "nested/value.txt"), "utf8")).toBe("hello");
      await expect(tools.get("write_text").execute({ path: "../escape.txt", content: "no" })).rejects.toThrow(
        /escapes/,
      );
      await expect(tools.get("read_text").execute({ path: "../outside.txt" })).rejects.toThrow(/escapes/);
      await writeFile(join(outside, "secret.txt"), "secret", "utf8");
      await symlink(outside, join(root, "escape"), "dir");
      await expect(tools.get("read_text").execute({ path: "escape/secret.txt" })).rejects.toThrow(/escapes/);
      await expect(
        tools.get("write_text").execute({ path: "escape/new.txt", content: "no" }),
      ).rejects.toThrow(/escapes/);
      await expect(tools.get("write_text").execute({ path: "large.txt", content: "123456" })).rejects.toThrow(
        /limit/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("denies shell by default and runs only allowlisted executables without a shell", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-shell-basic-"));
    try {
      const denied = createBasicTools({ root, permissions: permissions() });
      await expect(
        denied.get("shell").execute({ executable: process.execPath, args: ["-e", ""] }),
      ).rejects.toThrow(/not allowlisted/);
      const allowed = createBasicTools({
        root,
        permissions: permissions(),
        shell: { allow: [process.execPath], deny: [], timeoutMs: 1000 },
      });
      const output = await allowed
        .get("shell")
        .execute({ executable: process.execPath, args: ["-e", "process.stdout.write(';')"] });
      expect(JSON.parse(output)).toMatchObject({ ok: true, stdout: ";" });
      await expect(
        allowed.get("shell").execute({ executable: process.execPath, args: ["-e", "process.exit(7)"] }),
      ).rejects.toThrow(/exit code 7/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("waits for the child close event after cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-shell-close-"));
    const marker = join(root, "state");
    const allowed = createBasicTools({
      root,
      permissions: permissions(),
      shell: { allow: [process.execPath], deny: [], timeoutMs: 2000 },
    });
    const script = `const {writeFileSync}=require("node:fs");process.on("SIGTERM",()=>setTimeout(()=>{writeFileSync(${JSON.stringify(marker)},"closed");process.exit(0)},150));writeFileSync(${JSON.stringify(marker)},"ready");setInterval(()=>{},1000);`;
    try {
      const controller = new AbortController();
      const running = allowed
        .get("shell")
        .execute({ executable: process.execPath, args: ["-e", script] }, controller.signal);
      const outcome = running.catch((error: unknown) => error);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          await readFile(marker, "utf8");
          break;
        } catch (error) {
          if (attempt === 99) throw error;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(await readFile(marker, "utf8")).toBe("ready");
      controller.abort();
      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/cancelled/);
      expect(await readFile(marker, "utf8")).toBe("closed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("registers the kernel tool service", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-tools-registry-"));
    const registry = new Registry(silent, () => ({ root }), permissions());
    registry.register(toolsBasic);
    try {
      await registry.load("tools-basic");
      const tools = registry.services.get<ToolRegistry>("tool:core");
      expect(tools.list().map((tool) => tool.name)).toEqual(["read_text", "write_text", "shell"]);
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
