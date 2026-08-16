#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createMcpServer } from "./server.js";

serveStdio(createMcpServer, {
  onerror: (error) => {
    console.error(error.message);
  },
});
