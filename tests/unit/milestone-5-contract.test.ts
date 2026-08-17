import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const EXPECTED_SEQUENCE = [
  "project-context",
  "guarded-file-replace",
  "stale-file-conflict",
  "wrong-scene-zero-mutation",
  "typed-batch-one-action-no-save",
  "batch-undo-redo",
  "failed-save-honesty",
  "explicit-scene-save",
  "input-map-new-sha",
  "editor-restart-input-map-readback",
  "script-and-project-checks",
  "runtime-find-input-wait-assert",
  "runtime-evidence",
  "diagnostics-incremental-logs-debug-report",
  "cleanup",
] as const;

type JsonSchema = boolean | {
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean;
  items?: JsonSchema;
  minItems?: number;
  uniqueItems?: boolean;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  allOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  not?: JsonSchema;
  if?: JsonSchema;
  then?: JsonSchema;
  else?: JsonSchema;
};

function schemaAccepts(schema: JsonSchema, value: unknown): boolean {
  if (typeof schema === "boolean") return schema;
  if (schema.const !== undefined && !Object.is(value, schema.const)) return false;
  if (schema.enum !== undefined && !schema.enum.some((entry) => Object.is(entry, value))) return false;
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = value === null
      ? "null"
      : Array.isArray(value)
        ? "array"
        : Number.isInteger(value)
          ? "integer"
          : typeof value;
    if (!types.includes(actual)) return false;
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return false;
    if (schema.maximum !== undefined && value > schema.maximum) return false;
  }
  if (typeof value === "string" && schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
    return false;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.uniqueItems && new Set(value.map((entry) => JSON.stringify(entry))).size !== value.length) {
      return false;
    }
    if (schema.items !== undefined && !value.every((entry) => schemaAccepts(schema.items ?? true, entry))) {
      return false;
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    if (schema.required?.some((key) => !Object.hasOwn(object, key))) return false;
    if (schema.properties !== undefined) {
      for (const [key, propertySchema] of Object.entries(schema.properties)) {
        if (Object.hasOwn(object, key) && !schemaAccepts(propertySchema, object[key])) return false;
      }
      if (schema.additionalProperties === false) {
        if (Object.keys(object).some((key) => !Object.hasOwn(schema.properties ?? {}, key))) return false;
      }
    }
  }
  if (schema.allOf !== undefined && !schema.allOf.every((entry) => schemaAccepts(entry, value))) return false;
  if (schema.anyOf !== undefined && !schema.anyOf.some((entry) => schemaAccepts(entry, value))) return false;
  if (schema.not !== undefined && schemaAccepts(schema.not, value)) return false;
  if (schema.if !== undefined) {
    const branch = schemaAccepts(schema.if, value) ? schema.then : schema.else;
    if (branch !== undefined && !schemaAccepts(branch, value)) return false;
  }
  return true;
}

async function loadReportSchema(): Promise<JsonSchema> {
  return JSON.parse(
    await readFile(resolve("tests/agent-benchmarks/deepseek-harness/report.schema.json"), "utf8"),
  ) as JsonSchema;
}

async function loadBenchmarkModule(): Promise<Record<string, unknown>> {
  return await import(pathToFileURL(resolve("tests/agent-benchmarks/milestone-5/run.mjs")).href) as Record<string, unknown>;
}

