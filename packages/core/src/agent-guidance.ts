import type {
  AgentGuideOverview,
  AgentGuideRecipeResult,
  AgentPlaybook,
  AgentRecipe,
  AgentRecipeSummary,
  RecipeId,
} from "@godot-agent-runtime/protocol";

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

const PLAYBOOK = deepFreeze<AgentPlaybook>({
  startupChecklist: [
    "Call godot_project_context first and use the returned project and main-scene identity; never guess the main scene.",
    "Keep every managed editor and runtime runId so it can be stopped during cleanup.",
  ],
  verificationLadder: [
    {
      id: "context",
      goal: "Bind all later work to the intended project and current bridge state.",
      tools: ["godot_project_context"],
      successCriteria: ["Project identity and the configured main scene are explicit."],
    },
    {
      id: "compile",
      goal: "Find parser or import failures before relying on runtime behavior.",
      tools: ["godot_script_check", "godot_project_check"],
      successCriteria: ["The changed script and then the project pass their applicable checks."],
    },
    {
      id: "edit",
      goal: "Apply guarded text or typed editor changes without silently overwriting newer work.",
      tools: ["godot_file_replace", "godot_file_write", "godot_editor_batch"],
      successCriteria: ["Mutation receipts match the intended project, content, scene, and history guards."],
    },
    {
      id: "visual",
      goal: "Collect pixels only for the visual facts that a screenshot can establish.",
      tools: ["godot_editor_screenshot", "godot_runtime_screenshot"],
      successCriteria: ["Evidence metadata identifies the project, scene, evidence class, and limitations."],
    },
    {
      id: "runtime",
      goal: "Observe the real running scene through structured state.",
      tools: ["godot_scene_launch", "godot_runtime_scene_tree", "godot_runtime_observe"],
      successCriteria: ["The expected scene and target nodes are present in structured runtime results."],
    },
    {
      id: "interactive",
      goal: "Prove player-facing behavior after bounded input.",
      tools: ["godot_runtime_ui_find", "godot_runtime_input", "godot_runtime_wait", "godot_runtime_assert"],
      successCriteria: ["A wait and assertion, not a screenshot alone, prove the expected state transition."],
    },
    {
      id: "cleanup",
      goal: "Leave no managed editor or runtime process behind.",
      tools: ["godot_run_stop"],
      successCriteria: ["Every managed run reaches a terminal state through godot_run_stop."],
    },
  ],
  editingRules: [
    "Prefer godot_file_replace for unique text changes; godot_file_write requires a create or matching SHA-256 guard.",
    "Prefer typed godot_editor_batch for multi-node edits; it creates one Undo/Redo action and never saves implicitly.",
    "Use scene, history, project fingerprint, and file hash receipts returned by the latest authoritative read or mutation.",
  ],
  diagnosticRules: [
    "Run godot_script_check before godot_project_check when one script changed.",
    "Call godot_diagnostics first, then follow nextActions with bounded godot_log_read calls.",
  ],
  honestyRules: [
    "Do not claim interaction success from screenshot evidence alone.",
    "Editor viewport evidence does not prove runtime behavior; a runtime frame still does not prove interaction.",
    "Do not claim model, device, export, host, or client execution that was not actually run.",
  ],
});

