import { EventBus, type PluginEventMap } from "./events.js";
import { type PluginManifest, PluginManifestSchema } from "./manifest.js";
import { PermissionGate } from "./permissions.js";
import type { Disposer, Logger, Plugin } from "./plugin.js";
import {
  isServiceName,
  type PluginCapabilityReader,
  type PluginServices,
  type ServiceReader,
  ServiceRegistry,
} from "./services.js";

const consoleLogger: Logger = {
  info: (m, meta) => console.info(m, meta ?? ""),
  warn: (m, meta) => console.warn(m, meta ?? ""),
  error: (m, meta) => console.error(m, meta ?? ""),
};

interface Loaded {
  dispose?: Disposer;
}

interface OperationOutcome {
  events: Promise<void>;
}

interface InFlight {
  kind: "load" | "unload";
  promise: Promise<void>;
  state: Promise<void>;
}

export interface PluginFailure {
  readonly name: string;
  readonly error: string;
}

export interface LoadAllResult {
  readonly loaded: string[];
  readonly failures: PluginFailure[];
}

export interface LoadAllOptions {
  readonly strict?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRegisteredPlugin(value: unknown): Plugin {
  if (!isRecord(value)) throw new Error("plugin must be an object");
  if (typeof value.setup !== "function") throw new Error("plugin setup must be a function");
  const parsed = PluginManifestSchema.safeParse(value.manifest);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw new Error(`invalid plugin manifest: ${detail}`);
  }
  return { manifest: parsed.data as PluginManifest, setup: value.setup as Plugin["setup"] };
}

/** Failures cross the bulk boundary as messages: no stacks, no objects, no partial diagnostics. */
function failureMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "unknown error";
}

export class Registry {
  readonly events: EventBus<PluginEventMap>;
  readonly services: ServiceReader;
  private readonly serviceStore: ServiceRegistry;
  private readonly available = new Map<string, Plugin>();
  private readonly loaded = new Map<string, Loaded>();
  private readonly inFlight = new Map<string, InFlight>();
  /** Every pending dependency edge, so a branching node keeps all of its in-flight dependencies. */
  private readonly loadEdges = new Map<string, Set<string>>();
  /** Load generation per plugin: a facade outliving its generation can no longer register. */
  private readonly epochs = new Map<string, number>();
  private epoch = 0;
  private closed = false;
  private closeRun: Promise<void> | undefined;

  constructor(
    private readonly log: Logger = consoleLogger,
    private readonly configFor: (name: string) => Record<string, unknown> = () => ({}),
    readonly permissions: PermissionGate = new PermissionGate(),
    services: ServiceRegistry = new ServiceRegistry(),
  ) {
    this.serviceStore = services;
    this.services = services;
    this.events = new EventBus<PluginEventMap>((event, error) =>
      this.log.error(`event handler failed: ${event}`, error),
    );
  }

  register(plugin: Plugin): void {
    const normalized = normalizeRegisteredPlugin(plugin);
    const { name } = normalized.manifest;
    if (this.available.has(name)) throw new Error(`plugin already registered: ${name}`);
    this.available.set(name, normalized);
  }

  load(name: string): Promise<void> {
    const active = this.inFlight.get(name);
    if (active?.kind === "load") return active.promise;
    if (active === undefined && this.closed) return Promise.reject(new Error("plugin registry is closed"));
    return this.continueLoad(name);
  }

  /** Reached only from a load admitted before close: the drain disposes whatever it loads. */
  private continueLoad(name: string): Promise<void> {
    const active = this.inFlight.get(name);
    if (active?.kind === "load") return active.promise;
    if (active !== undefined) {
      const resume = (): Promise<void> => this.continueLoad(name);
      return active.state.then(resume, resume);
    }
    if (this.loaded.has(name)) return Promise.resolve();
    return this.startOperation(name, "load", () => this.loadInternal(name, [name]));
  }

  private settleOperation(name: string, kind: InFlight["kind"]): void {
    if (this.inFlight.get(name)?.kind === kind) this.inFlight.delete(name);
  }

  private startOperation(
    name: string,
    kind: InFlight["kind"],
    operation: () => Promise<OperationOutcome>,
  ): Promise<void> {
    let outcome: OperationOutcome = { events: Promise.resolve() };
    const state = Promise.resolve()
      .then(operation)
      .then((value) => {
        outcome = value;
      });
    const promise = state.then(async () => {
      await outcome.events;
    });
    const entry: InFlight = { kind, promise, state };
    void promise.catch(() => {});
    this.inFlight.set(name, entry);
    const clear = (): void => {
      if (this.inFlight.get(name) === entry) this.inFlight.delete(name);
    };
    void state.then(clear, clear);
    return promise;
  }

