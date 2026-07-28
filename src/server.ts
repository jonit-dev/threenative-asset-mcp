import { McpServer } from "@modelcontextprotocol/server";

import { FabClient } from "./fab/client.js";
import {
  AssetOutputSchema,
  createGetAssetHandler,
  GetAssetInputSchema,
} from "./tools/get-asset.js";
import {
  createSearchAssetsHandler,
  SearchOutputSchema,
  SearchToolInputSchema,
} from "./tools/search-assets.js";
import {
  createListFiltersHandler,
  ListFiltersInputSchema,
  ListFiltersOutputSchema,
} from "./tools/list-filters.js";
import {
  createListLimitedTimeFreeHandler,
  ListLimitedTimeFreeInputSchema,
  ListLimitedTimeFreeOutputSchema,
} from "./tools/list-limited-time-free.js";
import {
  createDownloadFreeAssetHandler,
  DownloadFreeAssetInputSchema,
  DownloadFreeAssetOutputSchema,
} from "./tools/download-free-asset.js";

export function createFabServer(
  client: FabClient = new FabClient(),
): McpServer {
  const server = new McpServer({
    name: "fab-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "fab_search_assets",
    {
      title: "Search Fab assets",
      description:
        "Search public Fab marketplace listings. Free assets are returned by default.",
      inputSchema: SearchToolInputSchema,
      outputSchema: SearchOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    createSearchAssetsHandler(client),
  );

  server.registerTool(
    "fab_get_asset",
    {
      title: "Get a Fab asset",
      description:
        "Get normalized public details and per-license prices for one Fab listing.",
      inputSchema: GetAssetInputSchema,
      outputSchema: AssetOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    createGetAssetHandler(client),
  );

  server.registerTool(
    "fab_list_filters",
    {
      title: "List Fab search filters",
      description:
        "List usable public Fab filter labels and slugs. A warning identifies versioned fallback or stale values.",
      inputSchema: ListFiltersInputSchema,
      outputSchema: ListFiltersOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    createListFiltersHandler(client),
  );

  server.registerTool(
    "fab_list_limited_time_free",
    {
      title: "List limited-time-free Fab promotions",
      description:
        "List Fab's dedicated curated limited-time-free promotions separately from general free search.",
      inputSchema: ListLimitedTimeFreeInputSchema,
      outputSchema: ListLimitedTimeFreeOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    createListLimitedTimeFreeHandler(client),
  );

  server.registerTool(
    "fab_download_free_asset",
    {
      title: "Download a free Fab asset file",
      description:
        "Download one directly available free Fab file into the configured local download directory. This never purchases or adds an asset to a library.",
      inputSchema: DownloadFreeAssetInputSchema,
      outputSchema: DownloadFreeAssetOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    createDownloadFreeAssetHandler(client),
  );

  const closeServer = server.close.bind(server);
  server.close = async () => {
    await Promise.allSettled([closeServer(), client.close()]);
  };
  server.server.onclose = () => {
    void client.close();
  };

  return server;
}
