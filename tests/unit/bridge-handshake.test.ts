import { describe, expect, it } from "vitest";

import { RuntimeFailure } from "../../packages/core/src/errors.js";
import * as Editor from "../../packages/core/src/editor.js";
import { validateBridgeHandshake } from "../../packages/core/src/runtime.js";
import {
  EDITOR_PROTOCOL_VERSION,
  RUNTIME_PROTOCOL_VERSION,
} from "../../packages/protocol/src/index.js";

describe("bridge handshake negotiation", () => {
  it("preserves the bridge's actual supported capability subset", () => {
    const result = validateBridgeHandshake(
      { protocolVersion: "0.3.0", capabilities: ["ui"] },
      "runtime",
      RUNTIME_PROTOCOL_VERSION,
      ["ui", "input"],
    );

    expect(result).toEqual({ protocolVersion: "0.3.0", capabilities: ["ui"] });
  });

  it("rejects an incompatible protocol version with a stable error", () => {
    expect(() => validateBridgeHandshake(
      { protocolVersion: "0.4.0", capabilities: [] },
      "editor",
      EDITOR_PROTOCOL_VERSION,
      [],
    )).toThrowError(RuntimeFailure);

    try {
      validateBridgeHandshake(
        { protocolVersion: "0.4.0", capabilities: [] },
        "editor",
        EDITOR_PROTOCOL_VERSION,
        [],
      );
    } catch (error) {
      expect(error).toMatchObject({
        payload: {
          code: "EDITOR_PROTOCOL_VERSION_MISMATCH",
          stage: "protocol",
          details: { expected: "0.6.0", actual: "0.4.0" },
        },
      });
    }
  });

  it("rejects unknown capabilities for the negotiated version", () => {
    expect(() => validateBridgeHandshake(
      { protocolVersion: "0.3.0", capabilities: ["run_script"] },
      "runtime",
      RUNTIME_PROTOCOL_VERSION,
      ["ui"],
    )).toThrowError(expect.objectContaining({
      payload: expect.objectContaining({ code: "RUNTIME_PROTOCOL_CAPABILITIES_INVALID" }),
    }));
  });

  it("returns a stable error when a matching editor omits scene_batch", () => {
    const assertEditorCapability = (Editor as unknown as {
      assertEditorCapability?: (capabilities: readonly string[], capability: string) => void;
    }).assertEditorCapability;
    expect(assertEditorCapability).toBeDefined();
    if (assertEditorCapability === undefined) return;

    expect(() => assertEditorCapability(["scene_open"], "scene_batch")).toThrowError(
      expect.objectContaining({
        payload: expect.objectContaining({
          code: "EDITOR_CAPABILITY_UNAVAILABLE",
          stage: "protocol",
          details: { capability: "scene_batch", capabilities: ["scene_open"] },
        }),
      }),
    );
    expect(() => assertEditorCapability(["scene_open", "scene_batch"], "scene_batch"))
      .not.toThrow();
  });

  it("requires the project configuration capability group", () => {
    expect(() => Editor.assertEditorCapability(["scene_batch"], "project_settings"))
      .toThrowError(expect.objectContaining({
        payload: expect.objectContaining({
          code: "EDITOR_CAPABILITY_UNAVAILABLE",
          details: { capability: "project_settings", capabilities: ["scene_batch"] },
        }),
      }));
    expect(() => Editor.assertEditorCapability(
      ["project_settings", "input_map", "resource_inspect"],
      "resource_inspect",
    )).not.toThrow();
  });
});
