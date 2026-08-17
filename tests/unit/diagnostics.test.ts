import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  getDiagnosticsSummary,
  readManagedLogs,
  shapeLogLines,
} from "../../packages/core/src/diagnostics.js";

const sandboxes: string[] = [];

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map(async (path) => {
    await rm(path, { recursive: true, force: true });
  }));
});

async function createRun(stdout: Buffer | string, stderr: Buffer | string = "") {
  const projectPath = await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-diagnostics-"));
  sandboxes.push(projectPath);
  await writeFile(resolve(projectPath, "project.godot"), "[application]\nconfig/name=\"Diagnostics\"\n", "utf8");
  const runId = "00000000-0000-4000-8000-000000000007";
  const directory = resolve(projectPath, ".godot", "agent-runtime", "runs");
  await mkdir(directory, { recursive: true });
  const stdoutPath = resolve(directory, `${runId}.stdout.log`);
  const stderrPath = resolve(directory, `${runId}.stderr.log`);
  await writeFile(stdoutPath, stdout);
  await writeFile(stderrPath, stderr);
  await writeFile(resolve(directory, `${runId}.json`), `${JSON.stringify({
    schemaVersion: 1,
    runId,
    token: "not-a-report-field",
    state: "exited",
    projectPath,
    scene: "res://main.tscn",
    processId: null,
    supervisorProcessId: process.pid,
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(1).toISOString(),
    exitCode: 0,
    signal: null,
    command: ["godot", "--path", projectPath],
    stdoutPath,
    stderrPath,
    runtimeBridgePort: null,
    failure: null,
  }, null, 2)}\n`, "utf8");
  return { projectPath, runId, stdoutPath, stderrPath };
}

describe("structured diagnostics", () => {
  it("classifies, filters, and deduplicates shaped lines", () => {
    const shaped = shapeLogLines([
      "ERROR: Missing node",
      "ERROR: Missing node",
      "WARNING: Deprecated call",
      "regular output",
    ], { minimumSeverity: "warning", deduplicate: true, maxLines: 100 });

    expect(shaped.entries).toEqual([
      { severity: "error", message: "ERROR: Missing node", count: 2 },
      { severity: "warning", message: "WARNING: Deprecated call", count: 1 },
    ]);
    expect(shaped.hidden).toMatchObject({ belowSeverity: 1, duplicates: 1 });
  });

  it("advances independent raw byte cursors without claiming stream interleaving", async () => {
    const run = await createRun("first\n", "ERROR: stderr first\n");
    const first = await readManagedLogs({
      projectPath: run.projectPath,
      runId: run.runId,
      stream: "combined",
      maxLines: 20,
    });
    await appendFile(run.stdoutPath, "second\n", "utf8");

    const second = await readManagedLogs({
      projectPath: run.projectPath,
      runId: run.runId,
      cursor: first.nextCursor,
      stream: "combined",
      maxLines: 20,
    });

    expect(first.order).toBe("stdout_then_stderr_blocks");
    expect(first.entries.map(({ stream }) => stream)).toEqual(["stdout", "stderr"]);
    expect(second.entries.map(({ message }) => message)).toEqual(["second"]);
    expect(second.nextCursor.stderrBytes).toBe(first.nextCursor.stderrBytes);
  });

  it("leaves an incomplete UTF-8 code point for the next read", async () => {
    const encoded = Buffer.from("A😀\n", "utf8");
    const run = await createRun(encoded.subarray(0, 3));
    const first = await readManagedLogs({
      projectPath: run.projectPath,
      runId: run.runId,
      stream: "stdout",
      maxBytes: 3,
      maxLines: 20,
      raw: true,
    });
    expect(first.entries.map(({ message }) => message)).toEqual(["A"]);
    expect(first.nextCursor.stdoutBytes).toBe(1);
    expect(JSON.stringify(first)).not.toContain("�");

    await appendFile(run.stdoutPath, encoded.subarray(3));
    const second = await readManagedLogs({
      projectPath: run.projectPath,
      runId: run.runId,
      cursor: first.nextCursor,
      stream: "stdout",
      maxLines: 20,
      raw: true,
    });
    expect(second.entries.map(({ message }) => message)).toEqual(["😀"]);
    expect(second.nextCursor.stdoutBytes).toBe(encoded.length);
    expect(JSON.stringify(second)).not.toContain("�");
  });

  it("rejects an invalid cursor even when its stream is not selected", async () => {
    const run = await createRun("ready\n");
    await expect(readManagedLogs({
      projectPath: run.projectPath,
      runId: run.runId,
      stream: "stdout",
      cursor: { stdoutBytes: 0, stderrBytes: -1 },
    })).rejects.toMatchObject({ payload: { code: "LOG_CURSOR_INVALID" } });
  });

  it("requires incremental log reading whenever observed logs are truncated", async () => {
    const run = await createRun(`${Array.from({ length: 501 }, (_, index) => `line ${index}`).join("\n")}\n`);
    const summary = await getDiagnosticsSummary({
      projectPath: run.projectPath,
      runId: run.runId,
    });
    expect(summary.truncated).toBe(true);
    expect(summary.nextActions).toContainEqual({
      tool: "godot_log_read",
      reason: expect.any(String),
      required: true,
    });
  });

  it("rejects invalid UTF-8 instead of treating it as a trailing partial code point", async () => {
    const run = await createRun(Buffer.from([0xff]));
    await expect(readManagedLogs({
      projectPath: run.projectPath,
      runId: run.runId,
      stream: "stdout",
    })).rejects.toMatchObject({ payload: { code: "LOG_INVALID_UTF8" } });
  });

  it("uses raw mode to preserve line whitespace without changing byte cursors", async () => {
    const run = await createRun("  WARNING: padded  \n");
    const shaped = await readManagedLogs({
      projectPath: run.projectPath,
      runId: run.runId,
      stream: "stdout",
    });
    const raw = await readManagedLogs({
      projectPath: run.projectPath,
      runId: run.runId,
      stream: "stdout",
      raw: true,
    });
    expect(shaped.entries[0]?.message).toBe("WARNING: padded");
    expect(raw.entries[0]?.message).toBe("  WARNING: padded  ");
    expect(raw.nextCursor).toEqual(shaped.nextCursor);
  });

  it("does not advance maxIssues past an unreturned distinct problem", async () => {
    const run = await createRun("ERROR: first issue\nERROR: second issue\n");
    const first = await getDiagnosticsSummary({
      projectPath: run.projectPath,
      runId: run.runId,
      maxIssues: 1,
    });
    const second = await getDiagnosticsSummary({
      projectPath: run.projectPath,
      runId: run.runId,
      cursor: first.nextCursor,
      maxIssues: 1,
    });

    expect(first.issues.map(({ message }) => message)).toEqual(["ERROR: first issue"]);
    expect(first.truncated).toBe(true);
    expect(second.issues.map(({ message }) => message)).toEqual(["ERROR: second issue"]);
  });
});
