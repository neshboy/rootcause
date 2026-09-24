# RootCause

A terminal tool that stitches together **container exit codes**, **orchestrator events**, and **recent deploys** to give you a fast, evidence-backed root-cause hypothesis when something in a Docker-based stack breaks - instead of manually flipping between `docker inspect`, `docker events`, and `docker logs` across half a dozen containers by hand.

## The problem

A container goes into `Restarting` at 3am. You now need to:

1. `docker inspect` it and scroll through 300 lines of JSON looking for `OOMKilled`, `ExitCode`, and `Health`.
2. `docker events --since ... --until ...` to see what actually happened around the time it broke.
3. `docker logs --tail 100` to see if the process said anything useful before it died.
4. Cross-reference all three by hand, in your head, while half asleep.

RootCause does steps 1-3 automatically and does step 4 for you, producing a ranked list of hypotheses with the exact evidence that supports each one - not a black-box guess, but a quote from the real `docker inspect`/`docker events`/`docker logs` output that led to the conclusion.

## Install / quick start

```bash
git clone <this repo>
cd rootcause
npm install
npm run build

# Diagnose one container (live, against your real Docker daemon)
node dist/cli.js diagnose my-flaky-container

# Or install it as a linked binary
npm link
rootcause diagnose my-flaky-container
rootcause scan
```

Requires Node.js >= 18 and a working `docker` CLI on `PATH` for live mode. Offline mode (`--from-file`) needs neither.

### `rootcause diagnose <container-name-or-id>`

Runs real `docker inspect`, `docker image inspect`, `docker events`, and `docker logs` against the container, feeds the results through the heuristics engine, and prints a ranked list of hypotheses:

```
Container: rootcause-manual-oom
Status: issues found (2 hypothesis/hypotheses, ranked by confidence)

1. [HIGH] Out-of-memory kill (OOMKilled)
   Evidence: State.OOMKilled=true, State.ExitCode=137
   Evidence: HostConfig.Memory limit=20MB
   Evidence: State.StartedAt=2026-09-24T10:20:15.242Z, State.FinishedAt=2026-09-24T10:20:15.569Z
   -> Raise the container's memory limit (currently 20MB) or find/fix a memory leak in the application.

2. [HIGH] Recent deploy correlated with failure onset
   Evidence: Container.Created=2026-09-24T10:20:15.073Z, State.StartedAt=2026-09-24T10:20:15.242Z
   Evidence: First failure signal at 2026-09-24T10:20:15.569Z - 0.0 minute(s) after start
   Evidence: This container is running the image currently tagged (image ID fd7dc98638c8 matches, built 2026-05-13T02:21:49Z) - confirms it started from the deploy that is now live.
   -> Check what changed in the image/config/env that (re)started this container just before it failed.
```

### `rootcause diagnose --from-file <inspect.json> [--events <events.json>] [--image <image.json>] [--logs <logs.txt>]`

Same engine, but reads previously captured Docker output from disk instead of shelling out - useful for sharing a diagnosis, or running RootCause somewhere without Docker access:

```bash
docker inspect my-container > inspect.json
docker logs --tail 100 my-container > logs.txt
rootcause diagnose --from-file inspect.json --logs logs.txt
```

### `rootcause scan`

Checks every running and recently-exited container on the daemon and prints a one-line, ranked summary for each - the fastest way to find out which of your 15 Compose services is the one actually broken:

```
RootCause scan - 13 container(s) checked, 3 with issues found

[ISSUES] api-1: [HIGH] Out-of-memory kill (OOMKilled)
         Evidence: State.OOMKilled=true, State.ExitCode=137
[ISSUES] worker-1: [HIGH] Crash loop
         Evidence: RestartCount=9 (docker inspect), State.Status=restarting, State.Restarting=true
[OK] postgres-1: healthy
[OK] redis-1: healthy
```

## The heuristics

