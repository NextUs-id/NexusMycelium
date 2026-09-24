import { describe, expect, it } from "vitest";
import { PluginManifestSchema } from "./manifest.js";

describe("PluginManifestSchema", () => {
  it("applies defaults", () => {
    const m = PluginManifestSchema.parse({ name: "a-b", version: "0.1.0", apiVersion: 1 });
    expect(m.provides).toEqual([]);
    expect(m.requires).toEqual([]);
    expect(m.permissions).toEqual([]);
  });

  it("rejects bad names and versions", () => {
    expect(() => PluginManifestSchema.parse({ name: "Bad Name", version: "0.1.0", apiVersion: 1 })).toThrow();
    expect(() => PluginManifestSchema.parse({ name: "ok", version: "v1", apiVersion: 1 })).toThrow();
  });

  it("rejects an unknown API version", () => {
    expect(() => PluginManifestSchema.parse({ name: "ok", version: "1.0.0", apiVersion: 2 })).toThrow();
  });
});
