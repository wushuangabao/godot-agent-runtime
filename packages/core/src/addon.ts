import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { readProjectFile, writeProjectFile } from "./safe-file.js";
import { RuntimeFailure } from "./errors.js";
import { getDistribution } from "./distribution.js";
import type { PlannedOperation } from "./atomic-file.js";

export const GODOT_AGENT_PLUGIN_ID = "godot_agent_runtime" as const;
export const GODOT_AGENT_PLUGIN_PATH =
  "res://addons/godot_agent_runtime/plugin.cfg" as const;
export const GODOT_AGENT_LEGACY_PLUGIN_NAME = "godot_agent_runtime" as const;

const ADDON_FILES = [
  "LICENSE",
  "plugin.cfg",
  "plugin.gd",
  "editor_bridge.gd",
  "runtime_entry.gd",
] as const;

export interface AddonInstallResult {
  readonly ok: true;
  readonly projectPath: string;
  readonly plugin: "godot_agent_runtime";
  readonly pluginPath: "res://addons/godot_agent_runtime/plugin.cfg";
  readonly files: readonly string[];
  readonly projectConfigurationChanged: boolean;
}

export interface PlannedProjectFileWrite {
  readonly projectPath: string;
  readonly resourcePath: string;
  readonly content: string;
  readonly expectedSha256: string | null;
  readonly operation: PlannedOperation;
}

export interface AddonInstallPlan {
  readonly projectPath: string;
  readonly pluginPath: "res://addons/godot_agent_runtime/plugin.cfg";
  readonly addonWrites: readonly PlannedProjectFileWrite[];
  readonly projectWrite: PlannedProjectFileWrite;
}

export function isGodotAgentRuntimeEnabled(enabledPlugins: readonly string[]): boolean {
  return enabledPlugins.some(
    (entry) =>
      entry === GODOT_AGENT_PLUGIN_PATH ||
      entry === GODOT_AGENT_LEGACY_PLUGIN_NAME,
  );
}

function enablePlugin(source: string): string {
  const headerPattern = /^\[editor_plugins\]\s*$/m;
  const header = headerPattern.exec(source);
  if (header === null) {
    return `${source.trimEnd()}\n\n[editor_plugins]\n\nenabled=PackedStringArray(${JSON.stringify(GODOT_AGENT_PLUGIN_PATH)})\n`;
  }
  const sectionStart = header.index;
  const nextHeaderPattern = /^\[[^\]]+\]\s*$/gm;
  nextHeaderPattern.lastIndex = header.index + header[0].length;
  const nextHeader = nextHeaderPattern.exec(source);
  const sectionEnd = nextHeader?.index ?? source.length;
  const section = source.slice(sectionStart, sectionEnd);
  const enabledPattern =
    /^enabled[ \t]*=[ \t]*PackedStringArray\((.*)\)[ \t]*$/m;
  const enabledMatch = section.match(enabledPattern);
  if (enabledMatch === null) {
    const replacement = `${section.trimEnd()}\n\nenabled=PackedStringArray(${JSON.stringify(GODOT_AGENT_PLUGIN_PATH)})\n\n`;
    return `${source.slice(0, sectionStart)}${replacement}${source.slice(sectionEnd)}`;
  }
  const entries = [...(enabledMatch[1] ?? "").matchAll(/"((?:\\.|[^"\\])*)"/g)].map(
    (match) => JSON.parse(`"${match[1] ?? ""}"`) as string,
  );
  const normalized: string[] = [];
  let inserted = false;
  for (const entry of entries) {
    const isRuntimePlugin =
      entry === GODOT_AGENT_PLUGIN_PATH ||
      entry === GODOT_AGENT_LEGACY_PLUGIN_NAME;
    if (!isRuntimePlugin) {
      normalized.push(entry);
      continue;
    }
    if (!inserted) {
      normalized.push(GODOT_AGENT_PLUGIN_PATH);
      inserted = true;
    }
  }
  if (!inserted) normalized.push(GODOT_AGENT_PLUGIN_PATH);
  const replacement = `enabled=PackedStringArray(${normalized.map((entry) => JSON.stringify(entry)).join(", ")})`;
  const updatedSection = section.replace(enabledMatch[0], replacement);
  return `${source.slice(0, sectionStart)}${updatedSection}${source.slice(sectionEnd)}`;
}

