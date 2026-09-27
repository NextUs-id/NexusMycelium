import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PermissionGate } from "../../../kernel/src/index.js";
import { createBasicTools } from "./index.js";

const outputCap = 64_000;
const marker = "\n[output truncated]";

function permissions(): PermissionGate {
  return new PermissionGate({ "fs.read": "allow", "fs.write": "allow", shell: "allow" });
}

function tools(root: string, timeoutMs = 1000) {
  return createBasicTools({
    root,
    permissions: permissions(),
    shell: { allow: [process.execPath], deny: [], timeoutMs },
  });
}

function run(root: string, script: string, extra: Record<string, unknown> = {}, timeoutMs?: number) {
  return tools(root, timeoutMs)
    .get("shell")
    .execute({ executable: process.execPath, args: ["-e", script], ...extra });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(path: string, attempts = 200): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await exists(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`file never appeared: ${path}`);
}

const node = (script: string) => JSON.stringify(script);

describe("tools-basic shell hardening", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("passes only the env allowlist and never leaks secrets or HOME", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-env-"));
    try {
      vi.stubEnv("PATH", "/usr/bin:/bin");
      vi.stubEnv("LANG", "en_US.UTF-8");
      vi.stubEnv("LC_ALL", "en_US.UTF-8");
      vi.stubEnv("TMPDIR", "/tmp");
      vi.stubEnv("HOME", "/home/leaked-home");
      vi.stubEnv("NEXUS_TEST_SECRET", "sk-do-not-leak");
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", "leaked-aws");
      const output = await run(
        root,
        `process.stdout.write(Object.keys(process.env).sort().join("\\n") + "\\n" + (process.env.HOME ?? "") + "|" + (process.env.NEXUS_TEST_SECRET ?? ""))`,
      );
      const parsed = JSON.parse(output);
      const lines = parsed.stdout.split("\n");
      const leaked = lines.pop() ?? "";
      expect(lines).toEqual(["LANG", "LC_ALL", "PATH", "TMPDIR"]);
      expect(leaked).toBe("|");
      expect(parsed.stdout).not.toContain("leaked-home");
      expect(parsed.stdout).not.toContain("sk-do-not-leak");
      expect(parsed.stdout).not.toContain("leaked-aws");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Group signalling needs POSIX process groups; win32 has no negative-pid kill.
  it.skipIf(process.platform === "win32")(
    "kills the whole process group on timeout so a stubborn descendant dies",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "nexus-group-"));
      const ready = join(root, "ready");
      const survivor = join(root, "survivor");
      try {
        const descendant = `process.on("SIGTERM",()=>{});setTimeout(()=>{require("node:fs").writeFileSync(${node(survivor)},"alive")},2500);`;
        const script = `require("node:child_process").spawn(process.execPath,["-e",${node(descendant)}],{stdio:"ignore"});require("node:fs").writeFileSync(${node(ready)},"ready");setInterval(()=>{},1000);`;
        const started = Date.now();
        await expect(run(root, script, {}, 400)).rejects.toThrow(/timed out after 400ms/);
        await waitFor(ready);
        await new Promise((resolve) => setTimeout(resolve, 2600));
        expect(await exists(survivor)).toBe(false);
        expect(Date.now() - started).toBeLessThan(20_000);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it("settles on a hard deadline when a stubborn child keeps the stdout pipe open", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-deadline-"));
    try {
      const script = `process.on("SIGTERM",()=>{});setInterval(()=>{process.stdout.write("y".repeat(4096))},20);`;
      const started = Date.now();
      await expect(run(root, script, {}, 300)).rejects.toThrow(/timed out after 300ms/);
      // 300ms timeout + 2 grace windows; the old wait-for-close path hung forever.
      expect(Date.now() - started).toBeLessThan(4000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("caps stdout and stderr at the byte limit and marks the truncation", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-cap-"));
    try {
      const script = `const flood="a".repeat(200000);process.stdout.write(flood);process.stderr.write(flood);`;
      const parsed = JSON.parse(await run(root, script, {}, 10_000));
      for (const stream of [parsed.stdout, parsed.stderr]) {
        expect(Buffer.byteLength(stream, "utf8")).toBe(outputCap + Buffer.byteLength(marker, "utf8"));
        expect(stream.endsWith(marker)).toBe(true);
        expect(Buffer.byteLength(stream.slice(0, outputCap), "utf8")).toBe(outputCap);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("confines cwd to the root and rejects traversal, symlink escapes, and non-directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-cwd-"));
    const outside = await mkdtemp(join(tmpdir(), "nexus-cwd-outside-"));
    try {
      const kit = tools(root);
      await mkdir(join(root, "sub"), { recursive: true });
      await writeFile(join(root, "file.txt"), "x", "utf8");
      await symlink(outside, join(root, "escape"), "dir");
      const cwd = await kit.get("shell").execute({
        executable: process.execPath,
        args: ["-e", "process.stdout.write(process.cwd())"],
        cwd: "sub",
      });
      expect(JSON.parse(cwd).stdout).toBe(await realpath(join(root, "sub")));
      await expect(
        kit.get("shell").execute({ executable: process.execPath, args: ["-e", ""], cwd: outside }),
      ).rejects.toThrow(/escapes/);
      await expect(
        kit.get("shell").execute({ executable: process.execPath, args: ["-e", ""], cwd: ".." }),
      ).rejects.toThrow(/escapes/);
      await expect(
        kit.get("shell").execute({ executable: process.execPath, args: ["-e", ""], cwd: "escape" }),
      ).rejects.toThrow(/escapes/);
      await expect(
        kit.get("shell").execute({ executable: process.execPath, args: ["-e", ""], cwd: "file.txt" }),
      ).rejects.toThrow(/must be a directory/);
      await expect(
        kit.get("shell").execute({ executable: process.execPath, args: ["-e", ""], cwd: "missing" }),
      ).rejects.toThrow(/ENOENT|no such file/i);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("still denies by default and never routes through a shell", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-deny-"));
    try {
      await expect(
        createBasicTools({ root, permissions: permissions() })
          .get("shell")
          .execute({ executable: process.execPath, args: ["-e", ""] }),
      ).rejects.toThrow(/not allowlisted/);
      const allowed = tools(root);
      await expect(
        allowed.get("shell").execute({ executable: "sh", args: ["-c", "echo pwned"] }),
      ).rejects.toThrow(/not allowlisted/);
      const parsed = JSON.parse(
        await allowed
          .get("shell")
          .execute({ executable: process.execPath, args: ["-e", "process.stdout.write(';')"] }),
      );
      expect(parsed).toMatchObject({ ok: true, stdout: ";" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
