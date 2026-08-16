import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  getManagedRunStatus,
  launchManagedProcess,
  stopManagedRun,
} from "../../packages/core/src/managed-run.js";
import {
  findLoopbackPort,
  waitForRuntimeBridge,
} from "../../packages/core/src/runtime.js";

describe("managed run lifecycle", () => {
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
});
