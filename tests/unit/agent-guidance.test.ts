import { describe, expect, it } from "vitest";

import { getAgentGuide } from "../../packages/core/src/index.js";

const RECIPE_IDS = [
  "edit-and-verify-ui",
  "edit-and-verify-3d",
  "fix-script-error",
  "safe-scene-batch",
  "collect-debug-report",
] as const;

describe("shared agent guidance", () => {
  it("returns the fixed verification ladder and honesty rules from Core", () => {
    const guide = getAgentGuide();

    expect(guide.playbook.startupChecklist[0]).toContain("godot_project_context");
    expect(guide.playbook.verificationLadder.map((step) => step.id)).toEqual([
      "context",
      "compile",
      "edit",
      "visual",
      "runtime",
      "interactive",
      "cleanup",
    ]);
    expect(guide.playbook.honestyRules).toContain(
      "Do not claim interaction success from screenshot evidence alone.",
    );
    expect(guide.playbook.editingRules.join(" ")).toContain("godot_file_replace");
    expect(guide.playbook.editingRules.join(" ")).toContain("guard");
    expect(guide.playbook.editingRules.join(" ")).toContain("godot_editor_batch");
    expect(guide.playbook.diagnosticRules.join(" ")).toContain("godot_diagnostics");
    expect(guide.playbook.diagnosticRules.join(" ")).toContain("godot_log_read");
  });

  it("advertises exactly five recipes and returns their complete static contracts", () => {
    const overview = getAgentGuide();
    expect(overview.recipes.map(({ id }) => id)).toEqual(RECIPE_IDS);

    for (const summary of overview.recipes) {
      const result = getAgentGuide(summary.id);
      expect(result.recipe).toMatchObject({
        id: summary.id,
        title: summary.title,
        goal: expect.any(String),
        prerequisites: expect.any(Array),
        tools: expect.any(Array),
        successCriteria: expect.any(Array),
        evidenceRequirements: expect.any(Array),
        cleanup: expect.any(Array),
      });
      expect(result.recipe.tools.length).toBeGreaterThan(0);
      expect(result.recipe.successCriteria.length).toBeGreaterThan(0);
      expect(result.recipe.evidenceRequirements.length).toBeGreaterThan(0);
      expect(result.recipe.cleanup).toContain("Stop every managed run with godot_run_stop.");
    }
  });

  it("stops every recipe after its final managed launch", () => {
    const guide = getAgentGuide();

    for (const summary of guide.recipes) {
      const { recipe } = getAgentGuide(summary.id);
      const launchIndexes = recipe.tools.flatMap((tool, index) =>
        tool === "godot_editor_launch" || tool === "godot_scene_launch" ? [index] : [],
      );
      if (launchIndexes.length === 0) continue;

      const finalLaunchIndex = Math.max(...launchIndexes);
      expect(recipe.tools.lastIndexOf("godot_run_stop"), recipe.id).toBeGreaterThan(finalLaunchIndex);
    }

    expect(getAgentGuide("safe-scene-batch").recipe.tools.at(-1)).toBe("godot_run_stop");
  });

  it("is deterministic, read-only, and does not retain caller mutations", () => {
    const first = getAgentGuide();
    const snapshot = JSON.stringify(first);
    expect(() => {
      (first.playbook.startupChecklist as string[]).push("caller state");
    }).toThrow();
    expect(JSON.stringify(getAgentGuide())).toBe(snapshot);
  });
});
