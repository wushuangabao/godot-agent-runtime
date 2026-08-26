import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const PACKAGE_NAME = "godot-agent-runtime";
const PACKAGE_VERSION = "0.2.0";
const GODOT_EXECUTABLE = "D:\\Godot\\Godot_v4.6.2-stable_win64.exe";
const REPOSITORY_ROOT = resolve();
const ALLOWLIST_PATH = resolve("tests", "fixtures", "npm-package-allowlist.json");
const MCP_BASELINE_PATH = resolve("tests", "fixtures", "mcp-tool-baseline-0.1.json");
const NPM_FILES = [
  "dist/npm/bin/",
  "dist/npm/assets/",
  "README.md",
  "LICENSE",
  "LICENSING.md",
];
const PRODUCTION_DEPENDENCIES = ["@modelcontextprotocol/server", "zod"];
const ADDON_FILES = [
  "LICENSE",
  "plugin.cfg",
  "plugin.gd",
  "editor_bridge.gd",
  "runtime_entry.gd",
];

class VerificationFailure extends Error {
  constructor(stage, message, details = {}) {
    super(message);
    this.name = "VerificationFailure";
    this.stage = stage;
    this.details = details;
  }
}

function assert(condition, stage, message, details = {}) {
  if (!condition) throw new VerificationFailure(stage, message, details);
}

function parseArguments(argv) {
  if (argv.length === 0) return { packageSpec: null };
  assert(
    argv.length === 2 && argv[0] === "--package-spec",
    "arguments",
    "Usage: node scripts/verify-npm-package.mjs [--package-spec godot-agent-runtime@0.2.0]",
    { argv },
  );
  assert(
    argv[1] === `${PACKAGE_NAME}@${PACKAGE_VERSION}`,
    "arguments",
    `--package-spec must be exactly ${PACKAGE_NAME}@${PACKAGE_VERSION}.`,
    { packageSpec: argv[1] },
  );
  return { packageSpec: argv[1] };
}

function toolInvocation(tool, args) {
  if (process.platform !== "win32") return { command: tool, args };
  const toolScript = resolve(
    dirname(process.execPath),
    "node_modules",
    tool === "npm" ? "npm/bin/npm-cli.js" : "corepack/dist/pnpm.js",
  );
  assert(
    existsSync(toolScript),
    "release_environment",
    `Could not locate the ${tool} JavaScript launcher beside Node.js.`,
    { toolScript, node: process.execPath },
  );
  return { command: process.execPath, args: [toolScript, ...args] };
}

