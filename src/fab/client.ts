import type { SearchInput, SearchOutput } from "../tools/search-assets.js";
import type {
  FilterGroups,
  FilterKind,
  ListFiltersInput,
  ListFiltersOutput,
} from "../tools/list-filters.js";
import type {
  ListLimitedTimeFreeInput,
  ListLimitedTimeFreeOutput,
} from "../tools/list-limited-time-free.js";
import { loadFabConfig } from "../config.js";
import { BrowserFabTransport } from "./browser-transport.js";
import { TtlLruCache } from "./cache.js";
import {
  DirectFabTransport,
  FabClientError,
  type FabDownloadRequest,
  type FabDownloadResult,
  type FabErrorCode,
  type FabTransport,
} from "./direct-transport.js";
import { createStderrLogger, nullFabLogger, type FabLogger } from "./errors.js";

const FAB_ORIGIN = "https://www.fab.com";
const SEARCH_PATH = "/i/listings/search";
const TAXONOMY_TTL_MS = 6 * 60 * 60 * 1_000;
const SEARCH_TTL_MS = 5 * 60 * 1_000;
const LISTING_TTL_MS = 15 * 60 * 1_000;
const LIMITED_TIME_FREE_TTL_MS = 10 * 60 * 1_000;
const MAX_SEARCH_PAYLOAD_BYTES = 256 * 1_024;
const TAXONOMY_CACHE_KEY = "taxonomy:public-filter-groups";
const TAXONOMY_CONTRACT_VERSION = "fab-taxonomy-fallback-2026-07-28";
const TAXONOMY_CAPTURED_AT = "2026-07-28T00:00:00.000Z";
const FILTER_KINDS: FilterKind[] = [
  "channels",
  "listing_types",
  "formats",
  "categories",
  "licenses",
];
const ALLOWED_DISCOVERY_PATHS = new Set([
  "/i/public/taxonomy",
  "/i/public/limited-time-free",
]);
const INTERNAL_FILTER_PATTERN =
  /(^|[-_\s])(admin|internal|private|staff|hidden|test)([-_\s]|$)/i;

const FALLBACK_FILTERS: FilterGroups = {
  channels: [
    { label: "Unreal Engine", slug: "unreal-engine" },
    { label: "Unity", slug: "unity" },
  ],
  listing_types: [{ label: "3D Model", slug: "3d-model" }],
  formats: [
    { label: "FBX", slug: "fbx" },
    { label: "glTF", slug: "gltf" },
  ],
  categories: [{ label: "Environments", slug: "environments" }],
  licenses: [
    { label: "Personal", slug: "personal" },
    { label: "Professional", slug: "professional" },
  ],
};

const FALLBACK_WARNING =
  "Fab has no confirmed anonymous taxonomy JSON contract; returning versioned fallback values captured on 2026-07-28.";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface FabDiscoveryOptions {
  /**
   * Optional public JSON operation captured by a future contract probe.
   * It is intentionally unset until a stable anonymous `/i/...` route exists.
   */
  taxonomyPath?: string;
  /**
   * Optional dedicated promotion JSON operation captured by a future probe.
   * General search is deliberately not accepted as a promotion source.
   */
  limitedTimeFreePath?: string;
  /**
   * A dedicated curated seam, for example an ID payload extracted from the
   * public `/limited-time-free` page by the MCP-owned browser profile.
   */
  limitedTimeFreeProvider?: () => Promise<unknown>;
  now?: () => number;
  taxonomyTtlMs?: number;
  logger?: FabLogger;
  cache?: TtlLruCache<unknown>;
}

interface TaxonomyCacheEntry {
  filters: FilterGroups;
  capturedAt: string;
  cachedAtMs: number;
  contractVersion: string;
  warnings: string[];
}

export {
  DirectFabTransport,
  FabClientError,
  type FabErrorCode,
  type FabTransport,
};

