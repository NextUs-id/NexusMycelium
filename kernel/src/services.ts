import type { AgentRunnerFactory } from "./agent.js";
import type { ModelProvider } from "./model.js";
import type { ToolRegistry } from "./tools.js";

export interface CoreServiceMap {
  readonly "model:mock": ModelProvider;
  readonly "model:openai": ModelProvider;
  readonly "tool:core": ToolRegistry;
  readonly "agent:runner-factory": AgentRunnerFactory;
}

export interface PluginServiceMap extends CoreServiceMap {
  readonly [name: string]: unknown;
}

export type ServiceName = string;

export interface ServiceReader {
  get<T>(name: ServiceName): T;
  has(name: ServiceName): boolean;
  names(): string[];
  owner(name: ServiceName): string | undefined;
}

export interface PluginCapabilityReader<Services extends object = PluginServiceMap> extends ServiceReader {
  get<Name extends keyof CoreServiceMap & string>(name: Name): CoreServiceMap[Name];
  get<Name extends Extract<keyof Services, string>>(name: Name): Services[Name];
  get<T>(name: ServiceName): T;
}

export interface PluginServices<Services extends object = PluginServiceMap>
  extends PluginCapabilityReader<Services> {
  register<Name extends keyof CoreServiceMap & string, Value extends CoreServiceMap[Name]>(
    name: Name,
    value: Value,
    owner?: string,
  ): void;
  register<Name extends Extract<keyof Services, string>, Value extends Services[Name]>(
    name: Name,
    value: Value,
    owner?: string,
  ): void;
  register<T>(name: ServiceName, value: T, owner?: string): void;
}

const unsafeServiceNames = new Set(["__proto__", "prototype", "constructor"]);

export function isServiceName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    !unsafeServiceNames.has(value) &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

function assertServiceName(name: string): void {
  if (!isServiceName(name)) throw new Error(`invalid service name: ${String(name)}`);
}

/** Services are owner-scoped; unloading a plugin removes every service it registered. */
export class ServiceRegistry {
  private readonly values = new Map<string, { owner: string; value: unknown }>();

  register<T>(name: string, value: T, owner = "kernel"): void {
    assertServiceName(name);
    if (typeof owner !== "string" || owner.length === 0 || owner.trim() !== owner) {
      throw new Error(`invalid service owner: ${String(owner)}`);
    }
    if (this.values.has(name)) throw new Error(`service already registered: ${name}`);
    this.values.set(name, { owner, value });
  }

  get<T>(name: string): T {
    assertServiceName(name);
    const entry = this.values.get(name);
    if (!entry) throw new Error(`service not found: ${name}`);
    return entry.value as T;
  }

  has(name: string): boolean {
    assertServiceName(name);
    return this.values.has(name);
  }

  owner(name: string): string | undefined {
    assertServiceName(name);
    return this.values.get(name)?.owner;
  }

  names(): string[] {
    return [...this.values.keys()];
  }

  unregisterOwner(owner: string): void {
    if (typeof owner !== "string" || owner.length === 0 || owner.trim() !== owner) {
      throw new Error(`invalid service owner: ${String(owner)}`);
    }
    for (const [name, entry] of this.values) {
      if (entry.owner === owner) this.values.delete(name);
    }
  }
}
