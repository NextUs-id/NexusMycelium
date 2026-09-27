import { describe, expect, it, vi } from "vitest";
import type { PluginEventMap } from "./events.js";
import { PermissionGate } from "./permissions.js";
import { definePlugin, type Plugin, type PluginContext } from "./plugin.js";
import { Registry } from "./registry.js";
import type { PluginServices } from "./services.js";

const silent = { info() {}, warn() {}, error() {} };
const make = (name: string, requires: string[] = [], dispose = () => {}) =>
  definePlugin({
    manifest: { name, version: "0.1.0", apiVersion: 1, requires },
    setup: () => dispose,
  });
const makeProvider = (name: string, service: string, owner?: string) =>
  definePlugin({
    manifest: { name, version: "0.1.0", apiVersion: 1, provides: [service] },
    setup: ({ services }) => {
      services.register(service, name, owner);
    },
  });

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function messages(error: unknown): string[] {
  if (error instanceof AggregateError) {
    return [error.message, ...error.errors.flatMap((inner) => messages(inner))];
  }
  return [error instanceof Error ? error.message : String(error)];
}

describe("Registry", () => {
  it("loads and unloads without restart, calling the disposer", async () => {
    const dispose = vi.fn();
    const reg = new Registry(silent);
    reg.register(make("a", [], dispose));
    await reg.load("a");
    expect(reg.isLoaded("a")).toBe(true);
    await reg.unload("a");
    expect(reg.isLoaded("a")).toBe(false);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("refuses to load when a dependency is missing", async () => {
    const reg = new Registry(silent);
    reg.register(make("b", ["a"]));
    await expect(reg.load("b")).rejects.toThrow(/requires a/);
  });

  it("refuses to unload a plugin others depend on", async () => {
    const reg = new Registry(silent);
    reg.register(make("a"));
    reg.register(make("b", ["a"]));
    await reg.load("a");
    await reg.load("b");
    await expect(reg.unload("a")).rejects.toThrow(/depends on it/);
  });

  it("refuses to unload a dependency while its dependent is loading", async () => {
    const setupGate = deferred();
    const setupStarted = deferred();
    const dispose = vi.fn();
    const reg = new Registry(silent);
    reg.register(make("a", [], dispose));
    reg.register(
      definePlugin({
        manifest: { name: "b", version: "0.1.0", apiVersion: 1, requires: ["a"] },
        setup: async () => {
          setupStarted.resolve();
          await setupGate.promise;
          return dispose;
        },
      }),
    );

    const loading = reg.load("b");
    await setupStarted.promise;
    await expect(reg.unload("a")).rejects.toThrow(/b is loading and depends on it/);
    expect(reg.isLoaded("a")).toBe(true);
    expect(dispose).not.toHaveBeenCalled();

    setupGate.resolve();
    await loading;
    await expect(reg.unload("a")).rejects.toThrow(/b depends on it/);
  });

  it("loads dependencies recursively and closes in reverse order", async () => {
    const order: string[] = [];
    const makeTracked = (name: string, requires: string[] = []) =>
      definePlugin({
        manifest: { name, version: "0.1.0", apiVersion: 1, requires },
        setup: () => {
          order.push(`load:${name}`);
          return () => {
            order.push(`close:${name}`);
          };
        },
      });
    const reg = new Registry(silent);
    reg.register(makeTracked("a"));
    reg.register(makeTracked("b", ["a"]));
    reg.register(makeTracked("c", ["b"]));
    await reg.load("c");
    expect(reg.loadedNames()).toEqual(["a", "b", "c"]);
    await reg.close();
    expect(order).toEqual(["load:a", "load:b", "load:c", "close:c", "close:b", "close:a"]);
  });

  it("rejects dependency cycles and cleans partial services", async () => {
    const reg = new Registry(silent);
    reg.register(make("a", ["b"]));
    reg.register(make("b", ["a"]));
    await expect(reg.load("a")).rejects.toThrow(/cycle/);
    expect(reg.loadedNames()).toEqual([]);
  });

  it("exposes services and removes them on unload", async () => {
    const plugin = definePlugin({
      manifest: { name: "service", version: "0.1.0", apiVersion: 1, provides: ["answer"] },
      setup: ({ services }) => {
        services.register("answer", 42, "service");
      },
    });
    const reg = new Registry(silent);
    reg.register(plugin);
    await reg.load("service");
    expect(reg.services.get<number>("answer")).toBe(42);
    await reg.unload("service");
    expect(reg.services.has("answer")).toBe(false);
  });

  it("rejects duplicate registration", () => {
    const reg = new Registry(silent);
    reg.register(make("a"));
    expect(() => reg.register(make("a"))).toThrow(/already registered/);
  });

  it("shares concurrent load and unload operations per plugin", async () => {
    const setupGate = deferred();
    const dispose = vi.fn();
    const setup = vi.fn(async () => {
      await setupGate.promise;
      return dispose;
    });
    const reg = new Registry(silent);
    reg.register(
      definePlugin({
        manifest: { name: "a", version: "0.1.0", apiVersion: 1 },
        setup,
      }),
    );
    const firstLoad = reg.load("a");
    const secondLoad = reg.load("a");
    expect(secondLoad).toBe(firstLoad);
    setupGate.resolve();
    await Promise.all([firstLoad, secondLoad]);
    expect(setup).toHaveBeenCalledOnce();

    const firstUnload = reg.unload("a");
    const secondUnload = reg.unload("a");
    expect(secondUnload).toBe(firstUnload);
    await Promise.all([firstUnload, secondUnload]);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("waits for in-flight setup before close", async () => {
    const setupGate = deferred();
    const order: string[] = [];
    const reg = new Registry(silent);
    reg.register(
      definePlugin({
        manifest: { name: "a", version: "0.1.0", apiVersion: 1 },
        setup: async () => {
          await setupGate.promise;
          order.push("setup");
          return () => {
            order.push("close");
          };
        },
      }),
    );
    const loading = reg.load("a");
    const closing = reg.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    setupGate.resolve();
    await Promise.all([loading, closing]);
    expect(order).toEqual(["setup", "close"]);
  });

  it("waits for a load queued before close", async () => {
    const order: string[] = [];
    const reg = new Registry(silent);
    reg.register(
      definePlugin({
        manifest: { name: "a", version: "0.1.0", apiVersion: 1 },
        setup: () => {
          order.push("setup");
          return () => {
            order.push("close");
          };
        },
      }),
    );
    await reg.load("a");
    const unloading = reg.unload("a");
    const reloading = reg.load("a");
    const closing = reg.close();
    await Promise.all([unloading, reloading, closing]);
    expect(order).toEqual(["setup", "close", "setup", "close"]);
    expect(reg.isLoaded("a")).toBe(false);
  });

  it("rejects concurrent dependency cycles without deadlocking", async () => {
    const reg = new Registry(silent);
    reg.register(make("a", ["b"]));
    reg.register(make("b", ["a"]));
    const results = await Promise.allSettled([reg.load("a"), reg.load("b")]);
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
  });

  it("scopes plugin permissions and service capabilities", async () => {
    const reg = new Registry(
      silent,
      () => ({}),
      new PermissionGate({ "fs.write": "allow", network: "allow" }),
    );
    reg.register(
      definePlugin({
        manifest: { name: "provider", version: "0.1.0", apiVersion: 1, provides: ["secret"] },
        setup: ({ services }) => {
          services.register("secret", 42, "provider");
        },
      }),
    );
    reg.register(
      definePlugin({
        manifest: { name: "consumer", version: "0.1.0", apiVersion: 1 },
        setup: async ({ services, capabilities, permissions }) => {
          expect(services.has("secret")).toBe(false);
          expect(capabilities.has("secret")).toBe(false);
          expect(() => services.get("secret")).toThrow(/service not found/);
          expect(permissions.decision("fs.write")).toBe("deny");
          await expect(permissions.check("fs.write", "write file")).rejects.toThrow(/permission denied/);
        },
      }),
    );
    await reg.load("provider");
    await reg.load("consumer");
  });

  it("delegates the provider capability closure through requires", async () => {
    const reg = new Registry(silent);
    reg.register(
      definePlugin({
        manifest: { name: "provider", version: "0.1.0", apiVersion: 1, provides: ["secret"] },
        setup: ({ services }) => {
          services.register("secret", 42);
        },
      }),
    );
    reg.register(
      definePlugin({
        manifest: { name: "consumer", version: "0.1.0", apiVersion: 1, requires: ["provider"] },
        setup: ({ capabilities }) => {
          expect(capabilities.get<number>("secret")).toBe(42);
          expect(capabilities.owner("secret")).toBe("provider");
        },
      }),
    );
    await reg.load("consumer");
    await reg.close();
  });

  it("reparses and freezes manifests at the registration boundary", async () => {
    const manifest = { name: "immutable", version: "0.1.0", apiVersion: 1, provides: ["value"] };
    const reg = new Registry(silent);
    const setup: Plugin["setup"] = ({ services }: PluginContext) => {
      services.register("value", 7);
    };
    reg.register({ manifest, setup } as unknown as Plugin);
    manifest.name = "mutated";
    manifest.provides.push("hidden");
    await reg.load("immutable");
    expect(reg.services.get<number>("value")).toBe(7);
    await reg.close();
  });

  it("rejects malformed direct plugin objects", () => {
    const reg = new Registry(silent);
    expect(() => reg.register(null as unknown as Plugin)).toThrow(/object/);
    expect(() =>
      reg.register({
        manifest: { name: "bad-", version: "0.1.0", apiVersion: 1 },
        setup() {},
      } as unknown as Plugin),
    ).toThrow(/manifest/);
    expect(() =>
      reg.register({
        manifest: { name: "bad-setup", version: "0.1.0", apiVersion: 1 },
        setup: 1,
      } as unknown as Plugin),
    ).toThrow(/setup/);
  });

  it("enforces provides and validates setup and disposer return values", async () => {
    const reg = new Registry(silent);
    reg.register(
      definePlugin({
        manifest: { name: "liar", version: "0.1.0", apiVersion: 1, provides: ["declared"] },
        setup: ({ services }) => {
          services.register("hidden", 1);
        },
      }),
    );
    await expect(reg.load("liar")).rejects.toThrow(/provides/);
    expect(reg.services.has("hidden")).toBe(false);

    reg.register({
      manifest: { name: "bad-setup", version: "0.1.0", apiVersion: 1 },
      setup: (() => ({ invalid: true })) as unknown as Plugin["setup"],
    } as unknown as Plugin);
    await expect(reg.load("bad-setup")).rejects.toThrow(/disposer/);

    reg.register({
      manifest: { name: "bad-disposer", version: "0.1.0", apiVersion: 1 },
      setup: (() => () => Promise.resolve(1)) as unknown as Plugin["setup"],
    } as unknown as Plugin);
    await reg.load("bad-disposer");
    await expect(reg.unload("bad-disposer")).rejects.toThrow(/disposer/);
    expect(reg.isLoaded("bad-disposer")).toBe(false);
  });

  it("does not deadlock when a dependency listener closes the registry", async () => {
    const reg = new Registry(silent);
    reg.register(
      definePlugin({
        manifest: { name: "provider", version: "0.1.0", apiVersion: 1 },
        setup: () => undefined,
      }),
    );
    reg.register(
      definePlugin({
        manifest: { name: "consumer", version: "0.1.0", apiVersion: 1, requires: ["provider"] },
        setup: () => undefined,
      }),
    );
    let finished!: () => void;
    const closed = new Promise<void>((resolve) => {
      finished = resolve;
    });
    reg.events.on("plugin:loaded", async ({ name }) => {
      if (name === "provider") {
        await reg.close();
        finished();
      }
    });
    await Promise.all([reg.load("consumer"), closed]);
    expect(reg.isLoaded("consumer")).toBe(false);
  });

  it("allows an unloaded listener to reload without deadlocking", async () => {
    const reg = new Registry(silent);
    reg.register(
      definePlugin({
        manifest: { name: "recyclable", version: "0.1.0", apiVersion: 1 },
        setup: () => undefined,
      }),
    );
    const off = reg.events.on("plugin:unloaded", async ({ name }) => {
      await reg.load(name);
    });
    await reg.load("recyclable");
    await reg.unload("recyclable");
    expect(reg.isLoaded("recyclable")).toBe(true);
    off();
    await reg.close();
  });

  it("settles lifecycle state before reentrant listeners run", async () => {
    const order: string[] = [];
    const reg = new Registry(silent);
    reg.register(
      definePlugin({
        manifest: { name: "reentrant", version: "0.1.0", apiVersion: 1 },
        setup: () => {
          order.push("setup");
          return () => {
            order.push("dispose");
          };
        },
      }),
    );
    reg.events.on("plugin:loaded", async ({ name }) => {
      order.push("loaded");
      await reg.unload(name);
      order.push("after-unload");
    });
    await reg.load("reentrant");
    expect(order).toEqual(["setup", "loaded", "dispose", "after-unload"]);
    expect(reg.isLoaded("reentrant")).toBe(false);
  });

  it("fails closed when one plugin registers a capability twice", async () => {
    const reg = new Registry(silent);
    reg.register(
      definePlugin({
        manifest: { name: "double", version: "0.1.0", apiVersion: 1, provides: ["cap"] },
        setup: ({ services }) => {
          services.register("cap", 1);
          services.register("cap", 2);
        },
      }),
    );
    await expect(reg.load("double")).rejects.toThrow(/service already registered: cap/);
    expect(reg.isLoaded("double")).toBe(false);
    expect(reg.services.has("cap")).toBe(false);
    expect(reg.services.owner("cap")).toBeUndefined();
  });

  it("keeps the first owner when two plugins claim the same capability", async () => {
    const reg = new Registry(silent);
    reg.register(makeProvider("first", "cap"));
    reg.register(makeProvider("second", "cap"));
    await reg.load("first");
    await expect(reg.load("second")).rejects.toThrow(/service already registered: cap/);
    expect(reg.isLoaded("second")).toBe(false);
    expect(reg.loadedNames()).toEqual(["first"]);
    expect(reg.services.get<string>("cap")).toBe("first");
    expect(reg.services.owner("cap")).toBe("first");
    await reg.close();
  });

  it("rejects a service owner that is not the registering plugin", async () => {
    const reg = new Registry(silent);
    reg.register(makeProvider("impostor", "cap", "somebody-else"));
    await expect(reg.load("impostor")).rejects.toThrow(/service owner must be impostor/);
    expect(reg.isLoaded("impostor")).toBe(false);
    expect(reg.services.has("cap")).toBe(false);
    expect(reg.services.owner("cap")).toBeUndefined();
  });

  it("refuses registration through a service facade retained past unload", async () => {
    const reg = new Registry(silent);
    let facade: PluginServices | undefined;
    reg.register(
      definePlugin({
        manifest: { name: "retained", version: "0.1.0", apiVersion: 1, provides: ["cap"] },
        setup: (ctx) => {
          facade = ctx.services;
          ctx.services.register("cap", 1);
        },
      }),
    );
    await reg.load("retained");
    await reg.unload("retained");
    expect(facade?.has("cap")).toBe(false);
    expect(facade?.owner("cap")).toBeUndefined();
    expect(() => facade?.register("cap", 2)).toThrow(/unloaded|not loaded/i);
    expect(reg.services.has("cap")).toBe(false);
    expect(reg.loadedNames()).toEqual([]);
  });

  it("emits ordered typed lifecycle payloads and isolates a failing listener", async () => {
    const errors: string[] = [];
    const log = {
      info() {},
      warn() {},
      error: (message: string) => {
        errors.push(message);
      },
    };
    const loaded: PluginEventMap["plugin:loaded"][] = [];
    const unloaded: PluginEventMap["plugin:unloaded"][] = [];
    const reg = new Registry(log);
    reg.register(make("alpha"));
    reg.register(make("beta", ["alpha"]));
    reg.events.on("plugin:loaded", (payload) => {
      loaded.push(payload);
      throw new Error("listener boom");
    });
    reg.events.on("plugin:unloaded", async (payload) => {
      await Promise.resolve();
      unloaded.push(payload);
    });
    await reg.load("beta");
    await reg.close();
    expect(loaded).toEqual([{ name: "alpha" }, { name: "beta" }]);
    expect(unloaded).toEqual([{ name: "beta" }, { name: "alpha" }]);
    expect(errors).toEqual(["event handler failed: plugin:loaded", "event handler failed: plugin:loaded"]);
    expect(reg.loadedNames()).toEqual([]);
  });

  it("loads a bulk request in dependency order and isolates a failed sibling", async () => {
    const order: string[] = [];
    const tracked = (name: string, requires: string[] = []) =>
      definePlugin({
        manifest: { name, version: "0.1.0", apiVersion: 1, requires },
        setup: () => {
          order.push(name);
          return () => {};
        },
      });
    const reg = new Registry(silent);
    reg.register(tracked("alpha"));
    reg.register(tracked("beta", ["alpha"]));
    reg.register(tracked("gamma", ["beta"]));
    reg.register(tracked("island"));
    reg.register(
      definePlugin({
        manifest: { name: "broken", version: "0.1.0", apiVersion: 1 },
        setup: () => {
          throw new Error("setup exploded");
        },
      }),
    );
    reg.register(tracked("dependent", ["broken"]));

    const report = await reg.loadAll(["gamma", "broken", "dependent", "island"]);

    expect(report.loaded).toEqual(["alpha", "beta", "gamma", "island"]);
    expect(order).toEqual(["alpha", "beta", "gamma", "island"]);
    expect(report.failures).toEqual([
      { name: "broken", error: "setup exploded" },
      { name: "dependent", error: "dependent requires broken: setup exploded" },
    ]);
    expect(reg.loadedNames()).toEqual(["alpha", "beta", "gamma", "island"]);
  });

  it("fails closed in strict mode and still isolates the sibling", async () => {
    const reg = new Registry(silent);
    reg.register(make("ok"));
    reg.register(
      definePlugin({
        manifest: { name: "broken", version: "0.1.0", apiVersion: 1 },
        setup: () => {
          throw new Error("setup exploded");
        },
      }),
    );

    const error = await reg.loadAll(["ok", "broken"], { strict: true }).then(
      () => undefined,
      (rejected: unknown) => rejected,
    );

    expect(messages(error)).toEqual(["plugin load failed", "setup exploded"]);
    expect(reg.isLoaded("ok")).toBe(true);
    expect(reg.isLoaded("broken")).toBe(false);
  });

  it("reports an unusable graph per name without running any setup", async () => {
    const setup = vi.fn();
    const reg = new Registry(silent);
    reg.register(make("needs-ghost", ["ghost"]));
    const report = await reg.loadAll(["needs-ghost", "ghost", "ghost"]);

    expect(report.loaded).toEqual([]);
    expect(report.failures).toEqual([
      { name: "needs-ghost", error: "needs-ghost requires ghost, which is not registered" },
      { name: "ghost", error: "unknown plugin: ghost" },
    ]);
    expect(reg.loadedNames()).toEqual([]);
    expect(setup).not.toHaveBeenCalled();
  });

  it("reports the whole path of a three and a four plugin cycle", async () => {
    const cycle = (path: readonly string[]) => {
      const reg = new Registry(silent);
      for (const [index, name] of path.entries()) {
        reg.register(make(name, [path[(index + 1) % path.length] ?? name]));
      }
      return reg;
    };
    const short = cycle(["a", "b", "c"]);
    const report = await short.loadAll(["a", "b"]);

    expect(report.loaded).toEqual([]);
    expect(report.failures.map((failure) => failure.name)).toEqual(["c", "b", "a"]);
    for (const failure of report.failures) {
      expect(failure.error).toContain("a -> b -> c -> a");
    }
    expect(short.loadedNames()).toEqual([]);
    await expect(short.load("a")).rejects.toThrow("plugin dependency cycle: a -> b -> c -> a");

    const long = cycle(["w", "x", "y", "z"]);
    const longer = await long.loadAll(["w"]);

    expect(longer.loaded).toEqual([]);
    for (const failure of longer.failures) {
      expect(failure.error).toContain("w -> x -> y -> z -> w");
    }
  });

  it("loads a shared dependency once through a diamond", async () => {
    const base = vi.fn();
    const reg = new Registry(silent);
    reg.register(
      definePlugin({
        manifest: { name: "base", version: "0.1.0", apiVersion: 1 },
        setup: base,
      }),
    );
    reg.register(make("left", ["base"]));
    reg.register(make("right", ["base"]));
    reg.register(make("top", ["left", "right"]));

    const report = await reg.loadAll(["top"]);

    expect(report.loaded).toEqual(["base", "left", "right", "top"]);
    expect(base).toHaveBeenCalledOnce();
  });

  it("swaps an object, disposes the old generation once, and rolls a refused swap back", async () => {
    const disposed: string[] = [];
    const observed: number[] = [];
    const generation = (value: number) =>
      definePlugin({
        manifest: {
          name: "provider",
          version: "0.1.0",
          apiVersion: 1,
          requires: [],
          provides: ["swap:cap"],
        },
        setup: ({ services }) => {
          services.register("swap:cap", value);
          return () => {
            disposed.push(`gen${value}`);
          };
        },
      });
    const events: string[] = [];
    const reg = new Registry(silent);
    reg.register(generation(1));
    reg.register(
      definePlugin({
        manifest: { name: "consumer", version: "0.1.0", apiVersion: 1, requires: ["provider"] },
        setup: ({ capabilities }) => {
          observed.push(capabilities.get<number>("swap:cap"));
          return () => {
            disposed.push("consumer");
          };
        },
      }),
    );
    for (const event of ["plugin:loaded", "plugin:unloaded"] as const) {
      reg.events.on(event, ({ name }) => {
        events.push(`${event.split(":")[1]}:${name}`);
      });
    }
    await reg.load("consumer");
    await reg.reload("provider", generation(2));

    expect(reg.services.get<number>("swap:cap")).toBe(2);
    expect(observed).toEqual([1, 2]);
    expect(disposed).toEqual(["consumer", "gen1"]);
    expect(reg.loadedNames()).toEqual(["provider", "consumer"]);
    expect(events).toEqual([
      "loaded:provider",
      "loaded:consumer",
      "unloaded:consumer",
      "unloaded:provider",
      "loaded:provider",
      "loaded:consumer",
    ]);

    const refused = definePlugin({
      manifest: { name: "provider", version: "0.1.0", apiVersion: 1, provides: ["swap:cap"] },
      setup: ({ services }) => {
        services.register("swap:cap", 3);
        throw new Error("replacement refused");
      },
    });
    const failure = await reg.reload("provider", refused).then(
      () => undefined,
      (rejected: unknown) => rejected,
    );

    expect(messages(failure)).toEqual(["plugin reload failed: provider", "replacement refused"]);

    expect(reg.isLoaded("provider")).toBe(true);
    expect(reg.isLoaded("consumer")).toBe(true);
    expect(reg.services.get<number>("swap:cap")).toBe(2);
    expect(reg.services.names()).toEqual(["swap:cap"]);
    expect(reg.services.owner("swap:cap")).toBe("provider");
    expect(observed).toEqual([1, 2, 2]);
    expect(disposed).toEqual(["consumer", "gen1", "consumer", "gen2"]);

    await reg.close();
    expect(reg.loadedNames()).toEqual([]);
    expect(reg.services.names()).toEqual([]);
  });

  it("refuses a replacement that is not the same plugin", async () => {
    const reg = new Registry(silent);
    reg.register(make("provider"));
    await expect(reg.reload("provider", make("impostor"))).rejects.toThrow(/must be named provider/);
    await expect(reg.reload("ghost", make("ghost"))).rejects.toThrow(/unknown plugin/);
    await reg.load("provider");
    expect(reg.isLoaded("provider")).toBe(true);
  });

  it("refuses a service facade retained from before a reload", async () => {
    let facade: PluginServices | undefined;
    const generation = (value: number) =>
      definePlugin({
        manifest: { name: "provider", version: "0.1.0", apiVersion: 1, provides: ["swap:cap"] },
        setup: (ctx) => {
          if (value === 1) facade = ctx.services;
          ctx.services.register("swap:cap", value);
        },
      });
    const reg = new Registry(silent);
    reg.register(generation(1));
    await reg.load("provider");
    await reg.reload("provider", generation(2));

    expect(reg.services.get<number>("swap:cap")).toBe(2);
    expect(() => facade?.register("swap:cap", 3)).toThrow(/not loaded/);
    expect(reg.services.get<number>("swap:cap")).toBe(2);
    await reg.close();
  });

  it("settles concurrent load, reload, and close without deadlocking or orphaning services", async () => {
    const setupGate = deferred();
    const disposed: string[] = [];
    const reg = new Registry(silent);
    reg.register(
      definePlugin({
        manifest: { name: "swappable", version: "0.1.0", apiVersion: 1, provides: ["swap:cap"] },
        setup: async ({ services }) => {
          await setupGate.promise;
          services.register("swap:cap", 1);
          return () => {
            disposed.push("gen1");
          };
        },
      }),
    );

    const loading = reg.load("swappable");
    const reloading = reg.reload("swappable");
    const closing = reg.close();
    setupGate.resolve();
    await Promise.allSettled([loading, reloading, closing]);

    expect(reg.loadedNames()).toEqual([]);
    expect(reg.services.names()).toEqual([]);
    expect(disposed).toEqual(["gen1"]);
    await expect(reg.load("swappable")).rejects.toThrow(/closed/);
  });

  it("is terminal and shares one shutdown between concurrent close calls", async () => {
    const dispose = vi.fn();
    const reg = new Registry(silent);
    reg.register(make("a", [], dispose));
    await reg.load("a");

    const first = reg.close();
    const second = reg.close();
    expect(second).toBe(first);
    await Promise.all([first, second]);

    expect(dispose).toHaveBeenCalledOnce();
    expect(reg.loadedNames()).toEqual([]);
    await expect(reg.load("a")).rejects.toThrow(/closed/);
    await expect(reg.loadAll(["a"])).rejects.toThrow(/closed/);
    await expect(reg.reload("a")).rejects.toThrow(/closed/);
    await reg.unload("a");
    expect(reg.isLoaded("a")).toBe(false);
  });
});
