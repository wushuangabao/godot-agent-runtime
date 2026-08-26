import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SetupCodexResultSchema,
} from "../../packages/protocol/src/index.js";
import {
  runProcess,
  setupCodex,
} from "../../packages/core/src/index.js";

const GODOT_EXECUTABLE = "D:\\Godot\\Godot_v4.6.2-stable_win64.exe";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(
      async (path) => await rm(path, { recursive: true, force: true }),
    ),
  );
});

describe.skipIf(!existsSync(GODOT_EXECUTABLE))("setup codex integration", () => {
  it("uses official Godot 4.6.2 and converges through the CLI", async () => {
    const workspacePath = await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-setup-integration-"));
    temporaryDirectories.push(workspacePath);
    const godotProjectPath = resolve(workspacePath, "GodotPrj");
    await mkdir(resolve(workspacePath, ".codex"), { recursive: true });
    await mkdir(godotProjectPath, { recursive: true });
    await writeFile(
      resolve(workspacePath, ".codex", "config.toml"),
      'model = "gpt-5.6"\n',
      "utf8",
    );
    await writeFile(
      resolve(godotProjectPath, "project.godot"),
      [
        "config_version=5",
        "",
        "[editor_plugins]",
        "",
        'enabled=PackedStringArray("res://addons/existing/plugin.cfg", "godot_agent_runtime")',
        "",
      ].join("\n"),
      "utf8",
    );

    const options = { workspacePath, godotProjectPath, godotExecutable: GODOT_EXECUTABLE };
    const first = SetupCodexResultSchema.parse(await setupCodex(options));
    const second = SetupCodexResultSchema.parse(await setupCodex(options));

    expect(first.godotVersion).toBe("4.6.2.stable.official.71f334935");
    expect(first.targets).toHaveLength(8);
    expect(second.targets).toHaveLength(8);
    expect(second.targets.every((target) => target.operation === "unchanged")).toBe(true);
    const codex = await readFile(resolve(workspacePath, ".codex", "config.toml"), "utf8");
    expect(codex).toContain('model = "gpt-5.6"');
    expect(codex).toContain('command = ');
    const project = await readFile(resolve(godotProjectPath, "project.godot"), "utf8");
    expect(project).toContain('"res://addons/existing/plugin.cfg"');
    expect(project.match(/"res:\/\/addons\/godot_agent_runtime\/plugin\.cfg"/g))
      .toHaveLength(1);
    expect(project).not.toContain('"godot_agent_runtime"');
    for (const filename of [
      "LICENSE",
      "plugin.cfg",
      "plugin.gd",
      "editor_bridge.gd",
      "runtime_entry.gd",
    ]) {
      expect(existsSync(resolve(
        godotProjectPath,
        "addons",
        "godot_agent_runtime",
        filename,
      ))).toBe(true);
    }

    const cli = await runProcess(
      process.execPath,
      [
        resolve("packages", "cli", "dist", "bin.js"),
        "setup",
        "codex",
        "--workspace",
        workspacePath,
        "--godot-project",
        godotProjectPath,
        "--godot",
        GODOT_EXECUTABLE,
      ],
      { timeoutMs: 30_000, maxOutputBytes: 64 * 1024 },
    );
    expect(cli.exitCode).toBe(0);
    expect(cli.stderr).toBe("");
    const cliResult = SetupCodexResultSchema.parse(JSON.parse(cli.stdout));
    expect(cliResult.targets.every((target) => target.operation === "unchanged")).toBe(true);

    const doctor = await runProcess(
      process.execPath,
      [resolve("packages", "cli", "dist", "bin.js"), "doctor"],
      { cwd: workspacePath, timeoutMs: 30_000, maxOutputBytes: 64 * 1024 },
    );
    expect(doctor.exitCode).toBe(0);
    const doctorResult = JSON.parse(doctor.stdout) as {
      checks: Array<{ name: string; details?: { configPath?: string } }>;
    };
    expect(doctorResult.checks.find((check) => check.name === "configuration"))
      .toMatchObject({
        details: {
          configPath: resolve(
            workspacePath,
            ".godot-agent-runtime",
            "config.local.json",
          ),
        },
      });
  }, 60_000);
});
