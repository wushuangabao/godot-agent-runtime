import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RuntimeFailure } from "./errors.js";

export const RUNTIME_PACKAGE_VERSION = "0.2.0" as const;

export type DistributionKind = "source" | "npm";

export interface ClientLauncher {
  readonly command: string;
  readonly args: readonly string[];
}

export interface DistributionLayout {
  readonly kind: DistributionKind;
  readonly version: string;
  readonly addonRoot: string;
  readonly hostScript: string;
  readonly mcpServerPath: string | null;
  readonly mcpLauncher: ClientLauncher;
}

const REQUIRED_ADDON_FILES = [
  "LICENSE",
  "plugin.cfg",
  "plugin.gd",
  "editor_bridge.gd",
  "runtime_entry.gd",
] as const;

let configuredDistribution: DistributionLayout | undefined;

function assertDistributionPath(
  kind: DistributionKind,
  asset: string,
  path: string,
  expectedType: "file" | "directory",
): void {
  try {
    const information = statSync(path);
    const valid = expectedType === "file"
      ? information.isFile()
      : information.isDirectory();
    if (valid) return;
  } catch {
    // Report every missing or unreadable asset through the stable boundary below.
  }
  throw new RuntimeFailure({
    code: "DISTRIBUTION_ASSET_MISSING",
    stage: "configuration",
    message: `The ${kind} distribution asset ${asset} is missing or unreadable.`,
    details: { kind, asset, path, expectedType },
    recovery: [
      kind === "source"
        ? "Build the repository and restore the checked-in runtime assets."
        : "Reinstall the exact npm package version and verify the package integrity.",
    ],
  });
}

function validateLayout(layout: DistributionLayout): DistributionLayout {
  assertDistributionPath(layout.kind, "addonRoot", layout.addonRoot, "directory");
  for (const filename of REQUIRED_ADDON_FILES) {
    assertDistributionPath(
      layout.kind,
      `addon:${filename}`,
      resolve(layout.addonRoot, filename),
      "file",
    );
  }
  assertDistributionPath(layout.kind, "hostScript", layout.hostScript, "file");
  if (layout.mcpServerPath !== null) {
    assertDistributionPath(
      layout.kind,
      "mcpServer",
      layout.mcpServerPath,
      "file",
    );
  }
  return Object.freeze({
    ...layout,
    mcpLauncher: Object.freeze({
      command: layout.mcpLauncher.command,
      args: Object.freeze([...layout.mcpLauncher.args]),
    }),
  });
}

export function createSourceDistribution(
  anchorUrl: string = import.meta.url,
): DistributionLayout {
  const directory = dirname(fileURLToPath(anchorUrl));
  const mcpServerPath = resolve(directory, "../../mcp-server/dist/bin.js");
  return validateLayout({
    kind: "source",
    version: RUNTIME_PACKAGE_VERSION,
    addonRoot: resolve(directory, "../../../addons/godot_agent_runtime"),
    hostScript: resolve(directory, "../host/run-host.mjs"),
    mcpServerPath,
    mcpLauncher: {
      command: process.execPath,
      args: [mcpServerPath],
    },
  });
}

export function createNpmDistribution(
  anchorUrl: string,
  version: string,
): DistributionLayout {
  const directory = dirname(fileURLToPath(anchorUrl));
  const assetRoot = resolve(directory, "../assets");
  return validateLayout({
    kind: "npm",
    version,
    addonRoot: resolve(assetRoot, "addons/godot_agent_runtime"),
    hostScript: resolve(assetRoot, "host/run-host.mjs"),
    mcpServerPath: null,
    mcpLauncher: {
      command: "npx",
      args: ["-y", `godot-agent-runtime@${version}`, "mcp"],
    },
  });
}

function sameLayout(left: DistributionLayout, right: DistributionLayout): boolean {
  return (
    left.kind === right.kind &&
    left.version === right.version &&
    left.addonRoot === right.addonRoot &&
    left.hostScript === right.hostScript &&
    left.mcpServerPath === right.mcpServerPath &&
    left.mcpLauncher.command === right.mcpLauncher.command &&
    left.mcpLauncher.args.length === right.mcpLauncher.args.length &&
    left.mcpLauncher.args.every(
      (argument, index) => argument === right.mcpLauncher.args[index],
    )
  );
}

export function configureDistribution(layout: DistributionLayout): void {
  if (configuredDistribution === undefined) {
    configuredDistribution = layout;
    return;
  }
  if (sameLayout(configuredDistribution, layout)) return;
  throw new RuntimeFailure({
    code: "DISTRIBUTION_ALREADY_CONFIGURED",
    stage: "configuration",
    message: "The runtime distribution was already configured for this process.",
    details: {
      configuredKind: configuredDistribution.kind,
      requestedKind: layout.kind,
      configuredVersion: configuredDistribution.version,
      requestedVersion: layout.version,
    },
    recovery: ["Start a fresh process for a different runtime distribution."],
  });
}

export function getDistribution(): DistributionLayout {
  return configuredDistribution ?? createSourceDistribution();
}
