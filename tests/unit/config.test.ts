import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { loadDevelopmentConfig } from "../../packages/core/src/config.js";

describe("loadDevelopmentConfig", () => {
  it("loads the ignored machine-local configuration", async () => {
    const config = await loadDevelopmentConfig(
      resolve("config", "development.local.json"),
    );

    expect(config.schemaVersion).toBe(1);
    expect(config.godot.executable).toMatch(/godot.*\.exe$/i);
  });
});
