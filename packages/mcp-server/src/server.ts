import {
  McpServer,
  type CallToolResult,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  checkProject,
  checkScript,
  assertRuntime,
  batchEditorScene,
  captureEditorScreenshot,
  captureRuntimeScreenshot,
  controlRuntime,
  connectEditorSignal,
  createInheritedEditorScene,
  createEditorNode,
  createEditorResource,
  deleteEditorNode,
  findProjects,
  findRuntimeUi,
  focusEditorResource,
  getEditorProjectSetting,
  getEditorInstance,
  getEditorInfo,
  getEditorNode,
  getEditorSceneTree,
  getEditorSelection,
  getEditorResource,
  inspectEditorResourcePath,
  getManagedRunStatus,
  getDiagnosticsSummary,
  getAgentGuide,
  getProjectContext,
  getRuntimeInfo,
  getRuntimeNode,
  observeRuntime,
  projectRuntime3D,
  raycastRuntime3D,
  getRuntimeSceneTree,
  inspectProject,
  injectRuntimeInput,
  injectRuntimeInputSequence,
  installGodotAddon,
  instantiateEditorScene,
  launchEditor,
  launchProject,
  moveEditorNode,
  openEditorScene,
  readManagedLogs,
  readProjectFile,
  replaceProjectText,
  redoEditorAction,
  runDoctor,
  createDebugReport,
  runProject,
  stopManagedRun,
  saveEditorScene,
  saveEditorResource,
  simulateRuntimePhysics,
  setEditorSelection,
  setEditorProjectSetting,
  setEditorInstanceEditable,
  toRuntimeError,
  writeProjectFile,
  updateEditorNode,
  updateEditorResource,
  upsertEditorInputAction,
  undoEditorAction,
  waitForRuntime,
  type RuntimeUiSelector,
} from "@godot-agent-runtime/core";
import {
  DoctorResultSchema,
  AgentGuideResultSchema,
  DebugReportResultSchema,
  DiagnosticsSummarySchema,
  AddonInstallResultSchema,
  EditorBatchRequestSchema,
  EditorBatchResultSchema,
  EditorInputActionMutationResultSchema,
  EditorInputActionUpsertRequestSchema,
  EditorBridgeInfoSchema,
  EditorHistoryResultSchema,
  EditorInheritedSceneResultSchema,
  EditorInstanceMutationResultSchema,
  EditorInstanceResultSchema,
  EditorMutationResultSchema,
  EditorProjectSettingGetRequestSchema,
  EditorProjectSettingMutationResultSchema,
  EditorProjectSettingResultSchema,
  EditorProjectSettingSetRequestSchema,
  EditorNodeResultSchema,
  EditorResourceResultSchema,
  EditorResourceInspectRequestSchema,
  EditorResourceInspectionResultSchema,
  EditorResourceReadResultSchema,
  EditorResourceFocusResultSchema,
  EditorResourceSaveResultSchema,
  EditorSceneSaveResultSchema,
  EditorSceneOpenResultSchema,
  EditorSceneTreeResultSchema,
  EditorScreenshotResultSchema,
  EditorSelectionResultSchema,
  EditorSignalConnectionResultSchema,
  GodotLaunchResultSchema,
  GodotRunResultSchema,
  GodotRunStatusSchema,
  LogCursorSchema,
  LogReadResultSchema,
  ProjectDiscoveryResultSchema,
  ProjectContextSchema,
  ProjectInfoSchema,
  RuntimeAssertionResultSchema,
  RuntimeBridgeInfoSchema,
  RuntimeControlResultSchema,
  RuntimeInputResultSchema,
  RuntimeInputSequenceResultSchema,
  RuntimeNodeResultSchema,
  RuntimeObservationResultSchema,
  RuntimeProjection3DResultSchema,
  RuntimeRaycast3DResultSchema,
  RuntimeSceneTreeResultSchema,
  RuntimeScreenshotResultSchema,
  RuntimeSimulationResultSchema,
  RuntimeUiResultSchema,
  RuntimeWaitResultSchema,
  SafeFileReadResultSchema,
  SafeFileWriteResultSchema,
  SafeTextReplaceResultSchema,
  ScriptCheckResultSchema,
  FileMutationGuardSchema,
  Sha256Schema,
  RecipeIdSchema,
} from "@godot-agent-runtime/protocol";

const ConfigInputSchema = z.object({
  configPath: z.string().min(1).optional(),
});

const ProjectInputSchema = z.object({
  projectPath: z.string().min(1),
});

const ProjectContextInputSchema = z.object({
  projectPath: z.string().min(1),
  editorRunId: z.uuid().optional(),
  runtimeRunId: z.uuid().optional(),
}).strict();

const AgentGuideInputSchema = z.object({
  recipeId: RecipeIdSchema.optional(),
}).strict();

const ProjectDiscoveryInputSchema = z.object({
  searchRoot: z.string().min(1),
  maxDepth: z.number().int().min(0).max(12).default(4),
  maxProjects: z.number().int().min(1).max(500).default(100),
});

const GodotOperationInputSchema = z.object({
  projectPath: z.string().min(1),
  configPath: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
  maxOutputBytes: z.number().int().min(1_024).max(1_048_576).optional(),
});

const ScriptCheckInputSchema = z.object({
  projectPath: z.string().min(1),
  path: z.string().min(1),
  configPath: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
  maxOutputBytes: z.number().int().min(1_024).max(1_048_576).optional(),
}).strict();

const RunInputSchema = GodotOperationInputSchema.extend({
  scene: z.string().min(1).optional(),
});

const LaunchInputSchema = z.object({
  projectPath: z.string().min(1),
  configPath: z.string().min(1).optional(),
  scene: z.string().min(1).optional(),
  startupTimeoutMs: z.number().int().min(100).max(120_000).optional(),
});

const RunLookupInputSchema = z.object({
  projectPath: z.string().min(1),
  runId: z.uuid(),
  maxOutputBytes: z.number().int().min(1_024).max(1_048_576).optional(),
});

const LogReadInputSchema = z.object({
  projectPath: z.string().min(1),
  runId: z.uuid(),
  cursor: LogCursorSchema.optional(),
  stream: z.enum(["stdout", "stderr", "combined"]).default("combined"),
  minimumSeverity: z.enum(["error", "warning", "info"]).default("info"),
  contains: z.string().min(1).max(1024).optional(),
  maxLines: z.number().int().min(1).max(500).default(100),
  deduplicate: z.boolean().default(false),
  raw: z.boolean().default(false),
}).strict();

const DiagnosticsInputSchema = z.object({
  projectPath: z.string().min(1),
  runId: z.uuid(),
  cursor: LogCursorSchema.optional(),
  maxIssues: z.number().int().min(1).max(50).default(50),
}).strict();

const DebugReportInputSchema = z.object({
  projectPath: z.string().min(1),
  expectedProjectFingerprint: Sha256Schema,
  issue: z.string().min(1).max(16_384),
  runId: z.uuid().optional(),
  reproduction: z.string().min(1).max(32_768).optional(),
  cursor: LogCursorSchema.optional(),
  format: z.enum(["markdown", "json"]).default("markdown"),
}).strict();

const StopInputSchema = RunLookupInputSchema.extend({
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
});

const RuntimeLookupInputSchema = z.object({
  projectPath: z.string().min(1),
  runId: z.uuid(),
  timeoutMs: z.number().int().min(100).max(30_000).optional(),
});

const RuntimeScreenshotInputSchema = RuntimeLookupInputSchema.extend({
  expectedScenePath: z.string().startsWith("res://").endsWith(".tscn").optional(),
});

const RuntimeSelectorSchema = z.object({
  path: z.string().min(1).optional(),
  text: z.string().min(1).optional(),
  type: z.string().min(1).optional(),
  visibleOnly: z.boolean().default(true),
});

const RuntimeUiInputSchema = RuntimeLookupInputSchema.extend({
  selector: RuntimeSelectorSchema.optional(),
  limit: z.number().int().min(1).max(500).default(100),
});

const RuntimeSceneTreeInputSchema = RuntimeLookupInputSchema.extend({
  maxDepth: z.number().int().min(0).max(64).default(16),
  maxNodes: z.number().int().min(1).max(5000).default(2000),
});

const RuntimeNodeLookupInputSchema = RuntimeLookupInputSchema.extend({
  nodePath: z.string().min(1),
  properties: z.array(z.string().min(1)).max(100).default([]),
});

const RuntimeObserveInputSchema = RuntimeLookupInputSchema.extend({
  nodePaths: z.array(z.string().min(1)).min(1).max(32),
  properties: z.array(z.string().min(1)).max(32).default([]),
});

const RuntimeSimulationInputSchema = RuntimeLookupInputSchema.extend({
  nodePath: z.string().min(1),
  frames: z.number().int().min(1).max(120).default(1),
  properties: z.array(z.string().min(1)).min(1).max(32)
    .default(["position", "global_position", "velocity"]),
  action: z.string().min(1).optional(),
  strength: z.number().min(0).max(1).optional(),
});

