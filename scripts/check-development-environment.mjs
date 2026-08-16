import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = resolve(
  process.argv[2] ?? resolve(repositoryRoot, "config", "development.local.json"),
);
const checks = [];

function addCheck(name, ok, details) {
  checks.push({ name, ok, details });
}

function isFile(path) {
  return existsSync(path) && statSync(path).isFile();
}

function isDirectory(path) {
  return existsSync(path) && statSync(path).isDirectory();
}

let config;
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
  addCheck("config", config.schemaVersion === 1, {
    path: configPath,
    schemaVersion: config.schemaVersion,
  });
} catch (error) {
  addCheck("config", false, {
    path: configPath,
    message: error instanceof Error ? error.message : String(error),
  });
}

if (config) {
  const godotExecutable = config.godot?.executable;
  if (typeof godotExecutable !== "string" || !isFile(godotExecutable)) {
    addCheck("godot", false, {
      executable: godotExecutable,
      message: "Configured Godot executable does not exist.",
    });
  } else {
    const result = spawnSync(godotExecutable, ["--headless", "--version"], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    const version = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    addCheck("godot", result.status === 0 && version.length > 0, {
      executable: godotExecutable,
      version,
      exitCode: result.status,
      error: result.error?.message,
    });
  }

  const harnessRoot = config.deepseekHarness?.root;
  const harnessPackage =
    typeof harnessRoot === "string" ? resolve(harnessRoot, "package.json") : undefined;
  if (
    typeof harnessRoot !== "string" ||
    !isDirectory(harnessRoot) ||
    !harnessPackage ||
    !isFile(harnessPackage)
  ) {
    addCheck("deepseekHarness", false, {
      root: harnessRoot,
      message: "Configured DeepSeek Harness checkout is incomplete.",
    });
  } else {
    const packageMetadata = JSON.parse(readFileSync(harnessPackage, "utf8"));
    addCheck("deepseekHarness", packageMetadata.name === "@deepseek-ai/dsh-root", {
      root: harnessRoot,
      version: packageMetadata.version,
      packageManager: packageMetadata.packageManager,
      node: packageMetadata.engines?.node,
    });
  }
}

const output = {
  ok: checks.every((check) => check.ok),
  configPath,
  checks,
};

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
if (!output.ok) {
  process.exitCode = 1;
}
