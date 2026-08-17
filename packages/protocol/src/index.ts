import * as z from "zod/v4";

export const EDITOR_PROTOCOL_VERSION = "0.6.0";
export const RUNTIME_PROTOCOL_VERSION = "0.3.0";
/** @deprecated Use EDITOR_PROTOCOL_VERSION or RUNTIME_PROTOCOL_VERSION explicitly. */
export const PROTOCOL_VERSION = RUNTIME_PROTOCOL_VERSION;

export const ErrorStageSchema = z.enum([
  "configuration",
  "discovery",
  "validation",
  "spawn",
  "import",
  "run",
  "protocol",
]);

export const RuntimeErrorSchema = z.object({
  code: z.string().min(1),
  stage: ErrorStageSchema,
  message: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
  recovery: z.array(z.string().min(1)).min(1),
});

export type RuntimeError = z.infer<typeof RuntimeErrorSchema>;

export const CheckStatusSchema = z.enum(["pass", "warning", "fail"]);

export const DoctorCheckSchema = z.object({
  name: z.string().min(1),
  status: CheckStatusSchema,
  summary: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
  recovery: z.array(z.string().min(1)).optional(),
});

export const DoctorResultSchema = z.object({
  ok: z.boolean(),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  protocolVersions: z.object({
    editor: z.literal(EDITOR_PROTOCOL_VERSION),
    runtime: z.literal(RUNTIME_PROTOCOL_VERSION),
  }),
  checks: z.array(DoctorCheckSchema),
});

export type DoctorResult = z.infer<typeof DoctorResultSchema>;

export const DevelopmentConfigSchema = z.object({
  schemaVersion: z.literal(1),
  godot: z.object({
    executable: z.string().min(1),
  }),
  deepseekHarness: z
    .object({
      root: z.string().min(1),
    })
    .optional(),
});

export type DevelopmentConfig = z.infer<typeof DevelopmentConfigSchema>;

export const ProjectInfoSchema = z.object({
  projectPath: z.string().min(1),
  projectFile: z.string().min(1),
  name: z.string().nullable(),
  mainScene: z.string().nullable(),
  renderer: z.string().nullable(),
  enabledPlugins: z.array(z.string()),
});

export type ProjectInfo = z.infer<typeof ProjectInfoSchema>;

export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const ProjectIdentitySchema = z.object({
  projectPath: z.string().min(1),
  projectFile: z.string().min(1),
  projectFingerprint: Sha256Schema,
  projectFileSha256: Sha256Schema,
});

export type ProjectIdentity = z.infer<typeof ProjectIdentitySchema>;

export const ProjectDiscoveryResultSchema = z.object({
  root: z.string().min(1),
  scannedDirectories: z.number().int().nonnegative(),
  truncated: z.boolean(),
  projects: z.array(ProjectInfoSchema),
});

export type ProjectDiscoveryResult = z.infer<typeof ProjectDiscoveryResultSchema>;

export const DiagnosticSchema = z.object({
  severity: z.enum(["error", "warning"]),
  message: z.string(),
});

