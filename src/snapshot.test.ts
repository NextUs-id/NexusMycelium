import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { protectedTrees, removeTree, snapshotTrees } from "./sandbox.fixtures.js";
import {
  createWorkspace,
  gitAvailable,
  gitOut,
  plantFile,
  snapshotPrefix,
  treeBytes,
} from "./snapshot.fixtures.js";
import { createSnapshot, restoreSnapshot } from "./snapshot.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const moduleSource = join(here, "snapshot.ts");
const gitReady = await gitAvailable();
const scratch: string[] = [];

afterEach(async () => {
  const pending = scratch.splice(0, scratch.length);
  await Promise.all(pending.map((path) => removeTree(path)));
});

/** A temp workspace holding a nested tree plus a `.gitignore` that protects `keep/` and `logs/`. */
async function seed(): Promise<string> {
  const root = track(await createWorkspace());
  await plantFile(root, "top.txt", "top\n");
  await plantFile(root, "src/deep/nested/leaf.txt", "leaf\n");
  await plantFile(root, "src/gone.txt", "gone\n");
  await plantFile(root, ".gitignore", "keep/\nlogs/\n");
  await plantFile(root, "keep/cache.bin", "cached\n");
  await plantFile(root, "logs/run.log", "log\n");
  return root;
}

function track<T extends string>(path: T): T {
  scratch.push(path);
  return path;
}

