#!/usr/bin/env node

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

function valueAfter(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value === "--") {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function usage() {
  process.stderr.write(
    "Usage: node adapters/deepseek-harness/run.mjs --harness-root PATH " +
      "[--project PATH] [--patch PATH] -- <task or DSH app arguments>\n",
  );
}

const args = process.argv.slice(2);
const separator = args.indexOf("--");
const launcherArgs = separator === -1 ? args : args.slice(0, separator);
const appArgs = separator === -1 ? [] : args.slice(separator + 1);
const harnessRootSource = valueAfter(launcherArgs, "--harness-root");

if (harnessRootSource === undefined || appArgs.length === 0) {
  usage();
  process.exitCode = 2;
} else {
  const harnessRoot = resolve(harnessRootSource);
  const projectPath = resolve(valueAfter(launcherArgs, "--project") ?? process.cwd());
  const patchPath = resolve(
    valueAfter(launcherArgs, "--patch") ??
      resolve(projectPath, ".dsh", "godot-agent-runtime.patch.yml"),
  );
  const manifestPath = resolve(harnessRoot, "package.json");
  const builtBin = resolve(harnessRoot, "apps", "cli", "lib", "bin.js");
  const sourceBin = resolve(harnessRoot, "apps", "cli", "src", "bin.ts");

  if (!existsSync(manifestPath)) {
    throw new Error(`DeepSeek Harness checkout was not found at ${harnessRoot}.`);
  }
  if (!existsSync(patchPath)) {
    throw new Error(
      `DeepSeek Harness patch was not found at ${patchPath}. Run configure deepseek-harness first.`,
    );
  }

  let nodeArgs;
  if (existsSync(builtBin)) {
    nodeArgs = [builtBin];
  } else {
    try {
      const requireFromHarness = createRequire(manifestPath);
      const tsxLoader = requireFromHarness.resolve("tsx/esm");
      nodeArgs = ["--import", pathToFileURL(tsxLoader).href, sourceBin];
    } catch (error) {
      throw new Error(
        "DeepSeek Harness is neither built nor dependency-installed. " +
          "Run pnpm install and pnpm build in its checkout before retrying.",
        { cause: error },
      );
    }
  }

  const child = spawn(
    process.execPath,
    [
      ...nodeArgs,
      "--profile",
      "headless",
      "--patch",
      patchPath,
      ...appArgs,
    ],
    {
      cwd: projectPath,
      env: { ...process.env, DSH_TOOLS_MODE: process.env.DSH_TOOLS_MODE ?? "native" },
      stdio: "inherit",
      windowsHide: true,
    },
  );

  child.once("error", (error) => {
    throw error;
  });
  child.once("exit", (code, signal) => {
    if (signal !== null) {
      process.stderr.write(`DeepSeek Harness exited from signal ${signal}.\n`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = code ?? 1;
  });
}