export const GodotRunResultSchema = z.object({
  ok: z.boolean(),
  mode: z.enum(["check", "run"]),
  projectPath: z.string().min(1),
  scene: z.string().nullable(),
  command: z.array(z.string()),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  durationMs: z.number().nonnegative(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  diagnostics: z.array(DiagnosticSchema),
});

export type GodotRunResult = z.infer<typeof GodotRunResultSchema>;

export const ScriptCheckResultSchema = z.object({
  ok: z.boolean(),
  path: z.string().startsWith("res://").regex(/\.gd$/i),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  durationMs: z.number().nonnegative(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  diagnostics: z.array(DiagnosticSchema),
}).strict();

export type ScriptCheckResult = z.infer<typeof ScriptCheckResultSchema>;

export const ManagedRunStateSchema = z.enum([
  "starting",
  "running",
  "stopping",
  "exited",
  "stopped",
  "failed",
]);

export const GodotLaunchResultSchema = z.object({
  ok: z.literal(true),
  runId: z.uuid(),
  state: z.literal("running"),
  projectPath: z.string().min(1),
  scene: z.string().nullable(),
  processId: z.number().int().positive(),
  supervisorProcessId: z.number().int().positive(),
  startedAt: z.string().datetime(),
  command: z.array(z.string()),
  stdoutPath: z.string().min(1),
  stderrPath: z.string().min(1),
  runtimeBridgePort: z.number().int().min(1).max(65535).nullable(),
});

export type GodotLaunchResult = z.infer<typeof GodotLaunchResultSchema>;

export const GodotRunStatusSchema = z.object({
  ok: z.boolean(),
  runId: z.uuid(),
  state: ManagedRunStateSchema,
  projectPath: z.string().min(1),
  scene: z.string().nullable(),
  processId: z.number().int().positive().nullable(),
  supervisorProcessId: z.number().int().positive(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  failure: RuntimeErrorSchema.nullable(),
  command: z.array(z.string()),
  stdoutPath: z.string().min(1),
  stderrPath: z.string().min(1),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  diagnostics: z.array(DiagnosticSchema),
  runtimeBridgePort: z.number().int().min(1).max(65535).nullable(),
});

export type GodotRunStatus = z.infer<typeof GodotRunStatusSchema>;

export const LogCursorSchema = z.object({
  stdoutBytes: z.number().int().nonnegative(),
  stderrBytes: z.number().int().nonnegative(),
}).strict();

export type LogCursor = z.infer<typeof LogCursorSchema>;

export const LogEntrySchema = z.object({
  stream: z.enum(["stdout", "stderr"]),
  severity: z.enum(["error", "warning", "info"]),
  message: z.string(),
  count: z.number().int().positive(),
}).strict();

export type LogEntry = z.infer<typeof LogEntrySchema>;

export const LogHiddenSchema = z.object({
  belowSeverity: z.number().int().nonnegative(),
  contains: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
}).strict();

export const LogReadResultSchema = z.object({
  ok: z.literal(true),
  projectPath: z.string().min(1),
  runId: z.uuid(),
  stream: z.enum(["stdout", "stderr", "combined"]),
  order: z.literal("stdout_then_stderr_blocks"),
  cursor: LogCursorSchema,
  nextCursor: LogCursorSchema,
  entries: z.array(LogEntrySchema).max(500),
  hidden: LogHiddenSchema,
  bytesRead: z.number().int().nonnegative().max(1_048_576),
  truncated: z.boolean(),
  raw: z.boolean(),
}).strict();

export type LogReadResult = z.infer<typeof LogReadResultSchema>;

export const NextActionSchema = z.object({
  tool: z.string().startsWith("godot_"),
  reason: z.string().min(1),
  required: z.boolean(),
}).strict();

export const DiagnosticsSummarySchema = z.object({
  ok: z.literal(true),
  projectPath: z.string().min(1),
  runId: z.uuid(),
  state: ManagedRunStateSchema,
  counts: z.object({
    errors: z.number().int().nonnegative(),
    warnings: z.number().int().nonnegative(),
    unique: z.number().int().nonnegative(),
    repeated: z.number().int().nonnegative(),
  }).strict(),
  issues: z.array(LogEntrySchema).max(50),
  nextCursor: LogCursorSchema,
  truncated: z.boolean(),
  nextActions: z.array(NextActionSchema),
}).strict();

export type DiagnosticsSummary = z.infer<typeof DiagnosticsSummarySchema>;

export const DebugReportResultSchema = z.object({
  ok: z.literal(true),
  projectPath: z.string().min(1),
  path: z.string().startsWith("res://").regex(/\.(?:md|json)$/),
  bytes: z.number().int().positive(),
  sha256: Sha256Schema,
  includedSections: z.array(z.enum([
    "doctor",
    "protocolVersions",
    "engine",
    "capabilities",
    "diagnostics",
    "logs",
    "runId",
    "issue",
    "reproduction",
  ])),
  reviewRequired: z.literal(true),
}).strict();

export type DebugReportResult = z.infer<typeof DebugReportResultSchema>;

export const ToolErrorResultSchema = z.object({
  ok: z.literal(false),
  error: RuntimeErrorSchema,
});

export type ToolErrorResult = z.infer<typeof ToolErrorResultSchema>;

export const SafeFileReadResultSchema = z.object({
  ok: z.literal(true),
  projectPath: z.string().min(1),
  path: z.string().startsWith("res://"),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  content: z.string(),
}).strict();

export type SafeFileReadResult = z.infer<typeof SafeFileReadResultSchema>;

export const FileMutationGuardSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("create") }).strict(),
  z.object({ mode: z.literal("match"), sha256: Sha256Schema }).strict(),
]);

export type FileMutationGuard = z.infer<typeof FileMutationGuardSchema>;

export const SafeFileWriteResultSchema = z.object({
  ok: z.literal(true),
  projectPath: z.string().min(1),
  path: z.string().startsWith("res://"),
  operation: z.enum(["created", "updated"]),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  previousSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
}).strict();

