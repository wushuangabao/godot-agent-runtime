import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDebugReport,
  renderDebugReport,
} from "../../packages/core/src/debug-report.js";
import { getProjectIdentity } from "../../packages/core/src/project.js";

const sandboxes: string[] = [];

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map(async (path) => {
    await rm(path, { recursive: true, force: true });
  }));
});

describe("debug reports", () => {
  it("redacts secrets in every user and log section", () => {
    for (const format of ["markdown", "json"] as const) {
      const report = renderDebugReport({
        format,
        issue: 'Button crashes; {"token":"json issue secret tail"}',
        reproduction: "  ' password ' = 'single quoted reproduction secret tail'  ",
        projectPath: "C:/Users/Alice/game",
        protocolVersions: { editor: "0.7.0", runtime: "0.4.0" },
        doctor: { ok: true, checks: [] },
        diagnostics: {
          counts: { errors: 1, warnings: 0, unique: 1, repeated: 0 },
          issues: [{
            stream: "stderr",
            severity: "error",
            message: '" api_key " : "double quoted diagnostic secret tail"',
            count: 1,
          }],
        },
        logs: [{
          stream: "stderr",
          severity: "error",
          message: '" Authorization " : "Bearer quoted log secret tail"',
          count: 1,
        }],
        runId: null,
        capabilities: ["structured_diagnostics"],
      });

      for (const secret of [
        "json issue secret tail",
        "single quoted reproduction secret tail",
        "double quoted diagnostic secret tail",
        "quoted log secret tail",
      ]) expect(report).not.toContain(secret);
      expect(report).not.toContain("secret tail");
      expect(report).toContain("[REDACTED]");
      expect(report).toContain("Button crashes");
    }
  });

  it("publishes a create-only report with a review receipt", async () => {
    const projectPath = await mkdtemp(resolve(tmpdir(), "godot-agent-runtime-report-"));
    sandboxes.push(projectPath);
    await writeFile(resolve(projectPath, "project.godot"), "[application]\nconfig/name=\"Report\"\n", "utf8");
    await mkdir(resolve(projectPath, ".godot"), { recursive: true });
    const identity = await getProjectIdentity(projectPath);

    const receipt = await createDebugReport({
      projectPath,
      expectedProjectFingerprint: identity.projectFingerprint,
      issue: "The button does not respond",
      reproduction: "token=private-token",
      format: "json",
    });

    expect(receipt).toMatchObject({
      ok: true,
      projectPath: identity.projectPath,
      path: expect.stringMatching(/^res:\/\/\.godot\/agent-runtime\/reports\/debug-.+\.json$/),
      bytes: expect.any(Number),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      includedSections: expect.arrayContaining(["doctor", "protocolVersions", "issue"]),
      reviewRequired: true,
    });
    const contents = await readFile(resolve(projectPath, receipt.path.slice("res://".length)), "utf8");
    expect(contents).not.toContain("private-token");
    expect(contents).toContain("[REDACTED]");
  });

  it("keeps rendered reports below the safe-file byte limit", () => {
    const report = renderDebugReport({
      format: "json",
      issue: "large logs",
      projectPath: "C:/game",
      protocolVersions: { editor: "0.7.0", runtime: "0.4.0" },
      doctor: { ok: true, checks: [] },
      diagnostics: {
        counts: { errors: 500, warnings: 0, unique: 500, repeated: 0 },
        issues: Array.from({ length: 50 }, (_, index) => ({
          stream: "stderr" as const,
          severity: "error" as const,
          message: `issue-${index}-${"x".repeat(10_000)}`,
          count: 1,
        })),
      },
      logs: Array.from({ length: 500 }, (_, index) => ({
        stream: "stderr" as const,
        severity: "error" as const,
        message: `log-${index}-${"x".repeat(10_000)}`,
        count: 1,
      })),
      runId: null,
      capabilities: ["structured_diagnostics"],
    });
    expect(Buffer.byteLength(report, "utf8")).toBeLessThan(1024 * 1024);
  });
});
