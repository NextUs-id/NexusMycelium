import { describe, expect, it, vi } from "vitest";
import type { Permission } from "./manifest.js";
import { PermissionGate } from "./permissions.js";

describe("PermissionGate", () => {
  it("defaults risky permissions to deny", async () => {
    const gate = new PermissionGate();
    await expect(gate.check("fs.write", "write file")).rejects.toThrow(/permission denied/);
    await expect(gate.check("shell", "run command")).rejects.toThrow(/permission denied/);
    await expect(gate.check("network", "fetch URL")).rejects.toThrow(/permission denied/);
  });

  it("requires an explicit approval for ask policies", async () => {
    const ask = vi.fn(async () => true);
    const gate = new PermissionGate({ "fs.write": "ask" }, ask);
    await expect(gate.check("fs.write", "write file")).resolves.toBeUndefined();
    expect(ask).toHaveBeenCalledWith("fs.write", "write file");
  });

  it("never asks for a denied permission", async () => {
    const ask = vi.fn(async () => true);
    const gate = new PermissionGate({ "fs.write": "deny" }, ask);
    await expect(gate.check("fs.write", "write file")).rejects.toThrow(/permission denied/);
    expect(ask).not.toHaveBeenCalled();
  });

  it("scopes declarations without widening a nested scope", async () => {
    const gate = new PermissionGate({ "fs.write": "allow", network: "allow" });
    const scoped = gate.scope(["network"]).scope(["network", "fs.write"]);
    expect(scoped.decision("network")).toBe("allow");
    expect(scoped.decision("fs.write")).toBe("deny");
    await expect(scoped.check("fs.write", "write file")).rejects.toThrow(/permission denied/);
  });

  it("fails closed for unknown permission names", async () => {
    const ask = vi.fn(async () => true);
    const gate = new PermissionGate({ "fs.write": "allow" }, ask);
    await expect(gate.check("fs.unknown" as Permission, "read file")).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    expect(ask).not.toHaveBeenCalled();
  });

  it("fails closed for invalid policy values even with approval", async () => {
    const ask = vi.fn(async () => true);
    const gate = new PermissionGate({ "fs.write": "maybe" } as never, ask);
    expect(gate.decision("fs.write")).toBe("deny");
    await expect(gate.check("fs.write", "write file")).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    expect(ask).not.toHaveBeenCalled();
  });

  it("rejects unknown names at the scope boundary", () => {
    const gate = new PermissionGate();
    expect(() => gate.scope(["fs.unknown"] as unknown as Permission[])).toThrow(/permission denied/);
  });
});
