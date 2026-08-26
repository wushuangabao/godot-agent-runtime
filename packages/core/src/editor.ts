import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import {
  EDITOR_PROTOCOL_VERSION,
  EditorBatchRequestSchema,
  EditorBatchResultSchema,
  EditorInputActionMutationResultSchema,
  EditorInputActionUpsertRequestSchema,
  EditorProjectSettingGetRequestSchema,
  EditorProjectSettingMutationResultSchema,
  EditorProjectSettingResultSchema,
  EditorProjectSettingSetRequestSchema,
  EditorResourceInspectRequestSchema,
  EditorResourceInspectionResultSchema,
  type EditorBatchOperation,
  type EditorBatchResult,
  type EditorInputActionMutationResult,
  type EditorInputBinding,
  type EditorProjectSettingMutationResult,
  type EditorProjectSettingResult,
  type EditorProjectSettingValue,
  type EditorResourceInspectionResult,
  type EditorSceneOpenResult,
  type EditorBridgeInfo,
  type EditorHistoryResult,
  type EditorInheritedSceneResult,
  type EditorInstanceMutationResult,
  type EditorInstanceResult,
  type EditorMutationResult,
  type EditorNodeResult,
  type EditorResourceResult,
  type EditorResourceReadResult,
  type EditorResourceFocusResult,
  type EditorResourceSaveResult,
  type EditorSceneSaveResult,
  type EditorSceneTreeResult,
  type EditorScreenshotResult,
  type EditorSelectionResult,
  type EditorSignalConnectionResult,
  type GodotLaunchResult,
} from "@godot-agent-runtime/protocol";

import { RuntimeFailure } from "./errors.js";
import { createEditorEvidenceMetadata } from "./evidence.js";
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
import { assertProjectFingerprint, inspectProject } from "./project.js";
import { withProjectMutationLock, type ProjectMutationLease } from "./safe-file.js";
import {
  findLoopbackPort,
  sendBridgeCommand,
  validateBridgeHandshake,
  type RuntimeLookupOptions,
} from "./runtime.js";
import { isGodotAgentRuntimeEnabled } from "./addon.js";

const EDITOR_CAPABILITIES = [
  "scene_tree",
  "selection",
  "screenshot",
  "screenshot_receipt",
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
  "scene_open",
  "scene_batch",
  "undo_redo",
  "project_settings",
  "input_map",
  "resource_inspect",
] as const;

const PROJECT_SETTINGS_DEADLINE_MS = 30_000;
const PROJECT_SETTINGS_RECONCILE_GRACE_MS = 5_000;