export type SafeFileWriteResult = z.infer<typeof SafeFileWriteResultSchema>;

export const SafeTextReplaceResultSchema = SafeFileWriteResultSchema.extend({
  replacements: z.number().int().positive(),
}).strict();

export type SafeTextReplaceResult = z.infer<typeof SafeTextReplaceResultSchema>;

export const RuntimeBridgeInfoSchema = z.object({
  ok: z.literal(true),
  runId: z.uuid(),
  protocolVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
  engineVersion: z.string().min(1),
  scene: z.string().nullable(),
  capabilities: z.array(z.enum(["screenshot", "ui", "scene_tree", "node", "observe", "simulate", "spatial_3d", "input", "input_sequence", "assert", "wait", "control"])),
});

export type RuntimeBridgeInfo = z.infer<typeof RuntimeBridgeInfoSchema>;

export const RuntimeRectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
  centerX: z.number(),
  centerY: z.number(),
});

export const RuntimeUiElementSchema = z.object({
  path: z.string().min(1),
  name: z.string(),
  type: z.string().min(1),
  text: z.string().nullable(),
  visible: z.boolean(),
  disabled: z.boolean().nullable(),
  rect: RuntimeRectSchema,
});

export const RuntimeUiResultSchema = z.object({
  ok: z.literal(true),
  runId: z.uuid(),
  count: z.number().int().nonnegative(),
  truncated: z.boolean(),
  elements: z.array(RuntimeUiElementSchema),
});

export type RuntimeUiResult = z.infer<typeof RuntimeUiResultSchema>;

export interface RuntimeSceneNode {
  readonly path: string;
  readonly name: string;
  readonly type: string;
  readonly scenePath: string | null;
  readonly children: RuntimeSceneNode[];
}

export const RuntimeSceneNodeSchema: z.ZodType<RuntimeSceneNode> = z.lazy(() =>
  z.object({
    path: z.string().min(1),
    name: z.string(),
    type: z.string().min(1),
    scenePath: z.string().nullable(),
    children: z.array(RuntimeSceneNodeSchema),
  }),
);

export const RuntimeSceneTreeResultSchema = z.object({
  ok: z.literal(true),
  runId: z.uuid(),
  root: RuntimeSceneNodeSchema.nullable(),
  truncated: z.boolean(),
});

export type RuntimeSceneTreeResult = z.infer<typeof RuntimeSceneTreeResultSchema>;

export const RuntimeNodeSchema = z.object({
  path: z.string().min(1),
  name: z.string(),
  type: z.string().min(1),
  parentPath: z.string().nullable(),
  scenePath: z.string().nullable(),
  properties: z.record(z.string(), z.unknown()),
});

export const RuntimeNodeResultSchema = z.object({
  ok: z.literal(true),
  runId: z.uuid(),
  node: RuntimeNodeSchema,
});

export type RuntimeNodeResult = z.infer<typeof RuntimeNodeResultSchema>;

export const RuntimeObservationNodeSchema = z.object({
  path: z.string().min(1),
  name: z.string(),
  type: z.string().min(1),
  scenePath: z.string().nullable(),
  groups: z.array(z.string()).max(100),
  metadata: z.record(z.string(), z.unknown()),
  state: z.record(z.string(), z.unknown()),
});

export const RuntimeObservationResultSchema = z.object({
  ok: z.literal(true),
  runId: z.uuid(),
  count: z.number().int().nonnegative().max(32),
  nodes: z.array(RuntimeObservationNodeSchema).max(32),
});

export type RuntimeObservationResult = z.infer<typeof RuntimeObservationResultSchema>;

export const Vector2ValueSchema = z.object({
  x: z.number(),
  y: z.number(),
});

export const Vector3ValueSchema = Vector2ValueSchema.extend({
  z: z.number(),
});

export const RuntimeProjection3DResultSchema = z.object({
  ok: z.literal(true),
  runId: z.uuid(),
  cameraPath: z.string().min(1),
  nodePath: z.string().min(1).nullable(),
  worldPosition: Vector3ValueSchema,
  screenPosition: Vector2ValueSchema,
  viewport: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  behind: z.boolean(),
  onScreen: z.boolean(),
  depth: z.number(),
  distance: z.number().nonnegative(),
});

export type RuntimeProjection3DResult = z.infer<typeof RuntimeProjection3DResultSchema>;

