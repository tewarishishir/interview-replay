import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    /**
     * The DB tests share a single Postgres database; running suites in
     * parallel would cause them to step on each other's rows. We
     * disable parallelism rather than namespacing every test, which is
     * fine because the suite is small and IO-bound on the DB.
     */
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    setupFiles: ["./tests/setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // `server-only` is a Next.js runtime guard ("crash if this module
      // gets imported into a client bundle"). Vitest doesn't bundle for
      // a client, so the marker is meaningless here — alias it to an
      // empty module so the import is a no-op.
      "server-only": path.resolve(__dirname, "tests/shims/server-only.ts"),
    },
  },
});
