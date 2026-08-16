import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readProjectFile, writeProjectFile } from "./safe-file.js";
import { RuntimeFailure } from "./errors.js";

const ADDON_FILES = ["plugin.cfg", "plugin.gd", "editor_bridge.gd", "runtime_entry.gd"] as const;

export interface AddonInstallResult {
  readonly ok: true;
  readonly projectPath: string;
  readonly plugin: "godot_agent_runtime";
  readonly files: readonly string[];
  readonly projectConfigurationChanged: boolean;
}

function enablePlugin(source: string): string {
  const headerPattern = /^\[editor_plugins\]\s*$/m;
  const header = headerPattern.exec(source);
  if (header === null) {
    return `${source.trimEnd()}\n\n[editor_plugins]\n\nenabled=PackedStringArray("godot_agent_runtime")\n`;
  }
  const sectionStart = header.index;
  const nextHeaderPattern = /^\[[^\]]+\]\s*$/gm;
  nextHeaderPattern.lastIndex = header.index + header[0].length;
  const nextHeader = nextHeaderPattern.exec(source);
  const sectionEnd = nextHeader?.index ?? source.length;
  const section = source.slice(sectionStart, sectionEnd);
  const enabledPattern = /^enabled\s*=\s*PackedStringArray\((.*)\)\s*$/m;
  const enabledMatch = section.match(enabledPattern);
  if (enabledMatch === null) {
    const replacement = `${section.trimEnd()}\n\nenabled=PackedStringArray("godot_agent_runtime")\n\n`;
    return `${source.slice(0, sectionStart)}${replacement}${source.slice(sectionEnd)}`;
  }
  const entries = [...(enabledMatch[1] ?? "").matchAll(/"((?:\\.|[^"\\])*)"/g)].map(
    (match) => JSON.parse(`"${match[1] ?? ""}"`) as string,
  );
  if (entries.includes("godot_agent_runtime")) return source;
  entries.push("godot_agent_runtime");
  const replacement = `enabled=PackedStringArray(${entries.map((entry) => JSON.stringify(entry)).join(", ")})`;
  const updatedSection = section.replace(enabledMatch[0], replacement);
  return `${source.slice(0, sectionStart)}${updatedSection}${source.slice(sectionEnd)}`;
}

export async function installGodotAddon(projectPath: string): Promise<AddonInstallResult> {
  const sourceRoot = fileURLToPath(
    new URL("../../../addons/godot_agent_runtime/", import.meta.url),
  );
  const installed: string[] = [];
  for (const filename of ADDON_FILES) {
    const content = await readFile(resolve(sourceRoot, filename), "utf8");
    const path = `addons/godot_agent_runtime/${filename}`;
    let expectedSha256: string | null = null;
    try {
      const current = await readProjectFile({ projectPath, path });
      expectedSha256 = current.sha256;
      if (current.content === content) {
        installed.push(`res://${path}`);
        continue;
      }
    } catch (error) {
      if (!(error instanceof RuntimeFailure && error.payload.code === "FILE_NOT_FOUND")) throw error;
      expectedSha256 = null;
    }
    await writeProjectFile({
      projectPath,
      path,
      content,
      expectedSha256,
      createDirectories: true,
    });
    installed.push(`res://${path}`);
  }

  const project = await readProjectFile({ projectPath, path: "project.godot" });
  const configured = enablePlugin(project.content);
  if (configured !== project.content) {
    await writeProjectFile({
      projectPath,
      path: "project.godot",
      content: configured,
      expectedSha256: project.sha256,
    });
  }
  return {
    ok: true,
    projectPath: project.projectPath,
    plugin: "godot_agent_runtime",
    files: installed,
    projectConfigurationChanged: configured !== project.content,
  };
}
