import { defineConfig } from "vitest/config";

// `npm test` must be hermetic (no real Docker daemon required) so it runs
// the same way in any environment, including a CI runner that might not
// have Docker. The real-Docker-gated suite lives in tests/docker-live.test.ts
// and is excluded here; run it explicitly via `npm run test:live` (see
// vitest.live.config.ts and the README's "Real Docker verification" section).
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "tests/docker-live.test.ts"],
  },
});
