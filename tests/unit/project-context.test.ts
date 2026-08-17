import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  getProjectContext,
  getProjectSnapshot,
} from "../../packages/core/src/index.js";
import { RuntimeFailure } from "../../packages/core/src/errors.js";

describe("getProjectContext", () => {
  it("returns project identity without implicitly binding editor or runtime runs", async () => {
    const context = await getProjectContext({
      projectPath: resolve("examples", "minimal-2d"),
    });

    expect(context).toMatchObject({
      ok: true,
      project: { mainScene: "res://main.tscn" },
      editor: null,
      runtime: null,
    });
    expect(context.identity.projectFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("preserves the structured error for an explicitly requested unknown run", async () => {
    try {
      await getProjectContext({
        projectPath: resolve("examples", "minimal-2d"),
        runtimeRunId: "00000000-0000-4000-8000-000000000000",
      });
      expect.unreachable("an unknown runtime runId must fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeFailure);
      expect((error as RuntimeFailure).payload).toMatchObject({
        code: "RUN_NOT_FOUND",
        stage: "discovery",
      });
    }
  });

  it("derives canonical project context and identity from one file snapshot", async () => {
    const projectPath = resolve("examples", "minimal-2d");
    const sandbox = await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-context-alias-"));
    const alias = resolve(sandbox, "project-alias");
    try {
      await symlink(projectPath, alias, process.platform === "win32" ? "junction" : "dir");

      const snapshot = await getProjectSnapshot(alias);
      const context = await getProjectContext({ projectPath: alias });
      const projectFileBytes = await readFile(snapshot.project.projectFile);

      expect(snapshot.project.projectPath).toBe(snapshot.identity.projectPath);
      expect(snapshot.project.projectFile).toBe(snapshot.identity.projectFile);
      expect(snapshot.identity.projectFileSha256).toBe(
        createHash("sha256").update(projectFileBytes).digest("hex"),
      );
      expect(context.project).toEqual(snapshot.project);
      expect(context.identity).toEqual(snapshot.identity);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});
