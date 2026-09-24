import { EventBus } from "./events.js";
import type { Disposer, Logger, Plugin } from "./plugin.js";

const consoleLogger: Logger = {
  info: (m, meta) => console.info(m, meta ?? ""),
  warn: (m, meta) => console.warn(m, meta ?? ""),
  error: (m, meta) => console.error(m, meta ?? ""),
};

interface Loaded {
  plugin: Plugin;
  dispose?: Disposer;
}

/**
 * Baseline registry. Task 1.2 extends it with dependency ordering,
 * hot swap, and failure isolation. Keep this file small and boring.
 */
export class Registry {
  readonly events: EventBus;
  private available = new Map<string, Plugin>();
  private loaded = new Map<string, Loaded>();

  constructor(
    private log: Logger = consoleLogger,
    private configFor: (name: string) => Record<string, unknown> = () => ({}),
  ) {
    this.events = new EventBus((event, error) => this.log.error(`event handler failed: ${event}`, error));
  }

  register(plugin: Plugin): void {
    const { name } = plugin.manifest;
    if (this.available.has(name)) throw new Error(`plugin already registered: ${name}`);
    this.available.set(name, plugin);
  }

  async load(name: string): Promise<void> {
    if (this.loaded.has(name)) return;
    const plugin = this.available.get(name);
    if (!plugin) throw new Error(`unknown plugin: ${name}`);
    for (const dep of plugin.manifest.requires) {
      if (!this.loaded.has(dep)) throw new Error(`${name} requires ${dep}, which is not loaded`);
    }
    const dispose = await plugin.setup({
      events: this.events,
      log: this.log,
      config: this.configFor(name),
    });
    this.loaded.set(name, { plugin, dispose: dispose || undefined });
    await this.events.emit("plugin:loaded", { name });
  }

  async unload(name: string): Promise<void> {
    const entry = this.loaded.get(name);
    if (!entry) return;
    for (const [other, { plugin }] of this.loaded) {
      if (plugin.manifest.requires.includes(name)) {
        throw new Error(`cannot unload ${name}: ${other} depends on it`);
      }
    }
    await entry.dispose?.();
    this.loaded.delete(name);
    await this.events.emit("plugin:unloaded", { name });
  }

  isLoaded(name: string): boolean {
    return this.loaded.has(name);
  }

  loadedNames(): string[] {
    return [...this.loaded.keys()];
  }
}
