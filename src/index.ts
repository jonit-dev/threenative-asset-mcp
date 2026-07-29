#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { FabClient } from "./fab/client.js";
import { PolyHavenClient } from "./polyhaven/client.js";
import { createAssetServer } from "./server.js";

const fab = new FabClient();
const polyhaven = new PolyHavenClient();
void fab.prepareBrowser();
const handle = serveStdio(() => createAssetServer({ fab, polyhaven }), {
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
  await Promise.allSettled([fab.close(), handle.close()]);
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
