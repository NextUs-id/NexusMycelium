import { describe, expect, it } from "vitest";
import type { ModelMessage } from "../../../kernel/src/model.js";
import {
  type CompactionPolicy,
  type CompactionState,
  compactMessages,
  DEFAULT_COMPACTION,
  transcriptChars,
} from "./context.js";

const SYSTEM: ModelMessage = { role: "system", content: "system prompt" };
const TASK: ModelMessage = { role: "user", content: "the task" };

function turn(index: number, size = 4_000): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: `call-${index}`, name: `tool-${index}`, arguments: {} }],
    },
    { role: "tool", content: `{"ok":true,"output":"${"x".repeat(size)}"}`, toolCallId: `call-${index}` },
  ];
}

function transcript(turns: number, size = 4_000): ModelMessage[] {
  const messages: ModelMessage[] = [SYSTEM, TASK];
  for (let index = 0; index < turns; index += 1) messages.push(...turn(index, size));
  return messages;
}

const policy: CompactionPolicy = { maxChars: 12_000, keepMessages: 4 };

describe("compactMessages", () => {
  it("leaves a transcript under the cap exactly as it was", () => {
    const messages = transcript(2);
    expect(compactMessages(messages, { maxChars: 100_000, keepMessages: 4 })).toBeUndefined();
    expect(messages).toEqual(transcript(2));
  });

  it("keeps the head and the recent tail, and replaces the middle with one bounded summary", () => {
    const result = compactMessages(transcript(6), policy);
    if (result === undefined) throw new Error("expected a compaction");
    expect(result.messages[0]).toEqual(SYSTEM);
    expect(result.messages[1]).toEqual(TASK);
    expect(result.messages[2]?.role).toBe("system");
    expect(result.messages[2]?.content).toMatch(/^compacted transcript: /);
    expect(result.messages[2]?.content.length).toBeLessThanOrEqual(400);
    expect(result.messages).toHaveLength(7);
    expect(result.removed).toBe(8);
    expect(result.savedChars).toBeGreaterThan(0);
    expect(transcriptChars(result.messages)).toBeLessThan(transcriptChars(transcript(6)));
  });

  it("never keeps a tool result whose tool call it dropped", () => {
    const result = compactMessages(transcript(6), { maxChars: 12_000, keepMessages: 3 });
    if (result === undefined) throw new Error("expected a compaction");
    const calls = new Set(
      result.messages.flatMap((message) => (message.toolCalls ?? []).map((call) => call.id)),
    );
    for (const message of result.messages) {
      if (message.role !== "tool") continue;
      expect(calls.has(message.toolCallId ?? "")).toBe(true);
    }
    // The cut never lands between a tool call and its result: the first kept tail message is paired.
    const tailStart = result.messages.findIndex((message, index) => index > 2);
    if (result.messages[tailStart]?.role === "tool") {
      expect(result.messages[tailStart - 1]?.toolCalls?.length).toBeGreaterThan(0);
    }
  });

  it("never drops a tool call whose result it keeps", () => {
    const messages = transcript(5);
    const result = compactMessages(messages, { maxChars: 9_000, keepMessages: 1 });
    if (result === undefined) throw new Error("expected a compaction");
    for (const message of result.messages) {
      for (const call of message.toolCalls ?? []) {
        const answered = result.messages.some(
          (candidate) => candidate.role === "tool" && candidate.toolCallId === call.id,
        );
        expect(answered).toBe(true);
      }
    }
  });

  it("refuses to cut a transcript that has no safe boundary", () => {
    // One unbreakable run of pairs and no room to keep the recent tail without cutting inside it.
    const messages: ModelMessage[] = [SYSTEM, TASK, ...turn(0, 20_000), ...turn(1, 20_000)];
    expect(compactMessages(messages, { maxChars: 100, keepMessages: 4 })).toBeUndefined();
  });

  it("refuses a cut whose only boundary would orphan a tool call", () => {
    // The tail could start at the final message, but that would drop a call whose answer never arrives.
    const messages: ModelMessage[] = [
      SYSTEM,
      TASK,
      {
        role: "assistant",
        content: "x".repeat(400),
        toolCalls: [{ id: "c", name: "tool-c", arguments: {} }],
      },
      { role: "assistant", content: "y".repeat(400) },
    ];
    expect(compactMessages(messages, { maxChars: 1, keepMessages: 1 })).toBeUndefined();
  });

  it("refuses to compact when the summary would not shrink the transcript", () => {
    // A span shorter than the summary it would be replaced by: paying the summary loses more than it saves.
    const messages: ModelMessage[] = [SYSTEM, TASK, { role: "assistant", content: "ab" }];
    expect(compactMessages(messages, { maxChars: 1, keepMessages: 0 })).toBeUndefined();
  });

  it("folds an earlier summary into the new one instead of stacking summaries", () => {
    const first = compactMessages(transcript(6), policy);
    if (first === undefined) throw new Error("expected a first compaction");
    const longer: ModelMessage[] = [...first.messages, ...turn(90), ...turn(91), ...turn(92), ...turn(93)];
    const previous: CompactionState = first.state;
    const second = compactMessages(longer, policy, previous);
    if (second === undefined) throw new Error("expected a second compaction");
    const summaries = second.messages.filter((message) =>
      message.content.startsWith("compacted transcript: "),
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.content).toBe(second.state.text);
    expect(second.state.droppedMessages).toBeGreaterThan(previous.droppedMessages);
    expect(second.state.tools).toContain("tool-0");
    expect(second.state.tools).toContain("tool-91");
    // The recent tail is kept verbatim, so its tool never becomes part of the summary.
    expect(second.state.tools).not.toContain("tool-93");
  });

  it("names a bounded number of tools and counts the failures it saw", () => {
    const messages: ModelMessage[] = [SYSTEM, TASK];
    for (let index = 0; index < 20; index += 1) {
      messages.push(
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: `c-${index}`, name: `tool-${index}`, arguments: {} }],
        },
        { role: "tool", content: '{"ok":false,"error":"nope"}', toolCallId: `c-${index}` },
      );
    }
    const result = compactMessages(messages, { maxChars: 200, keepMessages: 4 });
    if (result === undefined) throw new Error("expected a compaction");
    expect(result.state.toolErrors).toBeGreaterThan(0);
    expect(result.state.tools.length).toBeGreaterThan(8);
    const summary = result.messages[2]?.content ?? "";
    expect(summary.length).toBeLessThanOrEqual(400);
    expect(summary).toContain("(+");
    expect(summary.split("tool-").length - 1).toBeLessThanOrEqual(9);
  });

  it("carries a default policy that leaves a small transcript alone", () => {
    expect(DEFAULT_COMPACTION.maxChars).toBeGreaterThan(0);
    expect(DEFAULT_COMPACTION.keepMessages).toBeGreaterThan(0);
    expect(compactMessages(transcript(2, 10), DEFAULT_COMPACTION)).toBeUndefined();
  });
});
