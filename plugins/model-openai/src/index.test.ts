import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PermissionGate, Registry } from "../../../kernel/src/index.js";
import type { ModelProvider } from "../../../kernel/src/model.js";
import modelOpenAI, { createMockModel, createOpenAICompatibleModel, isModelAllowed } from "./index.js";

const silent = { info() {}, warn() {}, error() {} };

const modelOptions = {
  baseUrl: "https://example.test/v1",
  model: "oc/space-bunny-free",
  timeoutMs: 1000,
  permissions: new PermissionGate({ network: "allow" }),
};

async function fakeHome(prefix: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  return home;
}

async function writeDummySecret(path: string, secret = "dummy-key"): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${secret}\n`, "utf8");
  await chmod(path, 0o600);
}

function okFetcher(): { fetcher: typeof fetch; authorization: () => string | null } {
  let header: string | null = null;
  return {
    fetcher: async (_input, init) => {
      header = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    },
    authorization: () => header,
  };
}

/** A provider whose single stubbed request always answers with `body`. */
function bodyModel(body: unknown) {
  return createOpenAICompatibleModel({
    ...modelOptions,
    apiKey: "test-key",
    fetcher: async () => new Response(JSON.stringify(body), { status: 200 }),
  });
}

const finalBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "chatcmpl-test",
  object: "chat.completion",
  created: 1758900000,
  model: "oc/space-bunny-free",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  ...extra,
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("model-openai", () => {
  it("calls an OpenAI-compatible endpoint and validates tool arguments", async () => {
    let authorization: string | null = null;
    let requestBody: unknown;
    const fetcher: typeof fetch = async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization");
      requestBody = JSON.parse(String(init?.body)) as unknown;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  { id: "call-1", function: { name: "read_text", arguments: '{"path":"a.txt"}' } },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );
    };
    const model = createOpenAICompatibleModel({
      baseUrl: "https://example.test/v1",
      model: "test-model",
      timeoutMs: 1000,
      permissions: new PermissionGate({ network: "allow" }),
      apiKey: "test-key",
      fetcher,
    });
    const result = await model.complete([{ role: "user", content: "read" }], []);
    expect(result).toEqual({
      type: "tool_calls",
      calls: [{ id: "call-1", name: "read_text", arguments: { path: "a.txt" } }],
    });
    expect(authorization).toBe("Bearer test-key");
    expect(requestBody).toMatchObject({ model: "test-model", stream: false });
  });

  it("waits for a non-cancellable fetcher before reporting timeout", async () => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    let requestSignal: AbortSignal | null | undefined;
    let fetchStarted = false;
    const fetcher: typeof fetch = (_input, init) => {
      fetchStarted = true;
      requestSignal = init?.signal;
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    };
    const model = createOpenAICompatibleModel({
      baseUrl: "https://example.test/v1",
      model: "test-model",
      timeoutMs: 20,
      permissions: new PermissionGate({ network: "allow" }),
      apiKey: "test-key",
      fetcher,
    });
    const completion = model.complete([{ role: "user", content: "wait" }], []);
    let settled = false;
    void completion.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchStarted).toBe(true);
    await vi.advanceTimersByTimeAsync(20);
    expect(requestSignal?.aborted).toBe(true);
    expect(settled).toBe(false);

    finish(new Response(JSON.stringify({ choices: [{ message: { content: "late" } }] }), { status: 200 }));
    await expect(completion).rejects.toThrow(/request timed out/);
  });

  it("rejects malformed responses and respects the network permission gate", async () => {
    const invalid = createOpenAICompatibleModel({
      baseUrl: "https://example.test/v1",
      model: "test-model",
      timeoutMs: 1000,
      permissions: new PermissionGate({ network: "allow" }),
      apiKey: "test-key",
      fetcher: async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    });
    await expect(invalid.complete([{ role: "user", content: "hello" }], [])).rejects.toThrow(
      /response is invalid/,
    );
    let called = false;
    const denied = createOpenAICompatibleModel({
      baseUrl: "https://example.test/v1",
      model: "test-model",
      timeoutMs: 1000,
      permissions: new PermissionGate(),
      apiKey: "test-key",
      fetcher: async () => {
        called = true;
        return new Response("{}", { status: 200 });
      },
    });
    await expect(denied.complete([{ role: "user", content: "hello" }], [])).rejects.toThrow(
      /permission denied/,
    );
    expect(called).toBe(false);
  });

  it("filters models by the configured prefix and rejects non-matching models", async () => {
    const options = {
      baseUrl: "https://example.test/v1",
      timeoutMs: 1000,
      permissions: new PermissionGate({ network: "allow" }),
    };
    expect(isModelAllowed("oc/space-bunny-free", ["oc/"])).toBe(true);
    expect(isModelAllowed("gpt-4o-mini", ["oc/"])).toBe(false);
    expect(() =>
      createOpenAICompatibleModel({ ...options, model: "gpt-4o-mini", allowedModelPrefixes: ["oc/"] }),
    ).toThrow(/prefix allowlist/);
    let requestBody: unknown;
    const model = createOpenAICompatibleModel({
      ...options,
      model: "oc/space-bunny-free",
      allowedModelPrefixes: ["oc/"],
      apiKey: "test-key",
      fetcher: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as unknown;
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
      },
    });
    await expect(model.complete([{ role: "user", content: "hello" }], [])).resolves.toEqual({
      type: "final",
      text: "ok",
    });
    expect(requestBody).toMatchObject({ model: "oc/space-bunny-free" });
  });

  it("reads a 0600 apiKeyFile and redacts the secret from errors", async () => {
    const home = await fakeHome("nexus-api-key-");
    const secretFile = join(home, ".config", "nexus", "user", "secrets", "provider.key");
    const secret = "test-file-secret";
    try {
      await mkdir(join(home, ".config", "nexus", "user", "secrets"), { recursive: true });
      await writeFile(secretFile, `${secret}\n`, "utf8");
      await chmod(secretFile, 0o600);
      let authorization: string | null = null;
      const model = createOpenAICompatibleModel({
        baseUrl: "https://example.test/v1",
        model: "oc/space-bunny-free",
        timeoutMs: 1000,
        permissions: new PermissionGate({ network: "allow" }),
        apiKeyFile: secretFile,
        fetcher: async (_input, init) => {
          authorization = new Headers(init?.headers).get("authorization");
          return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
        },
      });
      await expect(model.complete([{ role: "user", content: "hello" }], [])).resolves.toEqual({
        type: "final",
        text: "ok",
      });
      expect(authorization).toBe(`Bearer ${secret}`);
      expect(() =>
        createOpenAICompatibleModel({
          baseUrl: "https://example.test/v1",
          model: "oc/space-bunny-free",
          timeoutMs: 1000,
          permissions: new PermissionGate({ network: "allow" }),
          apiKeyFile: join(home, "outside.key"),
        }),
      ).toThrow(/user\/secrets/);
      const leaking = createOpenAICompatibleModel({
        baseUrl: "https://example.test/v1",
        model: "oc/space-bunny-free",
        timeoutMs: 1000,
        permissions: new PermissionGate({ network: "allow" }),
        apiKeyFile: secretFile,
        fetcher: async () => {
          throw new Error(`request included ${secret}`);
        },
      });
      let error: unknown;
      try {
        await leaking.complete([{ role: "user", content: "hello" }], []);
      } catch (value) {
        error = value;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("[REDACTED]");
      expect((error as Error).message).not.toContain(secret);
      await chmod(secretFile, 0o644);
      const insecure = createOpenAICompatibleModel({
        baseUrl: "https://example.test/v1",
        model: "oc/space-bunny-free",
        timeoutMs: 1000,
        permissions: new PermissionGate({ network: "allow" }),
        apiKeyFile: secretFile,
      });
      await expect(insecure.complete([{ role: "user", content: "hello" }], [])).rejects.toThrow(
        /permissions 600/,
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("uses the configured OpenAI provider and model without mock fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-model-openai-"));
    const keyFile = join(root, "user", "secrets", "provider.key");
    await mkdir(join(root, "user", "secrets"), { recursive: true });
    await writeFile(keyFile, "dummy-provider-key\\n", "utf8");
    await chmod(keyFile, 0o600);
    let requestBody: unknown;
    vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as unknown;
      return new Response(JSON.stringify({ choices: [{ message: { content: "done" } }] }), { status: 200 });
    });
    const registry = new Registry(
      silent,
      () => ({
        provider: "openai",
        model: "configured-model",
        apiKeyFile: keyFile,
        runtimeUserRoot: join(root, "user"),
      }),
      new PermissionGate({ network: "allow", "fs.read": "allow" }),
    );
    try {
      registry.register(modelOpenAI);
      await registry.load("model-openai");
      const model = registry.services.get<ModelProvider>("model:openai");
      await expect(model.complete([{ role: "user", content: "hello" }], [])).resolves.toEqual({
        type: "final",
        text: "done",
      });
      expect(requestBody).toMatchObject({ model: "configured-model" });
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true });
    }

    const fallback = new Registry(
      silent,
      () => ({ provider: "mock", model: "mock" }),
      new PermissionGate({ network: "allow", "fs.read": "allow" }),
    );
    fallback.register(modelOpenAI);
    await expect(fallback.load("model-openai")).rejects.toThrow(/requires provider: openai/);
    await fallback.close();

    const invalid = new Registry(
      silent,
      () => ({ provider: "openai", baseUrl: "file:///tmp/openai" }),
      new PermissionGate({ network: "allow", "fs.read": "allow" }),
    );
    invalid.register(modelOpenAI);
    await expect(invalid.load("model-openai")).rejects.toThrow(/HTTP or HTTPS/);
    expect(invalid.services.has("model:mock")).toBe(false);
    await invalid.close();
  });

  it("validates and reads only the selected dummy API key environment variable", async () => {
    const options = {
      baseUrl: "https://example.test/v1",
      model: "test-model",
      timeoutMs: 1000,
      permissions: new PermissionGate({ network: "allow" }),
    };
    expect(() => createOpenAICompatibleModel({ ...options, apiKeyEnv: "bad-name" })).toThrow(
      /environment name is invalid/,
    );
    vi.stubEnv("NEXUS_TEST_OPENAI_KEY", "custom-key");
    let authorization: string | null = null;
    const model = createOpenAICompatibleModel({
      ...options,
      apiKeyEnv: "NEXUS_TEST_OPENAI_KEY",
      fetcher: async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization");
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
        });
      },
    });
    await model.complete([{ role: "user", content: "hello" }], []);
    expect(authorization).toBe("Bearer custom-key");
  });

  it("provides a deterministic offline mock sequence", async () => {
    const model = createMockModel();
    const first = await model.complete(
      [{ role: "user", content: 'write file "note.txt" with content "hello"' }],
      [],
    );
    expect(first).toEqual({
      type: "tool_calls",
      calls: [{ id: "mock-1", name: "write_text", arguments: { path: "note.txt", content: "hello" } }],
    });
    const second = await model.complete(
      [
        { role: "user", content: 'write file "note.txt" with content "hello"' },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "mock-1", name: "write_text", arguments: { path: "note.txt", content: "hello" } },
          ],
        },
        { role: "tool", content: '{"ok":true}', toolCallId: "mock-1" },
      ],
      [],
    );
    expect(second).toEqual({ type: "final", text: "Completed deterministic mock task for note.txt." });
  });

  it("accepts the trusted home user scope when no runtime scope is granted", async () => {
    const home = await fakeHome("nexus-home-scope-");
    const keyFile = join(home, ".config", "nexus", "user", "secrets", "9router.key");
    try {
      await writeDummySecret(keyFile);
      const { fetcher, authorization } = okFetcher();
      const model = createOpenAICompatibleModel({ ...modelOptions, apiKeyFile: keyFile, fetcher });
      await expect(model.complete([{ role: "user", content: "hello" }], [])).resolves.toEqual({
        type: "final",
        text: "ok",
      });
      expect(authorization()).toMatch(/^Bearer /);

      const registry = new Registry(
        silent,
        () => ({ provider: "openai", model: "oc/space-bunny-free", apiKeyFile: keyFile }),
        new PermissionGate({ network: "allow", "fs.read": "allow" }),
      );
      try {
        vi.stubGlobal("fetch", fetcher);
        registry.register(modelOpenAI);
        await registry.load("model-openai");
        const loaded = registry.services.get<ModelProvider>("model:openai");
        await expect(loaded.complete([{ role: "user", content: "hello" }], [])).resolves.toEqual({
          type: "final",
          text: "ok",
        });
        expect(authorization()).toMatch(/^Bearer /);
      } finally {
        await registry.close();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects a fake absolute user path that only looks like the user scope", async () => {
    const home = await fakeHome("nexus-fake-scope-");
    const fake = await mkdtemp(join(tmpdir(), "nexus-fake-user-"));
    try {
      const fakeKey = join(fake, "user", "secrets", "9router.key");
      await writeDummySecret(fakeKey);
      expect(fakeKey).toMatch(/\/user\/secrets\//);
      expect(() => createOpenAICompatibleModel({ ...modelOptions, apiKeyFile: fakeKey })).toThrow(
        /user\/secrets/,
      );
      const registry = new Registry(
        silent,
        () => ({ provider: "openai", model: "oc/space-bunny-free", apiKeyFile: fakeKey }),
        new PermissionGate({ network: "allow", "fs.read": "allow" }),
      );
      try {
        registry.register(modelOpenAI);
        await expect(registry.load("model-openai")).rejects.toThrow(/user\/secrets|user\/providers/);
        expect(registry.services.has("model:openai")).toBe(false);
      } finally {
        await registry.close();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(fake, { recursive: true, force: true });
    }
  });

  it("rejects traversal, relative, and directory apiKeyFile paths", async () => {
    const home = await fakeHome("nexus-traversal-");
    try {
      const scope = join(home, ".config", "nexus", "user", "secrets");
      for (const candidate of [
        `${scope}/../secrets/key`,
        `${home}/.config/nexus/user/../user/secrets/key`,
        `${scope}/../../escape.key`,
        "user/secrets/provider.key",
        scope,
      ]) {
        expect(() => createOpenAICompatibleModel({ ...modelOptions, apiKeyFile: candidate })).toThrow(
          /apiKeyFile/,
        );
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects a parent symlink escape and a symlinked key file", async () => {
    const home = await fakeHome("nexus-symlink-");
    const outside = await mkdtemp(join(tmpdir(), "nexus-symlink-outside-"));
    try {
      const user = join(home, ".config", "nexus", "user");
      const escaped = join(outside, "escaped.key");
      await writeDummySecret(join(user, "secrets", "real.key"));
      await writeDummySecret(escaped);
      await symlink(outside, join(user, "providers"), "dir");
      await symlink(escaped, join(user, "secrets", "linked.key"));
      const escapes: [string, RegExp][] = [
        [join(user, "providers", "escaped.key"), /approved user scope/],
        [join(user, "secrets", "linked.key"), /regular file|approved user scope/],
      ];
      for (const [candidate, message] of escapes) {
        const model = createOpenAICompatibleModel({
          ...modelOptions,
          apiKeyFile: candidate,
          fetcher: okFetcher().fetcher,
        });
        await expect(model.complete([{ role: "user", content: "hello" }], [])).rejects.toThrow(message);
      }
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("returns the reported token counters and cache reads on final and tool-call results", async () => {
    const model = bodyModel(
      finalBody({
        usage: {
          prompt_tokens: 1200,
          completion_tokens: 84,
          total_tokens: 1284,
          prompt_tokens_details: { cached_tokens: 1024, audio_tokens: 0 },
        },
      }),
    );
    await expect(model.complete([{ role: "user", content: "hello" }], [])).resolves.toEqual({
      type: "final",
      text: "ok",
      usage: {
        inputTokens: 1200,
        outputTokens: 84,
        totalTokens: 1284,
        source: "model-openai",
        cachedTokens: 1024,
      },
    });

    const tools = bodyModel({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: "call-1", function: { name: "read_text", arguments: '{"path":"a.txt"}' } }],
          },
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
    });
    const called = await tools.complete([{ role: "user", content: "read" }], []);
    expect(called).toEqual({
      type: "tool_calls",
      calls: [{ id: "call-1", name: "read_text", arguments: { path: "a.txt" } }],
      usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17, source: "model-openai" },
    });
    expect(called.usage).not.toHaveProperty("cachedTokens");
  });

  it("leaves usage undefined when the gateway omits, nulls, empties, or zeroes it", async () => {
    for (const usage of [
      undefined,
      null,
      {},
      { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        prompt_tokens_details: { cached_tokens: 0 },
      },
      { prompt_tokens: 7, completion_tokens: 0 },
      { prompt_tokens: 7, completion_tokens: 3 },
      { prompt_tokens: 7, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 0 } },
    ]) {
      const model = bodyModel(finalBody(usage === undefined ? {} : { usage }));
      const result = await model.complete([{ role: "user", content: "hello" }], []);
      expect(result.usage).toBeUndefined();
      expect(Object.hasOwn(result, "usage")).toBe(false);
    }
    // Reported zeros are data, not fabrication: the other counters still land.
    for (const usage of [
      { prompt_tokens: 0, completion_tokens: 12, total_tokens: 12 },
      { prompt_tokens: 7, completion_tokens: 0, total_tokens: 7 },
    ]) {
      const model = bodyModel(finalBody({ usage }));
      await expect(model.complete([{ role: "user", content: "hello" }], [])).resolves.toMatchObject({
        usage: { totalTokens: usage.total_tokens, source: "model-openai" },
      });
    }
  });

  it("rejects malformed usage counters instead of reporting zeros", async () => {
    for (const usage of [
      { prompt_tokens: "1200", completion_tokens: 84, total_tokens: 1284 },
      { prompt_tokens: 1200, completion_tokens: 84, total_tokens: 1284.5 },
      { prompt_tokens: -1, completion_tokens: 84, total_tokens: 1284 },
      { prompt_tokens: 1200, completion_tokens: 84, total_tokens: null },
      { prompt_tokens: 1200, completion_tokens: 84, total_tokens: 1284, prompt_tokens_details: 5 },
      {
        prompt_tokens: 1200,
        completion_tokens: 84,
        total_tokens: 1284,
        prompt_tokens_details: { cached_tokens: "1k" },
      },
      "1200 tokens",
    ]) {
      const model = bodyModel(finalBody({ usage }));
      await expect(model.complete([{ role: "user", content: "hello" }], [])).rejects.toThrow(
        /response is invalid/,
      );
    }
  });

  it("parses a 9Router-shaped body and ignores router-only fields", async () => {
    const model = bodyModel({
      id: "gen-1758900000-abc",
      object: "chat.completion",
      created: 1758900000,
      model: "openai/gpt-4o-mini",
      provider: "9router",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "routed answer", refusal: null },
          logprobs: null,
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 31,
        completion_tokens: 9,
        total_tokens: 40,
        prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
        cost: 0.0000123,
        cost_details: { upstream_inference_cost: null },
        is_byok: false,
      },
    });
    const result = await model.complete([{ role: "user", content: "route me" }], []);
    expect(result).toEqual({
      type: "final",
      text: "routed answer",
      usage: {
        inputTokens: 31,
        outputTokens: 9,
        totalTokens: 40,
        source: "model-openai",
        cachedTokens: 0,
      },
    });
    expect(result).not.toHaveProperty("cost");
  });
});
