# Fab provider implementation and verification

Date: 2026-07-28

## Outcome

The Fab provider was originally implemented for the 0.1.0 release and is now
part of the `threenative-asset-mcp` multi-provider stdio MCP.
The deterministic implementation review passes. Release remains gated on a
successful clean anonymous browser/detail canary because Fab currently applies
intermittent Cloudflare challenges.

## Tools

- `fab_search_assets`
  - defaults to `priceMode: "free"`
  - supports explicit `any` and price ranges
  - maps all documented filters
  - preserves cursors opaquely
  - caps output at 24 results and 256 KiB
- `fab_get_asset`
  - accepts only a UUID or canonical Fab listing URL
  - reports free status per license tier
  - caps descriptions, arrays, URLs, and strings
- `fab_list_filters`
  - returns five filter groups
  - uses six-hour caching
  - identifies versioned fallback or stale values with warnings
- `fab_list_limited_time_free`
  - is distinct from general free search
  - extracts canonical listing UUIDs from Fab's public curated page using the
    dedicated browser
  - never guesses promotion end dates

There are no acquisition, purchase, cart, wishlist, library, login, download,
or mutation tools.

## Safety

- Direct requests are restricted to exact approved public Fab routes.
- No Cookie or Authorization header is sent.
- The browser uses an MCP-owned profile and rejects known Chrome, Chromium, and
  Edge profile roots, including canonicalized symlink paths.
- Cloudflare/CAPTCHA is never bypassed.
- Challenges fall back to the browser once, then return
  `FAB_BROWSER_ATTENTION_REQUIRED`.
- Logs are structured JSON on stderr; stdout is reserved for MCP JSON-RPC.
- Queries are redacted unless `FAB_LOG_QUERIES=1`.
- Retries apply only to 429, 502, 503, and 504, at most twice.
- Requests are paced at a minimum 750 ms interval.

## Deterministic verification

All completed successfully:

```text
npm ci
npm run browser:install
npm run typecheck
npm test                 # 45/45
npm run build
npm pack --dry-run
npm run inspect          # all four tools
```

The built-process smoke test verifies initialize, tools/list, an offline
structured tool call, JSON-only stdout, SIGTERM exit 0, cache bounds, retry
limits, Retry-After, and log redaction.

## Live verification

The real live gate is:

```bash
npm run test:live
```

Observed across bounded anonymous runs:

- public search returned `200 application/json` with two free forest results
  on some runs;
- the opaque next cursor returned a distinct second page;
- later search or detail requests were intermittently challenged;
- the clean dedicated browser received `403` with a Cloudflare challenge;
- the built MCP returned `FAB_BROWSER_ATTENTION_REQUIRED` without leaking
  response bodies, headers, cookies, or profile paths.
- a headed Inspector call on the non-graphical verification host returned
  `FAB_UPSTREAM_UNAVAILABLE` within 23 seconds rather than hanging past the MCP
  client deadline.

The live command intentionally exits nonzero while the required clean
browser/detail contract cannot be verified.

Latest bounded probe (`2026-07-28T21:56:43Z`):

- direct: `403 text/html`, classified `FAB_CHALLENGE`;
- dedicated anonymous Chromium: `403 text/html`, classified `FAB_CHALLENGE`;
- Chrome-controlled public free-search page: `403`, title
  `Just a moment...`, before the application search request ran;
- the visible check did not self-resolve after 20 seconds, and homepage-first
  navigation was challenged identically;
- current frontend bundles expose no separate public catalog origin suitable as
  a compliant fallback;
- no imported profile, inspected cookies/tokens, or bypass behavior.

Packaged artifact SHA-256:

```text
a1776ed5e86dddf63f84ff9a1fa215ae9ed4d4d9364bb256e10881b67ae67750
```

## Manual release gate

Configure one MCP host temporarily with `FAB_BROWSER_HEADLESS=0` and an
MCP-owned `FAB_BROWSER_PROFILE_DIR`. The server opens Fab in its dedicated
browser at startup. Complete any visible verification there before calling
`fab_search_assets`, then call search and `fab_get_asset` again. If the host
cannot open a graphical browser, move this release check to one that can. Do not
point the variable at a normal browser profile or copy an existing signed-in
session.

Release only after:

1. free search succeeds through the dedicated anonymous profile;
2. cursor pagination returns a distinct page;
3. one listing detail returns formats and per-license prices;
4. the result matches the public Fab UI;
5. `npm run test:live` exits zero.