const sortTokens: Record<NonNullable<SearchInput["sort"]>, string> = {
  relevance: "-relevance",
  rating: "-ratings.averageRating",
  newest: "-firstPublishedAt",
  oldest: "firstPublishedAt",
  price_asc: "price",
  price_desc: "-price",
  discount_desc: "-min_discount_percentage",
  recently_updated: "-publishedAt",
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function firstString(
  record: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = asString(record?.[key]);
    if (value) return value;
  }
  return undefined;
}

function firstNumber(
  record: Record<string, unknown> | undefined,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = asNumber(record?.[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function safeHttpsUrl(value: unknown): string | undefined {
  const text = asString(value);
  if (!text || text.length > 1_024) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function publicOperationUrl(path: string): URL {
  const url = new URL(path, FAB_ORIGIN);
  const segments = url.pathname.toLowerCase().split("/").filter(Boolean);
  if (
    url.origin !== FAB_ORIGIN ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    !ALLOWED_DISCOVERY_PATHS.has(url.pathname) ||
    segments.includes("admin")
  ) {
    throw new FabClientError(
      "FAB_INTERNAL",
      "Discovery operations must use an explicitly approved public Fab route.",
    );
  }
  return url;
}

function normalizeFilterValue(
  value: unknown,
): { label: string; slug: string } | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    if (
      !normalized ||
      normalized.length > 200 ||
      INTERNAL_FILTER_PATTERN.test(normalized)
    ) {
      return undefined;
    }
    return { label: normalized, slug: normalized };
  }
  const record = asRecord(value);
  if (!record) return undefined;
  if (
    record.hidden === true ||
    record.internal === true ||
    record.isInternal === true ||
    record.adminOnly === true
  ) {
    return undefined;
  }
  const label = firstString(record, "label", "name", "title");
  const slug = firstString(record, "slug", "code", "value", "id");
  if (!label || !slug || label.length > 200 || slug.length > 200) {
    return undefined;
  }
  if (
    INTERNAL_FILTER_PATTERN.test(slug) ||
    INTERNAL_FILTER_PATTERN.test(label)
  ) {
    return undefined;
  }
  return { label, slug };
}

function normalizeFilterGroup(value: unknown): Array<{
  label: string;
  slug: string;
}> {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const normalized = [];
  for (const entry of value) {
    const item = normalizeFilterValue(entry);
    if (!item || seen.has(item.slug)) continue;
    seen.add(item.slug);
    normalized.push(item);
    if (normalized.length === 200) break;
  }
  return normalized;
}

function normalizeTaxonomy(value: unknown): FilterGroups {
  const envelope = asRecord(value);
  const root =
    asRecord(envelope?.filters) ??
    asRecord(envelope?.taxonomy) ??
    asRecord(envelope?.data) ??
    envelope;
  if (!root) {
    throw new FabClientError(
      "FAB_UPSTREAM_CHANGED",
      "Fab's taxonomy response no longer matches the expected contract.",
    );
  }
  const filters: FilterGroups = {
    channels: normalizeFilterGroup(root.channels),
    listing_types: normalizeFilterGroup(
      root.listing_types ?? root.listingTypes,
    ),
    formats: normalizeFilterGroup(
      root.formats ?? root.asset_formats ?? root.assetFormats,
    ),
    categories: normalizeFilterGroup(root.categories),
    licenses: normalizeFilterGroup(root.licenses),
  };
  if (FILTER_KINDS.some((kind) => filters[kind].length === 0)) {
    throw new FabClientError(
      "FAB_UPSTREAM_CHANGED",
      "Fab's taxonomy response is missing a required public filter group.",
    );
  }
  return filters;
}

function selectFilterKinds(
  filters: FilterGroups,
  kinds: FilterKind[] | undefined,
): Partial<FilterGroups> {
  const selected: Partial<FilterGroups> = {};
  for (const kind of kinds ?? FILTER_KINDS) selected[kind] = filters[kind];
  return selected;
}

function explicitPromotionEnd(value: unknown): string | undefined {
  const text = asString(value);
  if (
    !text ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      text,
    ) ||
    !Number.isFinite(Date.parse(text))
  ) {
    return undefined;
  }
  return text;
}

function promotionEntries(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  const entries = record?.results ?? record?.items ?? record?.listings;
  return Array.isArray(entries) ? entries : undefined;
}

function priceFrom(value: unknown):
  | {
      amount: number;
      currency: string;
      effectiveAmount?: number;
    }
  | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const amount = firstNumber(record, "amount", "price");
  if (amount === undefined) return undefined;
  const currency = (
    firstString(record, "currency", "currencyCode") ?? "USD"
  ).slice(0, 10);
  const effectiveAmount = firstNumber(
    record,
    "effectiveAmount",
    "discountedAmount",
    "discountPrice",
  );
  return {
    amount,
    currency,
    ...(effectiveAmount === undefined ? {} : { effectiveAmount }),
  };
}