async function planProjectFileWrite(
  projectPath: string,
  resourcePath: string,
  content: string,
): Promise<PlannedProjectFileWrite> {
  try {
    const current = await readProjectFile({ projectPath, path: resourcePath });
    return {
      projectPath: current.projectPath,
      resourcePath: current.path,
      content,
      expectedSha256: current.sha256,
      operation: current.content === content ? "unchanged" : "updated",
    };
  } catch (error) {
    if (!(error instanceof RuntimeFailure && error.payload.code === "FILE_NOT_FOUND")) {
      throw error;
    }
    return {
      projectPath,
      resourcePath: resourcePath.startsWith("res://")
        ? resourcePath
        : `res://${resourcePath}`,
      content,
      expectedSha256: null,
      operation: "created",
    };
  }
}

function projectPlanConflict(
  plan: PlannedProjectFileWrite,
  actualSha256: string | null,
): RuntimeFailure {
  return new RuntimeFailure({
    code: "FILE_WRITE_CONFLICT",
    stage: "validation",
    message: "The project file changed after the addon write was planned.",
    details: {
      path: plan.resourcePath,
      expectedSha256: plan.expectedSha256,
      actualSha256,
    },
    recovery: ["Read the current project state and recompute the addon installation plan."],
  });
}

async function applyProjectFileWrite(
  plan: PlannedProjectFileWrite,
): Promise<PlannedOperation> {
  if (plan.operation === "unchanged") {
    let current;
    try {
      current = await readProjectFile({
        projectPath: plan.projectPath,
        path: plan.resourcePath,
      });
    } catch {
      throw projectPlanConflict(plan, null);
    }
    if (
      current.sha256 !== plan.expectedSha256 ||
      current.content !== plan.content
    ) {
      throw projectPlanConflict(plan, current.sha256);
    }
    return "unchanged";
  }
  const result = await writeProjectFile({
    projectPath: plan.projectPath,
    path: plan.resourcePath,
    content: plan.content,
    expectedSha256: plan.expectedSha256,
    createDirectories: true,
  });
  return result.operation;
}

export async function planGodotAddonInstall(
  projectPath: string,
): Promise<AddonInstallPlan> {
  const project = await readProjectFile({ projectPath, path: "project.godot" });
  const sourceRoot = getDistribution().addonRoot;
  const addonWrites: PlannedProjectFileWrite[] = [];
  for (const filename of ADDON_FILES) {
    const content = await readFile(resolve(sourceRoot, filename), "utf8");
    addonWrites.push(await planProjectFileWrite(
      project.projectPath,
      `res://addons/godot_agent_runtime/${filename}`,
      content,
    ));
  }
  const configured = enablePlugin(project.content);
  return Object.freeze({
    projectPath: project.projectPath,
    pluginPath: GODOT_AGENT_PLUGIN_PATH,
    addonWrites: Object.freeze(addonWrites),
    projectWrite: Object.freeze({
      projectPath: project.projectPath,
      resourcePath: project.path,
      content: configured,
      expectedSha256: project.sha256,
      operation: configured === project.content ? "unchanged" : "updated",
    }),
  });
}

export async function applyGodotAddonInstallPlan(
  plan: AddonInstallPlan,
): Promise<AddonInstallResult> {
  const completedTargets: string[] = [];
  try {
    for (const write of plan.addonWrites) {
      await applyProjectFileWrite(write);
      const installed = await readProjectFile({
        projectPath: write.projectPath,
        path: write.resourcePath,
      });
      if (installed.content !== write.content) {
        throw projectPlanConflict(write, installed.sha256);
      }
      completedTargets.push(write.resourcePath);
    }
    await applyProjectFileWrite(plan.projectWrite);
    completedTargets.push(plan.projectWrite.resourcePath);
  } catch (error) {
    if (error instanceof RuntimeFailure) {
      throw new RuntimeFailure({
        ...error.payload,
        details: {
          ...error.payload.details,
          completedTargets,
        },
      });
    }
    throw new RuntimeFailure({
      code: "ADDON_INSTALL_FAILED",
      stage: "configuration",
      message: "The addon installation plan could not be applied.",
      details: {
        completedTargets,
        cause: error instanceof Error ? error.message : String(error),
      },
      recovery: ["Inspect the completed targets and rerun the idempotent addon installation."],
    });
  }
  return {
    ok: true,
    projectPath: plan.projectPath,
    plugin: GODOT_AGENT_PLUGIN_ID,
    pluginPath: GODOT_AGENT_PLUGIN_PATH,
    files: plan.addonWrites.map((write) => write.resourcePath),
    projectConfigurationChanged: plan.projectWrite.operation !== "unchanged",
  };
}

export async function installGodotAddon(
  projectPath: string,
): Promise<AddonInstallResult> {
  return await applyGodotAddonInstallPlan(
    await planGodotAddonInstall(projectPath),
  );
}
