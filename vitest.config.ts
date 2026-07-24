import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "pi-workflows": new URL("./src/workflows/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/e2e/**", "node_modules/**"],
    coverage: {
      // istanbul instruments through the vitest transform pipeline only, so
      // jiti-compiled copies of workflow modules don't pollute the report.
      provider: "istanbul",
      include: ["src/**"],
      // overlay.ts needs a real TUI/Theme the test harness cannot produce, and
      // the e2e suite runs --mode rpc where the overlay factory never runs. The
      // logic it drives lives in src/render/run-view.ts and is tested there.
      exclude: ["src/extension/overlay.ts"],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 85,
        statements: 85,
      },
    },
  },
});
