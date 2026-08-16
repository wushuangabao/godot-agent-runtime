import {
  McpServer,
  type CallToolResult,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  checkProject,
  assertRuntime,
  captureRuntimeScreenshot,
  controlRuntime,
  connectEditorSignal,
  createEditorNode,
  createEditorResource,
  deleteEditorNode,
  findProjects,
  findRuntimeUi,
  focusEditorResource,
  getEditorInstance,
  getEditorInfo,
  getEditorNode,
  getEditorSceneTree,
  getEditorSelection,
  getEditorResource,
  getManagedRunStatus,
  getRuntimeInfo,
  getRuntimeNode,
  getRuntimeSceneTree,
  inspectProject,
  injectRuntimeInput,
  injectRuntimeInputSequence,
  installGodotAddon,
  instantiateEditorScene,
  launchEditor,
  launchProject,
  moveEditorNode,
  readProjectFile,
  redoEditorAction,
  runDoctor,
  runProject,
  stopManagedRun,
  saveEditorScene,
  saveEditorResource,
  setEditorSelection,
  setEditorInstanceEditable,
  toRuntimeError,
  writeProjectFile,
  updateEditorNode,
  updateEditorResource,
  undoEditorAction,
  waitForRuntime,
  type RuntimeUiSelector,
} from "@godot-agent-runtime/core";
import {
  DoctorResultSchema,
  AddonInstallResultSchema,
  EditorBridgeInfoSchema,
  EditorHistoryResultSchema,
  EditorInstanceMutationResultSchema,
  EditorInstanceResultSchema,
  EditorMutationResultSchema,
  EditorNodeResultSchema,
  EditorResourceResultSchema,
  EditorResourceReadResultSchema,
  EditorResourceFocusResultSchema,
  EditorResourceSaveResultSchema,
  EditorSceneSaveResultSchema,
  EditorSceneTreeResultSchema,
  EditorSelectionResultSchema,
  EditorSignalConnectionResultSchema,
  GodotLaunchResultSchema,
  GodotRunResultSchema,
  GodotRunStatusSchema,
  ProjectDiscoveryResultSchema,
  ProjectInfoSchema,
  RuntimeAssertionResultSchema,
  RuntimeBridgeInfoSchema,
  RuntimeControlResultSchema,
  RuntimeInputResultSchema,
  RuntimeInputSequenceResultSchema,
  RuntimeNodeResultSchema,
  RuntimeSceneTreeResultSchema,
  RuntimeScreenshotResultSchema,
  RuntimeUiResultSchema,
  RuntimeWaitResultSchema,
  SafeFileReadResultSchema,
  SafeFileWriteResultSchema,
} from "@godot-agent-runtime/protocol";

const ConfigInputSchema = z.object({
  configPath: z.string().min(1).optional(),
});

const ProjectInputSchema = z.object({
  projectPath: z.string().min(1),
});

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

const StopInputSchema = RunLookupInputSchema.extend({
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
});

