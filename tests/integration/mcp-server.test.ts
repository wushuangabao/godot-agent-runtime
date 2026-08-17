import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getAgentGuide, getProjectIdentity, readProjectFile } from "../../packages/core/src/index.js";
import { createMcpServer } from "../../packages/mcp-server/src/server.js";
import { SafeFileWriteResultSchema, SafeTextReplaceResultSchema } from "../../packages/protocol/src/index.js";

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

let compiledCli: Promise<void> | undefined;

async function runChild(command: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((complete, reject) => {
    child.once("error", reject);
    child.once("close", complete);
  });
  return { code, stdout, stderr };
}

async function ensureCompiledCli(): Promise<void> {
  compiledCli ??= (async () => {
    const compiler = resolve(process.cwd(), "node_modules", "typescript", "bin", "tsc");
    const result = await runChild(process.execPath, [
      compiler,
      "-b",
      "packages/cli",
      "--pretty",
      "false",
    ]);
    if (result.code !== 0) {
      throw new Error(`Failed to compile CLI fixture:\n${result.stdout}${result.stderr}`);
    }
  })();
  await compiledCli;
}

async function runCli(args: string[]): Promise<{ code: number | null; payload: Record<string, unknown> }> {
  await ensureCompiledCli();
  const executable = resolve(process.cwd(), "packages", "cli", "dist", "bin.js");
  const result = await runChild(process.execPath, [executable, ...args]);
  return {
    code: result.code,
    payload: JSON.parse(result.stdout) as Record<string, unknown>,
  };
}

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
      "godot_project_context",
      "godot_agent_guide",
      "godot_project_check",
      "godot_script_check",
      "godot_file_read",
      "godot_file_write",
      "godot_file_replace",
      "godot_addon_install",
      "godot_scene_run",
      "godot_scene_launch",
      "godot_run_status",
      "godot_log_read",
      "godot_diagnostics",
      "godot_debug_report",
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
      "godot_editor_project_setting_get",
      "godot_editor_project_setting_set",
      "godot_editor_input_action_upsert",
      "godot_editor_resource_inspect",
      "godot_editor_scene_open",
      "godot_editor_scene_tree",
      "godot_editor_node_get",
      "godot_editor_selection_get",
      "godot_editor_selection_set",
      "godot_editor_batch",
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
    expect(tools).toHaveLength(62);
    expect(Buffer.byteLength(JSON.stringify(stable(tools)), "utf8")).toBeLessThanOrEqual(144_606);
    const instructions = client.getInstructions() ?? "";
    expect(Buffer.byteLength(instructions, "utf8")).toBeLessThanOrEqual(4_096);
    for (const required of [
      "godot_project_context",
      "godot_agent_guide",
      "godot_diagnostics",
      "godot_runtime_assert",
      "godot_run_stop",
    ]) {
      expect(instructions).toContain(required);
    }
    const advertised = new Set(names);
    for (const recipe of getAgentGuide().recipes) {
      for (const tool of recipe.tools) expect(advertised.has(tool), `${recipe.id}: ${tool}`).toBe(true);
    }
    const fileWrite = tools.find(({ name }) => name === "godot_file_write");
    const fileReplace = tools.find(({ name }) => name === "godot_file_replace");
    const projectContext = tools.find(({ name }) => name === "godot_project_context");
    const scriptCheck = tools.find(({ name }) => name === "godot_script_check");
    const editorStatus = tools.find(({ name }) => name === "godot_editor_status");
    const projectSettingSet = tools.find(({ name }) => name === "godot_editor_project_setting_set");
    const inputActionUpsert = tools.find(({ name }) => name === "godot_editor_input_action_upsert");
    const resourceInspect = tools.find(({ name }) => name === "godot_editor_resource_inspect");
    const editorSceneOpen = tools.find(({ name }) => name === "godot_editor_scene_open");
    const editorNodeCreate = tools.find(({ name }) => name === "godot_editor_node_create");
    const editorBatch = tools.find(({ name }) => name === "godot_editor_batch");
    const editorSceneSave = tools.find(({ name }) => name === "godot_editor_scene_save");
    const editorScreenshot = tools.find(({ name }) => name === "godot_editor_screenshot");
    const runtimeScreenshot = tools.find(({ name }) => name === "godot_runtime_screenshot");
    const logRead = tools.find(({ name }) => name === "godot_log_read");
    const diagnostics = tools.find(({ name }) => name === "godot_diagnostics");
    const debugReport = tools.find(({ name }) => name === "godot_debug_report");
    expect(projectContext?.inputSchema.additionalProperties).toBe(false);
    expect(projectContext?.outputSchema?.additionalProperties).toBe(false);
    expect(projectContext?.annotations).toEqual({
      readOnlyHint: true,
      idempotentHint: true,
    });
    expect(scriptCheck?.inputSchema.additionalProperties).toBe(false);
    expect(scriptCheck?.outputSchema?.additionalProperties).toBe(false);
    expect(scriptCheck?.annotations).toEqual({
      readOnlyHint: false,
      idempotentHint: true,
    });
    expect(editorStatus?.outputSchema?.properties).toHaveProperty("historyVersion");
    expect(projectSettingSet?.inputSchema.required).toEqual(expect.arrayContaining([
      "expectedProjectFingerprint",
      "expectedProjectFileSha256",
      "key",
      "value",
    ]));
    expect(projectSettingSet?.inputSchema.additionalProperties).toBe(false);
    expect(projectSettingSet?.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(inputActionUpsert?.inputSchema.required).toEqual(expect.arrayContaining([
      "expectedProjectFingerprint",
      "expectedProjectFileSha256",
      "name",
      "events",
    ]));
    expect(inputActionUpsert?.inputSchema.additionalProperties).toBe(false);
    expect(resourceInspect?.inputSchema.additionalProperties).toBe(false);
    expect(resourceInspect?.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
    });
    expect(editorSceneOpen?.inputSchema.required).toEqual(expect.arrayContaining([
      "expectedProjectFingerprint",
      "scenePath",
    ]));
    expect(editorSceneOpen?.outputSchema?.properties).toHaveProperty("historyVersion");
    expect(editorNodeCreate?.inputSchema.required).toContain("expectedScenePath");
    expect(editorNodeCreate?.inputSchema.properties).toHaveProperty("expectedProjectFingerprint");
    expect(editorBatch?.inputSchema.required).toEqual(expect.arrayContaining([
      "expectedScenePath",
      "expectedProjectFingerprint",
      "operations",
      "confirmDestructive",
    ]));
    expect(editorBatch?.inputSchema.additionalProperties).toBe(false);
    expect(editorBatch?.outputSchema?.additionalProperties).toBe(false);
    expect(editorBatch?.outputSchema?.properties).not.toHaveProperty("saved");
    expect(editorBatch?.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
    expect(editorSceneSave?.inputSchema.required).toEqual(expect.arrayContaining([
      "expectedScenePath",
      "expectedHistoryVersion",
    ]));
    expect(editorScreenshot?.inputSchema.properties).toHaveProperty("expectedScenePath");
    expect(runtimeScreenshot?.inputSchema.properties).toHaveProperty("expectedScenePath");
    expect(editorScreenshot?.outputSchema?.required).toContain("evidence");
    expect(runtimeScreenshot?.outputSchema?.required).toContain("evidence");
    expect(editorScreenshot?.outputSchema?.properties).toHaveProperty("evidence");
    expect(runtimeScreenshot?.outputSchema?.properties).toHaveProperty("evidence");
    expect(logRead?.inputSchema.additionalProperties).toBe(false);
    expect(diagnostics?.inputSchema.additionalProperties).toBe(false);
    expect(debugReport?.inputSchema.required).toEqual(expect.arrayContaining([
      "projectPath",
      "expectedProjectFingerprint",
      "issue",
    ]));
    expect(debugReport?.inputSchema.additionalProperties).toBe(false);
    expect(fileWrite?.inputSchema.additionalProperties).toBe(false);
    expect(fileWrite?.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(fileReplace?.inputSchema.additionalProperties).toBe(false);
    expect(fileReplace?.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
  });

  it("offers the same static agent guidance through MCP and CLI", async () => {
    const overview = await client.callTool({ name: "godot_agent_guide", arguments: {} });
    const recipe = await client.callTool({
      name: "godot_agent_guide",
      arguments: { recipeId: "safe-scene-batch" },
    });
    const cliOverview = await runCli(["agent-guide"]);
    const cliRecipe = await runCli(["agent-guide", "safe-scene-batch"]);

    expect(overview.isError).not.toBe(true);
    expect(recipe.isError).not.toBe(true);
    expect(overview.structuredContent).toEqual(getAgentGuide());
    expect(recipe.structuredContent).toEqual(getAgentGuide("safe-scene-batch"));
    expect(cliOverview).toEqual({ code: 0, payload: overview.structuredContent as Record<string, unknown> });
    expect(cliRecipe).toEqual({ code: 0, payload: recipe.structuredContent as Record<string, unknown> });
  });

  it("returns the stable scene guard error when expectedScenePath is omitted", async () => {
    const projectPath = resolveProject("examples/minimal-2d");
    const runId = "00000000-0000-4000-8000-000000000000";

    const missingSceneGuard = await client.callTool({
      name: "godot_editor_node_create",
      arguments: {
        projectPath,
        runId,
        parentPath: ".",
        type: "Node2D",
        name: "MissingSceneGuard",
      },
    });
    expect(missingSceneGuard.isError).toBe(true);
    expect(missingSceneGuard.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: "EDITOR_SCENE_PATH_REQUIRED",
        recovery: expect.arrayContaining([expect.any(String)]),
      },
    });
  });

  it("returns the stable history guard error when expectedHistoryVersion is omitted", async () => {
    const projectPath = resolveProject("examples/minimal-2d");
    const runId = "00000000-0000-4000-8000-000000000000";
    const missingHistoryGuard = await client.callTool({
      name: "godot_editor_scene_save",
      arguments: {
        projectPath,
        runId,
        expectedScenePath: "res://main.tscn",
      },
    });
    expect(missingHistoryGuard.isError).toBe(true);
    expect(missingHistoryGuard.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: "EDITOR_HISTORY_VERSION_REQUIRED",
        recovery: expect.arrayContaining([expect.any(String)]),
      },
    });
  });

  it("rejects unknown raw batch operations through MCP and CLI before bridge access", async () => {
    const projectPath = resolveProject("examples/minimal-2d");
    const runId = "00000000-0000-4000-8000-000000000000";
    const operations = [{ op: "run_script", source: "print('unsafe')" }];
    const result = await client.callTool({
      name: "godot_editor_batch",
      arguments: {
        projectPath,
        runId,
        expectedProjectFingerprint: "0".repeat(64),
        expectedScenePath: "res://main.tscn",
        operations,
        confirmDestructive: false,
      },
    });
    const cli = await runCli([
      "editor-batch",
      projectPath,
      runId,
      "--project-fingerprint",
      "0".repeat(64),
      "--scene",
      "res://main.tscn",
      "--operations",
      JSON.stringify(operations),
      "--confirm-destructive",
      "false",
    ]);

    expect(result.isError).toBe(true);
    expect(cli).toMatchObject({
      code: 1,
      payload: { ok: false, error: { code: "EDITOR_BATCH_INPUT_INVALID", stage: "validation" } },
    });
  });

  it("enforces guarded writes and exposes structured text replacement", async () => {
    const projectPath = await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-mcp-files-"));
    try {
      await writeFile(
        resolve(projectPath, "project.godot"),
        'config_version=5\n[application]\nconfig/name="MCP File Fixture"\n',
        "utf8",
      );
      await writeFile(resolve(projectPath, "main.gd"), "extends Node\n", "utf8");
      const identity = await getProjectIdentity(projectPath);
      const before = await readProjectFile({ projectPath, path: "main.gd" });

      const unguarded = await client.callTool({
        name: "godot_file_write",
        arguments: { projectPath, path: "unguarded.gd", content: "extends Node\n" },
      });
      expect(unguarded.isError).toBe(true);
      expect(unguarded.structuredContent).toMatchObject({
        ok: false,
        error: {
          code: "FILE_GUARD_REQUIRED",
          recovery: expect.arrayContaining([expect.any(String)]),
        },
      });

      const bothGuards = await client.callTool({
        name: "godot_file_write",
        arguments: {
          projectPath,
          path: "main.gd",
          content: "extends Node2D\n",
          guard: { mode: "match", sha256: before.sha256 },
          expectedSha256: before.sha256,
        },
      });
      expect(bothGuards.isError).toBe(true);
      expect(bothGuards.structuredContent).toMatchObject({
        ok: false,
        error: {
          code: "FILE_GUARD_CONFLICT",
          recovery: expect.arrayContaining([expect.any(String)]),
        },
      });

      const legacy = await client.callTool({
        name: "godot_file_write",
        arguments: {
          projectPath,
          path: "main.gd",
          content: "extends Node2D\n",
          expectedSha256: before.sha256,
          expectedProjectFingerprint: identity.projectFingerprint,
        },
      });
      expect(legacy.isError).not.toBe(true);
      expect(legacy.structuredContent).toMatchObject({ operation: "updated" });

      const current = await readProjectFile({ projectPath, path: "main.gd" });
      const wrongProject = await client.callTool({
        name: "godot_file_write",
        arguments: {
          projectPath,
          path: "main.gd",
          content: "extends Control\n",
          guard: { mode: "match", sha256: current.sha256 },
          expectedProjectFingerprint: "0".repeat(64),
        },
      });
      expect(wrongProject.isError).toBe(true);
      expect(wrongProject.structuredContent).toMatchObject({
        ok: false,
        error: { code: "PROJECT_IDENTITY_MISMATCH" },
      });
      expect(await readFile(resolve(projectPath, "main.gd"), "utf8")).toBe("extends Node2D\n");

      const replaced = await client.callTool({
        name: "godot_file_replace",
        arguments: {
          projectPath,
          expectedProjectFingerprint: identity.projectFingerprint,
          path: "main.gd",
          oldText: "extends Node2D",
          newText: "extends Control",
        },
      });
      expect(replaced.isError).not.toBe(true);
      expect(replaced.structuredContent).toMatchObject({ replacements: 1, operation: "updated" });

      await writeFile(resolve(projectPath, "duplicate.gd"), "value = 1\nvalue = 1\n", "utf8");
      const ambiguous = await client.callTool({
        name: "godot_file_replace",
        arguments: {
          projectPath,
          expectedProjectFingerprint: identity.projectFingerprint,
          path: "duplicate.gd",
          oldText: "value = 1",
          newText: "value = 2",
        },
      });
      expect(ambiguous.isError).toBe(true);
      expect(ambiguous.structuredContent).toMatchObject({
        ok: false,
        error: { code: "FILE_REPLACE_AMBIGUOUS" },
      });
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("offers equivalent guarded file operations through the CLI", async () => {
    const projectPath = await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-cli-files-"));
    try {
      await writeFile(resolve(projectPath, "project.godot"), "config_version=5\n", "utf8");
      await writeFile(resolve(projectPath, "main.gd"), "extends Node\n", "utf8");
      const identity = await getProjectIdentity(projectPath);
      const before = await readProjectFile({ projectPath, path: "main.gd" });

      const read = await runCli(["file-read", projectPath, "main.gd"]);
      expect(read).toMatchObject({ code: 0, payload: { sha256: before.sha256 } });

      const write = await runCli([
        "file-write",
        projectPath,
        "main.gd",
        "--content",
        "extends Node2D\n",
        "--expected-sha256",
        before.sha256,
        "--expected-project-fingerprint",
        identity.projectFingerprint,
      ]);
      expect(write).toMatchObject({ code: 0, payload: { operation: "updated" } });

      const replace = await runCli([
        "file-replace",
        projectPath,
        "main.gd",
        "--project-fingerprint",
        identity.projectFingerprint,
        "--old",
        "extends Node2D",
        "--new",
        "extends Control",
      ]);
      expect(replace).toMatchObject({ code: 0, payload: { replacements: 1 } });

      const create = await runCli([
        "file-write",
        projectPath,
        "created.gd",
        "--content",
        "extends Node\n",
        "--create-only",
      ]);
      expect(create).toMatchObject({ code: 0, payload: { operation: "created" } });

      const neitherGuard = await runCli([
        "file-write",
        projectPath,
        "neither.gd",
        "--content",
        "extends Node\n",
      ]);
      expect(neitherGuard).toMatchObject({
        code: 1,
        payload: {
          error: {
            code: "FILE_GUARD_REQUIRED",
            recovery: expect.arrayContaining([expect.any(String)]),
          },
        },
      });

      const bothGuards = await runCli([
        "file-write",
        projectPath,
        "main.gd",
        "--content",
        "extends Control\n",
        "--create-only",
        "--expected-sha256",
        before.sha256,
      ]);
      expect(bothGuards).toMatchObject({
        code: 1,
        payload: {
          error: {
            code: "FILE_GUARD_CONFLICT",
            recovery: expect.arrayContaining([expect.any(String)]),
          },
        },
      });
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("rejects unknown fields in file mutation output schemas", () => {
    const writeResult = {
      ok: true as const,
      projectPath: "C:/project",
      path: "res://main.gd",
      operation: "updated" as const,
      bytes: 1,
      sha256: "1".repeat(64),
      previousSha256: "2".repeat(64),
    };

    expect(SafeFileWriteResultSchema.safeParse({ ...writeResult, unexpected: true }).success).toBe(false);
    expect(SafeTextReplaceResultSchema.safeParse({
      ...writeResult,
      replacements: 1,
      unexpected: true,
    }).success).toBe(false);
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

  it("offers equivalent project context through MCP and CLI", async () => {
    const projectPath = resolveProject("examples/minimal-2d");
    const result = await client.callTool({
      name: "godot_project_context",
      arguments: { projectPath },
    });
    const cli = await runCli(["context", projectPath]);

    expect(result.isError).not.toBe(true);
    expect(cli.code).toBe(0);
    expect(cli.payload).toEqual(result.structuredContent);
    expect(cli.payload).toMatchObject({
      ok: true,
      project: { mainScene: "res://main.tscn" },
      editor: null,
      runtime: null,
    });
  });

  it("offers equivalent unsupported script errors through MCP and CLI", async () => {
    const projectPath = resolveProject("tests/fixtures/script-check");
    const result = await client.callTool({
      name: "godot_script_check",
      arguments: { projectPath, path: "res://project.godot" },
    });
    const cli = await runCli(["script-check", projectPath, "res://project.godot"]);

    expect(result.isError).toBe(true);
    expect(cli.code).toBe(1);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "SCRIPT_TYPE_UNSUPPORTED", stage: "validation" },
    });
    expect(cli.payload).toEqual(result.structuredContent);
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

  it("offers equivalent bounded log and diagnostic results through MCP and CLI", async () => {
    const projectPath = await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-mcp-diagnostics-"));
    try {
      await writeFile(resolve(projectPath, "project.godot"), "config_version=5\n", "utf8");
      const runId = "00000000-0000-4000-8000-000000000017";
      const directory = resolve(projectPath, ".godot", "agent-runtime", "runs");
      await mkdir(directory, { recursive: true });
      const stdoutPath = resolve(directory, `${runId}.stdout.log`);
      const stderrPath = resolve(directory, `${runId}.stderr.log`);
      await writeFile(stdoutPath, "READY\n", "utf8");
      await writeFile(stderrPath, "ERROR: token=transport-secret\n", "utf8");
      await writeFile(resolve(directory, `${runId}.json`), `${JSON.stringify({
        schemaVersion: 1,
        runId,
        token: "metadata-secret",
        state: "exited",
        projectPath,
        scene: null,
        processId: null,
        supervisorProcessId: process.pid,
        startedAt: new Date(0).toISOString(),
        endedAt: new Date(1).toISOString(),
        exitCode: 0,
        signal: null,
        command: ["godot", "--path", projectPath],
        stdoutPath,
        stderrPath,
        runtimeBridgePort: null,
        failure: null,
      }, null, 2)}\n`, "utf8");

      const log = await client.callTool({
        name: "godot_log_read",
        arguments: { projectPath, runId, minimumSeverity: "warning", deduplicate: true },
      });
      const logCli = await runCli(["log-read", projectPath, runId, "--minimum-severity", "warning", "--deduplicate", "true"]);
      expect(log.isError).not.toBe(true);
      expect(logCli).toMatchObject({ code: 0, payload: log.structuredContent });

      const diagnostic = await client.callTool({
        name: "godot_diagnostics",
        arguments: { projectPath, runId },
      });
      const diagnosticCli = await runCli(["diagnostics", projectPath, runId]);
      expect(diagnostic.isError).not.toBe(true);
      expect(diagnosticCli).toMatchObject({ code: 0, payload: diagnostic.structuredContent });

      const identity = await getProjectIdentity(projectPath);
      const oversizedCliIssue = await runCli([
        "debug-report",
        projectPath,
        "--project-fingerprint",
        identity.projectFingerprint,
        "--issue",
        "x".repeat(16_385),
      ]);
      expect(oversizedCliIssue).toMatchObject({ code: 1, payload: { ok: false } });
      const report = await client.callTool({
        name: "godot_debug_report",
        arguments: {
          projectPath,
          expectedProjectFingerprint: identity.projectFingerprint,
          issue: "Runtime log error",
          runId,
          reproduction: "token=mcp-report-secret",
          format: "json",
        },
      });
      const reportCli = await runCli([
        "debug-report",
        projectPath,
        "--project-fingerprint",
        identity.projectFingerprint,
        "--issue",
        "Runtime log error",
        "--run-id",
        runId,
        "--reproduction",
        "token=cli-report-secret",
        "--format",
        "json",
      ]);
      expect(report.isError).not.toBe(true);
      expect(report.structuredContent).toMatchObject({ reviewRequired: true, path: expect.stringMatching(/\.json$/) });
      expect(reportCli).toMatchObject({ code: 0, payload: { reviewRequired: true, path: expect.stringMatching(/\.json$/) } });
      for (const receipt of [report.structuredContent, reportCli.payload] as Array<{ path: string }>) {
        const contents = await readFile(resolve(projectPath, receipt.path.slice("res://".length)), "utf8");
        expect(contents).not.toContain("report-secret");
        expect(contents).toContain("[REDACTED]");
      }
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("preserves managed-run stable errors for all diagnostic tools", async () => {
    const projectPath = resolveProject("examples/minimal-2d");
    const runId = "00000000-0000-4000-8000-000000000000";
    for (const name of ["godot_log_read", "godot_diagnostics"] as const) {
      const result = await client.callTool({ name, arguments: { projectPath, runId } });
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { ok: false, error: { code: "RUN_NOT_FOUND", stage: "discovery" } },
      });
    }
  });

  it("rejects unknown options and extra positionals for every new CLI command", async () => {
    const projectPath = resolveProject("examples/minimal-2d");
    const runId = "00000000-0000-4000-8000-000000000000";
    const fingerprint = (await getProjectIdentity(projectPath)).projectFingerprint;
    const cases = [
      ["log-read", projectPath, runId, "--maximum-lines", "1"],
      ["log-read", projectPath, runId, "extra"],
      ["diagnostics", projectPath, runId, "--maximum-issues", "1"],
      ["diagnostics", projectPath, runId, "extra"],
      ["debug-report", projectPath, "--project-fingerprint", fingerprint, "--issue", "issue", "--unknown", "value"],
      ["debug-report", projectPath, "extra", "--project-fingerprint", fingerprint, "--issue", "issue"],
    ];
    for (const args of cases) {
      const result = await runCli(args);
      expect(result).toMatchObject({ code: 1, payload: { ok: false } });
    }
  });
});

function resolveProject(relativePath: string): string {
  return new URL(`../../${relativePath}`, import.meta.url).pathname.replace(/^\/(.:)/, "$1");
}
