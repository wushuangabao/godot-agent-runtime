import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import type {
  EditorBridgeInfo,
  EditorHistoryResult,
  EditorInheritedSceneResult,
  EditorInstanceMutationResult,
  EditorInstanceResult,
  EditorMutationResult,
  EditorNodeResult,
  EditorResourceResult,
  EditorResourceReadResult,
  EditorResourceFocusResult,
  EditorResourceSaveResult,
  EditorSceneSaveResult,
  EditorSceneTreeResult,
  EditorScreenshotResult,
  EditorSelectionResult,
  EditorSignalConnectionResult,
  GodotLaunchResult,
} from "@godot-agent-runtime/protocol";

import { RuntimeFailure } from "./errors.js";
import {
  prepareHostEnvironment,
  resolveGodotExecutable,
  type GodotOperationOptions,
} from "./godot.js";
import {
  getManagedRunStatus,
  launchManagedProcess,
  stopManagedRun,
} from "./managed-run.js";
import { inspectProject } from "./project.js";
import {
  findLoopbackPort,
  sendBridgeCommand,
  validateBridgeHandshake,
  type RuntimeLookupOptions,
} from "./runtime.js";

const EDITOR_CAPABILITIES = [
  "scene_tree",
  "selection",
  "screenshot",
  "viewport_3d",
  "node_edit",
  "scene_instantiate",
  "scene_inheritance",
  "instance_editable",
  "resource_edit",
  "resource_save",
  "resource_focus",
  "signal_connect",
  "scene_save",
  "undo_redo",
] as const;

export async function getEditorInfo(options: RuntimeLookupOptions): Promise<EditorBridgeInfo> {
  const result = await sendBridgeCommand(options, "hello");
  const handshake = validateBridgeHandshake(result, "editor", EDITOR_CAPABILITIES);
  return {
    ok: true,
    runId: options.runId,
    protocolVersion: handshake.protocolVersion,
    engineVersion: String(result.engineVersion ?? "unknown"),
    scene: typeof result.scene === "string" ? result.scene : null,
    capabilities: handshake.capabilities as EditorBridgeInfo["capabilities"],
  };
}

async function waitForEditor(
  options: RuntimeLookupOptions,
  requireOpenScene: boolean,
): Promise<EditorBridgeInfo> {
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const info = await getEditorInfo({ ...options, timeoutMs: 750 });
      if (!requireOpenScene || info.scene !== null) return info;
      lastError = new Error("Editor bridge is ready but the main scene is still opening.");
    } catch (error) {
      lastError = error;
      if (error instanceof RuntimeFailure && error.payload.code.startsWith("EDITOR_PROTOCOL_")) {
        throw error;
      }
      try {
        const status = await getManagedRunStatus(options);
        const errors = status.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
        if (errors.length > 0 || status.state === "failed") {
          throw new RuntimeFailure({
            code: "EDITOR_PLUGIN_FAILED",
            stage: "spawn",
            message: "The EditorPlugin reported startup errors.",
            details: {
              runId: options.runId,
              state: status.state,
              diagnostics: errors,
              stderr: status.stderr,
            },
            recovery: ["Fix the EditorPlugin parse/runtime errors, then launch a fresh managed editor."],
          });
        }
      } catch (statusError) {
        if (statusError instanceof RuntimeFailure && statusError.payload.code === "EDITOR_PLUGIN_FAILED") {
          throw statusError;
        }
      }
      await new Promise((delay) => setTimeout(delay, 100));
    }
  }
  throw new RuntimeFailure({
    code: "EDITOR_BRIDGE_START_TIMEOUT",
    stage: "spawn",
    message: "The EditorPlugin did not become ready before the startup deadline.",
    details: { cause: lastError instanceof Error ? lastError.message : String(lastError) },
    recovery: ["Install and enable the addon with godot_addon_install, then inspect the editor run logs."],
  });
}

