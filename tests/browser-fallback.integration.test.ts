import { describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadFabConfig } from "../src/config.js";
import { BrowserFabTransport } from "../src/fab/browser-transport.js";
import {
  FabClient,
  FabClientError,
  type FabTransport,
} from "../src/fab/client.js";
import { assertAllowedFabApiUrl } from "../src/fab/direct-transport.js";
import { SearchInputSchema } from "../src/tools/search-assets.js";
import { searchFixture } from "./fixtures/fab-contracts.js";

class StubTransport implements FabTransport {
  readonly name: "direct" | "browser";
  readonly search: (url: URL) => Promise<unknown>;
  readonly close = vi.fn(async () => {});

  constructor(
    name: "direct" | "browser",
    implementation: () => Promise<unknown>,
  ) {
    this.name = name;
    this.search = vi.fn(async (_url: URL) => implementation());
  }
}

function input() {
  return SearchInputSchema.parse({ query: "forest" });
}

describe("Fab browser fallback orchestration", () => {
  it("rejects API paths outside the exact public allowlist", () => {
    expect(() =>
      assertAllowedFabApiUrl(
        new URL("https://www.fab.com/i/arbitrary/internal-operation"),
      ),
    ).toThrow("Refused a non-Fab upstream URL");
  });

  it("rejects normal browser profile locations", () => {
    expect(() =>
      loadFabConfig({
        FAB_BROWSER_PROFILE_DIR: join(
          homedir(),
          ".config",
          "google-chrome",
          "Default",
        ),
      }),
    ).toThrow("must be an MCP-owned directory");
  });

  it("falls back exactly once when direct transport returns a challenge", async () => {
    const direct = new StubTransport("direct", async () => {
      throw new FabClientError("FAB_CHALLENGE", "challenge");
    });
    const browser = new StubTransport("browser", async () => searchFixture);

    const result = await new FabClient(direct, browser).search(input());

    expect(direct.search).toHaveBeenCalledTimes(1);
    expect(browser.search).toHaveBeenCalledTimes(1);
    expect(result.transport).toBe("browser");
  });

  it.each([
    new FabClientError("FAB_INVALID_INPUT", "invalid"),
    new FabClientError("FAB_NOT_FOUND", "missing"),
  ])("does not fall back for %s", async (directError) => {
    const direct = new StubTransport("direct", async () => {
      throw directError;
    });
    const browser = new StubTransport("browser", async () => searchFixture);

    await expect(new FabClient(direct, browser).search(input())).rejects.toBe(
      directError,
    );
    expect(browser.search).not.toHaveBeenCalled();
  });

  it("serializes browser requests with maximum concurrency one", async () => {
    let active = 0;
    let maximum = 0;
    const page = {
      url: () => "https://www.fab.com/",
      goto: vi.fn(async () => {}),
      evaluate: vi.fn(async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return {
          status: 200,
          ok: true,
          contentType: "application/json",
          cfMitigated: null,
          responseOrigin: "https://www.fab.com",
          payload: searchFixture,
        };
      }),
    };
    const context = {
      pages: () => [page],
      newPage: vi.fn(async () => page),
      close: vi.fn(async () => {}),
    };
    const transport = new BrowserFabTransport({
      timeoutMs: 1_000,
      headless: true,
      profileDir: "/dedicated-test-profile",
      launchContext: vi.fn(async () => context),
    });

    await Promise.all([
      transport.search(new URL("https://www.fab.com/i/listings/search?q=a")),
      transport.search(new URL("https://www.fab.com/i/listings/search?q=b")),
      transport.search(new URL("https://www.fab.com/i/listings/search?q=c")),
    ]);

    expect(maximum).toBe(1);
    expect(page.evaluate).toHaveBeenCalledTimes(3);
  });

  it("waits in headed mode for visible manual verification", async () => {
    let verificationChecks = 0;
    const sleep = vi.fn(async () => {});
    const page = {
      url: () => "https://www.fab.com/",
      goto: vi.fn(async () => {}),
      evaluate: vi.fn(
        async (_callback: unknown, argument: Record<string, unknown>) => {
          if ("requestUrl" in argument) {
            return {
              status: 200,
              ok: true,
              contentType: "application/json",
              cfMitigated: null,
              responseOrigin: "https://www.fab.com",
              payload: searchFixture,
            };
          }
          verificationChecks += 1;
          return {
            origin: "https://www.fab.com",
            challengeVisible: verificationChecks === 1,
          };
        },
      ),
    };
    const context = {
      pages: () => [page],
      newPage: vi.fn(async () => page),
      close: vi.fn(async () => {}),
    };
    const transport = new BrowserFabTransport({
      timeoutMs: 1_000,
      manualChallengeTimeoutMs: 10_000,
      headless: false,
      profileDir: "/dedicated-test-profile",
      launchContext: vi.fn(async () => context),
      sleep,
    });

    await expect(
      transport.search(
        new URL("https://www.fab.com/i/listings/search?q=forest"),
      ),
    ).resolves.toEqual(searchFixture);
    expect(verificationChecks).toBe(2);
    expect(sleep).toHaveBeenCalledWith(1_000);
    await transport.close();
  });

  it("closes the persistent context exactly once during shutdown", async () => {
    const page = {
      url: () => "https://www.fab.com/",
      goto: vi.fn(async () => {}),
      evaluate: vi.fn(async () => ({
        status: 200,
        ok: true,
        contentType: "application/json",
        cfMitigated: null,
        responseOrigin: "https://www.fab.com",
        payload: searchFixture,
      })),
    };
    const context = {
      pages: () => [page],
      newPage: vi.fn(async () => page),
      close: vi.fn(async () => {}),
    };
    const launchContext = vi.fn(async () => context);
    const transport = new BrowserFabTransport({
      timeoutMs: 1_000,
      headless: true,
      profileDir: "/dedicated-test-profile",
      launchContext,
    });
    await transport.search(
      new URL("https://www.fab.com/i/listings/search?q=forest"),
    );

    await transport.close();
    await transport.close();

    expect(launchContext).toHaveBeenCalledTimes(1);
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it("redacts challenge details and dedicated profile paths", async () => {
    const secret = "cookie=private; /dedicated-test-profile; <html>challenge";
    const page = {
      url: () => "https://www.fab.com/",
      goto: vi.fn(async () => {}),
      evaluate: vi.fn(async () => {
        throw new Error(secret);
      }),
    };
    const context = {
      pages: () => [page],
      newPage: vi.fn(async () => page),
      close: vi.fn(async () => {}),
    };
    const transport = new BrowserFabTransport({
      timeoutMs: 1_000,
      headless: true,
      profileDir: "/dedicated-test-profile",
      launchContext: vi.fn(async () => context),
    });

    let thrown: unknown;
    try {
      await transport.search(
        new URL("https://www.fab.com/i/listings/search?q=forest"),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(FabClientError);
    expect(JSON.stringify(thrown)).not.toContain(secret);
    expect((thrown as Error).message).not.toContain("cookie");
    expect((thrown as Error).message).not.toContain("profile");
    expect((thrown as Error).stack).not.toContain(secret);
    await transport.close();
  });

  it("classifies browser HTML challenges as attention required", async () => {
    const page = {
      url: () => "https://www.fab.com/",
      goto: vi.fn(async () => {}),
      evaluate: vi.fn(async () => ({
        status: 403,
        ok: false,
        contentType: "text/html",
        cfMitigated: "challenge",
        responseOrigin: "https://www.fab.com",
      })),
    };
    const context = {
      pages: () => [page],
      newPage: vi.fn(async () => page),
      close: vi.fn(async () => {}),
    };
    const transport = new BrowserFabTransport({
      timeoutMs: 1_000,
      headless: true,
      profileDir: "/dedicated-test-profile",
      launchContext: vi.fn(async () => context),
    });

    await expect(
      transport.search(
        new URL("https://www.fab.com/i/listings/search?q=forest"),
      ),
    ).rejects.toMatchObject({ code: "FAB_BROWSER_ATTENTION_REQUIRED" });
    await transport.close();
  });

  it("does not fetch when homepage navigation leaves Fab", async () => {
    let currentUrl = "about:blank";
    const page = {
      url: () => currentUrl,
      goto: vi.fn(async () => {
        currentUrl = "https://example.com/";
      }),
      evaluate: vi.fn(async () => {
        throw new Error("must not run");
      }),
    };
    const context = {
      pages: () => [page],
      newPage: vi.fn(async () => page),
      close: vi.fn(async () => {}),
    };
    const transport = new BrowserFabTransport({
      timeoutMs: 1_000,
      headless: true,
      profileDir: "/dedicated-test-profile",
      launchContext: vi.fn(async () => context),
    });

    await expect(
      transport.search(
        new URL("https://www.fab.com/i/listings/search?q=forest"),
      ),
    ).rejects.toMatchObject({ code: "FAB_ACCESS_DENIED" });
    expect(page.evaluate).not.toHaveBeenCalled();
    await transport.close();
  });

  it("extracts only curated listing IDs from the approved promotions page", async () => {
    let currentUrl = "https://www.fab.com/";
    const page = {
      url: () => currentUrl,
      goto: vi.fn(async (url: string) => {
        currentUrl = url;
      }),
      evaluate: vi.fn(async () => [
        "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      ]),
    };
    const context = {
      pages: () => [page],
      newPage: vi.fn(async () => page),
      close: vi.fn(async () => {}),
    };
    const transport = new BrowserFabTransport({
      timeoutMs: 1_000,
      headless: true,
      profileDir: "/dedicated-test-profile",
      launchContext: vi.fn(async () => context),
    });

    await expect(transport.getLimitedTimeFreeIds(1)).resolves.toEqual([
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    ]);
    expect(page.goto).toHaveBeenCalledWith(
      "https://www.fab.com/limited-time-free",
      expect.objectContaining({ waitUntil: "domcontentloaded" }),
    );
    await transport.close();
  });
});
