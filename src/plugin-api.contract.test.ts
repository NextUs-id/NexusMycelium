import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  definePlugin,
  discoverPlugins,
  EventBus,
  loadPlugin,
  PermissionGate,
  type PermissionPolicy,
  Registry,
} from "../kernel/src/index.js";
import type { ModelProvider } from "../kernel/src/model.js";
import type { ToolRegistry } from "../kernel/src/tools.js";
import modelOpenAI from "../plugins/model-openai/src/index.js";
import toolsBasic, { createBasicTools } from "../plugins/tools-basic/src/index.js";
import toolsCore from "../plugins/tools-core/src/index.js";
import { createRuntime } from "./runtime.js";

const silent = { info() {}, warn() {}, error() {} };

function modelResponse(text = "ok"): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });
}

async function writeDummyKey(home: string): Promise<string> {
  const path = join(home, ".config", "nexus", "user", "secrets", "provider.key");
  await mkdir(join(home, ".config", "nexus", "user", "secrets"), { recursive: true });
  await writeFile(path, "dummy-key\n", "utf8");
  await chmod(path, 0o600);
  return path;
}

describe("v1 plugin API contracts", () => {
  it("rejects service registration not declared by provides", async () => {
    const registry = new Registry(silent);
    registry.register(
      definePlugin({
        manifest: {
          name: "provider",
          version: "0.1.0",
          apiVersion: 1,
          provides: ["service:allowed"],
        },
        setup({ services }) {
          services.register("service:allowed", 1);
          services.register("service:hidden", 2);
        },
      }),
    );
    await expect(registry.load("provider")).rejects.toThrow(/provide|declared|service/i);
    expect(registry.services.has("service:allowed")).toBe(false);
    await registry.close();
  });

  it("delivers typed event payloads and waits for async handlers", async () => {
    type Events = {
      "plugin:loaded": { name: string };
      "plugin:unloaded": { name: string };
    };
    const events = new EventBus<Events>();
    const received: Events["plugin:loaded"][] = [];
    const off = events.on("plugin:loaded", async (payload) => {
      await Promise.resolve();
      received.push(payload);
    });
    await events.emit("plugin:loaded", { name: "typed-plugin" });
    off();
    await events.emit("plugin:loaded", { name: "ignored-plugin" });
    expect(received).toEqual([{ name: "typed-plugin" }]);
  });

  it("fails closed for an invalid permission policy", async () => {
    const ask = vi.fn(async () => true);
    let gate: PermissionGate | undefined;
    try {
      gate = new PermissionGate({ network: "invalid" as PermissionPolicy }, ask);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      return;
    }
    await expect(gate.check("network", "network access")).rejects.toThrow(/permission denied|invalid/i);
    expect(ask).not.toHaveBeenCalled();
  });

  it("requires fs.read and accepts only an approved user key path", async () => {
    const home = await mkdtemp(join(tmpdir(), "nexus-contract-home-"));
    const root = await mkdtemp(join(tmpdir(), "nexus-contract-model-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    const keyFile = await writeDummyKey(home);
    let calls = 0;
    let usedDummyKey = false;
    const fetcher: typeof fetch = async (_input, init) => {
      calls += 1;
      usedDummyKey = new Headers(init?.headers).get("authorization") === "Bearer dummy-key";
      return modelResponse();
    };
    vi.stubGlobal("fetch", fetcher);
    const allowed = new Registry(
      silent,
      () => ({ provider: "openai", model: "test-model", apiKeyFile: keyFile }),
      new PermissionGate({ network: "allow", "fs.read": "allow" }),
    );
    const denied = new Registry(
      silent,
      () => ({ provider: "openai", model: "test-model", apiKeyFile: keyFile }),
      new PermissionGate({ network: "allow", "fs.read": "deny" }),
    );
    const outside = new Registry(
      silent,
      () => ({ provider: "openai", model: "test-model", apiKeyFile: join(root, "outside.key") }),
      new PermissionGate({ network: "allow", "fs.read": "allow" }),
    );
    try {
      expect(modelOpenAI.manifest.permissions).toEqual(expect.arrayContaining(["fs.read", "network"]));
      allowed.register(modelOpenAI);
      await allowed.load("model-openai");
      const model = allowed.services.get<ModelProvider>("model:openai");
      await expect(model.complete([{ role: "user", content: "hello" }], [])).resolves.toEqual({
        type: "final",
        text: "ok",
      });
      expect(calls).toBe(1);
      expect(usedDummyKey).toBe(true);

      denied.register(modelOpenAI);
      await expect(denied.load("model-openai")).rejects.toThrow(/fs\.read|permission denied/i);
      expect(calls).toBe(1);

      outside.register(modelOpenAI);
      await expect(outside.load("model-openai")).rejects.toThrow(/user\/secrets|user\/providers/i);
      expect(calls).toBe(1);
    } finally {
      await allowed.close();
      await denied.close();
      await outside.close();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects omitted runtime and plugin roots instead of using cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-contract-root-"));
    await mkdir(join(root, "config"), { recursive: true });
    await mkdir(join(root, "user"), { recursive: true });
    await writeFile(
      join(root, "config", "default.yaml"),
      "model:\n  provider: mock\n  model: mock\n",
      "utf8",
    );
    await writeFile(join(root, "user", "config.yaml"), "permissions:\n  network: deny\n", "utf8");
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    const expectRuntimeRootRejected = async (options?: { root?: string }): Promise<void> => {
      let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
      let error: unknown;
      try {
        runtime = await createRuntime(options);
      } catch (caught) {
        error = caught;
      }
      await runtime?.close();
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toMatch(/root|cwd/i);
    };
    try {
      await expectRuntimeRootRejected();
      await expectRuntimeRootRejected({ root: undefined });
      const registry = new Registry(
        silent,
        () => ({}),
        new PermissionGate({ "fs.read": "allow", "fs.write": "allow", shell: "deny" }),
      );
      registry.register(toolsBasic);
      try {
        await expect(registry.load("tools-basic")).rejects.toThrow(/root|configuration/i);
      } finally {
        await registry.close();
      }
    } finally {
      cwd.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("canonicalizes a symlinked tools root before confinement", async () => {
    const parent = await mkdtemp(join(tmpdir(), "nexus-contract-tools-"));
    const root = join(parent, "root");
    const alias = join(parent, "root-alias");
    await mkdir(root);
    await symlink(root, alias, "dir");
    await writeFile(join(parent, "outside.txt"), "outside", "utf8");
    const tools = createBasicTools({
      root: alias,
      permissions: new PermissionGate({ "fs.read": "allow", "fs.write": "allow", shell: "deny" }),
    });
    try {
      await tools.get("write_text").execute({ path: "nested/value.txt", content: "inside" });
      expect(await readFile(join(root, "nested/value.txt"), "utf8")).toBe("inside");
      await expect(tools.get("read_text").execute({ path: "../outside.txt" })).rejects.toThrow(/escapes/);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("discovers official package entries deterministically", async () => {
    const directory = new URL("../plugins/", import.meta.url);
    const first = await discoverPlugins(directory);
    const second = await discoverPlugins(directory);
    const names = first.map((plugin) => plugin.manifest.name);
    expect(names).toEqual([...names].sort((left, right) => left.localeCompare(right)));
    expect(names).toEqual(second.map((plugin) => plugin.manifest.name));
    expect(names).toEqual(expect.arrayContaining(["loop-react", "model-openai", "tools-basic"]));
    expect(first.every((plugin) => plugin.manifest.apiVersion === 1)).toBe(true);
    await expect(
      loadPlugin(new URL("../plugins/model-openai/package.json", import.meta.url)),
    ).rejects.toThrow();
    await expect(loadPlugin(new URL("../kernel/src/registry.ts", import.meta.url))).rejects.toThrow(
      /untrusted/i,
    );
  });

  it("cleans setup failures and reports disposer failures", async () => {
    const registry = new Registry(silent);
    registry.register(
      definePlugin({
        manifest: { name: "broken", version: "0.1.0", apiVersion: 1, provides: ["broken:service"] },
        setup({ services }) {
          services.register("broken:service", true);
          throw new Error("setup failed");
        },
      }),
    );
    await expect(registry.load("broken")).rejects.toThrow("setup failed");
    expect(registry.services.has("broken:service")).toBe(false);

    const dispose = vi.fn(() => {
      throw new Error("disposer failed");
    });
    registry.register(
      definePlugin({
        manifest: { name: "disposable", version: "0.1.0", apiVersion: 1 },
        setup: () => dispose,
      }),
    );
    await registry.load("disposable");
    await expect(registry.close()).rejects.toThrow("disposer failed");
    expect(registry.isLoaded("disposable")).toBe(false);
  });

  it("rejects tools-basic and tools-core co-activation on the shared tool:core capability", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-contract-tooldup-"));
    const claimants = (await discoverPlugins(new URL("../plugins/", import.meta.url)))
      .filter((plugin) => plugin.manifest.provides.includes("tool:core"))
      .map((plugin) => plugin.manifest.name)
      .sort();
    expect(claimants).toEqual(["tools-basic", "tools-core"]);

    const activate = async (order: readonly [string, string]): Promise<Registry> => {
      const registry = new Registry(
        silent,
        (name) => (name === "tools-basic" || name === "tools-core" ? { tools: { root } } : {}),
        new PermissionGate({ "fs.read": "allow", "fs.write": "allow", shell: "deny" }),
      );
      registry.register(toolsBasic);
      registry.register(toolsCore);
      await registry.load(order[0]);
      await expect(registry.load(order[1])).rejects.toThrow(/service already registered: tool:core/);
      return registry;
    };

    for (const order of [
      ["tools-basic", "tools-core"],
      ["tools-core", "tools-basic"],
    ] as const) {
      const registry = await activate(order);
      try {
        expect(registry.loadedNames()).toEqual([order[0]]);
        expect(registry.isLoaded(order[1])).toBe(false);
        expect(registry.services.owner("tool:core")).toBe(order[0]);
        expect(registry.services.get<ToolRegistry>("tool:core").list().length).toBeGreaterThan(0);
      } finally {
        await registry.close();
      }
      expect(registry.services.has("tool:core")).toBe(false);
    }
  });
});
