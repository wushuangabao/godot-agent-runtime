import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import {
  assertRuntime,
  batchEditorScene,
  captureRuntimeScreenshot,
  checkProject,
  checkScript,
  createDebugReport,
  findRuntimeUi,
  getDiagnosticsSummary,
  getEditorInfo,
  getEditorNode,
  getProjectContext,
  getProjectIdentity,
  injectRuntimeInput,
  installGodotAddon,
  launchEditor,
  launchProject,
  readManagedLogs,
  readProjectFile,
  redoEditorAction,
  replaceProjectText,
  saveEditorScene,
  stopManagedRun,
  toRuntimeError,
  undoEditorAction,
  upsertEditorInputAction,
  waitForRuntime,
  writeProjectFile,
} from "../../../packages/core/dist/index.js";
import { createMcpServer } from "../../../packages/mcp-server/dist/server.js";

export const MILESTONE_5_SEQUENCE = Object.freeze([
  "project-context",
  "guarded-file-replace",
  "stale-file-conflict",
  "wrong-scene-zero-mutation",
  "typed-batch-one-action-no-save",
  "batch-undo-redo",
  "failed-save-honesty",
  "explicit-scene-save",
  "input-map-new-sha",
  "editor-restart-input-map-readback",
  "script-and-project-checks",
  "runtime-find-input-wait-assert",
  "runtime-evidence",
  "diagnostics-incremental-logs-debug-report",
  "cleanup"
]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function measureMcpContract() {
  const server = createMcpServer();
  const client = new Client({ name: "milestone-5-contract", version: "0.2.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    const instructions = client.getInstructions() ?? "";
    return {
      serverInfo: client.getServerVersion(),
      toolCount: tools.length,
      toolSchemaBytes: Buffer.byteLength(JSON.stringify(stable(tools)), "utf8"),
      instructionsBytes: Buffer.byteLength(instructions, "utf8"),
    };
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
}

async function blockSceneSave(path) {
  if (process.platform !== "win32") {
    await chmod(path, 0o444);
    return async () => await chmod(path, 0o666);
  }
  const script = [
    "$stream = [System.IO.File]::Open($args[0], [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)",
    "[Console]::Out.WriteLine('READY')",
    "[Console]::Out.Flush()",
    "[Console]::In.ReadLine() | Out-Null",
    "$stream.Dispose()",
  ].join("; ");
  const helperDirectory = await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-milestone-5-lock-"));
  const helperPath = resolve(helperDirectory, "lock.ps1");
  await writeFile(helperPath, script, "utf8");
  const child = spawn("powershell.exe", ["-NoProfile", "-File", helperPath, path], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await new Promise((complete, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out acquiring the scene save lock.")), 5_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Scene lock helper exited before READY with code ${code}: ${stderr}`));
    });
    child.stdout.on("data", (chunk) => {
      if (!chunk.includes("READY")) return;
      clearTimeout(timeout);
      complete();
    });
  });
  return async () => {
    child.stdin.end("\n");
    await new Promise((complete, reject) => {
      child.once("error", reject);
      child.once("close", complete);
    });
    await rm(helperDirectory, { recursive: true, force: true });
  };
}

async function expectFailure(operation, expectedCode) {
  try {
    await operation();
  } catch (error) {
    const structured = toRuntimeError(error);
    if (structured.code !== expectedCode) {
      throw new Error(`Expected ${expectedCode}, received ${structured.code}: ${structured.message}`);
    }
    return structured;
  }
  throw new Error(`Expected ${expectedCode}, but the operation succeeded.`);
}

function toCleanupError(error) {
  const structured = toRuntimeError(error);
  const code = error !== null
    && typeof error === "object"
    && typeof error.code === "string"
      ? error.code
      : structured.code;
  return { ...structured, code, stage: "cleanup" };
}

export async function finalizeMilestone5Report({
  artifactDirectory,
  projectPath,
  report,
  releaseSaveBlock = null,
  removeTemporaryProject = async (path) => await rm(path, { recursive: true, force: true }),
  writeReport = writeFile,
  writeOutput = (value) => process.stdout.write(value),
  markFailure = () => { process.exitCode = 1; },
}) {
  const cleanup = report.cleanup ?? {
    attempted: true,
    allStopped: true,
    finalStates: {},
    errors: [],
  };
  report.cleanup = cleanup;
  cleanup.errors ??= [];
  let cleanupFailed = false;

  function recordCleanupError(error) {
    cleanupFailed = true;
    cleanup.errors.push(toCleanupError(error));
  }

  if (releaseSaveBlock !== null) {
    try {
      await releaseSaveBlock();
    } catch (error) {
      recordCleanupError(error);
    }
  }

  cleanup.temporaryProjectRemoved = projectPath === null;
  if (projectPath !== null) {
    try {
      await removeTemporaryProject(projectPath);
      cleanup.temporaryProjectRemoved = true;
    } catch (error) {
      cleanup.temporaryProjectRemoved = false;
      recordCleanupError(error);
    }
  }

  if (cleanupFailed) {
    report.ok = false;
    report.error ??= {
      code: "MILESTONE_CLEANUP_FAILED",
      stage: "cleanup",
      message: "Milestone cleanup did not complete; see cleanup.errors.",
      recovery: ["Review cleanup errors and remove remaining temporary resources manually."],
    };
    markFailure();
  }

  const reportPath = resolve(artifactDirectory, "report.json");
  await writeReport(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeOutput(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`);
  return { report, reportPath };
}

export async function runMilestone5WithDependencies(dependencies = {}) {
  const task = "milestone-5-optimized-mcp-closure";
  const startedAt = performance.now();
  const sourceProjectPath = resolve("examples", "control-ui");
  const configPath = resolve("config", "development.local.json");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const artifactDirectory = dependencies.artifactDirectory ?? resolve("artifacts", "milestone-5", timestamp);
  const measureContract = dependencies.measureMcpContract ?? measureMcpContract;
  const createTemporaryProject = dependencies.createTemporaryProject
    ?? (async () => await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-milestone-5-")));
  const copyProjectFixture = dependencies.copyProjectFixture ?? (async (source, target) =>
    await cp(source, target, {
      recursive: true,
      filter: (candidate) => !candidate.startsWith(resolve(source, ".godot")),
    }));
  const removeTemporaryProject = dependencies.removeTemporaryProject
    ?? (async (path) => await rm(path, { recursive: true, force: true }));
  const writeReport = dependencies.writeReport ?? writeFile;
  const writeOutput = dependencies.writeOutput ?? ((value) => process.stdout.write(value));
  const markFailure = dependencies.markFailure ?? (() => { process.exitCode = 1; });
  const steps = [];
  const counters = { toolCalls: 0, contextCalls: 0, batchCalls: 0, diagnosticCalls: 0 };
  const evidenceClasses = new Set();
  let projectPath = null;
  let editorRun = null;
  let runtimeRun = null;
  let releaseSaveBlock = null;
  const finalStates = { editor: "not_started", runtime: "not_started" };

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

  async function toolStep(name, tool, operation) {
    counters.toolCalls += 1;
    if (tool === "godot_project_context") counters.contextCalls += 1;
    if (tool === "godot_editor_batch") counters.batchCalls += 1;
    if (["godot_diagnostics", "godot_log_read", "godot_debug_report"].includes(tool)) {
      counters.diagnosticCalls += 1;
    }
    return await step(name, operation);
  }

  async function stopRun(kind, run) {
    if (run === null || projectPath === null) return null;
    const stopped = await toolStep(`stop-${kind}`, "godot_run_stop", async () =>
      await stopManagedRun({ projectPath, runId: run.runId, timeoutMs: 15_000 }),
    );
    finalStates[kind] = stopped.state;
    return stopped;
  }

  async function preserveEvidence(source, filename) {
    const target = resolve(artifactDirectory, filename);
    await copyFile(source, target);
    const bytes = await readFile(target);
    return { path: target, bytes: bytes.length, sha256: sha256(bytes) };
  }

  await mkdir(artifactDirectory, { recursive: true });
  let report;
  let mcp = null;
  try {
    mcp = await step("measure-mcp-contract", measureContract);
    if (mcp.toolCount !== 62 || mcp.toolSchemaBytes > 144_606 || mcp.instructionsBytes > 4_096) {
      throw new Error(`MCP context budget exceeded: ${JSON.stringify(mcp)}`);
    }

    projectPath = await step("create-temporary-project", createTemporaryProject);
    await step("copy-control-ui-fixture", async () =>
      await copyProjectFixture(sourceProjectPath, projectPath),
    );

    const context = await toolStep("project-context", "godot_project_context", async () =>
      await getProjectContext({ projectPath }),
    );
    const projectFingerprint = context.identity.projectFingerprint;
    const beforeScript = await toolStep("read-script-before-replace", "godot_file_read", async () =>
      await readProjectFile({ projectPath, path: "res://main.gd" }),
    );
    const replacement = await toolStep("guarded-file-replace", "godot_file_replace", async () =>
      await replaceProjectText({
        projectPath,
        expectedProjectFingerprint: projectFingerprint,
        path: "res://main.gd",
        oldText: "var started := false",
        newText: "var started: bool = false",
      }),
    );
    if (replacement.replacements !== 1 || replacement.previousSha256 !== beforeScript.sha256) {
      throw new Error("Unique guarded replacement did not return the expected content receipt.");
    }
    evidenceClasses.add("file_receipt");
    const staleConflict = await toolStep("stale-file-conflict", "godot_file_write", async () =>
      await expectFailure(
        async () => await writeProjectFile({
          projectPath,
          path: "res://main.gd",
          content: beforeScript.content,
          expectedSha256: beforeScript.sha256,
          expectedProjectFingerprint: projectFingerprint,
        }),
        "FILE_WRITE_CONFLICT",
      ),
    );

    await toolStep("install-editor-plugin", "godot_addon_install", async () =>
      await installGodotAddon(projectPath),
    );
    editorRun = await toolStep("launch-editor", "godot_editor_launch", async () =>
      await launchEditor({ projectPath, configPath, timeoutMs: 30_000 }),
    );
    finalStates.editor = editorRun.state;
    const editorStatus = await toolStep("editor-status-before-batch", "godot_editor_status", async () =>
      await getEditorInfo({ projectPath, runId: editorRun.runId }),
    );
    if (editorStatus.scene !== "res://main.tscn" || editorStatus.historyVersion === null) {
      throw new Error("Managed editor did not open res://main.tscn with a history version.");
    }
    const guard = {
      projectPath,
      runId: editorRun.runId,
      expectedProjectFingerprint: projectFingerprint,
      expectedScenePath: editorStatus.scene,
    };

    const beforeWrongSceneVersion = editorStatus.historyVersion;
    const wrongScene = await toolStep("wrong-scene-zero-mutation", "godot_editor_batch", async () =>
      await expectFailure(
        async () => await batchEditorScene({
          ...guard,
          expectedScenePath: "res://wrong.tscn",
          actionName: "Must not apply",
          operations: [{ op: "node_create", parentPath: "/root/Main", type: "Node", name: "WrongSceneMutation", properties: {} }],
          confirmDestructive: false,
        }),
        "EDITOR_SCENE_MISMATCH",
      ),
    );
    const afterWrongScene = await toolStep("editor-status-after-wrong-scene", "godot_editor_status", async () =>
      await getEditorInfo({ projectPath, runId: editorRun.runId }),
    );
    if (afterWrongScene.historyVersion !== beforeWrongSceneVersion) {
      throw new Error("Wrong-scene rejection changed native history.");
    }
    await toolStep("prove-wrong-scene-node-absent", "godot_editor_node_get", async () =>
      await expectFailure(
        async () => await getEditorNode({ projectPath, runId: editorRun.runId, nodePath: "/root/Main/WrongSceneMutation" }),
        "EDITOR_NODE_NOT_FOUND",
      ),
    );

    const mainPath = resolve(projectPath, "main.tscn");
    const diskBeforeBatch = await readFile(mainPath, "utf8");
    const batch = await toolStep("typed-batch-one-action-no-save", "godot_editor_batch", async () =>
      await batchEditorScene({
        ...guard,
        actionName: "Build milestone 5 UI",
        operations: [
          {
            op: "node_create",
            parentPath: "/root/Main",
            type: "Panel",
            name: "AgentPanel",
            properties: {
              position: { $type: "Vector2", x: 24, y: 272 },
              size: { $type: "Vector2", x: 220, y: 64 },
            },
          },
          {
            op: "node_create",
            parentPath: "/root/Main/AgentPanel",
            type: "Button",
            name: "BatchButton",
            properties: {
              text: "Agent Batch",
              position: { $type: "Vector2", x: 12, y: 10 },
              size: { $type: "Vector2", x: 196, y: 44 },
            },
          },
          {
            op: "resource_create",
            nodePath: "/root/Main/AgentPanel/BatchButton",
            property: "theme_override_styles/normal",
            type: "StyleBoxFlat",
            properties: { bg_color: { $type: "Color", r: 0.12, g: 0.35, b: 0.72, a: 1 } },
          },
          {
            op: "signal_connect",
            sourcePath: "/root/Main/AgentPanel/BatchButton",
            signal: "pressed",
            targetPath: "/root/Main",
            method: "_on_start_pressed",
          },
        ],
        confirmDestructive: false,
      }),
    );
    if (batch.operationCount !== 4 || !batch.undoable || !batch.dirty || Object.hasOwn(batch, "saved")) {
      throw new Error("Typed batch did not report one undoable, dirty, unsaved action.");
    }
    if (await readFile(mainPath, "utf8") !== diskBeforeBatch) {
      throw new Error("Typed batch saved the scene implicitly.");
    }
    evidenceClasses.add("scene_receipt");

    const undone = await toolStep("batch-undo", "godot_editor_undo", async () =>
      await undoEditorAction({
        ...guard,
        expectedHistoryVersion: batch.historyVersion,
        expectedActionName: batch.actionName,
      }),
    );
    await toolStep("prove-batch-undone", "godot_editor_node_get", async () =>
      await expectFailure(
        async () => await getEditorNode({ projectPath, runId: editorRun.runId, nodePath: "/root/Main/AgentPanel" }),
        "EDITOR_NODE_NOT_FOUND",
      ),
    );
    const redone = await toolStep("batch-redo", "godot_editor_redo", async () =>
      await redoEditorAction({
        ...guard,
        expectedHistoryVersion: undone.afterVersion,
        expectedActionName: batch.actionName,
      }),
    );
    await toolStep("prove-batch-redone", "godot_editor_node_get", async () =>
      await getEditorNode({
        projectPath,
        runId: editorRun.runId,
        nodePath: "/root/Main/AgentPanel/BatchButton",
        properties: ["text"],
      }),
    );

    releaseSaveBlock = await step("inject-scene-save-failure", async () => await blockSceneSave(mainPath));
    const failedSave = await toolStep("failed-save-honesty", "godot_editor_scene_save", async () =>
      await expectFailure(
        async () => await saveEditorScene({ ...guard, expectedHistoryVersion: redone.afterVersion }),
        "EDITOR_SCENE_SAVE_FAILED",
      ),
    );
    await toolStep("prove-batch-still-applied-after-save-failure", "godot_editor_node_get", async () =>
      await getEditorNode({ projectPath, runId: editorRun.runId, nodePath: "/root/Main/AgentPanel/BatchButton" }),
    );
    await releaseSaveBlock();
    releaseSaveBlock = null;
    if (await readFile(mainPath, "utf8") !== diskBeforeBatch) {
      throw new Error("Failed save changed the on-disk scene.");
    }

    const saved = await toolStep("explicit-scene-save", "godot_editor_scene_save", async () =>
      await saveEditorScene({ ...guard, expectedHistoryVersion: redone.afterVersion }),
    );
    const savedSceneSource = await readFile(mainPath, "utf8");
    if (!savedSceneSource.includes("AgentPanel") || !savedSceneSource.includes("BatchButton")) {
      throw new Error("Explicit save did not persist the typed batch.");
    }
    const sceneEvidence = await preserveEvidence(mainPath, "main-after-typed-batch.tscn");

    let identity = await getProjectIdentity(projectPath);
    const inputMap = await toolStep("input-map-new-sha", "godot_editor_input_action_upsert", async () =>
      await upsertEditorInputAction({
        projectPath,
        runId: editorRun.runId,
        expectedProjectFingerprint: identity.projectFingerprint,
        expectedProjectFileSha256: identity.projectFileSha256,
        name: "agent_accept",
        deadzone: 0.5,
        replaceEvents: true,
        events: [{ type: "key", physicalKeycode: 32 }],
      }),
    );
    if (inputMap.beforeSha256 === inputMap.afterSha256 || inputMap.undoable) {
      throw new Error("InputMap mutation did not return a new non-Undo file receipt.");
    }
    evidenceClasses.add("project_setting_receipt");

    await stopRun("editor", editorRun);
    editorRun = null;
    editorRun = await toolStep("restart-editor", "godot_editor_launch", async () =>
      await launchEditor({ projectPath, configPath, timeoutMs: 30_000 }),
    );
    finalStates.editor = editorRun.state;
    identity = await getProjectIdentity(projectPath);
    const inputMapReadback = await toolStep(
      "editor-restart-input-map-readback",
      "godot_editor_input_action_upsert",
      async () => await upsertEditorInputAction({
        projectPath,
        runId: editorRun.runId,
        expectedProjectFingerprint: identity.projectFingerprint,
        expectedProjectFileSha256: identity.projectFileSha256,
        name: "agent_accept",
        deadzone: 0.5,
        replaceEvents: false,
        events: [{ type: "mouse_button", buttonIndex: 1 }],
      }),
    );
    if (inputMapReadback.events.length !== 2) {
      throw new Error("Restarted editor did not reload and extend the persisted InputMap action.");
    }
    const projectSettingsEvidence = await preserveEvidence(
      resolve(projectPath, "project.godot"),
      "project-after-input-map.godot",
    );
    await stopRun("editor", editorRun);
    editorRun = null;

    const scriptCheck = await toolStep("script-check", "godot_script_check", async () =>
      await checkScript({ projectPath, path: "res://main.gd", configPath, timeoutMs: 30_000 }),
    );
    const projectCheck = await toolStep("project-check", "godot_project_check", async () =>
      await checkProject({ projectPath, configPath, timeoutMs: 30_000 }),
    );
    if (!scriptCheck.ok || !projectCheck.ok) throw new Error("Script or project validation failed.");

    runtimeRun = await toolStep("launch-runtime", "godot_scene_launch", async () =>
      await launchProject({ projectPath, configPath, timeoutMs: 20_000 }),
    );
    finalStates.runtime = runtimeRun.state;
    const diagnostics = await toolStep("diagnostics", "godot_diagnostics", async () =>
      await getDiagnosticsSummary({ projectPath, runId: runtimeRun.runId }),
    );
    evidenceClasses.add("diagnostics");
    const ui = await toolStep("runtime-find", "godot_runtime_ui_find", async () =>
      await findRuntimeUi({
        projectPath,
        runId: runtimeRun.runId,
        selector: { text: "Agent Batch", type: "Button", visibleOnly: true },
      }),
    );
    if (ui.count !== 1) throw new Error(`Expected one Agent Batch button, found ${ui.count}.`);
    const input = await toolStep("runtime-input", "godot_runtime_input", async () =>
      await injectRuntimeInput({
        projectPath,
        runId: runtimeRun.runId,
        kind: "click",
        path: ui.elements[0].path,
      }),
    );
    const waited = await toolStep("runtime-wait", "godot_runtime_wait", async () =>
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
    const asserted = await toolStep("runtime-assert", "godot_runtime_assert", async () =>
      await assertRuntime({
        projectPath,
        runId: runtimeRun.runId,
        kind: "property",
        nodePath: "/root/Main/StatusLabel",
        property: "text",
        expected: "Started",
      }),
    );
    if (!input.delivered || !waited.satisfied || !asserted.passed) {
      throw new Error("Structured runtime interaction proof failed.");
    }
    evidenceClasses.add("structured_wait");
    evidenceClasses.add("structured_assertion");

    const screenshot = await toolStep("runtime-evidence", "godot_runtime_screenshot", async () =>
      await captureRuntimeScreenshot({
        projectPath,
        runId: runtimeRun.runId,
        expectedScenePath: "res://main.tscn",
      }),
    );
    if (screenshot.evidence.class !== "runtime_frame" || screenshot.evidence.provesInteraction) {
      throw new Error("Runtime screenshot overclaimed its evidence class.");
    }
    evidenceClasses.add(screenshot.evidence.class);
    const screenshotEvidence = await preserveEvidence(screenshot.path, "runtime-after-interaction.png");
    const incrementalLogs = await toolStep("incremental-logs", "godot_log_read", async () =>
      await readManagedLogs({
        projectPath,
        runId: runtimeRun.runId,
        cursor: diagnostics.nextCursor,
        stream: "combined",
        minimumSeverity: "info",
        maxLines: 100,
        deduplicate: true,
      }),
    );
    evidenceClasses.add("incremental_logs");
    identity = await getProjectIdentity(projectPath);
    const debugReport = await toolStep("debug-report", "godot_debug_report", async () =>
      await createDebugReport({
        projectPath,
        expectedProjectFingerprint: identity.projectFingerprint,
        issue: "Milestone 5 structured interaction evidence",
        reproduction: "Click Agent Batch, wait for meta:started, assert StatusLabel text.",
        runId: runtimeRun.runId,
        format: "json",
      }),
    );
    if (!debugReport.reviewRequired) throw new Error("Debug report did not require review before sharing.");
    evidenceClasses.add("debug_report");
    const debugReportEvidence = await preserveEvidence(
      resolve(projectPath, debugReport.path.slice("res://".length)),
      "debug-report.json",
    );

    const runtimeStopped = await stopRun("runtime", runtimeRun);
    runtimeRun = null;
    const cleanup = {
      attempted: true,
      allStopped: finalStates.editor === "stopped" && finalStates.runtime === "stopped",
      finalStates: { ...finalStates },
      errors: [],
    };
    if (!cleanup.allStopped) throw new Error(`Managed run cleanup failed: ${JSON.stringify(cleanup)}`);

    report = {
      ok: true,
      task,
      sequence: MILESTONE_5_SEQUENCE,
      durationMs: Math.round(performance.now() - startedAt),
      artifactDirectory,
      ...counters,
      mcp,
      evidenceClasses: [...evidenceClasses].sort(),
      evidence: {
        context,
        fileMutation: { before: beforeScript.sha256, replacement, staleConflict },
        wrongScene: { error: wrongScene, historyVersion: beforeWrongSceneVersion },
        batch: { receipt: batch, undo: undone, redo: redone, failedSave, save: saved },
        inputMap: { first: inputMap, afterRestart: inputMapReadback },
        checks: { script: scriptCheck, project: projectCheck },
        runtime: { ui: ui.elements[0], input, wait: waited, assertion: asserted },
        diagnostics: { summary: diagnostics, incrementalLogs, debugReport },
        paths: {
          scene: sceneEvidence,
          projectSettings: projectSettingsEvidence,
          runtimeFrame: screenshotEvidence,
          debugReport: debugReportEvidence,
        },
      },
      cleanup,
      steps,
      finalStates: { editor: finalStates.editor, runtime: runtimeStopped.state },
    };
  } catch (error) {
    const cleanup = { attempted: true, allStopped: true, finalStates: { ...finalStates }, errors: [] };
    if (releaseSaveBlock !== null) {
      const release = releaseSaveBlock;
      releaseSaveBlock = null;
      try {
        await release();
      } catch (cleanupError) {
        cleanup.allStopped = false;
        cleanup.errors.push(toCleanupError(cleanupError));
      }
    }
    for (const [kind, run] of [["runtime", runtimeRun], ["editor", editorRun]]) {
      if (run === null || projectPath === null) continue;
      try {
        const stopped = await stopRun(kind, run);
        cleanup.finalStates[kind] = stopped.state;
        if (stopped.state !== "stopped" && stopped.state !== "exited") cleanup.allStopped = false;
      } catch (cleanupError) {
        cleanup.allStopped = false;
        cleanup.errors.push(toCleanupError(cleanupError));
      }
    }
    report = {
      ok: false,
      task,
      sequence: MILESTONE_5_SEQUENCE,
      durationMs: Math.round(performance.now() - startedAt),
      artifactDirectory,
      ...counters,
      mcp,
      evidenceClasses: [...evidenceClasses].sort(),
      error: toRuntimeError(error),
      cleanup,
      steps,
    };
    markFailure();
  } finally {
    await finalizeMilestone5Report({
      artifactDirectory,
      projectPath,
      report,
      releaseSaveBlock,
      removeTemporaryProject,
      writeReport,
      writeOutput,
      markFailure,
    });
  }
  return report;
}

export async function runMilestone5() {
  return await runMilestone5WithDependencies();
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runMilestone5();
}
