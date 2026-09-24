import { definePlugin } from "@nexus/kernel";

/** Minimal plugin: copy this folder to start a new one. */
export default definePlugin({
  manifest: {
    name: "example-hello",
    version: "0.1.0",
    apiVersion: 1,
    description: "Logs a greeting on load. Reference implementation.",
    provides: ["example"],
  },
  setup({ log, config }) {
    const who = typeof config.who === "string" ? config.who : "world";
    log.info(`hello, ${who}`);
    return () => log.info("bye");
  },
});
