import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertRuntime,
  captureRuntimeScreenshot,
  controlRuntime,
  findRuntimeUi,
  getRuntimeInfo,
  getRuntimeNode,
  getRuntimeSceneTree,
  launchProject,
  injectRuntimeInputSequence,
  stopManagedRun,
  waitForRuntime,
} from "../../packages/core/src/index.js";

const configPath = resolve("config", "development.local.json");
const hasLocalConfig = existsSync(configPath);

describe.skipIf(!hasLocalConfig)("runtime bridge integration", () => {
  it(
    "captures, discovers, clicks, and proves structured state",
    async () => {
      const projectPath = resolve("examples", "control-ui");
      const launch = await launchProject({ projectPath, configPath, timeoutMs: 20_000 });
      try {
        const info = await getRuntimeInfo({ projectPath, runId: launch.runId });
        expect(info.protocolVersion).toBe("0.1.0");
        expect(info.capabilities).toEqual(["screenshot", "ui", "scene_tree", "node", "input", "input_sequence", "assert", "wait", "control"]);

        const sceneTree = await getRuntimeSceneTree({
          projectPath,
          runId: launch.runId,
          maxDepth: 8,
          maxNodes: 100,
        });
        expect(sceneTree).toMatchObject({
          truncated: false,
          root: { path: "/root/Main", name: "Main", type: "Control", scenePath: "res://main.tscn" },
        });
        expect(sceneTree.root?.children.map((child) => child.name)).toContain("StatusLabel");

        const runtimeNode = await getRuntimeNode({
          projectPath,
          runId: launch.runId,
          nodePath: "/root/Main/StatusLabel",
          properties: ["text", "visible"],
        });
        expect(runtimeNode.node).toMatchObject({
          path: "/root/Main/StatusLabel",
          type: "Label",
          parentPath: "/root/Main",
          properties: { text: "Idle", visible: true },
        });
        await expect(getRuntimeNode({
          projectPath,
          runId: launch.runId,
          nodePath: "/root/Main/StatusLabel",
          properties: ["missing_agent_property"],
        })).rejects.toMatchObject({ payload: { code: "RUNTIME_PROPERTY_NOT_FOUND" } });

        const vectorAssertion = await assertRuntime({
          projectPath,
          runId: launch.runId,
          kind: "property",
          nodePath: "/root/Main/StartButton",
          property: "position",
          expected: { x: 240, y: 144 },
        });
        expect(vectorAssertion).toMatchObject({
          passed: true,
          expected: { x: 240, y: 144 },
          actual: { x: 240, y: 144 },
        });

        expect(await controlRuntime({
          projectPath,
          runId: launch.runId,
          action: "pause",
        })).toMatchObject({ action: "pause", paused: true });
        const stepped = await controlRuntime({
          projectPath,
          runId: launch.runId,
          action: "step",
          frames: 2,
        });
        expect(stepped).toMatchObject({ action: "step", paused: true, framesRequested: 2 });
        expect(stepped.processFramesAdvanced).toBeGreaterThanOrEqual(2);
        const physicsStepped = await controlRuntime({
          projectPath,
          runId: launch.runId,
          action: "step_physics",
          frames: 2,
        });
        expect(physicsStepped).toMatchObject({
          action: "step_physics",
          paused: true,
          framesRequested: 2,
        });
        expect(physicsStepped.physicsFramesAdvanced).toBeGreaterThanOrEqual(2);
        expect(await controlRuntime({
          projectPath,
          runId: launch.runId,
          action: "resume",
        })).toMatchObject({ action: "resume", paused: false });

        const ui = await findRuntimeUi({
          projectPath,
          runId: launch.runId,
          selector: { text: "Start", type: "Button" },
        });
        expect(ui.count).toBe(1);
        const button = ui.elements[0];
        expect(button?.path).toContain("StartButton");

        const before = await captureRuntimeScreenshot({ projectPath, runId: launch.runId });
        expect(existsSync(before.path)).toBe(true);
        expect(before.bytes).toBeGreaterThan(0);

        const input = await injectRuntimeInputSequence({
          projectPath,
          runId: launch.runId,
          steps: [
            { kind: "click", path: button!.path, afterMs: 20 },
            { kind: "key", keycode: 65, holdMs: 10 },
          ],
        });
        expect(input).toMatchObject({ delivered: true, completed: 2 });
        expect(input.results).toHaveLength(2);

        const waited = await waitForRuntime({
          projectPath,
          runId: launch.runId,
          kind: "property",
          nodePath: "/root/Main",
          property: "meta:started",
          expected: true,
          waitTimeoutMs: 1_000,
        });
        expect(waited).toMatchObject({ satisfied: true, timedOut: false, actual: true });

        const timedOut = await waitForRuntime({
          projectPath,
          runId: launch.runId,
          kind: "property",
          nodePath: "/root/Main/StatusLabel",
          property: "text",
          expected: "Never happens",
          waitTimeoutMs: 75,
        });
        expect(timedOut).toMatchObject({ satisfied: false, timedOut: true, actual: "Started" });
        expect(timedOut.attempts).toBeGreaterThan(1);

        const assertion = await assertRuntime({
          projectPath,
          runId: launch.runId,
          kind: "property",
          nodePath: "/root/Main",
          property: "meta:started",
          expected: true,
        });
        expect(assertion.passed, JSON.stringify(assertion)).toBe(true);

        const statusText = await assertRuntime({
          projectPath,
          runId: launch.runId,
          kind: "property",
          nodePath: "/root/Main/StatusLabel",
          property: "text",
          expected: "Started",
        });
        expect(statusText.passed, JSON.stringify(statusText)).toBe(true);
      } finally {
        const stopped = await stopManagedRun({ projectPath, runId: launch.runId });
        expect(stopped.state).toBe("stopped");
      }
    },
    60_000,
  );
});