const RuntimeProjection3DInputSchema = RuntimeLookupInputSchema.extend({
  cameraPath: z.string().min(1).optional(),
  nodePath: z.string().min(1).optional(),
  worldPosition: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(),
}).superRefine((value, context) => {
  if ((value.nodePath === undefined) === (value.worldPosition === undefined)) {
    context.addIssue({ code: "custom", message: "provide exactly one of nodePath or worldPosition" });
  }
});

const RuntimeRaycast3DInputSchema = RuntimeLookupInputSchema.extend({
  cameraPath: z.string().min(1).optional(),
  screenPosition: z.object({ x: z.number(), y: z.number() }),
  maxDistance: z.number().positive().max(100_000).default(1_000),
  collisionMask: z.number().int().min(0).max(4_294_967_295).default(4_294_967_295),
  collideWithBodies: z.boolean().default(true),
  collideWithAreas: z.boolean().default(false),
});

const RuntimeInputSchema = RuntimeLookupInputSchema.extend({
  kind: z.enum(["click", "action", "key"]),
  path: z.string().min(1).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  button: z.number().int().min(1).max(9).optional(),
  action: z.string().min(1).optional(),
  strength: z.number().min(0).max(1).optional(),
  holdMs: z.number().int().min(0).max(2_000).optional(),
  keycode: z.number().int().positive().optional(),
}).superRefine((value, context) => {
  if (value.kind === "click" && value.path === undefined && (value.x === undefined || value.y === undefined)) {
    context.addIssue({ code: "custom", message: "click requires path or both x and y" });
  }
  if (value.kind === "action" && value.action === undefined) {
    context.addIssue({ code: "custom", message: "action input requires action" });
  }
  if (value.kind === "key" && value.keycode === undefined) {
    context.addIssue({ code: "custom", message: "key input requires keycode" });
  }
});

const RuntimeInputSequenceStepSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("click"),
    path: z.string().min(1).optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    button: z.number().int().min(1).max(9).optional(),
    afterMs: z.number().int().min(0).max(1_000).optional(),
  }).superRefine((value, context) => {
    if (value.path === undefined && (value.x === undefined || value.y === undefined)) {
      context.addIssue({ code: "custom", message: "click requires path or both x and y" });
    }
  }),
  z.object({
    kind: z.literal("action"),
    action: z.string().min(1),
    strength: z.number().min(0).max(1).optional(),
    holdMs: z.number().int().min(0).max(2_000).optional(),
    afterMs: z.number().int().min(0).max(1_000).optional(),
  }),
  z.object({
    kind: z.literal("key"),
    keycode: z.number().int().positive(),
    holdMs: z.number().int().min(0).max(2_000).optional(),
    afterMs: z.number().int().min(0).max(1_000).optional(),
  }),
]);

const RuntimeInputSequenceSchema = RuntimeLookupInputSchema.extend({
  steps: z.array(RuntimeInputSequenceStepSchema).min(1).max(32),
}).superRefine((value, context) => {
  const totalDuration = value.steps.reduce(
    (sum, step) => sum + ("holdMs" in step ? (step.holdMs ?? 0) : 0) + (step.afterMs ?? 0),
    0,
  );
  if (totalDuration > 5_000) {
    context.addIssue({ code: "custom", message: "combined holdMs and afterMs must not exceed 5000" });
  }
});

const RuntimeAssertInputSchema = RuntimeLookupInputSchema.extend({
  kind: z.enum(["ui_exists", "property"]),
  selector: RuntimeSelectorSchema.optional(),
  expectedExists: z.boolean().optional(),
  nodePath: z.string().min(1).optional(),
  property: z.string().min(1).optional(),
  operator: z.enum(["equals", "not_equals", "gt", "gte", "lt", "lte", "contains"]).optional(),
  expected: z.unknown().optional(),
}).superRefine((value, context) => {
  if (value.kind === "ui_exists" && value.selector === undefined) {
    context.addIssue({ code: "custom", message: "ui_exists requires selector" });
  }
  if (value.kind === "property" && (value.nodePath === undefined || value.property === undefined || value.expected === undefined)) {
    context.addIssue({ code: "custom", message: "property assertion requires nodePath, property, and expected" });
  }
});

const RuntimeWaitInputSchema = RuntimeLookupInputSchema.extend({
  kind: z.enum(["ui_exists", "property"]),
  selector: RuntimeSelectorSchema.optional(),
  expectedExists: z.boolean().optional(),
  nodePath: z.string().min(1).optional(),
  property: z.string().min(1).optional(),
  operator: z.enum(["equals", "not_equals", "gt", "gte", "lt", "lte", "contains"]).optional(),
  expected: z.unknown().optional(),
  waitTimeoutMs: z.number().int().min(0).max(30_000).default(1_000),
  pollEveryFrames: z.number().int().min(1).max(60).default(1),
}).superRefine((value, context) => {
  if (value.kind === "ui_exists" && value.selector === undefined) {
    context.addIssue({ code: "custom", message: "ui_exists requires selector" });
  }
  if (value.kind === "property" && (value.nodePath === undefined || value.property === undefined || value.expected === undefined)) {
    context.addIssue({ code: "custom", message: "property wait requires nodePath, property, and expected" });
  }
});

const RuntimeControlInputSchema = RuntimeLookupInputSchema.extend({
  action: z.enum(["pause", "resume", "step", "step_physics"]),
  frames: z.number().int().min(1).max(120).optional(),
});

const EditorNodeLookupInputSchema = RuntimeLookupInputSchema.extend({
  nodePath: z.string().min(1),
  properties: z.array(z.string().min(1)).max(100).default([]),
});

const EditorMutationLookupInputSchema = RuntimeLookupInputSchema.extend({
  expectedProjectFingerprint: Sha256Schema.optional(),
  expectedScenePath: z.string().startsWith("res://").endsWith(".tscn"),
});

const EditorHistoryMutationInputSchema = EditorMutationLookupInputSchema.extend({
  expectedHistoryVersion: z.number().int().nonnegative(),
  expectedActionName: z.string().min(1).optional(),
});

const EditorSceneOpenInputSchema = RuntimeLookupInputSchema.extend({
  expectedProjectFingerprint: Sha256Schema,
  scenePath: z.string().startsWith("res://").endsWith(".tscn"),
});

const EditorPropertiesSchema = z.record(z.string().min(1), z.unknown()).refine(
  (value) => Object.keys(value).length <= 100,
  "properties must contain at most 100 entries",
);

const EditorNodeCreateInputSchema = EditorMutationLookupInputSchema.extend({
  parentPath: z.string().min(1),
  type: z.string().min(1),
  name: z.string().min(1),
  properties: EditorPropertiesSchema.default({}),
});

const EditorSceneInstantiateInputSchema = EditorMutationLookupInputSchema.extend({
  parentPath: z.string().min(1),
  scenePath: z.string().startsWith("res://").endsWith(".tscn"),
  name: z.string().min(1).optional(),
  properties: EditorPropertiesSchema.default({}),
});

const EditorSceneInheritanceInputSchema = RuntimeLookupInputSchema.extend({
  sourceScenePath: z.string().startsWith("res://").endsWith(".tscn"),
  targetScenePath: z.string().startsWith("res://").endsWith(".tscn"),
  rootName: z.string().min(1).optional(),
  rootProperties: EditorPropertiesSchema.default({}),
  open: z.boolean().default(false),
  overwrite: z.boolean().default(false),
});

const EditorNodeUpdateInputSchema = EditorMutationLookupInputSchema.extend({
  nodePath: z.string().min(1),
  name: z.string().min(1).optional(),
  properties: EditorPropertiesSchema.default({}),
}).superRefine((value, context) => {
  if (value.name === undefined && Object.keys(value.properties).length === 0) {
    context.addIssue({ code: "custom", message: "update requires name or properties" });
  }
});

const EditorNodeDeleteInputSchema = EditorMutationLookupInputSchema.extend({
  nodePath: z.string().min(1),
});

const EditorNodeMoveInputSchema = EditorMutationLookupInputSchema.extend({
  nodePath: z.string().min(1),
  newParentPath: z.string().min(1),
  index: z.number().int().min(-1).optional(),
  keepGlobalTransform: z.boolean().default(true),
});

const EditorResourceCreateInputSchema = EditorMutationLookupInputSchema.extend({
  nodePath: z.string().min(1),
  property: z.string().min(1),
  type: z.string().min(1),
  properties: EditorPropertiesSchema.default({}),
});

const EditorResourceLookupInputSchema = RuntimeLookupInputSchema.extend({
  nodePath: z.string().min(1),
  property: z.string().min(1),
  properties: z.array(z.string().min(1)).max(100).default([]),
});

const EditorResourceUpdateInputSchema = EditorMutationLookupInputSchema.extend({
  nodePath: z.string().min(1),
  property: z.string().min(1),
  properties: EditorPropertiesSchema.refine(
    (value) => Object.keys(value).length > 0,
    "resource update requires at least one property",
  ),
});

const EditorInstanceLookupInputSchema = RuntimeLookupInputSchema.extend({
  nodePath: z.string().min(1),
});