  private loadDependency(name: string, ancestry: readonly string[], parent: string): Promise<void> {
    const active = this.inFlight.get(name);
    if (active) {
      if (active.kind === "load") {
        this.assertNoLoadCycle(parent, name);
        return active.state;
      }
      const resume = (): Promise<void> => this.loadDependency(name, ancestry, parent);
      return active.state.then(resume, resume);
    }
    if (this.loaded.has(name)) return Promise.resolve();
    this.startOperation(name, "load", () => this.loadInternal(name, ancestry));
    return this.inFlight.get(name)?.state ?? Promise.resolve();
  }

  private addEdge(from: string, to: string): void {
    let edges = this.loadEdges.get(from);
    if (!edges) {
      edges = new Set();
      this.loadEdges.set(from, edges);
    }
    edges.add(to);
  }

  private removeEdge(from: string, to: string): void {
    const edges = this.loadEdges.get(from);
    if (!edges) return;
    edges.delete(to);
    if (edges.size === 0) this.loadEdges.delete(from);
  }

  private assertNoLoadCycle(parent: string, target: string): void {
    const path = this.edgePath(target, parent);
    if (path === undefined) return;
    const cycle = path[path.length - 1] === parent ? path : [...path, parent];
    throw new Error(`plugin dependency cycle: ${cycle.join(" -> ")}`);
  }