export const RuntimeRaycast3DResultSchema = z.object({
  ok: z.literal(true),
  runId: z.uuid(),
  cameraPath: z.string().min(1),
  screenPosition: Vector2ValueSchema,
  rayOrigin: Vector3ValueSchema,
  rayDirection: Vector3ValueSchema,
  maxDistance: z.number().positive(),
  collisionMask: z.number().int().nonnegative(),
  hit: z.boolean(),
  collider: z.object({
    path: z.string().min(1).nullable(),
    type: z.string().min(1),
  }).nullable(),
  position: Vector3ValueSchema.nullable(),
  normal: Vector3ValueSchema.nullable(),
  shape: z.number().int().nullable(),
  faceIndex: z.number().int().nullable(),
});

export type RuntimeRaycast3DResult = z.infer<typeof RuntimeRaycast3DResultSchema>;

export const RuntimeSimulationSampleSchema = z.object({
  frame: z.number().int().nonnegative().max(120),
  properties: z.record(z.string(), z.unknown()),
});

export const RuntimeSimulationResultSchema = z.object({
  ok: z.literal(true),
  runId: z.uuid(),
  nodePath: z.string().min(1),
  isolated: z.literal(true),
  framesRequested: z.number().int().min(1).max(120),
  physicsFramesAdvanced: z.number().int().nonnegative(),
  pausedRestored: z.boolean(),
  action: z.string().nullable(),
  samples: z.array(RuntimeSimulationSampleSchema).min(2).max(121),
});

export type RuntimeSimulationResult = z.infer<typeof RuntimeSimulationResultSchema>;

export const RuntimeScreenshotResultSchema = z.object({
  ok: z.literal(true),
  runId: z.uuid(),
  path: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export type RuntimeScreenshotResult = z.infer<typeof RuntimeScreenshotResultSchema>;

export const RuntimeInputResultSchema = z.object({
  ok: z.literal(true),
  runId: z.uuid(),
  kind: z.enum(["click", "action", "key"]),
  delivered: z.boolean(),
  target: z.string().nullable(),
  position: z.object({ x: z.number(), y: z.number() }).nullable(),
});

export type RuntimeInputResult = z.infer<typeof RuntimeInputResultSchema>;

export const RuntimeInputSequenceResultSchema = z.object({
  ok: z.literal(true),
  runId: z.uuid(),
  delivered: z.literal(true),
  completed: z.number().int().min(1).max(32),
  elapsedMs: z.number().int().nonnegative(),
  results: z.array(RuntimeInputResultSchema.omit({ ok: true, runId: true })).max(32),
});

export type RuntimeInputSequenceResult = z.infer<typeof RuntimeInputSequenceResultSchema>;

export const RuntimeAssertionResultSchema = z.object({
  ok: z.literal(true),
  runId: z.uuid(),
  passed: z.boolean(),
  assertion: z.string().min(1),
  expected: z.unknown(),
  actual: z.unknown(),
  evidence: z.record(z.string(), z.unknown()),
});

export type RuntimeAssertionResult = z.infer<typeof RuntimeAssertionResultSchema>;

export const RuntimeWaitResultSchema = z.object({
  ok: z.literal(true),
  runId: z.uuid(),
  satisfied: z.boolean(),
  timedOut: z.boolean(),
  elapsedMs: z.number().int().nonnegative(),
  attempts: z.number().int().positive(),
  assertion: z.string().min(1),
  expected: z.unknown(),
  actual: z.unknown(),
  evidence: z.record(z.string(), z.unknown()),
});

export type RuntimeWaitResult = z.infer<typeof RuntimeWaitResultSchema>;

export const RuntimeControlResultSchema = z.object({
  ok: z.literal(true),
  runId: z.uuid(),
  action: z.enum(["pause", "resume", "step", "step_physics"]),
  paused: z.boolean(),
  framesRequested: z.number().int().nonnegative(),
  processFramesAdvanced: z.number().int().nonnegative(),
  physicsFramesAdvanced: z.number().int().nonnegative(),
  elapsedMs: z.number().int().nonnegative(),
});

export type RuntimeControlResult = z.infer<typeof RuntimeControlResultSchema>;

export const AddonInstallResultSchema = z.object({
  ok: z.literal(true),
  projectPath: z.string().min(1),
  plugin: z.literal("godot_agent_runtime"),
  files: z.array(z.string().startsWith("res://")),
  projectConfigurationChanged: z.boolean(),
});

const BoundedEditorPropertiesSchema = z.record(z.string().min(1), z.unknown())
  .refine(
    (value) => Object.keys(value).length <= 100,
    "At most 100 properties are allowed.",
  );

export const EditorBatchOperationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("node_create"),
    parentPath: z.string().min(1),
    type: z.string().min(1),
    name: z.string().min(1),
    properties: BoundedEditorPropertiesSchema.default({}),
  }).strict(),
  z.object({
    op: z.literal("node_update"),
    nodePath: z.string().min(1),
    name: z.string().min(1).optional(),
    properties: BoundedEditorPropertiesSchema.default({}),
  }).strict(),
  z.object({
    op: z.literal("node_move"),
    nodePath: z.string().min(1),
    newParentPath: z.string().min(1),
    index: z.number().int().min(-1).optional(),
    keepGlobalTransform: z.boolean().default(true),
  }).strict(),
  z.object({
    op: z.literal("node_delete"),
    nodePath: z.string().min(1),
  }).strict(),
  z.object({
    op: z.literal("scene_instantiate"),
    parentPath: z.string().min(1),
    scenePath: z.string().startsWith("res://").endsWith(".tscn"),
    name: z.string().min(1).optional(),
    properties: BoundedEditorPropertiesSchema.default({}),
  }).strict(),
  z.object({
    op: z.literal("resource_create"),
    nodePath: z.string().min(1),
    property: z.string().min(1),
    type: z.string().min(1),
    properties: BoundedEditorPropertiesSchema.default({}),
  }).strict(),
  z.object({
    op: z.literal("resource_update"),
    nodePath: z.string().min(1),
    property: z.string().min(1),
    properties: BoundedEditorPropertiesSchema,
  }).strict(),
  z.object({
    op: z.literal("instance_set_editable"),
    nodePath: z.string().min(1),
    editable: z.boolean(),
  }).strict(),
  z.object({
    op: z.literal("signal_connect"),
    sourcePath: z.string().min(1),
    signal: z.string().min(1),
    targetPath: z.string().min(1),
    method: z.string().min(1),
    flags: z.number().int().min(0).max(15).optional(),
  }).strict(),
]);

