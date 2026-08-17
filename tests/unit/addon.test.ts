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
