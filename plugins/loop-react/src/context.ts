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
/** Length of one tool turn at `index`: an assistant tool call plus every result that answers it. */
function toolTurn(messages: readonly ModelMessage[], index: number): number {
  const first = messages[index];
  if (first?.role !== "assistant" || (first.toolCalls?.length ?? 0) === 0) return 0;
  let end = index + 1;
  while (end < messages.length && messages[end]?.role === "tool") end += 1;
  return end - index;
}

/**
 * Which messages survive, `keep[index] === false` meaning "drop this one". Tier one never drops a
 * user turn, a final answer, or half a tool turn: it spends whole tool turns only, and only while
 * there is still a gap to close. It returns `undefined` when tool turns cannot reach the cap, which
 * is the caller's cue to try the span rule instead.
 */
function keepByToolTurns(
  messages: readonly ModelMessage[],
  start: number,
  maxChars: number,
): boolean[] | undefined {
  const keep = messages.map(() => true);
  let keptChars = transcriptChars(messages);
  let dropped = false;
  let index = start;
  while (index < messages.length) {
    const length = toolTurn(messages, index);
    if (length === 0) {
      index += 1;
      continue;
    }
    const groupChars = transcriptChars(messages.slice(index, index + length));
    // While the transcript is still over the cap, this whole turn is worth spending.
    if (keptChars > maxChars) {
      for (let inner = index; inner < index + length; inner += 1) keep[inner] = false;
      keptChars -= groupChars;
      dropped = true;
    }
    index += length;
  }
  if (!dropped || keptChars > maxChars) return undefined;
  return keep;
}

/** The span rule: keep the head, the recent tail, and cut wherever that leaves no orphan. */
function keepBySpan(
  messages: readonly ModelMessage[],
  dropStart: number,
  keepMessages: number,
): boolean[] | undefined {
  let keepFrom = Math.max(dropStart, messages.length - keepMessages);
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
  const keep = messages.map(() => true);
  for (let index = dropStart; index < keepFrom; index += 1) keep[index] = false;
  return keep;
}

/**
 * One compaction pass, in two tiers: spend whole tool turns first, and only fall back to cutting a
 * span when tool output cannot pay for the cap on its own.
 *
 * The tiers differ in what they may lose, and the first tier is the one that runs in practice. A
 * user instruction or a final answer is the part of a transcript a model cannot rebuild, so tier one
 * never drops either, however small `keepMessages` is. Tier two can, and that is the honest limit:
 * when the bulk of a transcript is prose rather than tool output, something has to go, and what
 * goes is the oldest span.
 */
export function compactMessages(
  messages: readonly ModelMessage[],
  policy: CompactionPolicy,
  previous: CompactionState = EMPTY_COMPACTION_STATE,
): CompactionResult | undefined {
  const total = transcriptChars(messages);
  if (total <= policy.maxChars) return undefined;
  const dropStart = headEnd(messages);
  if (dropStart >= messages.length) return undefined;
  const summary = messages[dropStart];
  const hasSummary = previous.text !== "" && summary?.role === "system" && summary.content === previous.text;
  // A carried summary is replaced, never kept next to a new one, so summaries cannot stack.
  const start = hasSummary ? dropStart + 1 : dropStart;
  const keep =
    keepByToolTurns(messages, start, policy.maxChars) ?? keepBySpan(messages, dropStart, policy.keepMessages);
  if (keep === undefined) return undefined;
  if (hasSummary && keep[dropStart] !== false) keep[dropStart] = false;

  const tools = new Set<string>(hasSummary ? previous.tools : []);
  let droppedMessages = hasSummary ? previous.droppedMessages : 0;
  let toolErrors = hasSummary ? previous.toolErrors : 0;
  let removed = 0;
  for (let index = dropStart; index < messages.length; index += 1) {
    if (keep[index] !== false) continue;
    const message = messages[index];
    if (message === undefined) continue;
    // The carried summary is already counted in `previous`; it is replaced, not counted twice.
    if (hasSummary && index === dropStart) continue;
    removed += 1;
    droppedMessages += 1;
    for (const call of message.toolCalls ?? []) tools.add(call.name);
    if (message.role === "tool" && toolFailed(message.content)) toolErrors += 1;
  }
  if (removed === 0) return undefined;
  const state: CompactionState = { text: "", droppedMessages, tools: [...tools].sort(), toolErrors };
  const text = summaryText(state);
  const compacted: ModelMessage[] = [];
  let written = false;
  for (let index = 0; index < messages.length; index += 1) {
    if (keep[index] === false) {
      if (!written) {
        compacted.push({ role: "system", content: text });
        written = true;
      }
      continue;
    }
    const message = messages[index];
    if (message !== undefined) compacted.push(message);
  }
  const savedChars = total - transcriptChars(compacted);
  // A summary that costs as much as it saves is a loss: refuse instead of paying it every turn.
  if (savedChars <= 0) return undefined;
  return { messages: compacted, state: { ...state, text }, removed, savedChars };
}