export type EditorBatchOperation = z.infer<typeof EditorBatchOperationSchema>;

export const EditorBatchRequestSchema = z.object({
  expectedScenePath: z.string().startsWith("res://").endsWith(".tscn"),
  expectedProjectFingerprint: Sha256Schema,
  actionName: z.string().min(1).max(120).optional(),
  operations: z.array(EditorBatchOperationSchema).min(1).max(32),
  confirmDestructive: z.boolean(),
}).strict().superRefine((value, context) => {
  if (!value.confirmDestructive && value.operations.some(({ op }) => op === "node_delete")) {
    context.addIssue({
      code: "custom",
      path: ["confirmDestructive"],
      message: "confirmDestructive must be true when operations contain node_delete.",
    });
  }
});

export type EditorBatchRequest = z.infer<typeof EditorBatchRequestSchema>;

export const EditorBatchReceiptSchema = z.object({
  index: z.number().int().min(0).max(31),
  op: z.enum([
    "node_create",
    "node_update",
    "node_move",
    "node_delete",
    "scene_instantiate",
    "resource_create",
    "resource_update",
    "instance_set_editable",
    "signal_connect",
  ]),
  path: z.string().min(1),
  action: z.string().min(1),
}).strict();

export const EditorBatchResultSchema = z.object({
  ok: z.literal(true),
  runId: z.uuid(),
  scenePath: z.string().startsWith("res://").endsWith(".tscn"),
  actionName: z.string().min(1).max(133),
  operationCount: z.number().int().min(1).max(32),
  results: z.array(EditorBatchReceiptSchema).max(32),
  undoable: z.literal(true),
  dirty: z.literal(true),
  historyVersion: z.number().int().nonnegative(),
}).strict();

export type EditorBatchResult = z.infer<typeof EditorBatchResultSchema>;

const EditorProjectSettingStringSchema = z.string().refine(
  (value) => new TextEncoder().encode(value).byteLength <= 16 * 1024,
  "Project setting strings must not exceed 16 KiB of UTF-8.",
);

export const EditorProjectSettingValueSchema = z.union([
  z.boolean(),
  z.number().finite().refine(
    (value) => Math.abs(value) <= Number.MAX_SAFE_INTEGER,
    "Project setting numbers must remain within JavaScript's safe numeric range.",
  ),
  EditorProjectSettingStringSchema,
  z.array(EditorProjectSettingStringSchema).max(256),
]);

