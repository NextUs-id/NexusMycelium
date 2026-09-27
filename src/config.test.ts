import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pluginConfig, resolveConfig } from "../kernel/src/config.js";

async function temporaryRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "nexus-config-"));
}

describe("resolveConfig", () => {
  it("deep-merges user YAML over defaults and resolves the tool root", async () => {
    const root = await temporaryRoot();
    try {
      await writeFile(join(root, "default.yaml"), "model:\n  provider: mock\n", "utf8");
      await writeFile(join(root, "user.yaml"), "agent:\n  maxSteps: 3\n", "utf8");
      const config = await resolveConfig(root, { defaultsPath: "default.yaml", userPath: "user.yaml" });
      expect(config.model.provider).toBe("mock");
      expect(config.model.timeoutMs).toBe(5000);
      expect(config.agent.maxSteps).toBe(3);
      expect(config.tools.root).toBe(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads user-only model settings and resolves the secret path", async () => {
    const root = await temporaryRoot();
    try {
      await writeFile(join(root, "default.yaml"), "model:\n  provider: mock\n", "utf8");
      await writeFile(
        join(root, "user.yaml"),
        "model:\n  provider: openai\n  model: oc/space-bunny-free\n  apiKeyFile: user/secrets/provider.key\n  allowedModelPrefixes:\n    - oc/\n",
        "utf8",
      );
      const config = await resolveConfig(root, { defaultsPath: "default.yaml", userPath: "user.yaml" });
      expect(config.model).toMatchObject({
        provider: "openai",
        model: "oc/space-bunny-free",
        apiKeyFile: join(root, "user/secrets/provider.key"),
        allowedModelPrefixes: ["oc/"],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an apiKeyFile outside the user scope", async () => {
    const root = await temporaryRoot();
    try {
      await writeFile(join(root, "default.yaml"), "model:\n  provider: mock\n", "utf8");
      await writeFile(join(root, "user.yaml"), "model:\n  apiKeyFile: ../provider.key\n", "utf8");
      await expect(
        resolveConfig(root, { defaultsPath: "default.yaml", userPath: "user.yaml" }),
      ).rejects.toThrow(/apiKeyFile/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes the OpenAI default model without changing the mock default", async () => {
    const root = await temporaryRoot();
    try {
      await writeFile(join(root, "default.yaml"), "model:\n  provider: mock\n  model: mock\n", "utf8");
      await writeFile(join(root, "user.yaml"), "model:\n  provider: openai\n", "utf8");
      const config = await resolveConfig(root, { defaultsPath: "default.yaml", userPath: "user.yaml" });
      expect(config.model).toMatchObject({ provider: "openai", model: "gpt-4o-mini" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects prototype-pollution keys before merging", async () => {
    const root = await temporaryRoot();
    try {
      await writeFile(join(root, "default.yaml"), "model:\n  provider: mock\n", "utf8");
      await writeFile(join(root, "user.yaml"), "model:\n  __proto__: polluted\n", "utf8");
      await expect(
        resolveConfig(root, { defaultsPath: "default.yaml", userPath: "user.yaml" }),
      ).rejects.toThrow(/unsafe configuration key/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed roots and unknown values instead of using cwd", async () => {
    const root = await temporaryRoot();
    try {
      await writeFile(join(root, "default.yaml"), "model:\n  provider: mock\n", "utf8");
      await writeFile(join(root, "user.yaml"), "tools:\n  root: null\n", "utf8");
      await expect(
        resolveConfig(root, { defaultsPath: "default.yaml", userPath: "user.yaml" }),
      ).rejects.toThrow(/invalid configuration/);
      await writeFile(join(root, "user.yaml"), "model:\n  unknown: true\n", "utf8");
      await expect(
        resolveConfig(root, { defaultsPath: "default.yaml", userPath: "user.yaml" }),
      ).rejects.toThrow(/invalid configuration/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("validates plugin-specific values and rejects unknown plugin configuration", async () => {
    const root = await temporaryRoot();
    try {
      await writeFile(join(root, "default.yaml"), "model:\n  provider: mock\n", "utf8");
      await writeFile(join(root, "user.yaml"), "plugins:\n  tools-basic:\n    root: null\n", "utf8");
      await expect(
        resolveConfig(root, { defaultsPath: "default.yaml", userPath: "user.yaml" }),
      ).rejects.toThrow(/plugins\.tools-basic/);
      await writeFile(join(root, "user.yaml"), "plugins:\n  loop-react:\n    maxSteps: many\n", "utf8");
      await expect(
        resolveConfig(root, { defaultsPath: "default.yaml", userPath: "user.yaml" }),
      ).rejects.toThrow(/plugins\.loop-react/);
      await writeFile(join(root, "user.yaml"), "plugins:\n  model-openai:\n    mode: mock\n", "utf8");
      await expect(
        resolveConfig(root, { defaultsPath: "default.yaml", userPath: "user.yaml" }),
      ).rejects.toThrow(/plugins\.model-openai/);
      await writeFile(join(root, "user.yaml"), "plugins:\n  untrusted:\n    root: .\n", "utf8");
      await expect(
        resolveConfig(root, { defaultsPath: "default.yaml", userPath: "user.yaml" }),
      ).rejects.toThrow(/unknown plugin configuration/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed values in the official defaults too", async () => {
    const root = await temporaryRoot();
    try {
      await writeFile(join(root, "default.yaml"), "tools:\n  root: null\n", "utf8");
      await writeFile(join(root, "user.yaml"), "tools:\n  root: .\n", "utf8");
      await expect(
        resolveConfig(root, { defaultsPath: "default.yaml", userPath: "user.yaml" }),
      ).rejects.toThrow(/invalid configuration/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves plugin tool roots against the runtime root", async () => {
    const root = await temporaryRoot();
    try {
      await writeFile(join(root, "default.yaml"), "tools:\n  root: nested\n", "utf8");
      await writeFile(join(root, "user.yaml"), "plugins:\n  tools-basic:\n    root: .\n", "utf8");
      const config = await resolveConfig(root, { defaultsPath: "default.yaml", userPath: "user.yaml" });
      expect(pluginConfig(config, "tools-basic").root).toBe(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
