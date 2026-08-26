import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { build } from "esbuild";

const packageRoot = resolve("dist", "npm");
const executable = resolve(packageRoot, "bin", "godot-agent-runtime.js");
const externalFamilies = ["@modelcontextprotocol/server", "zod"];
const addonFiles = [
  "LICENSE",
  "plugin.cfg",
  "plugin.gd",
  "editor_bridge.gd",
  "runtime_entry.gd",
];

function familyFor(path) {
  return externalFamilies.find(
    (family) => path === family || path.startsWith(`${family}/`),
  );
}

await rm(packageRoot, { recursive: true, force: true });
await mkdir(resolve(packageRoot, "bin"), { recursive: true });
await mkdir(resolve(packageRoot, "assets", "addons", "godot_agent_runtime"), {
  recursive: true,
});
await mkdir(resolve(packageRoot, "assets", "host"), { recursive: true });

const result = await build({
  entryPoints: [resolve("packages", "release", "dist", "bin.js")],
  outfile: executable,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  sourcemap: false,
  metafile: true,
  logLevel: "silent",
  banner: { js: "#!/usr/bin/env node" },
  external: [
    "@modelcontextprotocol/server",
    "@modelcontextprotocol/server/*",
    "zod",
    "zod/*",
  ],
});

for (const filename of addonFiles) {
  await copyFile(
    resolve("addons", "godot_agent_runtime", filename),
    resolve(packageRoot, "assets", "addons", "godot_agent_runtime", filename),
  );
}
await copyFile(
  resolve("packages", "core", "host", "run-host.mjs"),
  resolve(packageRoot, "assets", "host", "run-host.mjs"),
);

const externalImports = Object.values(result.metafile.outputs)
  .flatMap((output) => output.imports)
  .filter((entry) => entry.external)
  .map((entry) => entry.path);
const internalBareImports = [...new Set(externalImports.filter(
  (path) => path.startsWith("@godot-agent-runtime/"),
))].sort();
const unexpectedExternalImports = [...new Set(externalImports.filter(
  (path) => !path.startsWith("node:") && familyFor(path) === undefined,
))].sort();

if (internalBareImports.length > 0 || unexpectedExternalImports.length > 0) {
  throw new Error(JSON.stringify({ internalBareImports, unexpectedExternalImports }));
}

const builtSource = await readFile(executable, "utf8");
if (/from\s+["']@godot-agent-runtime\//u.test(builtSource)) {
  throw new Error("The public executable contains a private workspace import.");
}

await writeFile(
  resolve("dist", "npm-build-metafile.json"),
  `${JSON.stringify({
    internalBareImports,
    externalFamilies: [...new Set(externalImports.map(familyFor).filter(Boolean))].sort(),
    unexpectedExternalImports,
    esbuild: result.metafile,
  }, null, 2)}\n`,
  "utf8",
);
