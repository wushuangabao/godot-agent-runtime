import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer, createConnection } from "node:net";
import { relative, resolve, sep } from "node:path";

import {
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeAssertionResult,
  type RuntimeBridgeInfo,
  type RuntimeControlResult,
  type RuntimeInputResult,
  type RuntimeInputSequenceResult,
  type RuntimeNodeResult,
  type RuntimeObservationResult,
  type RuntimeProjection3DResult,
  type RuntimeRaycast3DResult,
  type RuntimeSceneTreeResult,
  type RuntimeSimulationResult,
  type RuntimeScreenshotResult,
  type RuntimeUiResult,
  type RuntimeWaitResult,
} from "@godot-agent-runtime/protocol";

import { RuntimeFailure } from "./errors.js";
import { createRuntimeEvidenceMetadata } from "./evidence.js";
import { getManagedRunConnection, getManagedRunStatus } from "./managed-run.js";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const RUNTIME_CAPABILITIES = [
  "screenshot",
  "screenshot_receipt",
  "ui",
  "scene_tree",
  "node",
  "observe",
  "simulate",
  "spatial_3d",
  "input",
  "input_sequence",
  "assert",
  "wait",
  "control",
] as const;

type BridgeKind = "runtime" | "editor";

export function validateBridgeHandshake<const Version extends string>(
  result: Record<string, unknown>,
  kind: BridgeKind,
  expectedProtocolVersion: Version,
  allowedCapabilities: readonly string[],
): { protocolVersion: Version; capabilities: string[] } {
  const prefix = kind.toUpperCase();
  if (typeof result.protocolVersion !== "string") {
    throw new RuntimeFailure({
      code: `${prefix}_PROTOCOL_HANDSHAKE_INVALID`,
      stage: "protocol",
      message: `${kind} bridge did not report a protocol version.`,
      details: { protocolVersion: result.protocolVersion ?? null },
      recovery: ["Install a bridge version compatible with this MCP server and start a fresh managed run."],
    });
  }
  if (result.protocolVersion !== expectedProtocolVersion) {
    throw new RuntimeFailure({
      code: `${prefix}_PROTOCOL_VERSION_MISMATCH`,
      stage: "protocol",
      message: `${kind} bridge protocol version is incompatible with this MCP server.`,
      details: { expected: expectedProtocolVersion, actual: result.protocolVersion },
      recovery: ["Reinstall the Godot Agent Runtime addon so the server and bridge versions match."],
    });
  }
  if (!Array.isArray(result.capabilities) || result.capabilities.length > 100 ||
      !result.capabilities.every((capability) => typeof capability === "string")) {
    throw new RuntimeFailure({
      code: `${prefix}_PROTOCOL_HANDSHAKE_INVALID`,
      stage: "protocol",
      message: `${kind} bridge returned an invalid capability list.`,
      recovery: ["Reinstall the Godot Agent Runtime addon and start a fresh managed run."],
    });
  }
  const capabilities = result.capabilities as string[];
  const unsupported = capabilities.filter((capability) => !allowedCapabilities.includes(capability));
  if (unsupported.length > 0) {
    throw new RuntimeFailure({
      code: `${prefix}_PROTOCOL_CAPABILITIES_INVALID`,
      stage: "protocol",
      message: `${kind} bridge reported capabilities unknown to this protocol version.`,
      details: { unsupported, protocolVersion: result.protocolVersion },
      recovery: ["Use matching server and bridge versions, then start a fresh managed run."],
    });
  }
  return { protocolVersion: expectedProtocolVersion, capabilities: [...capabilities] };
}

export interface RuntimeLookupOptions {
  readonly projectPath: string;
  readonly runId: string;
  readonly timeoutMs?: number;
}

export interface RuntimeScreenshotOptions extends RuntimeLookupOptions {
  readonly expectedScenePath?: string;
}

export interface RuntimeUiSelector {
  readonly path?: string;
  readonly text?: string;
  readonly type?: string;
  readonly visibleOnly?: boolean;
}

export interface RuntimeUiFindOptions extends RuntimeLookupOptions {
  readonly selector?: RuntimeUiSelector;
  readonly limit?: number;
}

export interface RuntimeSceneTreeOptions extends RuntimeLookupOptions {
  readonly maxDepth?: number;
  readonly maxNodes?: number;
}

export interface RuntimeNodeLookupOptions extends RuntimeLookupOptions {
  readonly nodePath: string;
  readonly properties?: readonly string[];
}

