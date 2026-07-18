import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // Mirror the "@/*" -> "./src/*" path alias from tsconfig.json.
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
