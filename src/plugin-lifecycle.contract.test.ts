import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  definePlugin,
  MAX_EMIT_DEPTH,
  PermissionGate,
  PLUGIN_EVENT_NAMES,
  Registry,
} from "../kernel/src/index.js";

const silent = { info() {}, warn() {}, error() {} };

function makePlugin(name: string, requires: string[] = []) {
  return definePlugin({
    manifest: { name, version: "0.1.0", apiVersion: 1, requires },
    setup: () => () => {},
  });
}

function flatten(error: unknown, into: string[] = []): string[] {
  if (error instanceof AggregateError) {
    into.push(error.message);
    for (const inner of error.errors) flatten(inner, into);
    return into;
  }
  into.push(error instanceof Error ? error.message : String(error));
  return into;
}

const temporaryRoots: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(directory);
  return directory;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("loadAll ordering", () => {
  it("loads each plugin once in dependency order and closes in reverse", async () => {
    const order: string[] = [];
    const tracked = (name: string, requires: string[] = []) =>
      definePlugin({
        manifest: { name, version: "0.1.0", apiVersion: 1, requires },
        setup: () => {
          order.push(`load:${name}`);
          return () => {
            order.push(`close:${name}`);
          };
        },
      });
    const registry = new Registry(silent);
    for (const plugin of [
      tracked("diamond", ["left", "right"]),
      tracked("right", ["base"]),
      tracked("left", ["base"]),
      tracked("base"),
    ]) {
      registry.register(plugin);
    }

    await registry.loadAll(["diamond", "right", "left", "base"]);

    expect(order).toEqual(["load:base", "load:left", "load:right", "load:diamond"]);
    expect(registry.loadedNames()).toEqual(["base", "left", "right", "diamond"]);

    await registry.close();
    expect(order).toEqual([
      "load:base",
      "load:left",
      "load:right",
      "load:diamond",
      "close:diamond",
      "close:right",
      "close:left",
      "close:base",
    ]);
    expect(registry.loadedNames()).toEqual([]);
  });

  it("isolates a failing sibling, reports every failure, and blocks only its dependents", async () => {
    const registry = new Registry(silent);
    registry.register(makePlugin("first"));
    registry.register(
      definePlugin({
        manifest: { name: "broken", version: "0.1.0", apiVersion: 1 },
        setup: () => {
          throw new Error("broken setup");
        },
      }),
    );
    registry.register(makePlugin("dependent", ["broken"]));
    registry.register(makePlugin("last"));

    const report = await registry.loadAll(["first", "broken", "dependent", "last"]);

    expect(report.loaded).toEqual(["first", "last"]);
    expect(registry.loadedNames()).toEqual(["first", "last"]);
    expect(report.failures.map((failure) => failure.name)).toEqual(["broken", "dependent"]);
    expect(report.failures[0]?.error).toBe("broken setup");
    expect(report.failures[1]?.error).toBe("dependent requires broken: broken setup");
    expect(registry.isLoaded("broken")).toBe(false);

    await expect(registry.loadAll(["first", "broken"], { strict: true })).rejects.toThrow(
      "plugin load failed",
    );
    await registry.close();
    expect(registry.loadedNames()).toEqual([]);
  });
});

describe("dependency graph", () => {
  it("reports the whole cycle path, loads nothing from it, and stays deterministic", async () => {
    const registry = new Registry(silent);
    registry.register(makePlugin("alpha", ["beta"]));
    registry.register(makePlugin("beta", ["gamma"]));
    registry.register(makePlugin("gamma", ["alpha"]));

    const first: string[] = [];
    await registry.load("alpha").catch((error) => flatten(error, first));

    expect(first).toEqual(["plugin dependency cycle: alpha -> beta -> gamma -> alpha"]);
    expect(registry.loadedNames()).toEqual([]);

    const report = await registry.loadAll(["alpha", "beta"]);
    expect(report.loaded).toEqual([]);
    expect(report.failures.map((failure) => failure.name)).toEqual(["gamma", "beta", "alpha"]);
    for (const failure of report.failures) {
      expect(failure.error).toContain(first[0] ?? "");
    }
    await expect(registry.loadAll(["alpha"], { strict: true })).rejects.toThrow("plugin load failed");

    await registry.close();
    expect(registry.loadedNames()).toEqual([]);
  });

  it("loads a shared dependency once and pins it until every dependent is gone", async () => {
    const setups = new Map<string, number>();
    const tracked = (name: string, requires: string[] = [], provides: string[] = []) =>
      definePlugin({
        manifest: { name, version: "0.1.0", apiVersion: 1, requires, provides },
        setup: ({ services }) => {
          setups.set(name, (setups.get(name) ?? 0) + 1);
          for (const service of provides) services.register(service, name);
          return () => {};
        },
      });
    const registry = new Registry(silent);
    registry.register(tracked("base", [], ["base:shared"]));
    registry.register(tracked("left", ["base"]));
    registry.register(tracked("right", ["base"]));
    registry.register(tracked("top", ["left", "right"]));

    await registry.load("top");

    expect([...setups.entries()]).toEqual([
      ["base", 1],
      ["left", 1],
      ["right", 1],
      ["top", 1],
    ]);
    expect(registry.loadedNames()).toEqual(["base", "left", "right", "top"]);

    await expect(registry.unload("base")).rejects.toThrow(/left depends on it/);
    expect(registry.services.get<string>("base:shared")).toBe("base");

    await registry.unload("top");
    await registry.unload("left");
    await expect(registry.unload("base")).rejects.toThrow(/right depends on it/);
    await registry.unload("right");
    await registry.unload("base");
    expect(registry.loadedNames()).toEqual([]);
    expect(registry.services.has("base:shared")).toBe(false);
  });
});