RootCause's engine (`src/heuristics.ts`) runs five independent, real-evidence-based heuristics against a container's `docker inspect`/`docker events`/`docker logs` output. All of them can fire at once - a container is often both crash-looping *and* exiting non-zero, and both facts are worth showing. Results are ranked `high` > `medium` > `low` confidence.

| Heuristic | Real signal it reads | Example evidence it quotes |
|---|---|---|
| **OOM kill** | `State.OOMKilled`, `State.ExitCode`, `HostConfig.Memory` | `State.OOMKilled=true, State.ExitCode=137` / `HostConfig.Memory limit=20MB` |
| **Non-zero exit** | `State.ExitCode`, `State.Running`, tail of `docker logs` | `State.ExitCode=1` + the last 5 real log lines |
| **Failing HEALTHCHECK** | `State.Health.Status`, `FailingStreak`, last health-check log entry | `State.Health.Status=unhealthy, FailingStreak=6` + the real probe output |
| **Recent deploy correlated with failure onset** | `State.StartedAt` vs. first failure signal (first unhealthy health-check entry, or `FinishedAt` for a real non-zero exit), plus a real `docker image inspect` comparison of the image ID this container was created from vs. what its tag currently resolves to | `First failure signal ... 4.0 minute(s) after start` |
| **Crash loop** | `RestartCount` from inspect, plus real `docker events --filter container=<id>` `die` events in the queried window, to compute an actual restart frequency | `RestartCount=9` + `9 "die" events ... ~4s apart on average` |

A container with none of these signals and a clean state (`Running`, healthy or no healthcheck, or exited with code `0`) is reported as `healthy`. A container that's genuinely broken but doesn't match any of the five patterns is reported `inconclusive`, with the raw signal printed for a human to take from there - RootCause never fabricates a hypothesis it doesn't have real evidence for.

Note: a one-shot job container that exits `0` (e.g. a migration script) is correctly treated as healthy, not a failure - see "Limitations / lessons from real testing" below for how that distinction was found and fixed.

## Real Docker verification (not mocked)

This was tested against a real local Docker daemon (Docker Engine 29.7.2), not fixtures alone. Three real containers were built and run, each engineered to fail a different real way:

```bash
# 1. Exits immediately with a non-zero code
docker run -d --name rootcause-manual-exit1 alpine:latest sh -c "echo boom; echo 'connection refused'; exit 1"

# 2. OOM-killed for real: writes past its 20MB memory limit into tmpfs (/dev/shm),
#    which is charged to the container's memory cgroup, so the kernel OOM-kills it.
docker run -d --name rootcause-manual-oom --memory=20m busybox sh -c "dd if=/dev/zero of=/dev/shm/fillfile bs=1M count=200"

# 3. A real failing HEALTHCHECK
docker run -d --name rootcause-manual-health --health-cmd="exit 1" --health-interval=2s --health-retries=1 --health-timeout=1s alpine:latest sleep 120

# 4. A real crash loop
docker run -d --name rootcause-manual-crashloop --restart=always alpine sh -c "exit 1"
```

Confirmed via real `docker ps`/`docker inspect` that all four failed as intended (`Exited (137)`, `Exited (1)`, `(unhealthy)`, `RestartCount` climbing), then ran the real built CLI against each:

```
$ node dist/cli.js diagnose rootcause-manual-oom
1. [HIGH] Out-of-memory kill (OOMKilled)
   Evidence: State.OOMKilled=true, State.ExitCode=137
   Evidence: HostConfig.Memory limit=20MB
   ...

$ node dist/cli.js diagnose rootcause-manual-exit1
1. [HIGH] Process exited with code 1
   Evidence: State.ExitCode=1, State.Error="", State.FinishedAt=...
   Evidence: Last 2 log line(s):
                 boom
                 connection refused
   ...

$ node dist/cli.js diagnose rootcause-manual-health
1. [HIGH] Failing HEALTHCHECK
   Evidence: State.Health.Status=unhealthy, FailingStreak=17
   ...

$ node dist/cli.js diagnose rootcause-manual-crashloop
1. [HIGH] Crash loop
   Evidence: RestartCount=9 (docker inspect), State.Status=restarting, State.Restarting=true
   Evidence: 9 "die" events observed in the queried window, ~4s apart on average
   ...
```

