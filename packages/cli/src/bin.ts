#!/usr/bin/env node

import {
  checkProject,
  checkScript,
  batchEditorScene,
  configureClient,
  assertRuntime,
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
  getEditorResource,
  inspectEditorResourcePath,
  getEditorSceneTree,
  getEditorSelection,
  getManagedRunStatus,
  getDiagnosticsSummary,
  getAgentGuide,
  getProjectContext,
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
  redoEditorAction,
  replaceProjectText,
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
  undoEditorAction,
  updateEditorNode,
  updateEditorResource,
  upsertEditorInputAction,
  waitForRuntime,
  writeProjectFile,
  type RuntimeInputStep,
  type EditorBatchOptions,
  type EditorInputActionUpsertOptions,
  type EditorProjectSettingSetOptions,
  RuntimeFailure,
  type RecipeId,
} from "@godot-agent-runtime/core";
import { parseFiniteNumber, parseFiniteVector3, parseInteger } from "./numeric.js";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function positional(args: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index]?.startsWith("--")) {
      if (args[index] !== "--create-only") index += 1;
      continue;
    }
    values.push(args[index] ?? "");
  }
  return values;
}

function assertCommandShape(
  args: string[],
  command: string,
  positionalCount: number,
  allowedOptions: ReadonlySet<string>,
): void {
  let actualPositionals = 0;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (!argument.startsWith("--")) {
      actualPositionals += 1;
      continue;
    }
    if (!allowedOptions.has(argument)) throw new Error(`${command} does not support ${argument}.`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    index += 1;
  }
  if (actualPositionals !== positionalCount) {
    throw new Error(`${command} received ${actualPositionals} positional arguments; expected ${positionalCount}.`);
  }
}

function sha256Option(args: string[], name: string): string | undefined {
  const value = option(args, name);
  if (value !== undefined && !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 hash.`);
  }
  return value;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseJsonObject(source: string | undefined, optionName: string): Record<string, unknown> | undefined {
  if (source === undefined) return undefined;
  const value: unknown = JSON.parse(source);
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${optionName} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function parseJsonStringArray(source: string | undefined, optionName: string): string[] | undefined {
  if (source === undefined) return undefined;
  const value: unknown = JSON.parse(source);
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${optionName} must be a JSON string array.`);
  }
  return value;
}

function parseJsonArray(source: string | undefined, optionName: string): unknown[] | undefined {
  if (source === undefined) return undefined;
  const value: unknown = JSON.parse(source);
  if (!Array.isArray(value)) throw new Error(`${optionName} must be a JSON array.`);
  return value;
}

function parseBoolean(source: string | undefined, optionName: string): boolean | undefined {
  if (source === undefined) return undefined;
  if (source === "true") return true;
  if (source === "false") return false;
  throw new Error(`${optionName} must be true or false.`);
}

function parseLogCursor(source: string | undefined): { stdoutBytes: number; stderrBytes: number } | undefined {
  const value = parseJsonObject(source, "--cursor");
  if (value === undefined) return undefined;
  if (
    Object.keys(value).some((key) => key !== "stdoutBytes" && key !== "stderrBytes") ||
    !Number.isInteger(value.stdoutBytes) || Number(value.stdoutBytes) < 0 ||
    !Number.isInteger(value.stderrBytes) || Number(value.stderrBytes) < 0
  ) {
    throw new Error("--cursor must be a strict JSON object with non-negative integer stdoutBytes and stderrBytes.");
  }
  return {
    stdoutBytes: Number(value.stdoutBytes),
    stderrBytes: Number(value.stderrBytes),
  };
}

function editorMutationGuard(args: string[]): {
  expectedProjectFingerprint?: string;
  expectedScenePath: string;
} {
  const expectedScenePath = option(args, "--expected-scene");
  if (expectedScenePath === undefined) {
    throw new RuntimeFailure({
      code: "EDITOR_SCENE_PATH_REQUIRED",
      stage: "validation",
      message: "--expected-scene is required for persistent editor mutations.",
      recovery: ["Run editor-status and pass its scene as --expected-scene."],
    });
  }
  const expectedProjectFingerprint = sha256Option(args, "--expected-project-fingerprint");
  return {
    expectedScenePath,
    ...(expectedProjectFingerprint === undefined ? {} : { expectedProjectFingerprint }),
  };
}

function editorHistoryGuard(args: string[]): {
  expectedProjectFingerprint?: string;
  expectedScenePath: string;
  expectedHistoryVersion: number;
  expectedActionName?: string;
} {
  const mutation = editorMutationGuard(args);
  const source = option(args, "--expected-history-version");
  if (source === undefined) {
    throw new RuntimeFailure({
      code: "EDITOR_HISTORY_VERSION_REQUIRED",
      stage: "validation",
      message: "--expected-history-version is required for editor save, undo, and redo.",
      recovery: ["Run editor-status or use the previous mutation receipt's historyVersion."],
    });
  }
  const expectedActionName = option(args, "--expected-action");
  return {
    ...mutation,
    expectedHistoryVersion: parseInteger(source, "--expected-history-version", { min: 0 }),
    ...(expectedActionName === undefined ? {} : { expectedActionName }),
  };
}

