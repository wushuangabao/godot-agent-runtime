import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  assertRuntime,
  captureEditorScreenshot,
  captureRuntimeScreenshot,
  checkProject,
  getEditorInfo,
  getEditorNode,
  getProjectIdentity,
  getRuntimeSceneTree,
  injectRuntimeInputSequence,
  installGodotAddon,
  launchEditor,
  launchProject,
  observeRuntime,
  projectRuntime3D,
  raycastRuntime3D,
  saveEditorScene,
  setEditorSelection,
  simulateRuntimePhysics,
  stopManagedRun,
  toRuntimeError,
  updateEditorNode,
  waitForRuntime,
} from "../../../packages/core/dist/index.js";

const task = "milestone-3-3d-editor-vision-spatial-query-physics-loop";
const startedAt = performance.now();
const sourceProjectPath = resolve("examples", "physics-3d");
const configPath = resolve("config", "development.local.json");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const artifactDirectory = resolve("artifacts", "milestone-3", timestamp);
const playerPath = "/root/Main/Player";
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
    ...(screenshot.viewport === undefined ? {} : {
      viewport: screenshot.viewport,
      viewportIndex: screenshot.viewportIndex,
      camera: screenshot.camera,
    }),
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
  projectPath = await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-milestone-3-"));
  await cp(sourceProjectPath, projectPath, {
    recursive: true,
    filter: (source) => !source.startsWith(resolve(sourceProjectPath, ".godot")),
  });

  await step("install-editor-plugin", async () => await installGodotAddon(projectPath));
  const identity = await step("identify-project", async () => await getProjectIdentity(projectPath));
  editorRun = await step("launch-editor", async () =>
    await launchEditor({ projectPath, configPath, timeoutMs: 30_000 }),
  );
  const editorStatus = await step("read-editor-status", async () =>
    await getEditorInfo({ projectPath, runId: editorRun.runId }),
  );
  if (editorStatus.scene === null || editorStatus.historyVersion === null) {
    throw new Error("Managed editor did not expose an active scene history.");
  }
  const editorBefore = await step("read-editor-player-transform", async () =>
    await getEditorNode({
      projectPath,
      runId: editorRun.runId,
      nodePath: playerPath,
      properties: ["position"],
    }),
  );
  const editorMutation = await step("edit-node3d-transform", async () =>
    await updateEditorNode({
      projectPath,
      runId: editorRun.runId,
      expectedProjectFingerprint: identity.projectFingerprint,
      expectedScenePath: editorStatus.scene,
      nodePath: playerPath,
      properties: { position: { $type: "Vector3", x: -2.5, y: 0.5, z: 0 } },
    }),
  );
  if (!editorMutation.undoable || !editorMutation.changedProperties.includes("position")) {
    throw new Error("EditorPlugin did not apply an undoable Node3D transform edit.");
  }
  await step("select-editor-player", async () =>
    await setEditorSelection({
      projectPath,
      runId: editorRun.runId,
      paths: [playerPath],
      focus: true,
    }),
  );
  await step("save-3d-scene", async () =>
    await saveEditorScene({
      projectPath,
      runId: editorRun.runId,
      expectedProjectFingerprint: identity.projectFingerprint,
      expectedScenePath: editorStatus.scene,
      expectedHistoryVersion: editorMutation.historyVersion,
    }),
  );
  const editorScreenshot = await step("capture-editor-3d-viewport", async () =>
    await captureEditorScreenshot({
      projectPath,
      runId: editorRun.runId,
      viewport: "3d",
      viewportIndex: 0,
    }),
  );
  if (editorScreenshot.viewport !== "3d" || editorScreenshot.viewportIndex !== 0 || editorScreenshot.camera === null) {
    throw new Error("Editor 3D screenshot did not expose viewport and camera metadata.");
  }
  const preservedEditor = await preserveScreenshot(editorScreenshot, "editor-3d-viewport.png");

  const editorStopped = await stopRun("editor", editorRun);
  editorRun = null;
  if (editorStopped?.state !== "stopped") throw new Error("Managed editor did not stop cleanly.");

  const sceneSource = await readFile(resolve(projectPath, "main.tscn"), "utf8");
  await writeFile(resolve(artifactDirectory, "verified-main.tscn"), sceneSource, "utf8");
  if (!sceneSource.includes("[node name=\"Player\" type=\"CharacterBody3D\"") ||
      !sceneSource.includes(", -2.5, 0.5, 0)")) {
    throw new Error("Saved scene did not contain the edited Node3D transform.");
  }
  const check = await step("parse-3d-project", async () =>
    await checkProject({ projectPath, configPath, timeoutMs: 30_000 }),
  );
  if (!check.ok) throw new Error("Godot did not parse the edited 3D project.");

  runtimeRun = await step("launch-3d-game", async () =>
    await launchProject({ projectPath, configPath, timeoutMs: 20_000 }),
  );
  const tree = await step("read-3d-scene-tree", async () =>
    await getRuntimeSceneTree({ projectPath, runId: runtimeRun.runId, maxDepth: 8, maxNodes: 100 }),
  );
  if (tree.root?.path !== "/root/Main") throw new Error("3D runtime scene root was not discovered.");
  await step("wait-for-3d-physics", async () =>
    await waitForRuntime({
      projectPath,
      runId: runtimeRun.runId,
      kind: "property",
      nodePath: playerPath,
      property: "meta:physics_ticks",
      operator: "gt",
      expected: 2,
      waitTimeoutMs: 1_000,
    }),
  );
  const before = await step("observe-3d-state-before", async () =>
    await observeRuntime({
      projectPath,
      runId: runtimeRun.runId,
      nodePaths: ["/root/Main", playerPath, "/root/Main/Camera"],
    }),
  );
  const playerBefore = before.nodes.find((node) => node.path === playerPath);
  const startX = Number(playerBefore?.state.position?.x);
  if (!Number.isFinite(startX) || playerBefore?.state.is_on_floor !== true) {
    throw new Error("CharacterBody3D observation did not expose a grounded numeric start state.");
  }
  const runtimeBefore = await step("capture-runtime-3d-before", async () =>
    await captureRuntimeScreenshot({ projectPath, runId: runtimeRun.runId }),
  );
  const preservedBefore = await preserveScreenshot(runtimeBefore, "runtime-3d-before.png");

  const projectionBefore = await step("project-player-to-screen", async () =>
    await projectRuntime3D({ projectPath, runId: runtimeRun.runId, nodePath: playerPath }),
  );
  if (!projectionBefore.onScreen || projectionBefore.behind) {
    throw new Error("CharacterBody3D did not project into the visible game viewport.");
  }
  const raycastBefore = await step("raycast-player-from-screen", async () =>
    await raycastRuntime3D({
      projectPath,
      runId: runtimeRun.runId,
      screenPosition: projectionBefore.screenPosition,
    }),
  );
  if (!raycastBefore.hit || raycastBefore.collider?.path !== playerPath) {
    throw new Error(`3D raycast did not select Player: ${raycastBefore.collider?.path ?? "no hit"}`);
  }

  const simulation = await step("simulate-isolated-world3d", async () =>
    await simulateRuntimePhysics({
      projectPath,
      runId: runtimeRun.runId,
      nodePath: playerPath,
      frames: 20,
      properties: ["position", "global_position", "velocity", "meta:distance", "meta:physics_ticks"],
      action: "ui_right",
    }),
  );
  const simulatedStartX = Number(simulation.samples[0]?.properties.position?.x);
  const simulatedEndX = Number(simulation.samples.at(-1)?.properties.position?.x);
  if (!simulation.isolated || !simulation.pausedRestored || simulatedEndX <= simulatedStartX) {
    throw new Error("Private World3D simulation did not move the duplicated CharacterBody3D.");
  }
  const unchanged = await step("prove-live-3d-state-unchanged", async () =>
    await observeRuntime({ projectPath, runId: runtimeRun.runId, nodePaths: [playerPath] }),
  );
  const unchangedX = Number(unchanged.nodes[0]?.state.position?.x);
  if (Math.abs(unchangedX - startX) > 0.001) {
    throw new Error(`World3D simulation mutated live Player x: ${startX} -> ${unchangedX}`);
  }

  await step("move-live-characterbody3d", async () =>
    await injectRuntimeInputSequence({
      projectPath,
      runId: runtimeRun.runId,
      steps: [{ kind: "action", action: "ui_right", holdMs: 300 }],
    }),
  );
  const moved = await step("wait-for-live-3d-movement", async () =>
    await waitForRuntime({
      projectPath,
      runId: runtimeRun.runId,
      kind: "property",
      nodePath: playerPath,
      property: "meta:distance",
      operator: "gt",
      expected: 0.25,
      waitTimeoutMs: 1_000,
    }),
  );
  const scenarioAssertion = await step("assert-3d-scenario", async () =>
    await assertRuntime({
      projectPath,
      runId: runtimeRun.runId,
      kind: "property",
      nodePath: "/root/Main",
      property: "meta:scenario_name",
      expected: "milestone-3",
    }),
  );
  if (!moved.satisfied || !scenarioAssertion.passed) throw new Error("Live 3D movement assertion failed.");
  const after = await step("observe-3d-state-after", async () =>
    await observeRuntime({
      projectPath,
      runId: runtimeRun.runId,
      nodePaths: [playerPath],
    }),
  );
  const endX = Number(after.nodes[0]?.state.position?.x);
  if (endX <= startX || after.nodes[0]?.state.is_on_floor !== true) {
    throw new Error("Live CharacterBody3D did not move while remaining grounded.");
  }
  const projectionAfter = await step("project-moved-player", async () =>
    await projectRuntime3D({ projectPath, runId: runtimeRun.runId, nodePath: playerPath }),
  );
  const raycastAfter = await step("raycast-moved-player", async () =>
    await raycastRuntime3D({
      projectPath,
      runId: runtimeRun.runId,
      screenPosition: projectionAfter.screenPosition,
    }),
  );
  if (raycastAfter.collider?.path !== playerPath) throw new Error("Moved Player could not be selected by 3D raycast.");

  const runtimeAfter = await step("capture-runtime-3d-after", async () =>
    await captureRuntimeScreenshot({ projectPath, runId: runtimeRun.runId }),
  );
  const preservedAfter = await preserveScreenshot(runtimeAfter, "runtime-3d-after.png");
  if (preservedBefore.sha256 === preservedAfter.sha256) {
    throw new Error("Runtime 3D screenshots did not change after verified movement.");
  }

  const runtimeStopped = await stopRun("runtime", runtimeRun);
  runtimeRun = null;
  if (runtimeStopped?.state !== "stopped") throw new Error("Managed runtime did not stop cleanly.");

  const report = {
    ok: true,
    task,
    toolCalls: steps.length,
    durationMs: Math.round(performance.now() - startedAt),
    artifactDirectory,
    evidence: {
      editor: { before: editorBefore, mutation: editorMutation, screenshot: preservedEditor },
      runtimeSceneRoot: tree.root?.path,
      observations: { before, unchangedAfterSimulation: unchanged, after },
      spatialQueries: { projectionBefore, raycastBefore, projectionAfter, raycastAfter },
      isolatedSimulation: simulation,
      assertions: [moved, scenarioAssertion],
      screenshots: { before: preservedBefore, after: preservedAfter },
      finalStates: { editor: editorStopped.state, runtime: runtimeStopped.state },
    },
    steps,
  };
  const reportPath = resolve(artifactDirectory, "report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`);
} catch (error) {
  const cleanup = {};
  if (runtimeRun !== null && projectPath !== null) {
    try {
      cleanup.runtime = await stopManagedRun({ projectPath, runId: runtimeRun.runId, timeoutMs: 15_000 });
    } catch (cleanupError) {
      cleanup.runtimeError = toRuntimeError(cleanupError);
    }
  }
  if (editorRun !== null && projectPath !== null) {
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
