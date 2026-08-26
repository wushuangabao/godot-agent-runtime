import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import * as clientConfigModule from "../../packages/core/src/client-config.js";
import * as core from "../../packages/core/src/index.js";

const { configureClient } = clientConfigModule;

const temporaryDirectories: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-config-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => await rm(path, { recursive: true })));
});

describe("client configuration", () => {
  it("plans without writing and applies an idempotent atomic client update", async () => {
    const projectPath = await temporaryRoot();
    const serverPath = resolve(projectPath, "server.js");
    await writeFile(serverPath, "", "utf8");
    const api = clientConfigModule as unknown as {
      planClientConfiguration(options: {
        target: "codex";
        projectPath: string;
        serverPath: string;
      }): Promise<{
        write: {
          path: string;
          operation: "created" | "updated" | "unchanged";
        };
      }>;
      applyClientConfigurationPlan(plan: unknown): Promise<{
        operation: "created" | "updated" | "unchanged";
      }>;
    };

    const firstPlan = await api.planClientConfiguration({
      target: "codex",
      projectPath,
      serverPath,
    });
    await expect(access(firstPlan.write.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(api.applyClientConfigurationPlan(firstPlan))
      .resolves.toMatchObject({ operation: "created" });

    const unchangedPlan = await api.planClientConfiguration({
      target: "codex",
      projectPath,
      serverPath,
    });
    const before = await stat(unchangedPlan.write.path);
    await expect(api.applyClientConfigurationPlan(unchangedPlan))
      .resolves.toMatchObject({ operation: "unchanged" });
    const after = await stat(unchangedPlan.write.path);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("rejects a client plan when the target changes before apply", async () => {
    const projectPath = await temporaryRoot();
    const serverPath = resolve(projectPath, "server.js");
    await writeFile(serverPath, "", "utf8");
    const targetPath = resolve(projectPath, ".codex", "config.toml");
    await mkdir(resolve(targetPath, ".."), { recursive: true });
    await writeFile(targetPath, "model = \"gpt-5\"\n", "utf8");
    const api = clientConfigModule as unknown as {
      planClientConfiguration(options: {
        target: "codex";
        projectPath: string;
        serverPath: string;
      }): Promise<unknown>;
      applyClientConfigurationPlan(plan: unknown): Promise<unknown>;
    };

    const plan = await api.planClientConfiguration({
      target: "codex",
      projectPath,
      serverPath,
    });
    await writeFile(targetPath, "model = \"gpt-5.1\"\n", "utf8");

    await expect(api.applyClientConfigurationPlan(plan)).rejects.toMatchObject({
      payload: { code: "ATOMIC_WRITE_CONFLICT", stage: "configuration" },
    });
    await expect(readFile(targetPath, "utf8")).resolves.toBe("model = \"gpt-5.1\"\n");
  });

  it("does not remove another process atomic-write lock", async () => {
    const projectPath = await temporaryRoot();
    const serverPath = resolve(projectPath, "server.js");
    await writeFile(serverPath, "", "utf8");
    const api = clientConfigModule as unknown as {
      planClientConfiguration(options: {
        target: "codex";
        projectPath: string;
        serverPath: string;
      }): Promise<{ write: { path: string } }>;
      applyClientConfigurationPlan(plan: unknown): Promise<unknown>;
    };
    const plan = await api.planClientConfiguration({
      target: "codex",
      projectPath,
      serverPath,
    });
    await mkdir(resolve(plan.write.path, ".."), { recursive: true });
    const lockPath = plan.write.path + ".godot-agent-runtime.lock";
    await writeFile(lockPath, "owned by another process", "utf8");

    await expect(api.applyClientConfigurationPlan(plan)).rejects.toMatchObject({
      payload: { code: "ATOMIC_WRITE_BUSY", stage: "configuration" },
    });
    await expect(access(lockPath)).resolves.toBeUndefined();
  });

  it("creates an idempotent project Codex managed section", async () => {
    const projectPath = await temporaryRoot();
    const serverPath = resolve(projectPath, "server.js");
    await writeFile(serverPath, "", "utf8");
    const first = await configureClient({ target: "codex", projectPath, serverPath });
    const second = await configureClient({ target: "codex", projectPath, serverPath });
    const content = await readFile(first.path, "utf8");

    expect(first.operation).toBe("created");
    expect(second.operation).toBe("unchanged");
    expect(first.serverPath).toBe(serverPath);
    expect(first.launcher).toEqual({
      command: process.execPath,
      args: [serverPath],
    });
    expect(content.match(/\[mcp_servers\.godot-agent-runtime\]/g)).toHaveLength(1);
  });

  it("preserves unrelated Claude MCP servers", async () => {
    const projectPath = await temporaryRoot();
    const serverPath = resolve(projectPath, "server.js");
    await writeFile(serverPath, "", "utf8");
    await writeFile(
      resolve(projectPath, ".mcp.json"),
      JSON.stringify({ mcpServers: { existing: { command: "existing" } } }),
      "utf8",
    );
    const result = await configureClient({ target: "claude-code", projectPath, serverPath });
    const value = JSON.parse(await readFile(result.path, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(value.mcpServers.existing).toBeDefined();
    expect(value.mcpServers["godot-agent-runtime"]).toBeDefined();
  });

  it("creates an idempotent DeepSeek Harness Cordis overlay", async () => {
    const projectPath = await temporaryRoot();
    const serverPath = resolve(projectPath, "server.js");
    await writeFile(serverPath, "", "utf8");
    const first = await configureClient({
      target: "deepseek-harness",
      projectPath,
      serverPath,
    });
    const second = await configureClient({
      target: "deepseek-harness",
      projectPath,
      serverPath,
    });
    const content = await readFile(first.path, "utf8");

    expect(first.operation).toBe("created");
    expect(second.operation).toBe("unchanged");
    expect(first.path).toBe(resolve(projectPath, ".dsh", "godot-agent-runtime.patch.yml"));
    expect(content).toContain("name: '@deepseek-ai/dsh-mcp-client'");
    expect(content).toContain("serverName: godot");
    expect(content).toContain(JSON.stringify(serverPath));
    expect(content).toContain(JSON.stringify(projectPath));
    expect(content).toContain("failOnStartupError: true");
  });

  it("writes the pinned npm launcher without a source server path", async () => {
    const projectPath = await temporaryRoot();
    const packageRoot = await temporaryRoot();
    const bin = resolve(packageRoot, "dist", "npm", "bin", "godot-agent-runtime.js");
    const addonRoot = resolve(
      packageRoot,
      "dist",
      "npm",
      "assets",
      "addons",
      "godot_agent_runtime",
    );
    const host = resolve(packageRoot, "dist", "npm", "assets", "host", "run-host.mjs");
    await mkdir(resolve(bin, ".."), { recursive: true });
    await mkdir(addonRoot, { recursive: true });
    await mkdir(resolve(host, ".."), { recursive: true });
    await writeFile(bin, "", "utf8");
    await writeFile(host, "", "utf8");
    for (const filename of [
      "LICENSE",
      "plugin.cfg",
      "plugin.gd",
      "editor_bridge.gd",
      "runtime_entry.gd",
    ]) {
      await writeFile(resolve(addonRoot, filename), filename, "utf8");
    }
    const distribution = core as unknown as {
      createNpmDistribution(anchorUrl: string, version: string): unknown;
      configureDistribution(layout: unknown): void;
    };
    distribution.configureDistribution(
      distribution.createNpmDistribution(pathToFileURL(bin).href, "0.2.0"),
    );

    const result = await configureClient({ target: "codex", projectPath });
    const content = await readFile(result.path, "utf8");

    expect(result.serverPath).toBeNull();
    expect(result.launcher).toEqual({
      command: "npx",
      args: ["-y", "godot-agent-runtime@0.2.0", "mcp"],
    });
    expect(content).toBe([
      "# >>> godot-agent-runtime managed section >>>",
      "[mcp_servers.godot-agent-runtime]",
      'command = "npx"',
      'args = ["-y", "godot-agent-runtime@0.2.0", "mcp"]',
      `cwd = ${JSON.stringify(projectPath)}`,
      "# <<< godot-agent-runtime managed section <<<",
      "",
    ].join("\n"));
  });
});
