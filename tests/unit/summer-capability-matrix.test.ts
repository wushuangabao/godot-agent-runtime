import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const DECISIONS = ["adopt", "adapt", "existing", "reject", "defer"] as const;

interface InventorySource {
  readonly name: string;
  readonly url: string;
  readonly commit: string;
  readonly license: string;
}

interface InventoryExtraction {
  readonly method: string;
  readonly registrationFiles: readonly string[];
  readonly toolNamesSha256: string;
}

interface InventoryItem {
  readonly id: string;
  readonly kind: "tool" | "behavior";
  readonly name: string;
}

interface Inventory {
  readonly reviewedAt: string;
  readonly toolCount: number;
  readonly behaviorCount: number;
  readonly sources: readonly InventorySource[];
  readonly extraction: InventoryExtraction;
  readonly items: readonly InventoryItem[];
}

interface Decision {
  readonly id: string;
  readonly decision: (typeof DECISIONS)[number];
  readonly rationale: string;
  readonly tasks: readonly string[];
  readonly existingEvidence?: readonly string[];
}

interface DecisionManifest {
  readonly inventoryCommit: string;
  readonly decisions: readonly Decision[];
}

interface ComparisonProjection {
  readonly itemCount: number;
  readonly decisionCounts: Record<(typeof DECISIONS)[number], number>;
}

interface McpBaseline {
  readonly commit: string;
  readonly serialization: {
    readonly encoding: string;
    readonly objectKeys: string;
    readonly arrays: string;
    readonly payload: string;
  };
  readonly toolCount: number;
  readonly toolSchemaBytes: number;
  readonly toolSchemaSha256: string;
  readonly instructionsBytes: number;
  readonly instructionsSha256: string;
  readonly capture: {
    readonly source: {
      readonly commit: string;
      readonly method: string;
      readonly serverSourceGitBlobSha1: string;
    };
    readonly initialize: { readonly instructions: string };
    readonly toolsList: { readonly tools: readonly unknown[] };
  };
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(resolve(path), "utf8")) as T;
}

function duplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) repeated.add(id);
    seen.add(id);
  }
  return [...repeated].sort();
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function evidenceLocation(evidence: string): { path: string; symbol?: string } {
  const separator = evidence.indexOf(":");
  if (separator === -1) return { path: evidence };
  return { path: evidence.slice(0, separator), symbol: evidence.slice(separator + 1) };
}

