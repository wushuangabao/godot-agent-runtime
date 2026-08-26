import { describe, expect, it } from "vitest";

import {
  dispatchReleaseCommand,
} from "../../packages/release/src/bin.js";

describe("public release command dispatch", () => {
  it("configures the npm distribution before serving MCP", async () => {
    const events: string[] = [];
    await dispatchReleaseCommand(["mcp"], {
      configureDistribution: () => { events.push("configure"); },
      runCli: async () => { events.push("cli"); },
      serveMcpStdio: async () => { events.push("mcp"); },
    });

    expect(events).toEqual(["configure", "mcp"]);
  });

  it("passes every non-MCP argument to the existing CLI", async () => {
    const events: string[] = [];
    let received: readonly string[] = [];
    await dispatchReleaseCommand(
      ["setup", "codex", "--workspace", "C:\\fixture"],
      {
        configureDistribution: () => { events.push("configure"); },
        runCli: async (argv) => {
          events.push("cli");
          received = argv;
        },
        serveMcpStdio: async () => { events.push("mcp"); },
      },
    );

    expect(events).toEqual(["configure", "cli"]);
    expect(received).toEqual(["setup", "codex", "--workspace", "C:\\fixture"]);
  });
});
