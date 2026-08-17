import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  captureEditorScreenshot,
  connectEditorSignal,
  createInheritedEditorScene,
  createEditorNode,
  createEditorResource,
  deleteEditorNode,
  findRuntimeUi,
  focusEditorResource,
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
  stopManagedRun,
  updateEditorNode,
  updateEditorResource,
  undoEditorAction,
} from "../../packages/core/src/index.js";

const configPath = resolve("config", "development.local.json");
const hasLocalConfig = existsSync(configPath);

describe.skipIf(!hasLocalConfig)("EditorPlugin integration", () => {
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
          protocolVersion: "0.4.0",
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
        expect(info.protocolVersion).toBe("0.4.0");
        expect(info.historyVersion).toEqual(expect.any(Number));
        expect(info.capabilities).toEqual([
          "scene_tree",
          "selection",
          "screenshot",
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
          "undo_redo",
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
        const screenshot = await captureEditorScreenshot({
          projectPath,
          runId,
          viewport: "3d",
          viewportIndex: 0,
        });
        expect(existsSync(screenshot.path)).toBe(true);
        expect(screenshot).toMatchObject({
          viewport: "3d",
          viewportIndex: 0,
          camera: { projection: "perspective" },
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