const EditorInstanceSetEditableInputSchema = EditorMutationLookupInputSchema.extend({
  nodePath: z.string().min(1),
  editable: z.boolean(),
});

const EditorResourceSaveInputSchema = EditorMutationLookupInputSchema.extend({
  nodePath: z.string().min(1),
  property: z.string().min(1),
  path: z.string().startsWith("res://").endsWith(".tres"),
  overwrite: z.boolean().default(false),
});

const EditorResourceFocusInputSchema = RuntimeLookupInputSchema.extend({
  path: z.string().startsWith("res://"),
});

const EditorSelectionSetInputSchema = RuntimeLookupInputSchema.extend({
  paths: z.array(z.string().min(1)).max(100),
  focus: z.boolean().default(true),
});

const EditorScreenshotInputSchema = RuntimeScreenshotInputSchema.extend({
  viewport: z.enum(["2d", "3d"]).default("2d"),
  viewportIndex: z.number().int().min(0).max(3).default(0),
});

const EditorSignalConnectInputSchema = EditorMutationLookupInputSchema.extend({
  sourcePath: z.string().min(1),
  signal: z.string().min(1),
  targetPath: z.string().min(1),
  method: z.string().min(1),
  flags: z.number().int().min(0).max(15).optional(),
});

const EditorBatchInputSchema = EditorBatchRequestSchema.safeExtend({
  projectPath: z.string().min(1),
  runId: z.uuid(),
  timeoutMs: z.number().int().min(100).max(30_000).optional(),
});

const EditorProjectSettingGetInputSchema = EditorProjectSettingGetRequestSchema.safeExtend({
  projectPath: z.string().min(1),
  runId: z.uuid(),
  timeoutMs: z.number().int().min(100).max(30_000).optional(),
});

const EditorProjectSettingSetInputSchema = EditorProjectSettingSetRequestSchema.safeExtend({
  projectPath: z.string().min(1),
  runId: z.uuid(),
  timeoutMs: z.number().int().min(100).max(30_000).optional(),
});

const EditorInputActionUpsertInputSchema = EditorInputActionUpsertRequestSchema.safeExtend({
  projectPath: z.string().min(1),
  runId: z.uuid(),
  timeoutMs: z.number().int().min(100).max(30_000).optional(),
});

const EditorResourceInspectInputSchema = EditorResourceInspectRequestSchema.safeExtend({
  projectPath: z.string().min(1),
  runId: z.uuid(),
  timeoutMs: z.number().int().min(100).max(30_000).optional(),
});

function acceptMissingRequiredGuards<Schema extends StandardSchemaWithJSON>(
  advertisedSchema: Schema,
  acceptedSchema: StandardSchemaWithJSON,
): Schema {
  const advertised = advertisedSchema["~standard"];
  const accepted = acceptedSchema["~standard"];
  const schema: StandardSchemaWithJSON = {
    "~standard": {
      version: 1,
      vendor: "godot-agent-runtime",
      validate: (value, options) => accepted.validate(value, options),
      jsonSchema: {
        input: (options) => advertised.jsonSchema.input(options),
        output: (options) => advertised.jsonSchema.output(options),
      },
    },
  };
  return schema as Schema;
}

const EditorNodeCreateHandlerInputSchema = acceptMissingRequiredGuards(
  EditorNodeCreateInputSchema,
  EditorNodeCreateInputSchema.partial({ expectedScenePath: true }),
);
const EditorSceneInstantiateHandlerInputSchema = acceptMissingRequiredGuards(
  EditorSceneInstantiateInputSchema,
  EditorSceneInstantiateInputSchema.partial({ expectedScenePath: true }),
);
const EditorInstanceSetEditableHandlerInputSchema = acceptMissingRequiredGuards(
  EditorInstanceSetEditableInputSchema,
  EditorInstanceSetEditableInputSchema.partial({ expectedScenePath: true }),
);
const EditorNodeUpdateHandlerInputSchema = acceptMissingRequiredGuards(
  EditorNodeUpdateInputSchema,
  EditorMutationLookupInputSchema.partial({ expectedScenePath: true }).extend({
    nodePath: z.string().min(1),
    name: z.string().min(1).optional(),
    properties: EditorPropertiesSchema.default({}),
  }).superRefine((value, context) => {
    if (value.name === undefined && Object.keys(value.properties).length === 0) {
      context.addIssue({ code: "custom", message: "update requires name or properties" });
    }
  }),
);
const EditorNodeDeleteHandlerInputSchema = acceptMissingRequiredGuards(
  EditorNodeDeleteInputSchema,
  EditorNodeDeleteInputSchema.partial({ expectedScenePath: true }),
);
const EditorNodeMoveHandlerInputSchema = acceptMissingRequiredGuards(
  EditorNodeMoveInputSchema,
  EditorNodeMoveInputSchema.partial({ expectedScenePath: true }),
);
const EditorResourceCreateHandlerInputSchema = acceptMissingRequiredGuards(
  EditorResourceCreateInputSchema,
  EditorResourceCreateInputSchema.partial({ expectedScenePath: true }),
);
const EditorResourceUpdateHandlerInputSchema = acceptMissingRequiredGuards(
  EditorResourceUpdateInputSchema,
  EditorResourceUpdateInputSchema.partial({ expectedScenePath: true }),
);
const EditorResourceSaveHandlerInputSchema = acceptMissingRequiredGuards(
  EditorResourceSaveInputSchema,
  EditorResourceSaveInputSchema.partial({ expectedScenePath: true }),
);
const EditorSignalConnectHandlerInputSchema = acceptMissingRequiredGuards(
  EditorSignalConnectInputSchema,
  EditorSignalConnectInputSchema.partial({ expectedScenePath: true }),
);
const EditorHistoryMutationHandlerInputSchema = acceptMissingRequiredGuards(
  EditorHistoryMutationInputSchema,
  EditorHistoryMutationInputSchema.partial({
    expectedScenePath: true,
    expectedHistoryVersion: true,
  }),
);
const EditorSceneSaveInputSchema = EditorHistoryMutationInputSchema.omit({ expectedActionName: true });
const EditorSceneSaveHandlerInputSchema = acceptMissingRequiredGuards(
  EditorSceneSaveInputSchema,
  EditorSceneSaveInputSchema.partial({
    expectedScenePath: true,
    expectedHistoryVersion: true,
  }),
);

const FileReadInputSchema = z.object({
  projectPath: z.string().min(1),
  path: z.string().min(1),
  maxBytes: z.number().int().min(1).max(1_048_576).optional(),
}).strict();

const BoundedUtf8TextSchema = z.string().refine(
  (value) => Buffer.byteLength(value, "utf8") <= 1_048_576,
  { message: "UTF-8 text must not exceed 1048576 bytes." },
);

const FileWriteInputSchema = FileReadInputSchema.extend({
  content: BoundedUtf8TextSchema,
  guard: FileMutationGuardSchema.optional(),
  expectedSha256: Sha256Schema.nullable().optional(),
  expectedProjectFingerprint: Sha256Schema.optional(),
  createDirectories: z.boolean().default(false),
}).strict();

const FileReplaceInputSchema = FileReadInputSchema.extend({
  expectedProjectFingerprint: Sha256Schema,
  oldText: BoundedUtf8TextSchema.refine((value) => value.length > 0, {
    message: "oldText must not be empty.",
  }),
  newText: BoundedUtf8TextSchema,
  replaceAll: z.boolean().default(false),
}).strict();

function success(structuredContent: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function failure(error: unknown): CallToolResult {
  const structuredContent = { ok: false, error: toRuntimeError(error) };
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError: true,
  };
}

function runtimeSelector(value: z.infer<typeof RuntimeSelectorSchema>): RuntimeUiSelector {
  return {
    visibleOnly: value.visibleOnly,
    ...(value.path === undefined ? {} : { path: value.path }),
    ...(value.text === undefined ? {} : { text: value.text }),
    ...(value.type === undefined ? {} : { type: value.type }),
  };
}

async function handle<T extends Record<string, unknown>>(
  tool: string,
  operation: () => Promise<T>,
): Promise<CallToolResult> {
  const started = performance.now();
  try {
    const result = await operation();
    logMcpCall({
      tool,
      ok: true,
      durationMs: Math.round(performance.now() - started),
      code: null,
      stage: null,
    });
    return success(result);
  } catch (error) {
    const payload = toRuntimeError(error);
    logMcpCall({
      tool,
      ok: false,
      durationMs: Math.round(performance.now() - started),
      code: payload.code,
      stage: payload.stage,
    });
    return failure(error);
  }
}

interface McpCallLog {
  readonly tool: string;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly code: string | null;
  readonly stage: string | null;
}

function logMcpCall(record: McpCallLog): void {
  if (record.ok && process.env.GODOT_AGENT_RUNTIME_MCP_DEBUG !== "1") return;
  process.stderr.write(`${JSON.stringify({
    tool: record.tool,
    ok: record.ok,
    durationMs: record.durationMs,
    code: record.code,
    stage: record.stage,
  })}\n`);
}

