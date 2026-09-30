import type { ContainerInspect, DockerEvent, ImageInspect } from "./types.js";
import { humanBytes, lastLines, parseDockerTime, shortDigest } from "./util.js";

/**
 * Everything a heuristic needs to evaluate one container. Built by
 * `collector.ts` from real `docker inspect`/`docker events`/`docker logs`
 * output in live mode, or read from captured JSON/text files in
 * `rootcause diagnose --from-file` offline mode. Either way, heuristics
 * themselves never shell out - they are pure functions of this context,
 * which is what makes them fast and hermetic to unit-test.
 */
export interface DiagnosisContext {
  containerName: string;
  inspect: ContainerInspect;
  /** `docker image inspect` of the image currently behind this container's tag, or null if unavailable/removed. */
  currentImageInspect: ImageInspect | null;
  /** Events for this container within the queried window, chronological (oldest first). */
  events: DockerEvent[];
  /** Raw `docker logs --tail N` output (stdout+stderr combined). */
  logTail: string;
  /** Injectable clock, so "how long ago" computations are deterministic in tests. */
  now: Date;
}

export type Confidence = "high" | "medium" | "low";

export interface Hypothesis {
  id: string;
  title: string;
  confidence: Confidence;
  /** Real, quoted evidence strings pulled directly from inspect/events/logs - never fabricated. */
  evidence: string[];
  recommendation: string;
}

export interface Heuristic {
  id: string;
  description: string;
  evaluate(ctx: DiagnosisContext): Hypothesis | null;
}

/** The earliest sign of trouble we can point to for this container, if any. */
function failureOnset(ctx: DiagnosisContext): Date | null {
  const health = ctx.inspect.State.Health;
  if (health) {
    const unhealthyEntry = health.Log.find((entry) => entry.ExitCode !== 0);
    const t = parseDockerTime(unhealthyEntry?.Start);
    if (t) return t;
  }
  // A clean exit (code 0) is not a failure - plenty of real containers are
  // one-shot jobs/migrations that are SUPPOSED to run once and exit 0.
  // Only a non-zero exit counts as a failure signal here (this was caught
  // against a real Docker daemon: a genuinely healthy one-shot container was
  // otherwise mislabeled as "recently failed" purely for having stopped).
  if (!ctx.inspect.State.Running && ctx.inspect.State.ExitCode !== 0) {
    const finished = parseDockerTime(ctx.inspect.State.FinishedAt);
    if (finished) return finished;
  }
  return null;
}

/**
 * 1. OOM kill - the single most specific and actionable signal Docker
 * exposes: State.OOMKilled is set directly by the kernel/daemon, no
 * inference required.
 */
const oomKilled: Heuristic = {
  id: "oom-killed",
  description: "Container was killed by the kernel OOM killer for exceeding its memory limit.",
  evaluate(ctx) {
    if (!ctx.inspect.State.OOMKilled) return null;
    const memLimit = ctx.inspect.HostConfig.Memory;
    const memLimitStr = memLimit > 0 ? humanBytes(memLimit) : "no explicit limit set (host-wide cgroup limit applies)";
    return {
      id: "oom-killed",
      title: "Out-of-memory kill (OOMKilled)",
      confidence: "high",
      evidence: [
        `State.OOMKilled=true, State.ExitCode=${ctx.inspect.State.ExitCode}`,
        `HostConfig.Memory limit=${memLimitStr}`,
        `State.StartedAt=${ctx.inspect.State.StartedAt}, State.FinishedAt=${ctx.inspect.State.FinishedAt}`,
      ],
      recommendation: `Raise the container's memory limit (currently ${memLimitStr}) or find/fix a memory leak in the application. If the limit is already generous, check for a large batch job or cache that spikes memory use.`,
    };
  },
};

/**
 * 2. Non-zero exit code - the process exited on its own (not via OOM),
 * with logs quoted as supporting evidence when available.
 */