describe("Summer capability decision closure", () => {
  it("classifies every frozen capability exactly once", async () => {
    const inventory = await readJson<Inventory>("docs/research/summer-mcp-inventory.json");
    const manifest = await readJson<DecisionManifest>("docs/research/summer-mcp-decisions.json");

    expect(inventory.reviewedAt).toBe("2026-08-17");
    expect(inventory.sources).toEqual([
      expect.objectContaining({
        name: "Summer Engine agent layer and MCP server",
        url: "https://github.com/SummerEngine/summer-engine-agent/tree/933fc30d77ce6b1eaaf356197377795cb8df0c59",
        commit: "933fc30d77ce6b1eaaf356197377795cb8df0c59",
        license: "MIT",
      }),
    ]);
    expect(manifest.inventoryCommit).toBe(inventory.sources[0]?.commit);

    const inventoryIds = inventory.items.map(({ id }) => id);
    const decisionIds = manifest.decisions.map(({ id }) => id);
    const inventorySet = new Set(inventoryIds);
    const decisionSet = new Set(decisionIds);
    const missing = [...inventorySet].filter((id) => !decisionSet.has(id)).sort();
    const extra = [...decisionSet].filter((id) => !inventorySet.has(id)).sort();
    const inventoryDuplicates = duplicates(inventoryIds);
    const decisionDuplicates = duplicates(decisionIds);

    expect(
      { missing, extra, inventoryDuplicates, decisionDuplicates },
      `Summer decision closure failed:\n${JSON.stringify(
        { missing, extra, inventoryDuplicates, decisionDuplicates },
        null,
        2,
      )}`,
    ).toEqual({
      missing: [],
      extra: [],
      inventoryDuplicates: [],
      decisionDuplicates: [],
    });

    const toolItems = inventory.items.filter(({ kind }) => kind === "tool");
    const behaviorItems = inventory.items.filter(({ kind }) => kind === "behavior");
    expect(inventory.toolCount).toBe(62);
    expect(inventory.toolCount).toBe(toolItems.length);
    expect(inventory.behaviorCount).toBe(5);
    expect(inventory.behaviorCount).toBe(behaviorItems.length);
    expect(behaviorItems.map(({ id }) => id).sort()).toEqual([
      "behavior:export-deploy-workflow",
      "behavior:raw-run-verification-probe",
      "behavior:runtime-input-verification-loop",
      "behavior:skills-routing",
      "behavior:synthetic-scene-preview",
    ]);

    expect(inventory.extraction).toMatchObject({
      method: "first string argument of server.tool() registrations at the pinned commit",
      registrationFiles: [
        "src/mcp/tools/asset-tools.ts",
        "src/mcp/tools/cloud-tools.ts",
        "src/mcp/tools/creator-tools.ts",
        "src/mcp/tools/debug-tools.ts",
        "src/mcp/tools/file-tools.ts",
        "src/mcp/tools/generate-tools.ts",
        "src/mcp/tools/project-tools.ts",
        "src/mcp/tools/scene-tools.ts",
        "src/mcp/tools/visual-tools.ts",
      ],
      toolNamesSha256: "9572f734304a87cc1ced4fc58c62e28daec0753b4e084ce61436d0e26dca582f",
    });
    expect(sha256(JSON.stringify(toolItems.map(({ name }) => name).sort()))).toBe(
      inventory.extraction.toolNamesSha256,
    );

    for (const item of inventory.items) {
      expect(item.id).toMatch(/^(tool:summer_[a-z0-9_]+|behavior:[a-z0-9-]+)$/);
      expect(item.name).not.toHaveLength(0);
      if (item.kind === "tool") expect(item.id).toBe(`tool:${item.name}`);
    }
    for (const entry of manifest.decisions) {
      expect(DECISIONS).toContain(entry.decision);
      expect(entry.rationale.trim().length).toBeGreaterThan(20);
      if (entry.decision === "adopt" || entry.decision === "adapt") {
        expect(entry.tasks, `${entry.id} must name its implementation task`).not.toHaveLength(0);
      }
      if (entry.decision === "existing") {
        expect(
          entry.existingEvidence,
          `${entry.id} must point to an existing file or test`,
        ).toBeDefined();
        expect(entry.existingEvidence).not.toHaveLength(0);
        for (const evidence of entry.existingEvidence ?? []) {
          const location = evidenceLocation(evidence);
          await expect(access(resolve(location.path))).resolves.toBeUndefined();
          if (location.symbol !== undefined) {
            expect(await readFile(resolve(location.path), "utf8")).toContain(location.symbol);
          }
        }
      }
      if (entry.decision === "reject" || entry.decision === "defer") {
        expect(
          entry.rationale,
          `${entry.id} must retain a concrete boundary rationale`,
        ).toMatch(/(?:边界|不引入|不提供|延期|风险|凭据|许可证|闭源|云|发布)/);
      }
    }

    for (const creatorId of [
      "tool:summer_creator_publish",
      "tool:summer_creator_releases",
      "tool:summer_creator_logs",
      "tool:summer_creator_config",
    ]) {
      const creatorDecision = manifest.decisions.find(({ id }) => id === creatorId);
      expect(creatorDecision?.decision).toBe("defer");
      expect(creatorDecision?.rationale).toContain("当前核心明确不实现发布平台");
      expect(creatorDecision?.rationale).toContain("另立外部/高风险设计评审");
    }
  });

  it("pins the measured 0.1 MCP schema budget", async () => {
    const baseline = await readJson<McpBaseline>("tests/fixtures/mcp-tool-baseline-0.1.json");

    expect(baseline).toMatchObject({
      commit: "657701a2ff26d569017a12465298a9f7d41a3f48",
      serialization: {
        encoding: "UTF-8",
        objectKeys: "recursive lexicographic sort",
        arrays: "preserve list_tools order",
        payload: "JSON.stringify(stablySorted(tools)) without whitespace or trailing newline",
      },
      toolCount: 49,
      toolSchemaBytes: 96_404,
      instructionsBytes: 332,
    });
    expect(baseline.capture.source).toEqual({
      commit: baseline.commit,
      method:
        "MCP initialize then tools/list; server source Git blob verified against pinned commit before capture",
      serverSourceGitBlobSha1: "0ae924a3037547c3e34e4332148c7fcd27f16227",
    });
    const tools = baseline.capture.toolsList.tools;
    const serializedTools = JSON.stringify(stable(tools));
    const instructions = baseline.capture.initialize.instructions;
    expect(tools).toHaveLength(baseline.toolCount);
    expect(Buffer.byteLength(serializedTools, "utf8")).toBe(baseline.toolSchemaBytes);
    expect(sha256(serializedTools)).toBe(baseline.toolSchemaSha256);
    expect(Buffer.byteLength(instructions, "utf8")).toBe(baseline.instructionsBytes);
    expect(sha256(instructions)).toBe(baseline.instructionsSha256);
  });

  it("keeps the comparisons projection equal to the frozen decision manifest", async () => {
    const manifest = await readJson<DecisionManifest>("docs/research/summer-mcp-decisions.json");
    const comparisons = await readFile(resolve("docs/comparisons.md"), "utf8");
    const match = comparisons.match(/<!-- summer-capability-projection (\{.*\}) -->/);
    expect(match?.[1], "docs/comparisons.md is missing its machine projection marker").toBeDefined();
    const projection = JSON.parse(match?.[1] ?? "{}") as ComparisonProjection;
    const decisionCounts = Object.fromEntries(
      DECISIONS.map((decision) => [
        decision,
        manifest.decisions.filter((entry) => entry.decision === decision).length,
      ]),
    );
    expect(projection).toEqual({ itemCount: manifest.decisions.length, decisionCounts });
  });
});
