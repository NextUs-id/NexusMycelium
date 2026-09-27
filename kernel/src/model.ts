export type ModelRole = "system" | "user" | "assistant" | "tool";

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ModelMessage {
  role: ModelRole;
  content: string;
  toolCallId?: string;
  toolCalls?: readonly ModelToolCall[];
}

export interface ModelToolDefinition {
  name: string;
  description: string;
  parameters: Readonly<Record<string, unknown>>;
}

/** Token accounting for one model turn, or the summed turns of a run on `AgentResult`. */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Provenance of the counts, e.g. the provider's own report. Free-form on purpose. */
  source: string;
  /**
   * Input tokens the provider served from its own prompt cache. Optional and additive: a report
   * without a cache-read count stays a valid `ModelUsage`, and a count is never derived or zero-filled
   * here. It is already part of `inputTokens`, so it is a reading aid and never a second charge.
   */
  cachedTokens?: number;
}

/** USD per million tokens. The caller supplies prices; the kernel never guesses them. */
export interface ModelPrice {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
}

export type ModelResult =
  | { type: "tool_calls"; calls: readonly ModelToolCall[]; usage?: ModelUsage }
  | { type: "final"; text: string; usage?: ModelUsage };

export interface ModelProvider {
  complete(
    messages: readonly ModelMessage[],
    tools: readonly ModelToolDefinition[],
    signal?: AbortSignal,
  ): Promise<ModelResult>;
}
