import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import * as configModule from "../../packages/core/src/config.js";

const temporaryDirectories: string[] = [];
const configApi = configModule as unknown as {
  resolveConfigPath(
    explicitPath?: string,
    cwd?: string,
    environment?: NodeJS.ProcessEnv,
  ): Promise<string>;
};

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-config-resolution-"));
  temporaryDirectories.push(root);
  return root;
}

async function writeConfig(path: string, executable = "C:\\Godot\\Godot.exe"): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify({
    schemaVersion: 1,
    godot: { executable },
  }), "utf8");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(
      async (path) => await rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("development configuration resolution", () => {
  it("prefers an explicit path over every other source", async () => {
    const root = await temporaryRoot();
    const explicit = resolve(root, "explicit.json");
    const environmentPath = resolve(root, "environment.json");
    await writeConfig(explicit);
    await writeConfig(environmentPath);
    await writeConfig(resolve(root, ".godot-agent-runtime", "config.local.json"));
    await writeConfig(resolve(root, "config", "development.local.json"));

    await expect(configApi.resolveConfigPath(explicit, root, {
      GODOT_AGENT_RUNTIME_CONFIG: environmentPath,
    })).resolves.toBe(explicit);
  });

  it("prefers the environment path over workspace and legacy files", async () => {
    const root = await temporaryRoot();
    const environmentPath = resolve(root, "environment.json");
    await writeConfig(environmentPath);
    await writeConfig(resolve(root, ".godot-agent-runtime", "config.local.json"));
    await writeConfig(resolve(root, "config", "development.local.json"));

    await expect(configApi.resolveConfigPath(undefined, root, {
      GODOT_AGENT_RUNTIME_CONFIG: environmentPath,
    })).resolves.toBe(environmentPath);
  });

  it("uses workspace local config before the legacy source config", async () => {
    const root = await temporaryRoot();
    const localPath = resolve(root, ".godot-agent-runtime", "config.local.json");
    await writeConfig(localPath);
    await writeConfig(resolve(root, "config", "development.local.json"));

    await expect(configApi.resolveConfigPath(undefined, root, {})).resolves.toBe(localPath);
  });

  it("falls back to the legacy source config", async () => {
    const root = await temporaryRoot();
    const legacyPath = resolve(root, "config", "development.local.json");
    await writeConfig(legacyPath);

    await expect(configApi.resolveConfigPath(undefined, root, {})).resolves.toBe(legacyPath);
  });

  it("reports all four sources when no default configuration exists", async () => {
    const root = await temporaryRoot();

    await expect(configApi.resolveConfigPath(undefined, root, {})).rejects.toMatchObject({
      payload: {
        code: "CONFIG_NOT_FOUND",
        stage: "configuration",
        details: {
          explicitPath: null,
          environmentVariable: "GODOT_AGENT_RUNTIME_CONFIG",
          workspacePath: resolve(root, ".godot-agent-runtime", "config.local.json"),
          legacyPath: resolve(root, "config", "development.local.json"),
        },
      },
    });
  });

  it("loads schema version 1 and rejects invalid schemas hermetically", async () => {
    const root = await temporaryRoot();
    const validPath = resolve(root, "valid.json");
    const invalidPath = resolve(root, "invalid.json");
    await writeConfig(validPath, "C:\\Godot\\Godot_v4.6.2.exe");
    await writeFile(invalidPath, JSON.stringify({
      schemaVersion: 2,
      godot: { executable: "" },
    }), "utf8");

    await expect(configModule.loadDevelopmentConfig(validPath)).resolves.toEqual({
      schemaVersion: 1,
      godot: { executable: "C:\\Godot\\Godot_v4.6.2.exe" },
    });
    await expect(configModule.loadDevelopmentConfig(invalidPath)).rejects.toMatchObject({
      payload: { code: "CONFIG_SCHEMA_INVALID", stage: "configuration" },
    });
  });
});
