import { defineConfig } from "vitest/config";

// Runs ONLY the real-Docker-dependent integration test, invoked explicitly
// via `npm run test:live`. It self-skips (via isDockerAvailable()) rather
// than failing outright if no Docker daemon is reachable in the environment
// it's run in.
export default defineConfig({
  test: {
    include: ["tests/docker-live.test.ts"],
  },
});
