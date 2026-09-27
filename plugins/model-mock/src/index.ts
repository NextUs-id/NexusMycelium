import { definePlugin } from "../../../kernel/src/index.js";
import type { ModelMessage, ModelProvider, ModelResult, ModelToolCall } from "../../../kernel/src/model.js";

interface WriteInstruction {
  path: string;
  content: string;
}

function taskText(messages: readonly ModelMessage[]): string {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n");
}

function parseInstruction(text: string): WriteInstruction | undefined {
  const match = text.match(
    /(?:write|create)\s+(?:file\s+)?["']?([^\s"']+)["']?\s+(?:with(?:\s+content)?|content)\s+(?:"([^"]*)"|'([^']*)'|(.+))/i,
  );
  if (!match) return undefined;
  return {
    path: match[1] ?? "",
    content: match[2] ?? match[3] ?? (match[4] ?? "").trim(),
  };
}

function readPath(text: string): string | undefined {
  return text.match(/read(?:\s+back)?\s+["']?([^\s"']+)/i)?.[1];
}

function toolCalls(messages: readonly ModelMessage[]): readonly ModelToolCall[] {
  return messages.flatMap((message) => message.toolCalls ?? []);
}

function call(name: string, args: Record<string, unknown>, index: number): ModelResult {
  return {
    type: "tool_calls",
    calls: [{ id: `mock-${index + 1}`, name, arguments: args }],
  };
}

export function createMockModel(): ModelProvider {
  return {
    async complete(messages) {
      const text = taskText(messages);
      const instruction = parseInstruction(text);
      const calls = toolCalls(messages);
      const names = new Set(calls.map((item) => item.name));
      if (instruction && !names.has("write_text")) {
        return call("write_text", { path: instruction.path, content: instruction.content }, calls.length);
      }
      const path = readPath(text);
      if (path && !names.has("read_text")) {
        return call("read_text", { path }, calls.length);
      }
      const lastToolMessage = [...messages].reverse().find((message) => message.role === "tool");
      if (lastToolMessage?.content.includes('"ok":false')) {
        return { type: "final", text: `Tool failure: ${lastToolMessage.content}` };
      }
      return {
        type: "final",
        text: instruction
          ? `Completed deterministic mock task for ${instruction.path}.`
          : "Completed deterministic mock task.",
      };
    },
  };
}

export default definePlugin({
  manifest: {
    name: "model-mock",
    version: "0.1.0",
    apiVersion: 1,
    description: "Deterministic offline model provider for the MVP.",
    provides: ["model:mock"],
  },
  setup({ services }) {
    services.register("model:mock", createMockModel(), "model-mock");
  },
});
