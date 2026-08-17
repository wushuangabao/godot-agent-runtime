import { appendFile, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  getManagedRunStatus,
  launchManagedProcess,
  stopManagedRun,
} from "../../packages/core/src/managed-run.js";
import {
  getDiagnosticsSummary,
  readManagedLogs,
} from "../../packages/core/src/diagnostics.js";
import { RuntimeFailure } from "../../packages/core/src/errors.js";
import {
  findLoopbackPort,
  sendBridgeCommand,
  waitForRuntimeBridge,
} from "../../packages/core/src/runtime.js";

describe("managed run lifecycle", () => {
  it("preserves RUN_NOT_FOUND when a project path is missing or was moved", async () => {
    const sandbox = await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-run-missing-"));
    const missingPath = resolve(sandbox, "never-existed");
    const movedFrom = resolve(sandbox, "moved-from");
    const movedTo = resolve(sandbox, "moved-to");
    const runId = "00000000-0000-4000-8000-000000000000";
    try {
      await mkdir(movedFrom);
      await rename(movedFrom, movedTo);

      for (const projectPath of [missingPath, movedFrom]) {
        try {
          await getManagedRunStatus({ projectPath, runId });
          expect.unreachable("a missing managed-run project path must fail");
        } catch (error) {
          expect(error).toBeInstanceOf(RuntimeFailure);
          expect((error as RuntimeFailure).payload).toMatchObject({
            code: "RUN_NOT_FOUND",
            stage: "discovery",
            details: {
              runId,
              projectPath,
              metadataPath: resolve(
                projectPath,
                ".godot",
                "agent-runtime",
                "runs",
                `${runId}.json`,
              ),
              cause: expect.any(String),
            },
            recovery: ["Use a runId returned for the same project by godot_scene_launch."],
          });
        }
      }
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("uses one canonical project authority across real and alias paths", async () => {
    const projectPath = resolve("tests", "fixtures", "managed-process");
    const canonicalProjectPath = await realpath(projectPath);
    const sandbox = await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-run-alias-"));
    const alias = resolve(sandbox, "project-alias");
    const childScript = resolve(projectPath, "child.mjs");
    const runIds: string[] = [];

    try {
      await symlink(projectPath, alias, process.platform === "win32" ? "junction" : "dir");

      const aliasLaunch = await launchManagedProcess({
        projectPath: alias,
        executable: process.execPath,
        args: [childScript],
        env: { ...process.env },
        scene: null,
      });
      runIds.push(aliasLaunch.runId);
      expect(aliasLaunch.projectPath).toBe(canonicalProjectPath);
      expect((await getManagedRunStatus({
        projectPath: canonicalProjectPath,
        runId: aliasLaunch.runId,
      })).projectPath).toBe(canonicalProjectPath);
      expect((await getManagedRunStatus({
        projectPath: alias,
        runId: aliasLaunch.runId,
      })).projectPath).toBe(canonicalProjectPath);
      await stopManagedRun({ projectPath: alias, runId: aliasLaunch.runId });

      const legacyMetadataPath = resolve(
        canonicalProjectPath,
        ".godot",
        "agent-runtime",
        "runs",
        `${aliasLaunch.runId}.json`,
      );
      const legacyMetadata = JSON.parse(
        await readFile(legacyMetadataPath, "utf8"),
      ) as Record<string, unknown>;
      await writeFile(
        legacyMetadataPath,
        `${JSON.stringify({ ...legacyMetadata, projectPath: alias }, null, 2)}\n`,
        "utf8",
      );
      expect((await getManagedRunStatus({
        projectPath: canonicalProjectPath,
        runId: aliasLaunch.runId,
      })).projectPath).toBe(canonicalProjectPath);
      expect((await getManagedRunStatus({
        projectPath: alias,
        runId: aliasLaunch.runId,
      })).projectPath).toBe(canonicalProjectPath);

      const realLaunch = await launchManagedProcess({
        projectPath: canonicalProjectPath,
        executable: process.execPath,
        args: [childScript],
        env: { ...process.env },
        scene: null,
      });
      runIds.push(realLaunch.runId);
      expect(realLaunch.projectPath).toBe(canonicalProjectPath);
      expect((await getManagedRunStatus({
        projectPath: alias,
        runId: realLaunch.runId,
      })).projectPath).toBe(canonicalProjectPath);
      expect((await getManagedRunStatus({
        projectPath: canonicalProjectPath,
        runId: realLaunch.runId,
      })).projectPath).toBe(canonicalProjectPath);
      await stopManagedRun({ projectPath: canonicalProjectPath, runId: realLaunch.runId });
    } finally {
      for (const runId of runIds.reverse()) {
        try {
          await stopManagedRun({ projectPath: canonicalProjectPath, runId });
        } catch {
          // Preserve the assertion failure; cleanup is best-effort.
        }
      }
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("launches, observes, and idempotently stops a persistent process", async () => {
    const projectPath = resolve("tests", "fixtures", "managed-process");
    const childScript = resolve(projectPath, "child.mjs");
    const launch = await launchManagedProcess({
      projectPath,
      executable: process.execPath,
      args: [childScript],
      env: { ...process.env },
      scene: null,
    });

    expect(launch.state).toBe("running");
    expect(launch.processId).toBeGreaterThan(0);

    let status = await getManagedRunStatus({ projectPath, runId: launch.runId });
    for (let attempt = 0; attempt < 20 && !status.stdout.includes("READY"); attempt += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      status = await getManagedRunStatus({ projectPath, runId: launch.runId });
    }
    expect(status.state).toBe("running");
    expect(status.stdout).toContain("MANAGED_PROCESS_READY");

    const stopped = await stopManagedRun({
      projectPath,
      runId: launch.runId,
      timeoutMs: 10_000,
    });
    expect(stopped.state).toBe("stopped");

    const stoppedAgain = await stopManagedRun({
      projectPath,
      runId: launch.runId,
    });
    expect(stoppedAgain.state).toBe("stopped");
    expect(stoppedAgain.stdout).toContain("MANAGED_PROCESS_READY");
    expect(stoppedAgain.endedAt).not.toBeNull();
  });

  it("reads appended logs incrementally and derives diagnostics only from observed run facts", async () => {
    const projectPath = resolve("tests", "fixtures", "managed-process");
    const childScript = resolve(projectPath, "child.mjs");
    const launch = await launchManagedProcess({
      projectPath,
      executable: process.execPath,
      args: [childScript],
      env: { ...process.env },
      scene: null,
    });
    try {
      let first = await readManagedLogs({ projectPath, runId: launch.runId, maxLines: 100 });
      for (let attempt = 0; attempt < 20 && first.nextCursor.stdoutBytes === 0; attempt += 1) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
        first = await readManagedLogs({ projectPath, runId: launch.runId, maxLines: 100 });
      }
      await appendFile(launch.stderrPath, "SCRIPT ERROR: Parse Error at res://broken.gd\n", "utf8");
      const incremental = await readManagedLogs({
        projectPath,
        runId: launch.runId,
        cursor: first.nextCursor,
        minimumSeverity: "warning",
        maxLines: 100,
      });
      expect(incremental.entries).toEqual([
        expect.objectContaining({
          stream: "stderr",
          severity: "error",
          message: "SCRIPT ERROR: Parse Error at res://broken.gd",
        }),
      ]);

      const summary = await getDiagnosticsSummary({
        projectPath,
        runId: launch.runId,
        cursor: first.nextCursor,
      });
      expect(summary).toMatchObject({
        state: "running",
        counts: { errors: 1, warnings: 0, unique: 1, repeated: 0 },
        nextActions: expect.arrayContaining([
          { tool: "godot_script_check", required: true, reason: expect.any(String) },
          { tool: "godot_run_stop", required: false, reason: expect.any(String) },
        ]),
      });
    } finally {
      await stopManagedRun({ projectPath, runId: launch.runId });
    }
  });

  it("fails fast when a managed runtime bridge process exits", async () => {
    const projectPath = resolve("tests", "fixtures", "managed-process");
    const launch = await launchManagedProcess({
      projectPath,
      executable: process.execPath,
      args: ["-e", "console.error('bridge startup failed'); process.exit(1)"],
      env: { ...process.env },
      scene: null,
      runtimeBridgePort: await findLoopbackPort(),
    });
    const startedAt = Date.now();
    await expect(waitForRuntimeBridge({
      projectPath,
      runId: launch.runId,
      timeoutMs: 5_000,
    })).rejects.toMatchObject({ payload: { code: "RUNTIME_BRIDGE_FAILED" } });
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    await stopManagedRun({ projectPath, runId: launch.runId });
  });

  it("reports whether a bridge connection failed before the request was sent", async () => {
    const projectPath = resolve("tests", "fixtures", "managed-process");
    const launch = await launchManagedProcess({
      projectPath,
      executable: process.execPath,
      args: [resolve(projectPath, "child.mjs")],
      env: { ...process.env },
      scene: null,
      runtimeBridgePort: await findLoopbackPort(),
    });
    try {
      await expect(sendBridgeCommand({
        projectPath,
        runId: launch.runId,
        timeoutMs: 1_000,
      }, "hello")).rejects.toMatchObject({
        payload: {
          code: "RUNTIME_BRIDGE_CONNECTION_FAILED",
          details: { requestSent: false },
        },
      });
      expect((await getManagedRunStatus({ projectPath, runId: launch.runId })).state).toBe("running");
    } finally {
      await stopManagedRun({ projectPath, runId: launch.runId });
    }
  });
});