export type EditorProjectSettingValue = z.infer<typeof EditorProjectSettingValueSchema>;

export const EditorProjectSettingGetRequestSchema = z.object({
  key: z.string().min(1).max(256),
}).strict();

export const EditorProjectSettingSetRequestSchema = z.object({
  expectedProjectFingerprint: Sha256Schema,
  expectedProjectFileSha256: Sha256Schema,
  key: z.string().min(1).max(256),
  value: EditorProjectSettingValueSchema,
}).strict();

const EditorInputKeyBindingSchema = z.object({
  type: z.literal("key"),
  keycode: z.number().int().positive().max(4_294_967_295).optional(),
  physicalKeycode: z.number().int().positive().max(4_294_967_295).optional(),
  shift: z.boolean().optional(),
  alt: z.boolean().optional(),
  ctrl: z.boolean().optional(),
  meta: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  if ((value.keycode === undefined) === (value.physicalKeycode === undefined)) {
    context.addIssue({
      code: "custom",
      message: "A key event requires exactly one of keycode or physicalKeycode.",
    });
  }
});

const EditorInputMouseButtonBindingSchema = z.object({
  type: z.literal("mouse_button"),
  buttonIndex: z.number().int().min(1).max(9),
}).strict();

const EditorInputJoypadButtonBindingSchema = z.object({
  type: z.literal("joypad_button"),
  buttonIndex: z.number().int().min(0).max(127),
  device: z.number().int().min(-1).max(15).optional(),
}).strict();

export const EditorInputBindingSchema = z.discriminatedUnion("type", [
  EditorInputKeyBindingSchema,
  EditorInputMouseButtonBindingSchema,
  EditorInputJoypadButtonBindingSchema,
]);

export type EditorInputBinding = z.infer<typeof EditorInputBindingSchema>;

export const EditorInputActionUpsertRequestSchema = z.object({
  expectedProjectFingerprint: Sha256Schema,
  expectedProjectFileSha256: Sha256Schema,
  name: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
  deadzone: z.number().min(0).max(1),
  replaceEvents: z.boolean(),
  events: z.array(EditorInputBindingSchema).min(1).max(32),
}).strict();

export const EditorResourceInspectRequestSchema = z.object({
  path: z.string().startsWith("res://").regex(/\.(?:tres|res)$/i),
  properties: z.array(z.string().min(1).max(256)).max(100).optional(),
}).strict();

export const EditorProjectSettingResultSchema = z.object({
  ok: z.literal(true),
  runId: z.uuid(),
  key: z.string().min(1),
  value: EditorProjectSettingValueSchema,
}).strict();

export type EditorProjectSettingResult = z.infer<typeof EditorProjectSettingResultSchema>;

export const EditorProjectSettingMutationResultSchema = z.object({
  ok: z.literal(true),
  runId: z.uuid(),
  operationId: z.uuid(),
  key: z.string().min(1),
  changed: z.boolean(),
  previousValue: EditorProjectSettingValueSchema,
  value: EditorProjectSettingValueSchema,
  beforeSha256: Sha256Schema,
  afterSha256: Sha256Schema,
  undoable: z.literal(false),
}).strict();

export type EditorProjectSettingMutationResult = z.infer<
  typeof EditorProjectSettingMutationResultSchema
>;

export const EditorInputActionMutationResultSchema = z.object({
  ok: z.literal(true),
  runId: z.uuid(),
  operationId: z.uuid(),
  name: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
  deadzone: z.number().min(0).max(1),
  replaceEvents: z.boolean(),
  events: z.array(EditorInputBindingSchema).min(1).max(32),
  changed: z.boolean(),
  beforeSha256: Sha256Schema,
  afterSha256: Sha256Schema,
  undoable: z.literal(false),
}).strict();

export type EditorInputActionMutationResult = z.infer<
  typeof EditorInputActionMutationResultSchema
>;

export const EditorResourceInspectionResultSchema = z.object({
  ok: z.literal(true),
  runId: z.uuid(),
  resource: z.object({
    path: z.string().startsWith("res://").regex(/\.(?:tres|res)$/i),
    class: z.string().min(1),
    editableProperties: z.array(z.string().min(1)).max(1000),
    properties: z.record(z.string(), z.unknown()),
  }).strict(),
}).strict();

export type EditorResourceInspectionResult = z.infer<
  typeof EditorResourceInspectionResultSchema
>;

