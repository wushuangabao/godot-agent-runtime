import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

import type { ProjectDiscoveryResult } from "@godot-agent-runtime/protocol";

import { RuntimeFailure } from "./errors.js";
import { inspectProject } from "./project.js";

const SKIPPED_DIRECTORIES = new Set([".git", ".godot", "node_modules"]);

export interface FindProjectsOptions {
  readonly maxDepth?: number;
  readonly maxProjects?: number;
}

export async function findProjects(
  searchRoot: string,
  options: FindProjectsOptions = {},
): Promise<ProjectDiscoveryResult> {
  const root = resolve(searchRoot);
  const maxDepth = options.maxDepth ?? 4;
  const maxProjects = options.maxProjects ?? 100;

  try {
    if (!(await stat(root)).isDirectory()) throw new Error("Path is not a directory.");
  } catch (error) {
    throw new RuntimeFailure({
      code: "SEARCH_ROOT_NOT_FOUND",
      stage: "discovery",
      message: `Project search root is not a readable directory: ${root}.`,
      details: {
        root,
        cause: error instanceof Error ? error.message : String(error),
      },
      recovery: ["Pass an existing directory as the project search root."],
    });
  }

  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  const projects: ProjectDiscoveryResult["projects"] = [];
  let scannedDirectories = 0;
  let truncated = false;

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    scannedDirectories += 1;

    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch {
      continue;
    }

    if (entries.some((entry) => entry.isFile() && entry.name === "project.godot")) {
      projects.push(await inspectProject(current.path));
      if (projects.length >= maxProjects) {
        truncated = queue.length > 0;
        break;
      }
      continue;
    }

    if (current.depth >= maxDepth) continue;
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      queue.push({ path: resolve(current.path, entry.name), depth: current.depth + 1 });
    }
  }

  return { root, scannedDirectories, truncated, projects };
}
