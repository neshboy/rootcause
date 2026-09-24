/** Small formatting/parsing helpers shared by the heuristics engine and CLI output. */

/** Formats a byte count the way a human reading a memory limit would expect. */
export function humanBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "unlimited";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const precision = value >= 10 ? 0 : 1;
  return `${value.toFixed(precision)}${units[unitIndex]}`;
}

/**
 * Parses a Docker timestamp. Docker reports the "unset" zero time as
 * "0001-01-01T00:00:00Z" (e.g. State.FinishedAt on a container that has
 * never exited) - this is treated as "not set" (null) rather than a real
 * date far in the past.
 */
export function parseDockerTime(value: string | undefined | null): Date | null {
  if (!value) return null;
  if (value.startsWith("0001-01-01T00:00:00")) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/** Returns the last N non-empty lines of a block of text, oldest-first. */
export function lastLines(text: string, n: number): string[] {
  const lines = text.split("\n").map((l) => l.trimEnd());
  const nonEmpty = lines.filter((l) => l.length > 0);
  return nonEmpty.slice(Math.max(0, nonEmpty.length - n));
}

/** Formats a millisecond duration as a short, human-readable relative string. */
export function humanDuration(ms: number): string {
  const absMs = Math.abs(ms);
  const seconds = absMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(1)}m`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

/** Shortens a "sha256:abcdef..." image ID/digest to a short, readable form. */
export function shortDigest(digest: string | undefined | null): string {
  if (!digest) return "unknown";
  const stripped = digest.startsWith("sha256:") ? digest.slice("sha256:".length) : digest;
  return stripped.slice(0, 12);
}
