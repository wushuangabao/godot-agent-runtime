import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type {
  SetupCodexResult,
  SetupTargetResult,
} from "@godot-agent-runtime/protocol";

import {
  applyGodotAddonInstallPlan,
  planGodotAddonInstall,
  type AddonInstallPlan,
  type PlannedProjectFileWrite,
} from "./addon.js";
import {
  applyAtomicTextWrite,
  planAtomicTextWrite,
  type PlannedTextWrite,
} from "./atomic-file.js";
import {
  applyClientConfigurationPlan,
  planClientConfiguration,
  type ClientConfigurationPlan,
} from "./client-config.js";
import { RUNTIME_PACKAGE_VERSION } from "./distribution.js";
import { RuntimeFailure } from "./errors.js";
import { runProcess } from "./process.js";

export interface SetupCodexOptions {
  readonly workspacePath: string;
  readonly godotProjectPath: string;
  readonly godotExecutable: string;
}

export interface SetupCodexPorts {
  readonly nodeVersion: string;
  readonly probeGodotVersion: (executable: string) => Promise<string>;
}

export interface CodexSetupPlan {
  readonly options: SetupCodexOptions;
  readonly godotVersion: string;
  readonly localConfigWrite: PlannedTextWrite;
  readonly clientPlan: ClientConfigurationPlan;
  readonly addonPlan: AddonInstallPlan;
}

function setupFailure(
  code: string,
  message: string,
  details: Record<string, unknown>,
  recovery: string[],
): RuntimeFailure {
  return new RuntimeFailure({
    code,
    stage: "validation",
    message,
    details,
    recovery,
  });
}

export function assertSupportedNodeVersion(version: string): void {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (Number.isInteger(major) && major >= 20) return;
  throw setupFailure(
    "SETUP_NODE_VERSION_UNSUPPORTED",
    "Godot Agent Runtime setup requires Node.js 20 or newer.",
    { version, requiredMajor: 20 },
    ["Install Node.js 20 or newer, then rerun the pinned setup command."],
  );
}

async function requirePath(
  name: string,
  path: string,
  expectedType: "file" | "directory",
): Promise<string> {
  if (!isAbsolute(path)) {
    throw setupFailure(
      "SETUP_PATH_INVALID",
      `${name} must be an absolute path.`,
      { name, path, expectedType },
      ["Pass an explicit absolute path and retry."],
    );
  }
  try {
    const information = await stat(path);
    const valid = expectedType === "file"
      ? information.isFile()
      : information.isDirectory();
    if (!valid) throw new Error(`expected ${expectedType}`);
    return await realpath(path);
  } catch (error) {
    throw setupFailure(
      "SETUP_PATH_INVALID",
      `${name} is not a readable ${expectedType}.`,
      {
        name,
        path,
        expectedType,
        cause: error instanceof Error ? error.message : String(error),
      },
      ["Correct the explicit path before rerunning setup."],
    );
  }
}

export async function probeGodotVersion(executable: string): Promise<string> {
  const result = await runProcess(executable, ["--headless", "--version"], {
    timeoutMs: 10_000,
    maxOutputBytes: 8 * 1024,
  });
  const lines = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const version = lines.find((line) => /^4\./.test(line));
  if (
    result.exitCode !== 0 ||
    result.timedOut ||
    version === undefined
  ) {
    throw setupFailure(
      "SETUP_GODOT_VERSION_UNSUPPORTED",
      "The explicit Godot executable did not report a supported Godot 4.x version.",
      {
        executable,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        stdout: result.stdout,
        stderr: result.stderr,
      },
      ["Pass an original Godot 4.x editor executable and retry."],
    );
  }
  return version;
}

function defaultPorts(): SetupCodexPorts {
  return {
    nodeVersion: process.versions.node,
    probeGodotVersion,
  };
}

function assertProjectInsideWorkspace(
  workspacePath: string,
  godotProjectPath: string,
): void {
  const offset = relative(workspacePath, godotProjectPath);
  if (
    offset === ".." ||
    offset.startsWith("../") ||
    offset.startsWith("..\\") ||
    isAbsolute(offset)
  ) {
    throw setupFailure(
      "SETUP_PROJECT_OUTSIDE_WORKSPACE",
      "The Godot project must be located inside the configured workspace.",
      { workspacePath, godotProjectPath },
      ["Pass the repository root as --workspace and its Godot project as --godot-project."],
    );
  }
}

