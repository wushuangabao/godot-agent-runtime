import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runCli } from "@godot-agent-runtime/cli";
import {
  configureDistribution,
  createNpmDistribution,
  RUNTIME_PACKAGE_VERSION,
  toRuntimeError,
} from "@godot-agent-runtime/core";
import { serveMcpStdio } from "@godot-agent-runtime/mcp-server";

export interface ReleaseCommandPorts {
  readonly configureDistribution: () => void;
  readonly runCli: (argv: readonly string[]) => Promise<void>;
  readonly serveMcpStdio: () => Promise<void>;
}

function createDefaultPorts(): ReleaseCommandPorts {
  return {
    configureDistribution: () => {
      configureDistribution(
        createNpmDistribution(import.meta.url, RUNTIME_PACKAGE_VERSION),
      );
    },
    runCli,
    serveMcpStdio,
  };
}

export async function dispatchReleaseCommand(
  argv: readonly string[],
  ports: ReleaseCommandPorts = createDefaultPorts(),
): Promise<void> {
  ports.configureDistribution();
  if (argv[0] === "mcp") {
    if (argv.length !== 1) {
      throw new Error("mcp does not accept command-line arguments.");
    }
    await ports.serveMcpStdio();
    return;
  }
  await ports.runCli(argv);
}

const invokedAsMain = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedAsMain) {
  try {
    await dispatchReleaseCommand(process.argv.slice(2));
  } catch (error) {
    if (process.argv[2] === "mcp") {
      console.error(error instanceof Error ? error.message : String(error));
    } else {
      process.stdout.write(`${JSON.stringify({ ok: false, error: toRuntimeError(error) }, null, 2)}\n`);
    }
    process.exitCode = 1;
  }
}
