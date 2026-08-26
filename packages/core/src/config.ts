import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  DevelopmentConfigSchema,
  type DevelopmentConfig,
} from "@godot-agent-runtime/protocol";

import { RuntimeFailure } from "./errors.js";

export function defaultConfigPath(cwd = process.cwd()): string {
  return resolve(cwd, ".godot-agent-runtime", "config.local.json");
}

async function isReadable(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveConfigPath(
  explicitPath?: string,
  cwd = process.cwd(),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (explicitPath !== undefined) return resolve(cwd, explicitPath);
  const environmentPath = environment.GODOT_AGENT_RUNTIME_CONFIG?.trim();
  if (environmentPath) return resolve(cwd, environmentPath);

  const workspacePath = defaultConfigPath(cwd);
  if (await isReadable(workspacePath)) return workspacePath;
  const legacyPath = resolve(cwd, "config", "development.local.json");
  if (await isReadable(legacyPath)) return legacyPath;

  throw new RuntimeFailure({
    code: "CONFIG_NOT_FOUND",
    stage: "configuration",
    message: "No Godot Agent Runtime configuration source was found.",
    details: {
      explicitPath: null,
      environmentVariable: "GODOT_AGENT_RUNTIME_CONFIG",
      workspacePath,
      legacyPath,
    },
    recovery: [
      "Pass --config with an explicit schema version 1 configuration path.",
      "Set GODOT_AGENT_RUNTIME_CONFIG to an explicit configuration path.",
      "Run setup codex to create .godot-agent-runtime/config.local.json.",
      "For a source checkout, create config/development.local.json.",
    ],
  });
}

export async function loadDevelopmentConfig(
  configPath?: string,
): Promise<DevelopmentConfig> {
  const resolvedPath = await resolveConfigPath(configPath);
  let source: string;

  try {
    source = await readFile(resolvedPath, "utf8");
  } catch (error) {
    throw new RuntimeFailure({
      code: "CONFIG_NOT_FOUND",
      stage: "configuration",
      message: `Development configuration was not found at ${resolvedPath}.`,
      details: {
        path: resolvedPath,
        cause: error instanceof Error ? error.message : String(error),
      },
      recovery: [
        "Pass an explicit configuration path or run setup codex for this workspace.",
        "For source development, copy config/development.local.example.json to config/development.local.json.",
        "Set godot.executable to a Godot 4.x editor executable.",
      ],
    });
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new RuntimeFailure({
      code: "CONFIG_INVALID_JSON",
      stage: "configuration",
      message: `Development configuration at ${resolvedPath} is not valid JSON.`,
      details: {
        path: resolvedPath,
        cause: error instanceof Error ? error.message : String(error),
      },
      recovery: ["Fix the JSON syntax and run doctor again."],
    });
  }

  const result = DevelopmentConfigSchema.safeParse(value);
  if (!result.success) {
    throw new RuntimeFailure({
      code: "CONFIG_SCHEMA_INVALID",
      stage: "configuration",
      message: `Development configuration at ${resolvedPath} does not match schema version 1.`,
      details: {
        path: resolvedPath,
        issues: result.error.issues,
      },
      recovery: ["Compare the file with config/development.local.example.json."],
    });
  }

  return result.data;
}
