import { Registry } from "@nexusmycelium/kernel";
import { describe, expect, it } from "vitest";
import hello from "./index.js";

describe("example-hello", () => {
  it("loads, greets using config, and unloads", async () => {
    const lines: string[] = [];
    const log = {
      info: (m: string) => {
        lines.push(m);
      },
      warn() {},
      error() {},
    };
    const reg = new Registry(log, () => ({ who: "nexus" }));
    reg.register(hello);
    await reg.load("example-hello");
    await reg.unload("example-hello");
    expect(lines).toEqual(["hello, nexus", "bye"]);
  });
});