export async function launchEditor(
  options: GodotOperationOptions,
): Promise<GodotLaunchResult> {
  const project = await inspectProject(options.projectPath);
  if (!project.enabledPlugins.includes("godot_agent_runtime")) {
    throw new RuntimeFailure({
      code: "EDITOR_PLUGIN_NOT_ENABLED",
      stage: "validation",
      message: "The Godot Agent Runtime EditorPlugin is not enabled for this project.",
      details: { enabledPlugins: project.enabledPlugins },
      recovery: ["Call godot_addon_install for this project before launching the managed editor."],
    });
  }
  const executable = await resolveGodotExecutable(options);
  const env = await prepareHostEnvironment(project.projectPath);
  const runtimeBridgePort = await findLoopbackPort();
  const args = ["--editor", "--path", project.projectPath];
  if (project.mainScene !== null) args.push(project.mainScene);
  const launch = await launchManagedProcess({
    projectPath: project.projectPath,
    executable,
    args,
    env,
    scene: null,
    runtimeBridgePort,
    ...(options.timeoutMs === undefined ? {} : { startupTimeoutMs: options.timeoutMs }),
  });
  try {
    await waitForEditor(
      {
        projectPath: project.projectPath,
        runId: launch.runId,
        timeoutMs: options.timeoutMs ?? 15_000,
      },
      project.mainScene !== null,
    );
    return launch;
  } catch (error) {
    let stoppedDetails: Record<string, unknown> = {};
    try {
      const stopped = await stopManagedRun({ projectPath: project.projectPath, runId: launch.runId });
      stoppedDetails = {
        runId: launch.runId,
        state: stopped.state,
        stdout: stopped.stdout,
        stderr: stopped.stderr,
        diagnostics: stopped.diagnostics,
      };
    } catch {
      // Preserve the plugin startup failure and its actionable recovery.
    }
    if (error instanceof RuntimeFailure) {
      throw new RuntimeFailure({
        ...error.payload,
        details: { ...error.payload.details, ...stoppedDetails },
      });
    }
    throw error;
  }
}

export async function getEditorSceneTree(
  options: RuntimeLookupOptions,
): Promise<EditorSceneTreeResult> {
  const result = await sendBridgeCommand(options, "scene_tree");
  return {
    ok: true,
    runId: options.runId,
    root: (result.root ?? null) as EditorSceneTreeResult["root"],
    truncated: Boolean(result.truncated),
  };
}

export interface EditorNodeLookupOptions extends RuntimeLookupOptions {
  readonly nodePath: string;
  readonly properties?: readonly string[];
}

export interface EditorNodeCreateOptions extends RuntimeLookupOptions {
  readonly parentPath: string;
  readonly type: string;
  readonly name: string;
  readonly properties?: Readonly<Record<string, unknown>>;
}

export interface EditorSceneInstantiateOptions extends RuntimeLookupOptions {
  readonly parentPath: string;
  readonly scenePath: string;
  readonly name?: string;
  readonly properties?: Readonly<Record<string, unknown>>;
}

export interface EditorSceneInheritanceOptions extends RuntimeLookupOptions {
  readonly sourceScenePath: string;
  readonly targetScenePath: string;
  readonly rootName?: string;
  readonly rootProperties?: Readonly<Record<string, unknown>>;
  readonly open?: boolean;
  readonly overwrite?: boolean;
}

export interface EditorNodeUpdateOptions extends RuntimeLookupOptions {
  readonly nodePath: string;
  readonly name?: string;
  readonly properties?: Readonly<Record<string, unknown>>;
}

export interface EditorNodeDeleteOptions extends RuntimeLookupOptions {
  readonly nodePath: string;
}

export interface EditorNodeMoveOptions extends RuntimeLookupOptions {
  readonly nodePath: string;
  readonly newParentPath: string;
  readonly index?: number;
  readonly keepGlobalTransform?: boolean;
}