function normalizeFormats(record: Record<string, unknown>): string[] {
  const raw = record.assetFormats ?? record.asset_formats ?? record.formats;
  if (!Array.isArray(raw)) return [];
  const values = raw.flatMap((entry) => {
    if (typeof entry === "string") return [entry.slice(0, 100)];
    const item = asRecord(entry);
    const value = firstString(item, "slug", "name", "code");
    return value ? [value.slice(0, 100)] : [];
  });
  return [...new Set(values)].slice(0, 20);
}

function normalizeTags(
  record: Record<string, unknown>,
): Array<{ name: string; slug?: string }> {
  if (!Array.isArray(record.tags)) return [];
  return record.tags
    .flatMap((entry) => {
      if (typeof entry === "string") {
        return [{ name: entry.slice(0, 100) }];
      }
      const tag = asRecord(entry);
      const name = firstString(tag, "name", "label", "slug");
      if (!name) return [];
      const slug = firstString(tag, "slug");
      return [
        {
          name: name.slice(0, 100),
          ...(slug ? { slug: slug.slice(0, 100) } : {}),
        },
      ];
    })
    .slice(0, 20);
}

function licenseEffectiveAmount(value: unknown): number | undefined {
  const license = asRecord(value);
  if (!license) return undefined;
  const price =
    priceFrom(license.price) ??
    priceFrom(license.pricing) ??
    priceFrom(license.basePrice);
  const discounted =
    priceFrom(license.discountedPrice) ??
    priceFrom(license.effectivePrice) ??
    priceFrom(license.salePrice);
  return (
    discounted?.effectiveAmount ??
    discounted?.amount ??
    price?.effectiveAmount ??
    price?.amount
  );
}

