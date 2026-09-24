import type { EventBus } from "./events.js";
import { type PluginManifest, type PluginManifestInput, PluginManifestSchema } from "./manifest.js";

export interface Logger {
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

export interface PluginContext {
  events: EventBus;
  log: Logger;
  /** Merged config for this plugin (official defaults <- user layer). */
  config: Record<string, unknown>;
}

/** Cleanup function returned by `setup`. Called on unload / hot swap. */
export type Disposer = () => void | Promise<void>;

export interface Plugin {
  manifest: PluginManifest;
  setup(ctx: PluginContext): Disposer | undefined | Promise<Disposer | undefined>;
}

export interface PluginDefinition {
  manifest: PluginManifestInput;
  setup: Plugin["setup"];
}

/** Validates the manifest and returns a ready-to-register plugin. */
export function definePlugin(def: PluginDefinition): Plugin {
  return { manifest: PluginManifestSchema.parse(def.manifest), setup: def.setup };
}
