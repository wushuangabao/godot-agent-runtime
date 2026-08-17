import { describe, expect, it } from "vitest";

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
    expect(EDITOR_PROTOCOL_VERSION).toBe("0.4.0");
    expect(RUNTIME_PROTOCOL_VERSION).toBe("0.3.0");
    expect(PROTOCOL_VERSION).toBe(RUNTIME_PROTOCOL_VERSION);

    expect(EditorBridgeInfoSchema.safeParse({
      ok: true,
      runId: "00000000-0000-4000-8000-000000000000",
      protocolVersion: EDITOR_PROTOCOL_VERSION,
      engineVersion: "4.4",
      scene: null,
      historyVersion: null,
      capabilities: ["scene_open"],
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
});
