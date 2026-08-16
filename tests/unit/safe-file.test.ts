import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readProjectFile,
  writeProjectFile,
} from "../../packages/core/src/safe-file.js";

const temporaryDirectories: string[] = [];

async function projectFixture(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-files-"));
  temporaryDirectories.push(root);
  await writeFile(
    resolve(root, "project.godot"),
    'config_version=5\n[application]\nconfig/name="Safe File Fixture"\n',
    "utf8",
  );
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => await rm(path, { recursive: true })));
});

describe("safe project files", () => {
  it("reads and atomically updates with a SHA-256 precondition", async () => {
    const projectPath = await projectFixture();
    await writeFile(resolve(projectPath, "main.gd"), "extends Node\n", "utf8");

    const before = await readProjectFile({ projectPath, path: "res://main.gd" });
    const result = await writeProjectFile({
      projectPath,
      path: "main.gd",
      content: 'extends Node\n\nfunc _ready():\n\tprint("ready")\n',
      expectedSha256: before.sha256,
    });

    expect(result.operation).toBe("updated");
    expect(result.previousSha256).toBe(before.sha256);
    expect(await readFile(resolve(projectPath, "main.gd"), "utf8")).toContain("ready");
  });

  it("rejects traversal, unsupported types, and stale writes", async () => {
    const projectPath = await projectFixture();
    await writeFile(resolve(projectPath, "main.gd"), "extends Node\n", "utf8");

    await expect(readProjectFile({ projectPath, path: "../outside.gd" })).rejects.toMatchObject({
      payload: { code: "FILE_PATH_INVALID" },
    });
    await expect(
      writeProjectFile({ projectPath, path: "asset.png", content: "not really png" }),
    ).rejects.toMatchObject({ payload: { code: "FILE_TYPE_NOT_ALLOWED" } });
    await expect(
      writeProjectFile({
        projectPath,
        path: "main.gd",
        content: "extends Node2D\n",
        expectedSha256: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ payload: { code: "FILE_CONFLICT" } });
  });

  it("creates nested files only when requested", async () => {
    const projectPath = await projectFixture();
    await mkdir(resolve(projectPath, "scripts"));
    const result = await writeProjectFile({
      projectPath,
      path: "scripts/player.gd",
      content: "extends Node2D\n",
      expectedSha256: null,
    });
    expect(result.operation).toBe("created");
  });
});