function printHelp(): void {
  process.stdout.write(`godot-agent-runtime commands:\n\n`);
  process.stdout.write(`  doctor [--config PATH]\n`);
  process.stdout.write(`  find [SEARCH_ROOT] [--max-depth N] [--limit N]\n`);
  process.stdout.write(`  inspect PROJECT_PATH\n`);
  process.stdout.write(`  context PROJECT_PATH [--editor-run-id RUN_ID] [--runtime-run-id RUN_ID]\n`);
  process.stdout.write(`  agent-guide [edit-and-verify-ui|edit-and-verify-3d|fix-script-error|safe-scene-batch|collect-debug-report]\n`);
  process.stdout.write(`  check PROJECT_PATH [--config PATH] [--timeout MS]\n`);
  process.stdout.write(`  script-check PROJECT_PATH RES_PATH [--config PATH] [--timeout MS] [--max-output BYTES]\n`);
  process.stdout.write(`  file-read PROJECT_PATH RES_PATH\n`);
  process.stdout.write(`  file-write PROJECT_PATH RES_PATH --content TEXT (--create-only | --expected-sha256 HASH) [--expected-project-fingerprint HASH]\n`);
  process.stdout.write(`  file-replace PROJECT_PATH RES_PATH --project-fingerprint HASH --old TEXT --new TEXT [--replace-all true|false]\n`);
  process.stdout.write(`  run PROJECT_PATH [--scene RES_PATH] [--config PATH] [--timeout MS]  # headless\n`);
  process.stdout.write(`  launch PROJECT_PATH [--scene RES_PATH] [--config PATH] [--timeout MS]\n`);
  process.stdout.write(`  status PROJECT_PATH RUN_ID [--max-output BYTES]\n`);
  process.stdout.write(`  log-read PROJECT_PATH RUN_ID [--cursor JSON] [--stream stdout|stderr|combined] [--minimum-severity error|warning|info] [--contains TEXT] [--max-lines N] [--deduplicate true|false] [--raw true|false]\n`);
  process.stdout.write(`  diagnostics PROJECT_PATH RUN_ID [--cursor JSON] [--max-issues N]\n`);
  process.stdout.write(`  debug-report PROJECT_PATH --project-fingerprint HASH --issue TEXT [--run-id RUN_ID] [--reproduction TEXT] [--cursor JSON] [--format markdown|json]\n`);
  process.stdout.write(`  stop PROJECT_PATH RUN_ID [--timeout MS] [--max-output BYTES]\n`);
  process.stdout.write(`  configure <codex|deepseek-harness|claude-code> [--project PATH] [--server PATH]\n`);
  process.stdout.write(`  addon-install PROJECT_PATH\n`);
  process.stdout.write(`  editor-launch PROJECT_PATH [--config PATH] [--timeout MS]\n`);
  process.stdout.write(`  editor-status PROJECT_PATH RUN_ID\n`);
  process.stdout.write(`  editor-project-setting-get PROJECT_PATH RUN_ID --key NAME\n`);
  process.stdout.write(`  editor-project-setting-set PROJECT_PATH RUN_ID --project-fingerprint HASH --project-sha256 HASH --key NAME --value JSON\n`);
  process.stdout.write(`  editor-input-action-upsert PROJECT_PATH RUN_ID --project-fingerprint HASH --project-sha256 HASH --name NAME --deadzone N --replace-events true|false --events JSON_ARRAY\n`);
  process.stdout.write(`  editor-resource-inspect PROJECT_PATH RUN_ID --path RES_PATH [--properties JSON_ARRAY]\n`);
  process.stdout.write(`  editor-scene-open PROJECT_PATH RUN_ID --project-fingerprint HASH --scene RES_PATH\n`);
  process.stdout.write(`  editor-tree PROJECT_PATH RUN_ID\n`);
  process.stdout.write(`  editor-node-get PROJECT_PATH RUN_ID --node NODE_PATH [--properties JSON_ARRAY]\n`);
  process.stdout.write(`  editor-node-create PROJECT_PATH RUN_ID --parent NODE_PATH --type TYPE --name NAME [--properties JSON_OBJECT]\n`);
  process.stdout.write(`  editor-scene-instantiate PROJECT_PATH RUN_ID --parent NODE_PATH --scene RES_PATH [--name NAME] [--properties JSON_OBJECT]\n`);
  process.stdout.write(`  editor-scene-inherit PROJECT_PATH RUN_ID --source RES_PATH --target RES_PATH [--root-name NAME] [--root-properties JSON_OBJECT] [--open true|false] [--overwrite true|false]\n`);
  process.stdout.write(`  editor-instance-get PROJECT_PATH RUN_ID --node NODE_PATH\n`);
  process.stdout.write(`  editor-instance-set-editable PROJECT_PATH RUN_ID --node NODE_PATH --editable true|false\n`);
  process.stdout.write(`  editor-node-update PROJECT_PATH RUN_ID --node NODE_PATH [--name NAME] [--properties JSON_OBJECT]\n`);
  process.stdout.write(`  editor-node-delete PROJECT_PATH RUN_ID --node NODE_PATH\n`);
  process.stdout.write(`  editor-node-move PROJECT_PATH RUN_ID --node NODE_PATH --parent NODE_PATH [--index N] [--keep-global-transform true|false]\n`);
  process.stdout.write(`  editor-resource-create PROJECT_PATH RUN_ID --node NODE_PATH --property NAME --type TYPE [--properties JSON_OBJECT]\n`);
  process.stdout.write(`  editor-resource-get PROJECT_PATH RUN_ID --node NODE_PATH --property NAME [--properties JSON_ARRAY]\n`);
  process.stdout.write(`  editor-resource-update PROJECT_PATH RUN_ID --node NODE_PATH --property NAME --properties JSON_OBJECT\n`);
  process.stdout.write(`  editor-resource-save PROJECT_PATH RUN_ID --node NODE_PATH --property NAME --path RES_PATH [--overwrite true|false]\n`);
  process.stdout.write(`  editor-resource-focus PROJECT_PATH RUN_ID --path RES_PATH\n`);
  process.stdout.write(`  editor-selection-get PROJECT_PATH RUN_ID\n`);
  process.stdout.write(`  editor-selection-set PROJECT_PATH RUN_ID --paths JSON_ARRAY [--focus true|false]\n`);
  process.stdout.write(`  editor-batch PROJECT_PATH RUN_ID --project-fingerprint HASH --scene RES_PATH --operations JSON_ARRAY [--action-name TEXT] --confirm-destructive true|false\n`);
  process.stdout.write(`  editor-signal-connect PROJECT_PATH RUN_ID --source NODE_PATH --signal NAME --target NODE_PATH --method NAME [--flags N]\n`);
  process.stdout.write(`  persistent editor mutations also require --expected-scene RES_PATH [--expected-project-fingerprint HASH]\n`);
  process.stdout.write(`  editor-save PROJECT_PATH RUN_ID --expected-scene RES_PATH --expected-history-version N\n`);
  process.stdout.write(`  editor-undo PROJECT_PATH RUN_ID --expected-scene RES_PATH --expected-history-version N [--expected-action NAME]\n`);
  process.stdout.write(`  editor-redo PROJECT_PATH RUN_ID --expected-scene RES_PATH --expected-history-version N [--expected-action NAME]\n`);
  process.stdout.write(`  editor-screenshot PROJECT_PATH RUN_ID [--expected-scene RES_PATH] [--viewport 2d|3d] [--viewport-index 0..3]\n`);
  process.stdout.write(`  runtime-ui PROJECT_PATH RUN_ID [--text TEXT] [--type TYPE] [--path NODE_PATH]\n`);
  process.stdout.write(`  runtime-tree PROJECT_PATH RUN_ID [--max-depth N] [--max-nodes N]\n`);
  process.stdout.write(`  runtime-node-get PROJECT_PATH RUN_ID --node NODE_PATH [--properties JSON_ARRAY]\n`);
  process.stdout.write(`  runtime-observe PROJECT_PATH RUN_ID --nodes JSON_ARRAY [--properties JSON_ARRAY]\n`);
  process.stdout.write(`  runtime-simulate PROJECT_PATH RUN_ID --node NODE_PATH [--frames N] [--properties JSON_ARRAY] [--action NAME] [--strength N]\n`);
  process.stdout.write(`  runtime-3d-project PROJECT_PATH RUN_ID (--node NODE_PATH | --position JSON_OBJECT) [--camera NODE_PATH]\n`);
  process.stdout.write(`  runtime-3d-raycast PROJECT_PATH RUN_ID --x N --y N [--camera NODE_PATH] [--max-distance N] [--collision-mask N]\n`);
  process.stdout.write(`  screenshot PROJECT_PATH RUN_ID [--expected-scene RES_PATH]\n`);
  process.stdout.write(`  click PROJECT_PATH RUN_ID --path NODE_PATH\n`);
  process.stdout.write(`  input-sequence PROJECT_PATH RUN_ID --steps JSON_ARRAY\n`);
  process.stdout.write(`  assert-property PROJECT_PATH RUN_ID --node NODE_PATH --property NAME --expected JSON\n`);
  process.stdout.write(`  wait-property PROJECT_PATH RUN_ID --node NODE_PATH --property NAME --expected JSON [--operator OP] [--wait-timeout MS] [--poll-frames N]\n`);
  process.stdout.write(`  runtime-control PROJECT_PATH RUN_ID <pause|resume|step|step_physics> [--frames N]\n`);
}

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  const values = positional(args);
  const configPath = option(args, "--config");
  const timeout = option(args, "--timeout");
  const timeoutMs = timeout === undefined
    ? undefined
    : parseInteger(timeout, "--timeout", { min: 100, max: 120_000 });
  const scene = option(args, "--scene");

  switch (command) {
    case "doctor":
      print(await runDoctor(configPath));
      return;
    case "find":
      print(
        await findProjects(values[0] ?? ".", {
          ...(option(args, "--max-depth") === undefined
            ? {}
            : {
                maxDepth: parseInteger(option(args, "--max-depth") ?? "", "--max-depth", { min: 0, max: 12 }),
              }),
          ...(option(args, "--limit") === undefined
            ? {}
            : { maxProjects: parseInteger(option(args, "--limit") ?? "", "--limit", { min: 1, max: 500 }) }),
        }),
      );
      return;
    case "inspect":
      if (!values[0]) throw new Error("inspect requires PROJECT_PATH.");
      print(await inspectProject(values[0]));
      return;
    case "context": {
      if (!values[0]) throw new Error("context requires PROJECT_PATH.");
      const editorRunId = option(args, "--editor-run-id");
      const runtimeRunId = option(args, "--runtime-run-id");
      print(await getProjectContext({
        projectPath: values[0],
        ...(editorRunId === undefined ? {} : { editorRunId }),
        ...(runtimeRunId === undefined ? {} : { runtimeRunId }),
      }));
      return;
    }
    case "agent-guide": {
      assertCommandShape(args, "agent-guide", values.length, new Set());
      if (values.length > 1) throw new Error("agent-guide accepts at most one recipe id.");
      const recipeId = values[0];
      if (recipeId === undefined) {
        print(getAgentGuide());
        return;
      }
      if (![
        "edit-and-verify-ui",
        "edit-and-verify-3d",
        "fix-script-error",
        "safe-scene-batch",
        "collect-debug-report",
      ].includes(recipeId)) {
        throw new Error(`Unknown agent recipe: ${recipeId}`);
      }
      print(getAgentGuide(recipeId as RecipeId));
      return;
    }
    case "file-read":
      if (!values[0] || !values[1]) throw new Error("file-read requires PROJECT_PATH and RES_PATH.");
      print(await readProjectFile({ projectPath: values[0], path: values[1] }));
      return;
    case "file-write": {
      if (!values[0] || !values[1]) throw new Error("file-write requires PROJECT_PATH and RES_PATH.");
      const content = option(args, "--content");
      if (content === undefined) throw new Error("file-write requires --content TEXT.");
      const createOnly = args.includes("--create-only");
      const expectedSha256 = sha256Option(args, "--expected-sha256");
      const expectedProjectFingerprint = sha256Option(args, "--expected-project-fingerprint");
      print(await writeProjectFile({
        projectPath: values[0],
        path: values[1],
        content,
        ...(createOnly ? { guard: { mode: "create" as const } } : {}),
        ...(expectedSha256 === undefined ? {} : { expectedSha256 }),
        ...(expectedProjectFingerprint === undefined ? {} : { expectedProjectFingerprint }),
      }));
      return;
    }
    case "file-replace": {
      if (!values[0] || !values[1]) throw new Error("file-replace requires PROJECT_PATH and RES_PATH.");
      const expectedProjectFingerprint = sha256Option(args, "--project-fingerprint");
      const oldText = option(args, "--old");
      const newText = option(args, "--new");
      if (expectedProjectFingerprint === undefined || oldText === undefined || newText === undefined) {
        throw new Error("file-replace requires --project-fingerprint HASH, --old TEXT, and --new TEXT.");
      }
      if (oldText.length === 0) throw new Error("file-replace --old must not be empty.");
      const replaceAll = parseBoolean(option(args, "--replace-all"), "--replace-all");
      print(await replaceProjectText({
        projectPath: values[0],
        path: values[1],
        expectedProjectFingerprint,
        oldText,
        newText,
        ...(replaceAll === undefined ? {} : { replaceAll }),
      }));
      return;
    }
    case "check":
      if (!values[0]) throw new Error("check requires PROJECT_PATH.");
      print(
        await checkProject({
          projectPath: values[0],
          ...(configPath === undefined ? {} : { configPath }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      );
      return;
    case "script-check": {
      if (!values[0] || !values[1]) {
        throw new Error("script-check requires PROJECT_PATH and RES_PATH.");
      }
      const maxOutput = option(args, "--max-output");
      print(
        await checkScript({
          projectPath: values[0],
          path: values[1],
          ...(configPath === undefined ? {} : { configPath }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          ...(maxOutput === undefined
            ? {}
            : {
                maxOutputBytes: parseInteger(maxOutput, "--max-output", {
                  min: 1_024,
                  max: 1_048_576,
                }),
              }),
        }),
      );
      return;
    }
    case "run":
      if (!values[0]) throw new Error("run requires PROJECT_PATH.");
      print(
        await runProject({
          projectPath: values[0],
          ...(configPath === undefined ? {} : { configPath }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          ...(scene === undefined ? {} : { scene }),
        }),
      );
      return;
    case "launch":
      if (!values[0]) throw new Error("launch requires PROJECT_PATH.");
      print(
        await launchProject({
          projectPath: values[0],
          ...(configPath === undefined ? {} : { configPath }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          ...(scene === undefined ? {} : { scene }),
        }),
      );
      return;
    case "status":
      if (!values[0] || !values[1]) {
        throw new Error("status requires PROJECT_PATH and RUN_ID.");
      }
      print(
        await getManagedRunStatus({
          projectPath: values[0],
          runId: values[1],
          ...(option(args, "--max-output") === undefined
            ? {}
            : {
                maxOutputBytes: parseInteger(option(args, "--max-output") ?? "", "--max-output", { min: 1_024, max: 1_048_576 }),
              }),
        }),
      );
      return;
    case "log-read": {
      assertCommandShape(args, "log-read", 2, new Set([
        "--cursor",
        "--stream",
        "--minimum-severity",
        "--contains",
        "--max-lines",
        "--deduplicate",
        "--raw",
      ]));
      if (!values[0] || !values[1]) throw new Error("log-read requires PROJECT_PATH and RUN_ID.");
      const cursor = parseLogCursor(option(args, "--cursor"));
      const stream = option(args, "--stream");
      if (stream !== undefined && stream !== "stdout" && stream !== "stderr" && stream !== "combined") {
        throw new Error("--stream must be stdout, stderr, or combined.");
      }
      const minimumSeverity = option(args, "--minimum-severity");
      if (minimumSeverity !== undefined && minimumSeverity !== "error" && minimumSeverity !== "warning" && minimumSeverity !== "info") {
        throw new Error("--minimum-severity must be error, warning, or info.");
      }
      const contains = option(args, "--contains");
      if (contains !== undefined && (contains.length === 0 || contains.length > 1024)) {
        throw new Error("--contains must contain 1 through 1024 characters.");
      }
      const maxLines = option(args, "--max-lines");
      const deduplicate = parseBoolean(option(args, "--deduplicate"), "--deduplicate");
      const raw = parseBoolean(option(args, "--raw"), "--raw");
      print(await readManagedLogs({
        projectPath: values[0],
        runId: values[1],
        ...(cursor === undefined ? {} : { cursor }),
        ...(stream === undefined ? {} : { stream }),
        ...(minimumSeverity === undefined ? {} : { minimumSeverity }),
        ...(contains === undefined ? {} : { contains }),
        ...(maxLines === undefined ? {} : { maxLines: parseInteger(maxLines, "--max-lines", { min: 1, max: 500 }) }),
        ...(deduplicate === undefined ? {} : { deduplicate }),
        ...(raw === undefined ? {} : { raw }),
      }));
      return;
    }
    case "diagnostics": {
      assertCommandShape(args, "diagnostics", 2, new Set(["--cursor", "--max-issues"]));
      if (!values[0] || !values[1]) throw new Error("diagnostics requires PROJECT_PATH and RUN_ID.");
      const cursor = parseLogCursor(option(args, "--cursor"));
      const maxIssues = option(args, "--max-issues");
      print(await getDiagnosticsSummary({
        projectPath: values[0],
        runId: values[1],
        ...(cursor === undefined ? {} : { cursor }),
        ...(maxIssues === undefined ? {} : { maxIssues: parseInteger(maxIssues, "--max-issues", { min: 1, max: 50 }) }),
      }));
      return;
    }
    case "debug-report": {
      assertCommandShape(args, "debug-report", 1, new Set([
        "--project-fingerprint",
        "--issue",
        "--run-id",
        "--reproduction",
        "--cursor",
        "--format",
      ]));
      if (!values[0]) throw new Error("debug-report requires PROJECT_PATH.");
      const expectedProjectFingerprint = sha256Option(args, "--project-fingerprint");
      const issue = option(args, "--issue");
      if (expectedProjectFingerprint === undefined || issue === undefined || issue.length === 0) {
        throw new Error("debug-report requires --project-fingerprint HASH and --issue TEXT.");
      }
      if (issue.length > 16_384) throw new Error("--issue must not exceed 16384 characters.");
      const runId = option(args, "--run-id");
      const reproduction = option(args, "--reproduction");
      if (reproduction !== undefined && (reproduction.length === 0 || reproduction.length > 32_768)) {
        throw new Error("--reproduction must contain 1 through 32768 characters.");
      }
      const cursor = parseLogCursor(option(args, "--cursor"));
      const format = option(args, "--format");
      if (format !== undefined && format !== "markdown" && format !== "json") {
        throw new Error("--format must be markdown or json.");
      }
      print(await createDebugReport({
        projectPath: values[0],
        expectedProjectFingerprint,
        issue,
        ...(runId === undefined ? {} : { runId }),
        ...(reproduction === undefined ? {} : { reproduction }),
        ...(cursor === undefined ? {} : { cursor }),
        ...(format === undefined ? {} : { format }),
      }));
      return;
    }
    case "stop":
      if (!values[0] || !values[1]) {
        throw new Error("stop requires PROJECT_PATH and RUN_ID.");
      }
      print(
        await stopManagedRun({
          projectPath: values[0],
          runId: values[1],
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          ...(option(args, "--max-output") === undefined
            ? {}
            : {
                maxOutputBytes: parseInteger(option(args, "--max-output") ?? "", "--max-output", { min: 1_024, max: 1_048_576 }),
              }),
        }),
      );
      return;
    case "configure": {
      const target = values[0];
      if (target !== "codex" && target !== "deepseek-harness" && target !== "claude-code") {
        throw new Error("configure requires codex, deepseek-harness, or claude-code.");
      }
      const projectPath = option(args, "--project");
      const serverPath = option(args, "--server");
      print(
        await configureClient({
          target,
          ...(projectPath === undefined ? {} : { projectPath }),
          ...(serverPath === undefined ? {} : { serverPath }),
        }),
      );
      return;
    }
    case "addon-install":
      if (!values[0]) throw new Error("addon-install requires PROJECT_PATH.");
      print(await installGodotAddon(values[0]));
      return;
    case "editor-launch":
      if (!values[0]) throw new Error("editor-launch requires PROJECT_PATH.");
      print(
        await launchEditor({
          projectPath: values[0],
          ...(configPath === undefined ? {} : { configPath }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      );
      return;
    case "editor-status":
      if (!values[0] || !values[1]) throw new Error("editor-status requires PROJECT_PATH and RUN_ID.");
      print(await getEditorInfo({ projectPath: values[0], runId: values[1] }));
      return;
    case "editor-project-setting-get": {
      if (!values[0] || !values[1]) throw new Error("editor-project-setting-get requires PROJECT_PATH and RUN_ID.");
      const key = option(args, "--key");
      if (key === undefined) throw new Error("editor-project-setting-get requires --key NAME.");
      print(await getEditorProjectSetting({
        projectPath: values[0],
        runId: values[1],
        key,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      }));
      return;
    }
    case "editor-project-setting-set": {
      if (!values[0] || !values[1]) throw new Error("editor-project-setting-set requires PROJECT_PATH and RUN_ID.");
      const expectedProjectFingerprint = sha256Option(args, "--project-fingerprint");
      const expectedProjectFileSha256 = sha256Option(args, "--project-sha256");
      const key = option(args, "--key");
      const source = option(args, "--value");
      if (expectedProjectFingerprint === undefined || expectedProjectFileSha256 === undefined || key === undefined || source === undefined) {
        throw new Error("editor-project-setting-set requires --project-fingerprint, --project-sha256, --key, and --value.");
      }
      print(await setEditorProjectSetting({
        projectPath: values[0],
        runId: values[1],
        expectedProjectFingerprint,
        expectedProjectFileSha256,
        key,
        value: JSON.parse(source) as EditorProjectSettingSetOptions["value"],
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      }));
      return;
    }
    case "editor-input-action-upsert": {
      if (!values[0] || !values[1]) throw new Error("editor-input-action-upsert requires PROJECT_PATH and RUN_ID.");
      const expectedProjectFingerprint = sha256Option(args, "--project-fingerprint");
      const expectedProjectFileSha256 = sha256Option(args, "--project-sha256");
      const name = option(args, "--name");
      const deadzoneSource = option(args, "--deadzone");
      const replaceEvents = parseBoolean(option(args, "--replace-events"), "--replace-events");
      const events = parseJsonArray(option(args, "--events"), "--events");
      if (expectedProjectFingerprint === undefined || expectedProjectFileSha256 === undefined || name === undefined || deadzoneSource === undefined || replaceEvents === undefined || events === undefined) {
        throw new Error("editor-input-action-upsert requires project guards, --name, --deadzone, --replace-events, and --events.");
      }
      print(await upsertEditorInputAction({
        projectPath: values[0],
        runId: values[1],
        expectedProjectFingerprint,
        expectedProjectFileSha256,
        name,
        deadzone: parseFiniteNumber(deadzoneSource, "--deadzone", { min: 0, max: 1 }),
        replaceEvents,
        events: events as EditorInputActionUpsertOptions["events"],
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      }));
      return;
    }
    case "editor-resource-inspect": {
      if (!values[0] || !values[1]) throw new Error("editor-resource-inspect requires PROJECT_PATH and RUN_ID.");
      const path = option(args, "--path");
      if (path === undefined) throw new Error("editor-resource-inspect requires --path RES_PATH.");
      const properties = parseJsonStringArray(option(args, "--properties"), "--properties");
      print(await inspectEditorResourcePath({
        projectPath: values[0],
        runId: values[1],
        path,
        ...(properties === undefined ? {} : { properties }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      }));
      return;
    }
    case "editor-scene-open": {
      if (!values[0] || !values[1]) throw new Error("editor-scene-open requires PROJECT_PATH and RUN_ID.");
      const expectedProjectFingerprint = sha256Option(args, "--project-fingerprint");
      const scenePath = option(args, "--scene");
      if (expectedProjectFingerprint === undefined || scenePath === undefined) {
        throw new Error("editor-scene-open requires --project-fingerprint and --scene.");
      }
      print(await openEditorScene({
        projectPath: values[0],
        runId: values[1],
        expectedProjectFingerprint,
        scenePath,
      }));
      return;
    }
    case "editor-tree":
      if (!values[0] || !values[1]) throw new Error("editor-tree requires PROJECT_PATH and RUN_ID.");
      print(await getEditorSceneTree({ projectPath: values[0], runId: values[1] }));
      return;
    case "editor-node-get": {
      if (!values[0] || !values[1]) throw new Error("editor-node-get requires PROJECT_PATH and RUN_ID.");
      const nodePath = option(args, "--node");
      if (nodePath === undefined) throw new Error("editor-node-get requires --node NODE_PATH.");
      const properties = parseJsonStringArray(option(args, "--properties"), "--properties");
      print(await getEditorNode({
        projectPath: values[0],
        runId: values[1],
        nodePath,
        ...(properties === undefined ? {} : { properties }),
      }));
      return;
    }
    case "editor-node-create": {
      if (!values[0] || !values[1]) throw new Error("editor-node-create requires PROJECT_PATH and RUN_ID.");
      const parentPath = option(args, "--parent");
      const type = option(args, "--type");
      const name = option(args, "--name");
      if (parentPath === undefined || type === undefined || name === undefined) {
        throw new Error("editor-node-create requires --parent, --type, and --name.");
      }
      const properties = parseJsonObject(option(args, "--properties"), "--properties");
      print(await createEditorNode({
        projectPath: values[0],
        runId: values[1],
        ...editorMutationGuard(args),
        parentPath,
        type,
        name,
        ...(properties === undefined ? {} : { properties }),
      }));
      return;
    }
    case "editor-scene-instantiate": {
      if (!values[0] || !values[1]) throw new Error("editor-scene-instantiate requires PROJECT_PATH and RUN_ID.");
      const parentPath = option(args, "--parent");
      const scenePath = option(args, "--scene");
      if (parentPath === undefined || scenePath === undefined) {
        throw new Error("editor-scene-instantiate requires --parent and --scene.");
      }
      const name = option(args, "--name");
      const properties = parseJsonObject(option(args, "--properties"), "--properties");
      print(await instantiateEditorScene({
        projectPath: values[0],
        runId: values[1],
        ...editorMutationGuard(args),
        parentPath,
        scenePath,
        ...(name === undefined ? {} : { name }),
        ...(properties === undefined ? {} : { properties }),
      }));
      return;
    }
    case "editor-scene-inherit": {
      if (!values[0] || !values[1]) throw new Error("editor-scene-inherit requires PROJECT_PATH and RUN_ID.");
      const sourceScenePath = option(args, "--source");
      const targetScenePath = option(args, "--target");
      if (sourceScenePath === undefined || targetScenePath === undefined) {
        throw new Error("editor-scene-inherit requires --source and --target.");
      }
      const rootName = option(args, "--root-name");
      const rootProperties = parseJsonObject(option(args, "--root-properties"), "--root-properties");
      const open = parseBoolean(option(args, "--open"), "--open");
      const overwrite = parseBoolean(option(args, "--overwrite"), "--overwrite");
      print(await createInheritedEditorScene({
        projectPath: values[0],
        runId: values[1],
        sourceScenePath,
        targetScenePath,
        ...(rootName === undefined ? {} : { rootName }),
        ...(rootProperties === undefined ? {} : { rootProperties }),
        ...(open === undefined ? {} : { open }),
        ...(overwrite === undefined ? {} : { overwrite }),
      }));
      return;
    }
    case "editor-instance-get": {
      if (!values[0] || !values[1]) throw new Error("editor-instance-get requires PROJECT_PATH and RUN_ID.");
      const nodePath = option(args, "--node");
      if (nodePath === undefined) throw new Error("editor-instance-get requires --node NODE_PATH.");
      print(await getEditorInstance({ projectPath: values[0], runId: values[1], nodePath }));
      return;
    }
    case "editor-instance-set-editable": {
      if (!values[0] || !values[1]) throw new Error("editor-instance-set-editable requires PROJECT_PATH and RUN_ID.");
      const nodePath = option(args, "--node");
      const editable = parseBoolean(option(args, "--editable"), "--editable");
      if (nodePath === undefined || editable === undefined) {
        throw new Error("editor-instance-set-editable requires --node and --editable.");
      }
      print(await setEditorInstanceEditable({
        projectPath: values[0],
        runId: values[1],
        ...editorMutationGuard(args),
        nodePath,
        editable,
      }));
      return;
    }
    case "editor-node-update": {
      if (!values[0] || !values[1]) throw new Error("editor-node-update requires PROJECT_PATH and RUN_ID.");
      const nodePath = option(args, "--node");
      const name = option(args, "--name");
      const properties = parseJsonObject(option(args, "--properties"), "--properties");
      if (nodePath === undefined || (name === undefined && properties === undefined)) {
        throw new Error("editor-node-update requires --node and at least one of --name or --properties.");
      }
      print(await updateEditorNode({
        projectPath: values[0],
        runId: values[1],
        ...editorMutationGuard(args),
        nodePath,
        ...(name === undefined ? {} : { name }),
        ...(properties === undefined ? {} : { properties }),
      }));
      return;
    }
    case "editor-node-delete": {
      if (!values[0] || !values[1]) throw new Error("editor-node-delete requires PROJECT_PATH and RUN_ID.");
      const nodePath = option(args, "--node");
      if (nodePath === undefined) throw new Error("editor-node-delete requires --node NODE_PATH.");
      print(await deleteEditorNode({
        projectPath: values[0],
        runId: values[1],
        ...editorMutationGuard(args),
        nodePath,
      }));
      return;
    }
    case "editor-node-move": {
      if (!values[0] || !values[1]) throw new Error("editor-node-move requires PROJECT_PATH and RUN_ID.");
      const nodePath = option(args, "--node");
      const newParentPath = option(args, "--parent");
      if (nodePath === undefined || newParentPath === undefined) {
        throw new Error("editor-node-move requires --node and --parent.");
      }
      const indexSource = option(args, "--index");
      const keepGlobalTransform = parseBoolean(option(args, "--keep-global-transform"), "--keep-global-transform");
      print(await moveEditorNode({
        projectPath: values[0],
        runId: values[1],
        ...editorMutationGuard(args),
        nodePath,
        newParentPath,
        ...(indexSource === undefined ? {} : { index: parseInteger(indexSource, "--index", { min: -1 }) }),
        ...(keepGlobalTransform === undefined ? {} : { keepGlobalTransform }),
      }));
      return;
    }
    case "editor-resource-create": {
      if (!values[0] || !values[1]) throw new Error("editor-resource-create requires PROJECT_PATH and RUN_ID.");
      const nodePath = option(args, "--node");
      const property = option(args, "--property");
      const type = option(args, "--type");
      if (nodePath === undefined || property === undefined || type === undefined) {
        throw new Error("editor-resource-create requires --node, --property, and --type.");
      }
      const properties = parseJsonObject(option(args, "--properties"), "--properties");
      print(await createEditorResource({
        projectPath: values[0],
        runId: values[1],
        ...editorMutationGuard(args),
        nodePath,
        property,
        type,
        ...(properties === undefined ? {} : { properties }),
      }));
      return;
    }
    case "editor-resource-get": {
      if (!values[0] || !values[1]) throw new Error("editor-resource-get requires PROJECT_PATH and RUN_ID.");
      const nodePath = option(args, "--node");
      const property = option(args, "--property");
      if (nodePath === undefined || property === undefined) {
        throw new Error("editor-resource-get requires --node and --property.");
      }
      const properties = parseJsonStringArray(option(args, "--properties"), "--properties");
      print(await getEditorResource({
        projectPath: values[0], runId: values[1], nodePath, property,
        ...(properties === undefined ? {} : { properties }),
      }));
      return;
    }
    case "editor-resource-update": {
      if (!values[0] || !values[1]) throw new Error("editor-resource-update requires PROJECT_PATH and RUN_ID.");
      const nodePath = option(args, "--node");
      const property = option(args, "--property");
      const properties = parseJsonObject(option(args, "--properties"), "--properties");
      if (nodePath === undefined || property === undefined || properties === undefined) {
        throw new Error("editor-resource-update requires --node, --property, and --properties.");
      }
      print(await updateEditorResource({
        projectPath: values[0],
        runId: values[1],
        ...editorMutationGuard(args),
        nodePath,
        property,
        properties,
      }));
      return;
    }
    case "editor-resource-save": {
      if (!values[0] || !values[1]) throw new Error("editor-resource-save requires PROJECT_PATH and RUN_ID.");
      const nodePath = option(args, "--node");
      const property = option(args, "--property");
      const path = option(args, "--path");
      if (nodePath === undefined || property === undefined || path === undefined) {
        throw new Error("editor-resource-save requires --node, --property, and --path.");
      }
      const overwrite = parseBoolean(option(args, "--overwrite"), "--overwrite");
      print(await saveEditorResource({
        projectPath: values[0],
        runId: values[1],
        ...editorMutationGuard(args),
        nodePath,
        property,
        path,
        ...(overwrite === undefined ? {} : { overwrite }),
      }));
      return;
    }
    case "editor-resource-focus": {
      if (!values[0] || !values[1]) throw new Error("editor-resource-focus requires PROJECT_PATH and RUN_ID.");
      const path = option(args, "--path");
      if (path === undefined) throw new Error("editor-resource-focus requires --path RES_PATH.");
      print(await focusEditorResource({ projectPath: values[0], runId: values[1], path }));
      return;
    }
    case "editor-selection-get":
      if (!values[0] || !values[1]) throw new Error("editor-selection-get requires PROJECT_PATH and RUN_ID.");
      print(await getEditorSelection({ projectPath: values[0], runId: values[1] }));
      return;
    case "editor-selection-set": {
      if (!values[0] || !values[1]) throw new Error("editor-selection-set requires PROJECT_PATH and RUN_ID.");
      const paths = parseJsonStringArray(option(args, "--paths"), "--paths");
      if (paths === undefined) throw new Error("editor-selection-set requires --paths JSON_ARRAY.");
      const focus = parseBoolean(option(args, "--focus"), "--focus");
      print(await setEditorSelection({
        projectPath: values[0],
        runId: values[1],
        paths,
        ...(focus === undefined ? {} : { focus }),
      }));
      return;
    }
    case "editor-batch": {
      if (!values[0] || !values[1]) throw new Error("editor-batch requires PROJECT_PATH and RUN_ID.");
      const expectedProjectFingerprint = sha256Option(args, "--project-fingerprint");
      const expectedScenePath = option(args, "--scene");
      const operations = parseJsonArray(option(args, "--operations"), "--operations");
      const confirmDestructive = parseBoolean(option(args, "--confirm-destructive"), "--confirm-destructive");
      if (expectedProjectFingerprint === undefined || expectedScenePath === undefined || operations === undefined || confirmDestructive === undefined) {
        throw new RuntimeFailure({
          code: "EDITOR_BATCH_INPUT_INVALID",
          stage: "validation",
          message: "editor-batch requires --project-fingerprint, --scene, --operations, and --confirm-destructive.",
          recovery: ["Pass the current project identity, active .tscn path, a typed operation array, and an explicit destructive confirmation."],
        });
      }
      const actionName = option(args, "--action-name");
      print(await batchEditorScene({
        projectPath: values[0],
        runId: values[1],
        expectedProjectFingerprint,
        expectedScenePath,
        operations: operations as EditorBatchOptions["operations"],
        confirmDestructive,
        ...(actionName === undefined ? {} : { actionName }),
      }));
      return;
    }
    case "editor-signal-connect": {
      if (!values[0] || !values[1]) throw new Error("editor-signal-connect requires PROJECT_PATH and RUN_ID.");
      const sourcePath = option(args, "--source");
      const signal = option(args, "--signal");
      const targetPath = option(args, "--target");
      const method = option(args, "--method");
      if (sourcePath === undefined || signal === undefined || targetPath === undefined || method === undefined) {
        throw new Error("editor-signal-connect requires --source, --signal, --target, and --method.");
      }
      const flagsSource = option(args, "--flags");
      print(await connectEditorSignal({
        projectPath: values[0],
        runId: values[1],
        ...editorMutationGuard(args),
        sourcePath,
        signal,
        targetPath,
        method,
        ...(flagsSource === undefined ? {} : { flags: parseInteger(flagsSource, "--flags", { min: 0, max: 15 }) }),
      }));
      return;
    }
    case "editor-save":
      if (!values[0] || !values[1]) throw new Error("editor-save requires PROJECT_PATH and RUN_ID.");
      print(await saveEditorScene({
        projectPath: values[0],
        runId: values[1],
        ...editorHistoryGuard(args),
      }));
      return;
    case "editor-undo":
      if (!values[0] || !values[1]) throw new Error("editor-undo requires PROJECT_PATH and RUN_ID.");
      print(await undoEditorAction({
        projectPath: values[0],
        runId: values[1],
        ...editorHistoryGuard(args),
      }));
      return;
    case "editor-redo":
      if (!values[0] || !values[1]) throw new Error("editor-redo requires PROJECT_PATH and RUN_ID.");
      print(await redoEditorAction({
        projectPath: values[0],
        runId: values[1],
        ...editorHistoryGuard(args),
      }));
      return;
    case "editor-screenshot": {
      if (!values[0] || !values[1]) throw new Error("editor-screenshot requires PROJECT_PATH and RUN_ID.");
      const viewport = option(args, "--viewport");
      const expectedScenePath = option(args, "--expected-scene");
      if (viewport !== undefined && viewport !== "2d" && viewport !== "3d") {
        throw new Error("--viewport must be 2d or 3d.");
      }
      const indexSource = option(args, "--viewport-index");
      print(await captureEditorScreenshot({
        projectPath: values[0],
        runId: values[1],
        ...(expectedScenePath === undefined ? {} : { expectedScenePath }),
        ...(viewport === undefined ? {} : { viewport }),
        ...(indexSource === undefined ? {} : { viewportIndex: parseInteger(indexSource, "--viewport-index", { min: 0, max: 3 }) }),
      }));
      return;
    }
    case "runtime-ui": {
      if (!values[0] || !values[1]) throw new Error("runtime-ui requires PROJECT_PATH and RUN_ID.");
      const text = option(args, "--text");
      const type = option(args, "--type");
      const path = option(args, "--path");
      print(
        await findRuntimeUi({
          projectPath: values[0],
          runId: values[1],
          selector: {
            ...(text === undefined ? {} : { text }),
            ...(type === undefined ? {} : { type }),
            ...(path === undefined ? {} : { path }),
          },
        }),
      );
      return;
    }
    case "runtime-tree": {
      if (!values[0] || !values[1]) throw new Error("runtime-tree requires PROJECT_PATH and RUN_ID.");
      const maxDepth = option(args, "--max-depth");
      const maxNodes = option(args, "--max-nodes");
      print(await getRuntimeSceneTree({
        projectPath: values[0], runId: values[1],
        ...(maxDepth === undefined ? {} : { maxDepth: parseInteger(maxDepth, "--max-depth", { min: 0, max: 64 }) }),
        ...(maxNodes === undefined ? {} : { maxNodes: parseInteger(maxNodes, "--max-nodes", { min: 1, max: 5_000 }) }),
      }));
      return;
    }
    case "runtime-node-get": {
      if (!values[0] || !values[1]) throw new Error("runtime-node-get requires PROJECT_PATH and RUN_ID.");
      const nodePath = option(args, "--node");
      if (nodePath === undefined) throw new Error("runtime-node-get requires --node NODE_PATH.");
      const properties = parseJsonStringArray(option(args, "--properties"), "--properties");
      print(await getRuntimeNode({
        projectPath: values[0], runId: values[1], nodePath,
        ...(properties === undefined ? {} : { properties }),
      }));
      return;
    }
    case "runtime-observe": {
      if (!values[0] || !values[1]) throw new Error("runtime-observe requires PROJECT_PATH and RUN_ID.");
      const nodePaths = parseJsonStringArray(option(args, "--nodes"), "--nodes");
      if (nodePaths === undefined || nodePaths.length === 0) {
        throw new Error("runtime-observe requires --nodes JSON_ARRAY.");
      }
      const properties = parseJsonStringArray(option(args, "--properties"), "--properties");
      print(await observeRuntime({
        projectPath: values[0],
        runId: values[1],
        nodePaths,
        ...(properties === undefined ? {} : { properties }),
      }));
      return;
    }
    case "runtime-simulate": {
      if (!values[0] || !values[1]) throw new Error("runtime-simulate requires PROJECT_PATH and RUN_ID.");
      const nodePath = option(args, "--node");
      if (nodePath === undefined) throw new Error("runtime-simulate requires --node NODE_PATH.");
      const framesSource = option(args, "--frames");
      const properties = parseJsonStringArray(option(args, "--properties"), "--properties");
      const action = option(args, "--action");
      const strengthSource = option(args, "--strength");
      print(await simulateRuntimePhysics({
        projectPath: values[0],
        runId: values[1],
        nodePath,
        ...(framesSource === undefined ? {} : { frames: parseInteger(framesSource, "--frames", { min: 1, max: 120 }) }),
        ...(properties === undefined ? {} : { properties }),
        ...(action === undefined ? {} : { action }),
        ...(strengthSource === undefined ? {} : { strength: parseFiniteNumber(strengthSource, "--strength", { min: 0, max: 1 }) }),
      }));
      return;
    }
    case "runtime-3d-project": {
      if (!values[0] || !values[1]) throw new Error("runtime-3d-project requires PROJECT_PATH and RUN_ID.");
      const nodePath = option(args, "--node");
      const rawWorldPosition = parseJsonObject(option(args, "--position"), "--position");
      const worldPosition = rawWorldPosition === undefined
        ? undefined
        : parseFiniteVector3(rawWorldPosition, "--position");
      if ((nodePath === undefined) === (worldPosition === undefined)) {
        throw new Error("runtime-3d-project requires exactly one of --node or --position.");
      }
      const cameraPath = option(args, "--camera");
      print(await projectRuntime3D({
        projectPath: values[0],
        runId: values[1],
        ...(nodePath === undefined ? {} : { nodePath }),
        ...(worldPosition === undefined ? {} : { worldPosition }),
        ...(cameraPath === undefined ? {} : { cameraPath }),
      }));
      return;
    }
    case "runtime-3d-raycast": {
      if (!values[0] || !values[1]) throw new Error("runtime-3d-raycast requires PROJECT_PATH and RUN_ID.");
      const xSource = option(args, "--x");
      const ySource = option(args, "--y");
      if (xSource === undefined || ySource === undefined) throw new Error("runtime-3d-raycast requires --x and --y.");
      const cameraPath = option(args, "--camera");
      const distanceSource = option(args, "--max-distance");
      const maskSource = option(args, "--collision-mask");
      print(await raycastRuntime3D({
        projectPath: values[0],
        runId: values[1],
        screenPosition: {
          x: parseFiniteNumber(xSource, "--x"),
          y: parseFiniteNumber(ySource, "--y"),
        },
        ...(cameraPath === undefined ? {} : { cameraPath }),
        ...(distanceSource === undefined ? {} : { maxDistance: parseFiniteNumber(distanceSource, "--max-distance", { min: Number.MIN_VALUE, max: 100_000 }) }),
        ...(maskSource === undefined ? {} : { collisionMask: parseInteger(maskSource, "--collision-mask", { min: 0, max: 4_294_967_295 }) }),
      }));
      return;
    }
    case "screenshot": {
      if (!values[0] || !values[1]) throw new Error("screenshot requires PROJECT_PATH and RUN_ID.");
      const expectedScenePath = option(args, "--expected-scene");
      print(await captureRuntimeScreenshot({
        projectPath: values[0],
        runId: values[1],
        ...(expectedScenePath === undefined ? {} : { expectedScenePath }),
      }));
      return;
    }
    case "click": {
      if (!values[0] || !values[1]) throw new Error("click requires PROJECT_PATH and RUN_ID.");
      const path = option(args, "--path");
      if (path === undefined) throw new Error("click requires --path NODE_PATH.");
      print(await injectRuntimeInput({ projectPath: values[0], runId: values[1], kind: "click", path }));
      return;
    }
    case "input-sequence": {
      if (!values[0] || !values[1]) throw new Error("input-sequence requires PROJECT_PATH and RUN_ID.");
      const steps = parseJsonArray(option(args, "--steps"), "--steps");
      if (steps === undefined) throw new Error("input-sequence requires --steps JSON_ARRAY.");
      print(await injectRuntimeInputSequence({
        projectPath: values[0],
        runId: values[1],
        steps: steps as RuntimeInputStep[],
      }));
      return;
    }
    case "assert-property": {
      if (!values[0] || !values[1]) throw new Error("assert-property requires PROJECT_PATH and RUN_ID.");
      const nodePath = option(args, "--node");
      const property = option(args, "--property");
      const expectedSource = option(args, "--expected");
      if (nodePath === undefined || property === undefined || expectedSource === undefined) {
        throw new Error("assert-property requires --node, --property, and --expected JSON.");
      }
      print(
        await assertRuntime({
          projectPath: values[0],
          runId: values[1],
          kind: "property",
          nodePath,
          property,
          expected: JSON.parse(expectedSource),
        }),
      );
      return;
    }
    case "wait-property": {
      if (!values[0] || !values[1]) throw new Error("wait-property requires PROJECT_PATH and RUN_ID.");
      const nodePath = option(args, "--node");
      const property = option(args, "--property");
      const expectedSource = option(args, "--expected");
      if (nodePath === undefined || property === undefined || expectedSource === undefined) {
        throw new Error("wait-property requires --node, --property, and --expected JSON.");
      }
      const operator = option(args, "--operator") as
        | "equals" | "not_equals" | "gt" | "gte" | "lt" | "lte" | "contains" | undefined;
      const waitTimeoutSource = option(args, "--wait-timeout");
      const pollFramesSource = option(args, "--poll-frames");
      print(await waitForRuntime({
        projectPath: values[0],
        runId: values[1],
        kind: "property",
        nodePath,
        property,
        expected: JSON.parse(expectedSource),
        ...(operator === undefined ? {} : { operator }),
        ...(waitTimeoutSource === undefined ? {} : { waitTimeoutMs: parseInteger(waitTimeoutSource, "--wait-timeout", { min: 0, max: 30_000 }) }),
        ...(pollFramesSource === undefined ? {} : { pollEveryFrames: parseInteger(pollFramesSource, "--poll-frames", { min: 1, max: 60 }) }),
      }));
      return;
    }
    case "runtime-control": {
      if (!values[0] || !values[1] || !values[2]) {
        throw new Error("runtime-control requires PROJECT_PATH, RUN_ID, and pause, resume, step, or step_physics.");
      }
      const action = values[2];
      if (action !== "pause" && action !== "resume" && action !== "step" && action !== "step_physics") {
        throw new Error("runtime-control action must be pause, resume, step, or step_physics.");
      }
      if (action === "step" || action === "step_physics") {
        const framesSource = option(args, "--frames");
        print(await controlRuntime({
          projectPath: values[0],
          runId: values[1],
          action,
          ...(framesSource === undefined ? {} : { frames: parseInteger(framesSource, "--frames", { min: 1, max: 120 }) }),
        }));
      } else {
        print(await controlRuntime({ projectPath: values[0], runId: values[1], action }));
      }
      return;
    }
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

try {
  await main();
} catch (error) {
  print({ ok: false, error: toRuntimeError(error) });
  process.exitCode = 1;
}
