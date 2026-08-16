import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  checkProject,
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
      const check = await checkProject({ projectPath, configPath, timeoutMs: 30_000 });
      expect(check.ok, JSON.stringify(check.diagnostics)).toBe(true);

      const run = await runProject({ projectPath, configPath, timeoutMs: 30_000 });
      expect(run.ok, JSON.stringify(run.diagnostics)).toBe(true);
      expect(`${run.stdout}\n${run.stderr}`).toContain(readyMarker);
    },
    70_000,
  );
});
