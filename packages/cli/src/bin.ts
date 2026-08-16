#!/usr/bin/env node

import {
  checkProject,
  configureClient,
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
  getEditorNode,
  getEditorResource,
  getEditorSceneTree,
  getEditorSelection,
  getManagedRunStatus,
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
  redoEditorAction,
  runDoctor,
  runProject,
  stopManagedRun,
  saveEditorScene,
  saveEditorResource,
  setEditorSelection,
  setEditorInstanceEditable,
  toRuntimeError,
  undoEditorAction,
  updateEditorNode,
  updateEditorResource,
  waitForRuntime,
  type RuntimeInputStep,
} from "@godot-agent-runtime/core";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function positional(args: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index]?.startsWith("--")) {
      index += 1;
      continue;
    }
    values.push(args[index] ?? "");
  }
  return values;
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

function printHelp(): void {
  process.stdout.write(`godot-agent-runtime commands:\n\n`);
  process.stdout.write(`  doctor [--config PATH]\n`);
  process.stdout.write(`  find [SEARCH_ROOT] [--max-depth N] [--limit N]\n`);
  process.stdout.write(`  inspect PROJECT_PATH\n`);
  process.stdout.write(`  check PROJECT_PATH [--config PATH] [--timeout MS]\n`);
  process.stdout.write(`  run PROJECT_PATH [--scene RES_PATH] [--config PATH] [--timeout MS]  # headless\n`);
  process.stdout.write(`  launch PROJECT_PATH [--scene RES_PATH] [--config PATH] [--timeout MS]\n`);
  process.stdout.write(`  status PROJECT_PATH RUN_ID [--max-output BYTES]\n`);
  process.stdout.write(`  stop PROJECT_PATH RUN_ID [--timeout MS] [--max-output BYTES]\n`);
  process.stdout.write(`  configure <codex|claude-code> [--project PATH] [--server PATH]\n`);
  process.stdout.write(`  addon-install PROJECT_PATH\n`);
  process.stdout.write(`  editor-launch PROJECT_PATH [--config PATH] [--timeout MS]\n`);
  process.stdout.write(`  editor-tree PROJECT_PATH RUN_ID\n`);
  process.stdout.write(`  editor-node-get PROJECT_PATH RUN_ID --node NODE_PATH [--properties JSON_ARRAY]\n`);
  process.stdout.write(`  editor-node-create PROJECT_PATH RUN_ID --parent NODE_PATH --type TYPE --name NAME [--properties JSON_OBJECT]\n`);
  process.stdout.write(`  editor-scene-instantiate PROJECT_PATH RUN_ID --parent NODE_PATH --scene RES_PATH [--name NAME] [--properties JSON_OBJECT]\n`);
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
  process.stdout.write(`  editor-signal-connect PROJECT_PATH RUN_ID --source NODE_PATH --signal NAME --target NODE_PATH --method NAME [--flags N]\n`);
  process.stdout.write(`  editor-save PROJECT_PATH RUN_ID\n`);
  process.stdout.write(`  editor-undo PROJECT_PATH RUN_ID\n`);
  process.stdout.write(`  editor-redo PROJECT_PATH RUN_ID\n`);
  process.stdout.write(`  runtime-ui PROJECT_PATH RUN_ID [--text TEXT] [--type TYPE] [--path NODE_PATH]\n`);
  process.stdout.write(`  runtime-tree PROJECT_PATH RUN_ID [--max-depth N] [--max-nodes N]\n`);
  process.stdout.write(`  runtime-node-get PROJECT_PATH RUN_ID --node NODE_PATH [--properties JSON_ARRAY]\n`);
  process.stdout.write(`  screenshot PROJECT_PATH RUN_ID\n`);
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
  const timeoutMs = timeout ? Number.parseInt(timeout, 10) : undefined;
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
                maxDepth: Number.parseInt(option(args, "--max-depth") ?? "", 10),
              }),
          ...(option(args, "--limit") === undefined
            ? {}
            : { maxProjects: Number.parseInt(option(args, "--limit") ?? "", 10) }),
        }),
      );
      return;
    case "inspect":
      if (!values[0]) throw new Error("inspect requires PROJECT_PATH.");
      print(await inspectProject(values[0]));
      return;
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
                maxOutputBytes: Number.parseInt(
                  option(args, "--max-output") ?? "",
                  10,
                ),
              }),
        }),
      );
      return;
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
                maxOutputBytes: Number.parseInt(
                  option(args, "--max-output") ?? "",
                  10,
                ),
              }),
        }),
      );
      return;
    case "configure": {
      const target = values[0];
      if (target !== "codex" && target !== "claude-code") {
        throw new Error("configure requires codex or claude-code.");
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
        parentPath,
        scenePath,
        ...(name === undefined ? {} : { name }),
        ...(properties === undefined ? {} : { properties }),
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
      print(await setEditorInstanceEditable({ projectPath: values[0], runId: values[1], nodePath, editable }));
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
      print(await deleteEditorNode({ projectPath: values[0], runId: values[1], nodePath }));
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
        nodePath,
        newParentPath,
        ...(indexSource === undefined ? {} : { index: Number.parseInt(indexSource, 10) }),
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
      print(await updateEditorResource({ projectPath: values[0], runId: values[1], nodePath, property, properties }));
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
        sourcePath,
        signal,
        targetPath,
        method,
        ...(flagsSource === undefined ? {} : { flags: Number.parseInt(flagsSource, 10) }),
      }));
      return;
    }
    case "editor-save":
      if (!values[0] || !values[1]) throw new Error("editor-save requires PROJECT_PATH and RUN_ID.");
      print(await saveEditorScene({ projectPath: values[0], runId: values[1] }));
      return;
    case "editor-undo":
      if (!values[0] || !values[1]) throw new Error("editor-undo requires PROJECT_PATH and RUN_ID.");
      print(await undoEditorAction({ projectPath: values[0], runId: values[1] }));
      return;
    case "editor-redo":
      if (!values[0] || !values[1]) throw new Error("editor-redo requires PROJECT_PATH and RUN_ID.");
      print(await redoEditorAction({ projectPath: values[0], runId: values[1] }));
      return;
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
        ...(maxDepth === undefined ? {} : { maxDepth: Number.parseInt(maxDepth, 10) }),
        ...(maxNodes === undefined ? {} : { maxNodes: Number.parseInt(maxNodes, 10) }),
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
    case "screenshot":
      if (!values[0] || !values[1]) throw new Error("screenshot requires PROJECT_PATH and RUN_ID.");
      print(await captureRuntimeScreenshot({ projectPath: values[0], runId: values[1] }));
      return;
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
        ...(waitTimeoutSource === undefined ? {} : { waitTimeoutMs: Number.parseInt(waitTimeoutSource, 10) }),
        ...(pollFramesSource === undefined ? {} : { pollEveryFrames: Number.parseInt(pollFramesSource, 10) }),
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
          ...(framesSource === undefined ? {} : { frames: Number.parseInt(framesSource, 10) }),
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