  private edgePath(from: string, to: string): string[] | undefined {
    const queue: string[][] = [[from]];
    const seen = new Set<string>([from]);
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
      const last = path[path.length - 1];
      if (last === undefined) continue;
      if (last === to) return path;
      for (const next of this.loadEdges.get(last) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push([...path, next]);
      }
    }
    return undefined;
  }

  private async loadInternal(name: string, ancestry: readonly string[]): Promise<OperationOutcome> {
    const plugin = this.available.get(name);
    if (!plugin) throw new Error(`unknown plugin: ${name}`);
    for (const dependency of plugin.manifest.requires) {
      if (!this.available.has(dependency)) {
        throw new Error(`${name} requires ${dependency}, which is not registered`);
      }
      if (ancestry.includes(dependency)) {
        throw new Error(`plugin dependency cycle: ${[...ancestry, dependency].join(" -> ")}`);
      }
      this.addEdge(name, dependency);
      try {
        await this.loadDependency(dependency, [...ancestry, dependency], name);
      } finally {
        this.removeEdge(name, dependency);
      }
    }

    const epoch = this.epoch + 1;
    this.epoch = epoch;
    this.epochs.set(name, epoch);
    let dispose: Disposer | undefined;
    const services = this.pluginServices(name, epoch);
    const capabilities = this.capabilityReader(name);
    try {
      const setupResult: unknown = await plugin.setup({
        events: this.events,
        log: this.log,
        config: this.configFor(name),
        services,
        capabilities,
        permissions: this.permissions.scope(plugin.manifest.permissions),
      });
      if (setupResult !== undefined && typeof setupResult !== "function") {
        throw new Error(`plugin setup must return a disposer or undefined: ${name}`);
      }
      dispose = setupResult as Disposer | undefined;
    } catch (error) {
      this.epochs.delete(name);
      this.removeServices(name);
      throw error;
    }
    this.loaded.set(name, { dispose });
    this.settleOperation(name, "load");
    return { events: this.events.emit("plugin:loaded", { name }) };
  }

  /**
   * Bulk load in dependency order. Unknown names, missing dependencies, and cycles are found by a
   * pre-check that runs no plugin code, so nothing from a broken graph is ever loaded. A failed
   * setup blocks only the names that require it; independent siblings keep loading and every failure
   * is reported per name. `strict` turns the report into a rejection for fail-closed callers.
   */
  async loadAll(names: readonly string[], options: LoadAllOptions = {}): Promise<LoadAllResult> {
    if (this.closed) throw new Error("plugin registry is closed");
    const { order, failed } = this.planLoad(names);
    for (const name of order) {
      const requires = this.available.get(name)?.manifest.requires ?? [];
      const blocker = requires.find((dependency) => failed.has(dependency));
      if (blocker !== undefined) {
        failed.set(name, `${name} requires ${blocker}: ${failed.get(blocker)}`);
        continue;
      }
      try {
        await this.load(name);
      } catch (error) {
        failed.set(name, failureMessage(error));
      }
    }
    const failures = [...failed].map(([name, error]) => ({ name, error }));
    if (options.strict === true && failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.error),
        "plugin load failed",
      );
    }
    return { loaded: order.filter((name) => !failed.has(name)), failures };
  }

  /**
   * Dependency-first order plus the pre-check verdict. The walk runs no plugin code, so a name with
   * an unknown dependency or a cycle is reported, together with everything that requires it, and
   * never reaches the load phase.
   */
  private planLoad(names: readonly string[]): { order: string[]; failed: Map<string, string> } {
    const failed = new Map<string, string>();
    const order: string[] = [];
    const planned = new Set<string>();
    const plan = (name: string, path: readonly string[]): void => {
      if (planned.has(name) || failed.has(name)) return;
      const plugin = this.available.get(name);
      if (!plugin) {
        failed.set(name, `unknown plugin: ${name}`);
        return;
      }
      for (const dependency of plugin.manifest.requires) {
        if (!this.available.has(dependency)) {
          failed.set(name, `${name} requires ${dependency}, which is not registered`);
          return;
        }
        if (path.includes(dependency)) {
          failed.set(name, `plugin dependency cycle: ${[...path, dependency].join(" -> ")}`);
          return;
        }
        plan(dependency, [...path, dependency]);
        if (failed.has(dependency)) {
          failed.set(name, `${name} requires ${dependency}: ${failed.get(dependency)}`);
          return;
        }
      }
      order.push(name);
      planned.add(name);
    };
    for (const name of names) plan(name, [name]);
    return { order, failed };
  }

  /**
   * Object-level swap for official in-process plugins: the caller hands over the replacement, there
   * is no file watcher and no agent-made/ reload. The dependent closure is unloaded in reverse load
   * order, the object is replaced only while nothing is loaded or in flight, and the closure is
   * loaded again in dependency order. A refused replacement restores the previous object and its
   * live services before rejecting, so a failed swap never orphans or tears a service.
   */
  async reload(name: string, replacement?: Plugin): Promise<void> {
    if (this.closed) throw new Error("plugin registry is closed");
    const previous = this.available.get(name);
    if (previous === undefined) throw new Error(`unknown plugin: ${name}`);
    const next = replacement === undefined ? previous : normalizeRegisteredPlugin(replacement);
    if (next.manifest.name !== name) {
      throw new Error(`replacement plugin must be named ${name}: ${next.manifest.name}`);
    }
    const closure = this.dependentsOf(name);
    for (const member of closure) {
      const active = this.inFlight.get(member);
      if (active !== undefined) await active.promise.catch(() => {});
    }
    const restore = [...this.loaded.keys()].filter((member) => closure.has(member));
    const target = restore.length === 0 ? [name] : restore;
    const failures: unknown[] = [];
    for (const member of [...target].reverse()) {
      try {
        await this.unload(member);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 0) {
      if (this.loaded.has(name) || this.inFlight.has(name)) {
        failures.push(new Error(`cannot reload ${name}: the plugin is loaded or in flight`));
      } else {
        this.available.set(name, next);
        for (const member of target) {
          try {
            await this.load(member);
          } catch (error) {
            failures.push(error);
            break;
          }
        }
      }
    }
    if (failures.length === 0) return;
    this.available.set(name, previous);
    for (const member of [...target].reverse()) {
      try {
        await this.unload(member);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const member of target) {
      try {
        await this.load(member);
      } catch (error) {
        failures.push(error);
      }
    }
    throw new AggregateError(failures, `plugin reload failed: ${name}`);
  }

  /** The plugin itself plus every registered plugin that transitively requires it. */
  private dependentsOf(name: string): Set<string> {
    // ponytail: fixpoint scan over the registered set; index by name if that set ever grows.
    const dependents = new Set([name]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [candidate, plugin] of this.available) {
        if (dependents.has(candidate)) continue;
        if (plugin.manifest.requires.some((dependency) => dependents.has(dependency))) {
          dependents.add(candidate);
          grew = true;
        }
      }
    }
    return dependents;
  }

  private allowedServiceOwners(name: string): ReadonlySet<string> {
    const owners = new Set([name]);
    const pending = [...(this.available.get(name)?.manifest.requires ?? [])];
    while (pending.length > 0) {
      const owner = pending.pop();
      if (owner === undefined || owners.has(owner)) continue;
      owners.add(owner);
      pending.push(...(this.available.get(owner)?.manifest.requires ?? []));
    }
    return owners;
  }

  private serviceAvailable(service: string, allowedOwners: ReadonlySet<string>): boolean {
    if (!isServiceName(service)) return false;
    const owner = this.serviceStore.owner(service);
    if (owner === undefined || !allowedOwners.has(owner)) return false;
    const ownerPlugin = this.available.get(owner);
    return ownerPlugin === undefined || ownerPlugin.manifest.provides.includes(service);
  }

  private pluginServices(name: string, epoch: number): PluginServices {
    const registry = this;
    const allowedOwners = this.allowedServiceOwners(name);
    const declared = new Set(this.available.get(name)?.manifest.provides ?? []);
    const available = (service: string): boolean => this.serviceAvailable(service, allowedOwners);
    const reader: PluginCapabilityReader = {
      get<T>(service: string): T {
        if (!available(service)) throw new Error(`service not found: ${service}`);
        return registry.serviceStore.get<T>(service);
      },
      has: available,
      names(): string[] {
        return registry.serviceStore.names().filter(available);
      },
      owner(service: string): string | undefined {
        return available(service) ? registry.serviceStore.owner(service) : undefined;
      },
    };
    return {
      ...reader,
      register<T>(service: string, value: T, owner?: string): void {
        // A facade can outlive its generation: only the live load may register.
        if (registry.epochs.get(name) !== epoch) {
          throw new Error(`cannot register service: plugin ${name} is not loaded`);
        }
        if (owner !== undefined && owner !== name) throw new Error(`service owner must be ${name}`);
        if (!declared.has(service)) {
          throw new Error(`service ${service} is not declared in provides for ${name}`);
        }
        registry.serviceStore.register(service, value, name);
      },
    } as PluginServices;
  }

  private capabilityReader(name: string): PluginCapabilityReader {
    const registry = this;
    const allowedOwners = this.allowedServiceOwners(name);
    const available = (service: string): boolean => this.serviceAvailable(service, allowedOwners);
    return {
      get<T>(service: string): T {
        if (!available(service)) throw new Error(`service not found: ${service}`);
        return registry.serviceStore.get<T>(service);
      },
      has: available,
      names: () => registry.serviceStore.names().filter(available),
      owner: (service: string) => (available(service) ? registry.serviceStore.owner(service) : undefined),
    };
  }

  private removeServices(name: string): void {
    this.serviceStore.unregisterOwner(name);
  }

  unload(name: string): Promise<void> {
    const active = this.inFlight.get(name);
    if (active) {
      if (active.kind === "unload") return active.promise;
      const resume = (): Promise<void> => this.unload(name);
      return active.state.then(resume, resume);
    }
    if (!this.loaded.has(name)) return Promise.resolve();
    return this.startOperation(name, "unload", () => this.unloadInternal(name));
  }

  private async callDisposer(dispose: Disposer | undefined): Promise<void> {
    if (dispose === undefined) return;
    const result: unknown = dispose();
    const awaited = await result;
    if (awaited !== undefined) throw new Error("plugin disposer must return void");
  }

  private async unloadInternal(name: string): Promise<OperationOutcome> {
    const entry = this.loaded.get(name);
    if (!entry) return { events: Promise.resolve() };
    const dependents = this.dependentsOf(name);
    dependents.delete(name);
    for (const [other, { kind }] of this.inFlight) {
      if (kind === "load" && dependents.has(other)) {
        throw new Error(`cannot unload ${name}: ${other} is loading and depends on it`);
      }
    }
    for (const other of this.loaded.keys()) {
      if (dependents.has(other)) throw new Error(`cannot unload ${name}: ${other} depends on it`);
    }

    let disposeError: unknown;
    let disposeFailed = false;
    try {
      await this.callDisposer(entry.dispose);
    } catch (error) {
      disposeError = error;
      disposeFailed = true;
    }
    this.loaded.delete(name);
    this.epochs.delete(name);
    this.removeServices(name);
    this.settleOperation(name, "unload");
    const events = this.events.emit("plugin:unloaded", { name });
    return {
      events: disposeFailed
        ? events.then(() => {
            throw disposeError;
          })
        : events,
    };
  }

  close(): Promise<void> {
    this.closeRun ??= this.drain();
    return this.closeRun;
  }

  /** Terminal: once the drain settles the registry accepts nothing again, however it ended. */
  private async drain(): Promise<void> {
    this.closed = true;
    const errors: unknown[] = [];
    while (this.inFlight.size > 0) {
      const settled = await Promise.allSettled([...this.inFlight.values()].map(({ state }) => state));
      for (const result of settled) {
        if (result.status === "rejected") errors.push(result.reason);
      }
    }
    while (this.loaded.size > 0) {
      for (const name of [...this.loaded.keys()].reverse()) {
        try {
          await this.unload(name);
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "plugin shutdown failed");
  }

  isLoaded(name: string): boolean {
    return this.loaded.has(name);
  }

  loadedNames(): string[] {
    return [...this.loaded.keys()];
  }
}
