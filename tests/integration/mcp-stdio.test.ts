import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

interface StdioRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}

async function runChild(command: string, args: string[]): Promise<StdioRun> {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((complete, reject) => {
    child.once("error", reject);
    child.once("close", complete);
  });
  return { stdout, stderr, code };
}

beforeAll(async () => {
  const compiler = resolve(process.cwd(), "node_modules", "typescript", "bin", "tsc");
  const built = await runChild(process.execPath, [compiler, "-b", "packages/mcp-server", "--pretty", "false"]);
  if (built.code !== 0) throw new Error(`MCP fixture build failed:\n${built.stdout}${built.stderr}`);
});

async function runStdio(debug: boolean): Promise<StdioRun> {
  const executable = resolve(process.cwd(), "packages", "mcp-server", "dist", "bin.js");
  const projectPath = resolve(process.cwd(), "examples", "minimal-2d");
  const child = spawn(process.execPath, [executable], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      GODOT_AGENT_RUNTIME_MCP_DEBUG: debug ? "1" : "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stdio-test", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "godot_project_inspect", arguments: { projectPath } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "godot_run_status", arguments: { projectPath: "token=stdio-secret", runId: "00000000-0000-4000-8000-000000000000" } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "godot_log_read", arguments: { projectPath, runId: "invalid-uuid-schema-secret" } } },
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "godot_log_read", arguments: { projectPath, runId: "00000000-0000-4000-8000-000000000000", extraField: "extra-field-schema-secret" } } },
  ];
  child.stdin.end(`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`);
  const code = await new Promise<number | null>((complete, reject) => {
    child.once("error", reject);
    child.once("close", complete);
  });
  return { stdout, stderr, code };
}

describe("real MCP stdio separation", () => {
  for (const debug of [false, true]) {
    it(`keeps protocol stdout parseable and fixed-field logs on stderr with debug=${debug}`, async () => {
      const result = await runStdio(debug);
      expect(result.code).toBe(0);
      const frames = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(frames.map(({ id }) => id).filter(Boolean).sort()).toEqual([1, 2, 3, 4, 5, 6]);
      expect(result.stdout).not.toContain("mcpCall");
      expect(result.stderr).not.toContain("stdio-secret");
      expect(result.stderr).not.toContain("schema-secret");
      const records = result.stderr.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records).toHaveLength(debug ? 4 : 3);
      for (const record of records) {
        expect(Object.keys(record).sort()).toEqual(["code", "durationMs", "ok", "stage", "tool"]);
      }
      expect(records.find(({ tool }) => tool === "godot_run_status")).toMatchObject({
        tool: "godot_run_status",
        ok: false,
        code: "RUN_NOT_FOUND",
        stage: "discovery",
      });
      expect(records.filter(({ code }) => code === "MCP_INPUT_INVALID")).toEqual([
        expect.objectContaining({ tool: "godot_log_read", ok: false, stage: "validation" }),
        expect.objectContaining({ tool: "godot_log_read", ok: false, stage: "validation" }),
      ]);
    });
  }
});