export async function createCodexSetupPlan(
  options: SetupCodexOptions,
  ports: SetupCodexPorts = defaultPorts(),
): Promise<CodexSetupPlan> {
  assertSupportedNodeVersion(ports.nodeVersion);
  const workspacePath = await requirePath(
    "workspacePath",
    options.workspacePath,
    "directory",
  );
  const godotProjectPath = await requirePath(
    "godotProjectPath",
    options.godotProjectPath,
    "directory",
  );
  assertProjectInsideWorkspace(workspacePath, godotProjectPath);
  await requirePath(
    "projectFile",
    resolve(godotProjectPath, "project.godot"),
    "file",
  );
  const godotExecutable = await requirePath(
    "godotExecutable",
    options.godotExecutable,
    "file",
  );
  const godotVersion = await ports.probeGodotVersion(godotExecutable);
  if (!/^4\./.test(godotVersion)) {
    throw setupFailure(
      "SETUP_GODOT_VERSION_UNSUPPORTED",
      "The explicit Godot executable is not Godot 4.x.",
      { godotExecutable, godotVersion },
      ["Pass an original Godot 4.x editor executable and retry."],
    );
  }

  const normalizedOptions = Object.freeze({
    workspacePath,
    godotProjectPath,
    godotExecutable,
  });
  const localConfigContent = `${JSON.stringify({
    schemaVersion: 1,
    godot: { executable: godotExecutable },
  }, null, 2)}\n`;
  const localConfigWrite = await planAtomicTextWrite(
    resolve(workspacePath, ".godot-agent-runtime", "config.local.json"),
    localConfigContent,
  );
  const clientPlan = await planClientConfiguration({
    target: "codex",
    projectPath: workspacePath,
  });
  const addonPlan = await planGodotAddonInstall(godotProjectPath);

  return Object.freeze({
    options: normalizedOptions,
    godotVersion,
    localConfigWrite,
    clientPlan,
    addonPlan,
  });
}

function projectTargetPath(
  projectPath: string,
  write: PlannedProjectFileWrite,
): string {
  return resolve(projectPath, write.resourcePath.slice("res://".length));
}

function addonTarget(
  projectPath: string,
  write: PlannedProjectFileWrite,
): SetupTargetResult {
  return {
    target: write.resourcePath === "res://project.godot"
      ? "project-plugin"
      : "addon-assets",
    path: projectTargetPath(projectPath, write),
    operation: write.operation,
  };
}

function throwWithCompletedTargets(
  error: unknown,
  completedTargets: readonly SetupTargetResult[],
): never {
  if (error instanceof RuntimeFailure) {
    throw new RuntimeFailure({
      ...error.payload,
      details: {
        ...error.payload.details,
        addonCompletedTargets: error.payload.details?.completedTargets,
        completedTargets,
      },
    });
  }
  throw new RuntimeFailure({
    code: "SETUP_APPLY_FAILED",
    stage: "configuration",
    message: "The Codex setup plan could not be fully applied.",
    details: {
      completedTargets,
      cause: error instanceof Error ? error.message : String(error),
    },
    recovery: ["Inspect the completed targets and rerun the same pinned setup command."],
  });
}

export async function applyCodexSetupPlan(
  plan: CodexSetupPlan,
): Promise<SetupCodexResult> {
  const targets: SetupTargetResult[] = [];
  try {
    const localOperation = await applyAtomicTextWrite(plan.localConfigWrite);
    targets.push({
      target: "local-config",
      path: plan.localConfigWrite.path,
      operation: localOperation,
    });

    const client = await applyClientConfigurationPlan(plan.clientPlan);
    targets.push({
      target: "codex-config",
      path: client.path,
      operation: client.operation,
    });

    try {
      await applyGodotAddonInstallPlan(plan.addonPlan);
    } catch (error) {
      if (error instanceof RuntimeFailure) {
        const completed = error.payload.details?.completedTargets;
        if (Array.isArray(completed)) {
          for (const resourcePath of completed) {
            if (typeof resourcePath !== "string") continue;
            const write = [
              ...plan.addonPlan.addonWrites,
              plan.addonPlan.projectWrite,
            ].find((candidate) => candidate.resourcePath === resourcePath);
            if (write !== undefined) {
              targets.push(addonTarget(plan.options.godotProjectPath, write));
            }
          }
        }
      }
      throw error;
    }
    for (const write of plan.addonPlan.addonWrites) {
      targets.push(addonTarget(plan.options.godotProjectPath, write));
    }
    targets.push(addonTarget(
      plan.options.godotProjectPath,
      plan.addonPlan.projectWrite,
    ));
  } catch (error) {
    throwWithCompletedTargets(error, targets);
  }

  return {
    ok: true,
    packageVersion: RUNTIME_PACKAGE_VERSION,
    workspacePath: plan.options.workspacePath,
    godotProjectPath: plan.options.godotProjectPath,
    godotExecutable: plan.options.godotExecutable,
    godotVersion: plan.godotVersion,
    targets,
    restartRequired: true,
  };
}

export async function setupCodex(
  options: SetupCodexOptions,
  ports?: SetupCodexPorts,
): Promise<SetupCodexResult> {
  return await applyCodexSetupPlan(
    await createCodexSetupPlan(options, ports),
  );
}
