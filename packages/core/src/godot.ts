import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import type {
  GodotLaunchResult,
  GodotRunResult,
} from "@godot-agent-runtime/protocol";

import { loadDevelopmentConfig } from "./config.js";
import { getDistribution } from "./distribution.js";
import { RuntimeFailure } from "./errors.js";
import { launchManagedProcess, stopManagedRun } from "./managed-run.js";
import { inspectProject } from "./project.js";
import { runProcess } from "./process.js";
import { findLoopbackPort, waitForRuntimeBridge } from "./runtime.js";

export interface GodotOperationOptions {
  readonly projectPath: string;
  readonly configPath?: string;
  readonly godotExecutable?: string;
  readonly scene?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

const NON_FATAL_ENGINE_DIAGNOSTICS = [
  /^ERROR: Failed to read the root certificate store\.$/,
  /^ERROR: Condition "p_format_loader\.is_null\(\)" is true\.$/,
];

export function compactGodotOutput(output: string): string {
  return output
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(
      (line) =>
        line.length > 0 &&
        !/^\[\s*\d+%\s*\]/.test(line) &&
        !/^\[ DONE \]/.test(line),
    )
    .join("\n");
}

export function collectGodotDiagnostics(stdout: string, stderr: string) {
  const diagnostics: Array<{ severity: "error" | "warning"; message: string }> = [];
  const lines = `${stdout}\n${stderr}`.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(SCRIPT ERROR|ERROR:)/i.test(trimmed)) {
      diagnostics.push({
        severity: NON_FATAL_ENGINE_DIAGNOSTICS.some((pattern) => pattern.test(trimmed))
          ? "warning"
          : "error",
        message: trimmed,
      });
    } else if (/^WARNING:/i.test(trimmed)) {
      diagnostics.push({ severity: "warning", message: trimmed });
    }
  }
  return diagnostics;
}

export async function resolveGodotExecutable(options: GodotOperationOptions): Promise<string> {
  if (options.godotExecutable) return resolve(options.godotExecutable);
  const config = await loadDevelopmentConfig(options.configPath);
  return resolve(config.godot.executable);
}

export async function prepareHostEnvironment(projectPath: string): Promise<NodeJS.ProcessEnv> {
  const hostDataRoot = resolve(projectPath, ".godot", "agent-runtime-host");
  const dataRoot = resolve(hostDataRoot, "data");
  const cacheRoot = resolve(hostDataRoot, "cache");
  await Promise.all([
    mkdir(dataRoot, { recursive: true }),
    mkdir(cacheRoot, { recursive: true }),
  ]);
  return {
    ...process.env,
    APPDATA: dataRoot,
    LOCALAPPDATA: cacheRoot,
    XDG_DATA_HOME: dataRoot,
    XDG_CONFIG_HOME: dataRoot,
    XDG_CACHE_HOME: cacheRoot,
    GODOT_USER_DATA_DIR: dataRoot,
  };
}

async function executeGodot(
  mode: "check" | "run",
  options: GodotOperationOptions,
): Promise<GodotRunResult> {
  const project = await inspectProject(options.projectPath);
  const executable = await resolveGodotExecutable(options);
  const env = await prepareHostEnvironment(project.projectPath);
  const args = ["--headless", "--path", project.projectPath];

  if (mode === "check") {
    args.push("--editor", "--quit");
  } else {
    if (options.scene) args.push(options.scene);
    args.push("--quit-after", "3");
  }

  const result = await runProcess(executable, args, {
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxOutputBytes === undefined
      ? {}
      : { maxOutputBytes: options.maxOutputBytes }),
    env,
  });
  const stdout = compactGodotOutput(result.stdout);
  const stderr = compactGodotOutput(result.stderr);
  const diagnostics = collectGodotDiagnostics(stdout, stderr);
  const ok =
    !result.timedOut &&
    result.exitCode === 0 &&
    diagnostics.every((diagnostic) => diagnostic.severity !== "error");

  if (result.timedOut) {
    throw new RuntimeFailure({
      code: "GODOT_TIMEOUT",
      stage: mode === "check" ? "import" : "run",
      message: `Godot ${mode} exceeded the configured timeout.`,
      details: {
        projectPath: project.projectPath,
        timeoutMs: options.timeoutMs ?? 15_000,
        stdout: result.stdout,
        stderr: result.stderr,
      },
      recovery: [
        "Increase timeoutMs for a first import.",
        "Run the command again with a clean minimal project to isolate import stalls.",
      ],
    });
  }

  return {
    ok,
    mode,
    projectPath: project.projectPath,
    scene: options.scene ?? (mode === "run" ? project.mainScene : null),
    command: [...result.command],
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdout,
    stderr,
    truncated: result.truncated,
    diagnostics,
  };
}

export async function checkProject(
  options: GodotOperationOptions,
): Promise<GodotRunResult> {
  return await executeGodot("check", options);
}

export async function runProject(
  options: GodotOperationOptions,
): Promise<GodotRunResult> {
  return await executeGodot("run", options);
}

export async function launchProject(
  options: GodotOperationOptions,
): Promise<GodotLaunchResult> {
  const project = await inspectProject(options.projectPath);
  const executable = await resolveGodotExecutable(options);
  const env = await prepareHostEnvironment(project.projectPath);
  const scene = options.scene ?? project.mainScene;
  if (scene === null) {
    throw new RuntimeFailure({
      code: "PROJECT_MAIN_SCENE_MISSING",
      stage: "validation",
      message: "A scene is required for a runtime bridge launch.",
      details: { projectPath: project.projectPath },
      recovery: ["Set application/run/main_scene or pass an explicit scene path."],
    });
  }
  const runtimeScript = resolve(getDistribution().addonRoot, "runtime_entry.gd");
  const runtimeBridgePort = await findLoopbackPort();
  const args = ["--path", project.projectPath, "--script", runtimeScript];

  const launch = await launchManagedProcess({
    projectPath: project.projectPath,
    executable,
    args,
    env: { ...env, GODOT_AGENT_RUNTIME_SCENE: scene },
    scene,
    runtimeBridgePort,
    ...(options.timeoutMs === undefined
      ? {}
      : { startupTimeoutMs: options.timeoutMs }),
  });
  try {
    await waitForRuntimeBridge({
      projectPath: project.projectPath,
      runId: launch.runId,
      timeoutMs: options.timeoutMs ?? 10_000,
    });
    return launch;
  } catch (error) {
    let stoppedDetails: Record<string, unknown> = {};
    try {
      const stopped = await stopManagedRun({ projectPath: project.projectPath, runId: launch.runId });
      stoppedDetails = {
        runId: launch.runId,
        state: stopped.state,
        stdout: stopped.stdout,
        stderr: stopped.stderr,
        diagnostics: stopped.diagnostics,
      };
    } catch {
      // Preserve the bridge startup failure; run status still contains logs.
    }
    if (error instanceof RuntimeFailure) {
      throw new RuntimeFailure({
        ...error.payload,
        details: { ...error.payload.details, ...stoppedDetails },
      });
    }
    throw error;
  }
}
