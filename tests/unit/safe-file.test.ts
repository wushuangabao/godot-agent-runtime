import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import * as corePackage from "../../packages/core/src/index.js";
import * as safeFileInternals from "../../packages/core/src/safe-file.js";
import {
  readProjectFile,
  replaceProjectText,
  withProjectMutationLock,
  writeProjectFile,
} from "../../packages/core/src/safe-file.js";
import { getProjectIdentity } from "../../packages/core/src/project.js";

const temporaryDirectories: string[] = [];
let compiledCore: Promise<void> | undefined;

interface ChildRun {
  readonly child: ChildProcessWithoutNullStreams;
  readonly result: Promise<{ code: number | null; stdout: string; stderr: string }>;
}

function startNodeScript(script: string): ChildRun {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: "test" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  return {
    child,
    result: new Promise((complete, reject) => {
      child.once("error", reject);
      child.once("close", (code) => complete({ code, stdout, stderr }));
    }),
  };
}

async function ensureCompiledCore(): Promise<void> {
  compiledCore ??= (async () => {
    const compiler = resolve(process.cwd(), "node_modules", "typescript", "bin", "tsc");
    const run = spawn(process.execPath, [compiler, "-b", "packages/core", "--pretty", "false"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    run.stdout.setEncoding("utf8");
    run.stderr.setEncoding("utf8");
    run.stdout.on("data", (chunk: string) => { output += chunk; });
    run.stderr.on("data", (chunk: string) => { output += chunk; });
    const code = await new Promise<number | null>((complete, reject) => {
      run.once("error", reject);
      run.once("close", complete);
    });
    if (code !== 0) throw new Error(`Failed to compile child-process fixture:\n${output}`);
  })();
  await compiledCore;
}

async function waitForPath(path: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await access(path);
      return;
    } catch {
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
      await new Promise((complete) => setTimeout(complete, 5));
    }
  }
}

async function onlyLease(projectPath: string): Promise<Record<string, unknown>> {
  const lockDirectory = resolve(projectPath, ".godot", "agent-runtime", "locks");
  const leaseNames = (await readdir(lockDirectory)).filter((name) => name.endsWith(".lease"));
  expect(leaseNames).toHaveLength(1);
  return JSON.parse(await readFile(resolve(lockDirectory, leaseNames[0] ?? ""), "utf8")) as Record<string, unknown>;
}

async function onlyLeasePath(projectPath: string): Promise<string> {
  const lockDirectory = resolve(projectPath, ".godot", "agent-runtime", "locks");
  const leaseNames = (await readdir(lockDirectory)).filter((name) => name.endsWith(".lease"));
  expect(leaseNames).toHaveLength(1);
  return resolve(lockDirectory, leaseNames[0] ?? "");
}

async function withSafeFileTestHooks<T>(
  hooks: safeFileInternals.SafeFileTestHooks,
  operation: () => Promise<T>,
): Promise<T> {
  const restore = safeFileInternals.__setSafeFileTestHooks(hooks);
  try {
    return await operation();
  } finally {
    restore();
  }
}

async function projectFixture(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-files-"));
  temporaryDirectories.push(root);
  await writeFile(
    resolve(root, "project.godot"),
    'config_version=5\n[application]\nconfig/name="Safe File Fixture"\n',
    "utf8",
  );
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => await rm(path, { recursive: true })));
});

