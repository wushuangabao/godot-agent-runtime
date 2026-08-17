import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  GodotLaunchResult,
  GodotRunStatus,
  RuntimeError,
} from "@godot-agent-runtime/protocol";

import { RuntimeFailure } from "./errors.js";

interface RunMetadata {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly token: string;
  readonly state: GodotRunStatus["state"];
  readonly projectPath: string;
  readonly scene: string | null;
  readonly processId: number | null;
  readonly supervisorProcessId: number;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly command: string[];
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly runtimeBridgePort: number | null;
  readonly failure: RuntimeError | null;
}

export interface ManagedProcessLaunchOptions {
  readonly projectPath: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly scene: string | null;
  readonly startupTimeoutMs?: number;
  readonly runtimeBridgePort?: number;
}

export interface ManagedRunLookupOptions {
  readonly projectPath: string;
  readonly runId: string;
  readonly maxOutputBytes?: number;
}

export interface ManagedRunConnection {
  readonly runId: string;
  readonly state: GodotRunStatus["state"];
  readonly token: string;
  readonly runtimeBridgePort: number;
}

export interface ManagedRunLogFiles {
  readonly projectPath: string;
  readonly runId: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}

const RUN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL_STATES = new Set<GodotRunStatus["state"]>([
  "exited",
  "stopped",
  "failed",
]);
const NON_FATAL_ENGINE_DIAGNOSTICS = [
  /^ERROR: Failed to read the root certificate store\.$/,
  /^ERROR: Condition "p_format_loader\.is_null\(\)" is true\.$/,
];

function runPaths(projectPath: string, runId: string) {
  const directory = resolve(projectPath, ".godot", "agent-runtime", "runs");
  return {
    directory,
    metadataPath: resolve(directory, `${runId}.json`),
    controlPath: resolve(directory, `${runId}.control.json`),
    jobPath: resolve(directory, `${runId}.job.json`),
    stdoutPath: resolve(directory, `${runId}.stdout.log`),
    stderrPath: resolve(directory, `${runId}.stderr.log`),
  };
}

function assertRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new RuntimeFailure({
      code: "RUN_ID_INVALID",
      stage: "validation",
      message: "runId must be a UUID returned by godot_scene_launch.",
      details: { runId },
      recovery: ["Pass the exact runId returned by godot_scene_launch."],
    });
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

function runNotFoundFailure(
  runId: string,
  projectPath: string,
  metadataPath: string,
  error: unknown,
): RuntimeFailure {
  return new RuntimeFailure({
    code: "RUN_NOT_FOUND",
    stage: "discovery",
    message: `Run ${runId} was not found for ${projectPath}.`,
    details: {
      runId,
      projectPath,
      metadataPath,
      cause: error instanceof Error ? error.message : String(error),
    },
    recovery: ["Use a runId returned for the same project by godot_scene_launch."],
  });
}

async function readMetadata(projectPath: string, runId: string): Promise<RunMetadata> {
  assertRunId(runId);
  const resolvedProjectPath = resolve(projectPath);
  const unresolvedMetadataPath = runPaths(resolvedProjectPath, runId).metadataPath;
  let canonicalProjectPath: string;
  try {
    canonicalProjectPath = await realpath(resolvedProjectPath);
  } catch (error) {
    throw runNotFoundFailure(runId, resolvedProjectPath, unresolvedMetadataPath, error);
  }
  const { metadataPath } = runPaths(canonicalProjectPath, runId);
  let metadata: RunMetadata;
  try {
    metadata = JSON.parse(await readFile(metadataPath, "utf8")) as RunMetadata;
  } catch (error) {
    throw runNotFoundFailure(runId, canonicalProjectPath, metadataPath, error);
  }

  let metadataProjectPath: string | null = null;
  try {
    metadataProjectPath = await realpath(resolve(metadata.projectPath));
  } catch {
    // Invalid or stale metadata is rejected below with the stable run error.
  }
  if (
    metadata.schemaVersion !== 1 ||
    metadata.runId !== runId ||
    metadataProjectPath !== canonicalProjectPath
  ) {
    throw new RuntimeFailure({
      code: "RUN_METADATA_INVALID",
      stage: "validation",
      message: `Run metadata for ${runId} is invalid or belongs to another project.`,
      details: { runId, projectPath: canonicalProjectPath, metadataPath },
      recovery: ["Launch a new run and use its returned projectPath and runId together."],
    });
  }

  return { ...metadata, projectPath: canonicalProjectPath };
}

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

