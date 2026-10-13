import { defineConfig } from "vitest/config";

// The mappers on real samples, and the downloader against a local server.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
