import {
  InMemoryTransport,
  LATEST_PROTOCOL_VERSION,
  type JSONRPCMessage,
  type McpServer,
} from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildSearchUrl,
  FabClient,
  type FabTransport,
} from "../src/fab/client.js";
import { createFabServer } from "../src/server.js";
import { SearchInputSchema } from "../src/tools/search-assets.js";
import { searchFixture } from "./fixtures/fab-contracts.js";

class FixtureTransport implements FabTransport {
  readonly name = "direct" as const;
  constructor(private readonly payload: unknown = searchFixture) {}
  readonly search = vi.fn(async () => this.payload);
  readonly close = vi.fn(async () => {});
}

const servers: McpServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function callSearch(
  args: Record<string, unknown>,
  transport = new FixtureTransport(),
) {
  const server = createFabServer(new FabClient(transport));
  servers.push(server);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const waiting = new Map<
    number,
    (message: Extract<JSONRPCMessage, { id: string | number }>) => void
  >();
  clientSide.onmessage = (message) => {
    if ("id" in message && typeof message.id === "number") {
      waiting.get(message.id)?.(
        message as Extract<JSONRPCMessage, { id: string | number }>,
      );
    }
  };
  await clientSide.start();
  await server.connect(serverSide);

  const request = (
    id: number,
    method: string,
    params: Record<string, unknown>,
  ) =>
    new Promise<Extract<JSONRPCMessage, { id: string | number }>>((resolve) => {
      waiting.set(id, resolve);
      void clientSide.send({ jsonrpc: "2.0", id, method, params });
    });

  await request(1, "initialize", {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "threenative-asset-mcp-test", version: "1.0.0" },
  });
  await clientSide.send({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  const response = await request(2, "tools/call", {
    name: "fab_search_assets",
    arguments: args,
  });
  await clientSide.close();
  return { response, transport };
}

describe("fab_search_assets", () => {
  it("defaults to free when price mode is omitted", () => {
    const input = SearchInputSchema.parse({});
    expect(buildSearchUrl(input).searchParams.get("is_free")).toBe("1");
  });

  it("omits the free filter when price mode is any", () => {
    const input = SearchInputSchema.parse({ priceMode: "any" });
    expect(buildSearchUrl(input).searchParams.has("is_free")).toBe(false);
  });

  it("appends repeated filter values", () => {
    const input = SearchInputSchema.parse({
      channels: ["unity", "unreal-engine"],
      formats: ["fbx", "gltf"],
    });
    const url = buildSearchUrl(input);
    expect(url.searchParams.getAll("channels")).toEqual([
      "unity",
      "unreal-engine",
    ]);
    expect(url.searchParams.getAll("asset_formats")).toEqual(["fbx", "gltf"]);
  });

  it("round-trips cursor and returns structured plus text content", async () => {
    const { response } = await callSearch({});
    expect("result" in response).toBe(true);
    if (!("result" in response)) return;
    const result = response.result as {
      content: Array<{ text: string }>;
      structuredContent: {
        nextCursor: string;
        items: Array<{ id: string; isFree: boolean }>;
      };
    };
    expect(result.structuredContent.nextCursor).toBe(
      "opaque-next-cursor-value",
    );
    expect(result.structuredContent.items[0]).toMatchObject({
      id: "8a8981c4-bb94-4184-84b7-6c70d7c75ef1",
      isFree: true,
    });
    expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual(
      result.structuredContent,
    );
  });

  it("uses explicit license prices before aggregate starting price", async () => {
    const paidLicenseWithZeroAggregate = {
      results: [
        {
          uid: "11111111-2222-4333-8444-555555555555",
          title: "Conflicting aggregate",
          licenses: [
            { slug: "personal", price: { amount: 10, currency: "USD" } },
          ],
          startingPrice: { amount: 0, currency: "USD" },
        },
      ],
      cursors: {},
    };
    const { response } = await callSearch(
      {},
      new FixtureTransport(paidLicenseWithZeroAggregate),
    );
    expect("result" in response).toBe(true);
    if (!("result" in response)) return;
    const result = response.result as {
      structuredContent: { items: Array<{ isFree: boolean }> };
    };
    expect(result.structuredContent.items[0]?.isFree).toBe(false);
  });

  it("bounds untrusted upstream search content below 256 KiB", async () => {
    const oversized = {
      results: Array.from({ length: 24 }, (_, index) => ({
        uid: `11111111-2222-4333-8444-${String(index).padStart(12, "0")}`,
        title: "t".repeat(20_000),
        seller: { name: "p".repeat(20_000) },
        assetFormats: Array.from({ length: 100 }, () => "f".repeat(10_000)),
        tags: Array.from({ length: 100 }, () => ({
          name: "n".repeat(10_000),
          slug: "s".repeat(10_000),
        })),
        startingPrice: { amount: 0, currency: "USD" },
      })),
      cursors: { next: "cursor" },
    };
    const { response } = await callSearch(
      {},
      new FixtureTransport(oversized),
    );
    expect("result" in response).toBe(true);
    if (!("result" in response)) return;
    const result = response.result as {
      structuredContent: {
        items: Array<{
          title: string;
          formats: string[];
          tags: Array<{ name: string }>;
        }>;
      };
    };
    expect(
      Buffer.byteLength(JSON.stringify(result.structuredContent), "utf8"),
    ).toBeLessThanOrEqual(256 * 1_024);
    expect(result.structuredContent.items[0]?.title.length).toBeLessThanOrEqual(
      500,
    );
    expect(
      result.structuredContent.items[0]?.formats.length,
    ).toBeLessThanOrEqual(20);
    expect(
      result.structuredContent.items[0]?.tags.length,
    ).toBeLessThanOrEqual(20);
  });

  it("rejects invalid price ranges without fetching", async () => {
    const transport = new FixtureTransport();
    const { response } = await callSearch(
      { priceMode: "range", minPrice: 20, maxPrice: 10 },
      transport,
    );
    expect("result" in response).toBe(true);
    if (!("result" in response)) return;
    expect(response.result).toMatchObject({ isError: true });
    expect(JSON.stringify(response.result)).toContain("FAB_INVALID_INPUT");
    expect(transport.search).not.toHaveBeenCalled();
  });
});
