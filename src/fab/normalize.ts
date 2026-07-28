import { FabClientError } from "./client.js";
import { UpstreamListingSchema } from "./schemas.js";
import type { AssetOutput } from "../tools/get-asset.js";

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function text(value: unknown, maxLength = 500): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, maxLength)
    : undefined;
}

function rawText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstText(
  value: RecordValue | undefined,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const result = text(value?.[key]);
    if (result) return result;
  }
  return undefined;
}

function httpsUrl(value: unknown): string | undefined {
  const candidate = text(value, 2_048);
  if (!candidate) return undefined;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "https:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function stringValues(value: unknown, limit = 100): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.flatMap((entry) => {
        if (typeof entry === "string") return [entry.slice(0, 200)];
        const item = record(entry);
        const candidate = firstText(item, "slug", "name", "label", "code");
        return candidate ? [candidate] : [];
      }),
    ),
  ].slice(0, limit);
}

function normalizeNamedValues(
  value: unknown,
  limit = 100,
): Array<{ name: string; slug?: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((entry) => {
      if (typeof entry === "string") return [{ name: entry.slice(0, 200) }];
      const item = record(entry);
      const name = firstText(item, "name", "label", "slug")?.slice(0, 200);
      if (!name) return [];
      const slug = firstText(item, "slug", "code")?.slice(0, 200);
      return [{ name, ...(slug ? { slug } : {}) }];
    })
    .slice(0, limit);
}

function normalizeMoney(
  value: unknown,
  fallbackCurrency: string,
):
  | { amount: number; currency: string; effectiveAmount?: number }
  | undefined {
  const item = record(value);
  if (!item) return undefined;
  const effectiveAmount = number(
    item.effectiveAmount ?? item.discountedAmount ?? item.discountPrice,
  );
  const amount =
    number(item.amount ?? item.price ?? item.value) ?? effectiveAmount;
  if (amount === undefined) return undefined;
  return {
    amount,
    currency:
      firstText(item, "currency", "currencyCode") ?? fallbackCurrency,
    ...(effectiveAmount === undefined ? {} : { effectiveAmount }),
  };
}

function normalizeLicenses(
  value: unknown,
  fallbackCurrency: string,
): AssetOutput["licenses"] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((entry) => {
      const item = record(entry);
      if (!item) return [];
      const slug = firstText(item, "slug", "code", "id")?.slice(0, 200);
      const name = firstText(item, "name", "label", "slug")?.slice(0, 200);
      if (!slug || !name) return [];
      const baseMoney =
        normalizeMoney(item.price, fallbackCurrency) ??
        normalizeMoney(item.basePrice, fallbackCurrency) ??
        normalizeMoney(item.pricing, fallbackCurrency);
      const explicitEffective =
        normalizeMoney(item.discountedPrice, fallbackCurrency) ??
        normalizeMoney(item.effectivePrice, fallbackCurrency) ??
        normalizeMoney(item.salePrice, fallbackCurrency);
      const basePrice = baseMoney
        ? { amount: baseMoney.amount, currency: baseMoney.currency }
        : undefined;
      const effectivePrice = explicitEffective
        ? {
            amount:
              explicitEffective.effectiveAmount ?? explicitEffective.amount,
            currency: explicitEffective.currency,
          }
        : baseMoney?.effectiveAmount === undefined
          ? undefined
          : {
              amount: baseMoney.effectiveAmount,
              currency: baseMoney.currency,
            };
      const effectiveAmount =
        effectivePrice?.amount ?? basePrice?.amount ?? Number.NaN;
      return [
        {
          slug,
          name,
          ...(firstText(item, "offerId", "offer_id", "offer")
            ? {
                offerId: firstText(item, "offerId", "offer_id", "offer")?.slice(
                  0,
                  200,
                ),
              }
            : {}),
          ...(basePrice ? { basePrice } : {}),
          ...(effectivePrice ? { effectivePrice } : {}),
          isFree: effectiveAmount === 0,
        },
      ];
    })
    .slice(0, 30);
}

function normalizeFiles(value: unknown): AssetOutput["files"] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((entry) => {
      if (typeof entry === "string") {
        return [{ name: entry.slice(0, 300) }];
      }
      const item = record(entry);
      if (!item) return [];
      const name = firstText(item, "name", "filename", "label")?.slice(0, 300);
      const url = httpsUrl(item.url ?? item.downloadUrl);
      const sizeBytes = number(item.sizeBytes ?? item.size);
      const format = firstText(item, "format", "extension", "type")?.slice(
        0,
        100,
      );
      if (!name && !url && sizeBytes === undefined && !format) return [];
      return [
        {
          ...(name ? { name } : {}),
          ...(url ? { url } : {}),
          ...(sizeBytes === undefined ? {} : { sizeBytes }),
          ...(format ? { format } : {}),
        },
      ];
    })
    .slice(0, 100);
}

