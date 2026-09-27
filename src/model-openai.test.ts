import { describe, expect, it } from "vitest";
import { PermissionGate } from "../kernel/src/permissions.js";
import { createOpenAICompatibleModel } from "../plugins/model-openai/src/index.js";

describe("OpenAI-compatible model", () => {
  it("validates tool responses and uses an explicit dummy API key", async () => {
    let authorization: string | null = null;
    const fetcher: typeof fetch = async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization");
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
        { status: 200, headers: { "content-type": "application/json" } },
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
    const result = await model.complete(
      [{ role: "user", content: "read" }],
      [{ name: "read_text", description: "read", parameters: { type: "object" } }],
    );
    expect(result).toEqual({
      type: "tool_calls",
      calls: [{ id: "call-1", name: "read_text", arguments: { path: "a.txt" } }],
    });
    expect(authorization).toBe("Bearer test-key");
  });

  it("rejects an invalid response and enforces the network gate", async () => {
    const invalidFetcher: typeof fetch = async () =>
      new Response(JSON.stringify({ choices: [] }), { status: 200 });
    const model = createOpenAICompatibleModel({
      baseUrl: "https://example.test/v1",
      model: "test-model",
      timeoutMs: 1000,
      permissions: new PermissionGate({ network: "allow" }),
      fetcher: invalidFetcher,
    });
    await expect(model.complete([{ role: "user", content: "hello" }], [])).rejects.toThrow(
      /response is invalid/,
    );
    let called = false;
    const deniedModel = createOpenAICompatibleModel({
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
    await expect(deniedModel.complete([{ role: "user", content: "hello" }], [])).rejects.toThrow(
      /permission denied/,
    );
    expect(called).toBe(false);
  });
});
