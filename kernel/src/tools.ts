export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  execute(input: unknown, signal?: AbortSignal): Promise<string>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) throw new Error(`tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`unknown tool: ${name}`);
    return tool;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  definitions(): { name: string; description: string; parameters: Readonly<Record<string, unknown>> }[] {
    return this.list().map(({ name, description, inputSchema }) => ({
      name,
      description,
      parameters: inputSchema,
    }));
  }
}
