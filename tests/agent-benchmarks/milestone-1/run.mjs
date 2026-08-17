import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  assertRuntime,
  captureRuntimeScreenshot,
  checkProject,
  findRuntimeUi,
  getEditorInfo,
  getEditorNode,
  getEditorSceneTree,
  getProjectIdentity,
  getRuntimeSceneTree,
  injectRuntimeInputSequence,
  inspectProject,
  installGodotAddon,
  launchEditor,
  launchProject,
  saveEditorScene,
  stopManagedRun,
  toRuntimeError,
  updateEditorNode,
  waitForRuntime,
} from "../../../packages/core/dist/index.js";

const task = "milestone-1-editor-runtime-closed-loop";
const startedAt = performance.now();
const sourceProjectPath = resolve("examples", "control-ui");
const configPath = resolve("config", "development.local.json");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const artifactDirectory = resolve("artifacts", "milestone-1", timestamp);
const steps = [];
let projectPath = null;
let editorRun = null;
let runtimeRun = null;

async function step(name, operation) {
  const stepStartedAt = performance.now();
  try {
    const result = await operation();
    steps.push({ name, ok: true, durationMs: Math.round(performance.now() - stepStartedAt) });
    return result;
  } catch (error) {
    steps.push({
      name,
      ok: false,
      durationMs: Math.round(performance.now() - stepStartedAt),
      error: toRuntimeError(error),
    });
    throw error;
  }
}

async function preserveScreenshot(screenshot, filename) {
  if (!existsSync(screenshot.path)) throw new Error(`Screenshot was not written: ${screenshot.path}`);
  const target = resolve(artifactDirectory, filename);
  await copyFile(screenshot.path, target);
  return {
    path: target,
    sourceName: basename(screenshot.path),
    width: screenshot.width,
    height: screenshot.height,
    bytes: screenshot.bytes,
    sha256: screenshot.sha256,
  };
}

async function stopRun(kind, run) {
  if (run === null || projectPath === null) return null;
  return await step(`stop-${kind}`, async () =>
    await stopManagedRun({ projectPath, runId: run.runId, timeoutMs: 15_000 }),
  );
}

await mkdir(artifactDirectory, { recursive: true });

