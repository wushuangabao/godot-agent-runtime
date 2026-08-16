import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  DevelopmentConfigSchema,
  type DevelopmentConfig,
} from "@godot-agent-runtime/protocol";

import { RuntimeFailure } from "./errors.js";

export function defaultConfigPath(cwd = process.cwd()): string {
  return resolve(cwd, "config", "development.local.json");
}

export async function loadDevelopmentConfig(
  configPath = defaultConfigPath(),
): Promise<DevelopmentConfig> {
  const resolvedPath = resolve(configPath);
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
        "Copy config/development.local.example.json to config/development.local.json.",
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
