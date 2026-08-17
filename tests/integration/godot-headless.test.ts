import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ScriptCheckResultSchema } from "../../packages/protocol/src/index.js";

import {
  checkProject,
  checkScript,
  prepareHostEnvironment,
  runDoctor,
  runProject,
} from "../../packages/core/src/index.js";

const configPath = resolve("config", "development.local.json");
const hasLocalConfig = existsSync(configPath);

describe.skipIf(!hasLocalConfig)("configured Godot headless integration", () => {
  it("passes environment diagnostics", async () => {
    const result = await runDoctor(configPath);
    expect(result.ok).toBe(true);
  });

  it.each([
    ["minimal-2d", "GODOT_AGENT_RUNTIME_READY:minimal-2d"],
    ["minimal-3d", "GODOT_AGENT_RUNTIME_READY:minimal-3d"],
    ["control-ui", "GODOT_AGENT_RUNTIME_READY:control-ui"],
  ])(
    "imports and runs the %s scene",
    async (projectName, readyMarker) => {
      const projectPath = resolve("examples", projectName);
      const check = await checkProject({ projectPath, configPath, timeoutMs: 45_000 });
      expect(check.ok, JSON.stringify(check.diagnostics)).toBe(true);

      const run = await runProject({ projectPath, configPath, timeoutMs: 45_000 });
      expect(run.ok, JSON.stringify(run.diagnostics)).toBe(true);
      expect(`${run.stdout}\n${run.stderr}`).toContain(readyMarker);
    },
    70_000,
  );

  it("checks one GDScript file without accessing user Godot directories", async () => {
    const fixture = resolve("tests", "fixtures", "script-check");
    const poisonedGlobalPath = resolve(
      await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-global-config-")),
      "must-not-be-accessed",
    );
    const originalEnvironment = {
      APPDATA: process.env.APPDATA,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
      GODOT_USER_DATA_DIR: process.env.GODOT_USER_DATA_DIR,
    };

    try {
      await writeFile(poisonedGlobalPath, "unchanged", "utf8");
      process.env.APPDATA = poisonedGlobalPath;
      process.env.LOCALAPPDATA = poisonedGlobalPath;
      process.env.XDG_DATA_HOME = poisonedGlobalPath;
      process.env.XDG_CONFIG_HOME = poisonedGlobalPath;
      process.env.XDG_CACHE_HOME = poisonedGlobalPath;
      process.env.GODOT_USER_DATA_DIR = poisonedGlobalPath;

      const isolatedEnvironment = await prepareHostEnvironment(fixture);
      expect(isolatedEnvironment.GODOT_USER_DATA_DIR).toBe(
        resolve(fixture, ".godot", "agent-runtime-host", "data"),
      );

      const valid = await checkScript({
        projectPath: fixture,
        path: "res://valid.gd",
        configPath,
        timeoutMs: 45_000,
      });
      expect(valid.ok, JSON.stringify(valid.diagnostics)).toBe(true);

      const uppercaseExtension = await checkScript({
        projectPath: fixture,
        path: "res://valid-uppercase.GD",
        configPath,
        timeoutMs: 45_000,
      });
      expect(uppercaseExtension.ok, JSON.stringify(uppercaseExtension.diagnostics)).toBe(true);
      expect(ScriptCheckResultSchema.parse(uppercaseExtension)).toEqual(uppercaseExtension);

      const invalid = await checkScript({
        projectPath: fixture,
        path: "res://invalid.gd",
        configPath,
        timeoutMs: 45_000,
      });
      expect(invalid.ok).toBe(false);
      expect(invalid.diagnostics.some((item) => item.severity === "error")).toBe(true);
      expect(await readFile(poisonedGlobalPath, "utf8")).toBe("unchanged");
    } finally {
      for (const [name, value] of Object.entries(originalEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(resolve(poisonedGlobalPath, ".."), { recursive: true });
    }
  }, 100_000);
});
