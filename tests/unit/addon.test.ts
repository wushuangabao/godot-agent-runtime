import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import * as addonModule from "../../packages/core/src/addon.js";
import { inspectProject } from "../../packages/core/src/project.js";
import { AddonInstallResultSchema } from "../../packages/protocol/src/index.js";

const { installGodotAddon } = addonModule;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => await rm(path, { recursive: true })));
});

describe("Godot addon installer", () => {
  it("versions the source addon with the public package", async () => {
    const pluginConfig = await readFile(
      resolve("addons", "godot_agent_runtime", "plugin.cfg"),
      "utf8",
    );
    expect(pluginConfig).toContain('version="0.2.0"');
  });

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
    const pluginConfig = await readFile(
      resolve(projectPath, "addons", "godot_agent_runtime", "plugin.cfg"),
      "utf8",
    );
    const pluginScript = await readFile(
      resolve(projectPath, "addons", "godot_agent_runtime", "plugin.gd"),
      "utf8",
    );
    const addonLicense = await readFile(
      resolve(projectPath, "addons", "godot_agent_runtime", "LICENSE"),
      "utf8",
    );

    expect(first.files).toEqual([
      "res://addons/godot_agent_runtime/LICENSE",
      "res://addons/godot_agent_runtime/plugin.cfg",
      "res://addons/godot_agent_runtime/plugin.gd",
      "res://addons/godot_agent_runtime/editor_bridge.gd",
      "res://addons/godot_agent_runtime/runtime_entry.gd",
    ]);
    expect(first.pluginPath).toBe("res://addons/godot_agent_runtime/plugin.cfg");
    expect(first.projectConfigurationChanged).toBe(true);
    expect(second.projectConfigurationChanged).toBe(false);
    expect(project.enabledPlugins).toEqual([
      "existing_plugin",
      "res://addons/godot_agent_runtime/plugin.cfg",
    ]);
    expect(configuration.match(/"res:\/\/addons\/godot_agent_runtime\/plugin\.cfg"/g)).toHaveLength(1);
    expect(pluginConfig).toMatch(/^; SPDX-License-Identifier: MIT\r?\n/);
    expect(pluginConfig).toContain('version="0.2.0"');
    expect(pluginScript).toMatch(/^# SPDX-License-Identifier: MIT\r?\n/);
    expect(editorBridge).toMatch(/^# SPDX-License-Identifier: MIT\r?\n/);
    expect(runtimeBridge).toMatch(/^# SPDX-License-Identifier: MIT\r?\n/);
    expect(addonLicense).toContain("MIT License");
    expect(addonLicense).toContain("Copyright (c) 2026 Godot Agent Runtime contributors");
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

  it("plans every addon write before applying and preserves unchanged mtimes", async () => {
    const projectPath = await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-addon-plan-"));
    temporaryDirectories.push(projectPath);
    const projectFile = resolve(projectPath, "project.godot");
    await writeFile(projectFile, "config_version=5\n", "utf8");
    const api = addonModule as unknown as {
      planGodotAddonInstall(projectPath: string): Promise<{
        addonWrites: readonly { operation: string; resourcePath: string }[];
        projectWrite: { operation: string };
      }>;
      applyGodotAddonInstallPlan(plan: unknown): Promise<{
        projectConfigurationChanged: boolean;
      }>;
    };

    const firstPlan = await api.planGodotAddonInstall(projectPath);
    expect(firstPlan.addonWrites).toHaveLength(5);
    expect(firstPlan.addonWrites.every((write) => write.operation === "created")).toBe(true);
    expect(firstPlan.projectWrite.operation).toBe("updated");
    await expect(access(resolve(projectPath, "addons"))).rejects.toMatchObject({ code: "ENOENT" });
    await api.applyGodotAddonInstallPlan(firstPlan);

    const secondPlan = await api.planGodotAddonInstall(projectPath);
    expect(secondPlan.addonWrites.every((write) => write.operation === "unchanged")).toBe(true);
    expect(secondPlan.projectWrite.content).toBe(await readFile(projectFile, "utf8"));
    expect(secondPlan.projectWrite.operation).toBe("unchanged");
    const pluginPath = resolve(projectPath, "addons", "godot_agent_runtime", "plugin.cfg");
    const pluginBefore = await stat(pluginPath);
    const projectBefore = await stat(projectFile);
    await expect(api.applyGodotAddonInstallPlan(secondPlan)).resolves.toMatchObject({
      projectConfigurationChanged: false,
    });
    const pluginAfter = await stat(pluginPath);
    const projectAfter = await stat(projectFile);
    expect(pluginAfter.mtimeMs).toBe(pluginBefore.mtimeMs);
    expect(projectAfter.mtimeMs).toBe(projectBefore.mtimeMs);
  });

  it("reports completed addon targets after a project.godot plan conflict and converges on retry", async () => {
    const projectPath = await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-addon-conflict-"));
    temporaryDirectories.push(projectPath);
    const projectFile = resolve(projectPath, "project.godot");
    await writeFile(projectFile, "config_version=5\n", "utf8");
    const api = addonModule as unknown as {
      planGodotAddonInstall(projectPath: string): Promise<unknown>;
      applyGodotAddonInstallPlan(plan: unknown): Promise<unknown>;
    };

    const plan = await api.planGodotAddonInstall(projectPath);
    await writeFile(projectFile, "config_version=5\n; concurrent change\n", "utf8");

    await expect(api.applyGodotAddonInstallPlan(plan)).rejects.toMatchObject({
      payload: {
        code: "FILE_WRITE_CONFLICT",
        details: {
          completedTargets: [
            "res://addons/godot_agent_runtime/LICENSE",
            "res://addons/godot_agent_runtime/plugin.cfg",
            "res://addons/godot_agent_runtime/plugin.gd",
            "res://addons/godot_agent_runtime/editor_bridge.gd",
            "res://addons/godot_agent_runtime/runtime_entry.gd",
          ],
        },
      },
    });
    expect(await readFile(projectFile, "utf8")).not.toContain(
      "res://addons/godot_agent_runtime/plugin.cfg",
    );

    const retry = await api.planGodotAddonInstall(projectPath);
    await expect(api.applyGodotAddonInstallPlan(retry)).resolves.toMatchObject({
      projectConfigurationChanged: true,
    });
    expect(await readFile(projectFile, "utf8")).toContain(
      "res://addons/godot_agent_runtime/plugin.cfg",
    );
  });

  it("migrates legacy and duplicate enablement entries to one canonical plugin path", async () => {
    const projectPath = await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-addon-migration-"));
    temporaryDirectories.push(projectPath);
    await writeFile(
      resolve(projectPath, "project.godot"),
      [
        "config_version=5",
        "",
        "[editor_plugins]",
        "",
        'enabled=PackedStringArray("first_plugin", "godot_agent_runtime", "second_plugin", "res://addons/godot_agent_runtime/plugin.cfg", "godot_agent_runtime")',
        "",
      ].join("\n"),
      "utf8",
    );

    await installGodotAddon(projectPath);
    const project = await inspectProject(projectPath);
    const configuration = await readFile(resolve(projectPath, "project.godot"), "utf8");

    expect(project.enabledPlugins).toEqual([
      "first_plugin",
      "res://addons/godot_agent_runtime/plugin.cfg",
      "second_plugin",
    ]);
    expect(configuration).not.toContain('"godot_agent_runtime"');
    expect(configuration.match(/"res:\/\/addons\/godot_agent_runtime\/plugin\.cfg"/g)).toHaveLength(1);
  });

  it("recognizes both canonical and legacy plugin enablement during the 0.2.x migration", () => {
    const module = addonModule as unknown as {
      GODOT_AGENT_PLUGIN_PATH: string;
      isGodotAgentRuntimeEnabled: (plugins: readonly string[]) => boolean;
    };

    expect(module.GODOT_AGENT_PLUGIN_PATH)
      .toBe("res://addons/godot_agent_runtime/plugin.cfg");
    expect(module.isGodotAgentRuntimeEnabled([
      "res://addons/godot_agent_runtime/plugin.cfg",
    ])).toBe(true);
    expect(module.isGodotAgentRuntimeEnabled(["godot_agent_runtime"])).toBe(true);
    expect(module.isGodotAgentRuntimeEnabled(["some_other_plugin"])).toBe(false);
  });

  it("requires the canonical plugin path in the public addon result schema", () => {
    expect(() => AddonInstallResultSchema.parse({
      ok: true,
      projectPath: "C:\\fixture",
      plugin: "godot_agent_runtime",
      files: [],
      projectConfigurationChanged: false,
    })).toThrow();
    expect(AddonInstallResultSchema.parse({
      ok: true,
      projectPath: "C:\\fixture",
      plugin: "godot_agent_runtime",
      pluginPath: "res://addons/godot_agent_runtime/plugin.cfg",
      files: [],
      projectConfigurationChanged: false,
    }).pluginPath).toBe("res://addons/godot_agent_runtime/plugin.cfg");
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