describe("safe project files", () => {
  it("keeps mutation test hooks internal to the safe-file module", async () => {
    expect(corePackage).not.toHaveProperty("__setSafeFileTestHooks");
    expect(safeFileInternals).toHaveProperty("__setSafeFileTestHooks");
    await ensureCompiledCore();
    const packageDeclaration = await readFile(resolve(process.cwd(), "packages/core/dist/index.d.ts"), "utf8");
    const internalDeclaration = await readFile(resolve(process.cwd(), "packages/core/dist/safe-file.d.ts"), "utf8");
    expect(packageDeclaration).not.toContain("__setSafeFileTestHooks");
    expect(packageDeclaration).not.toContain("__testTiming");
    expect(internalDeclaration).toContain("__setSafeFileTestHooks");
  });

  it("fails closed when a write omits its mutation guard", async () => {
    const projectPath = await projectFixture();

    await expect(writeProjectFile({
      projectPath,
      path: "main.gd",
      content: "extends Node2D\n",
    })).rejects.toMatchObject({ payload: { code: "FILE_GUARD_REQUIRED" } });
  });

  it("replaces one unique text occurrence", async () => {
    const projectPath = await projectFixture();
    await writeFile(resolve(projectPath, "main.gd"), "extends Node\n", "utf8");
    const identity = await getProjectIdentity(projectPath);

    const result = await replaceProjectText({
      projectPath,
      expectedProjectFingerprint: identity.projectFingerprint,
      path: "main.gd",
      oldText: "extends Node",
      newText: "extends Node2D",
    });

    expect(result.replacements).toBe(1);
    expect(await readFile(resolve(projectPath, "main.gd"), "utf8")).toBe("extends Node2D\n");
  });

  it("rejects an ambiguous replacement by default", async () => {
    const projectPath = await projectFixture();
    await writeFile(resolve(projectPath, "duplicate.gd"), "value = 1\nvalue = 1\n", "utf8");
    const identity = await getProjectIdentity(projectPath);

    await expect(replaceProjectText({
      projectPath,
      expectedProjectFingerprint: identity.projectFingerprint,
      path: "duplicate.gd",
      oldText: "value = 1",
      newText: "value = 2",
    })).rejects.toMatchObject({ payload: { code: "FILE_REPLACE_AMBIGUOUS" } });
  });

  it("supports bounded replaceAll and rejects a missing match", async () => {
    const projectPath = await projectFixture();
    await writeFile(resolve(projectPath, "values.gd"), "value = 1\nvalue = 1\n", "utf8");
    const identity = await getProjectIdentity(projectPath);

    const result = await replaceProjectText({
      projectPath,
      expectedProjectFingerprint: identity.projectFingerprint,
      path: "values.gd",
      oldText: "value = 1",
      newText: "value = 2",
      replaceAll: true,
    });
    expect(result.replacements).toBe(2);
    expect(await readFile(resolve(projectPath, "values.gd"), "utf8")).toBe("value = 2\nvalue = 2\n");

    await expect(replaceProjectText({
      projectPath,
      expectedProjectFingerprint: identity.projectFingerprint,
      path: "values.gd",
      oldText: "missing",
      newText: "unused",
    })).rejects.toMatchObject({ payload: { code: "FILE_REPLACE_NOT_FOUND" } });
  });

  it("rejects empty replacement text before matching", async () => {
    const projectPath = await projectFixture();
    await writeFile(resolve(projectPath, "main.gd"), "extends Node\n", "utf8");
    const identity = await getProjectIdentity(projectPath);

    await expect(replaceProjectText({
      projectPath,
      expectedProjectFingerprint: identity.projectFingerprint,
      path: "main.gd",
      oldText: "",
      newText: "unused",
    })).rejects.toMatchObject({ payload: { code: "FILE_REPLACE_TEXT_EMPTY" } });
  });

  it("rejects replaceAll amplification before constructing an oversized result", async () => {
    const projectPath = await projectFixture();
    const original = "a".repeat(300_000);
    await writeFile(resolve(projectPath, "large.gd"), original, "utf8");
    const identity = await getProjectIdentity(projectPath);

    await expect(replaceProjectText({
      projectPath,
      expectedProjectFingerprint: identity.projectFingerprint,
      path: "large.gd",
      oldText: "a",
      newText: "1234",
      replaceAll: true,
    })).rejects.toMatchObject({
      payload: {
        code: "FILE_TOO_LARGE",
        details: { phase: "replacement_budget", projectedBytes: 1_200_000 },
      },
    });
    expect(await readFile(resolve(projectPath, "large.gd"), "utf8")).toBe(original);
  });

  it("rejects malformed UTF-8 with a stable text-read error", async () => {
    const projectPath = await projectFixture();
    await writeFile(resolve(projectPath, "invalid.gd"), Buffer.from([0xc3, 0x28]));

    await expect(readProjectFile({
      projectPath,
      path: "invalid.gd",
    })).rejects.toMatchObject({
      payload: {
        code: "FILE_INVALID_UTF8",
        recovery: expect.arrayContaining([expect.any(String)]),
      },
    });
  });

  it("bounds the actual read when a file grows after stat", async () => {
    const projectPath = await projectFixture();
    const target = resolve(projectPath, "growing.gd");
    await writeFile(target, "ok\n", "utf8");
    let injected = false;

    await withSafeFileTestHooks({
      beforePathOperation: async ({ operation }) => {
        if ((operation as string) !== "target_read_open" || injected) return;
        injected = true;
        await writeFile(target, Buffer.alloc(1_048_577, 0x61));
      },
    } as safeFileInternals.SafeFileTestHooks, async () => {
      await expect(readProjectFile({
        projectPath,
        path: "growing.gd",
      })).rejects.toMatchObject({
        payload: {
          code: "FILE_TOO_LARGE",
          details: {
            phase: "actual_read",
            size: 1_048_577,
            maxBytes: 1_048_576,
          },
          recovery: expect.arrayContaining([expect.any(String)]),
        },
      });
    });
    expect(injected).toBe(true);
  });

  it("rejects guard conflicts while preserving legacy guarded calls", async () => {
    const projectPath = await projectFixture();
    await writeFile(resolve(projectPath, "main.gd"), "extends Node\n", "utf8");
    const before = await readProjectFile({ projectPath, path: "main.gd" });

    await expect(writeProjectFile({
      projectPath,
      path: "main.gd",
      content: "extends Node2D\n",
      guard: { mode: "match", sha256: before.sha256 },
      expectedSha256: before.sha256,
    })).rejects.toMatchObject({ payload: { code: "FILE_GUARD_CONFLICT" } });

    const updated = await writeProjectFile({
      projectPath,
      path: "main.gd",
      content: "extends Node2D\n",
      expectedSha256: before.sha256,
    });
    expect(updated.operation).toBe("updated");

    const created = await writeProjectFile({
      projectPath,
      path: "created.gd",
      content: "extends Node\n",
      expectedSha256: null,
    });
    expect(created.operation).toBe("created");
  });

  it("checks the project fingerprint before modifying the target", async () => {
    const projectPath = await projectFixture();
    const target = resolve(projectPath, "main.gd");
    await writeFile(target, "extends Node\n", "utf8");
    const before = await readProjectFile({ projectPath, path: "main.gd" });

    await expect(writeProjectFile({
      projectPath,
      expectedProjectFingerprint: "0".repeat(64),
      path: "main.gd",
      content: "extends Node2D\n",
      guard: { mode: "match", sha256: before.sha256 },
    })).rejects.toMatchObject({ payload: { code: "PROJECT_IDENTITY_MISMATCH" } });
    expect(await readFile(target, "utf8")).toBe("extends Node\n");
  });

  it("rejects a junction that escapes the canonical project root", async () => {
    const projectPath = await projectFixture();
    const outside = await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-outside-"));
    temporaryDirectories.push(outside);
    await writeFile(resolve(outside, "escape.gd"), "outside\n", "utf8");
    await symlink(outside, resolve(projectPath, "linked"), "junction");

    await expect(writeProjectFile({
      projectPath,
      path: "linked/escape.gd",
      content: "changed\n",
      guard: { mode: "match", sha256: "0".repeat(64) },
    })).rejects.toMatchObject({ payload: { code: "FILE_SYMLINK_REJECTED" } });
    expect(await readFile(resolve(outside, "escape.gd"), "utf8")).toBe("outside\n");
  });

  it("allows only one competing create guard to publish", async () => {
    const projectPath = await projectFixture();
    const attempts = await Promise.allSettled([
      writeProjectFile({
        projectPath,
        path: "created.gd",
        content: "winner = 1\n",
        guard: { mode: "create" },
      }),
      writeProjectFile({
        projectPath,
        path: "created.gd",
        content: "winner = 2\n",
        guard: { mode: "create" },
      }),
    ]);

    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(attempts.find((result) => result.status === "rejected")).toMatchObject({
      reason: { payload: { code: "FILE_ALREADY_EXISTS" } },
    });
  });

  it("rechecks a match guard inside the mutation lock", async () => {
    const projectPath = await projectFixture();
    await writeFile(resolve(projectPath, "main.gd"), "extends Node\n", "utf8");
    const before = await readProjectFile({ projectPath, path: "main.gd" });
    const attempts = await Promise.allSettled([
      writeProjectFile({
        projectPath,
        path: "main.gd",
        content: "extends Node2D\n",
        guard: { mode: "match", sha256: before.sha256 },
      }),
      writeProjectFile({
        projectPath,
        path: "main.gd",
        content: "extends Control\n",
        guard: { mode: "match", sha256: before.sha256 },
      }),
    ]);

    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(attempts.find((result) => result.status === "rejected")).toMatchObject({
      reason: { payload: { code: "FILE_WRITE_CONFLICT" } },
    });
  });

  it("allows only one independent Node process to commit the same match guard", async () => {
    await ensureCompiledCore();
    const projectPath = await projectFixture();
    await writeFile(resolve(projectPath, "main.gd"), "extends Node\n", "utf8");
    const before = await readProjectFile({ projectPath, path: "main.gd" });
    const identity = await getProjectIdentity(projectPath);
    const gate = resolve(projectPath, "child-gate");
    const coreUrl = pathToFileURL(resolve(process.cwd(), "packages/core/dist/safe-file.js")).href;
    const runs = ["Node2D", "Control"].map((base, index) => {
      const ready = resolve(projectPath, `child-${index}.ready`);
      const script = `
        import { access, writeFile } from "node:fs/promises";
        import { writeProjectFile } from ${JSON.stringify(coreUrl)};
        await writeFile(${JSON.stringify(ready)}, String(process.pid), "utf8");
        while (true) {
          try { await access(${JSON.stringify(gate)}); break; }
          catch { await new Promise((complete) => setTimeout(complete, 5)); }
        }
        try {
          const result = await writeProjectFile({
            projectPath: ${JSON.stringify(projectPath)},
            expectedProjectFingerprint: ${JSON.stringify(identity.projectFingerprint)},
            path: "main.gd",
            content: ${JSON.stringify(`extends ${base}\n`)},
            guard: { mode: "match", sha256: ${JSON.stringify(before.sha256)} },
          });
          console.log(JSON.stringify({ ok: true, result }));
        } catch (error) {
          console.log(JSON.stringify({ ok: false, code: error?.payload?.code ?? "UNEXPECTED" }));
        }
      `;
      return { ready, ...startNodeScript(script) };
    });
    await Promise.all(runs.map(async ({ ready }) => await waitForPath(ready)));
    await writeFile(gate, "go", "utf8");
    const results = await Promise.all(runs.map(async ({ result }) => await result));
    expect(results.every(({ code, stderr }) => code === 0 && stderr === "")).toBe(true);
    const payloads = results.map(({ stdout }) => JSON.parse(stdout.trim()) as { ok: boolean; code?: string });
    expect(payloads.filter(({ ok }) => ok)).toHaveLength(1);
    expect(payloads.filter(({ code }) => code === "FILE_WRITE_CONFLICT")).toHaveLength(1);
  });

  it("heartbeats an active cross-process owner and never reclaims it by age alone", async () => {
    await ensureCompiledCore();
    const projectPath = await projectFixture();
    const ready = resolve(projectPath, "heartbeat.ready");
    const coreUrl = pathToFileURL(resolve(process.cwd(), "packages/core/dist/safe-file.js")).href;
    const timing = {
      heartbeatMs: 20,
      staleTtlMs: 60,
      quarantineMs: 60,
      acquireTimeoutMs: 80,
      pollMs: 5,
    };
    const run = startNodeScript(`
      import { writeFile } from "node:fs/promises";
      import { __setSafeFileTestHooks, withProjectMutationLock } from ${JSON.stringify(coreUrl)};
      __setSafeFileTestHooks({ timing: ${JSON.stringify(timing)} });
      await withProjectMutationLock({
        projectPath: ${JSON.stringify(projectPath)}, path: "main.gd",
      }, async () => {
        await writeFile(${JSON.stringify(ready)}, "ready", "utf8");
        await new Promise((complete) => setTimeout(complete, 250));
      });
      console.log(JSON.stringify({ ok: true }));
    `);
    await waitForPath(ready);
    const first = await onlyLease(projectPath);
    await new Promise((complete) => setTimeout(complete, 55));
    const second = await onlyLease(projectPath);
    expect(Number(second.heartbeatAt)).toBeGreaterThan(Number(first.heartbeatAt));

    await withSafeFileTestHooks(
      { timing: { ...timing, acquireTimeoutMs: 70 } },
      async () => await expect(withProjectMutationLock({
        projectPath,
        path: "main.gd",
      }, async () => undefined)).rejects.toMatchObject({ payload: { code: "FILE_MUTATION_BUSY" } }),
    );
    const completed = await run.result;
    expect(completed).toMatchObject({ code: 0, stderr: "" });
  });

  it("never reclaims a live publishing owner after the publish deadline", async () => {
    await ensureCompiledCore();
    const projectPath = await projectFixture();
    const ready = resolve(projectPath, "publishing.ready");
    const release = resolve(projectPath, "publishing.release");
    const coreUrl = pathToFileURL(resolve(process.cwd(), "packages/core/dist/safe-file.js")).href;
    const timing = {
      heartbeatMs: 20,
      staleTtlMs: 60,
      quarantineMs: 60,
      acquireTimeoutMs: 70,
      pollMs: 5,
    };
    const run = startNodeScript(`
      import { access, writeFile } from "node:fs/promises";
      import { __setSafeFileTestHooks, withProjectMutationLock } from ${JSON.stringify(coreUrl)};
      __setSafeFileTestHooks({ timing: ${JSON.stringify(timing)} });
      await withProjectMutationLock({
        projectPath: ${JSON.stringify(projectPath)}, path: "main.gd",
      }, async (lease) => {
        await lease.prepareResultUnknown();
        await writeFile(${JSON.stringify(ready)}, "ready", "utf8");
        const deadline = Date.now() + 10000;
        while (true) {
          try {
            await access(${JSON.stringify(release)});
            break;
          } catch {
            if (Date.now() >= deadline) throw new Error("Timed out waiting for publishing lease release.");
            await new Promise((complete) => setTimeout(complete, 10));
          }
        }
      });
    `);
    await waitForPath(ready);
    expect(await onlyLease(projectPath)).toMatchObject({ state: "publishing" });
    await new Promise((complete) => setTimeout(complete, 70));

    try {
      await withSafeFileTestHooks({ timing }, async () => {
        await expect(withProjectMutationLock({
          projectPath,
          path: "main.gd",
        }, async () => "second-owner")).rejects.toMatchObject({
          payload: { code: "FILE_MUTATION_BUSY" },
        });
        await expect(withProjectMutationLock({
          projectPath,
          path: "main.gd",
          indeterminateErrorCode: "PROJECT_MUTATION_INDETERMINATE",
        }, async () => "second-owner")).rejects.toMatchObject({
          payload: {
            code: "PROJECT_MUTATION_INDETERMINATE",
            details: { leaseState: "publishing", quarantineUntil: expect.any(String) },
          },
        });
      });
    } finally {
      await writeFile(release, "release", "utf8");
    }
    expect(await run.result).toMatchObject({ code: 0, stderr: "" });
  });

  it("reclaims a crashed owner only after its safe stale deadline", async () => {
    await ensureCompiledCore();
    const projectPath = await projectFixture();
    const ready = resolve(projectPath, "crash.ready");
    const coreUrl = pathToFileURL(resolve(process.cwd(), "packages/core/dist/safe-file.js")).href;
    const timing = {
      heartbeatMs: 20,
      staleTtlMs: 1_000,
      quarantineMs: 100,
      acquireTimeoutMs: 30,
      pollMs: 5,
    };
    const run = startNodeScript(`
      import { writeFile } from "node:fs/promises";
      import { __setSafeFileTestHooks, withProjectMutationLock } from ${JSON.stringify(coreUrl)};
      __setSafeFileTestHooks({ timing: ${JSON.stringify(timing)} });
      await withProjectMutationLock({
        projectPath: ${JSON.stringify(projectPath)}, path: "main.gd",
      }, async () => {
        await writeFile(${JSON.stringify(ready)}, "ready", "utf8");
        process.exit(23);
      });
    `);
    await waitForPath(ready);
    const crashed = await run.result;
    expect(crashed.code).toBe(23);

    await withSafeFileTestHooks({ timing }, async () => await expect(withProjectMutationLock({
      projectPath,
      path: "main.gd",
    }, async () => undefined)).rejects.toMatchObject({ payload: { code: "FILE_MUTATION_BUSY" } }));
    await new Promise((complete) => setTimeout(complete, 1_010));
    await withSafeFileTestHooks(
      { timing: { ...timing, acquireTimeoutMs: 80 } },
      async () => await expect(withProjectMutationLock({
        projectPath,
        path: "main.gd",
      }, async () => "reclaimed")).resolves.toBe("reclaimed"),
    );
  });

  it("quarantines an unknown result until its safe deadline", async () => {
    const projectPath = await projectFixture();
    const timing = {
      heartbeatMs: 20,
      staleTtlMs: 60,
      quarantineMs: 150,
      acquireTimeoutMs: 25,
      pollMs: 5,
    };
    await withSafeFileTestHooks({ timing }, async () => {
      await withProjectMutationLock({
        projectPath,
        path: "main.gd",
      }, async (lease) => {
        await lease.prepareResultUnknown();
        lease.markResultUnknown();
      });

      expect(await onlyLease(projectPath)).toMatchObject({ state: "quarantined" });

      await expect(withProjectMutationLock({
        projectPath,
        path: "main.gd",
      }, async () => undefined)).rejects.toMatchObject({ payload: { code: "FILE_MUTATION_BUSY" } });
      await expect(withProjectMutationLock({
        projectPath,
        path: "main.gd",
        indeterminateErrorCode: "PROJECT_MUTATION_INDETERMINATE",
      }, async () => undefined)).rejects.toMatchObject({
        payload: {
          code: "PROJECT_MUTATION_INDETERMINATE",
          details: { leaseState: "quarantined", quarantineUntil: expect.any(String) },
        },
      });
    });
    await new Promise((complete) => setTimeout(complete, 170));
    await withSafeFileTestHooks(
      { timing: { ...timing, acquireTimeoutMs: 80 } },
      async () => await expect(withProjectMutationLock({
        projectPath,
        path: "main.gd",
      }, async () => "reconciled")).resolves.toBe("reconciled"),
    );
  });

  it("starts a fresh quarantine deadline when a long publish becomes unknown", async () => {
    const projectPath = await projectFixture();
    const timing = {
      heartbeatMs: 20,
      staleTtlMs: 60,
      quarantineMs: 60,
      acquireTimeoutMs: 25,
      pollMs: 5,
    };
    let reportedDeadline = "";
    let markedAt = 0;

    await withSafeFileTestHooks({ timing }, async () => {
      await withProjectMutationLock({
        projectPath,
        path: "main.gd",
      }, async (lease) => {
        await lease.prepareResultUnknown();
        await new Promise((complete) => setTimeout(complete, 70));
        markedAt = Date.now();
        reportedDeadline = lease.markResultUnknown();
      });
    });

    const persisted = await onlyLease(projectPath);
    expect(persisted).toMatchObject({
      state: "quarantined",
      quarantineUntil: Date.parse(reportedDeadline),
    });
    expect(Date.parse(reportedDeadline)).toBeGreaterThanOrEqual(markedAt + timing.quarantineMs);
  });

  it("recovers unchanged malformed lease and reclaim records only after the stale deadline", async () => {
    const projectPath = await projectFixture();
    const timing = {
      heartbeatMs: 20,
      staleTtlMs: 60,
      quarantineMs: 60,
      acquireTimeoutMs: 20,
      pollMs: 5,
    };
    let leasePath = "";
    await withSafeFileTestHooks({ timing }, async () => {
      await withProjectMutationLock({ projectPath, path: "main.gd" }, async () => {
        leasePath = await onlyLeasePath(projectPath);
      });
    });

    await writeFile(leasePath, '{"ownerPid":', "utf8");
    await withSafeFileTestHooks({ timing }, async () => {
      await expect(withProjectMutationLock({ projectPath, path: "main.gd" }, async () => undefined))
        .rejects.toMatchObject({ payload: { code: "FILE_MUTATION_BUSY" } });
      await new Promise((complete) => setTimeout(complete, 45));
      await expect(withProjectMutationLock({ projectPath, path: "main.gd" }, async () => "lease-recovered"))
        .resolves.toBe("lease-recovered");
    });

    const reclaimPath = leasePath.replace(/\.lease$/, ".reclaim");
    await writeFile(reclaimPath, "{partial", "utf8");
    await withSafeFileTestHooks({ timing }, async () => {
      await expect(withProjectMutationLock({ projectPath, path: "main.gd" }, async () => undefined))
        .rejects.toMatchObject({ payload: { code: "FILE_MUTATION_BUSY" } });
      await new Promise((complete) => setTimeout(complete, 45));
      await expect(withProjectMutationLock({ projectPath, path: "main.gd" }, async () => "reclaim-recovered"))
        .resolves.toBe("reclaim-recovered");
    });
  });

  it("does not reclaim a malformed record that is still being refreshed", async () => {
    const projectPath = await projectFixture();
    const timing = {
      heartbeatMs: 20,
      staleTtlMs: 60,
      quarantineMs: 60,
      acquireTimeoutMs: 80,
      pollMs: 5,
    };
    let leasePath = "";
    await withSafeFileTestHooks({ timing }, async () => {
      await withProjectMutationLock({ projectPath, path: "main.gd" }, async () => {
        leasePath = await onlyLeasePath(projectPath);
      });
    });
    await writeFile(leasePath, "{active", "utf8");
    const refresh = setInterval(() => {
      void writeFile(leasePath, `{active-${Date.now()}`, "utf8");
    }, 15);
    try {
      await withSafeFileTestHooks({ timing }, async () => {
        await expect(withProjectMutationLock({ projectPath, path: "main.gd" }, async () => undefined))
          .rejects.toMatchObject({ payload: { code: "FILE_MUTATION_BUSY" } });
      });
    } finally {
      clearInterval(refresh);
    }
  });

  it("does not let an expired reclaimer delete a lease or a takeover claim", async () => {
    const projectPath = await projectFixture();
    const timing = {
      heartbeatMs: 20,
      staleTtlMs: 40,
      quarantineMs: 60,
      acquireTimeoutMs: 80,
      pollMs: 5,
    };
    let leasePath = "";
    let leaseRecord: Record<string, unknown> = {};
    await withSafeFileTestHooks({ timing }, async () => {
      await withProjectMutationLock({ projectPath, path: "main.gd" }, async () => {
        leasePath = await onlyLeasePath(projectPath);
        leaseRecord = await onlyLease(projectPath);
      });
    });
    const deadOwnerNonce = "dead-owner";
    await writeFile(leasePath, `${JSON.stringify({
      ...leaseRecord,
      ownerNonce: deadOwnerNonce,
      ownerPid: 2_147_483_647,
      state: "active",
      heartbeatAt: Date.now() - 1_000,
      expiresAt: Date.now() - 1,
      quarantineUntil: null,
    })}\n`, "utf8");
    const reclaimPath = leasePath.replace(/\.lease$/, ".reclaim");
    const takeoverNonce = "takeover-owner";
    let injected = false;

    await withSafeFileTestHooks({
      timing,
      beforePathOperation: async ({ operation, paths }) => {
        if ((operation as string) !== "reclaim_before_lease_unlink" || injected) return;
        injected = true;
        await new Promise((complete) => setTimeout(complete, 50));
        const activeReclaimPath = paths.find((path) => path.endsWith(".reclaim"));
        expect(activeReclaimPath).toBeDefined();
        await writeFile(activeReclaimPath ?? reclaimPath, `${JSON.stringify({
          ownerNonce: takeoverNonce,
          ownerPid: process.pid,
          observedOwnerNonce: deadOwnerNonce,
          claimedAt: Date.now(),
          expiresAt: Date.now() - 1,
        })}\n`, "utf8");
      },
    } as safeFileInternals.SafeFileTestHooks, async () => {
      await expect(withProjectMutationLock({
        projectPath,
        path: "main.gd",
      }, async () => "wrong-owner")).rejects.toMatchObject({
        payload: { code: "FILE_MUTATION_BUSY" },
      });
    });

    expect(injected).toBe(true);
    expect(JSON.parse(await readFile(leasePath, "utf8"))).toMatchObject({
      ownerNonce: deadOwnerNonce,
    });
    expect(JSON.parse(await readFile(reclaimPath, "utf8"))).toMatchObject({
      ownerNonce: takeoverNonce,
    });
  });

  it("leaves no blocking lease when acquisition crashes before no-replace publish", async () => {
    await ensureCompiledCore();
    const projectPath = await projectFixture();
    const coreUrl = pathToFileURL(resolve(process.cwd(), "packages/core/dist/safe-file.js")).href;
    const run = startNodeScript(`
      import { __setSafeFileTestHooks, withProjectMutationLock } from ${JSON.stringify(coreUrl)};
      __setSafeFileTestHooks({
        timing: { heartbeatMs: 20, staleTtlMs: 100, quarantineMs: 100, acquireTimeoutMs: 30, pollMs: 5 },
        beforePathOperation: ({ operation }) => {
          if (operation === "lease_publish_link") process.exit(24);
        },
      });
      await withProjectMutationLock({
        projectPath: ${JSON.stringify(projectPath)}, path: "main.gd",
      }, async () => undefined);
    `);
    const crashed = await run.result;
    expect(crashed.code).toBe(24);

    await withSafeFileTestHooks({
      timing: { heartbeatMs: 20, staleTtlMs: 100, quarantineMs: 100, acquireTimeoutMs: 50, pollMs: 5 },
    }, async () => {
      await expect(withProjectMutationLock({ projectPath, path: "main.gd" }, async () => "acquired"))
        .resolves.toBe("acquired");
    });
  });

  it("maps an unsupported lease hard-link to a stable capability error", async () => {
    const projectPath = await projectFixture();
    let injected = false;

    await withSafeFileTestHooks({
      beforePathOperation: ({ operation }) => {
        if (operation !== "lease_publish_link") return;
        injected = true;
        throw Object.assign(new Error("hard links are unavailable"), { code: "ENOTSUP" });
      },
    }, async () => {
      await expect(withProjectMutationLock({
        projectPath,
        path: "main.gd",
      }, async () => undefined)).rejects.toMatchObject({
        payload: {
          code: "FILE_LOCK_CAPABILITY_UNAVAILABLE",
          recovery: expect.arrayContaining([expect.any(String)]),
        },
      });
    });
    expect(injected).toBe(true);
  });

  it("reports an applied receipt when lease release fails after a successful write", async () => {
    const projectPath = await projectFixture();
    const target = resolve(projectPath, "main.gd");
    await writeFile(target, "extends Node\n", "utf8");
    const before = await readProjectFile({ projectPath, path: "main.gd" });
    let injected = false;

    await withSafeFileTestHooks({
      beforePathOperation: ({ operation, paths }) => {
        if (
          operation !== "record_unlink" ||
          !paths.some((path) => path.endsWith(".lease"))
        ) {
          return;
        }
        injected = true;
        throw Object.assign(new Error("lease release denied"), { code: "EPERM" });
      },
    }, async () => {
      await expect(writeProjectFile({
        projectPath,
        path: "main.gd",
        content: "extends Node2D\n",
        guard: { mode: "match", sha256: before.sha256 },
      })).rejects.toMatchObject({
        payload: {
          code: "FILE_MUTATION_RELEASE_FAILED",
          details: {
            applied: true,
            receipt: {
              operation: "updated",
              sha256: expect.any(String),
            },
            coordinationRelease: { code: "EPERM" },
          },
          recovery: expect.arrayContaining([expect.any(String)]),
        },
      });
    });
    expect(injected).toBe(true);
    expect(await readFile(target, "utf8")).toBe("extends Node2D\n");
  });

  it("preserves a business failure when lease release also fails", async () => {
    const projectPath = await projectFixture();
    const target = resolve(projectPath, "main.gd");
    await writeFile(target, "extends Node\n", "utf8");
    let injected = false;

    await withSafeFileTestHooks({
      beforePathOperation: ({ operation, paths }) => {
        if (
          operation !== "record_unlink" ||
          !paths.some((path) => path.endsWith(".lease"))
        ) {
          return;
        }
        injected = true;
        throw Object.assign(new Error("lease release denied"), { code: "EACCES" });
      },
    }, async () => {
      await expect(writeProjectFile({
        projectPath,
        path: "main.gd",
        content: "extends Node2D\n",
        guard: { mode: "match", sha256: "0".repeat(64) },
      })).rejects.toMatchObject({
        payload: {
          code: "FILE_WRITE_CONFLICT",
          details: {
            coordinationRelease: { code: "EACCES" },
          },
          recovery: expect.arrayContaining([expect.any(String)]),
        },
      });
    });
    expect(injected).toBe(true);
    expect(await readFile(target, "utf8")).toBe("extends Node\n");
  });

  it("fails before target publish when quarantine preparation cannot persist", async () => {
    const projectPath = await projectFixture();
    await writeFile(resolve(projectPath, "main.gd"), "extends Node\n", "utf8");
    const before = await readProjectFile({ projectPath, path: "main.gd" });
    let injected = false;
    await withSafeFileTestHooks({
      beforePathOperation: ({ operation }) => {
        if (operation !== "lease_prepare_publish_rename") return;
        injected = true;
        throw Object.assign(new Error("simulated quarantine persistence failure"), { code: "EIO" });
      },
    } as safeFileInternals.SafeFileTestHooks, async () => {
      await expect(writeProjectFile({
        projectPath,
        path: "main.gd",
        content: "extends Node2D\n",
        guard: { mode: "match", sha256: before.sha256 },
      })).rejects.toMatchObject({
        payload: {
          code: "FILE_QUARANTINE_PERSIST_FAILED",
          recovery: expect.arrayContaining([expect.any(String)]),
        },
      });
    });
    expect(injected).toBe(true);
    expect(await readFile(resolve(projectPath, "main.gd"), "utf8")).toBe("extends Node\n");
    await expect(withProjectMutationLock({ projectPath, path: "main.gd" }, async () => "released"))
      .resolves.toBe("released");
  });

  it("preserves the unknown-result error when temporary cleanup also fails", async () => {
    const projectPath = await projectFixture();
    const target = resolve(projectPath, "main.gd");
    await writeFile(target, "extends Node\n", "utf8");
    const before = await readProjectFile({ projectPath, path: "main.gd" });
    let cleanupInjected = false;
    await withSafeFileTestHooks({
      timing: { heartbeatMs: 20, staleTtlMs: 60, quarantineMs: 60, acquireTimeoutMs: 30, pollMs: 5 },
      beforePathOperation: async ({ operation }) => {
        if (operation === "target_publish_rename") {
          await writeFile(target, "third-party content\n", "utf8");
          throw Object.assign(new Error("simulated uncertain publish"), { code: "EIO" });
        }
        if (operation === "target_temp_cleanup") {
          cleanupInjected = true;
          throw Object.assign(new Error("simulated cleanup failure"), { code: "EPERM" });
        }
      },
    } as safeFileInternals.SafeFileTestHooks, async () => {
      await expect(writeProjectFile({
        projectPath,
        path: "main.gd",
        content: "extends Node2D\n",
        guard: { mode: "match", sha256: before.sha256 },
      })).rejects.toMatchObject({
        payload: {
          code: "FILE_WRITE_RESULT_UNKNOWN",
          details: { quarantineUntil: expect.any(String) },
          recovery: expect.arrayContaining([expect.any(String)]),
        },
      });
    });
    expect(cleanupInjected).toBe(true);
  });

  it("reports a publishing lease when an unknown result cannot persist quarantine", async () => {
    const projectPath = await projectFixture();
    const target = resolve(projectPath, "main.gd");
    await writeFile(target, "extends Node\n", "utf8");
    const before = await readProjectFile({ projectPath, path: "main.gd" });
    let publishInjected = false;
    let quarantineInjected = false;
    let failure: unknown;

    await withSafeFileTestHooks({
      beforePathOperation: async ({ operation }) => {
        if (operation === "target_publish_rename") {
          publishInjected = true;
          await writeFile(target, "third-party content\n", "utf8");
          throw Object.assign(new Error("simulated uncertain publish"), { code: "EIO" });
        }
        if (operation === "lease_replace_rename") {
          quarantineInjected = true;
          throw Object.assign(new Error("simulated quarantine transition failure"), { code: "EACCES" });
        }
      },
    }, async () => {
      try {
        await writeProjectFile({
          projectPath,
          path: "main.gd",
          content: "extends Node2D\n",
          guard: { mode: "match", sha256: before.sha256 },
        });
      } catch (error) {
        failure = error;
      }
    });

    expect(publishInjected).toBe(true);
    expect(quarantineInjected).toBe(true);
    expect(failure).toMatchObject({
      payload: {
        code: "FILE_QUARANTINE_PERSIST_FAILED",
        details: {
          cause: "simulated uncertain publish",
          leaseState: "publishing",
          ownerPid: process.pid,
          ownerNonce: expect.any(String),
          quarantineUntil: expect.any(String),
          requiresProcessRestart: true,
        },
        recovery: expect.arrayContaining([
          expect.stringMatching(/stop|restart/i),
          expect.stringMatching(/PID|quarantineUntil/),
        ]),
      },
    });
    const payload = (failure as {
      payload: { details: { ownerNonce: string; quarantineUntil: string } };
    }).payload;
    const persisted = await onlyLease(projectPath);
    expect(persisted).toMatchObject({
      state: "publishing",
      ownerPid: process.pid,
      ownerNonce: payload.details.ownerNonce,
      quarantineUntil: Date.parse(payload.details.quarantineUntil),
    });
  });

  it("reads and atomically updates with a SHA-256 precondition", async () => {
    const projectPath = await projectFixture();
    await writeFile(resolve(projectPath, "main.gd"), "extends Node\n", "utf8");

    const before = await readProjectFile({ projectPath, path: "res://main.gd" });
    const result = await writeProjectFile({
      projectPath,
      path: "main.gd",
      content: 'extends Node\n\nfunc _ready():\n\tprint("ready")\n',
      expectedSha256: before.sha256,
    });

    expect(result.operation).toBe("updated");
    expect(result.previousSha256).toBe(before.sha256);
    expect(await readFile(resolve(projectPath, "main.gd"), "utf8")).toContain("ready");
  });

  it("rejects traversal, unsupported types, and stale writes", async () => {
    const projectPath = await projectFixture();
    await writeFile(resolve(projectPath, "main.gd"), "extends Node\n", "utf8");

    await expect(readProjectFile({ projectPath, path: "../outside.gd" })).rejects.toMatchObject({
      payload: { code: "FILE_PATH_INVALID" },
    });
    await expect(
      writeProjectFile({ projectPath, path: "asset.png", content: "not really png" }),
    ).rejects.toMatchObject({ payload: { code: "FILE_TYPE_NOT_ALLOWED" } });
    await expect(
      writeProjectFile({
        projectPath,
        path: "main.gd",
        content: "extends Node2D\n",
        expectedSha256: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ payload: { code: "FILE_WRITE_CONFLICT" } });
  });

  it("creates nested files only when requested", async () => {
    const projectPath = await projectFixture();
    await mkdir(resolve(projectPath, "scripts"));
    const result = await writeProjectFile({
      projectPath,
      path: "scripts/player.gd",
      content: "extends Node2D\n",
      expectedSha256: null,
    });
    expect(result.operation).toBe("created");
  });

  it("allows createDirectories for a project-root file", async () => {
    const projectPath = await projectFixture();
    const result = await writeProjectFile({
      projectPath,
      path: "root.gd",
      content: "extends Node\n",
      guard: { mode: "create" },
      createDirectories: true,
    });

    expect(result.operation).toBe("created");
  });
});
