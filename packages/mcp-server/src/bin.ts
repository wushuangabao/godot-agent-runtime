#!/usr/bin/env node

import { serveMcpStdio } from "./index.js";

try {
  await serveMcpStdio();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
