import type { RuntimeError } from "@godot-agent-runtime/protocol";

export class RuntimeFailure extends Error {
  readonly payload: RuntimeError;

  constructor(payload: RuntimeError) {
    super(payload.message);
    this.name = "RuntimeFailure";
    this.payload = payload;
  }
}

export function toRuntimeError(error: unknown): RuntimeError {
  if (error instanceof RuntimeFailure) {
    return error.payload;
  }

  return {
    code: "UNEXPECTED_ERROR",
    stage: "protocol",
    message: error instanceof Error ? error.message : String(error),
    recovery: ["Retry the operation with verbose diagnostics enabled."],
  };
}
