#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { FabClient } from "./fab/client.js";
import { createFabServer } from "./server.js";

const client = new FabClient();
void client.prepareBrowser();
const handle = serveStdio(() => createFabServer(client), {
  onerror(error) {
    process.stderr.write(
      `${JSON.stringify({
        level: "error",
        message: "MCP transport error",
        error: error.name,
      })}\n`,
    );
  },
});

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await Promise.allSettled([client.close(), handle.close()]);
}

process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
process.once("beforeExit", () => {
  void shutdown();
});