describe("hot swap", () => {
  it("disposes the old generation once and restores the previous object after a refused swap", async () => {
    const disposed: string[] = [];
    const generation = (value: number) =>
      definePlugin({
        manifest: {
          name: "swappable",
          version: "0.1.0",
          apiVersion: 1,
          provides: ["swap:generation"],
        },
        setup({ services }) {
          services.register("swap:generation", value);
          return () => {
            disposed.push(`gen${value}`);
          };
        },
      });
    const registry = new Registry(silent);
    registry.register(generation(1));

    await registry.load("swappable");
    expect(registry.services.get<number>("swap:generation")).toBe(1);

    await registry.reload("swappable", generation(2));
    expect(registry.services.get<number>("swap:generation")).toBe(2);
    expect(disposed).toEqual(["gen1"]);

    const messages: string[] = [];
    await registry
      .reload(
        "swappable",
        definePlugin({
          manifest: { name: "swappable", version: "0.1.0", apiVersion: 1 },
          setup: () => {
            throw new Error("replacement refused");
          },
        }),
      )
      .catch((error) => flatten(error, messages));
    expect(messages).toContain("plugin reload failed: swappable");
    expect(messages).toContain("replacement refused");

    // Rollback: the refused object is gone and the previous generation is live again.
    expect(registry.isLoaded("swappable")).toBe(true);
    expect(registry.services.get<number>("swap:generation")).toBe(2);
    expect(disposed).toEqual(["gen1", "gen2"]);

    await registry.reload("swappable", generation(3));
    expect(registry.services.get<number>("swap:generation")).toBe(3);
    expect(disposed).toEqual(["gen1", "gen2", "gen2"]);

    await registry.close();
    expect(disposed).toEqual(["gen1", "gen2", "gen2", "gen3"]);
    expect(registry.services.has("swap:generation")).toBe(false);
  });

  it("reloads the dependent closure so dependents observe the new generation", async () => {
    const observed: number[] = [];
    const provider = (value: number) =>
      definePlugin({
        manifest: {
          name: "provider",
          version: "0.1.0",
          apiVersion: 1,
          provides: ["swap:cap"],
        },
        setup({ services }) {
          services.register("swap:cap", value);
          return () => {};
        },
      });
    const registry = new Registry(silent);
    registry.register(provider(1));
    registry.register(
      definePlugin({
        manifest: { name: "consumer", version: "0.1.0", apiVersion: 1, requires: ["provider"] },
        setup: ({ capabilities }) => {
          observed.push(capabilities.get<number>("swap:cap"));
        },
      }),
    );

    await registry.load("consumer");
    expect(observed).toEqual([1]);

    await registry.reload("provider", provider(2));

    expect(observed).toEqual([1, 2]);
    expect(registry.loadedNames()).toEqual(["provider", "consumer"]);
    expect(registry.services.get<number>("swap:cap")).toBe(2);
    await registry.close();
    expect(registry.loadedNames()).toEqual([]);
  });
});

