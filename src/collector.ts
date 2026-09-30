import type { DiagnosisContext } from "./heuristics.js";
import type { DockerEvent } from "./types.js";
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
 * @param preFetchedEvents if supplied (e.g. one daemon-wide
 *   `fetchAllEvents` call shared across many containers by `rootcause
 *   scan`), events for this container are filtered from this list instead
 *   of spawning a fresh `docker events --filter container=<id>` subprocess.
 */
export async function collectDiagnosisContext(
  idOrName: string,
  now: Date = new Date(),
  eventsWindowMinutes = 60,
  preFetchedEvents?: DockerEvent[],
): Promise<DiagnosisContext> {
  const inspect = await inspectContainer(idOrName);

  const sinceIso = new Date(now.getTime() - eventsWindowMinutes * 60_000).toISOString();
  const untilIso = now.toISOString();

  const eventsPromise: Promise<DockerEvent[]> = preFetchedEvents
    ? Promise.resolve(preFetchedEvents.filter((e) => e.Actor.ID === inspect.Id))
    : fetchContainerEvents(inspect.Id, sinceIso, untilIso).catch(() => []);

  const [currentImageInspect, events, logTail] = await Promise.all([
    inspectImage(inspect.Config.Image),
    eventsPromise,
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