const nonZeroExit: Heuristic = {
  id: "nonzero-exit",
  description: "Container process exited on its own with a non-zero exit code.",
  evaluate(ctx) {
    const state = ctx.inspect.State;
    if (state.Running || state.OOMKilled || state.ExitCode === 0) return null;
    const tail = lastLines(ctx.logTail, 5);
    let signalNote = "";
    if (state.ExitCode === 137) signalNote = " (137 = SIGKILL; if HostConfig.Memory is set and OOMKilled is false, this is more likely an external kill than an in-container OOM)";
    if (state.ExitCode === 143) signalNote = " (143 = SIGTERM; likely a graceful stop/restart request, or the container didn't exit within its stop grace period)";
    return {
      id: "nonzero-exit",
      title: `Process exited with code ${state.ExitCode}${signalNote}`,
      confidence: tail.length > 0 ? "high" : "medium",
      evidence: [
        `State.ExitCode=${state.ExitCode}, State.Error=${JSON.stringify(state.Error)}, State.FinishedAt=${state.FinishedAt}`,
        tail.length > 0
          ? `Last ${tail.length} log line(s):\n${tail.map((l) => `    ${l}`).join("\n")}`
          : "No log output was captured before exit (docker logs returned nothing).",
      ],
      recommendation: `Read the log lines above for the specific error/stack trace behind exit code ${state.ExitCode}. If logs are empty, the process may have crashed before it could flush output - try running the image interactively.`,
    };
  },
};

/**
 * 3. Failing HEALTHCHECK - the container's own configured health probe is
 * reporting unhealthy, independent of whether the main process has exited.
 */
const failingHealthcheck: Heuristic = {
  id: "failing-healthcheck",
  description: "Container is up but its HEALTHCHECK is failing.",
  evaluate(ctx) {
    const health = ctx.inspect.State.Health;
    if (!health || health.Status !== "unhealthy") return null;
    const lastEntry = health.Log[health.Log.length - 1];
    return {
      id: "failing-healthcheck",
      title: "Failing HEALTHCHECK",
      confidence: "high",
      evidence: [
        `State.Health.Status=unhealthy, FailingStreak=${health.FailingStreak}`,
        lastEntry
          ? `Last health check at ${lastEntry.Start}: exit code ${lastEntry.ExitCode}, output: ${JSON.stringify(lastEntry.Output.trim().slice(0, 200))}`
          : "No health check log entries were captured.",
      ],
      recommendation: "Run the HEALTHCHECK command manually inside the container to see the real failure - a process can be listed as \"Up\" while its health probe still fails (wrong port/path, slow startup, or the app is up but not actually ready).",
    };
  },
};

/**
 * 4. Recent (re)deploy correlated with failure onset - the container was
 * (re)created/started shortly before it started failing. This is the
 * "recent deploy" correlation: a container that ran fine for days and then
 * broke is a different problem than one that broke within minutes of being
 * (re)started with a new image.
 */
