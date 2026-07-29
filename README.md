# threenative-asset-mcp

A [Model Context Protocol](https://modelcontextprotocol.io/) server for finding
3D assets across [Fab](https://www.fab.com/) and
[Poly Haven](https://polyhaven.com/). It gives AI clients provider-scoped,
structured search, asset metadata, category/filter discovery, downloadable file
data, and guarded Fab downloads for directly available free files.

`fab_search_assets` defaults to free assets. This means Fab reported at least
one free or effectively free license; it does not imply every license tier is
free. Use `fab_get_asset` before making license or price claims.

Poly Haven results are CC0 and explicitly labelled `Powered by Poly Haven`.
`polyhaven_list_files` exposes official download URLs, hashes, sizes, and
dependency relationships with pagination and resolution/format filters.

> Status: experimental. Fab's `/i/*` JSON routes are undocumented and can
> change or restrict automated access. Poly Haven provides a documented public
> API, but clients must send a unique User-Agent and visibly credit Poly Haven.
> Review each provider's terms and each asset's license.

## Requirements

- Node.js 20.19 or newer
- A local environment capable of running Playwright Chromium when Fab requests
  browser verification
- No Epic or Fab login is required or automated

## Install

An MCP host can launch the published package with:

```bash
npx -y threenative-asset-mcp
```

For a local checkout:

```bash
npm ci
npm run browser:install
npm run typecheck
npm test
npm run build
node dist/index.js
```

Playwright does not download Chromium as part of a normal package install. Run
`npx -p playwright@1.62.0 playwright install chromium` once on the MCP host
before relying on the browser fallback.

## MCP host configuration

### Codex

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.assets]
command = "npx"
args = ["-y", "threenative-asset-mcp"]
```

For a local build:

```toml
[mcp_servers.assets]
command = "node"
args = ["/absolute/path/to/threenative-asset-mcp/dist/index.js"]
```

### Claude Desktop

Add a server entry to the Claude Desktop configuration:

```json
{
  "mcpServers": {
    "assets": {
      "command": "npx",
      "args": ["-y", "threenative-asset-mcp"]
    }
  }
}
```

### VS Code

Create `.vscode/mcp.json`:

```json
{
  "servers": {
    "assets": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "threenative-asset-mcp"]
    }
  }
}
```

Restart the MCP host after changing its configuration.

## MCP tools

Fab:

- `fab_search_assets` — searches public listings. `priceMode` defaults to
  `free`; use `any` or `range` explicitly for paid results.
- `fab_get_asset` — returns normalized public listing details and per-license
  effective prices.
- `fab_list_filters` — returns known public filter labels and slugs, including
  an explicit warning when the versioned fallback is used.
- `fab_list_limited_time_free` — reads only a separately verified curated
  promotion surface. In production it extracts canonical listing UUIDs from
  Fab's public `/limited-time-free` page through the dedicated browser, then
  resolves them through the normal detail client; it never substitutes general
  `is_free=1` search.
- `fab_download_free_asset` — downloads one directly available free file into
  the dedicated download directory after explicit Fab EULA acknowledgement. It
  refuses purchase, acquisition, library-only, ambiguous, and unsafe-path
  flows.

Poly Haven:

- `polyhaven_search_assets` — searches HDRIs, textures, and models by text,
  type, and category, with relevance/popularity/date/name sorting and cursor
  pagination.
- `polyhaven_get_asset` — returns normalized metadata, attributes, authors,
  dimensions, resolution, and CC0 licensing for one asset.
- `polyhaven_list_categories` — returns category labels and counts for one
  asset type.
- `polyhaven_list_files` — returns the official file URLs, sizes, MD5 hashes,
  and dependency relationships. Use `resolution` and `format` to select usable
  variants; follow `nextCursor` until absent to retrieve every matching file.

All discovery and Poly Haven tools are read-only. The Fab download tool writes
only within its dedicated local directory and never purchases, adds to cart or
library, wishlists, signs in, or overwrites an existing download.

## Configuration

| Variable                        | Default                                            | Purpose                                                  |
| ------------------------------- | -------------------------------------------------- | -------------------------------------------------------- |
| `FAB_DIRECT_TIMEOUT_MS`         | `20000`                                            | Direct JSON request timeout.                             |
| `FAB_BROWSER_TIMEOUT_MS`        | `30000`                                            | Dedicated browser request timeout.                       |
| `FAB_BROWSER_MANUAL_TIMEOUT_MS` | `10000`                                            | Headed-mode grace period for visible verification.       |
| `FAB_BROWSER_HEADLESS`          | `true`                                             | Set to `0` temporarily for manual verification.          |
| `FAB_BROWSER_PROFILE_DIR`       | OS state directory under `threenative-asset-mcp/fab-browser-profile` | MCP-owned Fab browser state.                    |
| `FAB_DOWNLOAD_DIR`              | `~/Downloads/threenative-asset-mcp/fab`            | Dedicated directory for Fab free-file downloads.         |
| `FAB_MAX_DOWNLOAD_BYTES`        | `2147483648`                                       | Maximum accepted download size in bytes.                 |
| `FAB_DOWNLOAD_TIMEOUT_MS`       | `600000`                                           | Total timeout for one file download.                     |
| `FAB_CURL_IMPERSONATE`          | auto-detected on `PATH`                            | curl-impersonate wrapper override; `0`/`off` disables.   |
| `FAB_MIN_REQUEST_INTERVAL_MS`   | `1000`                                             | Minimum spacing between direct upstream requests.        |
| `FAB_LOG_LEVEL`                 | `warn`                                             | `debug`, `info`, `warn`, or `error`.                     |
| `FAB_LOG_QUERIES`               | `false`                                            | Set to `1` only if query text may be written to logs.    |

Direct requests are spaced at least `FAB_MIN_REQUEST_INTERVAL_MS` apart. Only
HTTP 429, 502, 503, and 504 are retried, at most twice, with backoff and
`Retry-After` support. Challenges, access denial, invalid input, missing
listings, and schema drift are never retried by the transport; a
curl-impersonate challenge response is additionally retried inside the
impersonation wrapper with longer, jittered waits before the browser fallback
is engaged.

## Browser-fingerprint TLS (curl-impersonate)

Fab's `/i/*` JSON routes sit behind Cloudflare bot management that challenges
Node's default TLS fingerprint — including plain `fetch` from this MCP and
headless Chromium — while real browser fingerprints pass. When a
[curl-impersonate](https://github.com/lwthiker/curl-impersonate) wrapper (for
example `curl_chrome146`) is available on the host `PATH`, the server performs
all anonymous JSON reads through it and no browser is needed for search,
detail, or download resolution. Set `FAB_CURL_IMPERSONATE=0` to force the old
behavior (plain Node fetch plus the Playwright fallback), or point it at a
specific wrapper binary.

Downloads of free files resolve entirely through the anonymous JSON contract
when possible: listing detail → `asset-formats/{format}` file listing →
`download-info` signed URL → guarded file write. The signed distribution URL
is validated against an exact Epic distribution-host allowlist before use.
Only when the direct path is challenged does the server fall back to the
guarded browser click flow below.

Process-local cache TTLs are five minutes for search, fifteen minutes for
listing details, six hours for taxonomy data, and ten minutes for promotions.
The shared LRU is capped at 500 entries and is cleared on process exit.

## Poly Haven API behavior

Poly Haven requests go only to `https://api.polyhaven.com`, with the required
`threenative-asset-mcp` User-Agent. Asset lists are cached for 15 minutes and
details, categories, and file trees are cached for up to one hour. Returned file
URLs are accepted only from `https://dl.polyhaven.org`.

The live API is free for personal and commercial use, but use of the API
requires a visible Poly Haven credit. The assets themselves are CC0. This MCP
includes `provider`, `license`, and `attribution` fields so downstream clients
can preserve that distinction. See the
[official API page](https://polyhaven.com/our-api) and
[API documentation](https://api.polyhaven.com/).

## Dedicated browser profile and privacy

When a direct anonymous request receives a Cloudflare challenge, the server may
open Playwright Chromium with a dedicated MCP-owned profile. It never attaches
to, copies, or reads the user's normal Chrome/Edge/Chromium profile, cookie
database, local storage, passwords, or Epic session.

If the tool returns `FAB_BROWSER_ATTENTION_REQUIRED`, run the same MCP command
once with `FAB_BROWSER_HEADLESS=0`. The MCP opens its dedicated Fab homepage at
startup, so complete any visible verification before calling the tool. A tool
call allows an additional `FAB_BROWSER_MANUAL_TIMEOUT_MS` grace period, then
returns `FAB_BROWSER_ATTENTION_REQUIRED` rather than exceeding typical MCP
client timeouts. Close the MCP process after verification and return to headless
mode. The server does not solve or bypass challenges.

Browser process startup is capped at ten seconds. On a host without a working
graphical session, headed mode returns `FAB_UPSTREAM_UNAVAILABLE` instead of
hanging an MCP call; run the manual release gate on a graphical host.

To clear browser-owned Fab state, stop every `threenative-asset-mcp` process and
move only the dedicated directory reported by your configuration out of
service. The default on Linux can be cleared recoverably with:

```bash
mv -- "${XDG_STATE_HOME:-$HOME/.local/state}/threenative-asset-mcp/fab-browser-profile" \
  "${XDG_STATE_HOME:-$HOME/.local/state}/threenative-asset-mcp/fab-browser-profile.cleared"
```

Do not point `FAB_BROWSER_PROFILE_DIR` at a normal browser profile. The server
rejects known normal-profile locations.

The MCP has no analytics or remote telemetry. Application logs are structured
JSON written only to stderr; stdout is reserved for MCP JSON-RPC. Search query
text is omitted from logs unless `FAB_LOG_QUERIES=1`. Raw upstream bodies,
headers, cookies, tokens, stack traces, and browser profile paths are not logged
or returned to the model.

## Troubleshooting

`FAB_CHALLENGE` or `FAB_BROWSER_ATTENTION_REQUIRED`
: Fab asked for browser verification. First check whether a curl-impersonate
wrapper is installed (`FAB_LOG_LEVEL=info` logs `fab_impersonate_enabled`
when active). Otherwise use the headed dedicated-profile step above. If
verification continues to fail, stop; do not copy a signed-in browser
session.

`FAB_RATE_LIMITED`
: Wait for `retryAfterSeconds` when present. The MCP already applied its bounded
retries.

`FAB_UPSTREAM_CHANGED`
: Fab's undocumented response changed. Re-run the sanitized contract probe and
update normalization and fixtures before continuing.

`FAB_UPSTREAM_UNAVAILABLE`
: Fab is unavailable, or a currently unverified discovery contract was
  intentionally disabled.

The MCP host shows no tools
: Build first, confirm the configured path is absolute, and run
`npm run inspect`. Logs belong on stderr; any non-JSON stdout is a bug.

## Verification

```bash
npm ci
npm run browser:install
npm run typecheck
npm test
npm run build
npm pack --dry-run
npm run inspect
```

Live checks are opt-in because they contact Fab:

```bash
npm run test:live
```

This runs the real anonymous search, cursor, detail, and dedicated-browser
contract probe. It exits nonzero when Fab challenges the clean browser or the
required contract cannot be verified. Live verification must remain anonymous,
concurrency-one, capped and paced. It must never acquire, purchase, wishlist,
download, or automatically solve a challenge.