async function readTail(
  path: string,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  try {
    const information = await stat(path);
    const length = Math.min(information.size, maxBytes);
    const buffer = Buffer.alloc(length);
    const handle = await open(path, "r");
    try {
      await handle.read(buffer, 0, length, information.size - length);
    } finally {
      await handle.close();
    }
    return { text: buffer.toString("utf8").trim(), truncated: information.size > length };
  } catch {
    return { text: "", truncated: false };
  }
}

function diagnostics(stdout: string, stderr: string): GodotRunStatus["diagnostics"] {
  const result: GodotRunStatus["diagnostics"] = [];
  for (const line of `${stdout}\n${stderr}`.split(/\r?\n/)) {
    const message = line.trim();
    if (/^(SCRIPT ERROR|ERROR:)/i.test(message)) {
      result.push({
        severity: NON_FATAL_ENGINE_DIAGNOSTICS.some((pattern) => pattern.test(message))
          ? "warning"
          : "error",
        message,
      });
    } else if (/^WARNING:/i.test(message)) {
      result.push({ severity: "warning", message });
    }
  }
  return result;
}

async function waitForMetadata(
  projectPath: string,
  runId: string,
  timeoutMs: number,
): Promise<RunMetadata> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const metadata = await readMetadata(projectPath, runId);
      if (metadata.state !== "starting") return metadata;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new RuntimeFailure({
    code: "RUN_START_TIMEOUT",
    stage: "spawn",
    message: `Run ${runId} did not report a started state within ${timeoutMs} ms.`,
    details: {
      runId,
      projectPath,
      cause: lastError instanceof Error ? lastError.message : String(lastError ?? "unknown"),
    },
    recovery: ["Read the run stderr log and run godot_doctor before retrying."],
  });
}