export const EditorBridgeInfoSchema = z.object({
  ok: z.literal(true),
  runId: z.uuid(),
  protocolVersion: z.literal(EDITOR_PROTOCOL_VERSION),
  engineVersion: z.string().min(1),
  scene: z.string().nullable(),
  historyVersion: z.number().int().nonnegative().nullable(),
  capabilities: z.array(
    z.enum([
      "scene_tree",
      "selection",
      "screenshot",
      "node_edit",
      "scene_instantiate",
      "scene_inheritance",
      "viewport_3d",
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
    ]),
  ),
});

export type EditorBridgeInfo = z.infer<typeof EditorBridgeInfoSchema>;

export const EditorSceneOpenResultSchema = z.object({
  ok: z.literal(true),
  runId: z.uuid(),
  opened: z.literal(true),
  previousScene: z.string().startsWith("res://").nullable(),
  scene: z.string().startsWith("res://").endsWith(".tscn"),
  historyVersion: z.number().int().nonnegative(),
});

export type EditorSceneOpenResult = z.infer<typeof EditorSceneOpenResultSchema>;

export const ProjectContextSchema = z.object({
  ok: z.literal(true),
  project: ProjectInfoSchema,
  identity: ProjectIdentitySchema,
  editor: EditorBridgeInfoSchema.nullable(),
  runtime: RuntimeBridgeInfoSchema.nullable(),
}).strict();

export type ProjectContext = z.infer<typeof ProjectContextSchema>;

export const EditorCamera3DSchema = z.object({
  projection: z.enum(["perspective", "orthogonal", "frustum"]),
  position: Vector3ValueSchema,
  rotationDegrees: Vector3ValueSchema,
  fov: z.number(),
  size: z.number(),
  near: z.number().positive(),
  far: z.number().positive(),
});

export const EditorScreenshotResultSchema = RuntimeScreenshotResultSchema.extend({
  viewport: z.enum(["2d", "3d"]),
  viewportIndex: z.number().int().min(0).max(3).nullable(),
  camera: EditorCamera3DSchema.nullable(),
});

export type EditorScreenshotResult = z.infer<typeof EditorScreenshotResultSchema>;

export interface EditorSceneNode {
  readonly path: string;
  readonly name: string;
  readonly type: string;
  readonly owner: string | null;
  readonly children: EditorSceneNode[];
}

export const EditorSceneNodeSchema: z.ZodType<EditorSceneNode> = z.lazy(() =>
  z.object({
    path: z.string().min(1),
    name: z.string(),
    type: z.string().min(1),
    owner: z.string().nullable(),
    children: z.array(EditorSceneNodeSchema),
  }),
);

export const EditorSceneTreeResultSchema = z.object({
  ok: z.literal(true),
  runId: z.uuid(),
  root: EditorSceneNodeSchema.nullable(),
  truncated: z.boolean(),
});

export type EditorSceneTreeResult = z.infer<typeof EditorSceneTreeResultSchema>;

export const EditorNodeSchema = z.object({
  path: z.string().min(1),
  name: z.string(),
  type: z.string().min(1),
  owner: z.string().nullable(),
  properties: z.record(z.string(), z.unknown()),
});

export type EditorNode = z.infer<typeof EditorNodeSchema>;

export const EditorNodeResultSchema = z.object({
  ok: z.literal(true),
  runId: z.uuid(),
  node: EditorNodeSchema,
});

export type EditorNodeResult = z.infer<typeof EditorNodeResultSchema>;

export const EditorMutationResultSchema = z.object({
  ok: z.literal(true),
  runId: z.uuid(),
  action: z.enum(["create", "update", "delete", "move", "instantiate"]),
  node: EditorNodeSchema.nullable(),
  deletedNode: EditorNodeSchema.optional(),
  previousPath: z.string().nullable(),
  previousParentPath: z.string().optional(),
  parentPath: z.string().optional(),
  index: z.number().int().nonnegative().optional(),
  scenePath: z.string().startsWith("res://").optional(),
  changedProperties: z.array(z.string()),
  undoable: z.literal(true),
  historyVersion: z.number().int().nonnegative(),
});

export type EditorMutationResult = z.infer<typeof EditorMutationResultSchema>;

export const EditorInheritedSceneResultSchema = z.object({
  ok: z.literal(true),
  runId: z.uuid(),
  created: z.literal(true),
  sourceScene: z.string().startsWith("res://").endsWith(".tscn"),
  targetScene: z.string().startsWith("res://").endsWith(".tscn"),
  rootName: z.string().min(1),
  opened: z.boolean(),
  overwritten: z.boolean(),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  undoable: z.literal(false),
});

