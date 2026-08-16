import { performance } from "node:perf_hooks";
import { resolve } from "node:path";

import {
  checkProject,
  findProjects,
  inspectProject,
  runDoctor,
  runProject,
  toRuntimeError,
} from "../../../packages/core/dist/index.js";

const startedAt = performance.now();
const projectPath = resolve("examples", "control-ui");
const steps = [];

async function step(name, operation) {
  const stepStartedAt = performance.now();
  const result = await operation();
  steps.push({
    name,
    ok: result.ok ?? true,
    durationMs: Math.round(performance.now() - stepStartedAt),
  });
  return result;
}

try {
  const doctor = await step("doctor", async () => await runDoctor());
  if (!doctor.ok) throw new Error("Environment doctor failed.");

  const discovery = await step(
    "discover-projects",
    async () => await findProjects(resolve("examples"), { maxDepth: 2 }),
  );
  if (!discovery.projects.some((project) => project.projectPath === projectPath)) {
    throw new Error("Control UI project was not discovered.");
  }

  const project = await step("inspect-project", async () => await inspectProject(projectPath));
  const check = await step("check-project", async () =>
    await checkProject({ projectPath, timeoutMs: 30_000 }),
  );
  if (!check.ok) throw new Error("Control UI import check failed.");

  const run = await step("run-scene", async () =>
    await runProject({ projectPath, timeoutMs: 30_000 }),
  );
  const readyMarker = "GODOT_AGENT_RUNTIME_READY:control-ui";
  if (!run.ok || !`${run.stdout}\n${run.stderr}`.includes(readyMarker)) {
    throw new Error("Control UI ready marker was not observed.");
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        task: "headless-mvp-control-ui",
        project: project.name,
        toolCalls: steps.length,
        durationMs: Math.round(performance.now() - startedAt),
        evidence: { readyMarker },
        steps,
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: false,
        task: "headless-mvp-control-ui",
        durationMs: Math.round(performance.now() - startedAt),
        error: toRuntimeError(error),
        steps,
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = 1;
}
