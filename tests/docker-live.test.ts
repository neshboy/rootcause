import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectDiagnosisContext } from "../src/collector.js";
import { isDockerAvailable } from "../src/docker.js";
import { diagnose } from "../src/engine.js";

/**
 * REAL Docker integration test - not mocked. Builds and runs real, minimal
 * containers engineered to fail in three different real ways, then runs
 * RootCause's actual collector + heuristics engine against them via the
 * real `docker` CLI, and asserts on the real diagnosis produced.
 *
 * This is intentionally NOT part of the default `npm test` run (see
 * vitest.config.ts, which excludes this file, and the README's "Real
 * Docker verification" section for why) - it's invoked explicitly via
 * `npm run test:live`. It self-skips via `isDockerAvailable()` rather than
 * failing outright when no Docker daemon is reachable, so it is still safe
 * to run in an environment without Docker.
 */

const execFileAsync = promisify(execFile);
const PREFIX = "rootcause-live-test";

async function docker(args: string[]): Promise<void> {
  await execFileAsync("docker", args, { maxBuffer: 16 * 1024 * 1024 });
}

async function dockerIgnoreErrors(args: string[]): Promise<void> {
  try {
    await docker(args);
  } catch {
    // best-effort cleanup
  }
}

const dockerAvailable = await isDockerAvailable();

describe.skipIf(!dockerAvailable)("real Docker integration (rootcause vs. real failing containers)", () => {
  const exitName = `${PREFIX}-exit1`;
  const oomName = `${PREFIX}-oom`;
  const healthName = `${PREFIX}-health`;

  beforeAll(async () => {
    await dockerIgnoreErrors(["rm", "-f", exitName, oomName, healthName]);

    await docker(["run", "-d", "--name", exitName, "alpine:latest", "sh", "-c", "echo boom; exit 1"]);

    await docker([
      "run",
      "-d",
      "--name",
      healthName,
      "--health-cmd=exit 1",
      "--health-interval=1s",
      "--health-retries=1",
      "--health-timeout=1s",
      "--health-start-period=1s",
      "alpine:latest",
      "sleep",
      "60",
    ]);

    // Real OOM trigger: write past the container's memory cgroup limit into
    // tmpfs (/dev/shm), which is charged to that cgroup - the kernel's OOM
    // killer then kills the container for real. Verified manually against
    // this environment's real Docker daemon before being encoded here.
    await docker([
      "run",
      "-d",
      "--name",
      oomName,
      "--memory=20m",
      "busybox",
      "sh",
      "-c",
      "dd if=/dev/zero of=/dev/shm/fillfile bs=1M count=200",
    ]);

    // Give all three containers time to actually reach their failing state.
    await new Promise((resolve) => setTimeout(resolve, 8000));
  }, 60_000);

  afterAll(async () => {
    await dockerIgnoreErrors(["rm", "-f", exitName, oomName, healthName]);
  });

  it("identifies a real OOM-killed container from real docker inspect output", async () => {
    const ctx = await collectDiagnosisContext(oomName);
    expect(ctx.inspect.State.OOMKilled).toBe(true);
    const result = diagnose(ctx);
    expect(result.status).toBe("issues-found");
    expect(result.hypotheses.map((h) => h.id)).toContain("oom-killed");
    expect(result.hypotheses.find((h) => h.id === "oom-killed")!.confidence).toBe("high");
  }, 30_000);

  it("identifies a real non-zero exit with real captured logs", async () => {
    const ctx = await collectDiagnosisContext(exitName);
    expect(ctx.inspect.State.ExitCode).toBe(1);
    const result = diagnose(ctx);
    expect(result.status).toBe("issues-found");
    const hyp = result.hypotheses.find((h) => h.id === "nonzero-exit");
    expect(hyp).toBeDefined();
    expect(hyp!.evidence.join("\n")).toContain("boom");
  }, 30_000);

  it("identifies a real failing HEALTHCHECK from real docker inspect output", async () => {
    const ctx = await collectDiagnosisContext(healthName);
    expect(ctx.inspect.State.Health?.Status).toBe("unhealthy");
    const result = diagnose(ctx);
    expect(result.status).toBe("issues-found");
    expect(result.hypotheses.map((h) => h.id)).toContain("failing-healthcheck");
  }, 30_000);
});
