import { describe, expect, it, vi } from "vitest";

import {
  FabClient,
  FabClientError,
  type FabTransport,
} from "../src/fab/client.js";
import {
  createListFiltersHandler,
  ListFiltersInputSchema,
} from "../src/tools/list-filters.js";
import {
  createListLimitedTimeFreeHandler,
  ListLimitedTimeFreeInputSchema,
} from "../src/tools/list-limited-time-free.js";
import {
  limitedTimeFreeFixture,
  searchFixture,
  taxonomyFixture,
} from "./fixtures/fab-contracts.js";

const SIX_HOURS_MS = 6 * 60 * 60 * 1_000;

class DiscoveryTransport implements FabTransport {
  readonly name = "direct" as const;
  readonly search = vi.fn(async () => searchFixture);
  readonly request = vi.fn<(url: URL) => Promise<unknown>>(
    async () => taxonomyFixture,
  );
  readonly getListing = vi.fn(async () => ({
    uid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    title: "Resolved Promotion",
  }));
  readonly close = vi.fn(async () => {});
}

class PromotionBrowserTransport implements FabTransport {
  readonly name = "browser" as const;
  readonly search = vi.fn(async () => searchFixture);
  readonly getListing = vi.fn(async () => ({
    uid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    title: "Resolved Promotion",
  }));
  readonly getLimitedTimeFreeIds = vi.fn(async () => [
    "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  ]);
  readonly close = vi.fn(async () => {});
}

describe("Fab discovery tools", () => {
  it("should return stable filter objects", async () => {
    const handler = createListFiltersHandler(
      new FabClient(new DiscoveryTransport()),
    );
    const result = await handler({
      kinds: ["channels", "listing_types", "formats", "categories", "licenses"],
    });

    expect("structuredContent" in result).toBe(true);
    if (!("structuredContent" in result)) return;
    expect(result.structuredContent.source).toBe("fallback");
    expect(result.structuredContent.warnings[0]).toContain(
      "no confirmed anonymous taxonomy",
    );
    for (const values of Object.values(result.structuredContent.filters)) {
      expect(values?.length).toBeGreaterThan(0);
      for (const value of values ?? []) {
        expect(value.label).toBeTruthy();
        expect(value.slug).toBeTruthy();
      }
    }
    expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual(
      result.structuredContent,
    );
  });

  it("should use cached taxonomy within TTL", async () => {
    const transport = new DiscoveryTransport();
    let now = Date.parse("2026-07-28T12:00:00.000Z");
    const client = new FabClient(transport, undefined, {
      taxonomyPath: "/i/public/taxonomy",
      now: () => now,
    });
    const input = ListFiltersInputSchema.parse({});

    const first = await client.listFilters(input);
    now += SIX_HOURS_MS - 1;
    const second = await client.listFilters(input);

    expect(first.source).toBe("live");
    expect(second.source).toBe("cache");
    expect(second.filters).toEqual(first.filters);
    expect(transport.request).toHaveBeenCalledTimes(1);
    expect(transport.request.mock.calls[0]?.[0].pathname).toBe(
      "/i/public/taxonomy",
    );
  });

  it("should return stale taxonomy with a warning", async () => {
    const transport = new DiscoveryTransport();
    transport.request
      .mockResolvedValueOnce(taxonomyFixture)
      .mockRejectedValueOnce(
        new FabClientError(
          "FAB_UPSTREAM_UNAVAILABLE",
          "taxonomy unavailable",
          true,
        ),
      );
    let now = Date.parse("2026-07-28T12:00:00.000Z");
    const client = new FabClient(transport, undefined, {
      taxonomyPath: "/i/public/taxonomy",
      now: () => now,
    });
    const input = ListFiltersInputSchema.parse({});

    const first = await client.listFilters(input);
    now += SIX_HOURS_MS + 1;
    const stale = await client.listFilters(input);

    expect(first.source).toBe("live");
    expect(stale.source).toBe("stale-cache");
    expect(stale.filters).toEqual(first.filters);
    expect(stale.warnings).toContain(
      "Fab taxonomy refresh failed; returning the last-good cached values.",
    );
    expect(transport.request).toHaveBeenCalledTimes(2);
  });

  it("filters internal taxonomy values", async () => {
    const transport = new DiscoveryTransport();
    transport.request.mockResolvedValueOnce({
      ...taxonomyFixture,
      channels: [
        ...taxonomyFixture.channels,
        "internal-preview",
        { label: "Staff Only", slug: "public-looking" },
      ],
    });
    const client = new FabClient(transport, undefined, {
      taxonomyPath: "/i/public/taxonomy",
    });
    const output = await client.listFilters(
      ListFiltersInputSchema.parse({ kinds: ["channels"] }),
    );
    expect(output.filters.channels).toEqual(taxonomyFixture.channels);
  });

  it("should not treat all free assets as limited-time promotions", async () => {
    const transport = new DiscoveryTransport();
    const provider = vi.fn(async () => limitedTimeFreeFixture);
    const client = new FabClient(transport, undefined, {
      limitedTimeFreeProvider: provider,
    });

    const output = await client.listLimitedTimeFree(
      ListLimitedTimeFreeInputSchema.parse({}),
    );

    expect(output.items.map((item) => item.id)).toEqual([
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    ]);
    expect(output.items.map((item) => item.id)).not.toContain(
      searchFixture.results[0].uid,
    );
    expect(provider).toHaveBeenCalledTimes(1);
    expect(transport.search).not.toHaveBeenCalled();
  });

  it("should omit an unknown promotion end time", async () => {
    const client = new FabClient(new DiscoveryTransport(), undefined, {
      limitedTimeFreeProvider: async () => ({
        results: [
          {
            uid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            title: "No Explicit End",
            promotionEndsAt: "2026-08-04",
          },
        ],
      }),
    });

    const output = await client.listLimitedTimeFree(
      ListLimitedTimeFreeInputSchema.parse({ limit: 1 }),
    );

    expect(output.items[0]).not.toHaveProperty("promotionEndsAt");
  });

  it("resolves UUID-only curated browser extraction through listing detail", async () => {
    const transport = new DiscoveryTransport();
    const client = new FabClient(transport, undefined, {
      limitedTimeFreeProvider: async () => [
        "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      ],
    });

    const output = await client.listLimitedTimeFree(
      ListLimitedTimeFreeInputSchema.parse({ limit: 1 }),
    );

    expect(output.items[0]).toMatchObject({
      id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      title: "Resolved Promotion",
    });
    expect(transport.getListing).toHaveBeenCalledWith(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "USD",
    );
  });

  it("uses the dedicated browser promotions surface in production mode", async () => {
    const direct = new DiscoveryTransport();
    const browser = new PromotionBrowserTransport();
    const client = new FabClient(direct, browser);

    const output = await client.listLimitedTimeFree(
      ListLimitedTimeFreeInputSchema.parse({ limit: 1 }),
    );

    expect(output.source).toBe("browser-curated");
    expect(browser.getLimitedTimeFreeIds).toHaveBeenCalledWith(1);
    expect(output.items[0]?.id).toBe(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    );
    expect(direct.search).not.toHaveBeenCalled();
  });

  it("returns structured plus text promotion output", async () => {
    const handler = createListLimitedTimeFreeHandler(
      new FabClient(new DiscoveryTransport(), undefined, {
        limitedTimeFreeProvider: async () => limitedTimeFreeFixture,
      }),
    );
    const result = await handler({});

    expect("structuredContent" in result).toBe(true);
    if (!("structuredContent" in result)) return;
    expect(result.structuredContent.items[0]?.promotionEndsAt).toBe(
      "2026-08-04T15:00:00Z",
    );
    expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual(
      result.structuredContent,
    );
  });

  it("returns explicit unavailability without a curated source", async () => {
    const transport = new DiscoveryTransport();
    const handler = createListLimitedTimeFreeHandler(new FabClient(transport));
    const result = await handler({});

    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("FAB_UPSTREAM_UNAVAILABLE");
    expect(JSON.stringify(result)).toContain(
      "no stable anonymous contract is configured",
    );
    expect(transport.search).not.toHaveBeenCalled();
  });

  it("refuses configured admin discovery operations", async () => {
    const transport = new DiscoveryTransport();
    const client = new FabClient(transport, undefined, {
      taxonomyPath: "/i/admin/taxonomy",
    });

    await expect(
      client.listFilters(ListFiltersInputSchema.parse({})),
    ).rejects.toMatchObject({ code: "FAB_INTERNAL" });
    expect(transport.request).not.toHaveBeenCalled();
  });
});