function normalizeSearchItem(
  value: unknown,
): SearchOutput["items"][number] | null {
  const record = asRecord(value);
  if (!record) return null;
  const rawId = firstString(record, "uid", "id", "uuid");
  const rawTitle = firstString(record, "title", "name");
  if (!rawId || !rawTitle) return null;
  const id = rawId.slice(0, 100);
  const title = rawTitle.slice(0, 500);

  const seller = asRecord(record.seller ?? record.publisher);
  const sellerName = firstString(
    seller,
    "name",
    "displayName",
    "username",
  )?.slice(0, 200);
  const categoryValue =
    asRecord(record.category) ??
    (Array.isArray(record.categories)
      ? asRecord(record.categories[0])
      : undefined);
  const categoryName = firstString(categoryValue, "name", "label");
  const categorySlug = firstString(categoryValue, "slug", "path");
  const ratingValue = asRecord(record.rating ?? record.ratings);
  const average = firstNumber(ratingValue, "average", "averageRating");
  const count = firstNumber(ratingValue, "count", "ratingCount", "total");
  const thumbnailRecord = asRecord(record.thumbnail);
  const startingPrice =
    priceFrom(record.startingPrice) ??
    priceFrom(record.starting_price) ??
    priceFrom(record.price);
  const licenses = Array.isArray(record.licenses) ? record.licenses : [];
  const licenseAmounts = licenses
    .map(licenseEffectiveAmount)
    .filter((amount): amount is number => amount !== undefined);
  const isFree =
    licenseAmounts.length > 0
      ? licenseAmounts.some((amount) => amount === 0)
      : startingPrice?.effectiveAmount === 0 || startingPrice?.amount === 0;

  return {
    id,
    title,
    url: `${FAB_ORIGIN}/listings/${id}`,
    ...(sellerName
      ? {
          publisher: {
            ...(firstString(seller, "uid", "id")
              ? { id: firstString(seller, "uid", "id")?.slice(0, 200) }
              : {}),
            name: sellerName,
            ...(safeHttpsUrl(seller?.url)
              ? { url: safeHttpsUrl(seller?.url) }
              : {}),
          },
        }
      : {}),
    ...(firstString(record, "listingType", "listing_type", "type")
      ? {
          listingType: firstString(
            record,
            "listingType",
            "listing_type",
            "type",
          )?.slice(0, 200),
        }
      : {}),
    ...(categoryName || categorySlug
      ? {
          category: {
            ...(categoryName ? { name: categoryName.slice(0, 200) } : {}),
            ...(categorySlug ? { slug: categorySlug.slice(0, 200) } : {}),
          },
        }
      : {}),
    formats: normalizeFormats(record),
    tags: normalizeTags(record),
    ...(safeHttpsUrl(
      record.thumbnailUrl ?? thumbnailRecord?.url ?? record.thumbnail,
    )
      ? {
          thumbnailUrl: safeHttpsUrl(
            record.thumbnailUrl ?? thumbnailRecord?.url ?? record.thumbnail,
          ),
        }
      : {}),
    ...(average !== undefined && count !== undefined
      ? { rating: { average, count } }
      : {}),
    ...(startingPrice ? { startingPrice } : {}),
    isFree,
    ...(typeof record.isDiscounted === "boolean"
      ? { isDiscounted: record.isDiscounted }
      : {}),
    ...(typeof record.isAiGenerated === "boolean"
      ? { isAiGenerated: record.isAiGenerated }
      : {}),
    ...(typeof record.is_ai_generated === "boolean"
      ? { isAiGenerated: record.is_ai_generated }
      : {}),
    ...(typeof record.isAiForbidden === "boolean"
      ? { allowsAiUse: !record.isAiForbidden }
      : {}),
    ...(typeof record.is_ai_forbidden === "boolean"
      ? { allowsAiUse: !record.is_ai_forbidden }
      : {}),
    ...(typeof record.isMature === "boolean"
      ? { isMature: record.isMature }
      : {}),
    ...(firstString(record, "firstPublishedAt", "publishedAt")
      ? {
          publishedAt: firstString(
            record,
            "firstPublishedAt",
            "publishedAt",
          )?.slice(0, 100),
        }
      : {}),
    ...(firstString(record, "publishedAt", "updatedAt")
      ? {
          updatedAt: firstString(record, "publishedAt", "updatedAt")?.slice(
            0,
            100,
          ),
        }
      : {}),
  };
}