try {
  projectPath = await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-milestone-1-"));
  await cp(sourceProjectPath, projectPath, {
    recursive: true,
    filter: (source) => !source.startsWith(resolve(sourceProjectPath, ".godot")),
  });

  const project = await step("inspect-project", async () => await inspectProject(projectPath));
  const identity = await step("identify-project", async () => await getProjectIdentity(projectPath));
  await step("install-editor-plugin", async () => await installGodotAddon(projectPath));

  editorRun = await step("launch-editor", async () =>
    await launchEditor({ projectPath, configPath, timeoutMs: 30_000 }),
  );
  const editorStatus = await step("read-editor-status", async () =>
    await getEditorInfo({ projectPath, runId: editorRun.runId }),
  );
  if (editorStatus.scene === null || editorStatus.historyVersion === null) {
    throw new Error("Managed editor did not expose an active scene history.");
  }
  const editorTree = await step("read-editor-scene-tree", async () =>
    await getEditorSceneTree({ projectPath, runId: editorRun.runId }),
  );
  if (editorTree.root?.name !== "Main") throw new Error("Edited Main scene was not discovered.");

  const originalButton = await step("read-original-button", async () =>
    await getEditorNode({
      projectPath,
      runId: editorRun.runId,
      nodePath: "/root/Main/StartButton",
      properties: ["text"],
    }),
  );
  if (originalButton.node.properties.text !== "Start") {
    throw new Error("Unexpected original StartButton text.");
  }

  const modifiedButton = await step("modify-button-through-editor-plugin", async () =>
    await updateEditorNode({
      projectPath,
      runId: editorRun.runId,
      expectedProjectFingerprint: identity.projectFingerprint,
      expectedScenePath: editorStatus.scene,
      nodePath: "/root/Main/StartButton",
      properties: { text: "Agent Launch" },
    }),
  );
  if (modifiedButton.node?.properties.text !== "Agent Launch") {
    throw new Error("EditorPlugin did not report the modified button text.");
  }

  await step("save-edited-scene", async () =>
    await saveEditorScene({
      projectPath,
      runId: editorRun.runId,
      expectedProjectFingerprint: identity.projectFingerprint,
      expectedScenePath: editorStatus.scene,
      expectedHistoryVersion: modifiedButton.historyVersion,
    }),
  );
  const editorStopped = await stopRun("editor", editorRun);
  editorRun = null;
  if (editorStopped?.state !== "stopped") throw new Error("Managed editor did not stop cleanly.");

  const check = await step("parse-modified-project", async () =>
    await checkProject({ projectPath, configPath, timeoutMs: 30_000 }),
  );
  if (!check.ok) throw new Error("Godot did not parse the modified project.");

  const sceneSource = await readFile(resolve(projectPath, "main.tscn"), "utf8");
  if (!sceneSource.includes('text = "Agent Launch"')) {
    throw new Error("Saved scene does not contain the EditorPlugin modification.");
  }
  const preservedScenePath = resolve(artifactDirectory, "main-after-editor-plugin.tscn");
  await writeFile(preservedScenePath, sceneSource, "utf8");

  runtimeRun = await step("launch-modified-game", async () =>
    await launchProject({ projectPath, configPath, timeoutMs: 20_000 }),
  );
  const runtimeTree = await step("read-runtime-scene-tree", async () =>
    await getRuntimeSceneTree({
      projectPath,
      runId: runtimeRun.runId,
      maxDepth: 16,
      maxNodes: 500,
    }),
  );
  if (runtimeTree.root?.path !== "/root/Main") throw new Error("Running Main scene was not discovered.");

  const beforeScreenshot = await step("capture-runtime-before", async () =>
    await captureRuntimeScreenshot({ projectPath, runId: runtimeRun.runId }),
  );
  const preservedBeforeScreenshot = await preserveScreenshot(beforeScreenshot, "runtime-before-click.png");

  const ui = await step("discover-modified-button", async () =>
    await findRuntimeUi({
      projectPath,
      runId: runtimeRun.runId,
      selector: { text: "Agent Launch", type: "Button", visibleOnly: true },
    }),
  );
  if (ui.count !== 1 || ui.elements.length !== 1) {
    throw new Error(`Expected exactly one modified button, found ${ui.count}.`);
  }
  const button = ui.elements[0];

  const input = await step("click-modified-button", async () =>
    await injectRuntimeInputSequence({
      projectPath,
      runId: runtimeRun.runId,
      steps: [{ kind: "click", path: button.path }],
    }),
  );
  if (!input.delivered) throw new Error("Runtime input was not delivered.");

  const started = await step("wait-for-runtime-state", async () =>
    await waitForRuntime({
      projectPath,
      runId: runtimeRun.runId,
      kind: "property",
      nodePath: "/root/Main",
      property: "meta:started",
      expected: true,
      waitTimeoutMs: 1_000,
    }),
  );
  const label = await step("assert-structured-result", async () =>
    await assertRuntime({
      projectPath,
      runId: runtimeRun.runId,
      kind: "property",
      nodePath: "/root/Main/StatusLabel",
      property: "text",
      expected: "Started",
    }),
  );
  if (!started.satisfied || !label.passed) throw new Error("Structured runtime verification failed.");

  const afterScreenshot = await step("capture-runtime-after", async () =>
    await captureRuntimeScreenshot({ projectPath, runId: runtimeRun.runId }),
  );
  const preservedAfterScreenshot = await preserveScreenshot(afterScreenshot, "runtime-after-click.png");
  if (preservedBeforeScreenshot.sha256 === preservedAfterScreenshot.sha256) {
    throw new Error("Runtime screenshots did not change after the verified interaction.");
  }

  const runtimeStopped = await stopRun("runtime", runtimeRun);
  runtimeRun = null;
  if (runtimeStopped?.state !== "stopped") throw new Error("Managed runtime did not stop cleanly.");

  const report = {
    ok: true,
    task,
    project: project.name,
    toolCalls: steps.length,
    durationMs: Math.round(performance.now() - startedAt),
    artifactDirectory,
    evidence: {
      editorScene: {
        root: editorTree.root?.path,
        originalButtonText: originalButton.node.properties.text,
        modifiedButtonText: modifiedButton.node?.properties.text,
        savedScenePath: preservedScenePath,
        savedSceneSha256: createHash("sha256").update(sceneSource).digest("hex"),
      },
      screenshots: {
        runtimeBefore: preservedBeforeScreenshot,
        runtimeAfter: preservedAfterScreenshot,
      },
      runtimeSceneRoot: runtimeTree.root?.path,
      discoveredButton: button,
      input,
      assertions: [started, label],
      finalStates: { editor: editorStopped.state, runtime: runtimeStopped.state },
    },
    steps,
  };
  const reportPath = resolve(artifactDirectory, "report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`);
} catch (error) {
  const cleanup = {};
  if (runtimeRun !== null) {
    try {
      cleanup.runtime = await stopManagedRun({ projectPath, runId: runtimeRun.runId, timeoutMs: 15_000 });
    } catch (cleanupError) {
      cleanup.runtimeError = toRuntimeError(cleanupError);
    }
  }
  if (editorRun !== null) {
    try {
      cleanup.editor = await stopManagedRun({ projectPath, runId: editorRun.runId, timeoutMs: 15_000 });
    } catch (cleanupError) {
      cleanup.editorError = toRuntimeError(cleanupError);
    }
  }
  const report = {
    ok: false,
    task,
    durationMs: Math.round(performance.now() - startedAt),
    artifactDirectory,
    error: toRuntimeError(error),
    cleanup,
    steps,
  };
  const reportPath = resolve(artifactDirectory, "report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  if (projectPath !== null) await rm(projectPath, { recursive: true, force: true });
}
