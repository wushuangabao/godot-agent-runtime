import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { configureClient } from "../../../packages/core/dist/index.js";

const task = "milestone-4-codex-deepseek-harness-adapter-conformance";
const startedAt = performance.now();
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const artifactDirectory = resolve("artifacts", "milestone-4", timestamp);
const serverPath = resolve("packages", "mcp-server", "dist", "bin.js");
const projectPath = process.cwd();
const requiredTools = [
  "godot_doctor",
  "godot_project_check",
  "godot_scene_launch",
  "godot_runtime_screenshot",
  "godot_runtime_ui_find",
  "godot_runtime_input",
  "godot_runtime_wait",
  "godot_runtime_assert",
  "godot_run_stop",
  "godot_editor_screenshot",
  "godot_runtime_3d_project",
  "godot_runtime_3d_raycast",
];
const steps = [];

async function runCaptured(command, args, options) {
  return await new Promise((resolveProcess, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill(), 30_000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (exitCode) => {
      clearTimeout(timeout);
      resolveProcess({ exitCode: exitCode ?? 1, stdout, stderr });
    });
  });
}

async function step(name, operation) {
  const stepStartedAt = performance.now();
  try {
    const result = await operation();
    steps.push({ name, ok: true, durationMs: Math.round(performance.now() - stepStartedAt) });
    return result;
  } catch (error) {
    steps.push({
      name,
      ok: false,
      durationMs: Math.round(performance.now() - stepStartedAt),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

await mkdir(artifactDirectory, { recursive: true });

let client;
let report;
try {
  const codex = await step("configure-codex", async () =>
    await configureClient({ target: "codex", projectPath, serverPath }),
  );
  const deepseekHarness = await step("configure-deepseek-harness", async () =>
    await configureClient({ target: "deepseek-harness", projectPath, serverPath }),
  );
  const codexSource = await readFile(codex.path, "utf8");
  const deepseekSource = await readFile(deepseekHarness.path, "utf8");
  await step("validate-client-configurations", async () => {
    if (!codexSource.includes("[mcp_servers.godot-agent-runtime]")) {
      throw new Error("Codex MCP configuration is missing its managed server table.");
    }
    if (!deepseekSource.includes("name: '@deepseek-ai/dsh-mcp-client'") ||
        !deepseekSource.includes("serverName: godot")) {
      throw new Error("DeepSeek Harness Cordis overlay is missing the MCP client registration.");
    }
  });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: projectPath,
    stderr: "pipe",
  });
  client = new Client({ name: "milestone-4-adapter-benchmark", version: "0.1.0" });
  await step("connect-generated-stdio-command", async () => await client.connect(transport));
  const listed = await step("list-structured-tools", async () => await client.listTools());
  const toolNames = new Set(listed.tools.map((tool) => tool.name));
  const missingTools = requiredTools.filter((name) => !toolNames.has(name));
  if (missingTools.length > 0) {
    throw new Error(`Required cross-agent tools are missing: ${missingTools.join(", ")}`);
  }
  for (const tool of listed.tools) {
    if (tool.inputSchema?.type !== "object" || tool.outputSchema === undefined) {
      throw new Error(`Tool ${tool.name} does not expose strict input/output schemas.`);
    }
  }
  const inspected = await step("call-project-inspection-over-stdio", async () =>
    await client.callTool({
      name: "godot_project_inspect",
      arguments: { projectPath: resolve("examples", "control-ui") },
    }),
  );
  if (inspected.isError === true ||
      inspected.structuredContent?.name !== "Godot Agent Runtime Control UI") {
    throw new Error("Generated stdio command did not return structured project metadata.");
  }

  const developmentConfig = JSON.parse(
    await readFile(resolve("config", "development.local.json"), "utf8"),
  );
  const harnessRoot = developmentConfig.deepseekHarness?.root;
  let harness = { configured: false, dependenciesReady: false, smoke: { executed: false } };
  if (typeof harnessRoot === "string") {
    const metadata = JSON.parse(await readFile(resolve(harnessRoot, "package.json"), "utf8"));
    if (metadata.name !== "@deepseek-ai/dsh-root") {
      throw new Error(`Configured DeepSeek Harness root contains ${metadata.name ?? "unknown"}.`);
    }
    const builtBin = resolve(harnessRoot, "apps", "cli", "lib", "bin.js");
    const dependenciesReady =
      existsSync(builtBin) || existsSync(resolve(harnessRoot, "node_modules"));
    let smoke = { executed: false };
    if (existsSync(builtBin)) {
      const dshHome = await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-dsh-home-"));
      try {
        const environment = {
          ...process.env,
          DSH_HOME: dshHome,
          DSH_TOOLS_MODE: "native",
          DSH_TELEMETRY_MODE: "DISABLED",
        };
        const dump = await step("compose-dsh-headless-profile", async () =>
          await runCaptured(
            process.execPath,
            [builtBin, "--profile", "headless", "--patch", deepseekHarness.path, "--dump-config"],
            { cwd: projectPath, env: environment },
          ),
        );
        if (dump.exitCode !== 0 ||
            !dump.stdout.includes("name: '@deepseek-ai/dsh-mcp-client'") ||
            !dump.stdout.includes("serverName: godot")) {
          throw new Error(`DSH config composition failed: ${dump.stderr || dump.stdout}`);
        }
        const help = await step("boot-dsh-headless-with-mcp", async () =>
          await runCaptured(
            process.execPath,
            [builtBin, "--profile", "headless", "--patch", deepseekHarness.path, "--help"],
            { cwd: projectPath, env: environment },
          ),
        );
        if (help.exitCode !== 0 || !help.stdout.includes("Usage: dsh --profile headless")) {
          throw new Error(`DSH Headless boot failed: ${help.stderr || help.stdout}`);
        }
        smoke = {
          executed: true,
          ok: true,
          profile: "headless",
          projectCwd: projectPath,
          mcpServerName: "godot",
        };
      } finally {
        await rm(dshHome, { recursive: true, force: true });
      }
    }
    harness = {
      configured: true,
      root: harnessRoot,
      version: metadata.version ?? null,
      dependenciesReady,
      smoke,
    };
  }

  report = {
    ok: true,
    task,
    protocol: "stdio",
    clients: [
      { name: "codex", configuration: codex },
      {
        name: "deepseek-harness",
        configuration: deepseekHarness,
        toolPrefix: "mcp__godot__",
        harness,
      },
    ],
    mcp: {
      toolCount: listed.tools.length,
      requiredTools,
      missingTools,
      structuredResult: inspected.structuredContent,
    },
    liveAgentBenchmark: {
      task: resolve("tests", "agent-benchmarks", "deepseek-harness", "task.md"),
      reportSchema: resolve("tests", "agent-benchmarks", "deepseek-harness", "report.schema.json"),
      ready: harness.dependenciesReady && harness.smoke.ok === true,
      executed: false,
      reason: harness.dependenciesReady
        ? "Run the headless task with the adapter launcher and configured model credentials."
        : "The DSH checkout is present but its dependencies/build artifacts are not installed.",
    },
    steps,
    durationMs: Math.round(performance.now() - startedAt),
  };
} catch (error) {
  report = {
    ok: false,
    task,
    error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
    steps,
    durationMs: Math.round(performance.now() - startedAt),
  };
  process.exitCode = 1;
} finally {
  if (client !== undefined) await client.close().catch(() => undefined);
  const reportPath = resolve(artifactDirectory, "report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`);
}
