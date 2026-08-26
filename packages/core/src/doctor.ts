import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";

import {
  EDITOR_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  RUNTIME_PROTOCOL_VERSION,
  type DoctorResult,
} from "@godot-agent-runtime/protocol";

import { loadDevelopmentConfig, resolveConfigPath } from "./config.js";
import { toRuntimeError } from "./errors.js";
import { runProcess } from "./process.js";

async function checkLoopback(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Loopback listener did not return a TCP address."));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

async function checkClientConfiguration(
  root: string,
  target: "codex" | "deepseek-harness",
): Promise<DoctorResult["checks"][number]> {
  const path =
    target === "codex"
      ? resolve(root, ".codex", "config.toml")
      : resolve(root, ".dsh", "godot-agent-runtime.patch.yml");
  try {
    const source = await readFile(path, "utf8");
    let configured = false;
    if (target === "codex") {
      configured = /\[mcp_servers\.godot-agent-runtime\]/.test(source);
    } else {
      configured =
        /name:\s*['"]?@deepseek-ai\/dsh-mcp-client['"]?/.test(source) &&
        /serverName:\s*['"]?godot['"]?/.test(source);
    }
    return {
      name: `client-${target}`,
      status: configured ? "pass" : "warning",
      summary: configured
        ? `${target} project MCP configuration is present.`
        : `${target} configuration exists but does not register godot-agent-runtime.`,
      details: { path },
      ...(configured
        ? {}
        : { recovery: [`Run configure ${target} from the Godot Agent Runtime CLI.`] }),
    };
  } catch (error) {
    return {
      name: `client-${target}`,
      status: "warning",
      summary: `${target} project MCP configuration was not found or could not be parsed.`,
      details: { path, cause: error instanceof Error ? error.message : String(error) },
      recovery: [`Run configure ${target} from the Godot Agent Runtime CLI.`],
    };
  }
}

export async function runDoctor(configPath?: string): Promise<DoctorResult> {
  const checks: DoctorResult["checks"] = [];
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  checks.push({
    name: "node",
    status: nodeMajor >= 20 ? "pass" : "fail",
    summary: `Node.js ${process.versions.node}`,
    details: { required: ">=20.0.0", executable: process.execPath },
    ...(nodeMajor >= 20
      ? {}
      : { recovery: ["Install Node.js 20 or newer."] }),
  });

  try {
    const resolvedConfigPath = await resolveConfigPath(configPath);
    const config = await loadDevelopmentConfig(resolvedConfigPath);
    checks.push({
      name: "configuration",
      status: "pass",
      summary: "Development configuration matches schema version 1.",
      details: { configPath: resolvedConfigPath },
    });

    await access(config.godot.executable, constants.X_OK);
    const version = await runProcess(config.godot.executable, ["--headless", "--version"], {
      timeoutMs: 10_000,
      maxOutputBytes: 8 * 1024,
    });
    const versionText = `${version.stdout}\n${version.stderr}`.trim();
    checks.push({
      name: "godot",
      status: version.exitCode === 0 && versionText ? "pass" : "fail",
      summary: versionText || "Godot did not report a version.",
      details: {
        executable: config.godot.executable,
        exitCode: version.exitCode,
      },
      ...(version.exitCode === 0 && versionText
        ? {}
        : { recovery: ["Configure a runnable Godot 4.x editor executable."] }),
    });

    if (config.deepseekHarness) {
      const packageFile = resolve(config.deepseekHarness.root, "package.json");
      const metadata = JSON.parse(await readFile(packageFile, "utf8")) as {
        name?: string;
        version?: string;
      };
      checks.push({
        name: "deepseek-harness",
        status: metadata.name === "@deepseek-ai/dsh-root" ? "pass" : "warning",
        summary: `${metadata.name ?? "unknown package"} ${metadata.version ?? "unknown version"}`,
        details: { root: config.deepseekHarness.root },
        ...(metadata.name === "@deepseek-ai/dsh-root"
          ? {}
          : { recovery: ["Point deepseekHarness.root to the official checkout."] }),
      });
    }
  } catch (error) {
    const payload = toRuntimeError(error);
    checks.push({
      name: payload.stage === "configuration" ? "configuration" : "godot",
      status: "fail",
      summary: payload.message,
      details: payload.details,
      recovery: payload.recovery,
    });
  }

  try {
    const port = await checkLoopback();
    checks.push({
      name: "loopback",
      status: "pass",
      summary: "A loopback TCP listener can bind successfully.",
      details: { host: "127.0.0.1", probePort: port },
    });
  } catch (error) {
    checks.push({
      name: "loopback",
      status: "fail",
      summary: error instanceof Error ? error.message : String(error),
      recovery: ["Allow local loopback TCP listeners in the host firewall policy."],
    });
  }

  checks.push(
    await checkClientConfiguration(process.cwd(), "codex"),
    await checkClientConfiguration(process.cwd(), "deepseek-harness"),
  );

  return {
    ok: checks.every((check) => check.status !== "fail"),
    protocolVersion: PROTOCOL_VERSION,
    protocolVersions: {
      editor: EDITOR_PROTOCOL_VERSION,
      runtime: RUNTIME_PROTOCOL_VERSION,
    },
    checks,
  };
}
