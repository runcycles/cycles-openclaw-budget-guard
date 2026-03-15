import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    environment: "node",
    pool: "threads",
    coverage: {
      thresholds: {
        lines: 95,
        branches: 95,
      },
    },
  },
});
