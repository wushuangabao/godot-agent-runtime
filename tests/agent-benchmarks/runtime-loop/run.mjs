import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  assertRuntime,
  captureRuntimeScreenshot,
  findRuntimeUi,
  injectRuntimeInputSequence,
  launchProject,
  stopManagedRun,
  toRuntimeError,
  waitForRuntime,
} from "../../../packages/core/dist/index.js";

const startedAt = performance.now();
const projectPath = resolve("examples", "control-ui");
const configPath = resolve("config", "development.local.json");
const steps = [];
let launch = null;

async function step(name, operation) {
  const stepStartedAt = performance.now();
  const result = await operation();
  steps.push({ name, ok: true, durationMs: Math.round(performance.now() - stepStartedAt) });
  return result;
}

try {
  launch = await step("launch", async () =>
    await launchProject({ projectPath, configPath, timeoutMs: 20_000 }),
  );
  const ui = await step("discover-ui", async () =>
    await findRuntimeUi({
      projectPath,
      runId: launch.runId,
      selector: { text: "Start", type: "Button" },
    }),
  );
  const button = ui.elements[0];
  if (!button) throw new Error("Start button was not discovered.");

  const screenshot = await step("capture-before", async () =>
    await captureRuntimeScreenshot({ projectPath, runId: launch.runId }),
  );
  if (!existsSync(screenshot.path)) throw new Error("Screenshot evidence was not written.");

  await step("click-start", async () =>
    await injectRuntimeInputSequence({
      projectPath,
      runId: launch.runId,
      steps: [{ kind: "click", path: button.path }],
    }),
  );
  const started = await step("wait-started", async () =>
    await waitForRuntime({
      projectPath,
      runId: launch.runId,
      kind: "property",
      nodePath: "/root/Main",
      property: "meta:started",
      expected: true,
      waitTimeoutMs: 1_000,
    }),
  );
  const label = await step("assert-label", async () =>
    await assertRuntime({
      projectPath,
      runId: launch.runId,
      kind: "property",
      nodePath: "/root/Main/StatusLabel",
      property: "text",
      expected: "Started",
    }),
  );
  if (!started.satisfied || !label.passed) throw new Error("Structured runtime verification failed.");

  const afterScreenshot = await step("capture-after", async () =>
    await captureRuntimeScreenshot({ projectPath, runId: launch.runId }),
  );

  const stopped = await step("stop", async () =>
    await stopManagedRun({ projectPath, runId: launch.runId }),
  );
  launch = null;
  process.stdout.write(`${JSON.stringify({
    ok: true,
    task: "runtime-control-ui-closed-loop",
    toolCalls: 8,
    durationMs: Math.round(performance.now() - startedAt),
    evidence: {
      beforeScreenshot: { path: screenshot.path, sha256: screenshot.sha256 },
      afterScreenshot: { path: afterScreenshot.path, sha256: afterScreenshot.sha256 },
      clickedPath: button.path,
      assertions: [started, label],
      finalState: stopped.state,
    },
    steps,
  }, null, 2)}\n`);
} catch (error) {
  if (launch !== null) {
    try {
      await stopManagedRun({ projectPath, runId: launch.runId });
    } catch {
      // Preserve the primary benchmark failure.
    }
  }
  process.stdout.write(`${JSON.stringify({
    ok: false,
    task: "runtime-control-ui-closed-loop",
    durationMs: Math.round(performance.now() - startedAt),
    error: toRuntimeError(error),
    steps,
  }, null, 2)}\n`);
  process.exitCode = 1;
}
