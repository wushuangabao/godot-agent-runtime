import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  assertRuntime,
  captureRuntimeScreenshot,
  checkProject,
  createInheritedEditorScene,
  getRuntimeSceneTree,
  injectRuntimeInputSequence,
  installGodotAddon,
  launchEditor,
  launchProject,
  observeRuntime,
  simulateRuntimePhysics,
  stopManagedRun,
  toRuntimeError,
  waitForRuntime,
} from "../../../packages/core/dist/index.js";

const task = "milestone-2-inheritance-isolated-physics-observation";
const startedAt = performance.now();
const sourceProjectPath = resolve("examples", "physics-2d");
const configPath = resolve("config", "development.local.json");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const artifactDirectory = resolve("artifacts", "milestone-2", timestamp);
const inheritedSceneResource = "res://variants/milestone-2.tscn";
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
    evidence: screenshot.evidence,
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
  projectPath = await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-milestone-2-"));
  await cp(sourceProjectPath, projectPath, {
    recursive: true,
    filter: (source) => !source.startsWith(resolve(sourceProjectPath, ".godot")),
  });

  await step("install-editor-plugin", async () => await installGodotAddon(projectPath));
  editorRun = await step("launch-editor", async () =>
    await launchEditor({ projectPath, configPath, timeoutMs: 30_000 }),
  );
  const inherited = await step("create-inherited-scene", async () =>
    await createInheritedEditorScene({
      projectPath,
      runId: editorRun.runId,
      sourceScenePath: "res://main.tscn",
      targetScenePath: inheritedSceneResource,
      rootName: "Milestone2",
      rootProperties: { scenario_name: "milestone-2" },
    }),
  );
  if (!inherited.created || inherited.undoable || inherited.rootName !== "Milestone2") {
    throw new Error("EditorPlugin did not create the inherited scene with the requested root override.");
  }

  const inheritedPath = resolve(projectPath, "variants", "milestone-2.tscn");
  const inheritedSource = await readFile(inheritedPath, "utf8");
  if (!inheritedSource.includes("main.tscn") || !inheritedSource.includes("instance=ExtResource")) {
    throw new Error("Saved scene is not serialized as a true inherited PackedScene.");
  }
  if (!inheritedSource.includes('scenario_name = "milestone-2"')) {
    throw new Error("Inherited root property override was not serialized.");
  }
  const preservedInheritedPath = resolve(artifactDirectory, "milestone-2-inherited.tscn");
  await writeFile(preservedInheritedPath, inheritedSource, "utf8");

  const editorStopped = await stopRun("editor", editorRun);
  editorRun = null;
  if (editorStopped?.state !== "stopped") throw new Error("Managed editor did not stop cleanly.");

  const check = await step("parse-inherited-project", async () =>
    await checkProject({ projectPath, configPath, timeoutMs: 30_000 }),
  );
  if (!check.ok) throw new Error("Godot did not parse the inherited scene project.");

  runtimeRun = await step("launch-inherited-scene", async () =>
    await launchProject({
      projectPath,
      configPath,
      scene: inheritedSceneResource,
      timeoutMs: 20_000,
    }),
  );
  const tree = await step("read-runtime-scene-tree", async () =>
    await getRuntimeSceneTree({
      projectPath,
      runId: runtimeRun.runId,
      maxDepth: 8,
      maxNodes: 100,
    }),
  );
  if (tree.root?.path !== "/root/Milestone2") {
    throw new Error(`Inherited runtime root was not discovered: ${tree.root?.path ?? "null"}`);
  }

  const before = await step("observe-live-state-before", async () =>
    await observeRuntime({
      projectPath,
      runId: runtimeRun.runId,
      nodePaths: ["/root/Milestone2", "/root/Milestone2/Player"],
    }),
  );
  const rootBefore = before.nodes.find((node) => node.path === "/root/Milestone2");
  const playerBefore = before.nodes.find((node) => node.path.endsWith("/Player"));
  if (rootBefore?.metadata.scenario_name !== "milestone-2" || playerBefore === undefined) {
    throw new Error("Enhanced runtime observation did not expose inherited metadata and Player state.");
  }
  const liveStartPosition = playerBefore.state.position;
  const startX = Number(liveStartPosition?.x);
  if (!Number.isFinite(startX)) throw new Error("Player start position was not numeric.");

  const beforeScreenshot = await step("capture-runtime-before", async () =>
    await captureRuntimeScreenshot({ projectPath, runId: runtimeRun.runId, expectedScenePath: inheritedSceneResource }),
  );
  const preservedBefore = await preserveScreenshot(beforeScreenshot, "runtime-before-movement.png");

  const simulation = await step("simulate-isolated-physics", async () =>
    await simulateRuntimePhysics({
      projectPath,
      runId: runtimeRun.runId,
      nodePath: "/root/Milestone2/Player",
      frames: 20,
      properties: ["position", "velocity", "meta:distance", "meta:physics_ticks"],
      action: "ui_right",
    }),
  );
  const simulatedStartX = Number(simulation.samples[0]?.properties.position?.x);
  const simulatedEndX = Number(simulation.samples.at(-1)?.properties.position?.x);
  if (!simulation.isolated || !simulation.pausedRestored || simulatedEndX <= simulatedStartX) {
    throw new Error("Isolated physics simulation did not advance the duplicated Player.");
  }

  const unchanged = await step("prove-live-state-unchanged", async () =>
    await observeRuntime({
      projectPath,
      runId: runtimeRun.runId,
      nodePaths: ["/root/Milestone2/Player"],
      properties: ["meta:distance"],
    }),
  );
  const unchangedX = Number(unchanged.nodes[0]?.state.position?.x);
  if (Math.abs(unchangedX - startX) > 0.001) {
    throw new Error(`Isolated simulation mutated live Player x: ${startX} -> ${unchangedX}`);
  }

  await step("move-live-player", async () =>
    await injectRuntimeInputSequence({
      projectPath,
      runId: runtimeRun.runId,
      steps: [{ kind: "action", action: "ui_right", holdMs: 250 }],
    }),
  );
  const moved = await step("wait-for-live-movement", async () =>
    await waitForRuntime({
      projectPath,
      runId: runtimeRun.runId,
      kind: "property",
      nodePath: "/root/Milestone2/Player",
      property: "meta:distance",
      operator: "gt",
      expected: startX,
      waitTimeoutMs: 1_000,
    }),
  );
  const inheritedAssertion = await step("assert-inherited-runtime-state", async () =>
    await assertRuntime({
      projectPath,
      runId: runtimeRun.runId,
      kind: "property",
      nodePath: "/root/Milestone2",
      property: "meta:scenario_name",
      expected: "milestone-2",
    }),
  );
  if (!moved.satisfied || !inheritedAssertion.passed) {
    throw new Error("Live movement or inherited runtime assertion failed.");
  }
  const after = await step("observe-live-state-after", async () =>
    await observeRuntime({
      projectPath,
      runId: runtimeRun.runId,
      nodePaths: ["/root/Milestone2/Player"],
      properties: ["meta:distance", "meta:physics_ticks"],
    }),
  );

  const afterScreenshot = await step("capture-runtime-after", async () =>
    await captureRuntimeScreenshot({ projectPath, runId: runtimeRun.runId, expectedScenePath: inheritedSceneResource }),
  );
  const preservedAfter = await preserveScreenshot(afterScreenshot, "runtime-after-movement.png");
  if (preservedBefore.sha256 === preservedAfter.sha256) {
    throw new Error("Runtime screenshots did not change after live Player movement.");
  }
  if (preservedAfter.evidence.class !== "runtime_frame" ||
      !preservedAfter.evidence.provesRuntime ||
      preservedAfter.evidence.provesInteraction) {
    throw new Error("Runtime screenshot evidence was misclassified or claimed interaction proof.");
  }
  if (!inheritedAssertion.passed) throw new Error("A runtime frame cannot replace godot_runtime_assert evidence.");

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
      inheritedScene: {
        ...inherited,
        preservedPath: preservedInheritedPath,
        sourceSha256: createHash("sha256").update(inheritedSource).digest("hex"),
      },
      runtimeSceneRoot: tree.root?.path,
      observations: { before, unchangedAfterSimulation: unchanged, after },
      isolatedSimulation: simulation,
      assertions: [moved, inheritedAssertion],
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
