import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { heuristics, type DiagnosisContext } from "../src/heuristics.js";
import type { ContainerInspect, DockerEvent, ImageInspect } from "../src/types.js";

const fixturesDir = path.join(__dirname, "fixtures");

function loadInspect(name: string): ContainerInspect {
  const raw = JSON.parse(readFileSync(path.join(fixturesDir, name), "utf-8")) as ContainerInspect[];
  return raw[0];
}

function loadImage(name: string): ImageInspect {
  const raw = JSON.parse(readFileSync(path.join(fixturesDir, name), "utf-8")) as ImageInspect[];
  return raw[0];
}

function loadEvents(name: string): DockerEvent[] {
  return readFileSync(path.join(fixturesDir, name), "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as DockerEvent);
}

function ctxFor(inspect: ContainerInspect, overrides: Partial<DiagnosisContext> = {}): DiagnosisContext {
  return {
    containerName: inspect.Name.replace(/^\//, ""),
    inspect,
    currentImageInspect: null,
    events: [],
    logTail: "",
    now: new Date("2026-09-24T14:00:00.000Z"),
    ...overrides,
  };
}

function heuristic(id: string) {
  const h = heuristics.find((x) => x.id === id);
  if (!h) throw new Error(`no heuristic registered with id "${id}"`);
  return h;
}

describe("oom-killed heuristic", () => {
  it("fires with high confidence and quotes OOMKilled/exit code/memory limit evidence", () => {
    const ctx = ctxFor(loadInspect("inspect-oom.json"));
    const result = heuristic("oom-killed").evaluate(ctx);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe("high");
    expect(result!.evidence.join(" ")).toContain("OOMKilled=true");
    expect(result!.evidence.join(" ")).toContain("ExitCode=137");
    expect(result!.evidence.join(" ")).toContain("32MB"); // 33554432 bytes
  });

  it("does not fire for a container that exited without OOMKilled set", () => {
    const ctx = ctxFor(loadInspect("inspect-exit1.json"));
    expect(heuristic("oom-killed").evaluate(ctx)).toBeNull();
  });
});

describe("nonzero-exit heuristic", () => {
  it("fires and quotes the exit code plus the real log tail", () => {
    const ctx = ctxFor(loadInspect("inspect-exit1.json"), {
      logTail: readFileSync(path.join(fixturesDir, "logs-exit1.txt"), "utf-8"),
    });
    const result = heuristic("nonzero-exit").evaluate(ctx);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe("high");
    expect(result!.title).toContain("code 1");
    expect(result!.evidence.join("\n")).toContain("Connection refused");
    expect(result!.evidence.join("\n")).toContain("boom");
  });

  it("downgrades to medium confidence when no logs were captured", () => {
    const ctx = ctxFor(loadInspect("inspect-exit1.json"), { logTail: "" });
    const result = heuristic("nonzero-exit").evaluate(ctx);
    expect(result!.confidence).toBe("medium");
  });

  it("does not fire for an OOM-killed container (OOM heuristic owns that case)", () => {
    const ctx = ctxFor(loadInspect("inspect-oom.json"));
    expect(heuristic("nonzero-exit").evaluate(ctx)).toBeNull();
  });

  it("does not fire for a healthy, running container", () => {
    const ctx = ctxFor(loadInspect("inspect-healthy.json"));
    expect(heuristic("nonzero-exit").evaluate(ctx)).toBeNull();
  });
});

describe("failing-healthcheck heuristic", () => {
  it("fires with high confidence and quotes FailingStreak and the last health log output", () => {
    const ctx = ctxFor(loadInspect("inspect-healthcheck-fail.json"));
    const result = heuristic("failing-healthcheck").evaluate(ctx);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe("high");
    expect(result!.evidence.join(" ")).toContain("FailingStreak=6");
    expect(result!.evidence.join(" ")).toContain("Connection refused");
  });

  it("does not fire for a healthy container", () => {
    const ctx = ctxFor(loadInspect("inspect-healthy.json"));
    expect(heuristic("failing-healthcheck").evaluate(ctx)).toBeNull();
  });

  it("does not fire for a container with no healthcheck configured", () => {
    const ctx = ctxFor(loadInspect("inspect-exit1.json"));
    expect(heuristic("failing-healthcheck").evaluate(ctx)).toBeNull();
  });
});

describe("recent-deploy-correlation heuristic", () => {
  it("fires with high confidence when the container started minutes before its first failure, and confirms it runs the currently-tagged image", () => {
    const ctx = ctxFor(loadInspect("inspect-recent-deploy.json"), {
      currentImageInspect: loadImage("image-recent-deploy.json"),
    });
    const result = heuristic("recent-deploy-correlation").evaluate(ctx);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe("high");
    expect(result!.evidence.join(" ")).toMatch(/4\.0 minute/);
    expect(result!.evidence.join(" ")).toContain("confirms it started from the deploy that is now live");
  });

  it("notes a digest mismatch when the tag now points at a different image than this container is running", () => {
    const mismatchedImage: ImageInspect = {
      Id: "sha256:different0000000000000000000000000000000000000000000000000000",
      Created: "2026-09-24T13:10:00.000000000Z",
    };
    const ctx = ctxFor(loadInspect("inspect-recent-deploy.json"), { currentImageInspect: mismatchedImage });
    const result = heuristic("recent-deploy-correlation").evaluate(ctx);
    expect(result).not.toBeNull();
    expect(result!.evidence.join(" ")).toContain("DIFFERENT image");
  });

  it("does not fire when the container has been running for days before failing", () => {
    // Same shape as the recent-deploy fixture, but StartedAt pushed back so
    // the gap to first failure is well over the 30-minute cutoff.
    const inspect = loadInspect("inspect-recent-deploy.json");
    inspect.State.StartedAt = "2026-09-20T13:00:00.000000000Z";
    const ctx = ctxFor(inspect);
    expect(heuristic("recent-deploy-correlation").evaluate(ctx)).toBeNull();
  });

  it("does not fire for a healthy container with no failure onset", () => {
    const ctx = ctxFor(loadInspect("inspect-healthy.json"));
    expect(heuristic("recent-deploy-correlation").evaluate(ctx)).toBeNull();
  });
});

describe("recent-deploy-correlation heuristic - clean-exit regression", () => {
  // Caught against a REAL Docker daemon: a container that ran once and
  // exited 0 (a one-shot migration job) was initially mislabeled as a
  // "recent deploy correlated with failure" purely for having stopped
  // shortly after starting. A clean exit is not a failure.
  it("does not fire for a one-shot container that exited cleanly (code 0) shortly after starting", () => {
    const ctx = ctxFor(loadInspect("inspect-clean-oneshot-exit.json"));
    expect(heuristic("recent-deploy-correlation").evaluate(ctx)).toBeNull();
  });

  it("does not treat a clean exit as a non-zero-exit failure either", () => {
    const ctx = ctxFor(loadInspect("inspect-clean-oneshot-exit.json"));
    expect(heuristic("nonzero-exit").evaluate(ctx)).toBeNull();
  });
});

describe("crash-loop heuristic", () => {
  it("fires with high confidence, quoting RestartCount and die-event frequency", () => {
    const ctx = ctxFor(loadInspect("inspect-crashloop.json"), {
      events: loadEvents("events-crashloop.jsonl"),
    });
    const result = heuristic("crash-loop").evaluate(ctx);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe("high");
    expect(result!.evidence.join(" ")).toContain("RestartCount=7");
    expect(result!.evidence.join(" ")).toMatch(/4 "die" events/);
    expect(result!.evidence.join(" ")).toContain("40s apart");
  });

  it("does not fire for a container with zero restarts and no die events", () => {
    const ctx = ctxFor(loadInspect("inspect-healthy.json"));
    expect(heuristic("crash-loop").evaluate(ctx)).toBeNull();
  });

  it("still fires from RestartCount alone when no events were supplied", () => {
    const ctx = ctxFor(loadInspect("inspect-crashloop.json"));
    const result = heuristic("crash-loop").evaluate(ctx);
    expect(result).not.toBeNull();
    expect(result!.evidence.join(" ")).toContain("RestartCount=7");
  });
});
