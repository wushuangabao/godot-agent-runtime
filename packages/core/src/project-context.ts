import type { ProjectContext } from "@godot-agent-runtime/protocol";

import { getEditorInfo } from "./editor.js";
import { getProjectSnapshot } from "./project.js";
import { getRuntimeInfo } from "./runtime.js";

export interface ProjectContextOptions {
  readonly projectPath: string;
  readonly editorRunId?: string;
  readonly runtimeRunId?: string;
}

export async function getProjectContext(
  options: ProjectContextOptions,
): Promise<ProjectContext> {
  const { project, identity } = await getProjectSnapshot(options.projectPath);
  const editor = options.editorRunId === undefined
    ? null
    : await getEditorInfo({
        projectPath: identity.projectPath,
        runId: options.editorRunId,
      });
  const runtime = options.runtimeRunId === undefined
    ? null
    : await getRuntimeInfo({
        projectPath: identity.projectPath,
        runId: options.runtimeRunId,
      });

  return { ok: true, project, identity, editor, runtime };
}
