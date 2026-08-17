import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { chmod, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  batchEditorScene,
  captureEditorScreenshot,
  connectEditorSignal,
  createInheritedEditorScene,
  createEditorNode,
  createEditorResource,
  deleteEditorNode,
  findRuntimeUi,
  focusEditorResource,
  getEditorProjectSetting,
  getEditorInstance,
  getEditorInfo,
  getEditorNode,
  getEditorSceneTree,
  getEditorSelection,
  getEditorResource,
  getProjectIdentity,
  assertRuntime,
  injectRuntimeInput,
  installGodotAddon,
  instantiateEditorScene,
  launchEditor,
  launchProject,
  moveEditorNode,
  openEditorScene,
  redoEditorAction,
  saveEditorScene,
  saveEditorResource,
  setEditorSelection,
  setEditorInstanceEditable,
  setEditorProjectSetting,
  stopManagedRun,
  updateEditorNode,
  updateEditorResource,
  upsertEditorInputAction,
  undoEditorAction,
  inspectEditorResourcePath,
  writeProjectFile,
} from "../../packages/core/src/index.js";

const configPath = resolve("config", "development.local.json");
const hasLocalConfig = existsSync(configPath);

async function blockSceneSave(path: string): Promise<() => Promise<void>> {
  if (process.platform !== "win32") {
    await chmod(path, 0o444);
    return async () => await chmod(path, 0o666);
  }
  const script = [
    "$stream = [System.IO.File]::Open($args[0], [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)",
    "[Console]::Out.WriteLine('READY')",
    "[Console]::Out.Flush()",
    "[Console]::In.ReadLine() | Out-Null",
    "$stream.Dispose()",
  ].join("; ");
  const helperDirectory = await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-scene-lock-"));
  const helperPath = resolve(helperDirectory, "lock.ps1");
  await writeFile(helperPath, script, "utf8");
  const child = spawn("powershell.exe", ["-NoProfile", "-File", helperPath, path], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  await new Promise<void>((complete, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out acquiring an exclusive scene lock.")), 5_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Scene lock helper exited before READY with code ${code}: ${stderr}`));
    });
    child.stdout.on("data", (chunk: string) => {
      if (!chunk.includes("READY")) return;
      clearTimeout(timeout);
      complete();
    });
  });
  return async () => {
    child.stdin.end("\n");
    await new Promise<void>((complete, reject) => {
      child.once("error", reject);
      child.once("close", () => complete());
    });
    await rm(helperDirectory, { recursive: true, force: true });
  };
}

