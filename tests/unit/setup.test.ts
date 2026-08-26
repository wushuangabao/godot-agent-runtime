import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import * as core from "../../packages/core/src/index.js";

interface SetupOptions {
  readonly workspacePath: string;
  readonly godotProjectPath: string;
  readonly godotExecutable: string;
}

interface SetupPorts {
  readonly nodeVersion: string;
  readonly probeGodotVersion: (executable: string) => Promise<string>;
}

interface SetupApi {
  assertSupportedNodeVersion(version: string): void;
  createCodexSetupPlan(options: SetupOptions, ports?: SetupPorts): Promise<{
    localConfigWrite: { path: string; operation: string };
    clientPlan: { write: { path: string; operation: string } };
    addonPlan: {
      addonWrites: readonly { operation: string }[];
      projectWrite: { operation: string };
    };
  }>;
  applyCodexSetupPlan(plan: unknown): Promise<{
    godotVersion: string;
    targets: readonly { operation: string }[];
  }>;
  setupCodex(options: SetupOptions, ports?: SetupPorts): Promise<{
    godotVersion: string;
    targets: readonly { operation: string }[];
  }>;
}

const api = core as unknown as SetupApi;
const temporaryDirectories: string[] = [];
const fakePorts: SetupPorts = {
  nodeVersion: "24.11.1",
  probeGodotVersion: async () => "4.6.2.stable.official.71f334935",
};

async function fixture(): Promise<SetupOptions> {
  const workspacePath = await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-setup-"));
  temporaryDirectories.push(workspacePath);
  const godotProjectPath = resolve(workspacePath, "GodotPrj");
  const godotExecutable = resolve(workspacePath, "Godot_v4.6.2-stable.exe");
  await mkdir(godotProjectPath, { recursive: true });
  await writeFile(
    resolve(godotProjectPath, "project.godot"),
    "config_version=5\n",
    "utf8",
  );
  await writeFile(godotExecutable, "", "utf8");
  return { workspacePath, godotProjectPath, godotExecutable };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(
      async (path) => await rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("Codex setup planning", () => {
  it("rejects Node versions below 20", () => {
    expect(() => api.assertSupportedNodeVersion("18.20.8")).toThrow(
      expect.objectContaining({
        payload: expect.objectContaining({
          code: "SETUP_NODE_VERSION_UNSUPPORTED",
          stage: "validation",
        }),
      }),
    );
    expect(() => api.assertSupportedNodeVersion("20.0.0")).not.toThrow();
  });

  it("rejects invalid inputs before creating configuration", async () => {
    const options = await fixture();
    const missingProject = resolve(options.workspacePath, "MissingGodotProject");

    await expect(api.createCodexSetupPlan({
      ...options,
      godotProjectPath: missingProject,
    }, fakePorts)).rejects.toMatchObject({
      payload: { code: "SETUP_PATH_INVALID", stage: "validation" },
    });
    await expect(access(resolve(
      options.workspacePath,
      ".godot-agent-runtime",
      "config.local.json",
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects non-Godot-4 versions before creating configuration", async () => {
    const options = await fixture();

    await expect(api.createCodexSetupPlan(options, {
      nodeVersion: "24.11.1",
      probeGodotVersion: async () => "3.6.5.stable",
    })).rejects.toMatchObject({
      payload: {
        code: "SETUP_GODOT_VERSION_UNSUPPORTED",
        stage: "validation",
      },
    });
    await expect(access(resolve(
      options.workspacePath,
      ".godot-agent-runtime",
      "config.local.json",
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("validates every planned target before the first write", async () => {
    const options = await fixture();
    const codexPath = resolve(options.workspacePath, ".codex", "config.toml");
    await mkdir(resolve(codexPath, ".."), { recursive: true });
    await writeFile(
      codexPath,
      "# >>> godot-agent-runtime managed section >>>\n",
      "utf8",
    );
    const projectBefore = await readFile(
      resolve(options.godotProjectPath, "project.godot"),
      "utf8",
    );

    await expect(api.createCodexSetupPlan(options, fakePorts)).rejects.toMatchObject({
      payload: {
        code: "CLIENT_CONFIG_MANAGED_SECTION_INVALID",
        stage: "configuration",
      },
    });
    await expect(access(resolve(
      options.workspacePath,
      ".godot-agent-runtime",
      "config.local.json",
    ))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(resolve(
      options.godotProjectPath,
      "addons",
    ))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(
      resolve(options.godotProjectPath, "project.godot"),
      "utf8",
    )).resolves.toBe(projectBefore);
  });

  it("computes all eight file operations without writing", async () => {
    const options = await fixture();
    const plan = await api.createCodexSetupPlan(options, fakePorts);

    expect(plan.localConfigWrite.operation).toBe("created");
    expect(plan.clientPlan.write.operation).toBe("created");
    expect(plan.addonPlan.addonWrites).toHaveLength(5);
    expect(plan.addonPlan.addonWrites.every((write) => write.operation === "created"))
      .toBe(true);
    expect(plan.addonPlan.projectWrite.operation).toBe("updated");
    await expect(access(plan.localConfigWrite.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(plan.clientPlan.write.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(resolve(options.godotProjectPath, "addons")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports an early apply conflict and converges after replanning", async () => {
    const options = await fixture();
    const plan = await api.createCodexSetupPlan(options, fakePorts);
    await mkdir(resolve(plan.localConfigWrite.path, ".."), { recursive: true });
    await writeFile(plan.localConfigWrite.path, "{}\n", "utf8");

    await expect(api.applyCodexSetupPlan(plan)).rejects.toMatchObject({
      payload: {
        code: "ATOMIC_WRITE_CONFLICT",
        details: { completedTargets: [] },
      },
    });

    const retried = await api.setupCodex(options, fakePorts);
    expect(retried.godotVersion).toBe("4.6.2.stable.official.71f334935");
    expect(retried.targets).toHaveLength(8);
    const second = await api.setupCodex(options, fakePorts);
    expect(second.targets.every((target) => target.operation === "unchanged")).toBe(true);
  });
});