export function buildSearchUrl(input: SearchInput): URL {
  const url = new URL(SEARCH_PATH, FAB_ORIGIN);
  const params = url.searchParams;
  if (input.query) params.set("q", input.query);
  if (input.priceMode === "free") params.set("is_free", "1");
  if (input.priceMode === "range") {
    params.set("price", `${input.minPrice ?? ""}..${input.maxPrice ?? ""}`);
  }

  const repeated: Array<[key: string, values: string[] | undefined]> = [
    ["channels", input.channels],
    ["listing_types", input.listingTypes],
    ["categories", input.categories],
    ["asset_formats", input.formats],
    ["tags", input.tags],
    ["licenses", input.licenses],
  ];
  for (const [key, values] of repeated) {
    for (const value of values ?? []) params.append(key, value);
  }

  if (input.publisher) params.set("seller", input.publisher);
  if (input.minimumRating !== undefined) {
    params.set("average_rating", `${input.minimumRating}..5`);
  }
  if (input.publishedSince) {
    params.set("published_since", input.publishedSince);
  }
  if (input.aiGenerated !== undefined) {
    params.set("is_ai_generated", input.aiGenerated ? "1" : "0");
  }
  if (input.allowsAiUse !== undefined) {
    params.set("is_ai_forbidden", input.allowsAiUse ? "0" : "1");
  }
  params.set("sort_by", sortTokens[input.sort]);
  params.set("count", String(input.limit));
  params.set("currency", input.currency);
  if (input.cursor) params.set("cursor", input.cursor);
  return url;
}

export class FabClient {
  private readonly directTransport: FabTransport;
  private readonly browserTransport: FabTransport | undefined;
  private readonly discovery: FabDiscoveryOptions;
  private readonly cache: TtlLruCache<unknown>;
  private readonly logger: FabLogger;
  private readonly now: () => number;

  constructor(
    directTransport?: FabTransport,
    browserTransport?: FabTransport,
    discovery: FabDiscoveryOptions = {},
  ) {
    this.discovery = discovery;
    this.now = discovery.now ?? Date.now;
    this.cache = discovery.cache ?? new TtlLruCache<unknown>({ now: this.now });
    if (directTransport) {
      this.directTransport = directTransport;
      this.browserTransport = browserTransport;
      this.logger = discovery.logger ?? nullFabLogger;
      return;
    }
    const config = loadFabConfig();
    this.logger = createStderrLogger({
      level: config.logLevel,
      logQueries: config.logQueries,
    });
    this.directTransport = new DirectFabTransport({
      timeoutMs: config.directTimeoutMs,
      logger: this.logger,
    });
    this.browserTransport = BrowserFabTransport.fromConfig(config);
  }

  private async withChallengeFallback(
    operation: (transport: FabTransport) => Promise<unknown>,
  ): Promise<{ payload: unknown; transport: FabTransport["name"] }> {
    try {
      return {
        payload: await operation(this.directTransport),
        transport: this.directTransport.name,
      };
    } catch (error) {
      if (
        !(error instanceof FabClientError) ||
        error.code !== "FAB_CHALLENGE" ||
        !this.browserTransport
      ) {
        throw error;
      }
      return {
        payload: await operation(this.browserTransport),
        transport: this.browserTransport.name,
      };
    }
  }

