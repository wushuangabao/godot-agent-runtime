import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { expect, it } from "vitest";

import { ProjectIdentitySchema } from "../../packages/protocol/src/index.js";
import { RuntimeFailure } from "../../packages/core/src/errors.js";
import {
  assertProjectFingerprint,
  getProjectIdentity,
} from "../../packages/core/src/project.js";

it("returns a stable path identity and a content receipt", async () => {
  const sandbox = await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-identity-"));
  const root = resolve(sandbox, "real-project");
  const alias = resolve(sandbox, "project-alias");
  try {
    await mkdir(root);
    const projectBytes = "config_version=5\n";
    await writeFile(resolve(root, "project.godot"), projectBytes, "utf8");
    const canonicalPath = await realpath(root);
    const identityPath = process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath;
    const expectedFingerprint = createHash("sha256").update(identityPath, "utf8").digest("hex");
    const expectedFileSha256 = createHash("sha256").update(projectBytes, "utf8").digest("hex");
    const first = await getProjectIdentity(root);
    const second = await getProjectIdentity(root);
    expect(first.projectPath).toBe(canonicalPath);
    expect(first.projectFile).toBe(resolve(canonicalPath, "project.godot"));
    expect(first.projectFingerprint).toBe(expectedFingerprint);
    expect(first.projectFingerprint).toBe(second.projectFingerprint);
    expect(first.projectFileSha256).toBe(expectedFileSha256);
    expect(ProjectIdentitySchema.parse(first)).toEqual(first);

    if (process.platform === "win32") {
      expect(first.projectFingerprint).toBe(
        createHash("sha256").update(canonicalPath.toLowerCase(), "utf8").digest("hex"),
      );
    }

    try {
      await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") return;
      throw error;
    }
    expect(await getProjectIdentity(alias)).toEqual(first);
  } finally {
    await rm(sandbox, { recursive: true });
  }
});

it("rejects the wrong project fingerprint and accepts the current one", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-identity-"));
  try {
    await writeFile(resolve(root, "project.godot"), "config_version=5\n", "utf8");
    const identity = await getProjectIdentity(root);

    try {
      await assertProjectFingerprint(root, "0".repeat(64));
      expect.unreachable("wrong project fingerprint must fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeFailure);
      const failure = error as RuntimeFailure;
      expect(failure.message).toBe(
        "The requested project does not match the previously inspected project.",
      );
      expect(failure.payload).toMatchObject({
        code: "PROJECT_IDENTITY_MISMATCH",
        stage: "validation",
        details: {
          expected: "0".repeat(64),
          actual: identity.projectFingerprint,
          projectPath: identity.projectPath,
        },
      });
      expect(failure.payload.recovery).toEqual([
        "Call godot_project_context for the intended project and retry with its projectFingerprint.",
      ]);
    }
    await expect(assertProjectFingerprint(root, identity.projectFingerprint)).resolves.toEqual(
      identity,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});
