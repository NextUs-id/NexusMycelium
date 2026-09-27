import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  EventBus,
  MAX_EMIT_DEPTH,
  PLUGIN_EVENT_NAMES,
  PLUGIN_EVENT_SCHEMAS,
  type PluginEventMap,
} from "./events.js";

type PingEvents = { ping: number };
const PING_CATALOG = { ping: z.number() } as const;

function collectErrors() {
  const errors: { event: string; error: unknown }[] = [];
  const onError = (event: string, error: unknown) => {
    errors.push({ event, error });
  };
  const messages = () =>
    errors.map((entry) => (entry.error instanceof Error ? entry.error.message : String(entry.error)));
  return { errors, onError, messages };
}

describe("plugin event catalog", () => {
  it("names and schemas stay equal to PluginEventMap", () => {
    expect(PLUGIN_EVENT_NAMES).toEqual(["plugin:loaded", "plugin:unloaded"]);
    expect([...PLUGIN_EVENT_NAMES].sort()).toEqual(Object.keys(PLUGIN_EVENT_SCHEMAS).sort());
  });

  it("exposes exactly the documented lifecycle payloads", () => {
    const bus = new EventBus<PluginEventMap>(collectErrors().onError);
    expect(bus.listenerCount("plugin:loaded")).toBe(0);
    expect(bus.listenerCount("plugin:unloaded")).toBe(0);
  });
});

describe("EventBus", () => {
  it("delivers payloads and supports unsubscribe", async () => {
    const bus = new EventBus<PingEvents>(() => {}, PING_CATALOG);
    const fn = vi.fn();
    const off = bus.on("ping", fn);
    await bus.emit("ping", 1);
    off();
    await bus.emit("ping", 2);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(1);
    expect(bus.listenerCount("ping")).toBe(0);
  });

  it("types plugin lifecycle payloads", async () => {
    const bus = new EventBus<PluginEventMap>();
    const names: string[] = [];
    bus.on("plugin:loaded", ({ name }) => {
      names.push(name);
    });
    await bus.emit("plugin:loaded", { name: "typed" });
    expect(names).toEqual(["typed"]);
  });

  it("isolates failing handlers", async () => {
    const { errors, onError } = collectErrors();
    const bus = new EventBus<PingEvents>(onError, PING_CATALOG);
    const ok = vi.fn();
    bus.on("ping", () => {
      throw new Error("boom");
    });
    bus.on("ping", ok);
    await bus.emit("ping", 1);
    expect(ok).toHaveBeenCalled();
    expect(errors.map((entry) => entry.event)).toEqual(["ping"]);
  });
});

describe("EventBus validation", () => {
  it("fails closed on malformed payloads and dispatches nothing", async () => {
    const { errors, onError } = collectErrors();
    const bus = new EventBus<PluginEventMap>(onError);
    const handler = vi.fn();
    bus.on("plugin:loaded", handler);
    await bus.emit("plugin:loaded", { name: 1 } as never);
    await bus.emit("plugin:loaded", { name: "" });
    await bus.emit("plugin:loaded", { name: "x", extra: true } as never);
    await bus.emit("plugin:loaded", undefined as never);
    expect(handler).not.toHaveBeenCalled();
    expect(errors.map((entry) => entry.event)).toEqual([
      "plugin:loaded",
      "plugin:loaded",
      "plugin:loaded",
      "plugin:loaded",
    ]);
  });

  it("fails closed on an event name outside the catalog, in on and in emit", async () => {
    const { errors, onError, messages } = collectErrors();
    const bus = new EventBus<PluginEventMap>(onError);
    const off = bus.on("plugin:exploded" as never, vi.fn());
    expect(bus.listenerCount("plugin:loaded")).toBe(0);
    expect(off()).toBeUndefined();
    await bus.emit("plugin:exploded" as never, {} as never);
    expect(errors.map((entry) => entry.event)).toEqual(["plugin:exploded", "plugin:exploded"]);
    expect(messages()).toEqual(["unknown event: plugin:exploded", "unknown event: plugin:exploded"]);
  });

  it("uses the plugin catalog by default, so a custom map fails closed without one", async () => {
    const { errors, onError } = collectErrors();
    const bus = new EventBus<PingEvents>(onError);
    const handler = vi.fn();
    bus.on("ping", handler);
    await bus.emit("ping", 1);
    expect(handler).not.toHaveBeenCalled();
    expect(errors).toHaveLength(2);
  });
});

describe("EventBus error reporting", () => {
  it("never rejects emit when onError throws", async () => {
    const bus = new EventBus<PluginEventMap>(() => {
      throw new Error("reporter exploded");
    });
    bus.on("plugin:loaded", () => {
      throw new Error("handler exploded");
    });
    bus.on("plugin:loaded", vi.fn());
    await expect(bus.emit("plugin:loaded", { name: "a" })).resolves.toBeUndefined();
    await expect(bus.emit("plugin:loaded", { name: "" })).resolves.toBeUndefined();
    await expect(bus.emit("plugin:nope" as never, {} as never)).resolves.toBeUndefined();
  });
});

describe("EventBus reentrancy", () => {
  it("terminates a handler that re-emits its own event", async () => {
    const { errors, onError, messages } = collectErrors();
    const bus = new EventBus<PluginEventMap>(onError);
    let dispatched = 0;
    bus.on("plugin:loaded", () => {
      dispatched += 1;
      return bus.emit("plugin:loaded", { name: "loop" });
    });
    await bus.emit("plugin:loaded", { name: "loop" });
    expect(dispatched).toBe(MAX_EMIT_DEPTH);
    expect(errors).toHaveLength(1);
    expect(messages()).toEqual([`emit depth limit ${MAX_EMIT_DEPTH} exceeded`]);
  });

  it("resets the depth counter so a later emit still dispatches", async () => {
    const bus = new EventBus<PluginEventMap>();
    const handler = vi.fn();
    bus.on("plugin:unloaded", handler);
    await bus.emit("plugin:unloaded", { name: "first" });
    await bus.emit("plugin:unloaded", { name: "second" });
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe("EventBus dispatch order", () => {
  it("awaits every handler before emit resolves", async () => {
    const bus = new EventBus<PluginEventMap>();
    const done: string[] = [];
    bus.on("plugin:loaded", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      done.push("slow");
    });
    bus.on("plugin:loaded", () => {
      done.push("fast");
    });
    await bus.emit("plugin:loaded", { name: "a" });
    expect(done.sort()).toEqual(["fast", "slow"]);
  });

  it("keeps a mid-dispatch unsubscribe out of the current emit only", async () => {
    const bus = new EventBus<PluginEventMap>();
    const calls: string[] = [];
    const offB = bus.on("plugin:loaded", () => {
      calls.push("b");
    });
    bus.on("plugin:loaded", () => {
      calls.push("a");
      offB();
    });
    await bus.emit("plugin:loaded", { name: "first" });
    expect(calls.sort()).toEqual(["a", "b"]);
    expect(bus.listenerCount("plugin:loaded")).toBe(1);
    await bus.emit("plugin:loaded", { name: "second" });
    expect(calls).toEqual(["a", "b", "a"]);
  });

  it("does not call handlers registered during the same emit", async () => {
    const bus = new EventBus<PluginEventMap>();
    const late = vi.fn();
    bus.on("plugin:unloaded", () => {
      bus.on("plugin:unloaded", late);
    });
    await bus.emit("plugin:unloaded", { name: "a" });
    expect(late).not.toHaveBeenCalled();
    await bus.emit("plugin:unloaded", { name: "b" });
    expect(late).toHaveBeenCalledWith({ name: "b" });
  });
});
