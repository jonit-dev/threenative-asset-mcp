import { McpServer } from "@modelcontextprotocol/server";

import { AmbientCgClient } from "./ambientcg/client.js";
import { AudioCatalogClient } from "./audio/client.js";
import { BundleAssetClient } from "./bundle/client.js";
import { DirectAssetDownloader } from "./download/direct-asset-downloader.js";
import { FabClient } from "./fab/client.js";
import { ItchAssetClient } from "./itch/client.js";
import { PolyHavenClient } from "./polyhaven/client.js";
import { SketchfabClient } from "./sketchfab/client.js";
import { SmithsonianClient } from "./smithsonian/client.js";
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
import {
  AmbientCgGetAssetInputSchema,
  AmbientCgGetAssetOutputSchema,
  AmbientCgListCategoriesInputSchema,
  AmbientCgListCategoriesOutputSchema,
  AmbientCgListFilesInputSchema,
  AmbientCgListFilesOutputSchema,
  AmbientCgSearchInputSchema,
  AmbientCgSearchOutputSchema,
  createAmbientCgGetAssetHandler,
  createAmbientCgListCategoriesHandler,
  createAmbientCgListFilesHandler,
  createAmbientCgSearchHandler,
} from "./tools/ambientcg.js";
import {
  createSketchfabGetDownloadsHandler,
  createSketchfabGetModelHandler,
  createSketchfabListCategoriesHandler,
  createSketchfabSearchHandler,
  SketchfabGetDownloadsInputSchema,
  SketchfabGetDownloadsOutputSchema,
  SketchfabGetModelInputSchema,
  SketchfabGetModelOutputSchema,
  SketchfabListCategoriesInputSchema,
  SketchfabListCategoriesOutputSchema,
  SketchfabSearchInputSchema,
  SketchfabSearchOutputSchema,
} from "./tools/sketchfab.js";
import {
  createSmithsonianGetAssetHandler,
  createSmithsonianListFilesHandler,
  createSmithsonianSearchHandler,
  SmithsonianGetAssetInputSchema,
  SmithsonianGetAssetOutputSchema,
  SmithsonianListFilesInputSchema,
  SmithsonianListFilesOutputSchema,
  SmithsonianSearchInputSchema,
  SmithsonianSearchOutputSchema,
} from "./tools/smithsonian.js";
import {
  AudioDownloadInputSchema,
  AudioDownloadOutputSchema,
  AudioListSourcesInputSchema,
  AudioListSourcesOutputSchema,
  AudioSearchInputSchema,
  AudioSearchOutputSchema,
  createAudioDownloadHandler,
  createAudioListSourcesHandler,
  createAudioSearchHandler,
} from "./tools/audio.js";
import {
  AssetListSourcesInputSchema,
  AssetSearchSourcesInputSchema,
  AssetSourceListOutputSchema,
  createAssetListSourcesHandler,
  createAssetSearchSourcesHandler,
} from "./tools/source-directory.js";
import {
  createDirectAssetDownloadHandler,
  DirectAssetDownloadInputSchema,
  DirectAssetDownloadOutputSchema,
} from "./tools/direct-download.js";
import {
  createItchDownloadHandler,
  createItchListDownloadsHandler,
  ItchDownloadInputSchema,
  ItchDownloadOutputSchema,
  ItchListDownloadsInputSchema,
  ItchListDownloadsOutputSchema,
} from "./tools/itch.js";
import {
  BundleDownloadAnimationInputSchema,
  BundleDownloadAnimationOutputSchema,
  BundleDownloadEntryInputSchema,
  BundleDownloadEntryOutputSchema,
  BundleListAnimationsInputSchema,
  BundleListAnimationsOutputSchema,
  BundleListEntriesInputSchema,
  BundleListEntriesOutputSchema,
  createBundleDownloadAnimationHandler,
  createBundleDownloadEntryHandler,
  createBundleListAnimationsHandler,
  createBundleListEntriesHandler,
} from "./tools/bundle.js";
import {
  AssetImportUnrealInputSchema,
  createAssetImportUnrealHandler,
  createFabImportAssetHandler,
  FabImportAssetInputSchema,
  ImportUnrealOutputSchema,
} from "./tools/import-unreal.js";

