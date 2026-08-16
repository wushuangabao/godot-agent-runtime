import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { inspectProject } from "../../packages/core/src/project.js";

describe("inspectProject", () => {
  it("reads stable project metadata", async () => {
    const project = await inspectProject(resolve("examples", "minimal-2d"));

    expect(project).toMatchObject({
      name: "Godot Agent Runtime Minimal 2D",
      mainScene: "res://main.tscn",
      renderer: "gl_compatibility",
      enabledPlugins: [],
    });
  });

  it("reads enabled only from the editor_plugins section", async () => {
    const projectPath = await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-project-"));
    try {
      await writeFile(
        resolve(projectPath, "project.godot"),
        [
          "config_version=5",
          "",
          "[unrelated_feature]",
          "enabled=true",
          "",
          "[editor_plugins]",
          'enabled=PackedStringArray("godot_agent_runtime")',
          "",
        ].join("\n"),
        "utf8",
      );

      expect((await inspectProject(projectPath)).enabledPlugins).toEqual(["godot_agent_runtime"]);
    } finally {
      await rm(projectPath, { recursive: true });
    }
  });
});