export interface RuntimeObservationOptions extends RuntimeLookupOptions {
  readonly nodePaths: readonly string[];
  readonly properties?: readonly string[];
}

export interface RuntimeSimulationOptions extends RuntimeLookupOptions {
  readonly nodePath: string;
  readonly frames?: number;
  readonly properties?: readonly string[];
  readonly action?: string;
  readonly strength?: number;
}

export interface RuntimeProjection3DOptions extends RuntimeLookupOptions {
  readonly cameraPath?: string;
  readonly nodePath?: string;
  readonly worldPosition?: { readonly x: number; readonly y: number; readonly z: number };
}

export interface RuntimeRaycast3DOptions extends RuntimeLookupOptions {
  readonly cameraPath?: string;
  readonly screenPosition: { readonly x: number; readonly y: number };
  readonly maxDistance?: number;
  readonly collisionMask?: number;
  readonly collideWithBodies?: boolean;
  readonly collideWithAreas?: boolean;
}

export type RuntimeInputOptions = RuntimeLookupOptions &
  (
    | {
        readonly kind: "click";
        readonly path?: string;
        readonly x?: number;
        readonly y?: number;
        readonly button?: number;
      }
    | {
        readonly kind: "action";
        readonly action: string;
        readonly strength?: number;
        readonly holdMs?: number;
      }
    | {
        readonly kind: "key";
        readonly keycode: number;
        readonly holdMs?: number;
      }
  );

export type RuntimeInputStep =
  | {
      readonly kind: "click";
      readonly path?: string;
      readonly x?: number;
      readonly y?: number;
      readonly button?: number;
      readonly afterMs?: number;
    }
  | {
      readonly kind: "action";
      readonly action: string;
      readonly strength?: number;
      readonly holdMs?: number;
      readonly afterMs?: number;
    }
  | {
      readonly kind: "key";
      readonly keycode: number;
      readonly holdMs?: number;
      readonly afterMs?: number;
    };

export interface RuntimeInputSequenceOptions extends RuntimeLookupOptions {
  readonly steps: readonly RuntimeInputStep[];
}

export type RuntimeAssertionOptions = RuntimeLookupOptions &
  (
    | {
        readonly kind: "ui_exists";
        readonly selector: RuntimeUiSelector;
        readonly expected?: boolean;
      }
    | {
        readonly kind: "property";
        readonly nodePath: string;
        readonly property: string;
        readonly operator?: "equals" | "not_equals" | "gt" | "gte" | "lt" | "lte" | "contains";
        readonly expected: unknown;
      }
  );

export type RuntimeWaitOptions = RuntimeAssertionOptions & {
  readonly waitTimeoutMs?: number;
  readonly pollEveryFrames?: number;
};

export type RuntimeControlOptions = RuntimeLookupOptions &
  (
    | { readonly action: "pause" | "resume" }
    | { readonly action: "step" | "step_physics"; readonly frames?: number }
  );

interface BridgeEnvelope {
  readonly id: string;
  readonly ok: boolean;
  readonly result?: Record<string, unknown>;
  readonly error?: { code?: string; message?: string; details?: Record<string, unknown> };
}

export async function findLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate a loopback port."));
        return;
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