describe("registry shutdown", () => {
  it("close is terminal: the registry accepts nothing afterwards", async () => {
    const registry = new Registry(silent);
    registry.register(makePlugin("terminal"));
    await registry.load("terminal");

    await registry.close();
    expect(registry.loadedNames()).toEqual([]);

    await expect(registry.load("terminal")).rejects.toThrow("plugin registry is closed");
    await expect(registry.reload("terminal")).rejects.toThrow("plugin registry is closed");
    await expect(registry.loadAll(["terminal"])).rejects.toThrow("plugin registry is closed");
    await registry.unload("terminal");
    expect(registry.isLoaded("terminal")).toBe(false);
    await expect(registry.close()).resolves.toBeUndefined();
  });
});

describe("lifecycle events", () => {
  it("emits exactly the events the runtime catalog declares", async () => {
    const registry = new Registry(silent);
    const seen = new Map<string, string[]>();
    for (const event of PLUGIN_EVENT_NAMES) {
      seen.set(event, []);
      registry.events.on(event, ({ name }) => {
        seen.get(event)?.push(name);
      });
    }
    registry.register(makePlugin("alpha"));
    registry.register(makePlugin("beta", ["alpha"]));

    await registry.loadAll(["beta"]);
    await registry.close();

    expect([...seen.keys()].sort()).toEqual([...PLUGIN_EVENT_NAMES].sort());
    expect(seen.get("plugin:loaded")).toEqual(["alpha", "beta"]);
    expect(seen.get("plugin:unloaded")).toEqual(["beta", "alpha"]);
  });

  it("publishes plugin:loaded only after setup and plugin:unloaded only after disposal", async () => {
    const order: string[] = [];
    const registry = new Registry(silent);
    registry.register(
      definePlugin({
        manifest: {
          name: "tracked",
          version: "0.1.0",
          apiVersion: 1,
          provides: ["tracked:value"],
        },
        setup({ services }) {
          order.push("setup");
          services.register("tracked:value", 1);
          return () => {
            order.push("dispose");
          };
        },
      }),
    );
    registry.events.on("plugin:loaded", ({ name }) => {
      order.push(`loaded:${name}:${registry.services.has("tracked:value")}`);
    });
    registry.events.on("plugin:unloaded", ({ name }) => {
      order.push(`unloaded:${name}:${registry.services.has("tracked:value")}`);
    });

    await registry.load("tracked");
    await registry.unload("tracked");

    expect(order).toEqual(["setup", "loaded:tracked:true", "dispose", "unloaded:tracked:false"]);
  });

  it("fails closed on an event name outside the catalog without touching registry state", async () => {
    const reported: string[] = [];
    const registry = new Registry({
      info() {},
      warn() {},
      error: (message: string) => {
        reported.push(message);
      },
    });
    registry.register(makePlugin("watched"));
    const handler = vi.fn();
    const loaded = vi.fn();

    const off = registry.events.on("plugin:exploded" as never, handler);
    expect(off()).toBeUndefined();
    await registry.events.emit("plugin:exploded" as never, {} as never);
    expect(handler).not.toHaveBeenCalled();
    expect(reported).toEqual([
      "event handler failed: plugin:exploded",
      "event handler failed: plugin:exploded",
    ]);

    registry.events.on("plugin:loaded", loaded);
    await registry.load("watched");
    expect(loaded).toHaveBeenCalledWith({ name: "watched" });
    expect(registry.isLoaded("watched")).toBe(true);
  });

  it("drops a malformed lifecycle payload a plugin emits and keeps the lifecycle intact", async () => {
    const reported: string[] = [];
    const registry = new Registry({
      info() {},
      warn() {},
      error: (message: string) => {
        reported.push(message);
      },
    });
    const loaded: string[] = [];
    registry.events.on("plugin:loaded", ({ name }) => {
      loaded.push(name);
    });
    registry.register(
      definePlugin({
        manifest: { name: "forger", version: "0.1.0", apiVersion: 1 },
        async setup({ events }) {
          await events.emit("plugin:loaded", { name: 7 } as never);
          await events.emit("plugin:loaded", undefined as never);
          await events.emit("plugin:loaded", { name: "forged", extra: true } as never);
          return () => {};
        },
      }),
    );

    await expect(registry.load("forger")).resolves.toBeUndefined();
    expect(loaded).toEqual(["forger"]);
    expect(reported).toEqual([
      "event handler failed: plugin:loaded",
      "event handler failed: plugin:loaded",
      "event handler failed: plugin:loaded",
    ]);
    expect(registry.isLoaded("forger")).toBe(true);
    await registry.close();
  });

  it("survives a listener that throws and a logger that throws while reporting it", async () => {
    const registry = new Registry({
      info() {},
      warn() {},
      error: () => {
        throw new Error("logger down");
      },
    });
    registry.register(makePlugin("watched"));
    const sibling = vi.fn();
    registry.events.on("plugin:loaded", () => {
      throw new Error("listener boom");
    });
    registry.events.on("plugin:loaded", sibling);

    await expect(registry.load("watched")).resolves.toBeUndefined();
    expect(sibling).toHaveBeenCalledWith({ name: "watched" });
    expect(registry.isLoaded("watched")).toBe(true);
    await expect(registry.close()).resolves.toBeUndefined();
    expect(registry.isLoaded("watched")).toBe(false);
  });

  it("bounds a self-reloading lifecycle listener at the emit depth ceiling", async () => {
    const reported: string[] = [];
    const registry = new Registry({
      info() {},
      warn() {},
      error: (message: string) => {
        reported.push(message);
      },
    });
    let setups = 0;
    let disposals = 0;
    registry.register(
      definePlugin({
        manifest: { name: "loop", version: "0.1.0", apiVersion: 1 },
        setup: () => {
          setups += 1;
          return () => {
            disposals += 1;
          };
        },
      }),
    );
    registry.events.on("plugin:loaded", async ({ name }) => {
      await registry.unload(name);
      await registry.load(name);
    });

    const settled = await Promise.race([
      registry.load("loop").then(
        () => "settled",
        (error) => `rejected:${String(error)}`,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 2000)),
    ]);

    expect(settled).toBe("settled");
    expect(setups).toBe(MAX_EMIT_DEPTH + 1);
    expect(disposals).toBe(MAX_EMIT_DEPTH);
    expect(registry.isLoaded("loop")).toBe(true);
    expect(reported).toEqual(["event handler failed: plugin:loaded"]);

    await registry.close();
    expect(registry.isLoaded("loop")).toBe(false);
    expect(disposals).toBe(setups);
  });
});

