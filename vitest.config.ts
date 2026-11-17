import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "core",
          root: "./packages/core",
          include: ["test/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "api",
          root: "./apps/api",
          include: ["test/**/*.test.ts"],
          environment: "node",
          testTimeout: 30000,
        },
      },
    ],
  },
});