export interface AssetServerClients {
  fab: FabClient;
  polyhaven: PolyHavenClient;
  ambientcg: AmbientCgClient;
  smithsonian: SmithsonianClient;
  sketchfab: SketchfabClient;
  audio: AudioCatalogClient;
  directDownloader: DirectAssetDownloader;
  itch: ItchAssetClient;
  bundle: BundleAssetClient;
}

export function createAssetServer(
  clients: AssetServerClients = {
    fab: new FabClient(),
    polyhaven: new PolyHavenClient(),
    ambientcg: new AmbientCgClient(),
    smithsonian: new SmithsonianClient(),
    sketchfab: new SketchfabClient(),
    audio: new AudioCatalogClient(),
    directDownloader: new DirectAssetDownloader(),
    itch: new ItchAssetClient(),
    bundle: new BundleAssetClient({ itch: new ItchAssetClient() }),
  },
): McpServer {
  const {
    fab,
    polyhaven,
    ambientcg,
    smithsonian,
    sketchfab,
    audio,
    directDownloader,
    itch,
    bundle,
  } = clients;
  const server = new McpServer({
    name: "threenative-asset-mcp",
    version: "0.4.0",
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
    "asset_import_unreal",
    {
      title: "Import a local Unreal asset directory",
      description:
        "Convert a local directory of Unreal .uasset files into self-contained source GLBs under a game's assets directory, with reconstructed PBR materials and a provenance report. Works on any already-downloaded Unreal pack, whatever downloaded it.",
      inputSchema: AssetImportUnrealInputSchema,
      outputSchema: ImportUnrealOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    createAssetImportUnrealHandler(),
  );

  server.registerTool(
    "fab_import_asset",
    {
      title: "Import an owned Fab Unreal asset",
      description:
        "Download an Unreal asset the signed-in Fab account already owns and convert it to source GLBs in one step. Uses the FabCLI session the user established themselves; it never logs in, claims, or purchases anything.",
      inputSchema: FabImportAssetInputSchema,
      outputSchema: ImportUnrealOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    createFabImportAssetHandler(),
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

  server.registerTool(
    "ambientcg_search_assets",
    {
      title: "Search ambientCG assets",
      description:
        "Search CC0 materials, HDRIs, models, decals, atlases, brushes, terrains, and other ambientCG assets.",
      inputSchema: AmbientCgSearchInputSchema,
      outputSchema: AmbientCgSearchOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    createAmbientCgSearchHandler(ambientcg),
  );
  server.registerTool(
    "ambientcg_get_asset",
    {
      title: "Get an ambientCG asset",
      description: "Get normalized metadata and CC0 licensing for one ambientCG asset.",
      inputSchema: AmbientCgGetAssetInputSchema,
      outputSchema: AmbientCgGetAssetOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    createAmbientCgGetAssetHandler(ambientcg),
  );
  server.registerTool(
    "ambientcg_list_categories",
    {
      title: "List ambientCG categories",
      description: "List ambientCG category metadata and asset counts.",
      inputSchema: AmbientCgListCategoriesInputSchema,
      outputSchema: AmbientCgListCategoriesOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    createAmbientCgListCategoriesHandler(ambientcg),
  );
  server.registerTool(
    "ambientcg_list_files",
    {
      title: "List ambientCG files",
      description:
        "List official CC0 asset archives with variant attributes, extensions, URLs, and byte sizes.",
      inputSchema: AmbientCgListFilesInputSchema,
      outputSchema: AmbientCgListFilesOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    createAmbientCgListFilesHandler(ambientcg),
  );

  server.registerTool(
    "smithsonian_search_assets",
    {
      title: "Search Smithsonian 3D assets",
      description:
        "Search Smithsonian Open Access 3D models and file variants by text, type, quality, and owning unit.",
      inputSchema: SmithsonianSearchInputSchema,
      outputSchema: SmithsonianSearchOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    createSmithsonianSearchHandler(smithsonian),
  );
  server.registerTool(
    "smithsonian_get_asset",
    {
      title: "Get a Smithsonian 3D asset",
      description: "Get a normalized summary of one Smithsonian Open Access 3D model.",
      inputSchema: SmithsonianGetAssetInputSchema,
      outputSchema: SmithsonianGetAssetOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    createSmithsonianGetAssetHandler(smithsonian),
  );
  server.registerTool(
    "smithsonian_list_files",
    {
      title: "List Smithsonian 3D files",
      description:
        "List direct Smithsonian Open Access files with format, quality, compression, and orientation metadata.",
      inputSchema: SmithsonianListFilesInputSchema,
      outputSchema: SmithsonianListFilesOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    createSmithsonianListFilesHandler(smithsonian),
  );

  server.registerTool(
    "sketchfab_search_models",
    {
      title: "Search Sketchfab models",
      description:
        "Search public Sketchfab models and return per-model license, author, geometry, and archive metadata.",
      inputSchema: SketchfabSearchInputSchema,
      outputSchema: SketchfabSearchOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    createSketchfabSearchHandler(sketchfab),
  );
  server.registerTool(
    "sketchfab_get_model",
    {
      title: "Get a Sketchfab model",
      description:
        "Get public metadata and explicit Creative Commons requirements for one Sketchfab model.",
      inputSchema: SketchfabGetModelInputSchema,
      outputSchema: SketchfabGetModelOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    createSketchfabGetModelHandler(sketchfab),
  );
  server.registerTool(
    "sketchfab_list_categories",
    {
      title: "List Sketchfab categories",
      description: "List public Sketchfab model category names and slugs.",
      inputSchema: SketchfabListCategoriesInputSchema,
      outputSchema: SketchfabListCategoriesOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    createSketchfabListCategoriesHandler(sketchfab),
  );
  server.registerTool(
    "sketchfab_get_downloads",
    {
      title: "Get Sketchfab download URLs",
      description:
        "Get temporary download URLs for a downloadable Sketchfab model using the user's SKETCHFAB_API_TOKEN. This does not store credentials or download files.",
      inputSchema: SketchfabGetDownloadsInputSchema,
      outputSchema: SketchfabGetDownloadsOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    createSketchfabGetDownloadsHandler(sketchfab),
  );

  server.registerTool(
    "audio_list_sources",
    {
      title: "List game-audio sources",
      description:
        "List supported audio libraries, best uses, licensing caveats, browse pages, and whether this MCP has a curated direct-download contract.",
      inputSchema: AudioListSourcesInputSchema,
      outputSchema: AudioListSourcesOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    createAudioListSourcesHandler(audio),
  );
  server.registerTool(
    "audio_search_assets",
    {
      title: "Search downloadable game-audio packs",
      description:
        "Search the curated catalog of official audio packs with stable direct URLs and explicit license metadata. Use audio_list_sources for broader provider-page discovery.",
      inputSchema: AudioSearchInputSchema,
      outputSchema: AudioSearchOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    createAudioSearchHandler(audio),
  );
  server.registerTool(
    "audio_download_asset",
    {
      title: "Download a curated game-audio pack",
      description:
        "Download one catalog asset by ID into the dedicated audio directory after explicit license acknowledgement. URLs and redirects are restricted to curated official hosts; existing files are never overwritten.",
      inputSchema: AudioDownloadInputSchema,
      outputSchema: AudioDownloadOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    createAudioDownloadHandler(audio),
  );

  server.registerTool(
    "itch_list_downloads",
    {
      title: "List curated itch.io pack downloads",
      description:
        "Resolve a fresh no-account itch.io download page and list its upload IDs, names, sizes, license, and safe suggested filenames. Signed page tokens are never returned.",
      inputSchema: ItchListDownloadsInputSchema,
      outputSchema: ItchListDownloadsOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    createItchListDownloadsHandler(itch),
  );
  server.registerTool(
    "itch_download_asset",
    {
      title: "Download a curated itch.io asset pack",
      description:
        "Resolve a fresh signed itch.io file URL for a listed upload and stream it into guarded local storage after explicit license acknowledgement. Signed URLs are not exposed in the MCP result.",
      inputSchema: ItchDownloadInputSchema,
      outputSchema: ItchDownloadOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    createItchDownloadHandler(itch),
  );

  server.registerTool(
    "asset_list_bundle_entries",
    {
      title: "List files inside a remote asset bundle",
      description:
        "Inspect a curated itch.io ZIP through HTTP byte ranges without downloading the whole archive. Returns individual entry paths and compressed/uncompressed sizes; signed URLs are never exposed.",
      inputSchema: BundleListEntriesInputSchema,
      outputSchema: BundleListEntriesOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    createBundleListEntriesHandler(bundle),
  );
  server.registerTool(
    "asset_download_bundle_entry",
    {
      title: "Download one file from a remote asset bundle",
      description:
        "Extract one selected ZIP entry through HTTP byte ranges, cache it locally, and avoid downloading unrelated bundle contents. Requires explicit license acknowledgement.",
      inputSchema: BundleDownloadEntryInputSchema,
      outputSchema: BundleDownloadEntryOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    createBundleDownloadEntryHandler(bundle),
  );
  server.registerTool(
    "asset_list_bundle_animations",
    {
      title: "List animation clips inside a bundled GLB",
      description:
        "Range-extract and cache only the aggregate GLB from a curated bundle, then return its named animation clips. The standard non-root-motion GLB is selected automatically when entryPath is omitted.",
      inputSchema: BundleListAnimationsInputSchema,
      outputSchema: BundleListAnimationsOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    createBundleListAnimationsHandler(bundle),
  );
  server.registerTool(
    "asset_download_bundle_animation",
    {
      title: "Download one animation from a bundled GLB",
      description:
        "Export one named animation as a small standalone GLB after range-fetching only the aggregate source entry. Unrelated clips, meshes, materials, and textures are removed; cached source entries are reused.",
      inputSchema: BundleDownloadAnimationInputSchema,
      outputSchema: BundleDownloadAnimationOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    createBundleDownloadAnimationHandler(bundle),
  );

  server.registerTool(
    "asset_list_sources",
    {
      title: "List recommended asset sources",
      description:
        "List agent-ready sources by default: every result has an MCP download path requiring no manual browser, login, checkout, or paywall. Set agentReadyOnly=false to inspect the broader research directory, including package-manager, Git, authenticated, and provider-page sources.",
      inputSchema: AssetListSourcesInputSchema,
      outputSchema: AssetSourceListOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    createAssetListSourcesHandler(),
  );
  server.registerTool(
    "asset_search_sources",
    {
      title: "Search recommended asset sources",
      description:
        "Search agent-ready asset sources by category, license, access mode, or text query. Manual/provider-page sources are excluded unless agentReadyOnly=false.",
      inputSchema: AssetSearchSourcesInputSchema,
      outputSchema: AssetSourceListOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    createAssetSearchSourcesHandler(),
  );
  server.registerTool(
    "asset_download_file",
    {
      title: "Download a direct provider asset file",
      description:
        "Download a file URL returned by Poly Haven, ambientCG, or Smithsonian MCP tools, or a curated Game-icons.net/Kenney direct ZIP, into guarded local storage after license acknowledgement. Provider hosts and URL shapes are allowlisted, redirects are revalidated, files are streamed with a byte cap, and existing files are never overwritten.",
      inputSchema: DirectAssetDownloadInputSchema,
      outputSchema: DirectAssetDownloadOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    createDirectAssetDownloadHandler(directDownloader),
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
  return createAssetServer({
    fab: client,
    polyhaven: new PolyHavenClient(),
    ambientcg: new AmbientCgClient(),
    smithsonian: new SmithsonianClient(),
    sketchfab: new SketchfabClient(),
    audio: new AudioCatalogClient(),
    directDownloader: new DirectAssetDownloader(),
    itch: new ItchAssetClient(),
    bundle: new BundleAssetClient({ itch: new ItchAssetClient() }),
  });
}
