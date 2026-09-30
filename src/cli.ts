#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { collectDiagnosisContext } from "./collector.js";
import { fetchAllEvents, isDockerAvailable, listAllContainerNames } from "./docker.js";
import { diagnose } from "./engine.js";
import { formatDiagnosis, formatScanReport } from "./formatter.js";
import type { DiagnosisContext } from "./heuristics.js";
import type { ContainerInspect, DockerEvent, ImageInspect } from "./types.js";

const VERSION = "0.1.0";

const HELP = `rootcause - fast root-cause hypotheses for a broken Docker container

USAGE:
  rootcause diagnose <container-name-or-id>
      Diagnose a single real container: shells out to docker inspect,
      docker events, docker image inspect, and docker logs, then prints a
      ranked list of root-cause hypotheses with quoted evidence.

  rootcause diagnose --from-file <inspect.json> [options]
      Diagnose from previously captured docker output - no daemon required.
      <inspect.json>          output of: docker inspect <container>
      --image <image.json>    output of: docker image inspect <image>
      --events <events.json>  output of: docker events --format '{{json .}}' (one JSON object per line)
      --logs <logs.txt>       output of: docker logs --tail N <container>

  rootcause scan
      Check every running and recently-exited container and print a ranked
      one-line summary for each, most actionable first.

OPTIONS:
  -h, --help      Show this help
  -v, --version   Show the version

EXAMPLES:
  rootcause diagnose my-flaky-api
  rootcause diagnose --from-file inspect.json --logs logs.txt
  rootcause scan
`;

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function readEventsFile(path: string | undefined): DockerEvent[] {
  if (!path) return [];
  const raw = readFileSync(path, "utf-8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as DockerEvent);
}

interface DiagnoseArgs {
  mode: "live" | "file";
  target?: string;
  inspectFile?: string;
  imageFile?: string;
  eventsFile?: string;
  logsFile?: string;
}

function parseDiagnoseArgs(argv: string[]): DiagnoseArgs | { error: string } {
  const args: DiagnoseArgs = { mode: "live" };
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--from-file":
        args.mode = "file";
        args.inspectFile = argv[++i];
        if (!args.inspectFile) return { error: "--from-file requires a path to a docker inspect JSON file" };
        break;
      case "--image":
        args.imageFile = argv[++i];
        if (!args.imageFile) return { error: "--image requires a path to a docker image inspect JSON file" };
        break;
      case "--events":
        args.eventsFile = argv[++i];
        if (!args.eventsFile) return { error: "--events requires a path to a docker events JSON-lines file" };
        break;
      case "--logs":
        args.logsFile = argv[++i];
        if (!args.logsFile) return { error: "--logs requires a path to a docker logs text file" };
        break;
      default:
        positionals.push(arg);
    }
  }

  if (args.mode === "file") return args;

  if (positionals.length === 0) {
    return { error: "diagnose requires a container name/ID, or --from-file <inspect.json>" };
  }
  args.target = positionals[0];
  return args;
}

async function runDiagnose(argv: string[]): Promise<number> {
  const args = parseDiagnoseArgs(argv);
  if ("error" in args) {
    console.error(`rootcause: ${args.error}`);
    console.error('Run "rootcause --help" for usage.');
    return 1;
  }

  let ctx: DiagnosisContext;

  if (args.mode === "file") {
    try {
      const inspect = readJsonFile<ContainerInspect[] | ContainerInspect>(args.inspectFile!);
      const inspectObj = Array.isArray(inspect) ? inspect[0] : inspect;
      if (!inspectObj) {
        console.error(`rootcause: ${args.inspectFile} contains no inspect data`);
        return 1;
      }
      const imageRaw = args.imageFile
        ? readJsonFile<ImageInspect[] | ImageInspect>(args.imageFile)
        : null;
      const currentImageInspect = imageRaw ? (Array.isArray(imageRaw) ? imageRaw[0] ?? null : imageRaw) : null;
      const events = readEventsFile(args.eventsFile);
      const logTail = args.logsFile ? readFileSync(args.logsFile, "utf-8") : "";

      ctx = {
        containerName: inspectObj.Name.replace(/^\//, ""),
        inspect: inspectObj,
        currentImageInspect,
        events,
        logTail,
        now: new Date(),
      };
    } catch (err) {
      console.error(`rootcause: failed to read/parse input files: ${(err as Error).message}`);
      return 1;
    }
  } else {
    const available = await isDockerAvailable();
    if (!available) {
      console.error("rootcause: could not reach the Docker daemon. Is Docker running and on your PATH?");
      console.error("Use --from-file <inspect.json> to analyze captured docker output instead.");
      return 1;
    }
    try {
      ctx = await collectDiagnosisContext(args.target!);
    } catch (err) {
      console.error(`rootcause: ${(err as Error).message}`);
      return 1;
    }
  }

  try {
    console.log(formatDiagnosis(diagnose(ctx)));
  } catch (err) {
    console.error(`rootcause: ${(err as Error).message}`);
    return 1;
  }
  return 0;
}

async function runScan(): Promise<number> {
  const available = await isDockerAvailable();
  if (!available) {
    console.error("rootcause: could not reach the Docker daemon. Is Docker running and on your PATH?");
    return 1;
  }

  const names = await listAllContainerNames();
  if (names.length === 0) {
    console.log("rootcause scan - no containers found (running or exited).");
    return 0;
  }

  const eventsWindowMinutes = 60;
  const now = new Date();
  const sinceIso = new Date(now.getTime() - eventsWindowMinutes * 60_000).toISOString();
  const untilIso = now.toISOString();
  // One daemon-wide `docker events` call, grouped by container inside
  // collectDiagnosisContext, instead of N per-container subprocesses.
  const allEvents = await fetchAllEvents(sinceIso, untilIso).catch(() => []);

  const diagnoses = await Promise.all(
    names.map(async (name) => {
      try {
        const ctx = await collectDiagnosisContext(name, now, eventsWindowMinutes, allEvents);
        return diagnose(ctx);
      } catch (err) {
        return {
          containerName: name,
          status: "inconclusive" as const,
          hypotheses: [],
          rawSignals: [`Failed to inspect this container: ${(err as Error).message}`],
        };
      }
    }),
  );

  console.log(formatScanReport(diagnoses));
  return 0;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case "diagnose":
      return runDiagnose(rest);
    case "scan":
      return runScan();
    case undefined:
    case "-h":
    case "--help":
    case "help":
      console.log(HELP);
      return 0;
    case "-v":
    case "--version":
    case "version":
      console.log(VERSION);
      return 0;
    default:
      console.error(`rootcause: unknown command "${command}"`);
      console.error('Run "rootcause --help" for usage.');
      return 1;
  }
}

const isMainModule = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`rootcause: unexpected error: ${(err as Error).message}`);
      process.exitCode = 1;
    },
  );
}