  async search(input: SearchInput): Promise<SearchOutput> {
    const startedAt = this.now();
    const searchUrl = buildSearchUrl(input);
    const cacheKey = `search:${searchUrl.toString()}`;
    const cached = this.cache.get(cacheKey) as SearchOutput | undefined;
    if (cached) {
      this.logger.log("debug", "fab_tool_complete", {
        tool: "fab_search_assets",
        durationMs: this.now() - startedAt,
        transport: cached.transport,
        resultCount: cached.items.length,
        cacheHit: true,
        ...this.logger.queryFields(input.query),
      });
      return cached;
    }
    try {
      const upstream = await this.withChallengeFallback((transport) =>
        transport.search(searchUrl),
      );
      const payload = asRecord(upstream.payload);
      if (!payload || !Array.isArray(payload.results)) {
        throw new FabClientError(
          "FAB_UPSTREAM_CHANGED",
          "Fab's search response no longer matches the expected contract.",
        );
      }
      const normalizedItems = payload.results
        .map(normalizeSearchItem)
        .filter((item): item is NonNullable<typeof item> => item !== null)
        .slice(0, input.limit);
      const cursors = asRecord(payload.cursors);
      const nextCursor =
        asString(cursors?.next) ?? asString(payload.next) ?? undefined;
      const warnings: string[] = [];
      const output: SearchOutput = {
        items: [...normalizedItems],
        ...(nextCursor && nextCursor.length <= 2_048
          ? { nextCursor }
          : {}),
        appliedFilters: {
          query: input.query ?? "",
          priceMode: input.priceMode,
          currency: input.currency,
          channels: input.channels ?? [],
          listingTypes: input.listingTypes ?? [],
          categories: input.categories ?? [],
          formats: input.formats ?? [],
          tags: input.tags ?? [],
          licenses: input.licenses ?? [],
          sort: input.sort,
          limit: input.limit,
        },
        transport: upstream.transport,
        warnings,
      };
      if (nextCursor && nextCursor.length > 2_048) {
        warnings.push(
          "Fab returned an oversized cursor, so pagination was omitted.",
        );
      }
      while (
        output.items.length > 0 &&
        Buffer.byteLength(JSON.stringify(output), "utf8") >
          MAX_SEARCH_PAYLOAD_BYTES
      ) {
        output.items.pop();
      }
      if (output.items.length < normalizedItems.length) {
        warnings.push(
          "Some results were omitted to keep the MCP response under 256 KiB.",
        );
        while (
          output.items.length > 0 &&
          Buffer.byteLength(JSON.stringify(output), "utf8") >
            MAX_SEARCH_PAYLOAD_BYTES
        ) {
          output.items.pop();
        }
      }
      this.cache.set(cacheKey, output, SEARCH_TTL_MS);
      this.logger.log("debug", "fab_tool_complete", {
        tool: "fab_search_assets",
        durationMs: this.now() - startedAt,
        transport: upstream.transport,
        resultCount: output.items.length,
        cacheHit: false,
        ...this.logger.queryFields(input.query),
      });
      return output;
    } catch (error) {
      this.logger.log("warn", "fab_tool_error", {
        tool: "fab_search_assets",
        durationMs: this.now() - startedAt,
        errorCode:
          error instanceof FabClientError ? error.code : "FAB_INTERNAL",
        ...this.logger.queryFields(input.query),
      });
      throw error;
    }
  }

  async getListing(
    id: string,
    currency: string,
  ): Promise<{ payload: unknown; transport: FabTransport["name"] }> {
    const cacheKey = `listing:${id.toLowerCase()}:${currency.toUpperCase()}`;
    const cached = this.cache.get(cacheKey) as
      { payload: unknown; transport: FabTransport["name"] } | undefined;
    if (cached) {
      this.logger.log("debug", "fab_tool_complete", {
        tool: "fab_get_asset",
        transport: cached.transport,
        cacheHit: true,
      });
      return cached;
    }
    const result = await this.withChallengeFallback((transport) => {
      if (!transport.getListing) {
        throw new FabClientError(
          "FAB_INTERNAL",
          "The configured Fab transport cannot load listing details.",
        );
      }
      return transport.getListing(id, currency);
    });
    this.cache.set(cacheKey, result, LISTING_TTL_MS);
    this.logger.log("debug", "fab_tool_complete", {
      tool: "fab_get_asset",
      transport: result.transport,
      cacheHit: false,
    });
    return result;
  }

  async downloadFreeAsset(
    request: FabDownloadRequest,
  ): Promise<FabDownloadResult> {
    const startedAt = this.now();
    try {
      if (!this.browserTransport?.downloadFreeAsset) {
        throw new FabClientError(
          "FAB_UPSTREAM_UNAVAILABLE",
          "The configured Fab browser cannot download public files.",
        );
      }
      const result =
        await this.browserTransport.downloadFreeAsset(request);
      this.logger.log("info", "fab_tool_complete", {
        tool: "fab_download_free_asset",
        durationMs: this.now() - startedAt,
        transport: this.browserTransport.name,
        format: request.format,
        sizeBytes: result.sizeBytes,
        alreadyExisted: result.alreadyExisted,
      });
      return result;
    } catch (error) {
      this.logger.log("warn", "fab_tool_error", {
        tool: "fab_download_free_asset",
        durationMs: this.now() - startedAt,
        errorCode:
          error instanceof FabClientError ? error.code : "FAB_INTERNAL",
        format: request.format,
      });
      throw error;
    }
  }

