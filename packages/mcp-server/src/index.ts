import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createMcpServer } from "./server.js";

export { createMcpServer };

export async function serveMcpStdio(): Promise<void> {
  await serveStdio(createMcpServer, {
    onerror: (error) => {
      console.error(error.message);
    },
  });
}
