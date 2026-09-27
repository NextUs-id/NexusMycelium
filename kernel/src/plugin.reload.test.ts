import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverPlugins, loadPlugin } from "./plugin.js";

/**
 * The trust root is pinned to the official `plugins/` directory, so per-plugin failures are
 * exercised against a temporary root that substitutes for it. ponytail: mocked `realpath` keeps
 * discovery hermetic; a real fixture root becomes worth it when the loader takes a root option.
 */
const fixture = vi.hoisted(() => ({ root: "" }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    realpath: async (target: string) => {
      const official = fileURLToPath(new URL("../../plugins/", import.meta.url));
      return fixture.root && resolve(target) === resolve(official) ? fixture.root : real.realpath(target);
    },
  };
});

const officialEntry = (relativePath: string, query = ""): URL =>
  new URL(`../../plugins/${relativePath}${query}`, import.meta.url);

function packageExport(target: string): string {
  return JSON.stringify({
    version: "0.1.0",
    private: true,
    type: "module",
    exports: { ".": target },
  });
}

function pluginSource(name: string, generation: string): string {
  return [
    "export default {",
    "  manifest: {",
    `    name: ${JSON.stringify(name)},`,
    '    version: "0.1.0",',
    "    apiVersion: 1,",
    `    description: ${JSON.stringify(generation)},`,
    "  },",
    "  setup: () => () => {},",
    "};",
    "",
  ].join("\n");
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  fixture.root = "";
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureRoot(files: Record<string, Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nexus-plugin-fixture-"));
  temporaryRoots.push(root);
  for (const [plugin, entries] of Object.entries(files)) {
    for (const [file, content] of Object.entries(entries)) {
      const path = join(root, plugin, file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
    }
  }
  fixture.root = root;
  return root;
}

describe("cache-bust entry identity", () => {
  it("reuses the module for one cache key and re-evaluates it for the next", async () => {
    const entry = officialEntry("example-hello/src/index.ts");
    const first = await loadPlugin(entry, { cacheKey: "gen-1" });
    const sameKey = await loadPlugin(entry, { cacheKey: "gen-1" });
    const rotated = await loadPlugin(entry, { cacheKey: "gen-2" });

    expect(sameKey.setup).toBe(first.setup);
    expect(rotated.setup).not.toBe(first.setup);
    expect([first, sameKey, rotated].map((plugin) => plugin.manifest.name)).toEqual([
      "example-hello",
      "example-hello",
      "example-hello",
    ]);
  });

  it("keeps a validated caller token instead of dropping it", async () => {
    const plain = await loadPlugin(officialEntry("example-hello/src/index.ts"));
    const tokenized = await loadPlugin(officialEntry("example-hello/src/index.ts", "?nexusCache=caller"));
    const sameToken = await loadPlugin(officialEntry("example-hello/src/index.ts", "?nexusCache=caller"));
    const rotated = await loadPlugin(officialEntry("example-hello/src/index.ts", "?nexusCache=caller"), {
      cacheKey: 9,
    });

    expect(tokenized.setup).not.toBe(plain.setup);
    expect(sameToken.setup).toBe(tokenized.setup);
    expect(rotated.setup).not.toBe(tokenized.setup);
    expect(plain.manifest.name).toBe("example-hello");
  });

  it("re-evaluates a rewritten source file once the cache key rotates", async () => {
    const root = await fixtureRoot({
      swappable: {
        "package.json": packageExport("./src/index.ts"),
        "src/index.ts": pluginSource("swappable", "gen-1"),
      },
    });

    expect((await discoverPlugins(root)).map((plugin) => plugin.manifest.description)).toEqual(["gen-1"]);
    await writeFile(join(root, "swappable", "src", "index.ts"), pluginSource("swappable", "gen-2"), "utf8");
    expect((await discoverPlugins(root)).map((plugin) => plugin.manifest.description)).toEqual(["gen-1"]);
    expect(
      (await discoverPlugins(root, { cacheKey: 2 })).map((plugin) => plugin.manifest.description),
    ).toEqual(["gen-2"]);
  });
});

describe("query and path boundary", () => {
  it("rejects unsafe query tokens before importing anything", async () => {
    const entry = officialEntry("example-hello/src/index.ts");
    await expect(
      loadPlugin(officialEntry("example-hello/src/index.ts", "?path=../../etc/passwd")),
    ).rejects.toThrow(/query token/);
    await expect(
      loadPlugin(officialEntry("example-hello/src/index.ts", "?nexusCache=../escape")),
    ).rejects.toThrow(/query token/);
    await expect(
      loadPlugin(officialEntry("example-hello/src/index.ts", "?nexusCache=v%202")),
    ).rejects.toThrow(/query token/);
    await expect(loadPlugin(entry, { cacheKey: "../escape" })).rejects.toThrow(/cache key/);
    await expect(loadPlugin(entry, { cacheKey: "a=b" })).rejects.toThrow(/cache key/);
  });

  it("keeps the file trust checks while a query is present", async () => {
    await expect(
      loadPlugin(new URL("../../user/config.example.yaml?nexusCache=1", import.meta.url)),
    ).rejects.toThrow(/untrusted plugin path/);
    await expect(
      loadPlugin(new URL("../../agent-made/staging/?nexusCache=1", import.meta.url)),
    ).rejects.toThrow(/untrusted plugin path/);
    await expect(loadPlugin(new URL("../../plugins/example-hello", import.meta.url))).rejects.toThrow(
      /not a file/,
    );
    await expect(loadPlugin("https://example.com/evil.ts")).rejects.toThrow(/file: protocol/);
    await expect(loadPlugin("not a url")).rejects.toThrow(/invalid plugin URL/);
  });
});

describe("dist and source entry fallback", () => {
  it("resolves the built sibling and falls back to the source twin", async () => {
    const root = await fixtureRoot({
      "dist-export": {
        "package.json": packageExport("./src/index.js"),
        "src/index.ts": pluginSource("dist-export", "source-twin"),
      },
      "source-export": {
        "package.json": packageExport("./src/index.ts"),
        "src/index.ts": pluginSource("source-export", "source"),
      },
      "both-export": {
        "package.json": packageExport("./src/index.ts"),
        "src/index.ts": pluginSource("both-export", "source"),
        "src/index.js": pluginSource("both-export", "built"),
      },
    });

    const discovered = await discoverPlugins(root, { isolateFailures: true });
    expect(discovered.errors).toEqual([]);
    expect(new Map(discovered.plugins.map((p) => [p.manifest.name, p.manifest.description]))).toEqual(
      new Map([
        ["dist-export", "source-twin"],
        ["source-export", "source"],
        ["both-export", "source"],
      ]),
    );
  });

  it("keeps a target that escapes the plugin directory rejected", async () => {
    const root = await fixtureRoot({
      escaping: {
        "package.json": packageExport("./../outside.js"),
        "src/index.ts": pluginSource("escaping", "never"),
      },
    });

    await expect(discoverPlugins(root)).rejects.toThrow(/stay inside its directory/);
    expect((await discoverPlugins(root, { isolateFailures: true })).errors[0]?.error.message).toMatch(
      /stay inside its directory/,
    );
  });
});

describe("discovery failure isolation", () => {
  it("stays fail-closed by default and isolates malformed siblings on request", async () => {
    const root = await fixtureRoot({
      "B-upper": {
        "package.json": packageExport("./src/index.ts"),
        "src/index.ts": pluginSource("upper", "upper"),
      },
      "Z-mid": { "package.json": "{ not json" },
      "a-lower": {
        "package.json": packageExport("./src/index.ts"),
        "src/index.ts": pluginSource("lower", "lower"),
      },
    });

    await expect(discoverPlugins(root)).rejects.toThrow(/invalid plugin package/);

    const isolated = await discoverPlugins(root, { isolateFailures: true });
    expect(isolated.plugins.map((plugin) => plugin.manifest.name)).toEqual(["upper", "lower"]);
    expect(isolated.errors.map((failure) => failure.directory)).toEqual(["Z-mid"]);
    expect(isolated.errors[0]?.error.message).toMatch(/invalid plugin package/);
  });

  it("keeps the bytewise order and isolates a symlinked or escaping directory", async () => {
    const outside = await mkdtemp(join(tmpdir(), "nexus-plugin-outside-"));
    temporaryRoots.push(outside);
    const root = await fixtureRoot({
      "B-upper": {
        "package.json": packageExport("./src/index.ts"),
        "src/index.ts": pluginSource("upper", "upper"),
      },
      "a-lower": {
        "package.json": packageExport("./src/index.ts"),
        "src/index.ts": pluginSource("lower", "lower"),
      },
    });
    await symlink(outside, join(root, "z-linked"), "dir");

    const isolated = await discoverPlugins(root, { isolateFailures: true });
    expect(isolated.plugins.map((plugin) => plugin.manifest.name)).toEqual(["upper", "lower"]);
    expect(isolated.errors.map((failure) => failure.directory)).toEqual(["z-linked"]);
    expect(isolated.errors[0]?.error.message).toMatch(/cannot be a symlink/);
    await expect(discoverPlugins(root)).rejects.toThrow(/cannot be a symlink/);
  });

  it("never isolates a root that is not the trusted plugins directory", async () => {
    const root = await fixtureRoot({});
    await expect(
      discoverPlugins(new URL("../../agent-made/", import.meta.url), { isolateFailures: true }),
    ).rejects.toThrow(/official trusted path/);
    expect(await discoverPlugins(root, { isolateFailures: true, cacheKey: "gen-1" })).toMatchObject({
      plugins: [],
      errors: [],
    });
  });
});
