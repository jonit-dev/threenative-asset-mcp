# threenative-asset-mcp

A [Model Context Protocol](https://modelcontextprotocol.io/) server for finding
3D assets across [Fab](https://www.fab.com/),
[Poly Haven](https://polyhaven.com/), [ambientCG](https://ambientcg.com/),
[Smithsonian 3D](https://3d.si.edu/), [Sketchfab](https://sketchfab.com/), and a
curated game-audio catalog spanning Sonniss, Kenney, Tallbeard, Scott Buckley,
itch.io, Mixkit, Pixabay, Freesound, OpenGameArt, and Abstraction. It gives AI clients provider-scoped,
structured search, asset metadata, category/filter discovery, downloadable file
data, and guarded Fab downloads for directly available free files.

The audio tools separate **source discovery** from **verified direct downloads**.
All ten sources are described with license caveats and official browse pages;
only packs with stable official URLs and known license metadata appear in the
direct-download catalog. The initial downloadable set is Kenney Interface
Sounds, Kenney Music Jingles, and all five Sonniss GDC 2026 archives.

`fab_search_assets` defaults to free assets. This means Fab reported at least
one free or effectively free license; it does not imply every license tier is
free. Use `fab_get_asset` before making license or price claims.

Poly Haven results are CC0 and explicitly labelled `Powered by Poly Haven`.
`polyhaven_list_files` exposes official download URLs, hashes, sizes, and
dependency relationships with pagination and resolution/format filters.

> Status: experimental. Fab's `/i/*` JSON routes are undocumented and can
> change or restrict automated access. Poly Haven provides a documented public
> API, but clients must send a unique User-Agent and visibly credit Poly Haven.
> Sketchfab licenses vary per model and download URLs require a user API token.
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

ambientCG:

- `ambientcg_search_assets` — searches CC0 materials, HDRIs, substances,
  decals, atlases, 3D models, images, brushes, terrains, and HDRI elements.
- `ambientcg_get_asset` — returns metadata, maps, technique, dimensions,
  statistics, and CC0 licensing.
- `ambientcg_list_categories` — lists typed categories and asset counts.
- `ambientcg_list_files` — returns official archives with variant attributes,
  extensions, URLs, and byte sizes.

Smithsonian 3D:

- `smithsonian_search_assets` — searches Open Access models by text, format,
  quality, owning unit, Draco compression, and glTF orientation compliance.
- `smithsonian_get_asset` — groups the file-centric API response into one model
  summary.
- `smithsonian_list_files` — returns direct model files with format, quality,
  compression, and orientation metadata.

Sketchfab:

- `sketchfab_search_models` — anonymously searches public models, defaulting to
  downloadable results, and preserves author, geometry, archive, and license
  metadata.
- `sketchfab_get_model` — returns public detail and explicit Creative Commons
  requirements.
- `sketchfab_list_categories` — lists public category names and slugs.
- `sketchfab_get_downloads` — uses `SKETCHFAB_API_TOKEN` to retrieve temporary
  download URLs. It never stores the token or returns it in tool output.

Game audio:

- `audio_list_sources` — lists the ten supported audio libraries, best uses,
  official browse pages, license/attribution cautions, and honest download
  capability (`curated-direct` or `provider-page`).
- `audio_search_assets` — searches only the curated packs with stable official
  direct URLs. Results preserve license, commercial-use, attribution, source,
  size (when known), and redistribution metadata.
- `audio_download_asset` — downloads a catalog asset by ID after
  `acceptLicense: true`. It uses an HTTPS host allowlist, validates every
  redirect, streams with a byte cap, writes atomically without overwrite, and
  returns the local path, byte size, and SHA-256.

Curated itch.io packs:

- `itch_list_downloads` — resolves a fresh no-account download page and lists
  upload IDs, filenames, sizes, CC0 terms, and pack-specific cautions without
  exposing the signed page token.
- `itch_download_asset` — resolves a fresh 60-second signed file URL and streams
  the selected upload into guarded storage after `acceptLicense: true`. Signed
  URLs are not returned. The initial catalog covers Tallbeard Music Loop
  Bundle, Quaternius Universal Animation Libraries 1 and 2, Brackeys VFX
  Bundle, and KayKit Platformer.
- `asset_list_bundle_entries` — reads the remote ZIP directory with HTTP byte
  ranges and returns individual paths and sizes without downloading the archive.
- `asset_download_bundle_entry` — range-fetches and extracts one selected file,
  caches it with a SHA-256 sidecar, and never downloads unrelated bundle files.
- `asset_list_bundle_animations` — range-fetches only an aggregate GLB and lists
  its named animation clips. For Quaternius, it automatically prefers the
  standard non-root-motion GLB.
- `asset_download_bundle_animation` — exports one named animation as a valid
  animation-only GLB, removing unrelated clips, meshes, materials, and textures.
  The cached aggregate GLB is reused across requests.

Unified source and download routing:

- `asset_list_sources` — returns only **agent-ready sources by default** across
  3D, textures, HDRIs, animations, VFX, 2D, UI, icons, fonts, and audio. An
  agent-ready source has an MCP download tool and requires no manual browser,
  login, checkout, donation prompt, or paywall. Pass `agentReadyOnly: false` to
  inspect the broader research directory, including package-manager, Git, and
  provider-page sources that are not yet integrated.
- `asset_search_sources` — filters that directory by text, category, access
  mode, and license tag (`cc0`, `cc-by`, `mit`, and others), while preserving
  the same agent-ready-only default.
- `asset_download_file` — streams a direct URL previously returned by
  `polyhaven_list_files`, `ambientcg_list_files`, `smithsonian_list_files`, or
  the Game-icons.net bulk archive or Kenney Particle Pack entry into guarded
  local storage. Provider hosts and URL shapes are allowlisted, redirects are
  revalidated, existing files are never overwritten, and the result includes
  SHA-256.

Recommended agent flow:

1. Call `asset_search_sources` with the requested category/query. Its default
   result set is guaranteed to contain only agent-ready sources.
2. Call the returned `searchTool` or `detailTool` when present.
3. Resolve variants with the returned `filesTool`.
4. Call the returned `downloadTool` with `acceptLicense: true`.
5. For aggregate Quaternius animation libraries, skip whole-pack download:
   `itch_list_downloads` → `asset_list_bundle_animations` →
   `asset_download_bundle_animation`.

This is intentionally a short MCP tool chain rather than a fake universal URL:
each provider keeps its real search/variant semantics, while source routing and
the no-manual-flow guarantee stay uniform.

All discovery tools are read-only. Download tools write only within their
dedicated local directories and never purchase, add to cart or library,
wishlist, sign in, or overwrite an existing download. Audio packs remain
subject to their source license; raw redistribution is not implied by download.

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
| `SKETCHFAB_API_TOKEN`           | unset                                              | User token for temporary Sketchfab download URLs.        |
| `AUDIO_DOWNLOAD_DIR`            | `~/Downloads/threenative-asset-mcp/audio`          | Dedicated directory for curated audio downloads.         |
| `AUDIO_MAX_DOWNLOAD_BYTES`      | `10737418240`                                      | Maximum accepted bytes per audio archive (10 GiB).       |
| `AUDIO_DOWNLOAD_TIMEOUT_MS`     | `1800000`                                          | Total timeout for one audio download (30 minutes).       |
| `ASSET_DOWNLOAD_DIR`            | `~/Downloads/threenative-asset-mcp/assets`         | Dedicated directory for direct provider downloads.       |
| `ASSET_MAX_DOWNLOAD_BYTES`      | `10737418240`                                      | Maximum accepted bytes per provider file (10 GiB).       |
| `ASSET_DOWNLOAD_TIMEOUT_MS`     | `1800000`                                          | Total timeout for one provider download (30 minutes).    |

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

## Other provider behavior

ambientCG uses its anonymous, read-only v3 API. Its files are CC0 and its API
exposes searchable metadata, categories, and downloadable variants.

Smithsonian uses the anonymous Smithsonian 3D file-search API. Files exposed by
that API are part of Smithsonian Open Access; the MCP retains direct source
URLs and format/quality metadata.

Sketchfab public search, categories, and model detail do not require a token.
The download endpoint requires a token belonging to the user, configured
through `SKETCHFAB_API_TOKEN`. The token is sent only in the Sketchfab
`Authorization` header, is never logged or persisted, and is not included in
MCP responses. Sketchfab models use different Creative Commons licenses; always
inspect `license.requirements` before use.

Audio direct downloads are catalog-ID based; the MCP does not accept arbitrary
URLs. Official Kenney downloads are restricted to `kenney.nl` and Sonniss GDC
downloads to `downloads.sonniss.com`, including redirect revalidation. Sources
without a stable, verified direct contract remain discoverable as
`provider-page` instead of being falsely presented as one-click downloads.

The generic direct downloader is intentionally narrower than an arbitrary URL
fetcher. It accepts only official Poly Haven, ambientCG, Smithsonian,
Game-icons.net, and curated Kenney URL contracts. The itch.io downloader uses
fresh signed mirror URLs internally but never exposes them. Sketchfab signed
downloads are exposed through `sketchfab_get_downloads` but are not persisted
by the generic downloader because their temporary CDN hosts vary and require
the user's token-backed session. Provider-page-only sources stay provider-page-only until a stable,
license-safe download contract is verified.

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
npm run test:providers:live
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

`npm run test:providers:live` launches the compiled stdio MCP and exercises live
search, detail, categories, and file discovery for ambientCG, Smithsonian 3D,
and Sketchfab. If `SKETCHFAB_API_TOKEN` is configured it also verifies the
authenticated download endpoint; otherwise it verifies the explicit
authentication-required response.