export async function sendBridgeCommand(
  options: RuntimeLookupOptions,
  command: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const connection = await getManagedRunConnection(options);
  const id = randomUUID();
  const timeoutMs = options.timeoutMs ?? 5_000;
  const request = `${JSON.stringify({ id, token: connection.token, command, params, timeoutMs })}\n`;

  const response = await new Promise<BridgeEnvelope>((resolveResponse, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: connection.runtimeBridgePort });
    let buffer = Buffer.alloc(0);
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(timeoutMs, () =>
      fail(
        new RuntimeFailure({
          code: "RUNTIME_BRIDGE_TIMEOUT",
          stage: "run",
          message: `Runtime bridge command ${command} timed out after ${timeoutMs} ms.`,
          details: { runId: options.runId, command },
          recovery: ["Query godot_run_status for runtime errors, then retry with a larger timeout."],
        }),
      ),
    );
    socket.once("error", (error) =>
      fail(
        new RuntimeFailure({
          code: "RUNTIME_BRIDGE_CONNECTION_FAILED",
          stage: "run",
          message: `Could not connect to the runtime bridge for run ${options.runId}.`,
          details: { command, cause: error.message },
          recovery: ["Confirm the run is still active and inspect its stderr with godot_run_status."],
        }),
      ),
    );
    socket.once("connect", () => socket.write(request, "utf8"));
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_RESPONSE_BYTES) {
        fail(
          new RuntimeFailure({
            code: "RUNTIME_RESPONSE_TOO_LARGE",
            stage: "protocol",
            message: "Runtime bridge response exceeded 1 MiB.",
            details: { command, bytes: buffer.length },
            recovery: ["Narrow the UI selector or lower the requested result limit."],
          }),
        );
        return;
      }
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      try {
        const parsed = JSON.parse(buffer.subarray(0, newline).toString("utf8")) as BridgeEnvelope;
        if (parsed.id !== id) throw new Error("response id mismatch");
        if (settled) return;
        settled = true;
        socket.destroy();
        resolveResponse(parsed);
      } catch (error) {
        fail(
          new RuntimeFailure({
            code: "RUNTIME_PROTOCOL_INVALID",
            stage: "protocol",
            message: "Runtime bridge returned an invalid response.",
            details: { command, cause: error instanceof Error ? error.message : String(error) },
            recovery: ["Inspect runtime logs and verify the bridge protocol version."],
          }),
        );
      }
    });
  });

  if (!response.ok || response.result === undefined) {
    throw new RuntimeFailure({
      code: response.error?.code ?? "RUNTIME_COMMAND_FAILED",
      stage: "run",
      message: response.error?.message ?? `Runtime command ${command} failed.`,
      ...(response.error?.details === undefined ? {} : { details: response.error.details }),
      recovery: ["Inspect godot_run_status diagnostics and correct the command arguments."],
    });
  }
  return response.result;
}

export async function getRuntimeInfo(options: RuntimeLookupOptions): Promise<RuntimeBridgeInfo> {
  const result = await sendBridgeCommand(options, "hello");
  const handshake = validateBridgeHandshake(
    result,
    "runtime",
    RUNTIME_PROTOCOL_VERSION,
    RUNTIME_CAPABILITIES,
  );
  return {
    ok: true,
    runId: options.runId,
    protocolVersion: handshake.protocolVersion,
    engineVersion: String(result.engineVersion ?? "unknown"),
    scene: typeof result.scene === "string" ? result.scene : null,
    capabilities: handshake.capabilities as RuntimeBridgeInfo["capabilities"],
  };
}

export async function waitForRuntimeBridge(
  options: RuntimeLookupOptions,
): Promise<RuntimeBridgeInfo> {
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await getRuntimeInfo({ ...options, timeoutMs: 750 });
    } catch (error) {
      lastError = error;
      if (error instanceof RuntimeFailure && error.payload.code.startsWith("RUNTIME_PROTOCOL_")) {
        throw error;
      }
      try {
        const status = await getManagedRunStatus(options);
        const errors = status.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
        if (errors.length > 0 || status.state === "failed") {
          throw new RuntimeFailure({
            code: "RUNTIME_BRIDGE_FAILED",
            stage: "spawn",
            message: "The Runtime Bridge reported startup errors.",
            details: {
              runId: options.runId,
              state: status.state,
              diagnostics: errors,
              stderr: status.stderr,
            },
            recovery: ["Fix the Runtime Bridge or project startup errors, then launch a fresh managed run."],
          });
        }
      } catch (statusError) {
        if (statusError instanceof RuntimeFailure && statusError.payload.code === "RUNTIME_BRIDGE_FAILED") {
          throw statusError;
        }
      }
      await new Promise((delay) => setTimeout(delay, 100));
    }
  }
  throw new RuntimeFailure({
    code: "RUNTIME_BRIDGE_START_TIMEOUT",
    stage: "spawn",
    message: `Runtime bridge for run ${options.runId} did not become ready.`,
    details: { cause: lastError instanceof Error ? lastError.message : String(lastError) },
    recovery: ["Read godot_run_status stderr and verify that the runtime entry script parses."],
  });
}

export async function findRuntimeUi(options: RuntimeUiFindOptions): Promise<RuntimeUiResult> {
  const result = await sendBridgeCommand(options, "ui_find", {
    selector: options.selector ?? {},
    limit: options.limit ?? 100,
  });
  const elements = Array.isArray(result.elements) ? result.elements : [];
  return {
    ok: true,
    runId: options.runId,
    count: Number(result.count ?? elements.length),
    truncated: Boolean(result.truncated),
    elements: elements as RuntimeUiResult["elements"],
  };
}

