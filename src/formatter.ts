import type { Diagnosis } from "./engine.js";
import type { Confidence } from "./heuristics.js";

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  high: "HIGH",
  medium: "MEDIUM",
  low: "LOW",
};

const STATUS_TAG: Record<Diagnosis["status"], string> = {
  healthy: "OK",
  "issues-found": "ISSUES",
  inconclusive: "INCONCLUSIVE",
};

/** Renders one Diagnosis as a readable terminal report (plain, pipeable text - no TTY libs required). */
export function formatDiagnosis(d: Diagnosis): string {
  const lines: string[] = [];
  lines.push(`Container: ${d.containerName}`);

  if (d.status === "healthy") {
    lines.push("Status: healthy - no failure signals detected.");
    return lines.join("\n");
  }

  if (d.status === "inconclusive") {
    lines.push("Status: inconclusive - no known failure pattern matched. Raw signal for manual review:");
    for (const s of d.rawSignals) lines.push(`  - ${s}`);
    return lines.join("\n");
  }

  lines.push(`Status: issues found (${d.hypotheses.length} hypothesis/hypotheses, ranked by confidence)`);
  lines.push("");
  d.hypotheses.forEach((h, i) => {
    lines.push(`${i + 1}. [${CONFIDENCE_LABEL[h.confidence]}] ${h.title}`);
    for (const e of h.evidence) {
      const evidenceLines = e.split("\n");
      lines.push(`   Evidence: ${evidenceLines[0]}`);
      for (const extra of evidenceLines.slice(1)) lines.push(`             ${extra}`);
    }
    lines.push(`   -> ${h.recommendation}`);
    lines.push("");
  });

  return lines.join("\n").trimEnd();
}

/** Renders a compact `[TAG] name: headline` line, used by `rootcause scan`. */
export function formatScanLine(d: Diagnosis): string {
  const tag = STATUS_TAG[d.status];
  if (d.status === "healthy") return `[${tag}] ${d.containerName}: healthy`;
  if (d.status === "inconclusive") return `[${tag}] ${d.containerName}: no known pattern matched`;
  const top = d.hypotheses[0];
  return `[${tag}] ${d.containerName}: [${CONFIDENCE_LABEL[top.confidence]}] ${top.title}`;
}

const STATUS_SORT_RANK: Record<Diagnosis["status"], number> = {
  "issues-found": 0,
  inconclusive: 1,
  healthy: 2,
};

/**
 * Renders the full `rootcause scan` report: one line per container, most
 * actionable first (issues found > inconclusive > healthy), with the top
 * hypothesis's first evidence line shown inline for issues-found containers.
 */
export function formatScanReport(diagnoses: Diagnosis[]): string {
  const sorted = [...diagnoses].sort((a, b) => STATUS_SORT_RANK[a.status] - STATUS_SORT_RANK[b.status]);
  const issueCount = sorted.filter((d) => d.status === "issues-found").length;

  const lines: string[] = [
    `RootCause scan - ${sorted.length} container(s) checked, ${issueCount} with issues found`,
    "",
  ];

  for (const d of sorted) {
    lines.push(formatScanLine(d));
    if (d.status === "issues-found") {
      const firstEvidence = d.hypotheses[0].evidence[0]?.split("\n")[0];
      if (firstEvidence) lines.push(`         Evidence: ${firstEvidence}`);
    }
  }

  return lines.join("\n");
}