describe("createSnapshot", () => {
  it.skipIf(!gitReady)("restores a nested tree byte-identical after dirty edits", async () => {
    const root = await seed();
    const commit = await createSnapshot(root);
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    const baseline = await treeBytes(root);

    // nested modification, a deleted tracked file, an edited top-level file, and new untracked files
    await writeFile(join(root, "src/deep/nested/leaf.txt"), "tampered\n", "utf8");
    await writeFile(join(root, "top.txt"), "top changed\n", "utf8");
    await removeTree(join(root, "src/gone.txt"));
    await plantFile(root, "src/deep/added.txt", "new\n");
    await mkdir(join(root, "scratch"), { recursive: true });
    await plantFile(root, "scratch/junk.txt", "junk\n");

    const result = await restoreSnapshot(root, commit);
    expect(result.restored).toBe(true);
    expect(result.commit).toBe(commit);
    expect(result.changedFiles).toEqual([
      "scratch/junk.txt",
      "src/deep/added.txt",
      "src/deep/nested/leaf.txt",
      "src/gone.txt",
      "top.txt",
    ]);
    for (const file of result.changedFiles) expect(file.startsWith("/")).toBe(false);
    expect(await treeBytes(root)).toEqual(baseline);
    expect((await gitOut(root, ["status", "--porcelain"])).trim()).toBe("");
  });

  it.skipIf(!gitReady)("removes untracked files but leaves ignored files untouched", async () => {
    const root = await seed();
    const commit = await createSnapshot(root);
    const ignored = await readFile(join(root, "keep/cache.bin"), "utf8");
    await plantFile(root, "untracked.txt", "u\n");
    await plantFile(root, "keep/new-cache.bin", "still ignored\n");
    await plantFile(root, "logs/new.log", "still ignored\n");

    const result = await restoreSnapshot(root, commit);
    expect(result.changedFiles).toEqual(["untracked.txt"]);
    expect(await readFile(join(root, "keep/cache.bin"), "utf8")).toBe(ignored);
    expect(await readFile(join(root, "keep/new-cache.bin"), "utf8")).toBe("still ignored\n");
    expect(await readFile(join(root, "logs/new.log"), "utf8")).toBe("still ignored\n");
    // `clean -fd` is what runs, never `-x`: the module cannot express cleaning ignored files.
    const source = await readFile(moduleSource, "utf8");
    expect(source).toContain('"clean", "-fd", "-q"');
    expect(source).not.toContain('"-x"');
    expect(source).not.toContain("--ignored");
  });

  it.skipIf(!gitReady)(
    "uses a workspace identity and reads no secret from the host environment",
    async () => {
      const previous = { home: process.env.HOME, key: process.env.OPENAI_API_KEY };
      const fakeHome = track(await createWorkspace());
      await plantFile(fakeHome, ".gitconfig", "[user]\n\tname = from-home\n\temail = home@example.com\n");
      process.env.HOME = fakeHome;
      process.env.OPENAI_API_KEY = "dummy-snapshot-key";
      try {
        const root = await seed();
        await plantFile(root, "notes.txt", "no keys here\n");
        const commit = await createSnapshot(root);
        const author = await gitOut(root, ["log", "-1", "--format=%an <%ae> %s", commit]);
        expect(author.trim()).toBe("nexus <nexus@localhost> nexus snapshot");
        const config = await gitOut(root, ["config", "--list", "--local"]);
        expect(config).not.toContain("from-home");
        expect(config).not.toContain("home@example.com");
        for (const content of Object.values(await treeBytes(root))) {
          expect(Buffer.from(content, "base64").toString("utf8")).not.toContain("dummy-snapshot-key");
        }
      } finally {
        if (previous.home === undefined) delete process.env.HOME;
        else process.env.HOME = previous.home;
        if (previous.key === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = previous.key;
      }
    },
  );

  it.skipIf(!gitReady)("keeps a repository the caller already initialized", async () => {
    const root = await seed();
    await gitOut(root, ["init", "--quiet"]);
    await gitOut(root, ["config", "user.name", "caller"]);
    await gitOut(root, ["config", "user.email", "caller@example.invalid"]);
    const commit = await createSnapshot(root);
    // The caller's own identity wins: config is written only when the module created the repo.
    expect((await gitOut(root, ["log", "-1", "--format=%an", commit])).trim()).toBe("caller");
    await plantFile(root, "untracked.txt", "u\n");
    expect((await restoreSnapshot(root, commit)).changedFiles).toEqual(["untracked.txt"]);
  });

  it.skipIf(!gitReady)("takes a second baseline and keeps older commits restorable", async () => {
    const root = await seed();
    const first = await createSnapshot(root);
    await plantFile(root, "top.txt", "second baseline\n");
    const second = await createSnapshot(root);
    expect(second).not.toBe(first);
    await writeFile(join(root, "top.txt"), "drifted again\n", "utf8");

    expect((await restoreSnapshot(root, second)).changedFiles).toEqual(["top.txt"]);
    expect(await readFile(join(root, "top.txt"), "utf8")).toBe("second baseline\n");
    expect((await restoreSnapshot(root, first)).commit).toBe(first);
    expect(await readFile(join(root, "top.txt"), "utf8")).toBe("top\n");
  });

  it.skipIf(!gitReady)("configures no remote and never reaches the network", async () => {
    const root = await seed();
    await createSnapshot(root);
    const config = await readFile(join(root, ".git", "config"), "utf8");
    expect(config).not.toContain("remote");
    expect(config).not.toContain("url");
    const source = await readFile(moduleSource, "utf8");
    for (const verb of ['"fetch"', '"clone"', '"pull"', '"push"', '"remote"'])
      expect(source).not.toContain(verb);
  });
});

describe("restoreSnapshot", () => {
  it.skipIf(!gitReady)("fails closed on a missing or corrupt commit and changes nothing", async () => {
    const root = await seed();
    const commit = await createSnapshot(root);
    await plantFile(root, "untracked.txt", "u\n");
    const before = await treeBytes(root);

    for (const bad of ["0000000000000000000000000000000000000000", "not-a-sha", "../../etc", "HEAD", ""]) {
      await expect(restoreSnapshot(root, bad)).rejects.toThrow(/hex sha|git/);
    }
    expect(await treeBytes(root)).toEqual(before);
    expect((await gitOut(root, ["rev-parse", "HEAD"])).trim()).toBe(commit);

    // A commit whose object store is gone is the real corruption, caught before anything is written.
    await removeTree(join(root, ".git", "objects"));
    await writeFile(join(root, "top.txt"), "task edit\n", "utf8");
    await expect(restoreSnapshot(root, commit)).rejects.toThrow(/git/);
    expect(await readFile(join(root, "top.txt"), "utf8")).toBe("task edit\n");
    // A workspace with no commit at all has nothing to reset to.
    const empty = track(await createWorkspace());
    await expect(restoreSnapshot(empty, commit)).rejects.toThrow(/git/);
  });

  it.skipIf(!gitReady)("refuses a relative, traversing, or missing root", async () => {
    const root = await seed();
    const commit = await createSnapshot(root);
    const missing = join(root, "does-not-exist");
    // Walking out with `..` lands on the temp dir or `/`; neither is a workspace the module owns.
    const escapes = [join(root, ".."), join(root, "..", "..", ".."), tmpdir(), "/"];
    for (const bad of ["src", "", "rel\0ative", missing, ...escapes]) {
      await expect(restoreSnapshot(bad, commit)).rejects.toThrow(/snapshot root/);
    }
    // Refusing must not mean creating the root on the way to the refusal.
    expect(await readdir(root)).toContain("top.txt");
    expect((await gitOut(root, ["rev-parse", "HEAD"])).trim()).toBe(commit);
  });

  it.skipIf(!gitReady)(
    "refuses the real repository, its user and data scopes, and any traversal to them",
    async () => {
      const before = await snapshotTrees(protectedTrees(repoRoot));
      for (const target of ["", "user", "data", "config", "src", "kernel", "plugins"]) {
        await expect(createSnapshot(join(repoRoot, target))).rejects.toThrow(/snapshot root/);
      }
      expect(await snapshotTrees(protectedTrees(repoRoot))).toEqual(before);

      // A root that resolves to somebody else's object store is refused twice over: a subdirectory
      // of a repository under temp, and a `.git` file planted to point at a checkout, which plain
      // git happily adopts and would let a commit write the other repository's history.
      const checkout = track(await createWorkspace());
      await gitOut(checkout, ["init", "--quiet"]);
      await mkdir(join(checkout, "nested"), { recursive: true });
      await expect(createSnapshot(join(checkout, "nested"))).rejects.toThrow(/refuses a git checkout/);
      const planted = track(await createWorkspace());
      await writeFile(join(planted, ".git"), `gitdir: ${join(checkout, ".git")}\n`, "utf8");
      expect((await gitOut(planted, ["rev-parse", "--absolute-git-dir"])).trim()).toBe(
        join(checkout, ".git"),
      );
      await expect(createSnapshot(planted)).rejects.toThrow(/refuses a git checkout/);
      expect((await gitOut(checkout, ["status", "--porcelain"])).trim()).toBe("");
    },
  );

  it.skipIf(!gitReady)("leaves no temp root of its own behind", async () => {
    const leaked = async (): Promise<string[]> =>
      (await readdir(tmpdir(), { withFileTypes: true }))
        .filter(
          (entry) => entry.name.startsWith(snapshotPrefix) && !scratch.includes(join(tmpdir(), entry.name)),
        )
        .map((entry) => entry.name)
        .sort();
    const before = await leaked();
    const root = await seed();
    const commit = await createSnapshot(root);
    await plantFile(root, "untracked.txt", "u\n");
    await restoreSnapshot(root, commit);
    // The snapshot lives in the caller's own temp root: no second directory is created anywhere.
    expect(await leaked()).toEqual(before);
  });

  it.skipIf(!gitReady)("fails closed when git is unavailable", async () => {
    const root = await seed();
    const commit = await createSnapshot(root);
    await plantFile(root, "untracked.txt", "u\n");
    const emptyPath = track(await createWorkspace());
    const previous = process.env.PATH;
    process.env.PATH = emptyPath;
    try {
      await expect(restoreSnapshot(root, commit)).rejects.toThrow(/git is not available on PATH/);
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    }
    // Fail closed with nothing half-applied: the task's own untracked file is still there.
    expect(await readFile(join(root, "untracked.txt"), "utf8")).toBe("u\n");
  });
});
