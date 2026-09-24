import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";

const fixture = (name: string) => path.join(__dirname, "fixtures", name);

describe("rootcause CLI - help/version/unknown command", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("prints help and exits 0 with no arguments", async () => {
    const code = await main([]);
    expect(code).toBe(0);
    expect(logSpy.mock.calls.join("\n")).toContain("USAGE");
  });

  it("prints the version for --version", async () => {
    const code = await main(["--version"]);
    expect(code).toBe(0);
    expect(logSpy.mock.calls.join("\n")).toMatch(/\d+\.\d+\.\d+/);
  });

  it("exits 1 with a helpful message for an unknown command", async () => {
    const code = await main(["bogus"]);
    expect(code).toBe(1);
    expect(errorSpy.mock.calls.join("\n")).toContain('unknown command "bogus"');
  });
});

describe("rootcause diagnose --from-file (offline mode - no Docker required)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("diagnoses a real captured OOM-kill inspect fixture and prints the specific hypothesis", async () => {
    const code = await main(["diagnose", "--from-file", fixture("inspect-oom.json")]);
    expect(code).toBe(0);
    const out = logSpy.mock.calls.join("\n");
    expect(out).toContain("oom-victim");
    expect(out).toContain("OOMKilled=true");
  });

  it("diagnoses a non-zero exit fixture together with its captured logs", async () => {
    const code = await main([
      "diagnose",
      "--from-file",
      fixture("inspect-exit1.json"),
      "--logs",
      fixture("logs-exit1.txt"),
    ]);
    expect(code).toBe(0);
    const out = logSpy.mock.calls.join("\n");
    expect(out).toContain("exit-one");
    expect(out).toContain("Connection refused");
  });

  it("diagnoses a crash-loop fixture together with its captured events", async () => {
    const code = await main([
      "diagnose",
      "--from-file",
      fixture("inspect-crashloop.json"),
      "--events",
      fixture("events-crashloop.jsonl"),
    ]);
    expect(code).toBe(0);
    const out = logSpy.mock.calls.join("\n");
    expect(out).toContain("flaky-worker");
    expect(out).toContain("Crash loop");
  });

  it("prints the honest healthy status for a fixture with no failure signals", async () => {
    const code = await main(["diagnose", "--from-file", fixture("inspect-healthy.json")]);
    expect(code).toBe(0);
    expect(logSpy.mock.calls.join("\n")).toContain("healthy - no failure signals detected");
  });

  it("exits 1 with a clear message when the input file does not exist", async () => {
    const code = await main(["diagnose", "--from-file", "nope-inspect.json"]);
    expect(code).toBe(1);
    expect(errorSpy.mock.calls.join("\n")).toContain("failed to read/parse input files");
  });

  it("exits 1 when diagnose is called with no container and no --from-file", async () => {
    const code = await main(["diagnose"]);
    expect(code).toBe(1);
    expect(errorSpy.mock.calls.join("\n")).toContain("requires a container name/ID");
  });
});

describe("built CLI binary (dist/cli.js) end-to-end smoke test", () => {
  it("runs as a real executable script and prints a report for --from-file input", () => {
    const distPath = path.join(__dirname, "..", "dist", "cli.js");
    const output = execFileSync(
      process.execPath,
      [distPath, "diagnose", "--from-file", fixture("inspect-healthcheck-fail.json")],
      { encoding: "utf-8" },
    );
    expect(output).toContain("unhealthy-web");
    expect(output).toContain("Failing HEALTHCHECK");
  });
});
