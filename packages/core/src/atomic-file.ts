import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { RuntimeFailure } from "./errors.js";

export type PlannedOperation = "created" | "updated" | "unchanged";

export interface PlannedTextWrite {
  readonly path: string;
  readonly content: string;
  readonly expectedSha256: string | null;
  readonly operation: PlannedOperation;
}

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function nodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function failure(
  code: string,
  message: string,
  details: Record<string, unknown>,
  recovery: string[],
): RuntimeFailure {
  return new RuntimeFailure({
    code,
    stage: "configuration",
    message,
    details,
    recovery,
  });
}

async function readOptionalText(path: string): Promise<Buffer | null> {
  try {
    const information = await lstat(path);
    if (information.isSymbolicLink()) {
      throw failure(
        "ATOMIC_WRITE_SYMLINK_REJECTED",
        "Atomic configuration writes do not follow symbolic links.",
        { path },
        ["Replace the symbolic link with a regular project-local file and retry."],
      );
    }
    if (!information.isFile()) {
      throw failure(
        "ATOMIC_WRITE_TARGET_INVALID",
        "The atomic configuration target is not a regular file.",
        { path },
        ["Choose a regular project-local configuration file."],
      );
    }
    return await readFile(path);
  } catch (error) {
    if (nodeError(error, "ENOENT")) return null;
    throw error;
  }
}

async function buildPlan(
  path: string,
  render: (existing: string | null) => string,
): Promise<PlannedTextWrite> {
  const resolvedPath = resolve(path);
  const current = await readOptionalText(resolvedPath);
  let existing: string | null = null;
  if (current !== null) {
    try {
      existing = new TextDecoder("utf-8", { fatal: true }).decode(current);
    } catch (error) {
      throw failure(
        "ATOMIC_WRITE_INVALID_UTF8",
        "The existing configuration is not valid UTF-8 text.",
        {
          path: resolvedPath,
          cause: error instanceof Error ? error.message : String(error),
        },
        ["Convert the configuration to UTF-8 before retrying."],
      );
    }
  }
  const content = render(existing);
  const expectedSha256 = current === null ? null : sha256(current);
  const operation: PlannedOperation = current === null
    ? "created"
    : existing === content
      ? "unchanged"
      : "updated";
  return Object.freeze({
    path: resolvedPath,
    content,
    expectedSha256,
    operation,
  });
}

export async function planAtomicTextWrite(
  path: string,
  content: string,
): Promise<PlannedTextWrite> {
  return await buildPlan(path, () => content);
}

export async function planAtomicTextUpdate(
  path: string,
  render: (existing: string | null) => string,
): Promise<PlannedTextWrite> {
  return await buildPlan(path, render);
}

export async function applyAtomicTextWrite(
  plan: PlannedTextWrite,
): Promise<PlannedOperation> {
  const path = resolve(plan.path);
  await mkdir(dirname(path), { recursive: true });
  const lockPath = `${path}.godot-agent-runtime.lock`;
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let lock: Awaited<ReturnType<typeof open>> | null = null;
  let ownsLock = false;
  try {
    try {
      lock = await open(lockPath, "wx");
      ownsLock = true;
    } catch (error) {
      throw failure(
        "ATOMIC_WRITE_BUSY",
        "Another runtime process is applying this configuration target.",
        { path, lockPath, cause: error instanceof Error ? error.message : String(error) },
        ["Wait for the other setup process to finish, then recompute the plan."],
      );
    }

    const current = await readOptionalText(path);
    const actualSha256 = current === null ? null : sha256(current);
    if (actualSha256 !== plan.expectedSha256) {
      throw failure(
        "ATOMIC_WRITE_CONFLICT",
        "The configuration changed after the write was planned.",
        {
          path,
          expectedSha256: plan.expectedSha256,
          actualSha256,
        },
        ["Read the current configuration, preserve unrelated settings, and plan again."],
      );
    }
    if (plan.operation === "unchanged") {
      const currentText = current === null
        ? null
        : new TextDecoder("utf-8", { fatal: true }).decode(current);
      if (currentText !== plan.content) {
        throw failure(
          "ATOMIC_WRITE_CONFLICT",
          "The unchanged plan no longer matches the configuration content.",
          { path, expectedSha256: plan.expectedSha256, actualSha256 },
          ["Recompute the configuration plan before retrying."],
        );
      }
      return "unchanged";
    }

    const handle = await open(temporaryPath, "wx");
    try {
      await handle.writeFile(plan.content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (plan.expectedSha256 === null) {
      try {
        await link(temporaryPath, path);
      } catch (error) {
        if (nodeError(error, "EEXIST")) {
          throw failure(
            "ATOMIC_WRITE_CONFLICT",
            "The configuration was created after the write was planned.",
            { path, expectedSha256: null },
            ["Read the new configuration and plan again."],
          );
        }
        throw error;
      }
    } else {
      await rename(temporaryPath, path);
    }
    return plan.operation;
  } catch (error) {
    if (error instanceof RuntimeFailure) throw error;
    throw failure(
      "ATOMIC_WRITE_FAILED",
      "The atomic configuration write failed.",
      { path, cause: error instanceof Error ? error.message : String(error) },
      ["Verify that the target directory is writable, then recompute the plan."],
    );
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (lock !== null) await lock.close().catch(() => undefined);
    if (ownsLock) await rm(lockPath, { force: true }).catch(() => undefined);
  }
}
