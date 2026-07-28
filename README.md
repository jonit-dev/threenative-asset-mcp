# Fab MCP

An unofficial, read-only [Model Context Protocol](https://modelcontextprotocol.io/)
server for finding public assets on [Fab](https://www.fab.com/). It gives AI
clients structured marketplace search, listing details, filter discovery, and a
separate limited-time-free surface.

`fab_search_assets` defaults to free assets. This means Fab reported at least
one free or effectively free license; it does not imply every license tier is
free. Use `fab_get_asset` before making license or price claims.

> Status: experimental. Fab's `/i/*` JSON routes are undocumented and can
> change or restrict automated access. Complete legal/product review before
> publishing or operating this integration broadly.

## Requirements

- Node.js 20.19 or newer
- A local environment capable of running Playwright Chromium when Fab requests
  browser verification
- No Epic or Fab login is required or automated

## Install and build

This workspace is not published to npm yet:

```bash
npm ci
npm run browser:install
npm run typecheck
npm test
npm run build
node dist/index.js
```

After publication, an MCP host can use `npx -y fab-mcp`. For a local checkout,
replace the `npx` command in the examples below with `node` and set `args` to
the absolute path to `dist/index.js`.

Playwright does not download Chromium as part of a normal package install. Run
`npx -p playwright@1.62.0 playwright install chromium` once on the MCP host
before relying on the browser fallback.

## MCP host configuration

### Codex

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.fab]
command = "npx"
args = ["-y", "fab-mcp"]
```

For a local build:

```toml
[mcp_servers.fab]
command = "node"
args = ["/absolute/path/to/fab-mcp/dist/index.js"]
```

### Claude Desktop

Add a server entry to the Claude Desktop configuration:

```json
{
  "mcpServers": {
    "fab": {
      "command": "npx",
      "args": ["-y", "fab-mcp"]
    }
  }
}
```

### VS Code

Create `.vscode/mcp.json`:

```json
{
  "servers": {
    "fab": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "fab-mcp"]
    }
  }
}
```

Restart the MCP host after changing its configuration.

## Tools

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

Every tool is annotated read-only, non-destructive, and idempotent. There are no
purchase, cart, library, wishlist, acquisition, login, or download operations.

## Configuration

| Variable                        | Default                                            | Purpose                                                  |
| ------------------------------- | -------------------------------------------------- | -------------------------------------------------------- |
| `FAB_DIRECT_TIMEOUT_MS`         | `20000`                                            | Direct JSON request timeout.                             |
| `FAB_BROWSER_TIMEOUT_MS`        | `30000`                                            | Dedicated browser request timeout.                       |
| `FAB_BROWSER_MANUAL_TIMEOUT_MS` | `10000`                                            | Headed-mode grace period for visible verification.       |
| `FAB_BROWSER_HEADLESS`          | `true`                                             | Set to `0` temporarily for manual verification.          |
| `FAB_BROWSER_PROFILE_DIR`       | OS state directory under `fab-mcp/browser-profile` | MCP-owned browser state.                                 |
| `FAB_LOG_LEVEL`                 | `warn`                                             | `debug`, `info`, `warn`, or `error`.                     |
| `FAB_LOG_QUERIES`               | `false`                                            | Set to `1` only if query text may be written to logs.    |

Direct requests are limited to one start every 750 ms. Only HTTP 429, 502, 503,
and 504 are retried, at most twice, with backoff and `Retry-After` support.
Challenges, access denial, invalid input, missing listings, and schema drift are
never retried.

Process-local cache TTLs are five minutes for search, fifteen minutes for
listing details, six hours for taxonomy data, and ten minutes for promotions.
The shared LRU is capped at 500 entries and is cleared on process exit.

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

To clear browser-owned Fab state, stop every `fab-mcp` process and move only the
dedicated directory reported by your configuration out of service. The default
on Linux can be cleared recoverably with:

```bash
mv -- "${XDG_STATE_HOME:-$HOME/.local/state}/fab-mcp/browser-profile" \
  "${XDG_STATE_HOME:-$HOME/.local/state}/fab-mcp/browser-profile.cleared"
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
: Fab asked for browser verification. Use the headed dedicated-profile step
above. If verification continues to fail, stop; do not copy a signed-in
browser session.

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
