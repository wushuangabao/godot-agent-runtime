import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";

import { RuntimeFailure } from "./errors.js";
import { inspectProject } from "./project.js";

const ALLOWED_TEXT_EXTENSIONS = new Set([
  ".cfg",
  ".cs",
  ".gd",
  ".gdshader",
  ".godot",
  ".json",
  ".md",
  ".shader",
  ".tres",
  ".tscn",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);
const ALLOWED_TEXT_FILENAMES = new Set(["LICENSE"]);

export interface SafeProjectTarget {
  readonly projectRoot: string;
  readonly target: string;
  readonly relativePath: string;
}

function normalizeProjectRelativePath(input: string): string {
  const value = input.startsWith("res://") ? input.slice(6) : input;
  if (!value || value.includes("\0") || /^[a-zA-Z]:/.test(value)) {
    throwPathFailure(input, "Path must be a non-empty project-relative or res:// path.");
  }
  const normalized = value.replaceAll("/", sep);
  if (normalized.startsWith(sep)) {
    throwPathFailure(input, "Absolute paths are not accepted.");
  }
  return normalized;
}

function throwPathFailure(path: string, message: string): never {
  throw new RuntimeFailure({
    code: "FILE_PATH_INVALID",
    stage: "validation",
    message,
    details: { path },
    recovery: [
      "Use a res:// path or a path relative to the Godot project root.",
      "Keep file operations inside the project and avoid parent-directory segments.",
    ],
  });
}

function assertContained(projectRoot: string, target: string, original: string): void {
  const offset = relative(projectRoot, target);
  if (offset === "" || offset === ".." || offset.startsWith(`..${sep}`) || resolve(offset) === offset) {
    throwPathFailure(original, "The requested path resolves outside the Godot project.");
  }
}

function assertAllowedExtension(target: string, original: string): void {
  if (
    !ALLOWED_TEXT_EXTENSIONS.has(extname(target).toLowerCase()) &&
    !ALLOWED_TEXT_FILENAMES.has(basename(target))
  ) {
    throw new RuntimeFailure({
      code: "FILE_TYPE_NOT_ALLOWED",
      stage: "validation",
      message: `File type ${extname(target) || "(none)"} is not writable by the safe text API.`,
      details: {
        path: original,
        allowedExtensions: [...ALLOWED_TEXT_EXTENSIONS],
        allowedFileNames: [...ALLOWED_TEXT_FILENAMES],
      },
      recovery: ["Use a Godot text resource, script, configuration, or documentation file."],
    });
  }
}

export async function resolveSafeTarget(
  projectPath: string,
  requestedPath: string,
  allowMissing: boolean,
): Promise<SafeProjectTarget> {
  const project = await inspectProject(projectPath);
  const projectRoot = await realpath(project.projectPath);
  const normalized = normalizeProjectRelativePath(requestedPath);
  const target = resolve(projectRoot, normalized);
  assertContained(projectRoot, target, requestedPath);
  assertAllowedExtension(target, requestedPath);

  const segments = relative(projectRoot, target).split(sep);
  let cursor = projectRoot;
  for (const segment of segments) {
    cursor = resolve(cursor, segment);
    try {
      const information = await lstat(cursor);
      if (information.isSymbolicLink()) {
        throw new RuntimeFailure({
          code: "FILE_SYMLINK_REJECTED",
          stage: "validation",
          message: "Safe file operations do not follow symbolic links or junctions.",
          details: { path: requestedPath, segment: cursor },
          recovery: ["Use a regular path located directly inside the Godot project."],
        });
      }
    } catch (error) {
      if (
        error instanceof RuntimeFailure ||
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      ) {
        throw error;
      }
      if (!allowMissing) {
        throw new RuntimeFailure({
          code: "FILE_NOT_FOUND",
          stage: "discovery",
          message: `Project file ${requestedPath} was not found.`,
          details: { path: requestedPath, projectPath: projectRoot },
          recovery: ["Read an existing project-relative text file, or create it with godot_file_write."],
        });
      }
      break;
    }
  }

  return {
    projectRoot,
    target,
    relativePath: relative(projectRoot, target).replaceAll(sep, "/"),
  };
}

export async function ensureSafeProjectDirectory(
  projectRoot: string,
  relativeDirectory: string,
): Promise<string> {
  if (relativeDirectory === "" || relativeDirectory === ".") return projectRoot;
  const target = resolve(projectRoot, relativeDirectory);
  assertContained(projectRoot, target, relativeDirectory);
  const segments = relative(projectRoot, target).split(sep);
  let cursor = projectRoot;
  for (const segment of segments) {
    cursor = resolve(cursor, segment);
    try {
      await mkdir(cursor);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    const information = await lstat(cursor);
    if (information.isSymbolicLink()) {
      throw new RuntimeFailure({
        code: "FILE_SYMLINK_REJECTED",
        stage: "validation",
        message: "Project-internal mutation directories cannot be symbolic links or junctions.",
        details: { path: relativeDirectory, segment: cursor },
        recovery: ["Replace the linked directory with a regular directory inside the project."],
      });
    }
    if (!information.isDirectory()) {
      throw new RuntimeFailure({
        code: "FILE_NOT_REGULAR",
        stage: "validation",
        message: "A project-internal mutation directory path is not a directory.",
        details: { path: relativeDirectory, segment: cursor },
        recovery: ["Remove or rename the conflicting non-directory path and retry."],
      });
    }
  }
  return target;
}