describe("diagnostic hygiene", () => {
  it("keeps temp roots, home paths, and key material out of lifecycle diagnostics", async () => {
    const home = await tempRoot("nexus-lifecycle-home-");
    const root = await tempRoot("nexus-lifecycle-root-");
    const keyPath = join(home, ".config", "nexus", "user", "secrets", "provider.key");
    await mkdir(join(home, ".config", "nexus", "user", "secrets"), { recursive: true });
    await writeFile(keyPath, "sk-dummy-lifecycle-key", { encoding: "utf8", mode: 0o600 });
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);

    const diagnostics: string[] = [];
    const registry = new Registry(
      {
        info() {},
        warn() {},
        error: (message: string) => {
          diagnostics.push(message);
        },
      },
      () => ({ apiKeyFile: keyPath, model: "dummy-model" }),
      new PermissionGate({ network: "deny" }),
    );
    const attempt = async (run: () => Promise<unknown>): Promise<void> => {
      await run().then(
        () => undefined,
        (error) => {
          flatten(error, diagnostics);
        },
      );
    };

    await attempt(() => registry.load("ghost"));
    registry.register(makePlugin("orphan", ["absent"]));
    await attempt(() => registry.load("orphan"));
    registry.register(
      definePlugin({
        manifest: { name: "liar", version: "0.1.0", apiVersion: 1, provides: ["declared:value"] },
        setup({ services }) {
          services.register("hidden:value", 1);
        },
      }),
    );
    await attempt(() => registry.load("liar"));
    registry.register(
      definePlugin({
        manifest: { name: "net", version: "0.1.0", apiVersion: 1, permissions: ["network"] },
        async setup({ permissions }) {
          await permissions.check("network", "call provider");
        },
      }),
    );
    await attempt(() => registry.load("net"));
    for (const name of ["leaky-one", "leaky-two"]) {
      registry.register(
        definePlugin({
          manifest: { name, version: "0.1.0", apiVersion: 1 },
          setup: () => () => {
            throw new Error(`${name} disposer failed`);
          },
        }),
      );
    }
    await registry.loadAll(["leaky-one", "leaky-two"]);
    await attempt(() => registry.close());

    expect(new Set(diagnostics)).toEqual(
      new Set([
        "unknown plugin: ghost",
        "orphan requires absent, which is not registered",
        "service hidden:value is not declared in provides for liar",
        "permission denied: network (call provider)",
        "leaky-one disposer failed",
        "leaky-two disposer failed",
        "plugin shutdown failed",
      ]),
    );
    for (const line of diagnostics) {
      expect(line).not.toContain(home);
      expect(line).not.toContain(root);
      expect(line).not.toContain(keyPath);
      expect(line).not.toContain("sk-dummy-lifecycle-key");
    }
  });
});
