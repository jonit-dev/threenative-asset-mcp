import { z } from "zod";

export const UpstreamSearchSchema = z
  .object({
    results: z.array(z.unknown()),
    cursors: z
      .object({
        next: z.string().nullable().optional(),
        previous: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const UpstreamListingSchema = z
  .record(z.string(), z.unknown())
  .superRefine((value, context) => {
    const id = value.uid ?? value.id ?? value.uuid;
    const title = value.title ?? value.name;
    if (typeof id !== "string" || id.length === 0) {
      context.addIssue({
        code: "custom",
        message: "listing identity is missing",
      });
    }
    if (typeof title !== "string" || title.length === 0) {
      context.addIssue({
        code: "custom",
        message: "listing title is missing",
      });
    }
    for (const key of [
      "licenses",
      "offers",
      "assetFormats",
      "asset_formats",
      "formats",
      "media",
      "images",
      "files",
      "tags",
      "categories",
    ]) {
      if (value[key] !== undefined && !Array.isArray(value[key])) {
        context.addIssue({
          code: "custom",
          message: `${key} must be an array when present`,
          path: [key],
        });
      }
    }
    const licenses = value.licenses ?? value.offers;
    if (Array.isArray(licenses)) {
      licenses.forEach((entry, index) => {
        if (
          typeof entry !== "object" ||
          entry === null ||
          Array.isArray(entry)
        ) {
          context.addIssue({
            code: "custom",
            message: "license entries must be objects",
            path: ["licenses", index],
          });
          return;
        }
        const license = entry as Record<string, unknown>;
        for (const priceKey of [
          "price",
          "basePrice",
          "pricing",
          "discountedPrice",
          "effectivePrice",
          "salePrice",
        ]) {
          const rawPrice = license[priceKey];
          if (rawPrice === undefined) continue;
          if (
            typeof rawPrice !== "object" ||
            rawPrice === null ||
            Array.isArray(rawPrice)
          ) {
            context.addIssue({
              code: "custom",
              message: `${priceKey} must be an object`,
              path: ["licenses", index, priceKey],
            });
            continue;
          }
          const price = rawPrice as Record<string, unknown>;
          const numeric = [
            price.amount,
            price.price,
            price.value,
            price.effectiveAmount,
            price.discountedAmount,
          ].some(
            (candidate) =>
              typeof candidate === "number" && Number.isFinite(candidate),
          );
          if (!numeric) {
            context.addIssue({
              code: "custom",
              message: `${priceKey} has no numeric price`,
              path: ["licenses", index, priceKey],
            });
          }
        }
      });
    }
  });
