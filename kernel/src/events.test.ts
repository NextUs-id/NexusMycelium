import { describe, expect, it, vi } from "vitest";
import { EventBus } from "./events.js";

describe("EventBus", () => {
  it("delivers payloads and supports unsubscribe", async () => {
    const bus = new EventBus<{ ping: number }>();
    const fn = vi.fn();
    const off = bus.on("ping", fn);
    await bus.emit("ping", 1);
    off();
    await bus.emit("ping", 2);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(1);
  });

  it("isolates failing handlers", async () => {
    const errors: string[] = [];
    const bus = new EventBus<{ ping: number }>((e) => errors.push(e));
    const ok = vi.fn();
    bus.on("ping", () => {
      throw new Error("boom");
    });
    bus.on("ping", ok);
    await bus.emit("ping", 1);
    expect(ok).toHaveBeenCalled();
    expect(errors).toEqual(["ping"]);
  });
});