const RuntimeLookupInputSchema = z.object({
  projectPath: z.string().min(1),
  runId: z.uuid(),
  timeoutMs: z.number().int().min(100).max(30_000).optional(),
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

const EditorPropertiesSchema = z.record(z.string().min(1), z.unknown()).refine(
  (value) => Object.keys(value).length <= 100,
  "properties must contain at most 100 entries",
);

const EditorNodeCreateInputSchema = RuntimeLookupInputSchema.extend({
  parentPath: z.string().min(1),
  type: z.string().min(1),
  name: z.string().min(1),
  properties: EditorPropertiesSchema.default({}),
});

const EditorSceneInstantiateInputSchema = RuntimeLookupInputSchema.extend({
  parentPath: z.string().min(1),
  scenePath: z.string().startsWith("res://").endsWith(".tscn"),
  name: z.string().min(1).optional(),
  properties: EditorPropertiesSchema.default({}),
});

const EditorNodeUpdateInputSchema = RuntimeLookupInputSchema.extend({
  nodePath: z.string().min(1),
  name: z.string().min(1).optional(),
  properties: EditorPropertiesSchema.default({}),
}).superRefine((value, context) => {
  if (value.name === undefined && Object.keys(value.properties).length === 0) {
    context.addIssue({ code: "custom", message: "update requires name or properties" });
  }
});

const EditorNodeDeleteInputSchema = RuntimeLookupInputSchema.extend({
  nodePath: z.string().min(1),
});

const EditorNodeMoveInputSchema = RuntimeLookupInputSchema.extend({
  nodePath: z.string().min(1),
  newParentPath: z.string().min(1),
  index: z.number().int().min(-1).optional(),
  keepGlobalTransform: z.boolean().default(true),
});

const EditorResourceCreateInputSchema = RuntimeLookupInputSchema.extend({
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

const EditorResourceUpdateInputSchema = RuntimeLookupInputSchema.extend({
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

const EditorInstanceSetEditableInputSchema = EditorInstanceLookupInputSchema.extend({
  editable: z.boolean(),
});

const EditorResourceSaveInputSchema = RuntimeLookupInputSchema.extend({
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

const EditorSignalConnectInputSchema = RuntimeLookupInputSchema.extend({
  sourcePath: z.string().min(1),
  signal: z.string().min(1),
  targetPath: z.string().min(1),
  method: z.string().min(1),
  flags: z.number().int().min(0).max(15).optional(),
});

const FileReadInputSchema = z.object({
  projectPath: z.string().min(1),
  path: z.string().min(1),
  maxBytes: z.number().int().min(1).max(1_048_576).optional(),
});

const FileWriteInputSchema = FileReadInputSchema.extend({
  content: z.string(),
  expectedSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
  createDirectories: z.boolean().default(false),
});

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
  operation: () => Promise<T>,
): Promise<CallToolResult> {
  try {
    return success(await operation());
  } catch (error) {
    return failure(error);
  }
}

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "godot-agent-runtime", version: "0.1.0" },
    {
      instructions:
        "Call godot_doctor before project operations. Use godot_project_check after file changes. Use godot_scene_run for bounded headless verification; use godot_scene_launch followed by godot_run_status and godot_run_stop for a visible interactive window.",
    },
  );

  server.registerTool(
    "godot_doctor",
    {
      title: "Diagnose Godot development environment",
      description:
        "Checks Node.js, local configuration, Godot, optional DeepSeek Harness, and loopback TCP readiness.",
      inputSchema: ConfigInputSchema,
      outputSchema: DoctorResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ configPath }) =>
      await handle(async () => {
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
      inputSchema: ProjectDiscoveryInputSchema,
      outputSchema: ProjectDiscoveryResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ searchRoot, maxDepth, maxProjects }) =>
      await handle(async () =>
        await findProjects(searchRoot, { maxDepth, maxProjects }),
      ),
  );

  server.registerTool(
    "godot_project_inspect",
    {
      title: "Inspect a Godot project",
      description:
        "Reads project.godot and returns the project name, main scene, renderer, and enabled plugins.",
      inputSchema: ProjectInputSchema,
      outputSchema: ProjectInfoSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ projectPath }) => await handle(async () => await inspectProject(projectPath)),
  );

  server.registerTool(
    "godot_project_check",
    {
      title: "Import and validate a Godot project",
      description:
        "Starts the configured Godot editor in headless mode, imports the project, and returns bounded diagnostics.",
      inputSchema: GodotOperationInputSchema,
      outputSchema: GodotRunResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ projectPath, configPath, timeoutMs, maxOutputBytes }) =>
      await handle(async () =>
        await checkProject({
          projectPath,
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
      inputSchema: FileReadInputSchema,
      outputSchema: SafeFileReadResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ projectPath, path, maxBytes }) =>
      await handle(async () =>
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
        "Atomically creates or updates an allowlisted UTF-8 project file. Pass expectedSha256 from godot_file_read (or null to require creation) to prevent lost updates.",
      inputSchema: FileWriteInputSchema,
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
      expectedSha256,
      createDirectories,
      maxBytes,
    }) =>
      await handle(async () =>
        await writeProjectFile({
          projectPath,
          path,
          content,
          createDirectories,
          ...(expectedSha256 === undefined ? {} : { expectedSha256 }),
          ...(maxBytes === undefined ? {} : { maxBytes }),
        }),
      ),
  );

  server.registerTool(
    "godot_addon_install",
    {
      title: "Install the Godot Agent Runtime addon",
      description: "Copies the versioned EditorPlugin into the project and enables it while preserving existing enabled plugins.",
      inputSchema: ProjectInputSchema,
      outputSchema: AddonInstallResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath }) =>
      await handle(async () => ({ ...(await installGodotAddon(projectPath)) })),
  );

  server.registerTool(
    "godot_scene_run",
    {
      title: "Run a Godot scene headlessly",
      description:
        "Runs the main or specified scene for a bounded number of frames and returns console output and diagnostics.",
      inputSchema: RunInputSchema,
      outputSchema: GodotRunResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ projectPath, configPath, timeoutMs, maxOutputBytes, scene }) =>
      await handle(async () =>
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
      inputSchema: LaunchInputSchema,
      outputSchema: GodotLaunchResultSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ projectPath, configPath, scene, startupTimeoutMs }) =>
      await handle(async () =>
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
      inputSchema: RunLookupInputSchema,
      outputSchema: GodotRunStatusSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ projectPath, runId, maxOutputBytes }) =>
      await handle(async () =>
        await getManagedRunStatus({
          projectPath,
          runId,
          ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
        }),
      ),
  );

  server.registerTool(
    "godot_run_stop",
    {
      title: "Stop a visible Godot run",
      description:
        "Requests a token-authenticated stop for a runId and waits for a terminal state. Repeated calls are safe.",
      inputSchema: StopInputSchema,
      outputSchema: GodotRunStatusSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ projectPath, runId, maxOutputBytes, timeoutMs }) =>
      await handle(async () =>
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
      inputSchema: RuntimeLookupInputSchema,
      outputSchema: RuntimeBridgeInfoSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ projectPath, runId, timeoutMs }) =>
      await handle(async () =>
        await getRuntimeInfo({ projectPath, runId, ...(timeoutMs === undefined ? {} : { timeoutMs }) }),
      ),
  );

  server.registerTool(
    "godot_runtime_screenshot",
    {
      title: "Capture the running game",
      description: "Captures the root viewport to a PNG under the run-specific evidence directory and returns path, dimensions, size, and SHA-256.",
      inputSchema: RuntimeLookupInputSchema,
      outputSchema: RuntimeScreenshotResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs }) =>
      await handle(async () =>
        await captureRuntimeScreenshot({ projectPath, runId, ...(timeoutMs === undefined ? {} : { timeoutMs }) }),
      ),
  );

  server.registerTool(
    "godot_runtime_ui_find",
    {
      title: "Find visible runtime UI",
      description: "Returns bounded Control nodes with stable paths, types, text, visibility, disabled state, and global rectangles.",
      inputSchema: RuntimeUiInputSchema,
      outputSchema: RuntimeUiResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ projectPath, runId, timeoutMs, selector, limit }) =>
      await handle(async () =>
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
      inputSchema: RuntimeSceneTreeInputSchema,
      outputSchema: RuntimeSceneTreeResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ projectPath, runId, timeoutMs, maxDepth, maxNodes }) =>
      await handle(async () =>
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
      inputSchema: RuntimeNodeLookupInputSchema,
      outputSchema: RuntimeNodeResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ projectPath, runId, timeoutMs, nodePath, properties }) =>
      await handle(async () =>
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
    "godot_runtime_input",
    {
      title: "Inject bounded runtime input",
      description: "Clicks a Control path or coordinates, pulses an InputMap action, or sends a numeric keycode. Hold duration is capped at 2 seconds.",
      inputSchema: RuntimeInputSchema,
      outputSchema: RuntimeInputResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (value) =>
      await handle(async () => {
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
      inputSchema: RuntimeInputSequenceSchema,
      outputSchema: RuntimeInputSequenceResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs, steps }) =>
      await handle(async () => {
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
      inputSchema: RuntimeAssertInputSchema,
      outputSchema: RuntimeAssertionResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (value) =>
      await handle(async () => {
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
      inputSchema: RuntimeWaitInputSchema,
      outputSchema: RuntimeWaitResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (value) =>
      await handle(async () => {
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
      inputSchema: RuntimeControlInputSchema,
      outputSchema: RuntimeControlResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs, action, frames }) =>
      await handle(async () => {
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
      inputSchema: GodotOperationInputSchema.omit({ maxOutputBytes: true }),
      outputSchema: GodotLaunchResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, configPath, timeoutMs }) =>
      await handle(async () =>
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
      inputSchema: RuntimeLookupInputSchema,
      outputSchema: EditorBridgeInfoSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ projectPath, runId, timeoutMs }) =>
      await handle(async () =>
        await getEditorInfo({ projectPath, runId, ...(timeoutMs === undefined ? {} : { timeoutMs }) }),
      ),
  );

  server.registerTool(
    "godot_editor_scene_tree",
    {
      title: "Read the edited scene tree",
      description: "Returns the currently edited scene as a bounded-depth structural tree of paths, names, types, and owners.",
      inputSchema: RuntimeLookupInputSchema,
      outputSchema: EditorSceneTreeResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ projectPath, runId, timeoutMs }) =>
      await handle(async () =>
        await getEditorSceneTree({ projectPath, runId, ...(timeoutMs === undefined ? {} : { timeoutMs }) }),
      ),
  );

  server.registerTool(
    "godot_editor_node_get",
    {
      title: "Read an edited scene node",
      description: "Reads one edited-scene node and up to 100 named properties. Godot Variants use tagged JSON objects such as {$type:'Vector2',x,y}.",
      inputSchema: EditorNodeLookupInputSchema,
      outputSchema: EditorNodeResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ projectPath, runId, timeoutMs, nodePath, properties }) =>
      await handle(async () =>
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
      inputSchema: RuntimeLookupInputSchema,
      outputSchema: EditorSelectionResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ projectPath, runId, timeoutMs }) =>
      await handle(async () =>
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
      inputSchema: EditorSelectionSetInputSchema,
      outputSchema: EditorSelectionResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs, paths, focus }) =>
      await handle(async () =>
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
    "godot_editor_node_create",
    {
      title: "Create an edited scene node",
      description: "Creates an instantiable Godot Node under parentPath, sets owner to the edited root, applies validated properties, and records one native Undo/Redo action.",
      inputSchema: EditorNodeCreateInputSchema,
      outputSchema: EditorMutationResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs, parentPath, type, name, properties }) =>
      await handle(async () =>
        await createEditorNode({
          projectPath,
          runId,
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
      inputSchema: EditorSceneInstantiateInputSchema,
      outputSchema: EditorMutationResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs, parentPath, scenePath, name, properties }) =>
      await handle(async () =>
        await instantiateEditorScene({
          projectPath,
          runId,
          parentPath,
          scenePath,
          properties,
          ...(name === undefined ? {} : { name }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      ),
  );

  server.registerTool(
    "godot_editor_instance_get",
    {
      title: "Read PackedScene instance editability",
      description: "Reports the source scene and editable-children state of an instantiated PackedScene root.",
      inputSchema: EditorInstanceLookupInputSchema,
      outputSchema: EditorInstanceResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ projectPath, runId, timeoutMs, nodePath }) =>
      await handle(async () =>
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
      inputSchema: EditorInstanceSetEditableInputSchema,
      outputSchema: EditorInstanceMutationResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs, nodePath, editable }) =>
      await handle(async () =>
        await setEditorInstanceEditable({
          projectPath,
          runId,
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
      inputSchema: EditorNodeUpdateInputSchema,
      outputSchema: EditorMutationResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs, nodePath, name, properties }) =>
      await handle(async () =>
        await updateEditorNode({
          projectPath,
          runId,
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
      inputSchema: EditorNodeDeleteInputSchema,
      outputSchema: EditorMutationResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs, nodePath }) =>
      await handle(async () =>
        await deleteEditorNode({
          projectPath,
          runId,
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
      inputSchema: EditorNodeMoveInputSchema,
      outputSchema: EditorMutationResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs, nodePath, newParentPath, index, keepGlobalTransform }) =>
      await handle(async () =>
        await moveEditorNode({
          projectPath,
          runId,
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
      inputSchema: EditorResourceCreateInputSchema,
      outputSchema: EditorResourceResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs, nodePath, property, type, properties }) =>
      await handle(async () =>
        await createEditorResource({
          projectPath,
          runId,
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
      inputSchema: EditorResourceLookupInputSchema,
      outputSchema: EditorResourceReadResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ projectPath, runId, timeoutMs, nodePath, property, properties }) =>
      await handle(async () =>
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
      inputSchema: EditorResourceUpdateInputSchema,
      outputSchema: EditorResourceResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs, nodePath, property, properties }) =>
      await handle(async () =>
        await updateEditorResource({
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
    "godot_editor_resource_save",
    {
      title: "Save an external Godot resource",
      description: "Saves a node's Resource property as a project-local .tres. Overwrite is rejected by default; the filesystem side effect is not undoable.",
      inputSchema: EditorResourceSaveInputSchema,
      outputSchema: EditorResourceSaveResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs, nodePath, property, path, overwrite }) =>
      await handle(async () =>
        await saveEditorResource({
          projectPath,
          runId,
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
      inputSchema: EditorResourceFocusInputSchema,
      outputSchema: EditorResourceFocusResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs, path }) =>
      await handle(async () =>
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
      inputSchema: EditorSignalConnectInputSchema,
      outputSchema: EditorSignalConnectionResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs, sourcePath, signal, targetPath, method, flags }) =>
      await handle(async () =>
        await connectEditorSignal({
          projectPath,
          runId,
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
      inputSchema: RuntimeLookupInputSchema,
      outputSchema: EditorSceneSaveResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs }) =>
      await handle(async () =>
        await saveEditorScene({
          projectPath,
          runId,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      ),
  );

  server.registerTool(
    "godot_editor_undo",
    {
      title: "Undo an edited scene action",
      description: "Undoes the latest action in the active scene's native Godot Undo/Redo history.",
      inputSchema: RuntimeLookupInputSchema,
      outputSchema: EditorHistoryResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs }) =>
      await handle(async () =>
        await undoEditorAction({
          projectPath,
          runId,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      ),
  );

  server.registerTool(
    "godot_editor_redo",
    {
      title: "Redo an edited scene action",
      description: "Redoes the next action in the active scene's native Godot Undo/Redo history.",
      inputSchema: RuntimeLookupInputSchema,
      outputSchema: EditorHistoryResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs }) =>
      await handle(async () =>
        await redoEditorAction({
          projectPath,
          runId,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      ),
  );

  server.registerTool(
    "godot_editor_screenshot",
    {
      title: "Capture the editor 2D viewport",
      description: "Captures the managed editor's 2D viewport into the run-specific evidence directory.",
      inputSchema: RuntimeLookupInputSchema,
      outputSchema: RuntimeScreenshotResultSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectPath, runId, timeoutMs }) =>
      await handle(async () =>
        await captureRuntimeScreenshot({ projectPath, runId, ...(timeoutMs === undefined ? {} : { timeoutMs }) }),
      ),
  );

  return server;
}
