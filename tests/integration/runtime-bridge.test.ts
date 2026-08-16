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
  observeRuntime,
  projectRuntime3D,
  raycastRuntime3D,
  getRuntimeSceneTree,
  injectRuntimeInput,
  launchProject,
  simulateRuntimePhysics,
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
        expect(info.protocolVersion).toBe("0.3.0");
        expect(info.capabilities).toEqual(["screenshot", "ui", "scene_tree", "node", "observe", "simulate", "spatial_3d", "input", "input_sequence", "assert", "wait", "control"]);

        const observation = await observeRuntime({
          projectPath,
          runId: launch.runId,
          nodePaths: ["/root/Main", "/root/Main/StartButton"],
        });
        expect(observation).toMatchObject({
          count: 2,
          nodes: [
            { path: "/root/Main", metadata: { started: false } },
            { path: "/root/Main/StartButton" },
          ],
        });

        const simulation = await simulateRuntimePhysics({
          projectPath,
          runId: launch.runId,
          nodePath: "/root/Main/StartButton",
          frames: 2,
          properties: ["position"],
        });
        expect(simulation).toMatchObject({
          isolated: true,
          framesRequested: 2,
          pausedRestored: true,
          samples: [
            { frame: 0, properties: { position: { x: 240, y: 144 } } },
            { frame: 1 },
            { frame: 2 },
          ],
        });

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

  it(
    "projects, raycasts, simulates, and moves a CharacterBody3D",
    async () => {
      const projectPath = resolve("examples", "physics-3d");
      const launch = await launchProject({ projectPath, configPath, timeoutMs: 20_000 });
      try {
        const nodePath = "/root/Main/Player";
        const before = await observeRuntime({
          projectPath,
          runId: launch.runId,
          nodePaths: [nodePath],
          properties: ["meta:distance", "meta:physics_ticks"],
        });
        const startPosition = before.nodes[0]!.state.position as { x: number; y: number; z: number };

        const projected = await projectRuntime3D({
          projectPath,
          runId: launch.runId,
          nodePath,
        });
        expect(projected).toMatchObject({ nodePath, behind: false, onScreen: true });
        expect(projected.viewport).toEqual({ width: 640, height: 360 });
        await expect(projectRuntime3D({
          projectPath,
          runId: launch.runId,
          worldPosition: { x: "invalid", y: 0, z: 0 } as unknown as { x: number; y: number; z: number },
        })).rejects.toMatchObject({ payload: { code: "RUNTIME_3D_WORLD_POSITION_INVALID" } });

        const picked = await raycastRuntime3D({
          projectPath,
          runId: launch.runId,
          screenPosition: projected.screenPosition,
        });
        expect(picked).toMatchObject({
          hit: true,
          collider: { path: nodePath, type: "CharacterBody3D" },
        });
        await expect(raycastRuntime3D({
          projectPath,
          runId: launch.runId,
          screenPosition: { x: "invalid", y: 0 } as unknown as { x: number; y: number },
        })).rejects.toMatchObject({ payload: { code: "RUNTIME_3D_SCREEN_POSITION_INVALID" } });

        const simulation = await simulateRuntimePhysics({
          projectPath,
          runId: launch.runId,
          nodePath,
          frames: 12,
          properties: ["position", "velocity", "is_on_floor", "meta:distance"],
          action: "ui_right",
        });
        const simulatedEnd = simulation.samples.at(-1)!.properties.position as { x: number };
        expect(simulatedEnd.x).toBeGreaterThan(startPosition.x);
        expect(simulation.samples.at(-1)!.properties.is_on_floor).toBe(true);
        expect(Math.abs((simulation.samples.at(-1)!.properties.position as { y: number }).y - 0.5)).toBeLessThan(0.01);

        const unchanged = await observeRuntime({
          projectPath,
          runId: launch.runId,
          nodePaths: [nodePath],
        });
        expect((unchanged.nodes[0]!.state.position as { x: number }).x).toBeCloseTo(startPosition.x, 4);

        await injectRuntimeInputSequence({
          projectPath,
          runId: launch.runId,
          steps: [{ kind: "action", action: "ui_right", holdMs: 180 }],
        });
        const after = await observeRuntime({
          projectPath,
          runId: launch.runId,
          nodePaths: [nodePath],
          properties: ["meta:distance"],
        });
        expect((after.nodes[0]!.state.position as { x: number }).x).toBeGreaterThan(startPosition.x);
        expect(after.nodes[0]!.state.is_on_floor).toBe(true);
      } finally {
        await stopManagedRun({ projectPath, runId: launch.runId });
      }
    },
    60_000,
  );

  it(
    "samples CharacterBody2D motion in an isolated world without mutating the live scene",
    async () => {
      const projectPath = resolve("examples", "physics-2d");
      const launch = await launchProject({ projectPath, configPath, timeoutMs: 20_000 });
      try {
        const before = await observeRuntime({
          projectPath,
          runId: launch.runId,
          nodePaths: ["/root/Main/Player"],
          properties: ["meta:distance", "meta:physics_ticks"],
        });
        const beforeNode = before.nodes[0]!;
        const beforePosition = beforeNode.state.position as { x: number; y: number };

        const simulation = await simulateRuntimePhysics({
          projectPath,
          runId: launch.runId,
          nodePath: "/root/Main/Player",
          frames: 12,
          properties: ["position", "velocity", "is_on_floor", "meta:distance", "meta:physics_ticks"],
          action: "ui_right",
        });
        expect(simulation).toMatchObject({
          isolated: true,
          framesRequested: 12,
          pausedRestored: true,
          action: "ui_right",
        });
        expect(simulation.samples).toHaveLength(13);
        const simulatedEnd = simulation.samples.at(-1)!.properties.position as { x: number; y: number };
        expect(simulatedEnd.x).toBeGreaterThan(beforePosition.x);
        expect(simulation.samples.at(-1)!.properties.is_on_floor).toBe(true);
        expect(Math.abs(simulatedEnd.y - 256)).toBeLessThan(0.2);

        const afterSimulation = await observeRuntime({
          projectPath,
          runId: launch.runId,
          nodePaths: ["/root/Main/Player"],
          properties: ["meta:distance"],
        });
        const liveAfterSimulation = afterSimulation.nodes[0]!.state.position as { x: number; y: number };
        expect(liveAfterSimulation.x).toBeCloseTo(beforePosition.x, 4);

        const nestedBefore = await observeRuntime({
          projectPath,
          runId: launch.runId,
          nodePaths: ["/root/Main/NestedPhysics/Drifter"],
        });
        const nestedStartX = (nestedBefore.nodes[0]!.state.position as { x: number }).x;

        const heldInput = injectRuntimeInput({
          projectPath,
          runId: launch.runId,
          kind: "action",
          action: "ui_right",
          strength: 0.75,
          holdMs: 500,
        });
        await waitForRuntime({
          projectPath,
          runId: launch.runId,
          kind: "property",
          nodePath: "/root/Main/Player",
          property: "meta:input_strength",
          expected: 0.75,
          waitTimeoutMs: 500,
        });
        const concurrentSimulation = await simulateRuntimePhysics({
          projectPath,
          runId: launch.runId,
          nodePath: "/root/Main/Player",
          frames: 120,
          properties: ["meta:input_strength"],
          action: "ui_right",
          strength: 1,
        });
        await heldInput;
        expect(concurrentSimulation.samples.at(-1)!.properties["meta:input_strength"]).toBe(1);
        const nestedAfter = await observeRuntime({
          projectPath,
          runId: launch.runId,
          nodePaths: ["/root/Main/NestedPhysics/Drifter"],
        });
        const nestedEndX = (nestedAfter.nodes[0]!.state.position as { x: number }).x;
        // The 500 ms live input hold advances about 5 px. The following 120-frame
        // simulation must not add another ~20 px in this child Viewport's world.
        expect(nestedEndX - nestedStartX).toBeLessThan(10);
        const releasedInput = await waitForRuntime({
          projectPath,
          runId: launch.runId,
          kind: "property",
          nodePath: "/root/Main/Player",
          property: "meta:input_strength",
          expected: 0,
          waitTimeoutMs: 500,
        });
        expect(releasedInput.satisfied).toBe(true);

        const longSimulationPromise = simulateRuntimePhysics({
          projectPath,
          runId: launch.runId,
          nodePath: "/root/Main/Player",
          frames: 120,
          properties: ["meta:physics_ticks"],
        });
        await new Promise((delay) => setTimeout(delay, 100));
        const pausedAfterSimulation = await controlRuntime({
          projectPath,
          runId: launch.runId,
          action: "pause",
        });
        await longSimulationPromise;
        expect(pausedAfterSimulation.paused).toBe(true);
        const pausedBefore = await observeRuntime({
          projectPath,
          runId: launch.runId,
          nodePaths: ["/root/Main/Player"],
          properties: ["meta:physics_ticks"],
        });
        await new Promise((delay) => setTimeout(delay, 200));
        const pausedAfter = await observeRuntime({
          projectPath,
          runId: launch.runId,
          nodePaths: ["/root/Main/Player"],
          properties: ["meta:physics_ticks"],
        });
        expect(pausedAfter.nodes[0]!.state["meta:physics_ticks"]).toBe(
          pausedBefore.nodes[0]!.state["meta:physics_ticks"],
        );
        await controlRuntime({ projectPath, runId: launch.runId, action: "resume" });

        const occupyingInput = injectRuntimeInput({
          projectPath,
          runId: launch.runId,
          kind: "action",
          action: "ui_right",
          strength: 0.5,
          holdMs: 500,
        });
        await waitForRuntime({
          projectPath,
          runId: launch.runId,
          kind: "property",
          nodePath: "/root/Main/Player",
          property: "meta:input_strength",
          expected: 0.5,
          waitTimeoutMs: 500,
        });
        await expect(injectRuntimeInputSequence({
          projectPath,
          runId: launch.runId,
          timeoutMs: 100,
          steps: [{ kind: "action", action: "ui_right", strength: 1, holdMs: 1_000 }],
        })).rejects.toMatchObject({ payload: { code: "RUNTIME_BRIDGE_TIMEOUT" } });
        await occupyingInput;
        await new Promise((delay) => setTimeout(delay, 200));
        const noGhostInput = await waitForRuntime({
          projectPath,
          runId: launch.runId,
          kind: "property",
          nodePath: "/root/Main/Player",
          property: "meta:input_strength",
          expected: 0,
          waitTimeoutMs: 500,
        });
        expect(noGhostInput.satisfied).toBe(true);

        await expect(injectRuntimeInput({
          projectPath,
          runId: launch.runId,
          timeoutMs: 100,
          kind: "action",
          action: "ui_right",
          strength: 1,
          holdMs: 1_000,
        })).rejects.toMatchObject({ payload: { code: "RUNTIME_BRIDGE_TIMEOUT" } });
        await new Promise((delay) => setTimeout(delay, 200));
        const cancelledInputReleased = await waitForRuntime({
          projectPath,
          runId: launch.runId,
          kind: "property",
          nodePath: "/root/Main/Player",
          property: "meta:input_strength",
          expected: 0,
          waitTimeoutMs: 500,
        });
        expect(cancelledInputReleased.satisfied).toBe(true);

        await injectRuntimeInputSequence({
          projectPath,
          runId: launch.runId,
          steps: [{ kind: "action", action: "ui_right", holdMs: 150 }],
        });
        const afterInput = await observeRuntime({
          projectPath,
          runId: launch.runId,
          nodePaths: ["/root/Main/Player"],
          properties: ["meta:distance", "meta:physics_ticks"],
        });
        const liveAfterInput = afterInput.nodes[0]!.state.position as { x: number; y: number };
        expect(liveAfterInput.x).toBeGreaterThan(beforePosition.x);
        expect(afterInput.nodes[0]!.state.is_on_floor).toBe(true);
      } finally {
        await stopManagedRun({ projectPath, runId: launch.runId });
      }
    },
    60_000,
  );

  it(
    "returns a stable error instead of timing out for an oversized observation",
    async () => {
      const projectPath = resolve("tests", "fixtures", "response-limits");
      const launch = await launchProject({ projectPath, configPath, timeoutMs: 20_000 });
      try {
        await expect(observeRuntime({
          projectPath,
          runId: launch.runId,
          nodePaths: Array.from({ length: 9 }, (_, index) => `/root/Main/Payload${index}`),
        })).rejects.toMatchObject({ payload: { code: "RUNTIME_RESPONSE_TOO_LARGE" } });
      } finally {
        await stopManagedRun({ projectPath, runId: launch.runId });
      }
    },
    60_000,
  );
});
