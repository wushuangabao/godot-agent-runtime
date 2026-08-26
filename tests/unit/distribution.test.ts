import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import * as core from "../../packages/core/src/index.js";

interface ClientLauncher {
  readonly command: string;
  readonly args: readonly string[];
}

interface DistributionLayout {
  readonly kind: "source" | "npm";
  readonly version: string;
  readonly addonRoot: string;
  readonly hostScript: string;
  readonly mcpServerPath: string | null;
  readonly mcpLauncher: ClientLauncher;
}

interface DistributionApi {
  createSourceDistribution(anchorUrl?: string): DistributionLayout;
  createNpmDistribution(anchorUrl: string, version: string): DistributionLayout;
  configureDistribution(layout: DistributionLayout): void;
}

const api = core as unknown as DistributionApi;
const temporaryDirectories: string[] = [];

async function createNpmFixture(name: string): Promise<{ root: string; anchorUrl: string }> {
  const root = await mkdtemp(resolve(tmpdir(), name));
  temporaryDirectories.push(root);
  const bin = resolve(root, "dist", "npm", "bin", "godot-agent-runtime.js");
  const addonRoot = resolve(root, "dist", "npm", "assets", "addons", "godot_agent_runtime");
  const host = resolve(root, "dist", "npm", "assets", "host", "run-host.mjs");
  await mkdir(resolve(bin, ".."), { recursive: true });
  await mkdir(addonRoot, { recursive: true });
  await mkdir(resolve(host, ".."), { recursive: true });
  await writeFile(bin, "", "utf8");
  await writeFile(host, "", "utf8");
  for (const filename of [
    "LICENSE",
    "plugin.cfg",
    "plugin.gd",
    "editor_bridge.gd",
    "runtime_entry.gd",
  ]) {
    await writeFile(resolve(addonRoot, filename), filename, "utf8");
  }
  return { root, anchorUrl: pathToFileURL(bin).href };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(
      async (path) => await rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("runtime distribution layout", () => {
  it("resolves source checkout assets and the built MCP server", () => {
    const layout = api.createSourceDistribution();

    expect(layout).toMatchObject({
      kind: "source",
      version: "0.2.0",
      addonRoot: resolve("addons", "godot_agent_runtime"),
      hostScript: resolve("packages", "core", "host", "run-host.mjs"),
      mcpServerPath: resolve("packages", "mcp-server", "dist", "bin.js"),
      mcpLauncher: {
        command: process.execPath,
        args: [resolve("packages", "mcp-server", "dist", "bin.js")],
      },
    });
  });

  it("resolves npm assets only beside the packaged executable", async () => {
    const fixture = await createNpmFixture("godot-agent-runtime-distribution-npm-");
    const layout = api.createNpmDistribution(fixture.anchorUrl, "0.2.0");

    expect(layout).toEqual({
      kind: "npm",
      version: "0.2.0",
      addonRoot: resolve(
        fixture.root,
        "dist",
        "npm",
        "assets",
        "addons",
        "godot_agent_runtime",
      ),
      hostScript: resolve(
        fixture.root,
        "dist",
        "npm",
        "assets",
        "host",
        "run-host.mjs",
      ),
      mcpServerPath: null,
      mcpLauncher: {
        command: "npx",
        args: ["-y", "godot-agent-runtime@0.2.0", "mcp"],
      },
    });
  });

  it("fails closed when a packaged asset is missing", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-distribution-missing-"));
    temporaryDirectories.push(root);
    const bin = resolve(root, "dist", "npm", "bin", "godot-agent-runtime.js");
    await mkdir(resolve(bin, ".."), { recursive: true });
    await writeFile(bin, "", "utf8");

    expect(() => api.createNpmDistribution(pathToFileURL(bin).href, "0.2.0"))
      .toThrow(expect.objectContaining({
        payload: expect.objectContaining({
          code: "DISTRIBUTION_ASSET_MISSING",
          stage: "configuration",
          details: expect.objectContaining({ kind: "npm" }),
        }),
      }));
  });

  it("accepts identical configuration once and rejects a different layout", async () => {
    const firstFixture = await createNpmFixture("godot-agent-runtime-distribution-first-");
    const secondFixture = await createNpmFixture("godot-agent-runtime-distribution-second-");
    const first = api.createNpmDistribution(firstFixture.anchorUrl, "0.2.0");
    const second = api.createNpmDistribution(secondFixture.anchorUrl, "0.2.0");

    expect(() => api.configureDistribution(first)).not.toThrow();
    expect(() => api.configureDistribution(first)).not.toThrow();
    expect(() => api.configureDistribution(second)).toThrow(expect.objectContaining({
      payload: expect.objectContaining({
        code: "DISTRIBUTION_ALREADY_CONFIGURED",
        stage: "configuration",
      }),
    }));
  });
});