describe.skipIf(!hasLocalConfig)("EditorPlugin integration", () => {
  it(
    "holds the shared project.godot lease while reconciling a timed-out Bridge response",
    async () => {
      const projectPath = await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-editor-settings-lease-"));
      await cp(resolve("examples", "control-ui"), projectPath, {
        recursive: true,
        filter: (source) => !source.includes(`${resolve("examples", "control-ui", ".godot")}`),
      });
      const previousDelay = process.env.GODOT_AGENT_RUNTIME_TEST_PROJECT_SETTING_DELAY_MS;
      process.env.GODOT_AGENT_RUNTIME_TEST_PROJECT_SETTING_DELAY_MS = "700";
      let runId: string | null = null;
      try {
        await installGodotAddon(projectPath);
        const launch = await launchEditor({ projectPath, configPath, timeoutMs: 30_000 });
        runId = launch.runId;
        const identity = await getProjectIdentity(projectPath);
        const source = await readFile(resolve(projectPath, "project.godot"), "utf8");

        const setting = setEditorProjectSetting({
          projectPath,
          runId,
          timeoutMs: 100,
          expectedProjectFingerprint: identity.projectFingerprint,
          expectedProjectFileSha256: identity.projectFileSha256,
          key: "display/window/size/viewport_width",
          value: 800,
        });
        await new Promise((complete) => setTimeout(complete, 150));
        let writerSettled = false;
        const writer = writeProjectFile({
          projectPath,
          path: "project.godot",
          content: `${source}\n; competing Task 2 writer\n`,
          expectedSha256: identity.projectFileSha256,
          expectedProjectFingerprint: identity.projectFingerprint,
        }).finally(() => { writerSettled = true; });
        await new Promise((complete) => setTimeout(complete, 200));
        expect(writerSettled).toBe(false);

        const changed = await setting;
        expect(changed).toMatchObject({
          value: 800,
          beforeSha256: identity.projectFileSha256,
          afterSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        });
        await expect(writer).rejects.toMatchObject({ payload: { code: "FILE_WRITE_CONFLICT" } });
      } finally {
        if (previousDelay === undefined) {
          delete process.env.GODOT_AGENT_RUNTIME_TEST_PROJECT_SETTING_DELAY_MS;
        } else {
          process.env.GODOT_AGENT_RUNTIME_TEST_PROJECT_SETTING_DELAY_MS = previousDelay;
        }
        if (runId !== null) await stopManagedRun({ projectPath, runId, timeoutMs: 15_000 });
        await rm(projectPath, { recursive: true, force: true });
      }
    },
    90_000,
  );

  it(
    "persists guarded project settings and InputMap while inspecting external resources read-only",
    async () => {
      const projectPath = await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-editor-settings-"));
      await cp(resolve("examples", "control-ui"), projectPath, {
        recursive: true,
        filter: (source) => !source.includes(`${resolve("examples", "control-ui", ".godot")}`),
      });
      await writeFile(
        resolve(projectPath, "agent_style.tres"),
        '[gd_resource type="StyleBoxFlat" format=3]\n\n[resource]\nbg_color = Color(0.2, 0.4, 0.8, 1)\n',
        "utf8",
      );
      const previousDelay = process.env.GODOT_AGENT_RUNTIME_TEST_PROJECT_SETTING_DELAY_MS;
      process.env.GODOT_AGENT_RUNTIME_TEST_PROJECT_SETTING_DELAY_MS = "700";
      let runId: string | null = null;
      try {
        await installGodotAddon(projectPath);
        const launch = await launchEditor({ projectPath, configPath, timeoutMs: 30_000 });
        runId = launch.runId;
        let identity = await getProjectIdentity(projectPath);

        expect(await getEditorInfo({ projectPath, runId })).toMatchObject({
          protocolVersion: "0.7.0",
          capabilities: expect.arrayContaining(["project_settings", "input_map", "resource_inspect"]),
        });
        expect(await getEditorProjectSetting({
          projectPath,
          runId,
          key: "display/window/size/viewport_width",
        })).toMatchObject({ key: "display/window/size/viewport_width", value: 640 });
        await expect(getEditorProjectSetting({
          projectPath,
          runId,
          key: "autoload/Unsafe",
        })).rejects.toMatchObject({ payload: { code: "EDITOR_PROJECT_SETTING_RESTRICTED" } });
        await expect(setEditorProjectSetting({
          projectPath,
          runId,
          expectedProjectFingerprint: identity.projectFingerprint,
          expectedProjectFileSha256: identity.projectFileSha256,
          key: "display/window/size/viewport_width",
          value: 0.5,
        })).rejects.toMatchObject({ payload: { code: "EDITOR_PROJECT_SETTING_TYPE_MISMATCH" } });

        const changed = await setEditorProjectSetting({
          projectPath,
          runId,
          expectedProjectFingerprint: identity.projectFingerprint,
          expectedProjectFileSha256: identity.projectFileSha256,
          key: "display/window/size/viewport_width",
          value: 960,
        });
        expect(changed).toMatchObject({
          changed: true,
          previousValue: 640,
          value: 960,
          beforeSha256: identity.projectFileSha256,
          afterSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          undoable: false,
        });

        identity = await getProjectIdentity(projectPath);
        const input = await upsertEditorInputAction({
          projectPath,
          runId,
          expectedProjectFingerprint: identity.projectFingerprint,
          expectedProjectFileSha256: identity.projectFileSha256,
          name: "agent_jump",
          deadzone: 0.5,
          replaceEvents: true,
          events: [{ type: "key", physicalKeycode: 32 }],
        });
        expect(input).toMatchObject({
          name: "agent_jump",
          deadzone: 0.5,
          events: [{ type: "key", physicalKeycode: 32 }],
          undoable: false,
        });
        const projectSource = await readFile(resolve(projectPath, "project.godot"), "utf8");
        expect(projectSource).toContain("[input]");
        expect(projectSource).toContain("agent_jump={");

        identity = await getProjectIdentity(projectPath);
        const unchangedStartedAt = Date.now();
        const unchangedInput = await upsertEditorInputAction({
          projectPath,
          runId,
          timeoutMs: 100,
          expectedProjectFingerprint: identity.projectFingerprint,
          expectedProjectFileSha256: identity.projectFileSha256,
          name: "agent_jump",
          deadzone: 0.5,
          replaceEvents: true,
          events: [{ type: "key", physicalKeycode: 32 }],
        });
        expect(unchangedInput).toMatchObject({
          name: "agent_jump",
          deadzone: 0.5,
          replaceEvents: true,
          events: [{ type: "key", physicalKeycode: 32 }],
          changed: false,
          beforeSha256: identity.projectFileSha256,
          afterSha256: identity.projectFileSha256,
          undoable: false,
        });
        expect(Date.now() - unchangedStartedAt).toBeLessThan(500);

        await stopManagedRun({ projectPath, runId, timeoutMs: 15_000 });
        runId = null;
        const restarted = await launchEditor({ projectPath, configPath, timeoutMs: 30_000 });
        runId = restarted.runId;
        identity = await getProjectIdentity(projectPath);
        const appended = await upsertEditorInputAction({
          projectPath,
          runId,
          expectedProjectFingerprint: identity.projectFingerprint,
          expectedProjectFileSha256: identity.projectFileSha256,
          name: "agent_jump",
          deadzone: 0.5,
          replaceEvents: false,
          events: [{ type: "mouse_button", buttonIndex: 1 }],
        });
        expect(appended.events).toHaveLength(2);
        expect(appended.events).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: "key", physicalKeycode: 32 }),
          { type: "mouse_button", buttonIndex: 1 },
        ]));

        const resource = await inspectEditorResourcePath({
          projectPath,
          runId,
          path: "res://agent_style.tres",
          properties: ["bg_color"],
        });
        expect(resource).toMatchObject({
          resource: {
            class: "StyleBoxFlat",
            path: "res://agent_style.tres",
            properties: { bg_color: { $type: "Color" } },
          },
        });
        await expect(inspectEditorResourcePath({
          projectPath,
          runId,
          path: "res://../agent_style.tres",
        })).rejects.toMatchObject({ payload: { code: "EDITOR_RESOURCE_PATH_ESCAPE" } });

        const beforeExternal = await getProjectIdentity(projectPath);
        await writeFile(
          resolve(projectPath, "project.godot"),
          `${await readFile(resolve(projectPath, "project.godot"), "utf8")}\n; external change\n`,
          "utf8",
        );
        const afterExternal = await getProjectIdentity(projectPath);
        await expect(setEditorProjectSetting({
          projectPath,
          runId,
          expectedProjectFingerprint: afterExternal.projectFingerprint,
          expectedProjectFileSha256: beforeExternal.projectFileSha256,
          key: "display/window/size/viewport_height",
          value: 540,
        })).rejects.toMatchObject({ payload: { code: "PROJECT_FILE_CONFLICT" } });
        await expect(setEditorProjectSetting({
          projectPath,
          runId,
          expectedProjectFingerprint: afterExternal.projectFingerprint,
          expectedProjectFileSha256: afterExternal.projectFileSha256,
          key: "display/window/size/viewport_height",
          value: 540,
        })).rejects.toMatchObject({ payload: { code: "EDITOR_PROJECT_SETTINGS_STALE" } });
      } finally {
        if (previousDelay === undefined) {
          delete process.env.GODOT_AGENT_RUNTIME_TEST_PROJECT_SETTING_DELAY_MS;
        } else {
          process.env.GODOT_AGENT_RUNTIME_TEST_PROJECT_SETTING_DELAY_MS = previousDelay;
        }
        if (runId !== null) await stopManagedRun({ projectPath, runId, timeoutMs: 15_000 });
        await rm(projectPath, { recursive: true, force: true });
      }
    },
    90_000,
  );

  it(
    "applies typed batches as one action with logical-path validation and honest persistence state",
    async () => {
      const projectPath = await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-editor-batch-"));
      await cp(resolve("examples", "control-ui"), projectPath, {
        recursive: true,
        filter: (source) => !source.includes(`${resolve("examples", "control-ui", ".godot")}`),
      });
      const mainPath = resolve(projectPath, "main.tscn");
      const diskBefore = await readFile(mainPath, "utf8");
      let editorRunId: string | null = null;
      let releaseSaveBlock: (() => Promise<void>) | null = null;
      try {
        await installGodotAddon(projectPath);
        const identity = await getProjectIdentity(projectPath);
        const launch = await launchEditor({ projectPath, configPath, timeoutMs: 30_000 });
        editorRunId = launch.runId;
        const guard = {
          projectPath,
          runId: editorRunId,
          expectedProjectFingerprint: identity.projectFingerprint,
          expectedScenePath: "res://main.tscn",
        } as const;

        expect(await getEditorInfo({ projectPath, runId: editorRunId })).toMatchObject({
          protocolVersion: "0.7.0",
          capabilities: expect.arrayContaining(["scene_batch"]),
        });

        const built = await batchEditorScene({
          ...guard,
          actionName: "Build agent panel",
          operations: [
            { op: "node_create", parentPath: "/root/Main", type: "Panel", name: "BatchPanel", properties: {} },
            { op: "node_create", parentPath: "/root/Main/BatchPanel", type: "Button", name: "BatchButton", properties: { text: "Batch" } },
            { op: "signal_connect", sourcePath: "/root/Main/BatchPanel/BatchButton", signal: "pressed", targetPath: "/root/Main", method: "_on_start_pressed" },
          ],
          confirmDestructive: false,
        });
        expect(built).toMatchObject({
          scenePath: "res://main.tscn",
          actionName: "Agent batch: Build agent panel",
          operationCount: 3,
          undoable: true,
          dirty: true,
          historyVersion: expect.any(Number),
        });
        expect(built.results).toHaveLength(3);
        expect(built).not.toHaveProperty("saved");
        expect((await getEditorNode({
          projectPath,
          runId: editorRunId,
          nodePath: "/root/Main/BatchPanel/BatchButton",
          properties: ["text"],
        })).node.properties.text).toBe("Batch");

        const undone = await undoEditorAction({
          ...guard,
          expectedHistoryVersion: built.historyVersion,
          expectedActionName: built.actionName,
        });
        expect(undone.actionName).toBe("Agent batch: Build agent panel");
        await expect(getEditorNode({
          projectPath,
          runId: editorRunId,
          nodePath: "/root/Main/BatchPanel",
        })).rejects.toMatchObject({ payload: { code: "EDITOR_NODE_NOT_FOUND" } });
        const redone = await redoEditorAction({
          ...guard,
          expectedHistoryVersion: undone.afterVersion,
          expectedActionName: built.actionName,
        });
        expect((await getEditorNode({
          projectPath,
          runId: editorRunId,
          nodePath: "/root/Main/BatchPanel/BatchButton",
        })).node.name).toBe("BatchButton");

        const initialButton = await getEditorNode({
          projectPath,
          runId: editorRunId,
          nodePath: "/root/Main/StartButton",
          properties: ["text"],
        });
        const sequentialUpdates = await batchEditorScene({
          ...guard,
          actionName: "Sequential updates",
          operations: [
            { op: "node_update", nodePath: "/root/Main/StartButton", properties: { text: "Review A" } },
            { op: "node_update", nodePath: "/root/Main/StartButton", properties: { text: "Review B" } },
          ],
          confirmDestructive: false,
        });
        expect((await getEditorNode({
          projectPath,
          runId: editorRunId,
          nodePath: "/root/Main/StartButton",
          properties: ["text"],
        })).node.properties.text).toBe("Review B");
        const sequentialUndone = await undoEditorAction({
          ...guard,
          expectedHistoryVersion: sequentialUpdates.historyVersion,
          expectedActionName: sequentialUpdates.actionName,
        });
        expect((await getEditorNode({
          projectPath,
          runId: editorRunId,
          nodePath: "/root/Main/StartButton",
          properties: ["text"],
        })).node.properties.text).toBe(initialButton.node.properties.text);
        await redoEditorAction({
          ...guard,
          expectedHistoryVersion: sequentialUndone.afterVersion,
          expectedActionName: sequentialUpdates.actionName,
        });
        expect((await getEditorNode({
          projectPath,
          runId: editorRunId,
          nodePath: "/root/Main/StartButton",
          properties: ["text"],
        })).node.properties.text).toBe("Review B");

        await createEditorNode({
          ...guard,
          parentPath: "/root/Main",
          type: "Node2D",
          name: "TransformSource",
          properties: { position: { $type: "Vector2", x: 100, y: 50 } },
        });
        await createEditorNode({
          ...guard,
          parentPath: "/root/Main",
          type: "Node2D",
          name: "TransformTarget",
          properties: { position: { $type: "Vector2", x: -20, y: 40 } },
        });
        await createEditorNode({
          ...guard,
          parentPath: "/root/Main/TransformSource",
          type: "Node2D",
          name: "TransformChild",
          properties: { position: { $type: "Vector2", x: 10, y: 5 } },
        });
        const transformProperties = ["position", "global_position", "transform", "global_transform"] as const;
        const initialTransform = await getEditorNode({
          projectPath,
          runId: editorRunId,
          nodePath: "/root/Main/TransformSource/TransformChild",
          properties: transformProperties,
        });
        const transformMove = await batchEditorScene({
          ...guard,
          actionName: "Transform then move",
          operations: [
            {
              op: "node_update",
              nodePath: "/root/Main/TransformSource/TransformChild",
              properties: { position: { $type: "Vector2", x: 30, y: 15 } },
            },
            {
              op: "node_move",
              nodePath: "/root/Main/TransformSource/TransformChild",
              newParentPath: "/root/Main/TransformTarget",
              keepGlobalTransform: true,
            },
          ],
          confirmDestructive: false,
        });
        const movedTransform = await getEditorNode({
          projectPath,
          runId: editorRunId,
          nodePath: "/root/Main/TransformTarget/TransformChild",
          properties: transformProperties,
        });
        const transformUndone = await undoEditorAction({
          ...guard,
          expectedHistoryVersion: transformMove.historyVersion,
          expectedActionName: transformMove.actionName,
        });
        expect((await getEditorNode({
          projectPath,
          runId: editorRunId,
          nodePath: "/root/Main/TransformSource/TransformChild",
          properties: transformProperties,
        })).node.properties).toEqual(initialTransform.node.properties);
        await redoEditorAction({
          ...guard,
          expectedHistoryVersion: transformUndone.afterVersion,
          expectedActionName: transformMove.actionName,
        });
        expect((await getEditorNode({
          projectPath,
          runId: editorRunId,
          nodePath: "/root/Main/TransformTarget/TransformChild",
          properties: transformProperties,
        })).node.properties).toEqual(movedTransform.node.properties);

        await batchEditorScene({
          ...guard,
          actionName: "Create ordered siblings",
          operations: [
            { op: "node_create", parentPath: "/root/Main", type: "Node", name: "OrderParent", properties: {} },
            { op: "node_create", parentPath: "/root/Main/OrderParent", type: "Node", name: "OrderA", properties: {} },
            { op: "node_create", parentPath: "/root/Main/OrderParent", type: "Node", name: "OrderB", properties: {} },
            { op: "node_create", parentPath: "/root/Main/OrderParent", type: "Node", name: "OrderC", properties: {} },
            { op: "node_create", parentPath: "/root/Main/OrderParent", type: "Node", name: "OrderD", properties: {} },
          ],
          confirmDestructive: false,
        });
        const orderedChildren = async (): Promise<string[]> => {
          const tree = await getEditorSceneTree({ projectPath, runId: editorRunId! });
          const parent = tree.root?.children.find((child) => child.name === "OrderParent");
          if (parent === undefined) throw new Error("OrderParent was not found in the editor scene tree.");
          return parent.children.map((child) => child.name);
        };
        expect(await orderedChildren()).toEqual(["OrderA", "OrderB", "OrderC", "OrderD"]);
        const reordered = await batchEditorScene({
          ...guard,
          actionName: "Omitted same-parent index",
          operations: [
            { op: "node_move", nodePath: "/root/Main/OrderParent/OrderA", newParentPath: "/root/Main/OrderParent" },
            { op: "node_move", nodePath: "/root/Main/OrderParent/OrderB", newParentPath: "/root/Main/OrderParent", index: 0 },
            { op: "node_delete", nodePath: "/root/Main/OrderParent/OrderB" },
          ],
          confirmDestructive: true,
        });
        expect(await orderedChildren()).toEqual(["OrderA", "OrderC", "OrderD"]);
        const reorderedUndone = await undoEditorAction({
          ...guard,
          expectedHistoryVersion: reordered.historyVersion,
          expectedActionName: reordered.actionName,
        });
        expect(await orderedChildren()).toEqual(["OrderA", "OrderB", "OrderC", "OrderD"]);
        await redoEditorAction({
          ...guard,
          expectedHistoryVersion: reorderedUndone.afterVersion,
          expectedActionName: reordered.actionName,
        });
        expect(await orderedChildren()).toEqual(["OrderA", "OrderC", "OrderD"]);

        const beforeInvalid = (await getEditorInfo({ projectPath, runId: editorRunId })).historyVersion!;
        await expect(batchEditorScene({
          ...guard,
          actionName: "Must stay atomic",
          operations: [
            { op: "node_create", parentPath: "/root/Main", type: "Node", name: "InvalidParent", properties: {} },
            { op: "node_create", parentPath: "/root/Main/InvalidParent", type: "Label", name: "InvalidChild", properties: {} },
            { op: "node_update", nodePath: "/root/Main/DoesNotExist", properties: { name: "never" } },
          ],
          confirmDestructive: false,
        })).rejects.toMatchObject({
          payload: {
            code: "EDITOR_BATCH_VALIDATION_FAILED",
            details: { index: 2, op: "node_update", path: "/root/Main/DoesNotExist" },
          },
        });
        await expect(getEditorNode({
          projectPath,
          runId: editorRunId,
          nodePath: "/root/Main/InvalidParent",
        })).rejects.toMatchObject({ payload: { code: "EDITOR_NODE_NOT_FOUND" } });
        expect((await getEditorInfo({ projectPath, runId: editorRunId })).historyVersion)
          .toBe(beforeInvalid);

        const logical = await batchEditorScene({
          ...guard,
          actionName: "Logical paths",
          operations: [
            { op: "node_create", parentPath: "/root/Main", type: "Node", name: "Flow", properties: {} },
            { op: "node_create", parentPath: "/root/Main/Flow", type: "Label", name: "Child", properties: { text: "Before" } },
            { op: "node_update", nodePath: "/root/Main/Flow", name: "Renamed", properties: {} },
            { op: "node_update", nodePath: "/root/Main/Renamed/Child", properties: { text: "After" } },
            { op: "node_create", parentPath: "/root/Main", type: "Node", name: "Destination", properties: {} },
            { op: "node_move", nodePath: "/root/Main/Renamed/Child", newParentPath: "/root/Main/Destination" },
            { op: "node_update", nodePath: "/root/Main/Destination/Child", name: "MovedChild", properties: {} },
            { op: "scene_instantiate", parentPath: "/root/Main", scenePath: "res://badge.tscn", name: "BatchBadge", properties: {} },
            { op: "node_update", nodePath: "/root/Main/BatchBadge", properties: { text: "Batch badge" } },
            { op: "node_create", parentPath: "/root/Main", type: "Node", name: "Disposable", properties: {} },
            { op: "node_delete", nodePath: "/root/Main/Disposable" },
          ],
          confirmDestructive: true,
        });
        expect(logical.operationCount).toBe(11);
        expect((await getEditorNode({
          projectPath,
          runId: editorRunId,
          nodePath: "/root/Main/Destination/MovedChild",
          properties: ["text"],
        })).node.properties.text).toBe("After");
        expect((await getEditorNode({
          projectPath,
          runId: editorRunId,
          nodePath: "/root/Main/BatchBadge",
          properties: ["text"],
        })).node.properties.text).toBe("Batch badge");
        await expect(getEditorNode({ projectPath, runId: editorRunId, nodePath: "/root/Main/Flow" }))
          .rejects.toMatchObject({ payload: { code: "EDITOR_NODE_NOT_FOUND" } });
        await expect(getEditorNode({ projectPath, runId: editorRunId, nodePath: "/root/Main/Disposable" }))
          .rejects.toMatchObject({ payload: { code: "EDITOR_NODE_NOT_FOUND" } });

        await expect(batchEditorScene({
          ...guard,
          actionName: "Deleted path is invalid",
          operations: [
            { op: "node_create", parentPath: "/root/Main", type: "Node", name: "Ghost", properties: {} },
            { op: "node_create", parentPath: "/root/Main/Ghost", type: "Label", name: "Child", properties: {} },
            { op: "node_delete", nodePath: "/root/Main/Ghost" },
            { op: "node_update", nodePath: "/root/Main/Ghost/Child", properties: { text: "never" } },
          ],
          confirmDestructive: true,
        })).rejects.toMatchObject({
          payload: { code: "EDITOR_BATCH_VALIDATION_FAILED", details: { index: 3 } },
        });
        expect((await getEditorInfo({ projectPath, runId: editorRunId })).historyVersion)
          .toBe(logical.historyVersion);

        releaseSaveBlock = await blockSceneSave(mainPath);
        await expect(saveEditorScene({
          ...guard,
          expectedHistoryVersion: logical.historyVersion,
        })).rejects.toMatchObject({ payload: { code: "EDITOR_SCENE_SAVE_FAILED" } });
        expect((await getEditorNode({
          projectPath,
          runId: editorRunId,
          nodePath: "/root/Main/Destination/MovedChild",
        })).node.name).toBe("MovedChild");
        expect((await getEditorInfo({ projectPath, runId: editorRunId })).historyVersion)
          .toBe(logical.historyVersion);
        await releaseSaveBlock();
        releaseSaveBlock = null;
        expect(await readFile(mainPath, "utf8")).toBe(diskBefore);

        await undoEditorAction({
          ...guard,
          expectedHistoryVersion: logical.historyVersion,
          expectedActionName: logical.actionName,
        });
        await expect(getEditorNode({
          projectPath,
          runId: editorRunId,
          nodePath: "/root/Main/Destination",
        })).rejects.toMatchObject({ payload: { code: "EDITOR_NODE_NOT_FOUND" } });
        await expect(getEditorNode({
          projectPath,
          runId: editorRunId,
          nodePath: "/root/Main/BatchBadge",
        })).rejects.toMatchObject({ payload: { code: "EDITOR_NODE_NOT_FOUND" } });
      } finally {
        if (releaseSaveBlock !== null) await releaseSaveBlock();
        if (editorRunId !== null) {
          await stopManagedRun({ projectPath, runId: editorRunId, timeoutMs: 15_000 });
        }
        await rm(projectPath, { recursive: true, force: true });
      }
    },
    90_000,
  );

  it(
    "guards the active scene and native history while explicitly opening scenes",
    async () => {
      const projectPath = await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-editor-guards-"));
      await cp(resolve("examples", "control-ui"), projectPath, {
        recursive: true,
        filter: (source) => !source.includes(`${resolve("examples", "control-ui", ".godot")}`),
      });
      let editorRunId: string | null = null;
      try {
        await installGodotAddon(projectPath);
        const identity = await getProjectIdentity(projectPath);
        const launch = await launchEditor({ projectPath, configPath, timeoutMs: 30_000 });
        editorRunId = launch.runId;

        const initial = await getEditorInfo({ projectPath, runId: editorRunId });
        expect(initial).toMatchObject({
          protocolVersion: "0.7.0",
          scene: "res://main.tscn",
          historyVersion: expect.any(Number),
        });
        expect(initial.historyVersion).toBeGreaterThanOrEqual(0);

        await expect(createEditorNode({
          projectPath,
          runId: editorRunId,
          expectedProjectFingerprint: identity.projectFingerprint,
          expectedScenePath: "res://not-open.tscn",
          parentPath: "/root/Main",
          type: "Label",
          name: "WrongSceneProbe",
          properties: {},
        })).rejects.toMatchObject({ payload: { code: "EDITOR_SCENE_MISMATCH" } });
        await expect(createEditorNode({
          projectPath,
          runId: editorRunId,
          parentPath: "/root/Main",
          type: "Label",
          name: "MissingGuardProbe",
          properties: {},
        } as Parameters<typeof createEditorNode>[0])).rejects.toMatchObject({
          payload: {
            code: "EDITOR_SCENE_PATH_REQUIRED",
            recovery: expect.arrayContaining([expect.any(String)]),
          },
        });
        await expect(createEditorNode({
          projectPath,
          runId: editorRunId,
          expectedProjectFingerprint: "0".repeat(64),
          expectedScenePath: "res://main.tscn",
          parentPath: "/root/Main",
          type: "Label",
          name: "WrongProjectProbe",
          properties: {},
        })).rejects.toMatchObject({ payload: { code: "PROJECT_IDENTITY_MISMATCH" } });
        await expect(getEditorNode({
          projectPath,
          runId: editorRunId,
          nodePath: "/root/Main/WrongSceneProbe",
        })).rejects.toMatchObject({ payload: { code: "EDITOR_NODE_NOT_FOUND" } });

        const mainAction = await createEditorNode({
          projectPath,
          runId: editorRunId,
          expectedProjectFingerprint: identity.projectFingerprint,
          expectedScenePath: "res://main.tscn",
          parentPath: "/root/Main",
          type: "Label",
          name: "MainHistoryProbe",
          properties: { text: "main history" },
        });
        expect(mainAction.historyVersion).toBeGreaterThan(initial.historyVersion!);
        expect((await getEditorInfo({ projectPath, runId: editorRunId })).historyVersion)
          .toBe(mainAction.historyVersion);

        const mainBefore = await readFile(resolve(projectPath, "main.tscn"), "utf8");
        const badgeBefore = await readFile(resolve(projectPath, "badge.tscn"), "utf8");
        const opened = await openEditorScene({
          projectPath,
          runId: editorRunId,
          expectedProjectFingerprint: identity.projectFingerprint,
          scenePath: "res://badge.tscn",
        });
        expect(opened).toMatchObject({
          opened: true,
          previousScene: "res://main.tscn",
          scene: "res://badge.tscn",
          historyVersion: expect.any(Number),
        });
        expect((await getEditorNode({
          projectPath,
          runId: editorRunId,
          nodePath: "/root/Badge",
          properties: ["text"],
        })).node.properties.text).toBe("Agent Badge");

        const staleMainGuard = {
          projectPath,
          runId: editorRunId,
          expectedProjectFingerprint: identity.projectFingerprint,
          expectedScenePath: "res://main.tscn",
          expectedHistoryVersion: mainAction.historyVersion,
        };
        await expect(saveEditorScene(staleMainGuard)).rejects.toMatchObject({
          payload: { code: "EDITOR_SCENE_MISMATCH" },
        });
        await expect(undoEditorAction(staleMainGuard)).rejects.toMatchObject({
          payload: { code: "EDITOR_SCENE_MISMATCH" },
        });
        await expect(redoEditorAction(staleMainGuard)).rejects.toMatchObject({
          payload: { code: "EDITOR_SCENE_MISMATCH" },
        });
        expect(await readFile(resolve(projectPath, "main.tscn"), "utf8")).toBe(mainBefore);
        expect(await readFile(resolve(projectPath, "badge.tscn"), "utf8")).toBe(badgeBefore);

        const reopenedMain = await openEditorScene({
          projectPath,
          runId: editorRunId,
          expectedProjectFingerprint: identity.projectFingerprint,
          scenePath: "res://main.tscn",
        });
        expect((await getEditorNode({
          projectPath,
          runId: editorRunId,
          nodePath: "/root/Main/MainHistoryProbe",
        })).node.name).toBe("MainHistoryProbe");
        const interveningAction = await createEditorNode({
          projectPath,
          runId: editorRunId,
          expectedProjectFingerprint: identity.projectFingerprint,
          expectedScenePath: "res://main.tscn",
          parentPath: "/root/Main",
          type: "Label",
          name: "InterveningHistoryProbe",
          properties: {},
        });
        expect(interveningAction.historyVersion).toBeGreaterThan(reopenedMain.historyVersion);
        await expect(saveEditorScene({
          projectPath,
          runId: editorRunId,
          expectedProjectFingerprint: identity.projectFingerprint,
          expectedScenePath: "res://main.tscn",
        } as Parameters<typeof saveEditorScene>[0])).rejects.toMatchObject({
          payload: {
            code: "EDITOR_HISTORY_VERSION_REQUIRED",
            recovery: expect.arrayContaining([expect.any(String)]),
          },
        });
        await expect(undoEditorAction({
          projectPath,
          runId: editorRunId,
          expectedProjectFingerprint: identity.projectFingerprint,
          expectedScenePath: "res://main.tscn",
          expectedHistoryVersion: reopenedMain.historyVersion,
        })).rejects.toMatchObject({ payload: { code: "EDITOR_HISTORY_CONFLICT" } });
        expect((await getEditorNode({
          projectPath,
          runId: editorRunId,
          nodePath: "/root/Main/InterveningHistoryProbe",
        })).node.name).toBe("InterveningHistoryProbe");
        const guardedUndo = await undoEditorAction({
          projectPath,
          runId: editorRunId,
          expectedProjectFingerprint: identity.projectFingerprint,
          expectedScenePath: "res://main.tscn",
          expectedHistoryVersion: interveningAction.historyVersion,
          expectedActionName: "Agent: create InterveningHistoryProbe",
        });
        expect(guardedUndo.historyVersion).toBe(guardedUndo.afterVersion);
        const guardedRedo = await redoEditorAction({
          projectPath,
          runId: editorRunId,
          expectedProjectFingerprint: identity.projectFingerprint,
          expectedScenePath: "res://main.tscn",
          expectedHistoryVersion: guardedUndo.historyVersion,
          expectedActionName: "Agent: create InterveningHistoryProbe",
        });
        expect(guardedRedo).toMatchObject({
          action: "redo",
          actionName: "Agent: create InterveningHistoryProbe",
          historyVersion: guardedRedo.afterVersion,
        });
      } finally {
        if (editorRunId !== null) {
          await stopManagedRun({ projectPath, runId: editorRunId, timeoutMs: 15_000 });
        }
        await rm(projectPath, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it(
    "reports a null history version when no edited scene is open",
    async () => {
      const projectPath = await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-editor-empty-"));
      await cp(resolve("examples", "control-ui"), projectPath, {
        recursive: true,
        filter: (source) => !source.includes(`${resolve("examples", "control-ui", ".godot")}`),
      });
      await writeFile(
        resolve(projectPath, "project.godot"),
        (await readFile(resolve(projectPath, "project.godot"), "utf8"))
          .replace(/run\/main_scene=.*\r?\n/, ""),
        "utf8",
      );
      let editorRunId: string | null = null;
      try {
        await installGodotAddon(projectPath);
        const launch = await launchEditor({ projectPath, configPath, timeoutMs: 30_000 });
        editorRunId = launch.runId;
        expect(await getEditorInfo({ projectPath, runId: editorRunId })).toMatchObject({
          scene: null,
          historyVersion: null,
        });
      } finally {
        if (editorRunId !== null) {
          await stopManagedRun({ projectPath, runId: editorRunId, timeoutMs: 15_000 });
        }
        await rm(projectPath, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it(
    "edits and saves through Undo/Redo, then proves the result at runtime",
    async () => {
      const projectPath = await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-editor-"));
      await cp(resolve("examples", "control-ui"), projectPath, {
        recursive: true,
        filter: (source) => !source.includes(`${resolve("examples", "control-ui", ".godot")}`),
      });
      let editorRunId: string | null = null;
      let runtimeRunId: string | null = null;
      try {
        await installGodotAddon(projectPath);
        const identity = await getProjectIdentity(projectPath);
        const launch = await launchEditor({ projectPath, configPath, timeoutMs: 30_000 });
        editorRunId = launch.runId;
        const mutationGuard = {
          expectedProjectFingerprint: identity.projectFingerprint,
          expectedScenePath: "res://main.tscn",
        } as const;
        const historyGuard = async () => {
          const historyVersion = (await getEditorInfo({ projectPath, runId: editorRunId! }))
            .historyVersion;
          if (historyVersion === null) throw new Error("Expected an active editor scene history.");
          return { ...mutationGuard, expectedHistoryVersion: historyVersion };
        };

        const info = await getEditorInfo({ projectPath, runId: editorRunId });
        expect(info.protocolVersion).toBe("0.7.0");
        expect(info.historyVersion).toEqual(expect.any(Number));
        expect(info.capabilities).toEqual([
          "scene_tree",
          "selection",
          "screenshot",
          "screenshot_receipt",
          "viewport_3d",
          "node_edit",
          "scene_instantiate",
          "scene_inheritance",
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
        ]);

        const inheritedScene = await createInheritedEditorScene({
          projectPath,
          runId: editorRunId,
          sourceScenePath: "res://main.tscn",
          targetScenePath: "res://variants/inherited_main.tscn",
          rootName: "InheritedMain",
          rootProperties: { tooltip_text: "Milestone 2 inherited scene" },
        });
        expect(inheritedScene).toMatchObject({
          created: true,
          sourceScene: "res://main.tscn",
          targetScene: "res://variants/inherited_main.tscn",
          rootName: "InheritedMain",
          overwritten: false,
          undoable: false,
        });
        expect(inheritedScene.bytes).toBeGreaterThan(0);
        await expect(createInheritedEditorScene({
          projectPath,
          runId: editorRunId,
          sourceScenePath: "res://main.tscn",
          targetScenePath: "res://variants/inherited_main.tscn",
        })).rejects.toMatchObject({ payload: { code: "EDITOR_INHERITED_SCENE_EXISTS" } });

        const tree = await getEditorSceneTree({ projectPath, runId: editorRunId });
        expect(tree.root).toMatchObject({ name: "Main", type: "Control" });
        expect(tree.root?.children.map((child) => child.name)).toContain("StartButton");

        await expect(updateEditorNode({
          projectPath,
          runId: editorRunId,
          ...mutationGuard,
          nodePath: "/root/Main/StartButton",
          properties: { icon: { $type: "Resource", path: "res://../badge.tscn" } },
        })).rejects.toMatchObject({ payload: { code: "EDITOR_RESOURCE_PATH_ESCAPE" } });
        await expect(updateEditorNode({
          projectPath,
          runId: editorRunId,
          ...mutationGuard,
          nodePath: "/root/Main/StartButton",
          properties: { icon: { $type: "Resource", path: "res://badge.tscn" } },
        })).rejects.toMatchObject({ payload: { code: "EDITOR_RESOURCE_CLASS_MISMATCH" } });

        await expect(instantiateEditorScene({
          projectPath,
          runId: editorRunId,
          ...mutationGuard,
          parentPath: "/root/Main",
          scenePath: "res://../badge.tscn",
        })).rejects.toMatchObject({ payload: { code: "EDITOR_RESOURCE_PATH_ESCAPE" } });

        const instantiated = await instantiateEditorScene({
          projectPath,
          runId: editorRunId,
          ...mutationGuard,
          parentPath: "/root/Main",
          scenePath: "res://badge.tscn",
          name: "AgentBadge",
        });
        expect(instantiated).toMatchObject({
          action: "instantiate",
          scenePath: "res://badge.tscn",
          node: { path: "/root/Main/AgentBadge", type: "Label" },
          undoable: true,
        });
        await undoEditorAction({ projectPath, runId: editorRunId, ...await historyGuard() });
        await expect(getEditorNode({
          projectPath,
          runId: editorRunId,
          nodePath: "/root/Main/AgentBadge",
        })).rejects.toMatchObject({ payload: { code: "EDITOR_NODE_NOT_FOUND" } });
        await redoEditorAction({ projectPath, runId: editorRunId, ...await historyGuard() });

        expect(await getEditorInstance({
          projectPath,
          runId: editorRunId,
          nodePath: "/root/Main/AgentBadge",
        })).toMatchObject({ scenePath: "res://badge.tscn", editable: false });
        const editableInstance = await setEditorInstanceEditable({
          projectPath,
          runId: editorRunId,
          ...mutationGuard,
          nodePath: "/root/Main/AgentBadge",
          editable: true,
        });
        expect(editableInstance).toMatchObject({
          action: "instance_set_editable",
          scenePath: "res://badge.tscn",
          previousEditable: false,
          editable: true,
          undoable: true,
        });
        await undoEditorAction({ projectPath, runId: editorRunId, ...await historyGuard() });
        expect((await getEditorInstance({
          projectPath,
          runId: editorRunId,
          nodePath: "/root/Main/AgentBadge",
        })).editable).toBe(false);
        await redoEditorAction({ projectPath, runId: editorRunId, ...await historyGuard() });

        await createEditorNode({
          projectPath,
          runId: editorRunId,
          ...mutationGuard,
          parentPath: "/root/Main",
          type: "Node2D",
          name: "TransformProbe",
          properties: {
            transform: {
              $type: "Transform2D",
              xAxis: { $type: "Vector2", x: 1, y: 0 },
              yAxis: { $type: "Vector2", x: 0, y: 1 },
              origin: { $type: "Vector2", x: 12, y: 34 },
            },
          },
        });
        const transformProbe = await getEditorNode({
          projectPath,
          runId: editorRunId,
          nodePath: "/root/Main/TransformProbe",
          properties: ["transform"],
        });
        expect(transformProbe.node.properties.transform).toMatchObject({
          $type: "Transform2D",
          origin: { $type: "Vector2", x: 12, y: 34 },
        });
        await deleteEditorNode({
          projectPath,
          runId: editorRunId,
          ...mutationGuard,
          nodePath: "/root/Main/TransformProbe",
        });

        const temporary = await createEditorNode({
          projectPath,
          runId: editorRunId,
          ...mutationGuard,
          parentPath: "/root/Main",
          type: "Label",
          name: "TemporaryLabel",
          properties: { text: "Delete me" },
        });
        expect(temporary.undoable).toBe(true);
        const deleted = await deleteEditorNode({
          projectPath,
          runId: editorRunId,
          ...mutationGuard,
          nodePath: "/root/Main/TemporaryLabel",
        });
        expect(deleted.action).toBe("delete");

        const created = await createEditorNode({
          projectPath,
          runId: editorRunId,
          ...mutationGuard,
          parentPath: "/root/Main",
          type: "Button",
          name: "AgentButton",
          properties: {
            text: "Draft",
            position: { $type: "Vector2", x: 32, y: 288 },
            size: { $type: "Vector2", x: 176, y: 48 },
          },
        });
        expect(created.node?.path).toBe("/root/Main/AgentButton");

        const updated = await updateEditorNode({
          projectPath,
          runId: editorRunId,
          ...mutationGuard,
          nodePath: "/root/Main/AgentButton",
          name: "EditorButton",
          properties: { text: "Editor Start" },
        });
        expect(updated.node?.path).toBe("/root/Main/EditorButton");
        expect(updated.changedProperties).toContain("name");

        const undone = await undoEditorAction({ projectPath, runId: editorRunId, ...await historyGuard() });
        expect(undone).toMatchObject({
          action: "undo",
          performed: true,
          actionName: "Agent: update AgentButton",
        });
        expect(undone.historyVersion).toBe(undone.afterVersion);
        const draftNode = await getEditorNode({
          projectPath,
          runId: editorRunId,
          nodePath: "/root/Main/AgentButton",
          properties: ["text"],
        });
        expect(draftNode.node.properties.text).toBe("Draft");

        const redone = await redoEditorAction({ projectPath, runId: editorRunId, ...await historyGuard() });
        expect(redone).toMatchObject({
          action: "redo",
          performed: true,
          actionName: "Agent: update AgentButton",
        });

        await createEditorNode({
          projectPath,
          runId: editorRunId,
          ...mutationGuard,
          parentPath: "/root/Main",
          type: "Panel",
          name: "AgentPanel",
          properties: {
            size: { $type: "Vector2", x: 256, y: 360 },
          },
        });
        const moved = await moveEditorNode({
          projectPath,
          runId: editorRunId,
          ...mutationGuard,
          nodePath: "/root/Main/EditorButton",
          newParentPath: "/root/Main/AgentPanel",
          index: 0,
        });
        expect(moved).toMatchObject({
          action: "move",
          previousPath: "/root/Main/EditorButton",
          parentPath: "/root/Main/AgentPanel",
          index: 0,
        });
        expect(moved.node?.path).toBe("/root/Main/AgentPanel/EditorButton");
        await undoEditorAction({ projectPath, runId: editorRunId, ...await historyGuard() });
        expect((await getEditorNode({
          projectPath,
          runId: editorRunId,
          nodePath: "/root/Main/EditorButton",
        })).node.path).toBe("/root/Main/EditorButton");
        await redoEditorAction({ projectPath, runId: editorRunId, ...await historyGuard() });

        const style = await createEditorResource({
          projectPath,
          runId: editorRunId,
          ...mutationGuard,
          nodePath: "/root/Main/AgentPanel/EditorButton",
          property: "theme_override_styles/normal",
          type: "StyleBoxFlat",
          properties: {
            bg_color: { $type: "Color", r: 0.1, g: 0.35, b: 0.8, a: 1 },
            corner_radius_top_left: 8,
            corner_radius_top_right: 8,
            corner_radius_bottom_left: 8,
            corner_radius_bottom_right: 8,
          },
        });
        expect(style).toMatchObject({
          action: "resource_create",
          resource: {
            $type: "Resource",
            class: "StyleBoxFlat",
          },
          undoable: true,
        });
        const savedColor = style.resource.properties.bg_color as Record<string, unknown>;
        expect(savedColor).toMatchObject({ $type: "Color", a: 1 });
        expect(savedColor.r).toBeCloseTo(0.1);
        expect(savedColor.g).toBeCloseTo(0.35);
        expect(savedColor.b).toBeCloseTo(0.8);

        expect(await getEditorResource({
          projectPath,
          runId: editorRunId,
          nodePath: "/root/Main/AgentPanel/EditorButton",
          property: "theme_override_styles/normal",
          properties: ["bg_color", "corner_radius_top_left"],
        })).toMatchObject({
          resource: {
            class: "StyleBoxFlat",
            properties: { corner_radius_top_left: 8 },
          },
        });
        const updatedStyle = await updateEditorResource({
          projectPath,
          runId: editorRunId,
          ...mutationGuard,
          nodePath: "/root/Main/AgentPanel/EditorButton",
          property: "theme_override_styles/normal",
          properties: {
            bg_color: { $type: "Color", r: 0.2, g: 0.45, b: 0.9, a: 1 },
          },
        });
        expect(updatedStyle).toMatchObject({
          action: "resource_update",
          changedProperties: ["bg_color"],
          resource: { properties: { bg_color: { $type: "Color", a: 1 } } },
        });

        const selection = await setEditorSelection({
          projectPath,
          runId: editorRunId,
          paths: ["/root/Main/AgentPanel/EditorButton"],
          focus: true,
        });
        expect(selection).toMatchObject({
          paths: ["/root/Main/AgentPanel/EditorButton"],
          focusedPath: "/root/Main/AgentPanel/EditorButton",
        });
        expect(await getEditorSelection({ projectPath, runId: editorRunId })).toMatchObject(selection);

        const resourceUpdateUndone = await undoEditorAction({ projectPath, runId: editorRunId, ...await historyGuard() });
        expect(resourceUpdateUndone.actionName).toBe("Agent: update StyleBoxFlat resource");
        const restoredStyle = await getEditorResource({
          projectPath,
          runId: editorRunId,
          nodePath: "/root/Main/AgentPanel/EditorButton",
          property: "theme_override_styles/normal",
          properties: ["bg_color"],
        });
        expect((restoredStyle.resource.properties.bg_color as Record<string, unknown>).r).toBeCloseTo(0.1);
        const resourceUndone = await undoEditorAction({ projectPath, runId: editorRunId, ...await historyGuard() });
        expect(resourceUndone.actionName).toBe("Agent: create StyleBoxFlat resource");
        expect((await getEditorNode({
          projectPath,
          runId: editorRunId,
          nodePath: "/root/Main/AgentPanel/EditorButton",
          properties: ["theme_override_styles/normal"],
        })).node.properties["theme_override_styles/normal"]).toBeNull();
        await redoEditorAction({ projectPath, runId: editorRunId, ...await historyGuard() });
        await redoEditorAction({ projectPath, runId: editorRunId, ...await historyGuard() });
        expect((await getEditorNode({
          projectPath,
          runId: editorRunId,
          nodePath: "/root/Main/AgentPanel/EditorButton",
          properties: ["theme_override_styles/normal"],
        })).node.properties["theme_override_styles/normal"]).toMatchObject({
          $type: "Resource",
          class: "StyleBoxFlat",
        });

        const externalStyle = await saveEditorResource({
          projectPath,
          runId: editorRunId,
          ...mutationGuard,
          nodePath: "/root/Main/AgentPanel/EditorButton",
          property: "theme_override_styles/normal",
          path: "res://agent_button_style.tres",
        });
        expect(externalStyle).toMatchObject({
          saved: true,
          path: "res://agent_button_style.tres",
          class: "StyleBoxFlat",
          overwritten: false,
          undoable: false,
        });
        expect(externalStyle.bytes).toBeGreaterThan(0);
        await expect(saveEditorResource({
          projectPath,
          runId: editorRunId,
          ...mutationGuard,
          nodePath: "/root/Main/AgentPanel/EditorButton",
          property: "theme_override_styles/normal",
          path: "res://../escaped.tres",
        })).rejects.toMatchObject({ payload: { code: "EDITOR_RESOURCE_PATH_ESCAPE" } });
        await expect(saveEditorResource({
          projectPath,
          runId: editorRunId,
          ...mutationGuard,
          nodePath: "/root/Main/AgentPanel/EditorButton",
          property: "theme_override_styles/normal",
          path: "res://agent_button_style.tres",
        })).rejects.toMatchObject({ payload: { code: "EDITOR_RESOURCE_FILE_EXISTS" } });
        expect(await focusEditorResource({
          projectPath,
          runId: editorRunId,
          path: "res://agent_button_style.tres",
        })).toMatchObject({
          selected: true,
          path: "res://agent_button_style.tres",
          class: "StyleBoxFlat",
        });
        expect((await undoEditorAction({ projectPath, runId: editorRunId, ...await historyGuard() })).actionName)
          .toBe("Agent: externalize EditorButton resource");
        expect((await getEditorNode({
          projectPath,
          runId: editorRunId,
          nodePath: "/root/Main/AgentPanel/EditorButton",
          properties: ["theme_override_styles/normal"],
        })).node.properties["theme_override_styles/normal"]).not.toMatchObject({
          path: "res://agent_button_style.tres",
        });
        expect(existsSync(resolve(projectPath, "agent_button_style.tres"))).toBe(true);
        await redoEditorAction({ projectPath, runId: editorRunId, ...await historyGuard() });
        expect((await getEditorNode({
          projectPath,
          runId: editorRunId,
          nodePath: "/root/Main/AgentPanel/EditorButton",
          properties: ["theme_override_styles/normal"],
        })).node.properties["theme_override_styles/normal"]).toMatchObject({
          path: "res://agent_button_style.tres",
        });

        const node = await getEditorNode({
          projectPath,
          runId: editorRunId,
          nodePath: "/root/Main/AgentPanel/EditorButton",
          properties: ["text", "position", "size"],
        });
        expect(node.node.properties).toMatchObject({
          text: "Editor Start",
          position: { $type: "Vector2", x: 32, y: 288 },
          size: { $type: "Vector2", x: 176, y: 48 },
        });

        const connection = await connectEditorSignal({
          projectPath,
          runId: editorRunId,
          ...mutationGuard,
          sourcePath: "/root/Main/AgentPanel/EditorButton",
          signal: "pressed",
          targetPath: "/root/Main",
          method: "_on_start_pressed",
        });
        expect(connection.undoable).toBe(true);

        const saved = await saveEditorScene({ projectPath, runId: editorRunId, ...await historyGuard() });
        expect(saved).toMatchObject({ saved: true, scene: "res://main.tscn" });
        expect(saved.historyVersion).toEqual(expect.any(Number));

        const editorScreenshot = await captureEditorScreenshot({
          projectPath,
          runId: editorRunId,
        });
        expect(editorScreenshot).toMatchObject({ viewport: "2d", viewportIndex: null, camera: null });
        expect(existsSync(editorScreenshot.path)).toBe(true);
        await stopManagedRun({ projectPath, runId: editorRunId, timeoutMs: 15_000 });
        editorRunId = null;

        const sceneSource = await readFile(resolve(projectPath, "main.tscn"), "utf8");
        expect(sceneSource).toContain('name="EditorButton"');
        expect(sceneSource).toContain("agent_button_style.tres");
        expect(sceneSource).toContain("badge.tscn");
        expect(sceneSource).toContain('parent="AgentPanel"');
        expect(sceneSource).not.toContain("TemporaryLabel");
        expect(sceneSource).toContain('signal="pressed"');
        expect(await readFile(resolve(projectPath, "agent_button_style.tres"), "utf8")).toContain("StyleBoxFlat");

        const inheritedSource = await readFile(resolve(projectPath, "variants", "inherited_main.tscn"), "utf8");
        expect(inheritedSource).toContain("main.tscn");
        expect(inheritedSource).toContain("instance=ExtResource");
        expect(inheritedSource).toContain('tooltip_text = "Milestone 2 inherited scene"');

        const runtime = await launchProject({
          projectPath,
          configPath,
          scene: "res://variants/inherited_main.tscn",
          timeoutMs: 20_000,
        });
        runtimeRunId = runtime.runId;
        expect((await findRuntimeUi({
          projectPath,
          runId: runtimeRunId,
          selector: { text: "Agent Badge", type: "Label" },
        })).count).toBe(1);
        const ui = await findRuntimeUi({
          projectPath,
          runId: runtimeRunId,
          selector: { text: "Editor Start", type: "Button" },
        });
        expect(ui.count).toBe(1);
        await injectRuntimeInput({
          projectPath,
          runId: runtimeRunId,
          kind: "click",
          path: ui.elements[0]!.path,
        });
        const assertion = await assertRuntime({
          projectPath,
          runId: runtimeRunId,
          kind: "property",
          nodePath: "/root/InheritedMain",
          property: "meta:started",
          expected: true,
        });
        expect(assertion.passed, JSON.stringify(assertion)).toBe(true);
      } finally {
        if (editorRunId !== null) {
          await stopManagedRun({ projectPath, runId: editorRunId, timeoutMs: 15_000 });
        }
        if (runtimeRunId !== null) {
          await stopManagedRun({ projectPath, runId: runtimeRunId, timeoutMs: 15_000 });
        }
        await rm(projectPath, { recursive: true });
      }
    },
    90_000,
  );

  it(
    "captures a selected 3D editor viewport and active editor camera",
    async () => {
      const projectPath = await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-editor-3d-"));
      await cp(resolve("examples", "physics-3d"), projectPath, {
        recursive: true,
        filter: (source) => !source.includes(`${resolve("examples", "physics-3d", ".godot")}`),
      });
      let runId: string | null = null;
      try {
        await installGodotAddon(projectPath);
        const launch = await launchEditor({ projectPath, configPath, timeoutMs: 30_000 });
        runId = launch.runId;
        const identity = await getProjectIdentity(projectPath);
        await expect(captureEditorScreenshot({
          projectPath,
          runId,
          expectedScenePath: "res://not-current.tscn",
          viewport: "3d",
          viewportIndex: 0,
        })).rejects.toMatchObject({ payload: { code: "EVIDENCE_SCENE_MISMATCH" } });
        const screenshot = await captureEditorScreenshot({
          projectPath,
          runId,
          expectedScenePath: "res://main.tscn",
          viewport: "3d",
          viewportIndex: 0,
        });
        expect(existsSync(screenshot.path)).toBe(true);
        expect(screenshot).toMatchObject({
          viewport: "3d",
          viewportIndex: 0,
          camera: { projection: "perspective" },
          evidence: {
            class: "editor_viewport",
            projectFingerprint: identity.projectFingerprint,
            scenePath: "res://main.tscn",
            runId,
            provesRuntime: false,
            provesInteraction: false,
            warnings: [],
          },
        });
        expect(screenshot.width).toBeGreaterThan(0);
        expect(screenshot.height).toBeGreaterThan(0);
      } finally {
        if (runId !== null) await stopManagedRun({ projectPath, runId, timeoutMs: 15_000 });
        await rm(projectPath, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it(
    "deletes an editor PNG when the edited scene changes during capture",
    async () => {
      const projectPath = await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-editor-evidence-race-"));
      await cp(resolve("examples", "physics-3d"), projectPath, {
        recursive: true,
        filter: (source) => !source.includes(`${resolve("examples", "physics-3d", ".godot")}`),
      });
      await writeFile(
        resolve(projectPath, "alternate.tscn"),
        '[gd_scene format=3]\n\n[node name="Alternate" type="Node3D"]\n',
        "utf8",
      );
      const previousSwitch = process.env.GODOT_AGENT_RUNTIME_TEST_SCREENSHOT_SWITCH_SCENE_PATH;
      process.env.GODOT_AGENT_RUNTIME_TEST_SCREENSHOT_SWITCH_SCENE_PATH = "res://alternate.tscn";
      let runId: string | null = null;
      try {
        await installGodotAddon(projectPath);
        const launch = await launchEditor({ projectPath, configPath, timeoutMs: 30_000 });
        runId = launch.runId;
        let removedPath = "";
        try {
          await captureEditorScreenshot({
            projectPath,
            runId,
            expectedScenePath: "res://main.tscn",
            viewport: "3d",
            viewportIndex: 0,
          });
          expect.fail("capture should reject an edited-scene switch during capture");
        } catch (error) {
          expect(error).toMatchObject({
            payload: {
              code: "EVIDENCE_SCENE_CHANGED_DURING_CAPTURE",
              details: { beforeScenePath: "res://main.tscn", afterScenePath: "res://alternate.tscn" },
            },
          });
          removedPath = String((error as { payload?: { details?: { path?: unknown } } }).payload?.details?.path ?? "");
        }
        expect(removedPath).not.toBe("");
        expect(existsSync(removedPath)).toBe(false);
      } finally {
        if (previousSwitch === undefined) {
          delete process.env.GODOT_AGENT_RUNTIME_TEST_SCREENSHOT_SWITCH_SCENE_PATH;
        } else {
          process.env.GODOT_AGENT_RUNTIME_TEST_SCREENSHOT_SWITCH_SCENE_PATH = previousSwitch;
        }
        if (runId !== null) await stopManagedRun({ projectPath, runId, timeoutMs: 15_000 });
        await rm(projectPath, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it(
    "closes a generated inherited scene when the editor started without an open scene",
    async () => {
      const projectPath = await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-editor-empty-"));
      await cp(resolve("tests", "fixtures", "editor-no-scene"), projectPath, { recursive: true });
      let runId: string | null = null;
      try {
        await installGodotAddon(projectPath);
        const launch = await launchEditor({ projectPath, configPath, timeoutMs: 30_000 });
        runId = launch.runId;
        expect((await getEditorSceneTree({ projectPath, runId })).root).toBeNull();

        const inherited = await createInheritedEditorScene({
          projectPath,
          runId,
          sourceScenePath: "res://base.tscn",
          targetScenePath: "res://generated.tscn",
          open: false,
        });
        expect(inherited.opened).toBe(false);
        expect((await getEditorSceneTree({ projectPath, runId })).root).toBeNull();
      } finally {
        if (runId !== null) await stopManagedRun({ projectPath, runId, timeoutMs: 15_000 });
        await rm(projectPath, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
