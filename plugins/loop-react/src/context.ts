import type { ModelMessage } from "../../../kernel/src/model.js";

/**
 * Every summary starts with this text. A previous summary is only recognised when the message at the
 * cut point matches the exact text handed back to us, so a transcript that merely looks like one
 * cannot be folded into a summary of its own making.
 */
const MARKER = "compacted transcript:";
const MAX_SUMMARY_CHARS = 400;
const MAX_NAMED_TOOLS = 8;

export interface CompactionPolicy {
  /** Compaction stays off the table while the transcript is at or under this many characters. */
  maxChars: number;
  /** How many of the most recent messages are always kept verbatim. */
  keepMessages: number;
}

/** On by default: a bounded run should not grow its prompt forever. */
export const DEFAULT_COMPACTION: CompactionPolicy = Object.freeze({ maxChars: 48_000, keepMessages: 6 });

export interface CompactionState {
  /** Exact text of the summary this transcript already carries, or `""` when it carries none. */
  text: string;
  droppedMessages: number;
  tools: readonly string[];
  toolErrors: number;
}

export const EMPTY_COMPACTION_STATE: CompactionState = Object.freeze({
  text: "",
  droppedMessages: 0,
  tools: Object.freeze([]),
  toolErrors: 0,
});

export interface CompactionResult {
  messages: ModelMessage[];
  state: CompactionState;
  /** Messages of the old span that no longer exist, the replaced summary included. */
  removed: number;
  savedChars: number;
}

export function transcriptChars(messages: readonly ModelMessage[]): number {
  let total = 0;
  for (const message of messages) total += message.content.length;
  return total;
}

/** A tool call with no answer next to it: dropping it would leave an answered call behind. */
function unanswered(message: ModelMessage | undefined): boolean {
  return message?.role === "assistant" && (message.toolCalls?.length ?? 0) > 0;
}

/** The observations this loop writes are JSON, so a failure is readable without guessing. */
function toolFailed(content: string): boolean {
  try {
    const parsed: unknown = JSON.parse(content);
    return typeof parsed === "object" && parsed !== null && (parsed as { ok?: unknown }).ok === false;
  } catch {
    return false;
  }
}

/** Leading system messages plus the first user turn: the task itself is never summarised away. */
function headEnd(messages: readonly ModelMessage[]): number {
  let index = 0;
  while (index < messages.length && messages[index]?.role === "system") index += 1;
  while (index < messages.length && messages[index]?.role !== "user") index += 1;
  return index < messages.length ? index + 1 : messages.length;
}

function summaryText(state: Omit<CompactionState, "text">): string {
  const tools = state.tools.slice(0, MAX_NAMED_TOOLS);
  const named = tools.length > 0 ? tools.join(", ") : "none";
  const rest = state.tools.length - tools.length;
  const unnamed = rest > 0 ? ` (+${rest} more)` : "";
  const failures = state.toolErrors > 0 ? `; ${state.toolErrors} failed tool result(s)` : "";
  return `${MARKER} ${state.droppedMessages} earlier message(s) dropped; tools used: ${named}${unnamed}${failures}.`.slice(
    0,
    MAX_SUMMARY_CHARS,
  );
}

/**
 * One compaction pass: replace the oldest droppable span with one summary message, or refuse.
 *
 * Refusing is the safe answer, and it is the answer in three cases: the transcript is under the cap,
 * no boundary exists that keeps every tool call answered, or the summary would not be shorter than
 * the span it replaces. A caller that loops on this therefore shrinks the transcript strictly, or
 * stops.
 */
export function compactMessages(
  messages: readonly ModelMessage[],
  policy: CompactionPolicy,
  previous: CompactionState = EMPTY_COMPACTION_STATE,
): CompactionResult | undefined {
  const total = transcriptChars(messages);
  if (total <= policy.maxChars) return undefined;
  const dropStart = headEnd(messages);
  const summary = messages[dropStart];
  const hasSummary = previous.text !== "" && summary?.role === "system" && summary.content === previous.text;
  // The summary sits at the head of the droppable span, so a later pass folds it into the new one.
  let keepFrom = Math.max(dropStart, messages.length - policy.keepMessages);
  for (let guard = 0; guard <= messages.length && keepFrom > dropStart; guard += 1) {
    let moved = false;
    while (keepFrom < messages.length && messages[keepFrom]?.role === "tool") {
      keepFrom += 1;
      moved = true;
    }
    while (keepFrom > dropStart && unanswered(messages[keepFrom - 1])) {
      keepFrom -= 1;
      moved = true;
    }
    if (!moved) break;
  }
  if (keepFrom <= dropStart) return undefined;

  const tools = new Set<string>(hasSummary ? previous.tools : []);
  let droppedMessages = hasSummary ? previous.droppedMessages : 0;
  let toolErrors = hasSummary ? previous.toolErrors : 0;
  for (let index = dropStart; index < keepFrom; index += 1) {
    const message = messages[index];
    if (message === undefined) continue;
    if (hasSummary && index === dropStart) continue;
    droppedMessages += 1;
    for (const call of message.toolCalls ?? []) tools.add(call.name);
    if (message.role === "tool" && toolFailed(message.content)) toolErrors += 1;
  }
  const state: CompactionState = { text: "", droppedMessages, tools: [...tools].sort(), toolErrors };
  const text = summaryText(state);
  if (
    text.length >=
    total - transcriptChars(messages.slice(0, dropStart)) - transcriptChars(messages.slice(keepFrom))
  ) {
    // A summary that costs as much as it saves is a loss: refuse instead of paying it every turn.
    return undefined;
  }
  const compacted: ModelMessage[] = [
    ...messages.slice(0, dropStart),
    { role: "system", content: text },
    ...messages.slice(keepFrom),
  ];
  return {
    messages: compacted,
    state: { ...state, text },
    removed: keepFrom - dropStart,
    savedChars: total - transcriptChars(compacted),
  };
}
