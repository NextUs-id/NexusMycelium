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
      expect(tools.list().map((tool) => tool.name)).toEqual([
        "read_text",
        "write_text",
        "edit_text",
        "shell",
      ]);
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("edit_text", () => {
  it("replaces exact text, applies edits in order, and reports what it changed", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-edit-"));
    try {
      const tools = createBasicTools({ root, permissions: permissions() });
      await writeFile(join(root, "note.txt"), "alpha beta gamma", "utf8");
      const value = (await tools.get("edit_text").execute({
        path: "note.txt",
        edits: [
          { oldText: "beta", newText: "BETA" },
          { oldText: "gamma", newText: "delta" },
        ],
      })) as string;
      expect(JSON.parse(value)).toEqual({
        ok: true,
        path: "note.txt",
        edits: 2,
        replacements: 2,
        bytes: 16,
      });
      expect(await readFile(join(root, "note.txt"), "utf8")).toBe("alpha BETA delta");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes nothing when one edit does not match, and says which one", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-edit-"));
    try {
      const tools = createBasicTools({ root, permissions: permissions() });
      await writeFile(join(root, "note.txt"), "alpha beta", "utf8");
      await expect(
        tools.get("edit_text").execute({
          path: "note.txt",
          edits: [
            { oldText: "beta", newText: "BETA" },
            { oldText: "missing", newText: "x" },
          ],
        }),
      ).rejects.toThrow(/edit 2/);
      // The first edit matched but nothing was written: an edit is all or nothing.
      expect(await readFile(join(root, "note.txt"), "utf8")).toBe("alpha beta");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses an ambiguous match unless the caller asks for every occurrence", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-edit-"));
    try {
      const tools = createBasicTools({ root, permissions: permissions() });
      await writeFile(join(root, "note.txt"), "x x", "utf8");
      await expect(
        tools.get("edit_text").execute({ path: "note.txt", edits: [{ oldText: "x", newText: "y" }] }),
      ).rejects.toThrow(/2 matches/);
      expect(await readFile(join(root, "note.txt"), "utf8")).toBe("x x");
      const value = (await tools.get("edit_text").execute({
        path: "note.txt",
        edits: [{ oldText: "x", newText: "y", replaceAll: true }],
      })) as string;
      expect(JSON.parse(value)).toMatchObject({ ok: true, edits: 1, replacements: 2 });
      expect(await readFile(join(root, "note.txt"), "utf8")).toBe("y y");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses an empty oldText, an empty edit list, and unknown keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-edit-"));
    try {
      const tools = createBasicTools({ root, permissions: permissions() });
      await writeFile(join(root, "note.txt"), "alpha", "utf8");
      await expect(
        tools.get("edit_text").execute({ path: "note.txt", edits: [{ oldText: "", newText: "x" }] }),
      ).rejects.toThrow();
      await expect(tools.get("edit_text").execute({ path: "note.txt", edits: [] })).rejects.toThrow();
      await expect(
        tools.get("edit_text").execute({
          path: "note.txt",
          edits: [{ oldText: "alpha", newText: "x", mode: "patch" }],
        }),
      ).rejects.toThrow();
      await expect(tools.get("edit_text").execute({ path: "note.txt", content: "alpha" })).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a file that is missing, a path outside the root, and a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-edit-"));
    const outside = await mkdtemp(join(tmpdir(), "nexus-edit-outside-"));
    try {
      const tools = createBasicTools({ root, permissions: permissions() });
      await writeFile(join(outside, "secret.txt"), "secret", "utf8");
      await writeFile(join(root, "real.txt"), "alpha", "utf8");
      await expect(
        tools.get("edit_text").execute({ path: "absent.txt", edits: [{ oldText: "a", newText: "b" }] }),
      ).rejects.toThrow();
      await expect(
        tools.get("edit_text").execute({
          path: "../secret.txt",
          edits: [{ oldText: "secret", newText: "leaked" }],
        }),
      ).rejects.toThrow(/escapes/);
      await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
      await expect(
        tools.get("edit_text").execute({
          path: "link.txt",
          edits: [{ oldText: "secret", newText: "leaked" }],
        }),
      ).rejects.toThrow(/symlink/);
      await expect(
        tools.get("edit_text").execute({
          path: "real.txt",
          edits: [{ oldText: "alpha", newText: "beta beta beta" }],
          replaceAll: true,
        }),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("needs the write permission and honours the configured size ceiling", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-edit-"));
    try {
      const denied = createBasicTools({
        root,
        permissions: new PermissionGate({ "fs.read": "allow", "fs.write": "deny", shell: "deny" }),
      });
      await writeFile(join(root, "note.txt"), "alpha", "utf8");
      await expect(
        denied.get("edit_text").execute({ path: "note.txt", edits: [{ oldText: "alpha", newText: "beta" }] }),
      ).rejects.toThrow(/fs.write/);
      const small = createBasicTools({ root, permissions: permissions(), maxBytes: 6 });
      await expect(
        small.get("edit_text").execute({
          path: "note.txt",
          edits: [{ oldText: "alpha", newText: "a much longer replacement" }],
        }),
      ).rejects.toThrow(/6-byte limit/);
      expect(await readFile(join(root, "note.txt"), "utf8")).toBe("alpha");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
