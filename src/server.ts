import { McpServer } from "@modelcontextprotocol/server";

import { FabClient } from "./fab/client.js";
import { PolyHavenClient } from "./polyhaven/client.js";
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
import {
  createPolyHavenGetAssetHandler,
  createPolyHavenListCategoriesHandler,
  createPolyHavenListFilesHandler,
  createPolyHavenSearchHandler,
  PolyHavenGetAssetInputSchema,
  PolyHavenGetAssetOutputSchema,
  PolyHavenListCategoriesInputSchema,
  PolyHavenListCategoriesOutputSchema,
  PolyHavenListFilesInputSchema,
  PolyHavenListFilesOutputSchema,
  PolyHavenSearchInputSchema,
  PolyHavenSearchOutputSchema,
} from "./tools/polyhaven.js";

export interface AssetServerClients {
  fab: FabClient;
  polyhaven: PolyHavenClient;
}

export function createAssetServer(
  clients: AssetServerClients = {
    fab: new FabClient(),
    polyhaven: new PolyHavenClient(),
  },
): McpServer {
  const { fab, polyhaven } = clients;
  const server = new McpServer({
    name: "threenative-asset-mcp",
    version: "0.2.0",
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
    createSearchAssetsHandler(fab),
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
    createGetAssetHandler(fab),
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
    createListFiltersHandler(fab),
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
    createListLimitedTimeFreeHandler(fab),
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
    createDownloadFreeAssetHandler(fab),
  );

  server.registerTool(
    "polyhaven_search_assets",
    {
      title: "Search Poly Haven assets",
      description:
        "Search CC0 HDRIs, textures, and models from Poly Haven. Results include explicit Poly Haven attribution.",
      inputSchema: PolyHavenSearchInputSchema,
      outputSchema: PolyHavenSearchOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    createPolyHavenSearchHandler(polyhaven),
  );

  server.registerTool(
    "polyhaven_get_asset",
    {
      title: "Get a Poly Haven asset",
      description:
        "Get normalized metadata, authorship, dimensions, and CC0 license information for one Poly Haven asset.",
      inputSchema: PolyHavenGetAssetInputSchema,
      outputSchema: PolyHavenGetAssetOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    createPolyHavenGetAssetHandler(polyhaven),
  );

  server.registerTool(
    "polyhaven_list_categories",
    {
      title: "List Poly Haven categories",
      description:
        "List Poly Haven category labels and asset counts for HDRIs, textures, or models.",
      inputSchema: PolyHavenListCategoriesInputSchema,
      outputSchema: PolyHavenListCategoriesOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    createPolyHavenListCategoriesHandler(polyhaven),
  );

  server.registerTool(
    "polyhaven_list_files",
    {
      title: "List Poly Haven asset files",
      description:
        "List official download URLs, byte sizes, MD5 hashes, and file dependencies for a Poly Haven asset, with format and resolution filters.",
      inputSchema: PolyHavenListFilesInputSchema,
      outputSchema: PolyHavenListFilesOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    createPolyHavenListFilesHandler(polyhaven),
  );

  const closeServer = server.close.bind(server);
  server.close = async () => {
    await Promise.allSettled([closeServer(), fab.close()]);
  };
  server.server.onclose = () => {
    void fab.close();
  };

  return server;
}

/** @deprecated Use createAssetServer to register every asset provider. */
export function createFabServer(client: FabClient = new FabClient()): McpServer {
  return createAssetServer({ fab: client, polyhaven: new PolyHavenClient() });
}
