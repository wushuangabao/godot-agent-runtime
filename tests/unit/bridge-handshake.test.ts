import { describe, expect, it } from "vitest";

import { RuntimeFailure } from "../../packages/core/src/errors.js";
import { validateBridgeHandshake } from "../../packages/core/src/runtime.js";

describe("bridge handshake negotiation", () => {
  it("preserves the bridge's actual supported capability subset", () => {
    const result = validateBridgeHandshake(
      { protocolVersion: "0.1.0", capabilities: ["ui"] },
      "runtime",
      ["ui", "input"],
    );

    expect(result).toEqual({ protocolVersion: "0.1.0", capabilities: ["ui"] });
  });

  it("rejects an incompatible protocol version with a stable error", () => {
    expect(() => validateBridgeHandshake(
      { protocolVersion: "0.0.9", capabilities: [] },
      "editor",
      [],
    )).toThrowError(RuntimeFailure);

    try {
      validateBridgeHandshake(
        { protocolVersion: "0.0.9", capabilities: [] },
        "editor",
        [],
      );
    } catch (error) {
      expect(error).toMatchObject({
        payload: {
          code: "EDITOR_PROTOCOL_VERSION_MISMATCH",
          stage: "protocol",
          details: { expected: "0.1.0", actual: "0.0.9" },
        },
      });
    }
  });

  it("rejects unknown capabilities for the negotiated version", () => {
    expect(() => validateBridgeHandshake(
      { protocolVersion: "0.1.0", capabilities: ["run_script"] },
      "runtime",
      ["ui"],
    )).toThrowError(expect.objectContaining({
      payload: expect.objectContaining({ code: "RUNTIME_PROTOCOL_CAPABILITIES_INVALID" }),
    }));
  });
});
