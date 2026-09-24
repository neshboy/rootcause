import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ContainerInspect, DockerEvent, ImageInspect } from "./types.js";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 16 * 1024 * 1024; // 16MB - generous for verbose logs/inspect output

/** Raised when the `docker` CLI is missing, or a command against a real daemon fails. */
export class DockerError extends Error {}

function runDocker(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("docker", args, { maxBuffer: MAX_BUFFER }).catch((err: unknown) => {
    const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    if (e.code === "ENOENT") {
      throw new DockerError("docker was not found on PATH.");
    }
    const stderr = (e.stderr ?? e.message ?? "").toString().trim();
    throw new DockerError(`docker ${args[0]} failed: ${stderr}`);
  });
}

/** Checks whether the Docker CLI can talk to a real daemon (`docker info`). */
export async function isDockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["info", "--format", "{{.ServerVersion}}"], {
      maxBuffer: MAX_BUFFER,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs real `docker inspect <idOrName>` and returns the parsed first (and
 * only, for a single container/image argument) element of the JSON array
 * Docker always returns.
 */
export async function inspectContainer(idOrName: string): Promise<ContainerInspect> {
  const { stdout } = await runDocker(["inspect", idOrName]);
  const parsed = JSON.parse(stdout) as ContainerInspect[];
  if (!parsed[0]) {
    throw new DockerError(`docker inspect returned no data for "${idOrName}"`);
  }
  return parsed[0];
}

/**
 * Runs real `docker image inspect <image>`. Returns null (rather than
 * throwing) if the image is gone/untagged locally - that is itself a
 * meaningful, honestly-reported signal (image was removed/replaced), not a
 * tool failure.
 */
export async function inspectImage(image: string): Promise<ImageInspect | null> {
  try {
    const { stdout } = await runDocker(["image", "inspect", image]);
    const parsed = JSON.parse(stdout) as ImageInspect[];
    return parsed[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Runs real `docker events --since <since> --until <until> --format '{{json .}}'`
 * scoped to a specific container via `--filter container=<idOrName>`, and
 * returns the parsed events in chronological order. Docker's historical
 * `events` query (with both --since and --until given) returns a finite
 * batch and exits, rather than streaming forever.
 */
export async function fetchContainerEvents(
  idOrName: string,
  sinceIso: string,
  untilIso: string,
): Promise<DockerEvent[]> {
  const { stdout } = await runDocker([
    "events",
    "--since",
    sinceIso,
    "--until",
    untilIso,
    "--filter",
    `container=${idOrName}`,
    "--format",
    "{{json .}}",
  ]);
  return parseEventLines(stdout);
}

/**
 * Runs real `docker events --since <since> --until <until> --format '{{json .}}'`
 * across the whole daemon (no container filter) - used by `rootcause scan`
 * to correlate events across multiple containers in one shot.
 */
export async function fetchAllEvents(sinceIso: string, untilIso: string): Promise<DockerEvent[]> {
  const { stdout } = await runDocker([
    "events",
    "--since",
    sinceIso,
    "--until",
    untilIso,
    "--format",
    "{{json .}}",
  ]);
  return parseEventLines(stdout);
}

function parseEventLines(stdout: string): DockerEvent[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as DockerEvent);
}

/** Runs real `docker logs --tail <n> <idOrName>` and returns the combined stdout+stderr tail. */
export async function fetchLogTail(idOrName: string, tailLines = 80): Promise<string> {
  try {
    const { stdout, stderr } = await runDocker(["logs", "--tail", String(tailLines), idOrName]);
    return [stdout, stderr].filter(Boolean).join("");
  } catch (err) {
    if (err instanceof DockerError) return "";
    throw err;
  }
}

/**
 * Runs real `docker ps -a --format '{{json .}}'` and returns the raw
 * name/id list of every running or recently-exited container - the
 * candidate set for `rootcause scan`.
 */
export async function listAllContainerNames(): Promise<string[]> {
  const { stdout } = await runDocker(["ps", "-a", "--format", "{{.Names}}"]);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