const RECIPES = deepFreeze<readonly AgentRecipe[]>([
  {
    id: "edit-and-verify-ui",
    title: "Edit and verify a UI flow",
    summary: "Guard one UI edit, compile it, then prove the real interaction with structured runtime evidence.",
    goal: "Change a Control-based UI and verify the player-visible state transition.",
    prerequisites: ["A local Godot project with a runnable UI scene and permission to modify it."],
    tools: [
      "godot_project_context", "godot_editor_launch", "godot_editor_status", "godot_editor_batch",
      "godot_editor_scene_save", "godot_script_check", "godot_project_check", "godot_run_stop",
      "godot_scene_launch", "godot_runtime_ui_find", "godot_runtime_screenshot", "godot_runtime_input",
      "godot_runtime_wait", "godot_runtime_assert",
    ],
    successCriteria: [
      "The guarded editor action is explicitly saved and the project checks pass.",
      "Runtime wait and assertion prove the intended UI state after input.",
    ],
    evidenceRequirements: [
      "Keep mutation/save receipts and structured wait/assert results.",
      "Treat screenshots only as runtime_frame visual evidence with provesInteraction=false.",
    ],
    cleanup: ["Stop every managed run with godot_run_stop."],
  },
  {
    id: "edit-and-verify-3d",
    title: "Edit and verify a 3D flow",
    summary: "Apply a guarded 3D scene edit and prove spatial and gameplay behavior with structured queries.",
    goal: "Change a Node3D scene and verify the running result through spatial and state assertions.",
    prerequisites: ["A runnable 3D scene with a Camera3D and an observable target node."],
    tools: [
      "godot_project_context", "godot_editor_launch", "godot_editor_status", "godot_editor_batch",
      "godot_editor_scene_save", "godot_editor_screenshot", "godot_project_check", "godot_run_stop",
      "godot_scene_launch", "godot_runtime_observe", "godot_runtime_3d_project", "godot_runtime_3d_raycast",
      "godot_runtime_input", "godot_runtime_wait", "godot_runtime_assert", "godot_runtime_screenshot",
    ],
    successCriteria: [
      "The saved scene passes project validation.",
      "Structured projection, raycast, wait, and assertion results prove the intended runtime behavior.",
    ],
    evidenceRequirements: [
      "Keep editor_viewport and runtime_frame receipts separate from structured interaction proof.",
      "Record target node paths and expected/actual assertion values.",
    ],
    cleanup: ["Stop every managed run with godot_run_stop."],
  },
  {
    id: "fix-script-error",
    title: "Fix a script parser error",
    summary: "Read and uniquely replace script text, run the lightweight script check, then validate the project.",
    goal: "Repair one GDScript or C# parse error without overwriting concurrent edits.",
    prerequisites: ["The failing project and script path are known."],
    tools: [
      "godot_project_context", "godot_file_read", "godot_file_replace", "godot_script_check",
      "godot_project_check", "godot_diagnostics", "godot_log_read",
    ],
    successCriteria: ["The script check and project check both pass after the guarded unique replacement."],
    evidenceRequirements: ["Keep the before/after SHA-256 receipt and file-level structured diagnostics."],
    cleanup: ["Stop every managed run with godot_run_stop."],
  },
  {
    id: "safe-scene-batch",
    title: "Apply one safe scene batch",
    summary: "Validate up to 32 typed operations, commit one native history action, inspect it, and save separately.",
    goal: "Make a multi-node editor change as one undoable action without an implicit save.",
    prerequisites: ["Project fingerprint, active scene path, and current native history version are known."],
    tools: [
      "godot_project_context", "godot_editor_launch", "godot_editor_status", "godot_editor_batch",
      "godot_editor_undo", "godot_editor_redo", "godot_editor_scene_save",
    ],
    successCriteria: [
      "The batch reports one action, dirty=true, saved=false, and a new history version.",
      "Guarded undo/redo affects the whole batch and explicit save reports its own outcome honestly.",
    ],
    evidenceRequirements: ["Keep batch, undo/redo, and save receipts as separate evidence."],
    cleanup: ["Stop every managed run with godot_run_stop."],
  },
  {
    id: "collect-debug-report",
    title: "Collect a reviewable debug report",
    summary: "Use the diagnostic funnel, bounded incremental logs, and a redacted report that requires review.",
    goal: "Package relevant local evidence without silently collecting source, secrets, or unlimited logs.",
    prerequisites: ["An issue summary and, when applicable, a managed runId are available."],
    tools: [
      "godot_project_context", "godot_diagnostics", "godot_log_read", "godot_debug_report",
    ],
    successCriteria: ["The report is bounded, redacted, evidence-sourced, and marked reviewRequired=true."],
    evidenceRequirements: ["Review the generated report before sharing and preserve its path and SHA-256 receipt."],
    cleanup: ["Stop every managed run with godot_run_stop."],
  },
]);

const RECIPE_MAP = new Map<RecipeId, AgentRecipe>(RECIPES.map((recipe) => [recipe.id, recipe]));
const OVERVIEW = deepFreeze<AgentGuideOverview>({
  kind: "overview",
  playbook: PLAYBOOK,
  recipes: RECIPES.map(({ id, title, summary, tools }): AgentRecipeSummary => ({ id, title, summary, tools })),
});

export function getAgentGuide(): AgentGuideOverview;
export function getAgentGuide(recipeId: RecipeId): AgentGuideRecipeResult;
export function getAgentGuide(recipeId?: RecipeId): AgentGuideOverview | AgentGuideRecipeResult {
  if (recipeId === undefined) return OVERVIEW;
  const recipe = RECIPE_MAP.get(recipeId);
  if (recipe === undefined) throw new Error(`Unknown agent recipe: ${recipeId}`);
  return deepFreeze({ kind: "recipe" as const, recipe });
}