RootCause correctly identified all four real failure modes, with real quoted evidence in every case. `rootcause scan` was also run against the full daemon (13 real containers, a mix from other locally-running projects plus the 4 engineered failures above) and correctly separated the healthy ones from the broken ones.

This same OOM-trigger/exit/healthcheck workflow is also encoded as an opt-in automated test - see [Testing](#testing) below.

### Limitations / lessons from real testing

Running against a real daemon (rather than only hand-written fixtures) surfaced a real bug during development: a genuinely healthy one-shot container that ran a migration script and exited `0` was initially flagged as "recent deploy correlated with failure" purely for having stopped shortly after starting. Exiting isn't the same as *failing* to exit correctly. This is fixed in `src/heuristics.ts`'s `failureOnset()` (only a non-zero exit counts as a failure signal) and `src/engine.ts`'s `isHealthy()` (a clean exit is healthy, not inconclusive), with regression tests for both in `tests/heuristics.test.ts` and `tests/engine.test.ts`.

## Testing

```bash
npm test
```

runs the hermetic suite (`vitest run`, `pretest` builds first): heuristics-engine unit tests against real-shaped `docker inspect`/`docker events` JSON fixtures (one fixture per failure mode - OOM kill, non-zero exit, failing healthcheck, recent-deploy correlation, crash loop, plus the clean-exit regression above), engine ranking tests, and CLI integration tests (`--from-file` offline mode plus a built-`dist/cli.js` smoke test). None of this requires Docker to be installed, by design - the Docker-calling code (`src/docker.ts`, `src/collector.ts`) is isolated behind a plain `DiagnosisContext` object that the heuristics engine consumes, so tests build that context directly from fixtures instead of mocking `child_process`.

```bash
npm run test:live
```

runs `tests/docker-live.test.ts` - the real-Docker-dependent suite that builds and tears down the same OOM/exit/healthcheck containers described above and asserts on RootCause's real diagnosis of them. It self-skips (rather than failing) if no Docker daemon is reachable, and is intentionally excluded from the default `npm test`/CI-gating run (see `vitest.config.ts`) so the primary suite stays hermetic. Since GitHub Actions' `ubuntu-latest` runners do ship a real Docker daemon, CI also runs it in a separate job (see `.github/workflows/ci.yml`) - it's a bonus real-Docker regression check, not a substitute for `npm test` passing.

## Limitations (v1 scope)

- **Docker only.** No Kubernetes support - correlating pod/container status across a live k8s cluster is a materially different problem (and a different sibling project's scope). No systemd support either; this version doesn't inspect host-level services.
- **Single-host.** RootCause talks to whatever Docker daemon `docker` on your `PATH` is pointed at - no multi-host/Swarm fan-out.
- **Heuristic, not deterministic.** The five heuristics are pattern-matches against real Docker Engine fields, not a certainty. `inconclusive` results are reported honestly rather than forcing a guess.
- **No deploy history store.** "Recent deploy" is inferred from `StartedAt`/`Created` timestamps and image-ID comparisons available *right now* from `docker inspect`/`docker image inspect` - RootCause does not persist a deploy log, so it can't tell you what the previous image was if it's since been deleted locally.
- **`docker events` window is bounded.** `diagnose`/`scan` query a 60-minute window by default; a crash loop or OOM kill from longer ago will still be caught via `docker inspect`'s `RestartCount`/`OOMKilled` fields, but the finer-grained event-frequency evidence won't be available.

## License

MIT - see [LICENSE](LICENSE).
