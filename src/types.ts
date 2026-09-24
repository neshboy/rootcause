/**
 * Types mirroring the REAL, documented JSON shape of:
 *   - `docker inspect <container>` (single element of the array Docker returns)
 *   - `docker events --format '{{json .}}'`
 *   - `docker image inspect <image>` (single element of the array Docker returns)
 *
 * Field names/casing match actual Docker CLI output (captured against a real
 * local Docker daemon, Docker Engine 29.x, during development of this tool).
 * Only the fields RootCause's heuristics actually read are declared - the
 * real `docker inspect` output has many more fields we don't need.
 */

export interface HealthLogEntry {
  Start: string;
  End: string;
  ExitCode: number;
  Output: string;
}

export interface ContainerHealth {
  Status: "starting" | "healthy" | "unhealthy" | string;
  FailingStreak: number;
  Log: HealthLogEntry[];
}

export interface ContainerState {
  Status: string;
  Running: boolean;
  Paused: boolean;
  Restarting: boolean;
  OOMKilled: boolean;
  Dead: boolean;
  Pid: number;
  ExitCode: number;
  Error: string;
  StartedAt: string;
  FinishedAt: string;
  Health?: ContainerHealth;
}

export interface ContainerHostConfig {
  Memory: number;
  RestartPolicy?: {
    Name: string;
    MaximumRetryCount: number;
  };
}

export interface ContainerConfig {
  Image: string;
  Healthcheck?: {
    Test?: string[];
  };
}

/** The shape RootCause cares about from `docker inspect <container>`. */
export interface ContainerInspect {
  Id: string;
  Created: string;
  Name: string;
  Image: string; // sha256:... - the image ID the container was created from
  RestartCount: number;
  State: ContainerState;
  HostConfig: ContainerHostConfig;
  Config: ContainerConfig;
}

/** The shape RootCause cares about from `docker image inspect <image>`. */
export interface ImageInspect {
  Id: string; // sha256:... - the CURRENT image ID behind a tag, right now
  Created: string;
  RepoTags?: string[];
  RepoDigests?: string[];
}

/** The shape RootCause cares about from `docker events --format '{{json .}}'`. */
export interface DockerEvent {
  Type: string; // "container", "image", "network", ...
  Action: string; // "start", "die", "oom", "health_status: unhealthy", ...
  Actor: {
    ID: string;
    Attributes: Record<string, string>;
  };
  scope?: string;
  time: number; // unix seconds
  timeNano?: number;
}
