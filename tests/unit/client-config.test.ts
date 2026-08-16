import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { configureClient } from "../../packages/core/src/client-config.js";

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
  it("creates an idempotent project Codex managed section", async () => {
    const projectPath = await temporaryRoot();
    const serverPath = resolve(projectPath, "server.js");
    await writeFile(serverPath, "", "utf8");
    const first = await configureClient({ target: "codex", projectPath, serverPath });
    const second = await configureClient({ target: "codex", projectPath, serverPath });
    const content = await readFile(first.path, "utf8");

    expect(first.operation).toBe("created");
    expect(second.operation).toBe("unchanged");
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
});