export type EditorInheritedSceneResult = z.infer<typeof EditorInheritedSceneResultSchema>;

export const EditorSignalConnectionResultSchema = z.object({
  ok: z.literal(true),
  runId: z.uuid(),
  action: z.literal("signal_connect"),
  sourcePath: z.string().min(1),
  signal: z.string().min(1),
  targetPath: z.string().min(1),
  method: z.string().min(1),
  flags: z.number().int().nonnegative(),
  undoable: z.literal(true),
  historyVersion: z.number().int().nonnegative(),
});

export type EditorSignalConnectionResult = z.infer<
  typeof EditorSignalConnectionResultSchema
>;

export const EditorSceneSaveResultSchema = z.object({
  ok: z.literal(true),
  runId: z.uuid(),
  saved: z.literal(true),
  scene: z.string().startsWith("res://"),
  error: z.literal(0),
  historyVersion: z.number().int().nonnegative(),
});

export type EditorSceneSaveResult = z.infer<typeof EditorSceneSaveResultSchema>;

export const EditorHistoryResultSchema = z.object({
  ok: z.literal(true),
  runId: z.uuid(),
  action: z.enum(["undo", "redo"]),
  performed: z.literal(true),
  actionName: z.string(),
  beforeVersion: z.number().int().nonnegative(),
  afterVersion: z.number().int().nonnegative(),
  historyVersion: z.number().int().nonnegative(),
});

export type EditorHistoryResult = z.infer<typeof EditorHistoryResultSchema>;

export const EditorResourceSchema = z.object({
  $type: z.literal("Resource"),
  path: z.string(),
  class: z.string().min(1),
  properties: z.record(z.string(), z.unknown()),
});

export const EditorResourceResultSchema = z.object({
  ok: z.literal(true),
  runId: z.uuid(),
  action: z.enum(["resource_create", "resource_update"]),
  nodePath: z.string().min(1),
  property: z.string().min(1),
  resource: EditorResourceSchema,
  changedProperties: z.array(z.string()),
  undoable: z.literal(true),
  historyVersion: z.number().int().nonnegative(),
});

export type EditorResourceResult = z.infer<typeof EditorResourceResultSchema>;

export const EditorResourceReadResultSchema = z.object({
  ok: z.literal(true),
  runId: z.uuid(),
  nodePath: z.string().min(1),
  property: z.string().min(1),
  resource: EditorResourceSchema,
});

export type EditorResourceReadResult = z.infer<typeof EditorResourceReadResultSchema>;

export const EditorInstanceResultSchema = z.object({
  ok: z.literal(true),
  runId: z.uuid(),
  nodePath: z.string().min(1),
  scenePath: z.string().startsWith("res://"),
  editable: z.boolean(),
});

export type EditorInstanceResult = z.infer<typeof EditorInstanceResultSchema>;

export const EditorInstanceMutationResultSchema = EditorInstanceResultSchema.extend({
  action: z.literal("instance_set_editable"),
  previousEditable: z.boolean(),
  undoable: z.literal(true),
  historyVersion: z.number().int().nonnegative(),
});

export type EditorInstanceMutationResult = z.infer<typeof EditorInstanceMutationResultSchema>;

export const EditorSelectionResultSchema = z.object({
  ok: z.literal(true),
  runId: z.uuid(),
  paths: z.array(z.string().min(1)).max(100),
  focusedPath: z.string().min(1).nullable(),
});

export type EditorSelectionResult = z.infer<typeof EditorSelectionResultSchema>;

export const EditorResourceSaveResultSchema = z.object({
  ok: z.literal(true),
  runId: z.uuid(),
  saved: z.literal(true),
  nodePath: z.string().min(1),
  property: z.string().min(1),
  path: z.string().startsWith("res://").endsWith(".tres"),
  previousPath: z.string(),
  class: z.string().min(1),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  overwritten: z.boolean(),
  undoable: z.literal(false),
  referenceUndoable: z.literal(true),
  fileUndoable: z.literal(false),
  historyVersion: z.number().int().nonnegative(),
});

export type EditorResourceSaveResult = z.infer<typeof EditorResourceSaveResultSchema>;

export const EditorResourceFocusResultSchema = z.object({
  ok: z.literal(true),
  runId: z.uuid(),
  selected: z.literal(true),
  path: z.string().startsWith("res://"),
  class: z.string().min(1),
});

export type EditorResourceFocusResult = z.infer<typeof EditorResourceFocusResultSchema>;