function normalizeCompatibility(
  value: unknown,
): AssetOutput["compatibility"] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((entry) => {
      if (typeof entry === "string") {
        return [{ name: entry.slice(0, 200) }];
      }
      const item = record(entry);
      const name = firstText(item, "name", "label", "engine", "platform");
      if (!name) return [];
      const version = firstText(item, "version", "engineVersion");
      const platform = firstText(item, "platform", "platformName");
      return [
        {
          name: name.slice(0, 200),
          ...(version ? { version: version.slice(0, 100) } : {}),
          ...(platform ? { platform: platform.slice(0, 100) } : {}),
        },
      ];
    })
    .slice(0, 50);
}

export function normalizeListing(
  raw: unknown,
  currency: string,
  transport: "direct" | "browser",
): AssetOutput {
  const parsed = UpstreamListingSchema.safeParse(raw);
  if (!parsed.success) {
    throw new FabClientError(
      "FAB_UPSTREAM_CHANGED",
      "Fab's listing response no longer matches the expected contract.",
    );
  }
  const value = parsed.data;
  const id = firstText(value, "uid", "id", "uuid")!;
  const title = firstText(value, "title", "name")!.slice(0, 500);
  const descriptionSource =
    rawText(
      value.description ?? value.longDescription ?? value.shortDescription,
    ) ?? "";
  const descriptionTruncated = descriptionSource.length > 12_000;
  const description = descriptionSource.slice(0, 12_000);
  const seller = record(value.seller ?? value.publisher);
  const sellerName = firstText(
    seller,
    "name",
    "displayName",
    "username",
  )?.slice(0, 200);
  const categories = normalizeNamedValues(
    value.categories ?? (value.category ? [value.category] : []),
    20,
  );
  const licenses = normalizeLicenses(value.licenses ?? value.offers, currency);

  const rawMedia = Array.isArray(value.media)
    ? value.media
    : Array.isArray(value.images)
      ? value.images
      : [];
  const media = rawMedia
    .flatMap((entry) => {
      if (typeof entry === "string") {
        const url = httpsUrl(entry);
        return url ? [{ type: "image", url }] : [];
      }
      const item = record(entry);
      const url = httpsUrl(item?.url ?? item?.src);
      if (!url) return [];
      return [
        {
          type:
            firstText(item, "type", "mediaType")?.slice(0, 50) ?? "image",
          url,
          ...(httpsUrl(item?.thumbnailUrl)
            ? { thumbnailUrl: httpsUrl(item?.thumbnailUrl) }
            : {}),
        },
      ];
    })
    .slice(0, 50);

  return {
    id,
    title,
    url: `https://www.fab.com/listings/${id}`,
    ...(httpsUrl(
      value.thumbnailUrl ?? record(value.thumbnail)?.url,
    )
      ? {
          thumbnailUrl: httpsUrl(
            value.thumbnailUrl ?? record(value.thumbnail)?.url,
          ),
        }
      : {}),
    ...(sellerName
      ? {
          publisher: {
            name: sellerName,
            ...(firstText(seller, "uid", "id")
              ? { id: firstText(seller, "uid", "id") }
              : {}),
          },
        }
      : {}),
    ...(description ? { description } : {}),
    descriptionTruncated,
    ...(categories[0] ? { category: categories[0] } : {}),
    breadcrumb: categories,
    tags: normalizeNamedValues(value.tags, 100),
    media,
    formats: stringValues(
      value.assetFormats ?? value.asset_formats ?? value.formats,
      50,
    ),
    files: normalizeFiles(value.files),
    compatibility: normalizeCompatibility(
      value.compatibleApps ??
        value.compatible_apps ??
        value.engineCompatibility ??
        value.platforms,
    ),
    licenses,
    freeLicenseSlugs: licenses
      .filter((license) => license.isFree)
      .map((license) => license.slug),
    ...(firstText(value, "firstPublishedAt", "publishedAt")
      ? {
          publishedAt: firstText(value, "firstPublishedAt", "publishedAt"),
        }
      : {}),
    ...(firstText(value, "updatedAt", "publishedAt")
      ? { updatedAt: firstText(value, "updatedAt", "publishedAt") }
      : {}),
    ...(typeof value.hasChangelog === "boolean"
      ? { hasChangelog: value.hasChangelog }
      : {}),
    ...(typeof value.isMature === "boolean"
      ? { isMature: value.isMature }
      : {}),
    ...(typeof value.isAiGenerated === "boolean"
      ? { isAiGenerated: value.isAiGenerated }
      : {}),
    ...(typeof value.isAiForbidden === "boolean"
      ? { allowsAiUse: !value.isAiForbidden }
      : {}),
    transport,
    warnings: [],
    rawContractVersion: "fab-public-2026-07-28",
  };
}
