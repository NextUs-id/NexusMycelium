import { z } from "zod";

export type Unsubscribe = () => void;
type Handler<T> = (payload: T) => void | Promise<void>;
export type EventErrorHandler = (event: string, error: unknown) => void;

/** One strict validator per event. A name missing from the catalog is not a member of this bus. */
export type EventCatalog<Events extends object> = {
  readonly [K in keyof Events]: z.ZodType<Events[K]>;
};

/** Public lifecycle event map v1. Docs: docs/PLUGIN_API.md, docs/ARCHITECTURE.md. */
export interface PluginEventMap {
  "plugin:loaded": { name: string };
  "plugin:unloaded": { name: string };
}

const pluginNamePayloadSchema = z.strictObject({ name: z.string().min(1) });

/** Runtime catalog, type-checked against `PluginEventMap` so map and schemas cannot drift. */
export const PLUGIN_EVENT_SCHEMAS = {
  "plugin:loaded": pluginNamePayloadSchema,
  "plugin:unloaded": pluginNamePayloadSchema,
} satisfies EventCatalog<PluginEventMap>;

/** Catalog names, type-checked against `PluginEventMap`; equality with the schemas is tested. */
export const PLUGIN_EVENT_NAMES = [
  "plugin:loaded",
  "plugin:unloaded",
] as const satisfies readonly (keyof PluginEventMap & string)[];

/**
 * Ceiling for nested `emit` calls. A handler that re-emits (directly or through an
 * unawaited promise) fails closed past this depth instead of hanging.
 * ponytail: fixed depth ceiling, not a per-event cycle detector. Raise or make
 * configurable only if a real workload needs deeper legitimate nesting.
 */
export const MAX_EMIT_DEPTH = 16;

export class EventBus<Events extends object> {
  private readonly handlers = new Map<keyof Events, Set<Handler<never>>>();
  private depth = 0;

  /**
   * @param onError receives every rejection: handler throw, invalid name/payload, depth overflow.
   *   It is never allowed to break `emit`; a throwing `onError` is swallowed.
   * @param catalog defaults to the plugin lifecycle catalog because `EventBus<PluginEventMap>`
   *   is the only bus the plugin surface hands out. A bus for any other map must pass its own
   *   catalog explicitly, otherwise every name it emits is unknown and fails closed.
   */
  constructor(
    private readonly onError: EventErrorHandler = () => {},
    private readonly catalog: EventCatalog<Events> | EventCatalog<PluginEventMap> = PLUGIN_EVENT_SCHEMAS,
  ) {}

  /** Fails closed on an event name outside the catalog: reported, not registered, no-op unsubscribe. */
  on<K extends keyof Events>(event: K, handler: Handler<Events[K]>): Unsubscribe {
    if (!this.schemaFor(event)) {
      this.report(String(event), new Error(`unknown event: ${String(event)}`));
      return () => {};
    }
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler<never>);
    return () => {
      set.delete(handler as Handler<never>);
    };
  }

  /** Fails closed on an unknown name or an invalid payload: reported, nothing dispatched. */
  async emit<K extends keyof Events>(event: K, payload: Events[K]): Promise<void> {
    const schema = this.schemaFor(event);
    if (!schema) {
      this.report(String(event), new Error(`unknown event: ${String(event)}`));
      return;
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      this.report(String(event), parsed.error);
      return;
    }
    const set = this.handlers.get(event);
    if (!set || set.size === 0) return;
    if (this.depth >= MAX_EMIT_DEPTH) {
      this.report(String(event), new Error(`emit depth limit ${MAX_EMIT_DEPTH} exceeded`));
      return;
    }
    this.depth += 1;
    try {
      // Snapshot: handlers added or removed mid-dispatch do not change this emit.
      await Promise.all(
        [...set].map(async (entry) => {
          try {
            await (entry as Handler<Events[K]>)(parsed.data as Events[K]);
          } catch (error) {
            this.report(String(event), error);
          }
        }),
      );
    } finally {
      this.depth -= 1;
    }
  }

  listenerCount(event: keyof Events): number {
    return this.handlers.get(event)?.size ?? 0;
  }

  private schemaFor(event: keyof Events): z.ZodType<Events[keyof Events]> | undefined {
    const schemas = this.catalog as Partial<Record<keyof Events & string, z.ZodType<Events[keyof Events]>>>;
    return schemas[event as keyof Events & string];
  }

  private report(event: string, error: unknown): void {
    try {
      this.onError(event, error);
    } catch {
      // ponytail: an error reporter that throws must not reject emit; swallow it here.
    }
  }
}
