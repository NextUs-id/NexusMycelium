import { describe, expect, it, vi } from "vitest";
import { definePlugin } from "./plugin.js";
import { Registry } from "./registry.js";

const silent = { info() {}, warn() {}, error() {} };
const make = (name: string, requires: string[] = [], dispose = () => {}) =>
  definePlugin({
    manifest: { name, version: "0.1.0", apiVersion: 1, requires },
    setup: () => dispose,
  });

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

  it("rejects duplicate registration", () => {
    const reg = new Registry(silent);
    reg.register(make("a"));
    expect(() => reg.register(make("a"))).toThrow(/already registered/);
  });
});
