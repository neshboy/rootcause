/** Public library surface, for anyone who wants RootCause's engine without the CLI. */
export { collectDiagnosisContext } from "./collector.js";
export {
  DockerError,
  fetchAllEvents,
  fetchContainerEvents,
  fetchLogTail,
  inspectContainer,
  inspectImage,
  isDockerAvailable,
  listAllContainerNames,
} from "./docker.js";
export { diagnose } from "./engine.js";
export type { ContainerStatus, Diagnosis } from "./engine.js";
export { formatDiagnosis, formatScanLine, formatScanReport } from "./formatter.js";
export { heuristics } from "./heuristics.js";
export type { Confidence, DiagnosisContext, Heuristic, Hypothesis } from "./heuristics.js";
export type { ContainerInspect, DockerEvent, ImageInspect } from "./types.js";