export async function getRuntimeSceneTree(
  options: RuntimeSceneTreeOptions,
): Promise<RuntimeSceneTreeResult> {
  const result = await sendBridgeCommand(options, "scene_tree", {
    maxDepth: options.maxDepth ?? 16,
    maxNodes: options.maxNodes ?? 2000,
  });
  return {
    ok: true,
    runId: options.runId,
    root: (result.root ?? null) as RuntimeSceneTreeResult["root"],
    truncated: Boolean(result.truncated),
  };
}

export async function getRuntimeNode(
  options: RuntimeNodeLookupOptions,
): Promise<RuntimeNodeResult> {
  const result = await sendBridgeCommand(options, "node_get", {
    nodePath: options.nodePath,
    properties: options.properties ?? [],
  });
  return {
    ok: true,
    runId: options.runId,
    node: result.node as RuntimeNodeResult["node"],
  };
}

export async function observeRuntime(
  options: RuntimeObservationOptions,
): Promise<RuntimeObservationResult> {
  const result = await sendBridgeCommand(options, "observe", {
    nodePaths: options.nodePaths,
    properties: options.properties ?? [],
  });
  const nodes = Array.isArray(result.nodes) ? result.nodes : [];
  return {
    ok: true,
    runId: options.runId,
    count: Number(result.count ?? nodes.length),
    nodes: nodes as RuntimeObservationResult["nodes"],
  };
}

export async function simulateRuntimePhysics(
  options: RuntimeSimulationOptions,
): Promise<RuntimeSimulationResult> {
  const result = await sendBridgeCommand(options, "simulate", {
    nodePath: options.nodePath,
    frames: options.frames ?? 1,
    properties: options.properties ?? ["position", "global_position", "velocity"],
    ...(options.action === undefined ? {} : { action: options.action }),
    ...(options.strength === undefined ? {} : { strength: options.strength }),
  });
  return {
    ok: true,
    runId: options.runId,
    nodePath: String(result.nodePath),
    isolated: true,
    framesRequested: Number(result.framesRequested),
    physicsFramesAdvanced: Number(result.physicsFramesAdvanced),
    pausedRestored: Boolean(result.pausedRestored),
    action: typeof result.action === "string" ? result.action : null,
    samples: (Array.isArray(result.samples) ? result.samples : []) as RuntimeSimulationResult["samples"],
  };
}

export async function projectRuntime3D(
  options: RuntimeProjection3DOptions,
): Promise<RuntimeProjection3DResult> {
  const result = await sendBridgeCommand(options, "project_3d", {
    ...(options.cameraPath === undefined ? {} : { cameraPath: options.cameraPath }),
    ...(options.nodePath === undefined ? {} : { nodePath: options.nodePath }),
    ...(options.worldPosition === undefined ? {} : { worldPosition: options.worldPosition }),
  });
  return { ok: true, runId: options.runId, ...result } as RuntimeProjection3DResult;
}

export async function raycastRuntime3D(
  options: RuntimeRaycast3DOptions,
): Promise<RuntimeRaycast3DResult> {
  const result = await sendBridgeCommand(options, "raycast_3d", {
    screenPosition: options.screenPosition,
    ...(options.cameraPath === undefined ? {} : { cameraPath: options.cameraPath }),
    ...(options.maxDistance === undefined ? {} : { maxDistance: options.maxDistance }),
    ...(options.collisionMask === undefined ? {} : { collisionMask: options.collisionMask }),
    ...(options.collideWithBodies === undefined ? {} : { collideWithBodies: options.collideWithBodies }),
    ...(options.collideWithAreas === undefined ? {} : { collideWithAreas: options.collideWithAreas }),
  });
  return { ok: true, runId: options.runId, ...result } as RuntimeRaycast3DResult;
}

export async function captureRuntimeScreenshot(
  options: RuntimeScreenshotOptions,
): Promise<RuntimeScreenshotResult> {
  const result = await sendBridgeCommand(options, "screenshot", {
    ...(options.expectedScenePath === undefined
      ? {}
      : { expectedScenePath: options.expectedScenePath }),
  });
  const path = resolve(String(result.path ?? ""));
  const evidenceRoot = resolve(
    options.projectPath,
    ".godot",
    "agent-runtime",
    "evidence",
    options.runId,
  );
  const offset = relative(evidenceRoot, path);
  if (offset === ".." || offset.startsWith(`..${sep}`) || resolve(offset) === offset) {
    throw new RuntimeFailure({
      code: "RUNTIME_EVIDENCE_PATH_INVALID",
      stage: "validation",
      message: "Runtime bridge returned a screenshot path outside its evidence directory.",
      details: { path, evidenceRoot },
      recovery: ["Stop this run and launch a fresh bridge session."],
    });
  }
  const [buffer, information, evidence] = await Promise.all([
    readFile(path),
    stat(path),
    createRuntimeEvidenceMetadata({
      projectPath: options.projectPath,
      runId: options.runId,
      receipt: {
        capturedAt: result.capturedAt,
        scenePath: result.scenePath,
      },
    }),
  ]);
  return {
    ok: true,
    runId: options.runId,
    path,
    width: Number(result.width),
    height: Number(result.height),
    bytes: information.size,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    evidence,
  };
}