export async function launchManagedProcess(
  options: ManagedProcessLaunchOptions,
): Promise<GodotLaunchResult> {
  const projectPath = await realpath(resolve(options.projectPath));
  const runId = randomUUID();
  const token = randomBytes(32).toString("hex");
  const paths = runPaths(projectPath, runId);
  await mkdir(paths.directory, { recursive: true });

  await writeJsonAtomic(paths.jobPath, {
    runId,
    token,
    projectPath,
    scene: options.scene,
    executable: resolve(options.executable),
    args: [...options.args],
    cwd: projectPath,
    env: {
      ...options.env,
      ...(options.runtimeBridgePort === undefined
        ? {}
        : {
            GODOT_AGENT_RUNTIME_PORT: String(options.runtimeBridgePort),
            GODOT_AGENT_RUNTIME_TOKEN: token,
            GODOT_AGENT_RUNTIME_RUN_ID: runId,
          }),
    },
    runtimeBridgePort: options.runtimeBridgePort ?? null,
    ...paths,
  });

  const hostScript = fileURLToPath(new URL("../host/run-host.mjs", import.meta.url));
  const supervisor = spawn(process.execPath, [hostScript, paths.jobPath], {
    cwd: dirname(hostScript),
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  supervisor.unref();

  let metadata: RunMetadata;
  try {
    metadata = await waitForMetadata(
      projectPath,
      runId,
      options.startupTimeoutMs ?? 10_000,
    );
  } catch (error) {
    if (supervisor.pid !== undefined) {
      try {
        process.kill(supervisor.pid, "SIGTERM");
      } catch {
        // The supervisor may already have exited.
      }
      try {
        const temporaryMetadata = JSON.parse(
          await readFile(`${paths.metadataPath}.${supervisor.pid}.tmp`, "utf8"),
        ) as Partial<RunMetadata>;
        if (
          temporaryMetadata.runId === runId &&
          temporaryMetadata.token === token &&
          typeof temporaryMetadata.processId === "number"
        ) {
          process.kill(temporaryMetadata.processId, "SIGTERM");
        }
      } catch {
        // Cleanup is best-effort; preserve the structured startup failure.
      }
    }
    throw error;
  }
  if (metadata.state !== "running" || metadata.processId === null) {
    throw new RuntimeFailure(
      metadata.failure ?? {
        code: "RUN_START_FAILED",
        stage: "spawn",
        message: `Run ${runId} entered ${metadata.state} before it became ready.`,
        details: { runId, projectPath },
        recovery: ["Read the run stderr log and run godot_doctor before retrying."],
      },
    );
  }

  return {
    ok: true,
    runId,
    state: "running",
    projectPath,
    scene: metadata.scene,
    processId: metadata.processId,
    supervisorProcessId: metadata.supervisorProcessId,
    startedAt: metadata.startedAt,
    command: metadata.command,
    stdoutPath: metadata.stdoutPath,
    stderrPath: metadata.stderrPath,
    runtimeBridgePort: metadata.runtimeBridgePort,
  };
}

export async function getManagedRunStatus(
  options: ManagedRunLookupOptions,
): Promise<GodotRunStatus> {
  const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
  let metadata = await readMetadata(options.projectPath, options.runId);

  if (
    (metadata.state === "running" || metadata.state === "stopping") &&
    !isProcessAlive(metadata.supervisorProcessId)
  ) {
    metadata = {
      ...metadata,
      state: "failed",
      endedAt: new Date().toISOString(),
      failure: {
        code: "RUN_SUPERVISOR_EXITED",
        stage: "run",
        message: "The run supervisor exited before recording a terminal state.",
        details: { supervisorProcessId: metadata.supervisorProcessId },
        recovery: ["Read the run logs, then launch the scene again."],
      },
    };
    await writeJsonAtomic(runPaths(metadata.projectPath, metadata.runId).metadataPath, metadata);
  }

  const stdoutLimit = Math.ceil(maxOutputBytes / 2);
  const stderrLimit = Math.floor(maxOutputBytes / 2);
  const [stdout, stderr] = await Promise.all([
    readTail(metadata.stdoutPath, stdoutLimit),
    readTail(metadata.stderrPath, stderrLimit),
  ]);

  return {
    ok: metadata.state !== "failed",
    runId: metadata.runId,
    state: metadata.state,
    projectPath: metadata.projectPath,
    scene: metadata.scene,
    processId: metadata.processId,
    supervisorProcessId: metadata.supervisorProcessId,
    startedAt: metadata.startedAt,
    endedAt: metadata.endedAt,
    exitCode: metadata.exitCode,
    signal: metadata.signal,
    failure: metadata.failure,
    command: metadata.command,
    stdoutPath: metadata.stdoutPath,
    stderrPath: metadata.stderrPath,
    stdout: stdout.text,
    stderr: stderr.text,
    truncated: stdout.truncated || stderr.truncated,
    diagnostics: diagnostics(stdout.text, stderr.text),
    runtimeBridgePort: metadata.runtimeBridgePort,
  };
}

export async function getManagedRunLogFiles(
  options: ManagedRunLookupOptions,
): Promise<ManagedRunLogFiles> {
  const metadata = await readMetadata(options.projectPath, options.runId);
  return {
    projectPath: metadata.projectPath,
    runId: metadata.runId,
    stdoutPath: metadata.stdoutPath,
    stderrPath: metadata.stderrPath,
  };
}

export async function getManagedRunConnection(
  options: ManagedRunLookupOptions,
): Promise<ManagedRunConnection> {
  const metadata = await readMetadata(options.projectPath, options.runId);
  if (metadata.state !== "running" || metadata.runtimeBridgePort === null) {
    throw new RuntimeFailure({
      code: "RUNTIME_BRIDGE_UNAVAILABLE",
      stage: "run",
      message: `Run ${options.runId} does not have an active runtime bridge.`,
      details: { state: metadata.state, runtimeBridgePort: metadata.runtimeBridgePort },
      recovery: ["Launch a new scene with godot_scene_launch and wait for its runtime bridge."],
    });
  }
  return {
    runId: metadata.runId,
    state: metadata.state,
    token: metadata.token,
    runtimeBridgePort: metadata.runtimeBridgePort,
  };
}

export async function stopManagedRun(
  options: ManagedRunLookupOptions & { readonly timeoutMs?: number },
): Promise<GodotRunStatus> {
  const current = await getManagedRunStatus(options);
  if (TERMINAL_STATES.has(current.state)) return current;

  const metadata = await readMetadata(options.projectPath, options.runId);
  const { controlPath } = runPaths(metadata.projectPath, metadata.runId);
  await writeJsonAtomic(controlPath, { token: metadata.token, action: "stop" });

  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  while (Date.now() < deadline) {
    const status = await getManagedRunStatus(options);
    if (TERMINAL_STATES.has(status.state)) return status;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }

  throw new RuntimeFailure({
    code: "RUN_STOP_TIMEOUT",
    stage: "run",
    message: `Run ${options.runId} did not stop within ${options.timeoutMs ?? 10_000} ms.`,
    details: { runId: options.runId, projectPath: resolve(options.projectPath) },
    recovery: ["Query godot_run_status before retrying the idempotent stop request."],
  });
}
