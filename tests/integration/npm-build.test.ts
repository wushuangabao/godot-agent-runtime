import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { runProcess } from "../../packages/core/src/process.js";

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function filesUnder(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(resolve(root, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...await filesUnder(root, relativePath));
    } else {
      files.push(relativePath.replaceAll("\\", "/"));
    }
  }
  return files.sort();
}

describe("public npm build", () => {
  it("declares the exact root package contract and keeps internal packages private", async () => {
    const manifest = await json("package.json");
    expect(manifest).toMatchObject({
      name: "godot-agent-runtime",
      version: "0.2.0",
      type: "module",
      license: "AGPL-3.0-or-later",
      bin: {
        "godot-agent-runtime": "dist/npm/bin/godot-agent-runtime.js",
      },
      files: [
        "dist/npm/bin/",
        "dist/npm/assets/",
        "README.md",
        "LICENSE",
        "LICENSING.md",
      ],
      engines: { node: ">=20.0.0" },
      dependencies: {
        "@modelcontextprotocol/server": "^2.0.0",
        zod: "^4.4.3",
      },
      publishConfig: { access: "public" },
      description: "Local-first MCP and CLI runtime for coding agents to automate and verify Godot 4.x projects.",
      repository: {
        type: "git",
        url: "git+https://github.com/wushuangabao/godot-agent-runtime.git",
      },
      homepage: "https://github.com/wushuangabao/godot-agent-runtime#readme",
      bugs: {
        url: "https://github.com/wushuangabao/godot-agent-runtime/issues",
      },
      keywords: ["godot", "mcp", "codex", "automation", "testing", "agent"],
    });
    expect(manifest.private).toBeUndefined();
    expect(manifest.devDependencies).toMatchObject({ esbuild: "0.28.2" });

    const packageDirectories = (await readdir("packages", { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    for (const directory of packageDirectories) {
      const internal = await json(resolve("packages", directory, "package.json"));
      expect(internal.private, directory).toBe(true);
    }
  });

  it("builds one shebang executable and the exact runtime asset tree", async () => {
    const result = await runProcess(
      process.execPath,
      [resolve("scripts", "build-npm-package.mjs")],
      { timeoutMs: 90_000, maxOutputBytes: 128 * 1024 },
    );
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result.stderr).toBe("");

    expect(await filesUnder(resolve("dist", "npm"))).toEqual([
      "assets/addons/godot_agent_runtime/LICENSE",
      "assets/addons/godot_agent_runtime/editor_bridge.gd",
      "assets/addons/godot_agent_runtime/plugin.cfg",
      "assets/addons/godot_agent_runtime/plugin.gd",
      "assets/addons/godot_agent_runtime/runtime_entry.gd",
      "assets/host/run-host.mjs",
      "bin/godot-agent-runtime.js",
    ]);
    const executable = await readFile(
      resolve("dist", "npm", "bin", "godot-agent-runtime.js"),
      "utf8",
    );
    expect(executable.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(executable).not.toMatch(/from\s+["']@godot-agent-runtime\//);

    const version = await runProcess(process.execPath, [
      resolve("dist", "npm", "bin", "godot-agent-runtime.js"),
      "--version",
    ]);
    expect(version).toMatchObject({
      exitCode: 0,
      stdout: "0.2.0",
      stderr: "",
      timedOut: false,
    });

    const metadata = await json(resolve("dist", "npm-build-metafile.json"));
    expect(metadata.internalBareImports).toEqual([]);
    expect(metadata.externalFamilies).toEqual([
      "@modelcontextprotocol/server",
      "zod",
    ]);
  }, 120_000);
});