async function run(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const child = spawn(command, args, {
    cwd: options.cwd ?? REPOSITORY_ROOT,
    env: options.env ?? process.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  const exitCode = await new Promise((complete, reject) => {
    child.once("error", reject);
    child.once("close", complete);
  }).finally(() => clearTimeout(timer));
  const result = {
    command: [command, ...args],
    cwd: options.cwd ?? REPOSITORY_ROOT,
    exitCode,
    timedOut,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
  if (exitCode !== 0 || timedOut) {
    throw new VerificationFailure(
      options.stage ?? "process",
      `${options.label ?? command} failed.`,
      result,
    );
  }
  return result;
}

async function runTool(tool, args, options = {}) {
  const invocation = toolInvocation(tool, args);
  return await run(invocation.command, invocation.args, options);
}

function parseJsonOutput(result, stage) {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new VerificationFailure(stage, "A command did not return valid JSON.", {
      stdout: result.stdout,
      stderr: result.stderr,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

async function buildAndPack(packDirectory) {
  await runTool("pnpm", ["run", "build:npm"], {
    label: "pnpm run build:npm",
    stage: "build",
  });

  const expectedFiles = JSON.parse(await readFile(ALLOWLIST_PATH, "utf8"));
  const dryRun = parseJsonOutput(await runTool(
    "npm",
    ["pack", "--dry-run", "--ignore-scripts", "--json"],
    { label: "npm pack --dry-run", stage: "pack" },
  ), "pack");
  assert(Array.isArray(dryRun) && dryRun.length === 1, "pack", "npm pack returned an unexpected payload.", { dryRun });
  const actualFiles = dryRun[0].files
    .map(({ path }) => path.replace(/^package\//u, ""))
    .sort();
  assert(
    JSON.stringify(actualFiles) === JSON.stringify([...expectedFiles].sort()),
    "pack",
    "npm pack file list does not match the release allowlist.",
    { expectedFiles, actualFiles },
  );

  const packed = parseJsonOutput(await runTool(
    "npm",
    [
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      packDirectory,
    ],
    { label: "npm pack", stage: "pack" },
  ), "pack");
  assert(Array.isArray(packed) && packed.length === 1, "pack", "npm pack did not produce exactly one tarball.", { packed });
  const tarballPath = resolve(packDirectory, packed[0].filename);
  const bytes = await readFile(tarballPath);
  const sha512 = createHash("sha512").update(bytes).digest("base64");
  assert(
    packed[0].integrity === `sha512-${sha512}`,
    "pack",
    "npm pack integrity does not match the tarball bytes.",
    { expected: packed[0].integrity, actual: `sha512-${sha512}` },
  );
  return { packageSpec: tarballPath, tarballPath, sha512, fileCount: actualFiles.length };
}

async function installConsumer(consumerDirectory, packageSpec) {
  await runTool("npm", ["init", "-y"], {
    cwd: consumerDirectory,
    label: "npm init",
    stage: "consumer_install",
  });
  await runTool(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", packageSpec],
    {
      cwd: consumerDirectory,
      label: `npm install ${packageSpec}`,
      stage: "release_environment",
      timeoutMs: 180_000,
    },
  );
  const packageDirectory = resolve(consumerDirectory, "node_modules", PACKAGE_NAME);
  const packageManifest = JSON.parse(await readFile(resolve(packageDirectory, "package.json"), "utf8"));
  assert(packageManifest.name === PACKAGE_NAME, "consumer_install", "Installed package name is incorrect.", { name: packageManifest.name });
  assert(packageManifest.version === PACKAGE_VERSION, "consumer_install", "Installed package version is incorrect.", { version: packageManifest.version });
  assert(packageManifest.private === undefined, "consumer_install", "Installed package must not be private.");
  assert(
    JSON.stringify(packageManifest.bin) === JSON.stringify({
      [PACKAGE_NAME]: "dist/npm/bin/godot-agent-runtime.js",
    }),
    "consumer_install",
    "Installed package bin contract is incorrect.",
    { bin: packageManifest.bin },
  );
  assert(
    JSON.stringify(packageManifest.files) === JSON.stringify(NPM_FILES),
    "consumer_install",
    "Installed package files contract is incorrect.",
    { files: packageManifest.files },
  );
  const dependencyFamilies = Object.keys(packageManifest.dependencies ?? {}).sort();
  assert(
    JSON.stringify(dependencyFamilies) === JSON.stringify(PRODUCTION_DEPENDENCIES),
    "consumer_install",
    "Installed package production dependencies are incorrect.",
    { dependencyFamilies },
  );

  const dependencyTree = parseJsonOutput(await runTool(
    "npm",
    ["ls", "--omit=dev", "--all", "--json"],
    { cwd: consumerDirectory, label: "npm ls --omit=dev", stage: "consumer_install" },
  ), "consumer_install");
  const packageNode = dependencyTree.dependencies?.[PACKAGE_NAME];
  assert(packageNode?.version === PACKAGE_VERSION, "consumer_install", "npm ls did not resolve the expected public package.", { packageNode });
  for (const family of PRODUCTION_DEPENDENCIES) {
    assert(packageNode.dependencies?.[family] !== undefined, "consumer_install", `npm ls is missing ${family}.`, { packageNode });
  }

  const executable = await realpath(resolve(
    packageDirectory,
    "dist",
    "npm",
    "bin",
    "godot-agent-runtime.js",
  ));
  const repositoryRelativeExecutable = relative(REPOSITORY_ROOT, executable);
  const executableIsInsideRepository = repositoryRelativeExecutable === ""
    || (!repositoryRelativeExecutable.startsWith("..")
      && !isAbsolute(repositoryRelativeExecutable));
  assert(
    !executableIsInsideRepository,
    "consumer_install",
    "The verified executable resolves inside the source repository.",
    { executable, repositoryRoot: REPOSITORY_ROOT, repositoryRelativeExecutable },
  );
  const executableSource = await readFile(executable, "utf8");
  assert(!executableSource.includes(REPOSITORY_ROOT), "consumer_install", "The installed executable embeds the source repository path.");
  return { packageDirectory, packageManifest, dependencyTree, executable };
}

async function verifyCli(executable, consumerDirectory) {
  const help = await run(process.execPath, [executable, "--help"], {
    cwd: consumerDirectory,
    label: "installed CLI help",
    stage: "cli",
  });
  assert(help.stdout.includes("setup codex"), "cli", "Installed CLI help does not advertise setup codex.");
  assert(help.stdout.includes("editor-launch"), "cli", "Installed CLI help does not advertise editor-launch.");
  const version = await run(process.execPath, [executable, "--version"], {
    cwd: consumerDirectory,
    label: "installed CLI version",
    stage: "cli",
  });
  assert(version.stdout === PACKAGE_VERSION, "cli", "Installed CLI version is incorrect.", { stdout: version.stdout });
}

async function verifyMcp(executable, consumerDirectory) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [executable, "mcp"],
    cwd: consumerDirectory,
    env: Object.fromEntries(
      Object.entries(process.env)
        .filter((entry) => typeof entry[1] === "string")
        .concat([["GODOT_AGENT_RUNTIME_MCP_DEBUG", "0"]]),
    ),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.setEncoding("utf8");
  transport.stderr?.on("data", (chunk) => { stderr += chunk; });
  const client = new Client({ name: "npm-release-verifier", version: PACKAGE_VERSION });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const baseline = JSON.parse(await readFile(MCP_BASELINE_PATH, "utf8"));
    const currentNames = new Set(tools.map(({ name }) => name));
    const missingBaselineTools = baseline.capture.toolsList.tools
      .map(({ name }) => name)
      .filter((name) => !currentNames.has(name));
    const serializedTools = JSON.stringify(stable(tools));
    const instructions = client.getInstructions() ?? "";
    const compatibility = {
      baselineToolCount: baseline.toolCount,
      currentToolCount: tools.length,
      missingBaselineTools,
      toolSchemaBytes: Buffer.byteLength(serializedTools, "utf8"),
      instructionsBytes: Buffer.byteLength(instructions, "utf8"),
    };
    assert(client.getServerVersion()?.name === PACKAGE_NAME, "mcp", "MCP server name is incorrect.", { serverVersion: client.getServerVersion() });
    assert(client.getServerVersion()?.version === PACKAGE_VERSION, "mcp", "MCP server version is incorrect.", { serverVersion: client.getServerVersion() });
    assert(missingBaselineTools.length === 0, "mcp", "The public package removed tools from the frozen 0.1 baseline.", compatibility);
    assert(tools.length === 62, "mcp", "The public package did not advertise the 0.2 tool set.", compatibility);
    assert(compatibility.toolSchemaBytes <= 144_606, "mcp", "The public MCP schema exceeds its context budget.", compatibility);
    assert(compatibility.instructionsBytes <= 4_096, "mcp", "The public MCP instructions exceed their context budget.", compatibility);
    assert(stderr.trim() === "", "mcp", "MCP emitted unexpected diagnostics during initialize/list_tools.", { stderr });
    return compatibility;
  } finally {
    await client.close();
  }
}

async function writeGodotFixture(workspaceDirectory, projectDirectory) {
  await mkdir(resolve(workspaceDirectory, ".codex"), { recursive: true });
  await mkdir(resolve(projectDirectory, "addons", "existing"), { recursive: true });
  await writeFile(
    resolve(workspaceDirectory, ".codex", "config.toml"),
    '# npm verifier marker\nmodel = "gpt-5.6"\n',
    "utf8",
  );
  await writeFile(
    resolve(projectDirectory, "addons", "existing", "plugin.cfg"),
    '[plugin]\nname="Existing"\ndescription="Fixture plugin"\nauthor="Tests"\nversion="1.0.0"\nscript="plugin.gd"\n',
    "utf8",
  );
  await writeFile(
    resolve(projectDirectory, "addons", "existing", "plugin.gd"),
    "@tool\nextends EditorPlugin\n",
    "utf8",
  );
  await writeFile(
    resolve(projectDirectory, "main.tscn"),
    '[gd_scene format=3]\n\n[node name="Main" type="Node"]\n',
    "utf8",
  );
  await writeFile(
    resolve(projectDirectory, "project.godot"),
    [
      "config_version=5",
      "",
      "[application]",
      "",
      'run/main_scene="res://main.tscn"',
      "",
      "[editor_plugins]",
      "",
      'enabled=PackedStringArray("res://addons/existing/plugin.cfg", "godot_agent_runtime")',
      "",
      "[rendering]",
      "",
      'renderer/rendering_method="gl_compatibility"',
      'renderer/rendering_method.mobile="gl_compatibility"',
      "",
    ].join("\n"),
    "utf8",
  );
}

async function runCliJson(executable, args, cwd, timeoutMs = 120_000) {
  return parseJsonOutput(await run(process.execPath, [executable, ...args], {
    cwd,
    timeoutMs,
    label: `installed CLI ${args[0] ?? ""}`,
    stage: "godot",
  }), "godot");
}

async function verifySetupAndGodot(executable, workspaceDirectory, projectDirectory, activeRuns) {
  await writeGodotFixture(workspaceDirectory, projectDirectory);
  const setupArguments = [
    "setup",
    "codex",
    "--workspace",
    workspaceDirectory,
    "--godot-project",
    projectDirectory,
    "--godot",
    GODOT_EXECUTABLE,
  ];
  const first = await runCliJson(executable, setupArguments, workspaceDirectory);
  const second = await runCliJson(executable, setupArguments, workspaceDirectory);
  assert(first.packageVersion === PACKAGE_VERSION, "setup", "setup codex returned the wrong package version.", { first });
  assert(first.godotVersion === "4.6.2.stable.official.71f334935", "setup", "setup codex did not validate official Godot 4.6.2.", { first });
  assert(Array.isArray(first.targets) && first.targets.length === 8, "setup", "First setup did not report all eight targets.", { first });
  assert(second.targets?.length === 8 && second.targets.every(({ operation }) => operation === "unchanged"), "setup", "Second setup was not fully idempotent.", { second });

  const codexConfiguration = await readFile(resolve(workspaceDirectory, ".codex", "config.toml"), "utf8");
  assert(codexConfiguration.includes("# npm verifier marker"), "setup", "setup codex removed the caller's Codex marker.");
  assert(codexConfiguration.includes(`${PACKAGE_NAME}@${PACKAGE_VERSION}`), "setup", "setup codex did not pin the public package version.");
  const projectConfiguration = await readFile(resolve(projectDirectory, "project.godot"), "utf8");
  assert(projectConfiguration.includes('"res://addons/existing/plugin.cfg"'), "setup", "setup codex removed an existing EditorPlugin.");
  assert((projectConfiguration.match(/"res:\/\/addons\/godot_agent_runtime\/plugin\.cfg"/gu) ?? []).length === 1, "setup", "Canonical EditorPlugin path was not written exactly once.");
  assert(!projectConfiguration.includes('"godot_agent_runtime"'), "setup", "Legacy bare EditorPlugin name was not migrated.");
  for (const filename of ADDON_FILES) {
    assert(existsSync(resolve(projectDirectory, "addons", "godot_agent_runtime", filename)), "setup", `Installed addon is missing ${filename}.`);
  }

  const editor = await runCliJson(
    executable,
    ["editor-launch", projectDirectory, "--timeout", "30000"],
    workspaceDirectory,
    60_000,
  );
  assert(editor.state === "running" && typeof editor.runId === "string", "godot", "Official Godot editor did not enter running state.", { editor });
  activeRuns.push({ projectDirectory, runId: editor.runId });
  const editorStatus = await runCliJson(
    executable,
    ["editor-status", projectDirectory, editor.runId],
    workspaceDirectory,
  );
  assert(editorStatus.protocolVersion === "0.7.0", "godot", "Editor Bridge handshake returned the wrong protocol version.", { editorStatus });
  const stoppedEditor = await runCliJson(
    executable,
    ["stop", projectDirectory, editor.runId, "--timeout", "15000"],
    workspaceDirectory,
    30_000,
  );
  assert(stoppedEditor.state === "stopped", "godot", "Editor run did not stop cleanly.", { stoppedEditor });
  activeRuns.pop();

  const runtime = await runCliJson(
    executable,
    ["launch", projectDirectory, "--scene", "res://main.tscn", "--timeout", "30000"],
    workspaceDirectory,
    60_000,
  );
  assert(runtime.state === "running" && typeof runtime.runId === "string", "godot", "Official Godot runtime did not enter running state.", { runtime });
  activeRuns.push({ projectDirectory, runId: runtime.runId });
  const runtimeStatus = await runCliJson(
    executable,
    ["status", projectDirectory, runtime.runId],
    workspaceDirectory,
  );
  assert(runtimeStatus.state === "running" && runtimeStatus.runtimeBridgePort !== null, "godot", "Runtime Bridge status is not ready.", { runtimeStatus });
  const stoppedRuntime = await runCliJson(
    executable,
    ["stop", projectDirectory, runtime.runId, "--timeout", "15000"],
    workspaceDirectory,
    30_000,
  );
  assert(stoppedRuntime.state === "stopped", "godot", "Runtime run did not stop cleanly.", { stoppedRuntime });
  activeRuns.pop();
  return {
    godotVersion: first.godotVersion,
    editorProtocolVersion: editorStatus.protocolVersion,
    runtimeBridgeReady: runtimeStatus.runtimeBridgePort !== null,
  };
}

function assertSafeTemporaryRoot(path) {
  const temporaryBase = resolve(tmpdir());
  assert(
    isAbsolute(path)
      && dirname(path) === temporaryBase
      && basename(path).startsWith("godot-agent-runtime-npm-"),
    "cleanup",
    "Refusing to recursively remove an unexpected temporary path.",
    { path, temporaryBase },
  );
}

async function main() {
  const { packageSpec } = parseArguments(process.argv.slice(2));
  assert(existsSync(GODOT_EXECUTABLE), "release_environment", "Official Godot 4.6.2 is not installed at the release-gate path.", { godotExecutable: GODOT_EXECUTABLE });
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-npm-"));
  assertSafeTemporaryRoot(temporaryRoot);
  const packDirectory = resolve(temporaryRoot, "pack");
  const consumerDirectory = resolve(temporaryRoot, "consumer");
  const workspaceDirectory = resolve(temporaryRoot, "workspace");
  const projectDirectory = resolve(workspaceDirectory, "GodotPrj");
  const activeRuns = [];
  let summary;
  try {
    await Promise.all([
      mkdir(packDirectory, { recursive: true }),
      mkdir(consumerDirectory, { recursive: true }),
      mkdir(projectDirectory, { recursive: true }),
    ]);
    const source = packageSpec === null
      ? await buildAndPack(packDirectory)
      : { packageSpec, tarballPath: null, sha512: null, fileCount: null };
    const installed = await installConsumer(consumerDirectory, source.packageSpec);
    await verifyCli(installed.executable, consumerDirectory);
    const mcp = await verifyMcp(installed.executable, consumerDirectory);
    const godot = await verifySetupAndGodot(
      installed.executable,
      workspaceDirectory,
      projectDirectory,
      activeRuns,
    );
    summary = {
      ok: true,
      mode: packageSpec === null ? "local-tarball" : "registry",
      package: `${installed.packageManifest.name}@${installed.packageManifest.version}`,
      tarballSha512: source.sha512,
      packedFileCount: source.fileCount,
      productionDependencies: Object.keys(installed.packageManifest.dependencies).sort(),
      mcp,
      godot,
    };
  } finally {
    for (const active of activeRuns.reverse()) {
      try {
        await runCliJson(
          resolve(consumerDirectory, "node_modules", PACKAGE_NAME, "dist", "npm", "bin", "godot-agent-runtime.js"),
          ["stop", active.projectDirectory, active.runId, "--timeout", "15000"],
          workspaceDirectory,
          30_000,
        );
      } catch {
        // Preserve the primary verification error; the guarded temp cleanup follows.
      }
    }
    assertSafeTemporaryRoot(temporaryRoot);
    await rm(temporaryRoot, { recursive: true, force: true });
    assert(!existsSync(temporaryRoot), "cleanup", "Temporary release verification directory still exists.", { temporaryRoot });
  }
  process.stdout.write(`${JSON.stringify({ ...summary, temporaryDirectoriesCleaned: true }, null, 2)}\n`);
}

try {
  await main();
} catch (error) {
  const payload = error instanceof VerificationFailure
    ? { ok: false, stage: error.stage, message: error.message, details: error.details }
    : {
        ok: false,
        stage: "unexpected",
        message: error instanceof Error ? error.message : String(error),
      };
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = 1;
}
