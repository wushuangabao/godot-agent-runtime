#!/usr/bin/env node

import { toRuntimeError } from "@godot-agent-runtime/core";

import { runCli } from "./main.js";

try {
  await runCli();
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: toRuntimeError(error) }, null, 2)}\n`);
  process.exitCode = 1;
}
