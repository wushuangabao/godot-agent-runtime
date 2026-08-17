import { extname } from "node:path";

import type { ScriptCheckResult } from "@godot-agent-runtime/protocol";

import { RuntimeFailure } from "./errors.js";
import {
  collectGodotDiagnostics,
  compactGodotOutput,
  prepareHostEnvironment,
  resolveGodotExecutable,
} from "./godot.js";
import { runProcess } from "./process.js";
import { resolveSafeTarget } from "./safe-path.js";

export interface ScriptCheckOptions {
  readonly projectPath: string;
  readonly path: string;
  readonly configPath?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

function assertGdScript(path: string): void {
  if (extname(path).toLowerCase() === ".gd") return;
  throw new RuntimeFailure({
    code: "SCRIPT_TYPE_UNSUPPORTED",
    stage: "validation",
    message: "Single-file script checking supports GDScript (.gd) only.",
    details: { path, extension: extname(path) || null },
    recovery: [
      "Pass a project-internal .gd file that is not a symbolic link.",
      "Use godot_project_check for C# projects and other project-wide validation.",
    ],
  });
}

export async function checkScript(
  options: ScriptCheckOptions,
): Promise<ScriptCheckResult> {
  assertGdScript(options.path);
  const target = await resolveSafeTarget(options.projectPath, options.path, false);
  const resourcePath = `res://${target.relativePath}`;
  const executable = await resolveGodotExecutable({
    projectPath: target.projectRoot,
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
  });
  const result = await runProcess(
    executable,
    [
      "--headless",
      "--no-header",
      "--path",
      target.projectRoot,
      "--script",
      resourcePath,
      "--check-only",
    ],
    {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.maxOutputBytes === undefined
        ? {}
        : { maxOutputBytes: options.maxOutputBytes }),
      env: await prepareHostEnvironment(target.projectRoot),
    },
  );
  const stdout = compactGodotOutput(result.stdout);
  const stderr = compactGodotOutput(result.stderr);
  const diagnostics = collectGodotDiagnostics(stdout, stderr);

  return {
    ok:
      !result.timedOut &&
      result.exitCode === 0 &&
      diagnostics.every((diagnostic) => diagnostic.severity !== "error"),
    path: resourcePath,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdout,
    stderr,
    truncated: result.truncated,
    diagnostics,
  };
}
