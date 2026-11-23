import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    // Run under a non-Manila host timezone so tests prove we never rely on the host clock's zone.
    env: { TZ: "America/Los_Angeles" },
  },
});