const recentDeployCorrelation: Heuristic = {
  id: "recent-deploy-correlation",
  description: "Container was (re)started shortly before it began failing - suggests a bad deploy rather than a runtime regression in a long-running process.",
  evaluate(ctx) {
    const startedAt = parseDockerTime(ctx.inspect.State.StartedAt);
    const onset = failureOnset(ctx);
    if (!startedAt || !onset) return null;
    const gapMs = onset.getTime() - startedAt.getTime();
    if (gapMs < 0) return null;
    const gapMinutes = gapMs / 60000;
    if (gapMinutes > 30) return null;

    // Docker resets State.StartedAt to "now" on every restart-policy-driven
    // auto-restart, so a container stuck in a restart loop for weeks would
    // otherwise still show a tiny StartedAt-to-failure gap on every check.
    // Only treat this as an actual (re)deploy when the container itself is
    // fresh: either this is its true first start (RestartCount === 0), or
    // it was only just created (Container.Created is itself close to
    // State.StartedAt) - as opposed to an old container that just happened
    // to restart recently.
    const created = parseDockerTime(ctx.inspect.Created);
    const createdToStartGapMinutes = created ? (startedAt.getTime() - created.getTime()) / 60000 : null;
    const isFreshContainer =
      ctx.inspect.RestartCount === 0 ||
      (createdToStartGapMinutes !== null && createdToStartGapMinutes >= 0 && createdToStartGapMinutes <= 30);
    if (!isFreshContainer) return null;

    const evidence = [
      `Container.Created=${ctx.inspect.Created}, State.StartedAt=${ctx.inspect.State.StartedAt}`,
      `First failure signal at ${onset.toISOString()} - ${gapMinutes.toFixed(1)} minute(s) after start`,
    ];

    if (ctx.currentImageInspect) {
      const runningDigest = ctx.inspect.Image;
      const currentDigest = ctx.currentImageInspect.Id;
      if (runningDigest !== currentDigest) {
        evidence.push(
          `Config.Image tag now resolves to a DIFFERENT image (${shortDigest(currentDigest)}, built ${ctx.currentImageInspect.Created}) than this container was created from (${shortDigest(runningDigest)}) - a newer build exists that this container is not running.`,
        );
      } else {
        evidence.push(
          `This container is running the image currently tagged (image ID ${shortDigest(runningDigest)} matches, built ${ctx.currentImageInspect.Created}) - confirms it started from the deploy that is now live.`,
        );
      }
    }

    return {
      id: "recent-deploy-correlation",
      title: "Recent deploy correlated with failure onset",
      confidence: gapMinutes <= 10 ? "high" : "medium",
      evidence,
      recommendation: "Check what changed in the image, config, or environment variables in the deploy that (re)started this container just before it failed - a rollback to the previous known-good image/tag is the fastest mitigation while investigating.",
    };
  },
};

/**
 * 5. Crash loop - rapid, repeated restarts. RestartCount (from inspect) is
 * the always-available signal; die/start events in the queried window (if
 * supplied) sharpen it into an actual restart frequency.
 */
const crashLoop: Heuristic = {
  id: "crash-loop",
  description: "Container is stuck in a restart loop (repeatedly dying and being restarted).",
  evaluate(ctx) {
    const restartCount = ctx.inspect.RestartCount;
    const dieEvents = ctx.events.filter((e) => e.Type === "container" && e.Action === "die");
    if (restartCount < 3 && dieEvents.length < 3) return null;

    const evidence = [
      `RestartCount=${restartCount} (docker inspect), State.Status=${ctx.inspect.State.Status}, State.Restarting=${ctx.inspect.State.Restarting}`,
    ];
    let frequencyBoost = false;
    if (dieEvents.length >= 2) {
      const first = dieEvents[0].time;
      const last = dieEvents[dieEvents.length - 1].time;
      const spanSeconds = last - first;
      const avgGapSeconds = spanSeconds / (dieEvents.length - 1);
      evidence.push(
        `${dieEvents.length} "die" events observed in the queried window, ~${avgGapSeconds.toFixed(0)}s apart on average`,
      );
      frequencyBoost = avgGapSeconds > 0 && avgGapSeconds < 120;
    }

    const confidence: Confidence = restartCount >= 5 || dieEvents.length >= 5 || frequencyBoost ? "high" : "medium";
    return {
      id: "crash-loop",
      title: "Crash loop",
      confidence,
      evidence,
      recommendation: "A high restart count with a short average interval means the container fails within seconds of every start. Check logs from immediately after a start (not the tail, which may be from a previous attempt) and pair this with the exit-code/OOM/healthcheck hypotheses above for the specific root cause.",
    };
  },
};

/** All heuristics RootCause evaluates, in a fixed, deterministic order. */
export const heuristics: Heuristic[] = [
  oomKilled,
  failingHealthcheck,
  nonZeroExit,
  recentDeployCorrelation,
  crashLoop,
];

export { failureOnset };