function loggedInputSchema<Schema extends StandardSchemaWithJSON>(tool: string, schema: Schema): Schema {
  const standard = schema["~standard"];
  const logged: StandardSchemaWithJSON = {
    "~standard": {
      version: 1,
      vendor: "godot-agent-runtime",
      validate: async (value, options) => {
        const started = performance.now();
        try {
          const result = await standard.validate(value, options);
          if (result.issues !== undefined) {
            logMcpCall({
              tool,
              ok: false,
              durationMs: Math.round(performance.now() - started),
              code: "MCP_INPUT_INVALID",
              stage: "validation",
            });
          }
          return result;
        } catch (error) {
          logMcpCall({
            tool,
            ok: false,
            durationMs: Math.round(performance.now() - started),
            code: "MCP_INPUT_INVALID",
            stage: "validation",
          });
          throw error;
        }
      },
      jsonSchema: standard.jsonSchema,
    },
  };
  return logged as Schema;
}

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "godot-agent-runtime", version: "0.2.0" },
    {
      instructions:
        "Start with godot_project_context; do not guess project or main-scene identity. Call godot_agent_guide when a detailed playbook or recipe is needed. Follow the fixed ladder: context, compile, edit, visual evidence, runtime observation, interactive wait/assert, cleanup. Use guarded file writes and typed editor batches. Run script/project checks before runtime claims. Call godot_diagnostics before bounded log reads. Screenshots prove only their evidence class; interaction requires godot_runtime_assert (normally after godot_runtime_wait). Always stop every managed process with godot_run_stop.",
    },
  );

  server.registerTool(
    "godot_doctor",
    {
      title: "Diagnose Godot development environment",
      description:
        "Checks Node.js, local configuration, Godot, optional DeepSeek Harness, and loopback TCP readiness.",
      inputSchema: loggedInputSchema("godot_doctor", ConfigInputSchema),
      outputSchema: DoctorResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ configPath }) =>
      await handle("godot_doctor", async () => {
        const result = await runDoctor(configPath);
        return result;
      }),
  );

  server.registerTool(
    "godot_projects_find",
    {
      title: "Find Godot projects",
      description:
        "Searches a bounded directory tree for project.godot files and returns stable project metadata.",
      inputSchema: loggedInputSchema("godot_projects_find", ProjectDiscoveryInputSchema),
      outputSchema: ProjectDiscoveryResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ searchRoot, maxDepth, maxProjects }) =>
      await handle("godot_projects_find", async () =>
        await findProjects(searchRoot, { maxDepth, maxProjects }),
      ),
  );

  server.registerTool(
    "godot_project_inspect",
    {
      title: "Inspect a Godot project",
      description:
        "Reads project.godot and returns the project name, main scene, renderer, and enabled plugins.",
      inputSchema: loggedInputSchema("godot_project_inspect", ProjectInputSchema),
      outputSchema: ProjectInfoSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ projectPath }) => await handle("godot_project_inspect", async () => await inspectProject(projectPath)),
  );

  server.registerTool(
    "godot_project_context",
    {
      title: "Get explicit Godot project context",
      description:
        "Returns project metadata and identity, plus editor/runtime bridge information only for explicitly supplied run IDs.",
      inputSchema: loggedInputSchema("godot_project_context", ProjectContextInputSchema),
      outputSchema: ProjectContextSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ projectPath, editorRunId, runtimeRunId }) =>
      await handle("godot_project_context", async () =>
        await getProjectContext({
          projectPath,
          ...(editorRunId === undefined ? {} : { editorRunId }),
          ...(runtimeRunId === undefined ? {} : { runtimeRunId }),
        }),
      ),
  );

  server.registerTool(
    "godot_agent_guide",
    {
      title: "Read the Godot agent playbook or one task recipe",
      description:
        "Returns static, read-only guidance from Core. Omit recipeId for the playbook and summaries, or select one complete recipe; it never executes a workflow or stores task state.",
      inputSchema: loggedInputSchema("godot_agent_guide", AgentGuideInputSchema),
      outputSchema: AgentGuideResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ recipeId }) =>
      await handle("godot_agent_guide", async () =>
        recipeId === undefined ? getAgentGuide() : getAgentGuide(recipeId),
      ),
  );

  server.registerTool(
    "godot_project_check",
    {
      title: "Import and validate a Godot project",
      description:
        "Starts the configured Godot editor in headless mode, imports the project, and returns bounded diagnostics.",
      inputSchema: loggedInputSchema("godot_project_check", GodotOperationInputSchema),
      outputSchema: GodotRunResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ projectPath, configPath, timeoutMs, maxOutputBytes }) =>
      await handle("godot_project_check", async () =>
        await checkProject({
          projectPath,
          ...(configPath === undefined ? {} : { configPath }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
        }),
      ),
  );

  server.registerTool(
    "godot_script_check",
    {
      title: "Check one GDScript file",
      description:
        "Runs the configured Godot editor with --script and --check-only for one project-internal, non-linked .gd file.",
      inputSchema: loggedInputSchema("godot_script_check", ScriptCheckInputSchema),
      outputSchema: ScriptCheckResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ projectPath, path, configPath, timeoutMs, maxOutputBytes }) =>
      await handle("godot_script_check", async () =>
        await checkScript({
          projectPath,
          path,
          ...(configPath === undefined ? {} : { configPath }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
        }),
      ),
  );

  server.registerTool(
    "godot_file_read",
    {
      title: "Read a Godot project text file",
      description:
        "Reads a bounded UTF-8 Godot project file without following symlinks. Returns SHA-256 for conflict-safe writes.",
      inputSchema: loggedInputSchema("godot_file_read", FileReadInputSchema),
      outputSchema: SafeFileReadResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ projectPath, path, maxBytes }) =>
      await handle("godot_file_read", async () =>
        await readProjectFile({
          projectPath,
          path,
          ...(maxBytes === undefined ? {} : { maxBytes }),
        }),
      ),
  );

  server.registerTool(
    "godot_file_write",
    {
      title: "Safely write a Godot project text file",
      description:
        "Creates or updates an allowlisted UTF-8 project file under an explicit create or SHA-256 match guard. The lease coordinates participating MCP/CLI processes; external editors do not honor it, so the SHA-256 is rechecked immediately before publish and this is not a general cross-process filesystem transaction.",
      inputSchema: loggedInputSchema("godot_file_write", FileWriteInputSchema),
      outputSchema: SafeFileWriteResultSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({
      projectPath,
      path,
      content,
      guard,
      expectedSha256,
      expectedProjectFingerprint,
      createDirectories,
      maxBytes,
    }) =>
      await handle("godot_file_write", async () =>
        await writeProjectFile({
          projectPath,
          path,
          content,
          createDirectories,
          ...(guard === undefined ? {} : { guard }),
          ...(expectedSha256 === undefined ? {} : { expectedSha256 }),
          ...(expectedProjectFingerprint === undefined
            ? {}
            : { expectedProjectFingerprint }),
          ...(maxBytes === undefined ? {} : { maxBytes }),
        }),
      ),
  );

  server.registerTool(
    "godot_file_replace",
    {
      title: "Replace text in a Godot project file",
      description:
        "Reads and replaces oldText under the expected project fingerprint and a server-side SHA-256 match guard. By default oldText must occur exactly once; replaceAll opts into replacing every bounded match.",
      inputSchema: loggedInputSchema("godot_file_replace", FileReplaceInputSchema),
      outputSchema: SafeTextReplaceResultSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({
      projectPath,
      path,
      expectedProjectFingerprint,
      oldText,
      newText,
      replaceAll,
      maxBytes,
    }) =>
      await handle("godot_file_replace", async () =>
        await replaceProjectText({
          projectPath,
          path,
          expectedProjectFingerprint,
          oldText,
          newText,
          replaceAll,
          ...(maxBytes === undefined ? {} : { maxBytes }),
        }),
      ),
  );

  server.registerTool(
    "godot_addon_install",
    {
      title: "Install the Godot Agent Runtime addon",
      description: "Copies the versioned EditorPlugin into the project and enables it while preserving existing enabled plugins.",
      inputSchema: loggedInputSchema("godot_addon_install", ProjectInputSchema),
      outputSchema: AddonInstallResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath }) =>
      await handle("godot_addon_install", async () => ({ ...(await installGodotAddon(projectPath)) })),
  );

  server.registerTool(
    "godot_scene_run",
    {
      title: "Run a Godot scene headlessly",
      description:
        "Runs the main or specified scene for a bounded number of frames and returns console output and diagnostics.",
      inputSchema: loggedInputSchema("godot_scene_run", RunInputSchema),
      outputSchema: GodotRunResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ projectPath, configPath, timeoutMs, maxOutputBytes, scene }) =>
      await handle("godot_scene_run", async () =>
        await runProject({
          projectPath,
          ...(configPath === undefined ? {} : { configPath }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
          ...(scene === undefined ? {} : { scene }),
        }),
      ),
  );

  server.registerTool(
    "godot_scene_launch",
    {
      title: "Launch a visible Godot scene",
      description:
        "Starts the main or specified scene in a persistent visible window and returns a runId for status and stop operations.",
      inputSchema: loggedInputSchema("godot_scene_launch", LaunchInputSchema),
      outputSchema: GodotLaunchResultSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ projectPath, configPath, scene, startupTimeoutMs }) =>
      await handle("godot_scene_launch", async () =>
        await launchProject({
          projectPath,
          ...(configPath === undefined ? {} : { configPath }),
          ...(scene === undefined ? {} : { scene }),
          ...(startupTimeoutMs === undefined
            ? {}
            : { timeoutMs: startupTimeoutMs }),
        }),
      ),
  );

  server.registerTool(
    "godot_run_status",
    {
      title: "Read a visible Godot run",
      description:
        "Returns persistent process state plus bounded stdout, stderr, and diagnostics for a runId.",
      inputSchema: loggedInputSchema("godot_run_status", RunLookupInputSchema),
      outputSchema: GodotRunStatusSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ projectPath, runId, maxOutputBytes }) =>
      await handle("godot_run_status", async () =>
        await getManagedRunStatus({
          projectPath,
          runId,
          ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
        }),
      ),
  );

  server.registerTool(
    "godot_log_read",
    {
      title: "Read bounded managed-run logs",
      description: "Reads stdout and stderr with independent raw-byte cursors, bounded shaping, filtering, and deduplication. Combined results are stdout then stderr blocks, not reconstructed interleaving.",
      inputSchema: loggedInputSchema("godot_log_read", LogReadInputSchema),
      outputSchema: LogReadResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ projectPath, runId, cursor, stream, minimumSeverity, contains, maxLines, deduplicate, raw }) =>
      await handle("godot_log_read", async () =>
        await readManagedLogs({
          projectPath,
          runId,
          ...(cursor === undefined ? {} : { cursor }),
          stream,
          minimumSeverity,
          ...(contains === undefined ? {} : { contains }),
          maxLines,
          deduplicate,
          raw,
        }),
      ),
  );

  server.registerTool(
    "godot_diagnostics",
    {
      title: "Summarize managed-run diagnostics",
      description: "Returns bounded observed error and warning counts, deduplicated issues, cursors, and evidence-based next actions.",
      inputSchema: loggedInputSchema("godot_diagnostics", DiagnosticsInputSchema),
      outputSchema: DiagnosticsSummarySchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ projectPath, runId, cursor, maxIssues }) =>
      await handle("godot_diagnostics", async () =>
        await getDiagnosticsSummary({
          projectPath,
          runId,
          ...(cursor === undefined ? {} : { cursor }),
          maxIssues,
        }),
      ),
  );

  server.registerTool(
    "godot_debug_report",
    {
      title: "Create a redacted debug report",
      description: "Creates a bounded, redacted, create-only Markdown or JSON report under the project and requires review before sharing.",
      inputSchema: loggedInputSchema("godot_debug_report", DebugReportInputSchema),
      outputSchema: DebugReportResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, expectedProjectFingerprint, issue, runId, reproduction, cursor, format }) =>
      await handle("godot_debug_report", async () =>
        await createDebugReport({
          projectPath,
          expectedProjectFingerprint,
          issue,
          ...(runId === undefined ? {} : { runId }),
          ...(reproduction === undefined ? {} : { reproduction }),
          ...(cursor === undefined ? {} : { cursor }),
          format,
        }),
      ),
  );

  server.registerTool(
    "godot_run_stop",
    {
      title: "Stop a visible Godot run",
      description:
        "Requests a token-authenticated stop for a runId and waits for a terminal state. Repeated calls are safe.",
      inputSchema: loggedInputSchema("godot_run_stop", StopInputSchema),
      outputSchema: GodotRunStatusSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ projectPath, runId, maxOutputBytes, timeoutMs }) =>
      await handle("godot_run_stop", async () =>
        await stopManagedRun({
          projectPath,
          runId,
          ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      ),
  );

  server.registerTool(
    "godot_runtime_status",
    {
      title: "Inspect the runtime bridge",
      description: "Authenticates to a managed run and returns its negotiated runtime capabilities and active scene.",
      inputSchema: loggedInputSchema("godot_runtime_status", RuntimeLookupInputSchema),
      outputSchema: RuntimeBridgeInfoSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ projectPath, runId, timeoutMs }) =>
      await handle("godot_runtime_status", async () =>
        await getRuntimeInfo({ projectPath, runId, ...(timeoutMs === undefined ? {} : { timeoutMs }) }),
      ),
  );

  server.registerTool(
    "godot_runtime_screenshot",
    {
      title: "Capture the running game",
      description: "Captures the root viewport to a PNG and returns additive runtime-frame evidence metadata bound to the live scene.",
      inputSchema: loggedInputSchema("godot_runtime_screenshot", RuntimeScreenshotInputSchema),
      outputSchema: RuntimeScreenshotResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs, expectedScenePath }) =>
      await handle("godot_runtime_screenshot", async () =>
        await captureRuntimeScreenshot({
          projectPath,
          runId,
          ...(expectedScenePath === undefined ? {} : { expectedScenePath }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      ),
  );

  server.registerTool(
    "godot_runtime_ui_find",
    {
      title: "Find visible runtime UI",
      description: "Returns bounded Control nodes with stable paths, types, text, visibility, disabled state, and global rectangles.",
      inputSchema: loggedInputSchema("godot_runtime_ui_find", RuntimeUiInputSchema),
      outputSchema: RuntimeUiResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ projectPath, runId, timeoutMs, selector, limit }) =>
      await handle("godot_runtime_ui_find", async () =>
        await findRuntimeUi({
          projectPath,
          runId,
          limit,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          ...(selector === undefined ? {} : { selector: runtimeSelector(selector) }),
        }),
      ),
  );

  server.registerTool(
    "godot_runtime_scene_tree",
    {
      title: "Read the runtime scene tree",
      description: "Returns the current running scene as a depth- and node-bounded structural tree without exposing the bridge node.",
      inputSchema: loggedInputSchema("godot_runtime_scene_tree", RuntimeSceneTreeInputSchema),
      outputSchema: RuntimeSceneTreeResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ projectPath, runId, timeoutMs, maxDepth, maxNodes }) =>
      await handle("godot_runtime_scene_tree", async () =>
        await getRuntimeSceneTree({
          projectPath,
          runId,
          maxDepth,
          maxNodes,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      ),
  );

  server.registerTool(
    "godot_runtime_node_get",
    {
      title: "Read a runtime node",
      description: "Reads identity and up to 100 declared properties from one running node; no methods or arbitrary code can be invoked.",
      inputSchema: loggedInputSchema("godot_runtime_node_get", RuntimeNodeLookupInputSchema),
      outputSchema: RuntimeNodeResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ projectPath, runId, timeoutMs, nodePath, properties }) =>
      await handle("godot_runtime_node_get", async () =>
        await getRuntimeNode({
          projectPath,
          runId,
          nodePath,
          properties,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      ),
  );

  server.registerTool(
    "godot_runtime_observe",
    {
      title: "Observe gameplay-focused runtime state",
      description: "Returns bounded multi-node snapshots with transforms, velocity, animation, collision state, groups, metadata, and requested extra properties.",
      inputSchema: loggedInputSchema("godot_runtime_observe", RuntimeObserveInputSchema),
      outputSchema: RuntimeObservationResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ projectPath, runId, timeoutMs, nodePaths, properties }) =>
      await handle("godot_runtime_observe", async () =>
        await observeRuntime({
          projectPath,
          runId,
          nodePaths,
          properties,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      ),
  );

  server.registerTool(
    "godot_runtime_simulate_physics",
    {
      title: "Simulate physics in an isolated world",
      description: "Duplicates the current scene into private 2D/3D worlds, advances 1-120 physics frames with optional InputMap action, samples one node, and restores the live tree pause state.",
      inputSchema: loggedInputSchema("godot_runtime_simulate_physics", RuntimeSimulationInputSchema),
      outputSchema: RuntimeSimulationResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs, nodePath, frames, properties, action, strength }) =>
      await handle("godot_runtime_simulate_physics", async () =>
        await simulateRuntimePhysics({
          projectPath,
          runId,
          nodePath,
          frames,
          properties,
          ...(action === undefined ? {} : { action }),
          ...(strength === undefined ? {} : { strength }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      ),
  );

  server.registerTool(
    "godot_runtime_3d_project",
    {
      title: "Project a 3D point into the game viewport",
      description: "Uses an active or explicitly selected Camera3D to map a Node3D or world position to screenshot pixel coordinates, including visibility and depth.",
      inputSchema: loggedInputSchema("godot_runtime_3d_project", RuntimeProjection3DInputSchema),
      outputSchema: RuntimeProjection3DResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ projectPath, runId, timeoutMs, cameraPath, nodePath, worldPosition }) =>
      await handle("godot_runtime_3d_project", async () =>
        await projectRuntime3D({
          projectPath,
          runId,
          ...(cameraPath === undefined ? {} : { cameraPath }),
          ...(nodePath === undefined ? {} : { nodePath }),
          ...(worldPosition === undefined ? {} : { worldPosition }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      ),
  );

  server.registerTool(
    "godot_runtime_3d_raycast",
    {
      title: "Raycast from a game viewport pixel",
      description: "Projects a screenshot pixel through Camera3D and performs a bounded physics ray query, returning the hit collider path, position, and normal.",
      inputSchema: loggedInputSchema("godot_runtime_3d_raycast", RuntimeRaycast3DInputSchema),
      outputSchema: RuntimeRaycast3DResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ projectPath, runId, timeoutMs, cameraPath, screenPosition, maxDistance, collisionMask, collideWithBodies, collideWithAreas }) =>
      await handle("godot_runtime_3d_raycast", async () =>
        await raycastRuntime3D({
          projectPath,
          runId,
          screenPosition,
          maxDistance,
          collisionMask,
          collideWithBodies,
          collideWithAreas,
          ...(cameraPath === undefined ? {} : { cameraPath }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      ),
  );

  server.registerTool(
    "godot_runtime_input",
    {
      title: "Inject bounded runtime input",
      description: "Clicks a Control path or coordinates, pulses an InputMap action, or sends a numeric keycode. Hold duration is capped at 2 seconds.",
      inputSchema: loggedInputSchema("godot_runtime_input", RuntimeInputSchema),
      outputSchema: RuntimeInputResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (value) =>
      await handle("godot_runtime_input", async () => {
        const common = {
          projectPath: value.projectPath,
          runId: value.runId,
          ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }),
        };
        if (value.kind === "click") {
          return await injectRuntimeInput({
            ...common,
            kind: "click",
            ...(value.path === undefined ? {} : { path: value.path }),
            ...(value.x === undefined ? {} : { x: value.x }),
            ...(value.y === undefined ? {} : { y: value.y }),
            ...(value.button === undefined ? {} : { button: value.button }),
          });
        }
        if (value.kind === "action") {
          return await injectRuntimeInput({
            ...common,
            kind: "action",
            action: value.action!,
            ...(value.strength === undefined ? {} : { strength: value.strength }),
            ...(value.holdMs === undefined ? {} : { holdMs: value.holdMs }),
          });
        }
        return await injectRuntimeInput({
          ...common,
          kind: "key",
          keycode: value.keycode!,
          ...(value.holdMs === undefined ? {} : { holdMs: value.holdMs }),
        });
      }),
  );

  server.registerTool(
    "godot_runtime_input_sequence",
    {
      title: "Inject a bounded runtime input sequence",
      description: "Runs 1-32 validated click/action/key steps in order with bounded holds and delays totaling at most 5 seconds.",
      inputSchema: loggedInputSchema("godot_runtime_input_sequence", RuntimeInputSequenceSchema),
      outputSchema: RuntimeInputSequenceResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs, steps }) =>
      await handle("godot_runtime_input_sequence", async () => {
        const normalizedSteps = steps.map((step) => {
          if (step.kind === "click") {
            return {
              kind: step.kind,
              ...(step.path === undefined ? {} : { path: step.path }),
              ...(step.x === undefined ? {} : { x: step.x }),
              ...(step.y === undefined ? {} : { y: step.y }),
              ...(step.button === undefined ? {} : { button: step.button }),
              ...(step.afterMs === undefined ? {} : { afterMs: step.afterMs }),
            } as const;
          }
          if (step.kind === "action") {
            return {
              kind: step.kind,
              action: step.action,
              ...(step.strength === undefined ? {} : { strength: step.strength }),
              ...(step.holdMs === undefined ? {} : { holdMs: step.holdMs }),
              ...(step.afterMs === undefined ? {} : { afterMs: step.afterMs }),
            } as const;
          }
          return {
            kind: step.kind,
            keycode: step.keycode,
            ...(step.holdMs === undefined ? {} : { holdMs: step.holdMs }),
            ...(step.afterMs === undefined ? {} : { afterMs: step.afterMs }),
          } as const;
        });
        return await injectRuntimeInputSequence({
          projectPath,
          runId,
          steps: normalizedSteps,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        });
      }),
  );

  server.registerTool(
    "godot_runtime_assert",
    {
      title: "Assert structured runtime state",
      description: "Evaluates a bounded UI-existence or node-property predicate and returns passed, expected, actual, and structured evidence.",
      inputSchema: loggedInputSchema("godot_runtime_assert", RuntimeAssertInputSchema),
      outputSchema: RuntimeAssertionResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (value) =>
      await handle("godot_runtime_assert", async () => {
        const common = {
          projectPath: value.projectPath,
          runId: value.runId,
          ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }),
        };
        if (value.kind === "ui_exists") {
          return await assertRuntime({
            ...common,
            kind: "ui_exists",
            selector: runtimeSelector(value.selector!),
            ...(value.expectedExists === undefined ? {} : { expected: value.expectedExists }),
          });
        }
        return await assertRuntime({
          ...common,
          kind: "property",
          nodePath: value.nodePath!,
          property: value.property!,
          expected: value.expected,
          ...(value.operator === undefined ? {} : { operator: value.operator }),
        });
      }),
  );

  server.registerTool(
    "godot_runtime_wait",
    {
      title: "Wait for structured runtime state",
      description: "Polls a bounded UI or property predicate on process frames until it passes or the wait timeout expires, returning the last structured observation.",
      inputSchema: loggedInputSchema("godot_runtime_wait", RuntimeWaitInputSchema),
      outputSchema: RuntimeWaitResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (value) =>
      await handle("godot_runtime_wait", async () => {
        const common = {
          projectPath: value.projectPath,
          runId: value.runId,
          waitTimeoutMs: value.waitTimeoutMs,
          pollEveryFrames: value.pollEveryFrames,
          ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }),
        };
        if (value.kind === "ui_exists") {
          return await waitForRuntime({
            ...common,
            kind: "ui_exists",
            selector: runtimeSelector(value.selector!),
            ...(value.expectedExists === undefined ? {} : { expected: value.expectedExists }),
          });
        }
        return await waitForRuntime({
          ...common,
          kind: "property",
          nodePath: value.nodePath!,
          property: value.property!,
          expected: value.expected,
          ...(value.operator === undefined ? {} : { operator: value.operator }),
        });
      }),
  );

  server.registerTool(
    "godot_runtime_control",
    {
      title: "Pause, resume, or step the runtime",
      description: "Pauses/resumes the SceneTree or advances 1-120 process frames while paused. Step requires an explicit prior pause.",
      inputSchema: loggedInputSchema("godot_runtime_control", RuntimeControlInputSchema),
      outputSchema: RuntimeControlResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs, action, frames }) =>
      await handle("godot_runtime_control", async () => {
        const common = {
          projectPath,
          runId,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        };
        if (action === "step" || action === "step_physics") {
          return await controlRuntime({
            ...common,
            action,
            ...(frames === undefined ? {} : { frames }),
          });
        }
        return await controlRuntime({ ...common, action });
      }),
  );

  server.registerTool(
    "godot_editor_launch",
    {
      title: "Launch a managed Godot editor",
      description: "Starts an enabled EditorPlugin in a visible managed editor and returns a runId shared by editor status, scene-tree, screenshot, and stop tools.",
      inputSchema: loggedInputSchema("godot_editor_launch", GodotOperationInputSchema.omit({ maxOutputBytes: true })),
      outputSchema: GodotLaunchResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, configPath, timeoutMs }) =>
      await handle("godot_editor_launch", async () =>
        await launchEditor({
          projectPath,
          ...(configPath === undefined ? {} : { configPath }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      ),
  );

  server.registerTool(
    "godot_editor_status",
    {
      title: "Inspect the EditorPlugin bridge",
      description: "Authenticates to a managed editor and reports the open scene and read-only editor capabilities.",
      inputSchema: loggedInputSchema("godot_editor_status", RuntimeLookupInputSchema),
      outputSchema: EditorBridgeInfoSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ projectPath, runId, timeoutMs }) =>
      await handle("godot_editor_status", async () =>
        await getEditorInfo({ projectPath, runId, ...(timeoutMs === undefined ? {} : { timeoutMs }) }),
      ),
  );

  server.registerTool(
    "godot_editor_project_setting_get",
    {
      title: "Read an allowlisted project setting",
      description: "Reads one existing bounded project setting from the managed editor's loaded ProjectSettings state.",
      inputSchema: loggedInputSchema("godot_editor_project_setting_get", EditorProjectSettingGetInputSchema),
      outputSchema: EditorProjectSettingResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ projectPath, runId, timeoutMs, key }) =>
      await handle("godot_editor_project_setting_get", async () => await getEditorProjectSetting({
        projectPath,
        runId,
        key,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      })),
  );

  server.registerTool(
    "godot_editor_project_setting_set",
    {
      title: "Set an allowlisted project setting",
      description: "Changes one existing bounded project setting under project fingerprint, project.godot SHA-256, managed-run, and cross-process lease guards.",
      inputSchema: loggedInputSchema("godot_editor_project_setting_set", EditorProjectSettingSetInputSchema),
      outputSchema: EditorProjectSettingMutationResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs, expectedProjectFingerprint, expectedProjectFileSha256, key, value }) =>
      await handle("godot_editor_project_setting_set", async () => await setEditorProjectSetting({
        projectPath,
        runId,
        expectedProjectFingerprint,
        expectedProjectFileSha256,
        key,
        value,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      })),
  );

  server.registerTool(
    "godot_editor_input_action_upsert",
    {
      title: "Upsert a typed InputMap action",
      description: "Persists one bounded typed InputMap action under the same project.godot identity, SHA-256, and lease guards as project settings.",
      inputSchema: loggedInputSchema("godot_editor_input_action_upsert", EditorInputActionUpsertInputSchema),
      outputSchema: EditorInputActionMutationResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs, expectedProjectFingerprint, expectedProjectFileSha256, name, deadzone, replaceEvents, events }) =>
      await handle("godot_editor_input_action_upsert", async () => await upsertEditorInputAction({
        projectPath,
        runId,
        expectedProjectFingerprint,
        expectedProjectFileSha256,
        name,
        deadzone,
        replaceEvents,
        events,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      })),
  );

  server.registerTool(
    "godot_editor_resource_inspect",
    {
      title: "Inspect an external Godot Resource",
      description: "Loads one project-internal non-linked .tres/.res and returns a bounded class/path/property summary without modifying it.",
      inputSchema: loggedInputSchema("godot_editor_resource_inspect", EditorResourceInspectInputSchema),
      outputSchema: EditorResourceInspectionResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ projectPath, runId, timeoutMs, path, properties }) =>
      await handle("godot_editor_resource_inspect", async () => await inspectEditorResourcePath({
        projectPath,
        runId,
        path,
        ...(properties === undefined ? {} : { properties }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      })),
  );

  server.registerTool(
    "godot_editor_scene_open",
    {
      title: "Open an editor scene",
      description: "Explicitly opens one project-local .tscn after validating project identity, then returns the active scene's native history version.",
      inputSchema: loggedInputSchema("godot_editor_scene_open", EditorSceneOpenInputSchema),
      outputSchema: EditorSceneOpenResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs, expectedProjectFingerprint, scenePath }) =>
      await handle("godot_editor_scene_open", async () =>
        await openEditorScene({
          projectPath,
          runId,
          expectedProjectFingerprint,
          scenePath,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      ),
  );

  server.registerTool(
    "godot_editor_scene_tree",
    {
      title: "Read the edited scene tree",
      description: "Returns the currently edited scene as a bounded-depth structural tree of paths, names, types, and owners.",
      inputSchema: loggedInputSchema("godot_editor_scene_tree", RuntimeLookupInputSchema),
      outputSchema: EditorSceneTreeResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ projectPath, runId, timeoutMs }) =>
      await handle("godot_editor_scene_tree", async () =>
        await getEditorSceneTree({ projectPath, runId, ...(timeoutMs === undefined ? {} : { timeoutMs }) }),
      ),
  );

  server.registerTool(
    "godot_editor_node_get",
    {
      title: "Read an edited scene node",
      description: "Reads one edited-scene node and up to 100 named properties. Godot Variants use tagged JSON objects such as {$type:'Vector2',x,y}.",
      inputSchema: loggedInputSchema("godot_editor_node_get", EditorNodeLookupInputSchema),
      outputSchema: EditorNodeResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ projectPath, runId, timeoutMs, nodePath, properties }) =>
      await handle("godot_editor_node_get", async () =>
        await getEditorNode({
          projectPath,
          runId,
          nodePath,
          properties,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      ),
  );

  server.registerTool(
    "godot_editor_selection_get",
    {
      title: "Read the editor selection",
      description: "Returns selected edited-scene node paths and the focused node path.",
      inputSchema: loggedInputSchema("godot_editor_selection_get", RuntimeLookupInputSchema),
      outputSchema: EditorSelectionResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ projectPath, runId, timeoutMs }) =>
      await handle("godot_editor_selection_get", async () =>
        await getEditorSelection({
          projectPath,
          runId,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      ),
  );

  server.registerTool(
    "godot_editor_selection_set",
    {
      title: "Select and focus edited-scene nodes",
      description: "Replaces the editor selection with up to 100 scene nodes and optionally focuses the first node in the Inspector.",
      inputSchema: loggedInputSchema("godot_editor_selection_set", EditorSelectionSetInputSchema),
      outputSchema: EditorSelectionResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs, paths, focus }) =>
      await handle("godot_editor_selection_set", async () =>
        await setEditorSelection({
          projectPath,
          runId,
          paths,
          focus,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      ),
  );

  server.registerTool(
    "godot_editor_batch",
    {
      title: "Apply an atomic editor scene batch",
      description: "Validates 1-32 typed scene operations, then applies them as one native Undo/Redo action without saving. Creation-only batches do not delete content; this tool is statically marked destructive because node_delete is supported.",
      inputSchema: loggedInputSchema("godot_editor_batch", EditorBatchInputSchema),
      outputSchema: EditorBatchResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs, expectedProjectFingerprint, expectedScenePath, actionName, operations, confirmDestructive }) =>
      await handle("godot_editor_batch", async () =>
        await batchEditorScene({
          projectPath,
          runId,
          expectedProjectFingerprint,
          expectedScenePath,
          operations,
          confirmDestructive,
          ...(actionName === undefined ? {} : { actionName }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      ),
  );

  server.registerTool(
    "godot_editor_node_create",
    {
      title: "Create an edited scene node",
      description: "Creates an instantiable Godot Node under parentPath, sets owner to the edited root, applies validated properties, and records one native Undo/Redo action.",
      inputSchema: loggedInputSchema("godot_editor_node_create", EditorNodeCreateHandlerInputSchema),
      outputSchema: EditorMutationResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs, expectedProjectFingerprint, expectedScenePath, parentPath, type, name, properties }) =>
      await handle("godot_editor_node_create", async () =>
        await createEditorNode({
          projectPath,
          runId,
          expectedProjectFingerprint,
          expectedScenePath,
          parentPath,
          type,
          name,
          properties,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      ),
  );

  server.registerTool(
    "godot_editor_scene_instantiate",
    {
      title: "Instantiate a PackedScene",
      description: "Loads a project-local .tscn and adds an editable scene instance below a parent as one native Undo/Redo action.",
      inputSchema: loggedInputSchema("godot_editor_scene_instantiate", EditorSceneInstantiateHandlerInputSchema),
      outputSchema: EditorMutationResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs, expectedProjectFingerprint, expectedScenePath, parentPath, scenePath, name, properties }) =>
      await handle("godot_editor_scene_instantiate", async () =>
        await instantiateEditorScene({
          projectPath,
          runId,
          expectedProjectFingerprint,
          expectedScenePath,
          parentPath,
          scenePath,
          properties,
          ...(name === undefined ? {} : { name }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      ),
  );

  server.registerTool(
    "godot_editor_scene_create_inherited",
    {
      title: "Create an inherited PackedScene",
      description: "Uses Godot PackedScene and SceneState APIs to create a project-local inherited .tscn with optional root overrides; target file creation is not Undo/Redo-backed.",
      inputSchema: loggedInputSchema("godot_editor_scene_create_inherited", EditorSceneInheritanceInputSchema),
      outputSchema: EditorInheritedSceneResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs, sourceScenePath, targetScenePath, rootName, rootProperties, open, overwrite }) =>
      await handle("godot_editor_scene_create_inherited", async () =>
        await createInheritedEditorScene({
          projectPath,
          runId,
          sourceScenePath,
          targetScenePath,
          rootProperties,
          open,
          overwrite,
          ...(rootName === undefined ? {} : { rootName }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      ),
  );

  server.registerTool(
    "godot_editor_instance_get",
    {
      title: "Read PackedScene instance editability",
      description: "Reports the source scene and editable-children state of an instantiated PackedScene root.",
      inputSchema: loggedInputSchema("godot_editor_instance_get", EditorInstanceLookupInputSchema),
      outputSchema: EditorInstanceResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ projectPath, runId, timeoutMs, nodePath }) =>
      await handle("godot_editor_instance_get", async () =>
        await getEditorInstance({
          projectPath,
          runId,
          nodePath,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      ),
  );

  server.registerTool(
    "godot_editor_instance_set_editable",
    {
      title: "Set PackedScene editable children",
      description: "Enables or disables editable children through Node.set_editable_instance as one native Godot Undo/Redo action.",
      inputSchema: loggedInputSchema("godot_editor_instance_set_editable", EditorInstanceSetEditableHandlerInputSchema),
      outputSchema: EditorInstanceMutationResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs, expectedProjectFingerprint, expectedScenePath, nodePath, editable }) =>
      await handle("godot_editor_instance_set_editable", async () =>
        await setEditorInstanceEditable({
          projectPath,
          runId,
          expectedProjectFingerprint,
          expectedScenePath,
          nodePath,
          editable,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      ),
  );

  server.registerTool(
    "godot_editor_node_update",
    {
      title: "Update an edited scene node",
      description: "Renames a node and/or applies validated Godot properties as one native Undo/Redo action. Structural owner and scene path properties are rejected.",
      inputSchema: loggedInputSchema("godot_editor_node_update", EditorNodeUpdateHandlerInputSchema),
      outputSchema: EditorMutationResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs, expectedProjectFingerprint, expectedScenePath, nodePath, name, properties }) =>
      await handle("godot_editor_node_update", async () =>
        await updateEditorNode({
          projectPath,
          runId,
          expectedProjectFingerprint,
          expectedScenePath,
          nodePath,
          properties,
          ...(name === undefined ? {} : { name }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      ),
  );

  server.registerTool(
    "godot_editor_node_delete",
    {
      title: "Delete an edited scene node",
      description: "Removes a non-root node while retaining it for native Undo/Redo restoration.",
      inputSchema: loggedInputSchema("godot_editor_node_delete", EditorNodeDeleteHandlerInputSchema),
      outputSchema: EditorMutationResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs, expectedProjectFingerprint, expectedScenePath, nodePath }) =>
      await handle("godot_editor_node_delete", async () =>
        await deleteEditorNode({
          projectPath,
          runId,
          expectedProjectFingerprint,
          expectedScenePath,
          nodePath,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      ),
  );

  server.registerTool(
    "godot_editor_node_move",
    {
      title: "Move an edited scene node",
      description: "Reparents and/or reorders a non-root node as one native Undo/Redo action, rejecting cycles and name conflicts.",
      inputSchema: loggedInputSchema("godot_editor_node_move", EditorNodeMoveHandlerInputSchema),
      outputSchema: EditorMutationResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs, expectedProjectFingerprint, expectedScenePath, nodePath, newParentPath, index, keepGlobalTransform }) =>
      await handle("godot_editor_node_move", async () =>
        await moveEditorNode({
          projectPath,
          runId,
          expectedProjectFingerprint,
          expectedScenePath,
          nodePath,
          newParentPath,
          keepGlobalTransform,
          ...(index === undefined ? {} : { index }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      ),
  );

  server.registerTool(
    "godot_editor_resource_create",
    {
      title: "Create an inline Godot resource",
      description: "Creates a validated Resource, applies tagged Variant properties, and assigns it to one edited-scene node property as a native Undo/Redo action.",
      inputSchema: loggedInputSchema("godot_editor_resource_create", EditorResourceCreateHandlerInputSchema),
      outputSchema: EditorResourceResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs, expectedProjectFingerprint, expectedScenePath, nodePath, property, type, properties }) =>
      await handle("godot_editor_resource_create", async () =>
        await createEditorResource({
          projectPath,
          runId,
          expectedProjectFingerprint,
          expectedScenePath,
          nodePath,
          property,
          type,
          properties,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      ),
  );

  server.registerTool(
    "godot_editor_resource_get",
    {
      title: "Read a Godot resource",
      description: "Reads up to 100 declared properties from the Resource stored in one edited-scene node property.",
      inputSchema: loggedInputSchema("godot_editor_resource_get", EditorResourceLookupInputSchema),
      outputSchema: EditorResourceReadResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ projectPath, runId, timeoutMs, nodePath, property, properties }) =>
      await handle("godot_editor_resource_get", async () =>
        await getEditorResource({
          projectPath,
          runId,
          nodePath,
          property,
          properties,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      ),
  );

  server.registerTool(
    "godot_editor_resource_update",
    {
      title: "Update a Godot resource",
      description: "Applies validated Resource subproperties as one native Godot Undo/Redo action; it does not invoke methods or save an external file.",
      inputSchema: loggedInputSchema("godot_editor_resource_update", EditorResourceUpdateHandlerInputSchema),
      outputSchema: EditorResourceResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs, expectedProjectFingerprint, expectedScenePath, nodePath, property, properties }) =>
      await handle("godot_editor_resource_update", async () =>
        await updateEditorResource({
          projectPath,
          runId,
          expectedProjectFingerprint,
          expectedScenePath,
          nodePath,
          property,
          properties,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      ),
  );

  server.registerTool(
    "godot_editor_resource_save",
    {
      title: "Save an external Godot resource",
      description: "Saves a node's Resource property as a project-local .tres. Overwrite is rejected by default; the filesystem side effect is not undoable.",
      inputSchema: loggedInputSchema("godot_editor_resource_save", EditorResourceSaveHandlerInputSchema),
      outputSchema: EditorResourceSaveResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs, expectedProjectFingerprint, expectedScenePath, nodePath, property, path, overwrite }) =>
      await handle("godot_editor_resource_save", async () =>
        await saveEditorResource({
          projectPath,
          runId,
          expectedProjectFingerprint,
          expectedScenePath,
          nodePath,
          property,
          path,
          overwrite,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      ),
  );

  server.registerTool(
    "godot_editor_resource_focus",
    {
      title: "Focus a project resource",
      description: "Selects a validated project-local resource in the FileSystem dock and opens it through EditorInterface.",
      inputSchema: loggedInputSchema("godot_editor_resource_focus", EditorResourceFocusInputSchema),
      outputSchema: EditorResourceFocusResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs, path }) =>
      await handle("godot_editor_resource_focus", async () =>
        await focusEditorResource({
          projectPath,
          runId,
          path,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      ),
  );

  server.registerTool(
    "godot_editor_signal_connect",
    {
      title: "Connect an edited scene signal",
      description: "Creates a persistent signal-to-method connection between edited-scene nodes as one native Undo/Redo action.",
      inputSchema: loggedInputSchema("godot_editor_signal_connect", EditorSignalConnectHandlerInputSchema),
      outputSchema: EditorSignalConnectionResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs, expectedProjectFingerprint, expectedScenePath, sourcePath, signal, targetPath, method, flags }) =>
      await handle("godot_editor_signal_connect", async () =>
        await connectEditorSignal({
          projectPath,
          runId,
          expectedProjectFingerprint,
          expectedScenePath,
          sourcePath,
          signal,
          targetPath,
          method,
          ...(flags === undefined ? {} : { flags }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      ),
  );

  server.registerTool(
    "godot_editor_scene_save",
    {
      title: "Save the edited scene",
      description: "Saves the active edited scene through EditorInterface and returns the res:// path and Godot error code.",
      inputSchema: loggedInputSchema("godot_editor_scene_save", EditorSceneSaveHandlerInputSchema),
      outputSchema: EditorSceneSaveResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs, expectedProjectFingerprint, expectedScenePath, expectedHistoryVersion }) =>
      await handle("godot_editor_scene_save", async () =>
        await saveEditorScene({
          projectPath,
          runId,
          expectedProjectFingerprint,
          expectedScenePath,
          expectedHistoryVersion,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      ),
  );

  server.registerTool(
    "godot_editor_undo",
    {
      title: "Undo an edited scene action",
      description: "Undoes the latest action in the active scene's native Godot Undo/Redo history.",
      inputSchema: loggedInputSchema("godot_editor_undo", EditorHistoryMutationHandlerInputSchema),
      outputSchema: EditorHistoryResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs, expectedProjectFingerprint, expectedScenePath, expectedHistoryVersion, expectedActionName }) =>
      await handle("godot_editor_undo", async () =>
        await undoEditorAction({
          projectPath,
          runId,
          expectedProjectFingerprint,
          expectedScenePath,
          expectedHistoryVersion,
          ...(expectedActionName === undefined ? {} : { expectedActionName }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      ),
  );

  server.registerTool(
    "godot_editor_redo",
    {
      title: "Redo an edited scene action",
      description: "Redoes the next action in the active scene's native Godot Undo/Redo history.",
      inputSchema: loggedInputSchema("godot_editor_redo", EditorHistoryMutationHandlerInputSchema),
      outputSchema: EditorHistoryResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs, expectedProjectFingerprint, expectedScenePath, expectedHistoryVersion, expectedActionName }) =>
      await handle("godot_editor_redo", async () =>
        await redoEditorAction({
          projectPath,
          runId,
          expectedProjectFingerprint,
          expectedScenePath,
          expectedHistoryVersion,
          ...(expectedActionName === undefined ? {} : { expectedActionName }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      ),
  );

  server.registerTool(
    "godot_editor_screenshot",
    {
      title: "Capture an editor 2D or 3D viewport",
      description: "Captures a managed editor viewport and returns additive editor-view evidence metadata bound to the edited scene.",
      inputSchema: loggedInputSchema("godot_editor_screenshot", EditorScreenshotInputSchema),
      outputSchema: EditorScreenshotResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs, expectedScenePath, viewport, viewportIndex }) =>
      await handle("godot_editor_screenshot", async () =>
        await captureEditorScreenshot({
          projectPath,
          runId,
          ...(expectedScenePath === undefined ? {} : { expectedScenePath }),
          viewport,
          viewportIndex,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      ),
  );

  return server;
}
