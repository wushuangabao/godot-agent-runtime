import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";

import type {
  SafeFileReadResult,
  SafeFileWriteResult,
} from "@godot-agent-runtime/protocol";

import { RuntimeFailure } from "./errors.js";
import { inspectProject } from "./project.js";

const DEFAULT_MAX_BYTES = 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([
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

export interface SafeFileOptions {
  readonly projectPath: string;
  readonly path: string;
  readonly maxBytes?: number;
}

export interface SafeFileWriteOptions extends SafeFileOptions {
  readonly content: string;
  readonly expectedSha256?: string | null;
  readonly createDirectories?: boolean;
}

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
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
  if (!ALLOWED_EXTENSIONS.has(extname(target).toLowerCase())) {
    throw new RuntimeFailure({
      code: "FILE_TYPE_NOT_ALLOWED",
      stage: "validation",
      message: `File type ${extname(target) || "(none)"} is not writable by the safe text API.`,
      details: { path: original, allowedExtensions: [...ALLOWED_EXTENSIONS] },
      recovery: ["Use a Godot text resource, script, configuration, or documentation file."],
    });
  }
}

async function resolveSafeTarget(
  projectPath: string,
  requestedPath: string,
  allowMissing: boolean,
): Promise<{ projectRoot: string; target: string; relativePath: string }> {
  const project = await inspectProject(projectPath);
  const projectRoot = await realpath(project.projectPath);
  const normalized = normalizeProjectRelativePath(requestedPath);
  const target = resolve(projectRoot, normalized);
  assertContained(projectRoot, target, requestedPath);
  assertAllowedExtension(target, requestedPath);

  const segments = relative(projectRoot, target).split(sep);
  let cursor = projectRoot;
  for (let index = 0; index < segments.length; index += 1) {
    cursor = resolve(cursor, segments[index] ?? "");
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

export async function readProjectFile(
  options: SafeFileOptions,
): Promise<SafeFileReadResult> {
  const maximum = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const { projectRoot, target, relativePath } = await resolveSafeTarget(
    options.projectPath,
    options.path,
    false,
  );
  const information = await stat(target);
  if (!information.isFile() || information.size > maximum) {
    throw new RuntimeFailure({
      code: information.isFile() ? "FILE_TOO_LARGE" : "FILE_NOT_REGULAR",
      stage: "validation",
      message: information.isFile()
        ? `Project file exceeds the ${maximum} byte read limit.`
        : "The requested path is not a regular file.",
      details: { path: relativePath, size: information.size, maxBytes: maximum },
      recovery: ["Choose a regular text file within the configured size limit."],
    });
  }
  const buffer = await readFile(target);
  if (buffer.includes(0)) {
    throw new RuntimeFailure({
      code: "FILE_BINARY_REJECTED",
      stage: "validation",
      message: "The safe file API only reads UTF-8 text files.",
      details: { path: relativePath },
      recovery: ["Use Godot resource APIs for binary assets."],
    });
  }
  const content = buffer.toString("utf8");
  return {
    ok: true,
    projectPath: projectRoot,
    path: `res://${relativePath}`,
    bytes: buffer.length,
    sha256: sha256(buffer),
    content,
  };
}

export async function writeProjectFile(
  options: SafeFileWriteOptions,
): Promise<SafeFileWriteResult> {
  const maximum = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const content = Buffer.from(options.content, "utf8");
  if (content.length > maximum || content.includes(0)) {
    throw new RuntimeFailure({
      code: content.length > maximum ? "FILE_TOO_LARGE" : "FILE_BINARY_REJECTED",
      stage: "validation",
      message: content.length > maximum
        ? `Content exceeds the ${maximum} byte write limit.`
        : "NUL bytes are not accepted by the safe text API.",
      details: { path: options.path, bytes: content.length, maxBytes: maximum },
      recovery: ["Write bounded UTF-8 text content only."],
    });
  }

  const { projectRoot, target, relativePath } = await resolveSafeTarget(
    options.projectPath,
    options.path,
    true,
  );
  let previous: Buffer | null = null;
  try {
    previous = await readFile(target);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }

  const previousSha256 = previous === null ? null : sha256(previous);
  if (options.expectedSha256 !== undefined && options.expectedSha256 !== previousSha256) {
    throw new RuntimeFailure({
      code: "FILE_CONFLICT",
      stage: "validation",
      message: "The file changed since it was read, so the write was not applied.",
      details: {
        path: `res://${relativePath}`,
        expectedSha256: options.expectedSha256,
        actualSha256: previousSha256,
      },
      recovery: ["Read the file again, incorporate the current content, and retry with its SHA-256."],
    });
  }

  if (options.createDirectories) await mkdir(dirname(target), { recursive: true });
  const temporary = resolve(dirname(target), `.${relativePath.split("/").at(-1)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
  } catch (error) {
    throw new RuntimeFailure({
      code: "FILE_WRITE_FAILED",
      stage: "validation",
      message: `Failed to atomically write res://${relativePath}.`,
      details: { cause: error instanceof Error ? error.message : String(error) },
      recovery: ["Verify that the parent directory exists and is writable, then retry."],
    });
  }

  return {
    ok: true,
    projectPath: projectRoot,
    path: `res://${relativePath}`,
    operation: previous === null ? "created" : "updated",
    bytes: content.length,
    sha256: sha256(content),
    previousSha256,
  };
}
