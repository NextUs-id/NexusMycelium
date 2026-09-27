import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["benchmarks/**/*.test.ts", "kernel/**/*.test.ts", "plugins/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
  },
});
