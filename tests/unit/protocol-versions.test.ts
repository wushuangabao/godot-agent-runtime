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
    expect(EDITOR_PROTOCOL_VERSION).toBe("0.5.0");
    expect(RUNTIME_PROTOCOL_VERSION).toBe("0.3.0");
    expect(PROTOCOL_VERSION).toBe(RUNTIME_PROTOCOL_VERSION);

    expect(EditorBridgeInfoSchema.safeParse({
      ok: true,
      runId: "00000000-0000-4000-8000-000000000000",
      protocolVersion: EDITOR_PROTOCOL_VERSION,
      engineVersion: "4.4",
      scene: null,
      historyVersion: null,
      capabilities: ["scene_open", "scene_batch"],
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
});
