import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RuntimeFailure } from "../../packages/core/src/errors.js";

const mocks = vi.hoisted(() => ({
  assertProjectFingerprint: vi.fn(async () => undefined),
  markResultUnknown: vi.fn(() => new Date(Date.now() + 90_000).toISOString()),
  prepareResultUnknown: vi.fn(async () => undefined),
  sendBridgeCommand: vi.fn(),
  stopManagedRun: vi.fn(),
}));

vi.mock("../../packages/core/src/project.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../packages/core/src/project.js")>(),
  assertProjectFingerprint: mocks.assertProjectFingerprint,
}));

vi.mock("../../packages/core/src/managed-run.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../packages/core/src/managed-run.js")>(),
  stopManagedRun: mocks.stopManagedRun,
}));

vi.mock("../../packages/core/src/runtime.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../packages/core/src/runtime.js")>(),
  sendBridgeCommand: mocks.sendBridgeCommand,
}));

vi.mock("../../packages/core/src/safe-file.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../packages/core/src/safe-file.js")>(),
  withProjectMutationLock: vi.fn(async (
    _options: unknown,
    operation: (lease: {
      prepareResultUnknown: () => Promise<void>;
      markResultUnknown: () => string;
    }) => Promise<unknown>,
  ) => await operation({
    prepareResultUnknown: mocks.prepareResultUnknown,
    markResultUnknown: mocks.markResultUnknown,
  })),
}));

import { setEditorProjectSetting } from "../../packages/core/src/editor.js";

const expectedProjectFingerprint = "1".repeat(64);
const expectedProjectFileSha256 = "2".repeat(64);
const editorCapabilities = [
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
];

const mutationResult = {
  operationId: "00000000-0000-4000-8000-000000000011",
  key: "display/window/size/viewport_width",
  changed: true,
  previousValue: 640,
  value: 800,
  beforeSha256: expectedProjectFileSha256,
  afterSha256: "3".repeat(64),
  undoable: false,
};

function editorHello() {
  return {
    protocolVersion: "0.7.0",
    engineVersion: "4.x-test",
    scene: "res://main.tscn",
    historyVersion: 1,
    capabilities: editorCapabilities,
  };
}

function settingOptions() {
  return {
    projectPath: "E:/fixture/project",
    runId: "00000000-0000-4000-8000-000000000012",
    expectedProjectFingerprint,
    expectedProjectFileSha256,
    key: "display/window/size/viewport_width",
    value: 800,
  };
}

describe("editor project-setting timeout reconciliation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a reconciliation window after the default 30 second command timeout", async () => {
    mocks.sendBridgeCommand.mockImplementation(async (_options, command: string) => {
      if (command === "hello") return editorHello();
      if (command === "project_setting_set") {
        vi.setSystemTime(30_000);
        throw new RuntimeFailure({
          code: "RUNTIME_BRIDGE_TIMEOUT",
          stage: "run",
          message: "timed out after the request was sent",
          details: { requestSent: true },
          recovery: [],
        });
      }
      if (command === "project_setting_operation_status") {
        return { state: "succeeded", result: mutationResult, error: null };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    mocks.stopManagedRun.mockRejectedValue(new Error("the managed editor must not be stopped"));

    await expect(setEditorProjectSetting(settingOptions())).resolves.toMatchObject(mutationResult);
    expect(mocks.sendBridgeCommand).toHaveBeenCalledWith(
      expect.any(Object),
      "project_setting_operation_status",
      expect.any(Object),
    );
    expect(mocks.stopManagedRun).not.toHaveBeenCalled();
  });

  it("does not reconcile or stop the editor when a connection failed before sending the request", async () => {
    const unsent = new RuntimeFailure({
      code: "RUNTIME_BRIDGE_CONNECTION_FAILED",
      stage: "run",
      message: "connection refused before send",
      details: { requestSent: false },
      recovery: [],
    });
    mocks.sendBridgeCommand.mockImplementation(async (_options, command: string) => {
      if (command === "hello") return editorHello();
      if (command === "project_setting_set") throw unsent;
      throw new RuntimeFailure({
        code: "STATUS_PROBE_UNEXPECTED",
        stage: "run",
        message: "status must not be queried for an unsent request",
        recovery: [],
      });
    });

    await expect(setEditorProjectSetting(settingOptions())).rejects.toMatchObject({
      payload: { code: "RUNTIME_BRIDGE_CONNECTION_FAILED", details: { requestSent: false } },
    });
    expect(mocks.sendBridgeCommand).toHaveBeenCalledTimes(2);
    expect(mocks.stopManagedRun).not.toHaveBeenCalled();
  });
});
