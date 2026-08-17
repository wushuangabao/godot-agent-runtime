import { describe, expect, it } from "vitest";

import * as Protocol from "../../packages/protocol/src/index.js";

const runId = "00000000-0000-4000-8000-000000000000";
const projectFingerprint = "a".repeat(64);

describe("screenshot evidence metadata", () => {
  it("defines strict editor and runtime evidence classes", () => {
    const schema = (Protocol as unknown as {
      EvidenceMetadataSchema?: { safeParse(value: unknown): { success: boolean } };
    }).EvidenceMetadataSchema;
    expect(schema).toBeDefined();
    if (schema === undefined) return;

    const common = {
      capturedAt: "2026-08-17T01:02:03.000Z",
      projectFingerprint,
      scenePath: "res://main.tscn",
      runId,
      provesInteraction: false,
      limitations: ["A single frame does not prove motion or input-driven behavior."],
      warnings: [],
    };
    expect(schema.safeParse({
      ...common,
      class: "editor_viewport",
      provesRuntime: false,
    }).success).toBe(true);
    expect(schema.safeParse({
      ...common,
      class: "runtime_frame",
      provesRuntime: true,
    }).success).toBe(true);
    expect(schema.safeParse({
      ...common,
      class: "editor_viewport",
      provesRuntime: true,
    }).success).toBe(false);
    expect(schema.safeParse({
      ...common,
      class: "runtime_frame",
      provesRuntime: false,
    }).success).toBe(false);
    expect(schema.safeParse({
      ...common,
      class: "runtime_frame",
      provesRuntime: true,
      provesInteraction: true,
    }).success).toBe(false);
    expect(schema.safeParse({
      ...common,
      class: "runtime_frame",
      provesRuntime: true,
      unknown: true,
    }).success).toBe(false);
  });

  it("requires additive evidence on both screenshot result schemas", () => {
    const runtimeSchema = Protocol.RuntimeScreenshotResultSchema;
    const editorSchema = Protocol.EditorScreenshotResultSchema;
    const screenshot = {
      ok: true,
      runId,
      path: "C:/game/.godot/agent-runtime/evidence/run/screenshot.png",
      width: 640,
      height: 360,
      bytes: 100,
      sha256: "b".repeat(64),
    };
    const runtimeEvidence = {
      class: "runtime_frame",
      capturedAt: "2026-08-17T01:02:03.000Z",
      projectFingerprint,
      scenePath: "res://main.tscn",
      runId,
      provesRuntime: true,
      provesInteraction: false,
      limitations: ["A single frame does not prove motion or input-driven behavior."],
      warnings: [],
    };
    const editorEvidence = {
      ...runtimeEvidence,
      class: "editor_viewport",
      provesRuntime: false,
    };

    expect(runtimeSchema.safeParse(screenshot).success).toBe(false);
    expect(runtimeSchema.safeParse({ ...screenshot, evidence: runtimeEvidence }).success).toBe(true);
    expect(editorSchema.safeParse({
      ...screenshot,
      viewport: "2d",
      viewportIndex: null,
      camera: null,
    }).success).toBe(false);
    expect(editorSchema.safeParse({
      ...screenshot,
      evidence: editorEvidence,
      viewport: "2d",
      viewportIndex: null,
      camera: null,
    }).success).toBe(true);
  });
});
