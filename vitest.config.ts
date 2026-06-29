import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Run tests via the Node runner so built-in modules resolve natively.
    pool: "forks",
    // node:sqlite is an experimental builtin (Node 24+); vite-node mangles it,
    // so route it (and the bare form) back to the real builtin via alias.
    alias: {
      sqlite: "node:sqlite",
    },
    server: {
      deps: { external: [/^node:/] },
    },
  },
  resolve: {
    conditions: ["node", "import"],
  },
});
