import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { installGodotAddon } from "../../packages/core/src/addon.js";
import { inspectProject } from "../../packages/core/src/project.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => await rm(path, { recursive: true })));
});

describe("Godot addon installer", () => {
  it("preserves enabled plugins and installs idempotently", async () => {
    const projectPath = await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-addon-"));
    temporaryDirectories.push(projectPath);
    await writeFile(
      resolve(projectPath, "project.godot"),
      [
        "config_version=5",
        "",
        "[application]",
        'config/name="Addon Fixture"',
        "",
        "[editor_plugins]",
        "",
        'enabled=PackedStringArray("existing_plugin")',
        "",
      ].join("\n"),
      "utf8",
    );

    const first = await installGodotAddon(projectPath);
    const second = await installGodotAddon(projectPath);
    const project = await inspectProject(projectPath);
    const configuration = await readFile(resolve(projectPath, "project.godot"), "utf8");
    const editorBridge = await readFile(
      resolve(projectPath, "addons", "godot_agent_runtime", "editor_bridge.gd"),
      "utf8",
    );
    const runtimeBridge = await readFile(
      resolve(projectPath, "addons", "godot_agent_runtime", "runtime_entry.gd"),
      "utf8",
    );

    expect(first.files).toHaveLength(4);
    expect(first.projectConfigurationChanged).toBe(true);
    expect(second.projectConfigurationChanged).toBe(false);
    expect(project.enabledPlugins).toEqual(["existing_plugin", "godot_agent_runtime"]);
    expect(configuration.match(/godot_agent_runtime/g)).toHaveLength(1);
    expect(editorBridge).toContain('const PROTOCOL_VERSION := "0.7.0"');
    expect(editorBridge).toContain('"screenshot_receipt"');
    expect(editorBridge).toContain('"scene_open"');
    expect(editorBridge).toContain('"scene_batch"');
    expect(editorBridge).toContain('"project_settings"');
    expect(editorBridge).toContain('"input_map"');
    expect(editorBridge).toContain('"resource_inspect"');
    expect(editorBridge).toContain('"project_setting_operation_status"');
    const lockFree = quotedStrings(sliceConst(editorBridge, "LOCK_FREE_EDITOR_COMMANDS"));
    const dispatched = matchCommandLiterals(sliceFunction(editorBridge, "_handle"));
    expect(lockFree).toEqual(["hello", "project_setting_operation_status"]);
    expect(dispatched).toEqual([
      "hello",
      "project_setting_get",
      "project_setting_set",
      "project_setting_operation_status",
      "input_action_upsert",
      "resource_inspect",
      "scene_open",
      "scene_tree",
      "selection",
      "selection_set",
      "screenshot",
      "node_get",
      "scene_batch",
      "node_create",
      "scene_instantiate",
      "scene_create_inherited",
      "node_update",
      "node_delete",
      "node_move",
      "resource_create",
      "resource_get",
      "resource_update",
      "resource_save",
      "resource_focus",
      "instance_get",
      "instance_set_editable",
      "signal_connect",
      "scene_save",
      "history_undo",
      "history_redo",
    ]);
    const locked = dispatched.filter((command) => !lockFree.includes(command));
    for (const command of lockFree) {
      expect(locked).not.toContain(command);
    }
    expect(sliceFunction(editorBridge, "_command_requires_exclusive_lock"))
      .toContain("LOCK_FREE_EDITOR_COMMANDS.has");
    const cameraUnavailableStart = editorBridge.indexOf("if camera == null:");
    const cameraUnavailableEnd = editorBridge.indexOf("var projection_name :=", cameraUnavailableStart);
    expect(cameraUnavailableStart).toBeGreaterThan(-1);
    expect(cameraUnavailableEnd).toBeGreaterThan(cameraUnavailableStart);
    expect(editorBridge.slice(cameraUnavailableStart, cameraUnavailableEnd))
      .toContain("DirAccess.remove_absolute(path)");
    expect(runtimeBridge).toContain('const PROTOCOL_VERSION := "0.4.0"');
    expect(runtimeBridge).toContain('"screenshot_receipt"');
  });
});

function sliceConst(source: string, name: string): string {
  const start = source.indexOf(`const ${name}`);
  const end = source.indexOf("]", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + 1);
}

function sliceFunction(source: string, name: string): string {
  const start = source.indexOf(`func ${name}(`);
  const end = source.indexOf("\nfunc ", start + 1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function quotedStrings(source: string): string[] {
  return [...source.matchAll(/"([a-z0-9_]+)"/g)].map((match) => match[1]);
}

function matchCommandLiterals(handleSource: string): string[] {
  const matchStart = handleSource.indexOf("match command:");
  const matchEnd = handleSource.indexOf("\tif exclusive:");
  expect(matchStart).toBeGreaterThan(-1);
  expect(matchEnd).toBeGreaterThan(matchStart);
  return [...handleSource.slice(matchStart, matchEnd).matchAll(/^\t\t"([a-z0-9_]+)":/gm)]
    .map((match) => match[1]);
}
