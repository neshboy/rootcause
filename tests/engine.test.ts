import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { diagnose } from "../src/engine.js";
import type { DiagnosisContext } from "../src/heuristics.js";
import type { ContainerInspect, DockerEvent } from "../src/types.js";

const fixturesDir = path.join(__dirname, "fixtures");

function loadInspect(name: string): ContainerInspect {
  return (JSON.parse(readFileSync(path.join(fixturesDir, name), "utf-8")) as ContainerInspect[])[0];
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

describe("diagnose()", () => {
  it("reports a healthy container as healthy with zero hypotheses", () => {
    const result = diagnose(ctxFor(loadInspect("inspect-healthy.json")));
    expect(result.status).toBe("healthy");
    expect(result.hypotheses).toHaveLength(0);
  });

  it("ranks the OOM hypothesis first, and only that one, for a clean OOM-kill fixture", () => {
    const result = diagnose(ctxFor(loadInspect("inspect-oom.json")));
    expect(result.status).toBe("issues-found");
    expect(result.hypotheses[0].id).toBe("oom-killed");
    expect(result.hypotheses[0].confidence).toBe("high");
  });

  it("surfaces the failing-healthcheck hypothesis for the healthcheck fixture", () => {
    const result = diagnose(ctxFor(loadInspect("inspect-healthcheck-fail.json")));
    expect(result.status).toBe("issues-found");
    expect(result.hypotheses.map((h) => h.id)).toContain("failing-healthcheck");
    expect(result.hypotheses[0].confidence).toBe("high");
  });

  it("orders all high-confidence hypotheses before medium-confidence ones", () => {
    const result = diagnose(
      ctxFor(loadInspect("inspect-crashloop.json"), { events: loadEvents("events-crashloop.jsonl") }),
    );
    expect(result.status).toBe("issues-found");
    const ids = result.hypotheses.map((h) => h.id);
    expect(ids).toContain("crash-loop");
    expect(ids).toContain("nonzero-exit");
    const confidences = result.hypotheses.map((h) => h.confidence);
    const firstMediumIndex = confidences.indexOf("medium");
    const lastHighIndex = confidences.lastIndexOf("high");
    if (firstMediumIndex !== -1 && lastHighIndex !== -1) {
      expect(lastHighIndex).toBeLessThan(firstMediumIndex);
    }
  });

  it("is inconclusive (not healthy, no hypothesis) for a container with no known failure pattern", () => {
    const inspect = loadInspect("inspect-healthy.json");
    // Running, but not "ready" by any heuristic's standard and not clean-healthy either:
    // paused mid-debug, no health probe configured, no exit/restart signal.
    delete (inspect.State as { Health?: unknown }).Health;
    inspect.State.Restarting = true;
    const result = diagnose(ctxFor(inspect));
    expect(result.status).toBe("inconclusive");
    expect(result.rawSignals.length).toBeGreaterThan(0);
  });

  it("treats a one-shot container that exited cleanly (code 0) as healthy, not a failure", () => {
    // Regression: caught against a real Docker daemon during manual
    // verification - a clean exit was initially mislabeled as a "recent
    // deploy correlated with failure" hypothesis. See heuristics.test.ts
    // for the heuristic-level regression test.
    const result = diagnose(ctxFor(loadInspect("inspect-clean-oneshot-exit.json")));
    expect(result.status).toBe("healthy");
    expect(result.hypotheses).toHaveLength(0);
  });

  it("always includes real raw signals (status/restart count) regardless of outcome", () => {
    const result = diagnose(ctxFor(loadInspect("inspect-oom.json")));
    expect(result.rawSignals.join(" ")).toContain("RestartCount=1");
  });
});
