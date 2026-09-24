export type Unsubscribe = () => void;
type Handler<T> = (payload: T) => void | Promise<void>;

/**
 * Tiny typed event bus. Handlers are isolated: one failing handler
 * never blocks the others. Errors are reported through `onError`.
 */
export class EventBus<Events extends Record<string, unknown> = Record<string, unknown>> {
  private handlers = new Map<keyof Events, Set<Handler<never>>>();

  constructor(private onError: (event: string, error: unknown) => void = () => {}) {}

  on<K extends keyof Events>(event: K, handler: Handler<Events[K]>): Unsubscribe {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler<never>);
    return () => set.delete(handler as Handler<never>);
  }

  async emit<K extends keyof Events>(event: K, payload: Events[K]): Promise<void> {
    const set = this.handlers.get(event);
    if (!set) return;
    await Promise.all(
      [...set].map(async (h) => {
        try {
          await (h as Handler<Events[K]>)(payload);
        } catch (error) {
          this.onError(String(event), error);
        }
      }),
    );
  }

  listenerCount(event: keyof Events): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}
