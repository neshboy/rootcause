import type { DiagnosisContext } from "./heuristics.js";
import {
  fetchContainerEvents,
  fetchLogTail,
  inspectContainer,
  inspectImage,
} from "./docker.js";

/**
 * Assembles a real DiagnosisContext for one container by shelling out to
 * `docker inspect`, `docker image inspect`, `docker events`, and
 * `docker logs`. This is the only place in RootCause that calls the real
 * Docker functions for a single-container diagnosis - the heuristics engine
 * itself never touches the network/CLI, which keeps it hermetically
 * unit-testable (see tests/heuristics.test.ts).
 *
 * @param idOrName container name or ID to diagnose
 * @param now injectable clock, defaults to the real current time
 * @param eventsWindowMinutes how far back to query `docker events`
 */
export async function collectDiagnosisContext(
  idOrName: string,
  now: Date = new Date(),
  eventsWindowMinutes = 60,
): Promise<DiagnosisContext> {
  const inspect = await inspectContainer(idOrName);

  const sinceIso = new Date(now.getTime() - eventsWindowMinutes * 60_000).toISOString();
  const untilIso = now.toISOString();

  const [currentImageInspect, events, logTail] = await Promise.all([
    inspectImage(inspect.Config.Image),
    fetchContainerEvents(inspect.Id, sinceIso, untilIso).catch(() => []),
    fetchLogTail(idOrName, 80),
  ]);

  return {
    containerName: inspect.Name.replace(/^\//, ""),
    inspect,
    currentImageInspect,
    events,
    logTail,
    now,
  };
}
