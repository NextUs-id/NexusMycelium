import { describe, expect, it } from "vitest";
import { discoverPlugins, loadPlugin } from "./plugin.js";

function bytewise(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

describe("plugin discovery", () => {
  it("loads official plugins and rejects untrusted paths", async () => {
    const plugins = await discoverPlugins(new URL("../../plugins/", import.meta.url));
    expect(plugins.map((plugin) => plugin.manifest.name)).toEqual(
      expect.arrayContaining(["loop-react", "model-openai", "tools-basic"]),
    );
    const loop = await loadPlugin(new URL("../../plugins/loop-react/src/index.ts", import.meta.url));
    expect(loop.manifest.name).toBe("loop-react");
    await expect(loadPlugin(new URL("./registry.ts", import.meta.url))).rejects.toThrow(
      /untrusted plugin path/,
    );
    await expect(discoverPlugins(new URL("../../", import.meta.url))).rejects.toThrow(
      /official trusted path/,
    );
  });

  it("is bytewise deterministic and never loads user or agent-made paths", async () => {
    const names = (await discoverPlugins(new URL("../../plugins/", import.meta.url))).map(
      (plugin) => plugin.manifest.name,
    );
    expect(names).toEqual([...names].sort(bytewise));
    await expect(loadPlugin(new URL("../../agent-made/active/.gitkeep", import.meta.url))).rejects.toThrow(
      /untrusted plugin path/,
    );
    await expect(discoverPlugins(new URL("../../agent-made/", import.meta.url))).rejects.toThrow(
      /official trusted path/,
    );
  });

  it("keeps the official discovery set and rejects every path outside the trust root", async () => {
    expect(
      (await discoverPlugins(new URL("../../plugins/", import.meta.url))).map(
        (plugin) => plugin.manifest.name,
      ),
    ).toEqual(["example-hello", "loop-react", "model-mock", "model-openai", "tools-basic", "tools-core"]);
    await expect(loadPlugin(new URL("../../user/config.example.yaml", import.meta.url))).rejects.toThrow(
      /untrusted plugin path/,
    );
    await expect(
      loadPlugin(new URL("../../plugins/../user/config.example.yaml", import.meta.url)),
    ).rejects.toThrow(/untrusted plugin path/);
    await expect(loadPlugin("https://example.com/plugin.ts")).rejects.toThrow(/file: protocol/);
    await expect(loadPlugin(new URL("../../plugins/loop-react", import.meta.url))).rejects.toThrow(
      /not a file/,
    );
    await expect(discoverPlugins(new URL("../../user/", import.meta.url))).rejects.toThrow(
      /official trusted path/,
    );
    await expect(discoverPlugins(new URL("../../plugins/loop-react/", import.meta.url))).rejects.toThrow(
      /official trusted path/,
    );
  });
});
