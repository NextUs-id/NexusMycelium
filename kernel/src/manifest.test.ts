import { describe, expect, it } from "vitest";
import { PluginManifestSchema } from "./manifest.js";

const base = { name: "a-b", version: "0.1.0", apiVersion: 1 };

describe("PluginManifestSchema", () => {
  it("applies defaults and freezes the parsed manifest", () => {
    const manifest = PluginManifestSchema.parse(base);
    expect(manifest.provides).toEqual([]);
    expect(manifest.requires).toEqual([]);
    expect(manifest.permissions).toEqual([]);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.provides)).toBe(true);
    expect(Reflect.set(manifest as object, "name", "changed")).toBe(false);
    expect(Reflect.set(manifest.provides as object, 0, "changed")).toBe(false);
  });

  it("rejects non-canonical names and incomplete versions", () => {
    for (const name of ["bad-", "bad--name", "-bad", "Bad Name", "bad_name"]) {
      expect(() => PluginManifestSchema.parse({ ...base, name })).toThrow();
    }
    for (const version of ["1", "1.2", "1.2.3.4", "v1.2.3", "01.2.3", "1.02.3"]) {
      expect(() => PluginManifestSchema.parse({ ...base, version })).toThrow();
    }
  });

  it("requires API version 1 exactly", () => {
    expect(() => PluginManifestSchema.parse({ ...base, apiVersion: 2 })).toThrow();
    expect(() => PluginManifestSchema.parse({ ...base, apiVersion: "1" })).toThrow();
  });

  it("requires non-empty unique capability lists and rejects self-require", () => {
    expect(() => PluginManifestSchema.parse({ ...base, provides: [""] })).toThrow();
    expect(() => PluginManifestSchema.parse({ ...base, provides: ["x", "x"] })).toThrow();
    expect(() => PluginManifestSchema.parse({ ...base, requires: ["a", "a"] })).toThrow();
    expect(() => PluginManifestSchema.parse({ ...base, permissions: ["fs.read", "fs.read"] })).toThrow();
    expect(() => PluginManifestSchema.parse({ ...base, requires: ["a-b"] })).toThrow();
  });

  it("rejects unknown fields and unsafe prototype keys", () => {
    expect(() => PluginManifestSchema.parse({ ...base, extra: true })).toThrow();
    expect(() => PluginManifestSchema.parse({ ...base, provides: ["__proto__"] })).toThrow();
    expect(() => PluginManifestSchema.parse({ ...base, provides: ["constructor"] })).toThrow();
    const polluted = { ...base } as Record<string, unknown>;
    Object.defineProperty(polluted, "__proto__", { value: {}, enumerable: true });
    expect(() => PluginManifestSchema.parse(polluted)).toThrow();
  });
});
