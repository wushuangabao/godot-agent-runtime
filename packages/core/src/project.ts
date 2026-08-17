import { createHash } from "node:crypto";
import { access, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";

import type { ProjectIdentity, ProjectInfo } from "@godot-agent-runtime/protocol";

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

function projectInfoFromSource(
  projectPath: string,
  projectFile: string,
  source: string,
): ProjectInfo {
  return {
    projectPath,
    projectFile,
    name: readSetting(source, "config/name"),
    mainScene: readSetting(source, "run/main_scene"),
    renderer:
      readSetting(source, "renderer/rendering_method") ??
      readSetting(source, "renderer/rendering_method.mobile"),
    enabledPlugins: readEnabledPlugins(source),
  };
}

export interface ProjectSnapshot {
  readonly project: ProjectInfo;
  readonly identity: ProjectIdentity;
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
  return projectInfoFromSource(resolvedProjectPath, projectFile, source);
}

export async function getProjectSnapshot(projectPath: string): Promise<ProjectSnapshot> {
  const resolvedProjectPath = resolve(projectPath);
  const requestedProjectFile = resolve(resolvedProjectPath, "project.godot");
  let canonicalPath: string;
  let bytes: Buffer;
  try {
    canonicalPath = await realpath(resolvedProjectPath);
    bytes = await readFile(resolve(canonicalPath, "project.godot"));
  } catch (error) {
    throw new RuntimeFailure({
      code: "PROJECT_NOT_FOUND",
      stage: "discovery",
      message: `No readable project.godot was found in ${resolvedProjectPath}.`,
      details: {
        projectPath: resolvedProjectPath,
        projectFile: requestedProjectFile,
        cause: error instanceof Error ? error.message : String(error),
      },
      recovery: ["Pass the directory that directly contains project.godot."],
    });
  }
  const projectFile = resolve(canonicalPath, "project.godot");
  const identityPath = process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath;
  return {
    project: projectInfoFromSource(canonicalPath, projectFile, bytes.toString("utf8")),
    identity: {
      projectPath: canonicalPath,
      projectFile,
      projectFingerprint: createHash("sha256").update(identityPath, "utf8").digest("hex"),
      projectFileSha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

export async function getProjectIdentity(projectPath: string): Promise<ProjectIdentity> {
  return (await getProjectSnapshot(projectPath)).identity;
}

export async function assertProjectFingerprint(
  projectPath: string,
  expected?: string,
): Promise<ProjectIdentity> {
  const identity = await getProjectIdentity(projectPath);
  if (expected !== undefined && expected !== identity.projectFingerprint) {
    throw new RuntimeFailure({
      code: "PROJECT_IDENTITY_MISMATCH",
      stage: "validation",
      message: "The requested project does not match the previously inspected project.",
      details: { expected, actual: identity.projectFingerprint, projectPath: identity.projectPath },
      recovery: [
        "Call godot_project_context for the intended project and retry with its projectFingerprint.",
      ],
    });
  }
  return identity;
}
