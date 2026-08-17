import { describe, expect, it } from "vitest";

import * as Protocol from "../../packages/protocol/src/index.js";

import {
  DoctorResultSchema,
  EDITOR_PROTOCOL_VERSION,
  EditorBridgeInfoSchema,
  PROTOCOL_VERSION,
  RUNTIME_PROTOCOL_VERSION,
  RuntimeBridgeInfoSchema,
} from "../../packages/protocol/src/index.js";

describe("bridge protocol versions", () => {
  it("evolves the editor protocol without changing runtime compatibility", () => {
    expect(EDITOR_PROTOCOL_VERSION).toBe("0.6.0");
    expect(RUNTIME_PROTOCOL_VERSION).toBe("0.3.0");
    expect(PROTOCOL_VERSION).toBe(RUNTIME_PROTOCOL_VERSION);

    expect(EditorBridgeInfoSchema.safeParse({
      ok: true,
      runId: "00000000-0000-4000-8000-000000000000",
      protocolVersion: EDITOR_PROTOCOL_VERSION,
      engineVersion: "4.4",
      scene: null,
      historyVersion: null,
      capabilities: ["scene_open", "scene_batch", "project_settings", "input_map", "resource_inspect"],
    }).success).toBe(true);
    expect(EditorBridgeInfoSchema.safeParse({
      ok: true,
      runId: "00000000-0000-4000-8000-000000000000",
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      engineVersion: "4.4",
      scene: null,
      historyVersion: null,
      capabilities: [],
    }).success).toBe(false);

    const runtime = {
      ok: true,
      runId: "00000000-0000-4000-8000-000000000000",
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      engineVersion: "4.4",
      scene: null,
      capabilities: [],
    };
    expect(RuntimeBridgeInfoSchema.safeParse(runtime).success).toBe(true);
    expect(RuntimeBridgeInfoSchema.safeParse({
      ...runtime,
      protocolVersion: EDITOR_PROTOCOL_VERSION,
    }).success).toBe(false);
  });

  it("keeps the deprecated doctor version and adds the explicit version matrix", () => {
    expect(DoctorResultSchema.safeParse({
      ok: true,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      protocolVersions: {
        editor: EDITOR_PROTOCOL_VERSION,
        runtime: RUNTIME_PROTOCOL_VERSION,
      },
      checks: [],
    }).success).toBe(true);
  });

  it("defines a strict bounded editor batch tagged union", () => {
    const operationSchema = (Protocol as unknown as {
      EditorBatchOperationSchema?: { safeParse(value: unknown): { success: boolean } };
    }).EditorBatchOperationSchema;
    const requestSchema = (Protocol as unknown as {
      EditorBatchRequestSchema?: { safeParse(value: unknown): { success: boolean } };
    }).EditorBatchRequestSchema;
    expect(operationSchema).toBeDefined();
    expect(requestSchema).toBeDefined();
    if (operationSchema === undefined || requestSchema === undefined) return;

    const create = {
      op: "node_create",
      parentPath: "/root/Main",
      type: "Panel",
      name: "BatchPanel",
      properties: {},
    };
    expect(operationSchema.safeParse(create).success).toBe(true);
    expect(operationSchema.safeParse({ ...create, unknown: true }).success).toBe(false);
    expect(operationSchema.safeParse({ op: "run_script" }).success).toBe(false);
    expect(operationSchema.safeParse({
      ...create,
      properties: Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`p${index}`, index])),
    }).success).toBe(false);

    const request = {
      expectedScenePath: "res://main.tscn",
      expectedProjectFingerprint: "a".repeat(64),
      actionName: "Build panel",
      operations: [create],
      confirmDestructive: false,
    };
    expect(requestSchema.safeParse(request).success).toBe(true);
    expect(requestSchema.safeParse({ ...request, operations: [] }).success).toBe(false);
    expect(requestSchema.safeParse({ ...request, operations: Array(33).fill(create) }).success).toBe(false);
    expect(requestSchema.safeParse({
      ...request,
      operations: [{ op: "node_delete", nodePath: "/root/Main/Old" }],
    }).success).toBe(false);
    expect(requestSchema.safeParse({
      ...request,
      operations: [{ op: "node_delete", nodePath: "/root/Main/Old" }],
      confirmDestructive: true,
    }).success).toBe(true);
    expect(requestSchema.safeParse({ ...request, save: true }).success).toBe(false);
  });

  it("defines bounded project-setting values and strict InputMap events", () => {
    const setting = (Protocol as unknown as {
      EditorProjectSettingValueSchema?: { safeParse(value: unknown): { success: boolean } };
    }).EditorProjectSettingValueSchema;
    const input = (Protocol as unknown as {
      EditorInputActionUpsertRequestSchema?: { safeParse(value: unknown): { success: boolean } };
    }).EditorInputActionUpsertRequestSchema;
    expect(setting).toBeDefined();
    expect(input).toBeDefined();
    if (setting === undefined || input === undefined) return;

    expect(setting.safeParse(true).success).toBe(true);
    expect(setting.safeParse(960).success).toBe(true);
    expect(setting.safeParse(0.5).success).toBe(true);
    expect(setting.safeParse(Number.MAX_SAFE_INTEGER + 1).success).toBe(false);
    expect(setting.safeParse("res://main.tscn").success).toBe(true);
    expect(setting.safeParse(["a", "b"]).success).toBe(true);
    expect(setting.safeParse("x".repeat(16 * 1024 + 1)).success).toBe(false);
    expect(setting.safeParse(Array(257).fill("x")).success).toBe(false);
    expect(setting.safeParse({ unsafe: true }).success).toBe(false);

    const request = {
      expectedProjectFingerprint: "a".repeat(64),
      expectedProjectFileSha256: "b".repeat(64),
      name: "agent_jump",
      deadzone: 0.5,
      replaceEvents: true,
      events: [{ type: "key", physicalKeycode: 32 }],
    };
    expect(input.safeParse(request).success).toBe(true);
    expect(input.safeParse({ ...request, name: "bad action" }).success).toBe(false);
    expect(input.safeParse({ ...request, deadzone: 2 }).success).toBe(false);
    expect(input.safeParse({ ...request, events: [] }).success).toBe(false);
    expect(input.safeParse({ ...request, events: Array(33).fill(request.events[0]) }).success).toBe(false);
    expect(input.safeParse({ ...request, events: [{ type: "key" }] }).success).toBe(false);
    expect(input.safeParse({ ...request, events: [{ type: "key", keycode: 32, physicalKeycode: 32 }] }).success).toBe(false);
    expect(input.safeParse({ ...request, events: [{ type: "key", keycode: 32, unknown: true }] }).success).toBe(false);
    expect(input.safeParse({ ...request, events: [{ type: "mouse_button", buttonIndex: 10 }] }).success).toBe(false);
    expect(input.safeParse({ ...request, events: [{ type: "joypad_button", buttonIndex: 128 }] }).success).toBe(false);
  });
});
