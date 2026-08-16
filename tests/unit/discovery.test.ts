import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { findProjects } from "../../packages/core/src/discovery.js";

describe("findProjects", () => {
  it("finds the five bounded example projects", async () => {
    const result = await findProjects(resolve("examples"), {
      maxDepth: 2,
      maxProjects: 10,
    });

    expect(result.truncated).toBe(false);
    expect(result.projects.map((project) => project.name).sort()).toEqual([
      "Godot Agent Runtime Control UI",
      "Godot Agent Runtime Minimal 2D",
      "Godot Agent Runtime Minimal 3D",
      "Godot Agent Runtime Physics 2D",
      "Godot Agent Runtime Physics 3D",
    ]);
  });
});
