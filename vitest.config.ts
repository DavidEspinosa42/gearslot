import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.ts"],
          globalSetup: ["tests/integration/global-setup.ts"],
          // One shared database: files run one after another; tests inside a file may be concurrent.
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 240_000,
        },
      },
    ],
  },
});
