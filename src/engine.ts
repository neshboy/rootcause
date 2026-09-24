import { heuristics, type Confidence, type DiagnosisContext, type Hypothesis } from "./heuristics.js";

export type ContainerStatus = "healthy" | "issues-found" | "inconclusive";

export interface Diagnosis {
  containerName: string;
  status: ContainerStatus;
  /** Ranked highest-confidence first; ties keep heuristics' declaration order. */
  hypotheses: Hypothesis[];
  /** Honest raw signal, always available - used verbatim when no heuristic matched. */
  rawSignals: string[];
}

const CONFIDENCE_RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };

function isHealthy(ctx: DiagnosisContext): boolean {
  const s = ctx.inspect.State;
  if (s.Restarting) return false;
  if (s.OOMKilled) return false;
  if (s.Health && s.Health.Status !== "healthy") return false;
  // A container with restarts but no healthcheck configured could still be
  // fine right now (e.g. it was restarted once for an unrelated reason days
  // ago) - we don't call that unhealthy on its own. The crash-loop heuristic
  // handles the "many restarts, still happening" case explicitly.
  if (s.Running) return true;
  // Not running is only "healthy" (i.e. not a failure) if the process
  // exited cleanly - plenty of real containers are one-shot jobs/migrations
  // that are SUPPOSED to run once and exit 0.
  return s.ExitCode === 0;
}

function buildRawSignals(ctx: DiagnosisContext): string[] {
  const s = ctx.inspect.State;
  const signals: string[] = [
    `State.Status=${s.Status}, Running=${s.Running}, Restarting=${s.Restarting}, OOMKilled=${s.OOMKilled}, ExitCode=${s.ExitCode}`,
    `RestartCount=${ctx.inspect.RestartCount}`,
  ];
  if (s.Health) {
    signals.push(`State.Health.Status=${s.Health.Status}, FailingStreak=${s.Health.FailingStreak}`);
  }
  if (ctx.events.length > 0) {
    const recent = ctx.events.slice(-5).map((e) => `${new Date(e.time * 1000).toISOString()} ${e.Action}`);
    signals.push(`Recent events: ${recent.join("; ")}`);
  } else {
    signals.push("(no docker events found for this container in the queried window)");
  }
  return signals;
}

/**
 * Runs every heuristic against a real (or fixture-derived) DiagnosisContext
 * and returns a ranked diagnosis. Heuristics are independent and can all
 * fire at once (e.g. a container can be both crash-looping AND exiting
 * non-zero) - that's intentional, since real incidents often have more
 * than one true supporting signal.
 */
export function diagnose(ctx: DiagnosisContext): Diagnosis {
  const hypotheses = heuristics
    .map((h) => h.evaluate(ctx))
    .filter((h): h is Hypothesis => h !== null)
    .sort((a, b) => CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence]);

  const rawSignals = buildRawSignals(ctx);

  if (hypotheses.length === 0) {
    return {
      containerName: ctx.containerName,
      status: isHealthy(ctx) ? "healthy" : "inconclusive",
      hypotheses,
      rawSignals,
    };
  }

  return {
    containerName: ctx.containerName,
    status: "issues-found",
    hypotheses,
    rawSignals,
  };
}