export async function injectRuntimeInput(
  options: RuntimeInputOptions,
): Promise<RuntimeInputResult> {
  const { projectPath: _projectPath, runId: _runId, timeoutMs: _timeoutMs, ...params } = options;
  const result = await sendBridgeCommand(options, "input", params);
  return {
    ok: true,
    runId: options.runId,
    kind: options.kind,
    delivered: Boolean(result.delivered),
    target: typeof result.target === "string" ? result.target : null,
    position:
      typeof result.x === "number" && typeof result.y === "number"
        ? { x: result.x, y: result.y }
        : null,
  };
}

export async function injectRuntimeInputSequence(
  options: RuntimeInputSequenceOptions,
): Promise<RuntimeInputSequenceResult> {
  const result = await sendBridgeCommand(options, "input_sequence", {
    steps: options.steps,
  });
  const rawResults = Array.isArray(result.results) ? result.results : [];
  return {
    ok: true,
    runId: options.runId,
    delivered: true,
    completed: Number(result.completed),
    elapsedMs: Number(result.elapsedMs),
    results: rawResults.map((item) => {
      const value = item as Record<string, unknown>;
      return {
        kind: String(value.kind) as RuntimeInputResult["kind"],
        delivered: Boolean(value.delivered),
        target: typeof value.target === "string" ? value.target : null,
        position:
          typeof value.x === "number" && typeof value.y === "number"
            ? { x: value.x, y: value.y }
            : null,
      };
    }),
  };
}

export async function assertRuntime(
  options: RuntimeAssertionOptions,
): Promise<RuntimeAssertionResult> {
  const { projectPath: _projectPath, runId: _runId, timeoutMs: _timeoutMs, ...params } = options;
  const result = await sendBridgeCommand(options, "assert", params);
  return {
    ok: true,
    runId: options.runId,
    passed: Boolean(result.passed),
    assertion: String(result.assertion ?? options.kind),
    expected: result.expected,
    actual: result.actual,
    evidence:
      typeof result.evidence === "object" && result.evidence !== null
        ? (result.evidence as Record<string, unknown>)
        : {},
  };
}

export async function waitForRuntime(
  options: RuntimeWaitOptions,
): Promise<RuntimeWaitResult> {
  const {
    projectPath: _projectPath,
    runId: _runId,
    timeoutMs: _timeoutMs,
    waitTimeoutMs = 1_000,
    pollEveryFrames = 1,
    ...condition
  } = options;
  const result = await sendBridgeCommand(
    {
      projectPath: options.projectPath,
      runId: options.runId,
      timeoutMs: options.timeoutMs ?? Math.min(waitTimeoutMs + 2_000, 32_000),
    },
    "wait",
    { ...condition, waitTimeoutMs, pollEveryFrames },
  );
  return {
    ok: true,
    runId: options.runId,
    satisfied: Boolean(result.satisfied),
    timedOut: Boolean(result.timedOut),
    elapsedMs: Number(result.elapsedMs),
    attempts: Number(result.attempts),
    assertion: String(result.assertion ?? options.kind),
    expected: result.expected,
    actual: result.actual,
    evidence:
      typeof result.evidence === "object" && result.evidence !== null
        ? (result.evidence as Record<string, unknown>)
        : {},
  };
}

export async function controlRuntime(
  options: RuntimeControlOptions,
): Promise<RuntimeControlResult> {
  const result = await sendBridgeCommand(options, "control", {
    action: options.action,
    ...(options.action === "step" || options.action === "step_physics"
      ? { frames: options.frames ?? 1 }
      : {}),
  });
  return {
    ok: true,
    runId: options.runId,
    action: options.action,
    paused: Boolean(result.paused),
    framesRequested: Number(result.framesRequested),
    processFramesAdvanced: Number(result.processFramesAdvanced),
    physicsFramesAdvanced: Number(result.physicsFramesAdvanced),
    elapsedMs: Number(result.elapsedMs),
  };
}