export async function getEditorInfo(options: RuntimeLookupOptions): Promise<EditorBridgeInfo> {
  const result = await sendBridgeCommand(options, "hello");
  const handshake = validateBridgeHandshake(
    result,
    "editor",
    EDITOR_PROTOCOL_VERSION,
    EDITOR_CAPABILITIES,
  );
  const rawHistoryVersion = result.historyVersion;
  const historyVersion = rawHistoryVersion === null
    ? null
    : rawHistoryVersion;
  if (historyVersion !== null &&
      (typeof historyVersion !== "number" || !Number.isInteger(historyVersion) || historyVersion < 0)) {
    throw new RuntimeFailure({
      code: "EDITOR_PROTOCOL_HANDSHAKE_INVALID",
      stage: "protocol",
      message: "editor bridge returned an invalid scene history version.",
      details: { historyVersion: rawHistoryVersion ?? null },
      recovery: ["Reinstall the Godot Agent Runtime addon and start a fresh managed editor."],
    });
  }
  const scene = typeof result.scene === "string" ? result.scene : null;
  if ((scene === null) !== (historyVersion === null)) {
    throw new RuntimeFailure({
      code: "EDITOR_PROTOCOL_HANDSHAKE_INVALID",
      stage: "protocol",
      message: "editor bridge returned inconsistent scene and history status.",
      details: { scene, historyVersion },
      recovery: ["Reinstall the Godot Agent Runtime addon and start a fresh managed editor."],
    });
  }
  return {
    ok: true,
    runId: options.runId,
    protocolVersion: handshake.protocolVersion,
    engineVersion: String(result.engineVersion ?? "unknown"),
    scene,
    historyVersion,
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
  if (!isGodotAgentRuntimeEnabled(project.enabledPlugins)) {
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

export interface EditorMutationLookupOptions extends RuntimeLookupOptions {
  readonly expectedProjectFingerprint?: string | undefined;
  readonly expectedScenePath: string;
}

export interface EditorHistoryMutationOptions extends EditorMutationLookupOptions {
  readonly expectedHistoryVersion: number;
  readonly expectedActionName?: string;
}

export interface EditorBatchOptions extends RuntimeLookupOptions {
  readonly expectedProjectFingerprint: string;
  readonly expectedScenePath: string;
  readonly actionName?: string;
  readonly operations: readonly EditorBatchOperation[];
  readonly confirmDestructive: boolean;
}

export interface EditorSceneOpenOptions extends RuntimeLookupOptions {
  readonly expectedProjectFingerprint: string;
  readonly scenePath: string;
}

export interface EditorNodeCreateOptions extends EditorMutationLookupOptions {
  readonly parentPath: string;
  readonly type: string;
  readonly name: string;
  readonly properties?: Readonly<Record<string, unknown>>;
}

export interface EditorSceneInstantiateOptions extends EditorMutationLookupOptions {
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

export interface EditorNodeUpdateOptions extends EditorMutationLookupOptions {
  readonly nodePath: string;
  readonly name?: string;
  readonly properties?: Readonly<Record<string, unknown>>;
}

export interface EditorNodeDeleteOptions extends EditorMutationLookupOptions {
  readonly nodePath: string;
}

export interface EditorNodeMoveOptions extends EditorMutationLookupOptions {
  readonly nodePath: string;
  readonly newParentPath: string;
  readonly index?: number;
  readonly keepGlobalTransform?: boolean;
}

export interface EditorResourceCreateOptions extends EditorMutationLookupOptions {
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

export interface EditorResourceUpdateOptions extends EditorMutationLookupOptions {
  readonly nodePath: string;
  readonly property: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

export interface EditorInstanceLookupOptions extends RuntimeLookupOptions {
  readonly nodePath: string;
}

export interface EditorInstanceSetEditableOptions extends EditorInstanceLookupOptions, EditorMutationLookupOptions {
  readonly editable: boolean;
}

export interface EditorResourceSaveOptions extends EditorMutationLookupOptions {
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

export interface EditorSignalConnectOptions extends EditorMutationLookupOptions {
  readonly sourcePath: string;
  readonly signal: string;
  readonly targetPath: string;
  readonly method: string;
  readonly flags?: number;
}

export interface EditorScreenshotOptions extends RuntimeLookupOptions {
  readonly expectedScenePath?: string;
  readonly viewport?: "2d" | "3d";
  readonly viewportIndex?: number;
}

export interface EditorProjectSettingGetOptions extends RuntimeLookupOptions {
  readonly key: string;
}

export interface EditorProjectSettingSetOptions extends RuntimeLookupOptions {
  readonly expectedProjectFingerprint: string;
  readonly expectedProjectFileSha256: string;
  readonly key: string;
  readonly value: EditorProjectSettingValue;
}

export interface EditorInputActionUpsertOptions extends RuntimeLookupOptions {
  readonly expectedProjectFingerprint: string;
  readonly expectedProjectFileSha256: string;
  readonly name: string;
  readonly deadzone: number;
  readonly replaceEvents: boolean;
  readonly events: readonly EditorInputBinding[];
}

export interface EditorResourceInspectOptions extends RuntimeLookupOptions {
  readonly path: string;
  readonly properties?: readonly string[];
}

function editorInputFailure(code: string, message: string, issues: unknown): RuntimeFailure {
  return new RuntimeFailure({
    code,
    stage: "validation",
    message,
    details: { issues },
    recovery: ["Use only the documented bounded project configuration fields."],
  });
}

function runtimeFailureFromReceipt(value: unknown): RuntimeFailure {
  const receipt = value as {
    readonly code?: unknown;
    readonly message?: unknown;
    readonly details?: unknown;
  };
  return new RuntimeFailure({
    code: typeof receipt.code === "string" ? receipt.code : "EDITOR_PROJECT_SETTING_OPERATION_FAILED",
    stage: "run",
    message: typeof receipt.message === "string"
      ? receipt.message
      : "The editor project-setting operation failed.",
    ...(receipt.details !== null && typeof receipt.details === "object"
      ? { details: receipt.details as Record<string, unknown> }
      : {}),
    recovery: ["Read the current project context and project.godot SHA-256 before retrying."],
  });
}

function uncertainBridgeFailure(error: unknown): boolean {
  if (!(error instanceof RuntimeFailure)) return false;
  if (error.payload.code === "RUNTIME_BRIDGE_TIMEOUT") return true;
  if (error.payload.code !== "RUNTIME_BRIDGE_CONNECTION_FAILED") return false;
  return error.payload.details?.requestSent !== false;
}

async function projectFileSha256(projectPath: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(resolve(projectPath, "project.godot")))
    .digest("hex");
}

async function reconcileProjectSettingOperation(
  options: RuntimeLookupOptions,
  operationId: string,
  deadline: number,
): Promise<Record<string, unknown> | null> {
  while (Date.now() < deadline) {
    try {
      const status = await sendBridgeCommand(
        { ...options, timeoutMs: Math.min(750, Math.max(100, deadline - Date.now())) },
        "project_setting_operation_status",
        { operationId },
      );
      if (status.state === "succeeded" && status.result !== null && typeof status.result === "object") {
        return status.result as Record<string, unknown>;
      }
      if (status.state === "failed") throw runtimeFailureFromReceipt(status.error);
    } catch (error) {
      if (!uncertainBridgeFailure(error)) throw error;
    }
    await new Promise((complete) => setTimeout(complete, 100));
  }
  return null;
}

async function runProjectSettingsMutation(
  options: RuntimeLookupOptions & {
    readonly expectedProjectFingerprint: string;
    readonly expectedProjectFileSha256: string;
  },
  capability: "project_settings" | "input_map",
  command: "project_setting_set" | "input_action_upsert",
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await assertProjectFingerprint(options.projectPath, options.expectedProjectFingerprint);
  const info = await getEditorInfo(options);
  assertEditorCapability(info.capabilities, capability);
  const operationId = randomUUID();
  return await withProjectMutationLock({
    projectPath: options.projectPath,
    path: "project.godot",
    expectedProjectFingerprint: options.expectedProjectFingerprint,
    indeterminateErrorCode: "PROJECT_MUTATION_INDETERMINATE",
  }, async (lease: ProjectMutationLease) => {
    const operationDeadline = Date.now() + PROJECT_SETTINGS_DEADLINE_MS;
    await lease.prepareResultUnknown();
    try {
      return await sendBridgeCommand(
        {
          projectPath: options.projectPath,
          runId: options.runId,
          timeoutMs: Math.min(options.timeoutMs ?? PROJECT_SETTINGS_DEADLINE_MS, PROJECT_SETTINGS_DEADLINE_MS),
        },
        command,
        {
          ...params,
          operationId,
          expectedProjectFileSha256: options.expectedProjectFileSha256,
        },
      );
    } catch (error) {
      if (!uncertainBridgeFailure(error)) throw error;
      const reconcileDeadline = Math.max(
        operationDeadline,
        Date.now() + PROJECT_SETTINGS_RECONCILE_GRACE_MS,
      );
      const reconciled = await reconcileProjectSettingOperation(options, operationId, reconcileDeadline);
      if (reconciled !== null) return reconciled;

      try {
        const stopped = await stopManagedRun({
          projectPath: options.projectPath,
          runId: options.runId,
          timeoutMs: 10_000,
        });
        const diskSha256 = await projectFileSha256(options.projectPath);
        throw new RuntimeFailure({
          code: "EDITOR_PROJECT_SETTING_RESULT_UNKNOWN",
          stage: "run",
          message: "The editor operation result could not be recovered after the managed editor stopped.",
          details: {
            operationId,
            state: stopped.state,
            beforeSha256: options.expectedProjectFileSha256,
            diskSha256,
            applied: diskSha256 !== options.expectedProjectFileSha256,
          },
          recovery: ["Read project.godot and restart the managed editor before deciding whether to retry."],
        });
      } catch (stopError) {
        if (stopError instanceof RuntimeFailure && stopError.payload.code === "EDITOR_PROJECT_SETTING_RESULT_UNKNOWN") {
          throw stopError;
        }
        const quarantineUntil = lease.markResultUnknown();
        throw new RuntimeFailure({
          code: "PROJECT_MUTATION_INDETERMINATE",
          stage: "run",
          message: "The editor operation and managed process could not be reconciled safely.",
          details: {
            operationId,
            quarantineUntil,
            cause: stopError instanceof Error ? stopError.message : String(stopError),
          },
          recovery: ["Do not write project.godot again until quarantineUntil, then reconcile its SHA-256."],
        });
      }
    }
  });
}

export async function getEditorProjectSetting(
  options: EditorProjectSettingGetOptions,
): Promise<EditorProjectSettingResult> {
  const parsed = EditorProjectSettingGetRequestSchema.safeParse({ key: options.key });
  if (!parsed.success) {
    throw editorInputFailure(
      "EDITOR_PROJECT_SETTING_INPUT_INVALID",
      "Project setting input is invalid.",
      parsed.error.issues,
    );
  }
  const info = await getEditorInfo(options);
  assertEditorCapability(info.capabilities, "project_settings");
  const result = EditorProjectSettingResultSchema.safeParse({
    ok: true,
    runId: options.runId,
    ...await sendBridgeCommand(options, "project_setting_get", parsed.data),
  });
  if (!result.success) throw editorInputFailure(
    "EDITOR_PROJECT_SETTING_RESULT_INVALID",
    "Editor returned an invalid project setting result.",
    result.error.issues,
  );
  return result.data;
}

export async function setEditorProjectSetting(
  options: EditorProjectSettingSetOptions,
): Promise<EditorProjectSettingMutationResult> {
  const parsed = EditorProjectSettingSetRequestSchema.safeParse({
    expectedProjectFingerprint: options.expectedProjectFingerprint,
    expectedProjectFileSha256: options.expectedProjectFileSha256,
    key: options.key,
    value: options.value,
  });
  if (!parsed.success) throw editorInputFailure(
    "EDITOR_PROJECT_SETTING_INPUT_INVALID",
    "Project setting input is invalid.",
    parsed.error.issues,
  );
  const raw = await runProjectSettingsMutation(
    options,
    "project_settings",
    "project_setting_set",
    { key: parsed.data.key, value: parsed.data.value },
  );
  const result = EditorProjectSettingMutationResultSchema.safeParse({
    ok: true,
    runId: options.runId,
    ...raw,
  });
  if (!result.success) throw editorInputFailure(
    "EDITOR_PROJECT_SETTING_RESULT_INVALID",
    "Editor returned an invalid project setting mutation result.",
    result.error.issues,
  );
  return result.data;
}

export async function upsertEditorInputAction(
  options: EditorInputActionUpsertOptions,
): Promise<EditorInputActionMutationResult> {
  const parsed = EditorInputActionUpsertRequestSchema.safeParse({
    expectedProjectFingerprint: options.expectedProjectFingerprint,
    expectedProjectFileSha256: options.expectedProjectFileSha256,
    name: options.name,
    deadzone: options.deadzone,
    replaceEvents: options.replaceEvents,
    events: options.events,
  });
  if (!parsed.success) throw editorInputFailure(
    "EDITOR_INPUT_ACTION_INPUT_INVALID",
    "Input action input is invalid.",
    parsed.error.issues,
  );
  const raw = await runProjectSettingsMutation(
    options,
    "input_map",
    "input_action_upsert",
    {
      name: parsed.data.name,
      deadzone: parsed.data.deadzone,
      replaceEvents: parsed.data.replaceEvents,
      events: parsed.data.events,
    },
  );
  const result = EditorInputActionMutationResultSchema.safeParse({
    ok: true,
    runId: options.runId,
    ...raw,
  });
  if (!result.success) throw editorInputFailure(
    "EDITOR_INPUT_ACTION_RESULT_INVALID",
    "Editor returned an invalid InputMap result.",
    result.error.issues,
  );
  return result.data;
}

export async function inspectEditorResourcePath(
  options: EditorResourceInspectOptions,
): Promise<EditorResourceInspectionResult> {
  const parsed = EditorResourceInspectRequestSchema.safeParse({
    path: options.path,
    ...(options.properties === undefined ? {} : { properties: options.properties }),
  });
  if (!parsed.success) throw editorInputFailure(
    "EDITOR_RESOURCE_INSPECT_INPUT_INVALID",
    "Resource inspection input is invalid.",
    parsed.error.issues,
  );
  const info = await getEditorInfo(options);
  assertEditorCapability(info.capabilities, "resource_inspect");
  const result = EditorResourceInspectionResultSchema.safeParse({
    ok: true,
    runId: options.runId,
    ...await sendBridgeCommand(options, "resource_inspect", parsed.data),
  });
  if (!result.success) throw editorInputFailure(
    "EDITOR_RESOURCE_INSPECT_RESULT_INVALID",
    "Editor returned an invalid resource inspection result.",
    result.error.issues,
  );
  return result.data;
}

async function prepareEditorMutation(options: EditorMutationLookupOptions): Promise<void> {
  await assertProjectFingerprint(options.projectPath, options.expectedProjectFingerprint);
  const expectedScenePath = options.expectedScenePath as unknown;
  if (typeof expectedScenePath !== "string" || expectedScenePath.length === 0) {
    throw new RuntimeFailure({
      code: "EDITOR_SCENE_PATH_REQUIRED",
      stage: "validation",
      message: "expectedScenePath is required for persistent editor mutations.",
      recovery: ["Read godot_editor_status and pass its exact scene path as expectedScenePath."],
    });
  }
  if (!expectedScenePath.startsWith("res://")) {
    throw new RuntimeFailure({
      code: "EDITOR_SCENE_PATH_INVALID",
      stage: "validation",
      message: "expectedScenePath must be a res:// scene path.",
      details: { expectedScenePath },
      recovery: ["Read godot_project_context or godot_editor_status and pass the exact scene path."],
    });
  }
}

async function prepareEditorHistoryMutation(options: EditorHistoryMutationOptions): Promise<void> {
  await prepareEditorMutation(options);
  const expectedHistoryVersion = options.expectedHistoryVersion as unknown;
  if (expectedHistoryVersion === undefined || expectedHistoryVersion === null) {
    throw new RuntimeFailure({
      code: "EDITOR_HISTORY_VERSION_REQUIRED",
      stage: "validation",
      message: "expectedHistoryVersion is required for scene save, undo, and redo.",
      recovery: ["Read godot_editor_status or the previous mutation receipt and pass its historyVersion."],
    });
  }
  if (!Number.isInteger(expectedHistoryVersion) || Number(expectedHistoryVersion) < 0) {
    throw new RuntimeFailure({
      code: "EDITOR_HISTORY_VERSION_INVALID",
      stage: "validation",
      message: "expectedHistoryVersion must be a non-negative integer.",
      details: { expectedHistoryVersion },
      recovery: ["Read godot_editor_status and pass its current historyVersion without modification."],
    });
  }
}

export async function batchEditorScene(
  options: EditorBatchOptions,
): Promise<EditorBatchResult> {
  const parsed = EditorBatchRequestSchema.safeParse({
    expectedScenePath: options.expectedScenePath,
    expectedProjectFingerprint: options.expectedProjectFingerprint,
    ...(options.actionName === undefined ? {} : { actionName: options.actionName }),
    operations: options.operations,
    confirmDestructive: options.confirmDestructive,
  });
  if (!parsed.success) {
    throw new RuntimeFailure({
      code: "EDITOR_BATCH_INPUT_INVALID",
      stage: "validation",
      message: "Editor batch input does not match the strict operation schema.",
      details: { issues: parsed.error.issues },
      recovery: ["Use one of the documented editor batch operations with only its declared fields."],
    });
  }
  await prepareEditorMutation({
    ...options,
    expectedProjectFingerprint: parsed.data.expectedProjectFingerprint,
    expectedScenePath: parsed.data.expectedScenePath,
  });
  const info = await getEditorInfo(options);
  assertEditorCapability(info.capabilities, "scene_batch");
  const result = await sendBridgeCommand(options, "scene_batch", parsed.data);
  const validated = EditorBatchResultSchema.safeParse({
    ok: true,
    runId: options.runId,
    ...result,
  });
  if (!validated.success) {
    throw new RuntimeFailure({
      code: "EDITOR_BATCH_RESULT_INVALID",
      stage: "protocol",
      message: "Editor bridge returned an invalid or unbounded batch result.",
      details: { issues: validated.error.issues },
      recovery: ["Install the matching Godot Agent Runtime addon and launch a fresh managed editor."],
    });
  }
  return validated.data;
}

export function assertEditorCapability(
  capabilities: readonly string[],
  capability: string,
): void {
  if (capabilities.includes(capability)) return;
  throw new RuntimeFailure({
    code: "EDITOR_CAPABILITY_UNAVAILABLE",
    stage: "protocol",
    message: `The managed editor does not advertise the required ${capability} capability.`,
    details: { capability, capabilities: [...capabilities] },
    recovery: ["Install the matching Godot Agent Runtime addon and launch a fresh managed editor."],
  });
}

export async function openEditorScene(
  options: EditorSceneOpenOptions,
): Promise<EditorSceneOpenResult> {
  const expectedProjectFingerprint = options.expectedProjectFingerprint as unknown;
  if (typeof expectedProjectFingerprint !== "string" || expectedProjectFingerprint.length === 0) {
    throw new RuntimeFailure({
      code: "PROJECT_FINGERPRINT_REQUIRED",
      stage: "validation",
      message: "expectedProjectFingerprint is required before opening an editor scene.",
      recovery: ["Read godot_project_context and pass identity.projectFingerprint."],
    });
  }
  await assertProjectFingerprint(options.projectPath, expectedProjectFingerprint);
  if (!options.scenePath.startsWith("res://") || !options.scenePath.toLowerCase().endsWith(".tscn")) {
    throw new RuntimeFailure({
      code: "EDITOR_SCENE_PATH_INVALID",
      stage: "validation",
      message: "scenePath must be a project-local res:// .tscn path.",
      details: { scenePath: options.scenePath },
      recovery: ["Choose a .tscn returned by the project files under res://."],
    });
  }
  const result = await sendBridgeCommand(options, "scene_open", {
    expectedProjectFingerprint,
    scenePath: options.scenePath,
  });
  return { ok: true, runId: options.runId, ...result } as EditorSceneOpenResult;
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
  await prepareEditorMutation(options);
  const result = await sendBridgeCommand(options, "node_create", {
    expectedScenePath: options.expectedScenePath,
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
  await prepareEditorMutation(options);
  const result = await sendBridgeCommand(options, "scene_instantiate", {
    expectedScenePath: options.expectedScenePath,
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
  await prepareEditorMutation(options);
  const result = await sendBridgeCommand(options, "node_update", {
    expectedScenePath: options.expectedScenePath,
    nodePath: options.nodePath,
    ...(options.name === undefined ? {} : { name: options.name }),
    properties: options.properties ?? {},
  });
  return { ok: true, runId: options.runId, ...result } as EditorMutationResult;
}

export async function deleteEditorNode(
  options: EditorNodeDeleteOptions,
): Promise<EditorMutationResult> {
  await prepareEditorMutation(options);
  const result = await sendBridgeCommand(options, "node_delete", {
    expectedScenePath: options.expectedScenePath,
    nodePath: options.nodePath,
  });
  return { ok: true, runId: options.runId, ...result } as EditorMutationResult;
}

export async function moveEditorNode(
  options: EditorNodeMoveOptions,
): Promise<EditorMutationResult> {
  await prepareEditorMutation(options);
  const result = await sendBridgeCommand(options, "node_move", {
    expectedScenePath: options.expectedScenePath,
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
  await prepareEditorMutation(options);
  const result = await sendBridgeCommand(options, "resource_create", {
    expectedScenePath: options.expectedScenePath,
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
  await prepareEditorMutation(options);
  const result = await sendBridgeCommand(options, "resource_update", {
    expectedScenePath: options.expectedScenePath,
    nodePath: options.nodePath,
    property: options.property,
    properties: options.properties,
  });
  return { ok: true, runId: options.runId, ...result } as EditorResourceResult;
}

export async function saveEditorResource(
  options: EditorResourceSaveOptions,
): Promise<EditorResourceSaveResult> {
  await prepareEditorMutation(options);
  const result = await sendBridgeCommand(options, "resource_save", {
    expectedScenePath: options.expectedScenePath,
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
  await prepareEditorMutation(options);
  const result = await sendBridgeCommand(options, "instance_set_editable", {
    expectedScenePath: options.expectedScenePath,
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
  await prepareEditorMutation(options);
  const result = await sendBridgeCommand(options, "signal_connect", {
    expectedScenePath: options.expectedScenePath,
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
  options: EditorHistoryMutationOptions,
): Promise<EditorSceneSaveResult> {
  await prepareEditorHistoryMutation(options);
  const result = await sendBridgeCommand(options, "scene_save", {
    expectedScenePath: options.expectedScenePath,
    expectedHistoryVersion: options.expectedHistoryVersion,
  });
  return { ok: true, runId: options.runId, ...result } as EditorSceneSaveResult;
}

export async function undoEditorAction(
  options: EditorHistoryMutationOptions,
): Promise<EditorHistoryResult> {
  await prepareEditorHistoryMutation(options);
  const result = await sendBridgeCommand(options, "history_undo", {
    expectedScenePath: options.expectedScenePath,
    expectedHistoryVersion: options.expectedHistoryVersion,
    ...(options.expectedActionName === undefined
      ? {}
      : { expectedActionName: options.expectedActionName }),
  });
  return { ok: true, runId: options.runId, ...result } as EditorHistoryResult;
}

export async function redoEditorAction(
  options: EditorHistoryMutationOptions,
): Promise<EditorHistoryResult> {
  await prepareEditorHistoryMutation(options);
  const result = await sendBridgeCommand(options, "history_redo", {
    expectedScenePath: options.expectedScenePath,
    expectedHistoryVersion: options.expectedHistoryVersion,
    ...(options.expectedActionName === undefined
      ? {}
      : { expectedActionName: options.expectedActionName }),
  });
  return { ok: true, runId: options.runId, ...result } as EditorHistoryResult;
}

export async function captureEditorScreenshot(
  options: EditorScreenshotOptions,
): Promise<EditorScreenshotResult> {
  const result = await sendBridgeCommand(options, "screenshot", {
    ...(options.expectedScenePath === undefined
      ? {}
      : { expectedScenePath: options.expectedScenePath }),
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
  const [buffer, information, evidence] = await Promise.all([
    readFile(path),
    stat(path),
    createEditorEvidenceMetadata({
      projectPath: options.projectPath,
      runId: options.runId,
      receipt: {
        capturedAt: result.capturedAt,
        scenePath: result.scenePath,
      },
    }),
  ]);
  return {
    ok: true,
    runId: options.runId,
    path,
    width: Number(result.width),
    height: Number(result.height),
    bytes: information.size,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    evidence,
    viewport: result.viewport as "2d" | "3d",
    viewportIndex: result.viewportIndex === null ? null : Number(result.viewportIndex),
    camera: result.camera as EditorScreenshotResult["camera"],
  };
}
