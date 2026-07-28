import { describe, expect, it, vi } from "vitest";

import { FabClientError } from "../src/fab/client.js";
import {
  createGetAssetHandler,
  parseListingId,
  type AssetLookupClient,
} from "../src/tools/get-asset.js";
import { detailFixture } from "./fixtures/fab-contracts.js";

const LISTING_ID = "8a8981c4-bb94-4184-84b7-6c70d7c75ef1";

function fixtureClient(payload: unknown = detailFixture): AssetLookupClient {
  return {
    getListing: vi.fn(async () => ({
      payload,
      transport: "direct" as const,
    })),
  };
}

describe("fab_get_asset", () => {
  it("accepts a canonical Fab listing URL", () => {
    expect(
      parseListingId(`https://www.fab.com/listings/${LISTING_ID}`),
    ).toBe(LISTING_ID);
  });

  it("rejects non-Fab URLs without fetching", async () => {
    const client = fixtureClient();
    const result = await createGetAssetHandler(client)({
      listingIdOrUrl: `https://example.com/listings/${LISTING_ID}`,
    });
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("FAB_INVALID_INPUT");
    expect(client.getListing).not.toHaveBeenCalled();
  });

  it("distinguishes free and paid licenses", async () => {
    const result = await createGetAssetHandler(fixtureClient())({
      listingIdOrUrl: LISTING_ID,
    });
    expect("structuredContent" in result).toBe(true);
    if (!("structuredContent" in result)) return;
    expect(result.structuredContent.freeLicenseSlugs).toEqual(["personal"]);
    expect(result.structuredContent.licenses).toEqual([
      expect.objectContaining({ slug: "personal", isFree: true }),
      expect.objectContaining({ slug: "professional", isFree: false }),
    ]);
  });

  it("honors an effective amount embedded in a license price", async () => {
    const result = await createGetAssetHandler(
      fixtureClient({
        ...detailFixture,
        licenses: [
          {
            slug: "personal",
            name: "Personal",
            price: {
              amount: 10,
              effectiveAmount: 0,
              currency: "USD",
            },
          },
        ],
      }),
    )({ listingIdOrUrl: LISTING_ID });
    expect("structuredContent" in result).toBe(true);
    if (!("structuredContent" in result)) return;
    expect(result.structuredContent.freeLicenseSlugs).toEqual(["personal"]);
    expect(result.structuredContent.licenses[0]).toMatchObject({
      basePrice: { amount: 10 },
      effectivePrice: { amount: 0 },
      isFree: true,
    });
  });

  it("caps long descriptions", async () => {
    const result = await createGetAssetHandler(
      fixtureClient({ ...detailFixture, description: "x".repeat(13_000) }),
    )({ listingIdOrUrl: LISTING_ID });
    expect("structuredContent" in result).toBe(true);
    if (!("structuredContent" in result)) return;
    expect(result.structuredContent.description).toHaveLength(12_000);
    expect(result.structuredContent.descriptionTruncated).toBe(true);
  });

  it("classifies contract drift", async () => {
    const result = await createGetAssetHandler(fixtureClient({ nope: true }))({
      listingIdOrUrl: LISTING_ID,
    });
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("FAB_UPSTREAM_CHANGED");
  });

  it("classifies malformed license contracts as drift", async () => {
    const result = await createGetAssetHandler(
      fixtureClient({
        ...detailFixture,
        licenses: { personal: { price: "free" } },
      }),
    )({ listingIdOrUrl: LISTING_ID });
    expect(JSON.stringify(result)).toContain("FAB_UPSTREAM_CHANGED");
  });

  it("bounds large strings and preserves compatibility versions", async () => {
    const result = await createGetAssetHandler(
      fixtureClient({
        ...detailFixture,
        tags: Array.from({ length: 100 }, (_, index) => ({
          name: `${index}-${"x".repeat(20_000)}`,
        })),
        compatibleApps: [{ name: "Unreal Engine", version: "5.4" }],
        updatedAt: "2026-07-27T12:00:00Z",
      }),
    )({ listingIdOrUrl: LISTING_ID });
    expect("structuredContent" in result).toBe(true);
    if (!("structuredContent" in result)) return;
    expect(JSON.stringify(result.structuredContent).length).toBeLessThan(
      256 * 1_024,
    );
    expect(result.structuredContent.compatibility).toEqual([
      { name: "Unreal Engine", version: "5.4" },
    ]);
    expect(result.structuredContent.updatedAt).toBe("2026-07-27T12:00:00Z");
  });

  it("preserves a not-found error", async () => {
    const client: AssetLookupClient = {
      getListing: vi.fn(async () => {
        throw new FabClientError("FAB_NOT_FOUND", "Listing not found.");
      }),
    };
    const result = await createGetAssetHandler(client)({
      listingIdOrUrl: LISTING_ID,
    });
    expect(JSON.stringify(result)).toContain("FAB_NOT_FOUND");
  });
});
