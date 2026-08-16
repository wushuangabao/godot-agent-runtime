import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMcpServer } from "../../packages/mcp-server/src/server.js";

describe("MCP server", () => {
  const server = createMcpServer();
  const client = new Client({ name: "integration-test", version: "0.1.0" });

  beforeEach(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await Promise.all([client.close(), server.close()]);
  });

  it("advertises high-level tools with schemas", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual([
      "godot_doctor",
      "godot_projects_find",
      "godot_project_inspect",
      "godot_project_check",
      "godot_file_read",
      "godot_file_write",
      "godot_addon_install",
      "godot_scene_run",
      "godot_scene_launch",
      "godot_run_status",
      "godot_run_stop",
      "godot_runtime_status",
      "godot_runtime_screenshot",
      "godot_runtime_ui_find",
      "godot_runtime_scene_tree",
      "godot_runtime_node_get",
      "godot_runtime_observe",
      "godot_runtime_simulate_physics",
      "godot_runtime_3d_project",
      "godot_runtime_3d_raycast",
      "godot_runtime_input",
      "godot_runtime_input_sequence",
      "godot_runtime_assert",
      "godot_runtime_wait",
      "godot_runtime_control",
      "godot_editor_launch",
      "godot_editor_status",
      "godot_editor_scene_tree",
      "godot_editor_node_get",
      "godot_editor_selection_get",
      "godot_editor_selection_set",
      "godot_editor_node_create",
      "godot_editor_scene_instantiate",
      "godot_editor_scene_create_inherited",
      "godot_editor_instance_get",
      "godot_editor_instance_set_editable",
      "godot_editor_node_update",
      "godot_editor_node_delete",
      "godot_editor_node_move",
      "godot_editor_resource_create",
      "godot_editor_resource_get",
      "godot_editor_resource_update",
      "godot_editor_resource_save",
      "godot_editor_resource_focus",
      "godot_editor_signal_connect",
      "godot_editor_scene_save",
      "godot_editor_undo",
      "godot_editor_redo",
      "godot_editor_screenshot",
    ]);
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.outputSchema).toBeDefined();
    }
  });

  it("returns structured project metadata", async () => {
    await client.listTools();
    const result = await client.callTool({
      name: "godot_project_inspect",
      arguments: { projectPath: resolveProject("examples/minimal-2d") },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      name: "Godot Agent Runtime Minimal 2D",
      mainScene: "res://main.tscn",
    });
  });

  it("preserves structured recovery data on failure", async () => {
    const result = await client.callTool({
      name: "godot_project_inspect",
      arguments: { projectPath: resolveProject("examples/does-not-exist") },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: "PROJECT_NOT_FOUND",
        stage: "discovery",
      },
    });
    expect(
      (result.structuredContent as { error: { recovery: string[] } }).error.recovery,
    ).not.toHaveLength(0);
  });

  it("returns a structured error for an unknown run", async () => {
    const result = await client.callTool({
      name: "godot_run_status",
      arguments: {
        projectPath: resolveProject("examples/control-ui"),
        runId: "00000000-0000-4000-8000-000000000000",
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "RUN_NOT_FOUND", stage: "discovery" },
    });
  });
});

function resolveProject(relativePath: string): string {
  return new URL(`../../${relativePath}`, import.meta.url).pathname.replace(/^\/(.:)/, "$1");
}