  async request(url: URL): Promise<unknown> {
    const upstream = await this.withChallengeFallback((transport) => {
      if (!transport.request) {
        throw new FabClientError(
          "FAB_INTERNAL",
          "The configured Fab transport cannot load this public resource.",
        );
      }
      return transport.request(url);
    });
    return upstream.payload;
  }

  async prepareBrowser(): Promise<void> {
    if (!this.browserTransport?.prepare) return;
    try {
      await this.browserTransport.prepare();
      this.logger.log("info", "fab_browser_ready", {
        transport: this.browserTransport.name,
      });
    } catch (error) {
      this.logger.log("warn", "fab_browser_prepare_failed", {
        errorCode:
          error instanceof FabClientError ? error.code : "FAB_INTERNAL",
      });
    }
  }

  async listFilters(input: ListFiltersInput): Promise<ListFiltersOutput> {
    const now = this.discovery.now?.() ?? Date.now();
    const ttl = this.discovery.taxonomyTtlMs ?? TAXONOMY_TTL_MS;
    const lastGood = this.cache.peek(TAXONOMY_CACHE_KEY) as
      | TaxonomyCacheEntry
      | undefined;
    const cached = input.refresh
      ? undefined
      : (this.cache.get(TAXONOMY_CACHE_KEY) as
          | TaxonomyCacheEntry
          | undefined);
    if (cached && now - cached.cachedAtMs < ttl) {
      return {
        filters: selectFilterKinds(cached.filters, input.kinds),
        source: "cache",
        capturedAt: cached.capturedAt,
        contractVersion: cached.contractVersion,
        warnings: cached.warnings,
      };
    }

    if (this.discovery.taxonomyPath) {
      try {
        const filters = normalizeTaxonomy(
          await this.request(publicOperationUrl(this.discovery.taxonomyPath)),
        );
        const taxonomyEntry: TaxonomyCacheEntry = {
          filters,
          capturedAt: new Date(now).toISOString(),
          cachedAtMs: now,
          contractVersion: "fab-taxonomy-live-v1",
          warnings: [],
        };
        this.cache.set(TAXONOMY_CACHE_KEY, taxonomyEntry, ttl);
        return {
          filters: selectFilterKinds(filters, input.kinds),
          source: "live",
          capturedAt: taxonomyEntry.capturedAt,
          contractVersion: taxonomyEntry.contractVersion,
          warnings: [],
        };
      } catch (error) {
        if (lastGood) {
          return {
            filters: selectFilterKinds(lastGood.filters, input.kinds),
            source: "stale-cache",
            capturedAt: lastGood.capturedAt,
            contractVersion: lastGood.contractVersion,
            warnings: [
              ...lastGood.warnings,
              "Fab taxonomy refresh failed; returning the last-good cached values.",
            ],
          };
        }
        if (error instanceof FabClientError && error.code === "FAB_INTERNAL") {
          throw error;
        }
      }
    }

    const fallbackEntry: TaxonomyCacheEntry = {
      filters: FALLBACK_FILTERS,
      capturedAt: TAXONOMY_CAPTURED_AT,
      cachedAtMs: now,
      contractVersion: TAXONOMY_CONTRACT_VERSION,
      warnings: [FALLBACK_WARNING],
    };
    this.cache.set(TAXONOMY_CACHE_KEY, fallbackEntry, ttl);
    return {
      filters: selectFilterKinds(FALLBACK_FILTERS, input.kinds),
      source: "fallback",
      capturedAt: TAXONOMY_CAPTURED_AT,
      contractVersion: TAXONOMY_CONTRACT_VERSION,
      warnings: [FALLBACK_WARNING],
    };
  }