describe("milestone 5 benchmark contract", () => {
  it("defines the complete deterministic sequence without executing the benchmark", async () => {
    const benchmarkPath = resolve("tests/agent-benchmarks/milestone-5/run.mjs");
    const syntax = spawnSync(process.execPath, ["--check", benchmarkPath], {
      cwd: process.cwd(),
      encoding: "utf8",
      windowsHide: true,
    });
    expect(syntax.status, syntax.stderr || syntax.stdout).toBe(0);

    const source = await readFile(benchmarkPath, "utf8");
    const match = source.match(
      /export const MILESTONE_5_SEQUENCE = Object\.freeze\((\[[\s\S]*?\])\);/,
    );
    expect(match?.[1]).toBeDefined();
    expect(JSON.parse(match?.[1] ?? "[]")).toEqual(EXPECTED_SEQUENCE);
    for (const required of [
      "getProjectContext",
      "replaceProjectText",
      "batchEditorScene",
      "undoEditorAction",
      "redoEditorAction",
      "saveEditorScene",
      "upsertEditorInputAction",
      "checkScript",
      "checkProject",
      "findRuntimeUi",
      "injectRuntimeInput",
      "waitForRuntime",
      "assertRuntime",
      "getDiagnosticsSummary",
      "readManagedLogs",
      "createDebugReport",
      "stopManagedRun",
    ]) {
      expect(source).toContain(required);
    }
    expect(source).toContain("toolSchemaBytes");
    expect(source).toContain("instructionsBytes");
    expect(source).toContain("evidenceClasses");
    expect(source).not.toMatch(/selectionRate|toolSelection/i);
  });

  it("publishes the focused package script and bounded cross-client report schema", async () => {
    const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts["benchmark:milestone-5"]).toBe(
      "pnpm run build && node tests/agent-benchmarks/milestone-5/run.mjs",
    );

    const schema = await loadReportSchema() as Exclude<JsonSchema, boolean>;
    expect(schema.required).toEqual(expect.arrayContaining([
      "client",
      "ok",
      "toolCount",
      "toolSchemaBytes",
      "instructionsBytes",
      "hostExecutionVerified",
    ]));
    expect(schema.properties?.toolCount).toMatchObject({ type: "integer", const: 62 });
    expect(schema.properties?.toolSchemaBytes).toMatchObject({
      type: "integer",
      maximum: 144_606,
    });
    expect(schema.properties?.instructionsBytes).toMatchObject({ type: "integer", maximum: 4_096 });
    expect(schema.properties?.hostExecutionVerified).toMatchObject({ type: "boolean" });
    expect(schema.properties?.contextCalls).toMatchObject({ type: "integer", minimum: 0 });
    expect(schema.properties?.diagnosticCalls).toMatchObject({ type: "integer", minimum: 0 });
  });

  it("conditions host-only evidence on verified execution", async () => {
    const schema = await loadReportSchema();
    const deterministicReport = {
      client: "deepseek-harness",
      ok: true,
      toolCount: 62,
      toolSchemaBytes: 140_656,
      instructionsBytes: 595,
      hostExecutionVerified: false,
    };
    expect(schemaAccepts(schema, deterministicReport)).toBe(true);
    expect(schemaAccepts(schema, { ...deterministicReport, selectionRate: 1 })).toBe(false);
    expect(schemaAccepts(schema, {
      ...deterministicReport,
      hostExecutionVerified: true,
      toolCalls: 4,
      contextCalls: 1,
      batchCalls: 0,
      diagnosticCalls: 1,
      durationMs: 10,
    })).toBe(false);
  });

  it("requires unverified host execution when model credentials are absent", async () => {
    const task = await readFile(resolve("tests/agent-benchmarks/deepseek-harness/task.md"), "utf8");
    expect(task).toContain("hostExecutionVerified");
    expect(task).toContain("false");
    expect(task).toMatch(/凭据|credentials/i);
    expect(task).toMatch(/不得生成或猜测.*选择率/);
  });

  it("persists measured MCP budgets when a later injected setup step fails", async () => {
    const benchmark = await loadBenchmarkModule();
    expect(benchmark.runMilestone5WithDependencies).toBeTypeOf("function");
    if (typeof benchmark.runMilestone5WithDependencies !== "function") return;

    const artifactDirectory = await mkdtemp(resolve(tmpdir(), "milestone-5-contract-report-"));
    const measured = {
      serverInfo: { name: "godot-agent-runtime", version: "0.2.0" },
      toolCount: 62,
      toolSchemaBytes: 140_656,
      instructionsBytes: 595,
    };
    try {
      const report = await benchmark.runMilestone5WithDependencies({
        artifactDirectory,
        measureMcpContract: async () => measured,
        createTemporaryProject: async () => {
          throw Object.assign(new Error("injected failure after MCP measurement"), {
            code: "INJECTED_AFTER_MCP",
          });
        },
        markFailure: () => undefined,
        writeOutput: () => undefined,
      }) as { mcp?: unknown };
      expect(report.mcp).toEqual(measured);
      const persisted = JSON.parse(await readFile(resolve(artifactDirectory, "report.json"), "utf8")) as {
        mcp?: unknown;
      };
      expect(persisted.mcp).toEqual(measured);
    } finally {
      await rm(artifactDirectory, { recursive: true, force: true });
    }
  });

  it("records temporary-directory cleanup failure before publishing the report", async () => {
    const benchmark = await loadBenchmarkModule();
    expect(benchmark.finalizeMilestone5Report).toBeTypeOf("function");
    if (typeof benchmark.finalizeMilestone5Report !== "function") return;

    const root = await mkdtemp(resolve(tmpdir(), "milestone-5-cleanup-contract-"));
    const artifactDirectory = resolve(root, "artifacts");
    const projectPath = resolve(root, "project");
    await Promise.all([mkdir(artifactDirectory), mkdir(projectPath)]);
    const order: string[] = [];
    const report = {
      ok: true,
      cleanup: { attempted: true, allStopped: true, finalStates: {}, errors: [] },
    };
    try {
      await benchmark.finalizeMilestone5Report({
        artifactDirectory,
        projectPath,
        report,
        removeTemporaryProject: async () => {
          order.push("remove");
          throw Object.assign(new Error("injected directory removal failure"), {
            code: "INJECTED_REMOVE_FAILED",
          });
        },
        writeReport: async (path: string, content: string) => {
          order.push("write");
          await writeFile(path, content, "utf8");
        },
        writeOutput: () => undefined,
        markFailure: () => undefined,
      });
      expect(order).toEqual(["remove", "write"]);
      const persisted = JSON.parse(await readFile(resolve(artifactDirectory, "report.json"), "utf8")) as {
        ok: boolean;
        cleanup: { temporaryProjectRemoved?: boolean; errors: Array<{ code?: string }> };
      };
      expect(persisted.ok).toBe(false);
      expect(persisted.cleanup.temporaryProjectRemoved).toBe(false);
      expect(persisted.cleanup.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "INJECTED_REMOVE_FAILED" }),
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("routes failure cleanup stops through counted tool steps", async () => {
    const source = await readFile(resolve("tests/agent-benchmarks/milestone-5/run.mjs"), "utf8");
    const failureCleanup = source.match(
      /} catch \(error\) \{\n    const cleanup = \{([\s\S]*?)report = \{\n      ok: false,/,
    );
    expect(failureCleanup?.[1]).toContain("await stopRun(kind, run)");
    expect(failureCleanup?.[1]).not.toContain("await stopManagedRun(");
  });
});
