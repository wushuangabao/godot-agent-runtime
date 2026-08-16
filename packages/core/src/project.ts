import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";

import type { ProjectInfo } from "@godot-agent-runtime/protocol";

import { RuntimeFailure } from "./errors.js";

function readSetting(source: string, key: string): string | null {
  const pattern = new RegExp(`^${key.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}=(.+)$`, "m");
  const match = pattern.exec(source);
  if (!match?.[1]) return null;
  const raw = match[1].trim();
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1);
  }
  return raw;
}

function readSection(source: string, name: string): string | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = new RegExp(`^\\s*\\[${escapedName}\\]\\s*$`, "m").exec(source);
  if (header === null) return null;
  const remainder = source.slice(header.index + header[0].length);
  const nextHeader = /^\s*\[[^\]\r\n]+\]\s*$/m.exec(remainder);
  return remainder.slice(0, nextHeader?.index ?? remainder.length);
}

function readEnabledPlugins(source: string): string[] {
  const editorPlugins = readSection(source, "editor_plugins");
  if (editorPlugins === null) return [];
  const raw = readSetting(editorPlugins, "enabled");
  if (!raw) return [];
  return [...raw.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
}

export async function inspectProject(projectPath: string): Promise<ProjectInfo> {
  const resolvedProjectPath = resolve(projectPath);
  const projectFile = resolve(resolvedProjectPath, "project.godot");

  try {
    await access(projectFile, constants.R_OK);
  } catch (error) {
    throw new RuntimeFailure({
      code: "PROJECT_NOT_FOUND",
      stage: "discovery",
      message: `No readable project.godot was found in ${resolvedProjectPath}.`,
      details: {
        projectPath: resolvedProjectPath,
        projectFile,
        cause: error instanceof Error ? error.message : String(error),
      },
      recovery: ["Pass the directory that directly contains project.godot."],
    });
  }

  const source = await readFile(projectFile, "utf8");
  return {
    projectPath: resolvedProjectPath,
    projectFile,
    name: readSetting(source, "config/name"),
    mainScene: readSetting(source, "run/main_scene"),
    renderer:
      readSetting(source, "renderer/rendering_method") ??
      readSetting(source, "renderer/rendering_method.mobile"),
    enabledPlugins: readEnabledPlugins(source),
  };
}