  async listLimitedTimeFree(
    input: ListLimitedTimeFreeInput,
  ): Promise<ListLimitedTimeFreeOutput> {
    const cacheKey = `limited-time-free:${input.limit}`;
    const cached = this.cache.get(cacheKey) as
      ListLimitedTimeFreeOutput | undefined;
    if (cached) {
      this.logger.log("debug", "fab_tool_complete", {
        tool: "fab_list_limited_time_free",
        resultCount: cached.items.length,
        cacheHit: true,
      });
      return cached;
    }
    let payload: unknown;
    let source: ListLimitedTimeFreeOutput["source"];
    if (this.discovery.limitedTimeFreeProvider) {
      payload = await this.discovery.limitedTimeFreeProvider();
      source = "configured-curated";
    } else if (this.discovery.limitedTimeFreePath) {
      payload = await this.request(
        publicOperationUrl(this.discovery.limitedTimeFreePath),
      );
      source = "live-curated";
    } else if (this.browserTransport?.getLimitedTimeFreeIds) {
      payload = await this.browserTransport.getLimitedTimeFreeIds(input.limit);
      source = "browser-curated";
    } else {
      throw new FabClientError(
        "FAB_UPSTREAM_UNAVAILABLE",
        "Fab's curated limited-time-free feed is unavailable because no stable anonymous contract is configured.",
      );
    }

    const entries = promotionEntries(payload);
    if (!entries) {
      throw new FabClientError(
        "FAB_UPSTREAM_CHANGED",
        "Fab's curated promotion response no longer matches the expected contract.",
      );
    }
    const seen = new Set<string>();
    const items: ListLimitedTimeFreeOutput["items"] = [];
    for (const value of entries) {
      if (items.length >= input.limit) break;
      const record = asRecord(value);
      const id = (
        typeof value === "string"
          ? value
          : firstString(record, "uid", "id", "uuid")
      )?.toLowerCase();
      if (!id || !UUID_PATTERN.test(id) || seen.has(id)) continue;
      seen.add(id);

      let title = firstString(record, "title", "name");
      let thumbnailUrl = safeHttpsUrl(
        record?.thumbnailUrl ?? asRecord(record?.thumbnail)?.url,
      );
      if (!title) {
        const detail = await this.getListing(id, "USD");
        const listing = asRecord(detail.payload);
        title = firstString(listing, "title", "name");
        thumbnailUrl ??= safeHttpsUrl(
          listing?.thumbnailUrl ?? asRecord(listing?.thumbnail)?.url,
        );
      }
      if (!title) {
        throw new FabClientError(
          "FAB_UPSTREAM_CHANGED",
          "A curated promotion no longer resolves to a public Fab listing.",
        );
      }

      const promotion = asRecord(record?.promotion);
      const promotionEndsAt = explicitPromotionEnd(
        record?.promotionEndsAt ??
          record?.promotion_ends_at ??
          promotion?.endsAt ??
          promotion?.ends_at,
      );
      items.push({
        id,
        title,
        url: `${FAB_ORIGIN}/listings/${id}`,
        ...(thumbnailUrl ? { thumbnailUrl } : {}),
        ...(promotionEndsAt ? { promotionEndsAt } : {}),
      });
    }

    const output: ListLimitedTimeFreeOutput = {
      items,
      source,
      warnings: [],
    };
    this.cache.set(cacheKey, output, LIMITED_TIME_FREE_TTL_MS);
    this.logger.log("debug", "fab_tool_complete", {
      tool: "fab_list_limited_time_free",
      resultCount: items.length,
      cacheHit: false,
    });
    return output;
  }

  async close(): Promise<void> {
    this.cache.clear();
    await Promise.allSettled([
      this.directTransport.close(),
      this.browserTransport?.close(),
    ]);
  }
}