export interface EditorResourceCreateOptions extends RuntimeLookupOptions {
  readonly nodePath: string;
  readonly property: string;
  readonly type: string;
  readonly properties?: Readonly<Record<string, unknown>>;
}

export interface EditorResourceLookupOptions extends RuntimeLookupOptions {
  readonly nodePath: string;
  readonly property: string;
  readonly properties?: readonly string[];
}

export interface EditorResourceUpdateOptions extends RuntimeLookupOptions {
  readonly nodePath: string;
  readonly property: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

export interface EditorInstanceLookupOptions extends RuntimeLookupOptions {
  readonly nodePath: string;
}

export interface EditorInstanceSetEditableOptions extends EditorInstanceLookupOptions {
  readonly editable: boolean;
}

export interface EditorResourceSaveOptions extends RuntimeLookupOptions {
  readonly nodePath: string;
  readonly property: string;
  readonly path: string;
  readonly overwrite?: boolean;
}

export interface EditorResourceFocusOptions extends RuntimeLookupOptions {
  readonly path: string;
}

export interface EditorSelectionSetOptions extends RuntimeLookupOptions {
  readonly paths: readonly string[];
  readonly focus?: boolean;
}

export interface EditorSignalConnectOptions extends RuntimeLookupOptions {
  readonly sourcePath: string;
  readonly signal: string;
  readonly targetPath: string;
  readonly method: string;
  readonly flags?: number;
}

export interface EditorScreenshotOptions extends RuntimeLookupOptions {
  readonly viewport?: "2d" | "3d";
  readonly viewportIndex?: number;
}

export async function getEditorNode(
  options: EditorNodeLookupOptions,
): Promise<EditorNodeResult> {
  const result = await sendBridgeCommand(options, "node_get", {
    nodePath: options.nodePath,
    properties: options.properties ?? [],
  });
  return { ok: true, runId: options.runId, node: result.node as EditorNodeResult["node"] };
}

export async function createEditorNode(
  options: EditorNodeCreateOptions,
): Promise<EditorMutationResult> {
  const result = await sendBridgeCommand(options, "node_create", {
    parentPath: options.parentPath,
    type: options.type,
    name: options.name,
    properties: options.properties ?? {},
  });
  return { ok: true, runId: options.runId, ...result } as EditorMutationResult;
}

export async function instantiateEditorScene(
  options: EditorSceneInstantiateOptions,
): Promise<EditorMutationResult> {
  const result = await sendBridgeCommand(options, "scene_instantiate", {
    parentPath: options.parentPath,
    scenePath: options.scenePath,
    ...(options.name === undefined ? {} : { name: options.name }),
    properties: options.properties ?? {},
  });
  return { ok: true, runId: options.runId, ...result } as EditorMutationResult;
}

export async function createInheritedEditorScene(
  options: EditorSceneInheritanceOptions,
): Promise<EditorInheritedSceneResult> {
  const result = await sendBridgeCommand(options, "scene_create_inherited", {
    sourceScenePath: options.sourceScenePath,
    targetScenePath: options.targetScenePath,
    ...(options.rootName === undefined ? {} : { rootName: options.rootName }),
    rootProperties: options.rootProperties ?? {},
    open: options.open ?? false,
    overwrite: options.overwrite ?? false,
  });
  const targetScene = String(result.targetScene ?? "");
  if (!targetScene.startsWith("res://")) {
    const status = await getManagedRunStatus(options);
    throw new RuntimeFailure({
      code: "EDITOR_INHERITED_SCENE_PATH_INVALID",
      stage: "protocol",
      message: "Editor bridge returned an invalid inherited scene path.",
      details: { targetScene, result, stderr: status.stderr, diagnostics: status.diagnostics },
      recovery: ["Reinstall the matching Godot Agent Runtime addon and retry."],
    });
  }
  const projectRoot = resolve(options.projectPath);
  const targetPath = resolve(projectRoot, targetScene.slice("res://".length));
  const offset = relative(projectRoot, targetPath);
  if (offset === ".." || offset.startsWith(`..${sep}`) || resolve(offset) === offset) {
    throw new RuntimeFailure({
      code: "EDITOR_INHERITED_SCENE_PATH_INVALID",
      stage: "validation",
      message: "Inherited scene target escaped the project directory.",
      details: { targetScene, projectRoot },
      recovery: ["Use a normalized .tscn path below res://."],
    });
  }
  const [content, information] = await Promise.all([readFile(targetPath), stat(targetPath)]);
  return {
    ok: true,
    runId: options.runId,
    created: true,
    sourceScene: String(result.sourceScene),
    targetScene,
    rootName: String(result.rootName),
    opened: Boolean(result.opened),
    overwritten: Boolean(result.overwritten),
    bytes: information.size,
    sha256: createHash("sha256").update(content).digest("hex"),
    undoable: false,
  };
}

export async function updateEditorNode(
  options: EditorNodeUpdateOptions,
): Promise<EditorMutationResult> {
  const result = await sendBridgeCommand(options, "node_update", {
    nodePath: options.nodePath,
    ...(options.name === undefined ? {} : { name: options.name }),
    properties: options.properties ?? {},
  });
  return { ok: true, runId: options.runId, ...result } as EditorMutationResult;
}

export async function deleteEditorNode(
  options: EditorNodeDeleteOptions,
): Promise<EditorMutationResult> {
  const result = await sendBridgeCommand(options, "node_delete", {
    nodePath: options.nodePath,
  });
  return { ok: true, runId: options.runId, ...result } as EditorMutationResult;
}

export async function moveEditorNode(
  options: EditorNodeMoveOptions,
): Promise<EditorMutationResult> {
  const result = await sendBridgeCommand(options, "node_move", {
    nodePath: options.nodePath,
    newParentPath: options.newParentPath,
    ...(options.index === undefined ? {} : { index: options.index }),
    ...(options.keepGlobalTransform === undefined
      ? {}
      : { keepGlobalTransform: options.keepGlobalTransform }),
  });
  return { ok: true, runId: options.runId, ...result } as EditorMutationResult;
}

export async function createEditorResource(
  options: EditorResourceCreateOptions,
): Promise<EditorResourceResult> {
  const result = await sendBridgeCommand(options, "resource_create", {
    nodePath: options.nodePath,
    property: options.property,
    type: options.type,
    properties: options.properties ?? {},
  });
  return { ok: true, runId: options.runId, ...result } as EditorResourceResult;
}

export async function getEditorResource(
  options: EditorResourceLookupOptions,
): Promise<EditorResourceReadResult> {
  const result = await sendBridgeCommand(options, "resource_get", {
    nodePath: options.nodePath,
    property: options.property,
    properties: options.properties ?? [],
  });
  return { ok: true, runId: options.runId, ...result } as EditorResourceReadResult;
}

export async function updateEditorResource(
  options: EditorResourceUpdateOptions,
): Promise<EditorResourceResult> {
  const result = await sendBridgeCommand(options, "resource_update", {
    nodePath: options.nodePath,
    property: options.property,
    properties: options.properties,
  });
  return { ok: true, runId: options.runId, ...result } as EditorResourceResult;
}

export async function saveEditorResource(
  options: EditorResourceSaveOptions,
): Promise<EditorResourceSaveResult> {
  const result = await sendBridgeCommand(options, "resource_save", {
    nodePath: options.nodePath,
    property: options.property,
    path: options.path,
    overwrite: options.overwrite ?? false,
  });
  return { ok: true, runId: options.runId, ...result } as EditorResourceSaveResult;
}

export async function focusEditorResource(
  options: EditorResourceFocusOptions,
): Promise<EditorResourceFocusResult> {
  const result = await sendBridgeCommand(options, "resource_focus", {
    path: options.path,
  });
  return { ok: true, runId: options.runId, ...result } as EditorResourceFocusResult;
}

export async function getEditorInstance(
  options: EditorInstanceLookupOptions,
): Promise<EditorInstanceResult> {
  const result = await sendBridgeCommand(options, "instance_get", {
    nodePath: options.nodePath,
  });
  return { ok: true, runId: options.runId, ...result } as EditorInstanceResult;
}

export async function setEditorInstanceEditable(
  options: EditorInstanceSetEditableOptions,
): Promise<EditorInstanceMutationResult> {
  const result = await sendBridgeCommand(options, "instance_set_editable", {
    nodePath: options.nodePath,
    editable: options.editable,
  });
  return { ok: true, runId: options.runId, ...result } as EditorInstanceMutationResult;
}

export async function getEditorSelection(
  options: RuntimeLookupOptions,
): Promise<EditorSelectionResult> {
  const result = await sendBridgeCommand(options, "selection");
  return { ok: true, runId: options.runId, ...result } as EditorSelectionResult;
}

export async function setEditorSelection(
  options: EditorSelectionSetOptions,
): Promise<EditorSelectionResult> {
  const result = await sendBridgeCommand(options, "selection_set", {
    paths: options.paths,
    focus: options.focus ?? true,
  });
  return { ok: true, runId: options.runId, ...result } as EditorSelectionResult;
}

export async function connectEditorSignal(
  options: EditorSignalConnectOptions,
): Promise<EditorSignalConnectionResult> {
  const result = await sendBridgeCommand(options, "signal_connect", {
    sourcePath: options.sourcePath,
    signal: options.signal,
    targetPath: options.targetPath,
    method: options.method,
    ...(options.flags === undefined ? {} : { flags: options.flags }),
  });
  return {
    ok: true,
    runId: options.runId,
    ...result,
  } as EditorSignalConnectionResult;
}

export async function saveEditorScene(
  options: RuntimeLookupOptions,
): Promise<EditorSceneSaveResult> {
  const result = await sendBridgeCommand(options, "scene_save");
  return { ok: true, runId: options.runId, ...result } as EditorSceneSaveResult;
}

export async function undoEditorAction(
  options: RuntimeLookupOptions,
): Promise<EditorHistoryResult> {
  const result = await sendBridgeCommand(options, "history_undo");
  return { ok: true, runId: options.runId, ...result } as EditorHistoryResult;
}

export async function redoEditorAction(
  options: RuntimeLookupOptions,
): Promise<EditorHistoryResult> {
  const result = await sendBridgeCommand(options, "history_redo");
  return { ok: true, runId: options.runId, ...result } as EditorHistoryResult;
}

export async function captureEditorScreenshot(
  options: EditorScreenshotOptions,
): Promise<EditorScreenshotResult> {
  const result = await sendBridgeCommand(options, "screenshot", {
    viewport: options.viewport ?? "2d",
    viewportIndex: options.viewportIndex ?? 0,
  });
  const path = resolve(String(result.path ?? ""));
  const evidenceRoot = resolve(
    options.projectPath,
    ".godot",
    "agent-runtime",
    "evidence",
    options.runId,
  );
  const offset = relative(evidenceRoot, path);
  if (offset === ".." || offset.startsWith(`..${sep}`) || resolve(offset) === offset) {
    throw new RuntimeFailure({
      code: "EDITOR_EVIDENCE_PATH_INVALID",
      stage: "validation",
      message: "Editor bridge returned a screenshot path outside its evidence directory.",
      details: { path, evidenceRoot },
      recovery: ["Stop this editor run and launch a fresh bridge session."],
    });
  }
  const [buffer, information] = await Promise.all([readFile(path), stat(path)]);
  return {
    ok: true,
    runId: options.runId,
    path,
    width: Number(result.width),
    height: Number(result.height),
    bytes: information.size,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    viewport: result.viewport as "2d" | "3d",
    viewportIndex: result.viewportIndex === null ? null : Number(result.viewportIndex),
    camera: result.camera as EditorScreenshotResult["camera"],
  };
}
