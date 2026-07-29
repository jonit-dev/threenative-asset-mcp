#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { AmbientCgClient } from "./ambientcg/client.js";
import { AudioCatalogClient } from "./audio/client.js";
import { BundleAssetClient } from "./bundle/client.js";
import { DirectAssetDownloader } from "./download/direct-asset-downloader.js";
import { FabClient } from "./fab/client.js";
import { ItchAssetClient } from "./itch/client.js";
import { PolyHavenClient } from "./polyhaven/client.js";
import { SketchfabClient } from "./sketchfab/client.js";
import { createAssetServer } from "./server.js";
import { SmithsonianClient } from "./smithsonian/client.js";

const fab = new FabClient();
const polyhaven = new PolyHavenClient();
const ambientcg = new AmbientCgClient();
const smithsonian = new SmithsonianClient();
const sketchfab = new SketchfabClient();
const audio = new AudioCatalogClient();
const directDownloader = new DirectAssetDownloader();
const itch = new ItchAssetClient({ downloader: directDownloader });
const bundle = new BundleAssetClient({ itch });
void fab.prepareBrowser();
const handle = serveStdio(
  () =>
    createAssetServer({
      fab,
      polyhaven,
      ambientcg,
      smithsonian,
      sketchfab,
      audio,
      directDownloader,
      itch,
      bundle,
    }),
  {
  onerror(error) {
    process.stderr.write(
      `${JSON.stringify({
        level: "error",
        message: "MCP transport error",
        error: error.name,
      })}\n`,
    );
  },
  },
);

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
