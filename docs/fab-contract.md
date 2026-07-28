# Fab public read contract

Captured: 2026-07-28

## Decision

**Conditional go** for an unofficial, local MCP with read-only discovery and
guarded downloads of directly available free files.

Fab exposes public browsing without requiring acquisition or account access, and
`GET https://www.fab.com/i/listings/search` was observed returning anonymous
JSON during this investigation. The same route can intermittently return a
Cloudflare `403` challenge, including from a clean Playwright profile. The MCP
may use the undocumented read paths only while it:

- sends no Cookie or Authorization header;
- never imports or attaches to a user's browser profile;
- performs no acquisition, library, wishlist, cart, checkout, or login action;
- downloads only a format exposed as directly available from the public listing
  UI, after explicit EULA acknowledgement, into a dedicated local directory;
- refuses purchase, acquisition, library-only, ambiguous, oversized, and
  unsafe-path download flows and never overwrites an existing file;
- accepts only JSON from allow-listed `https://www.fab.com/i/...` URLs;
- classifies challenges and never attempts to bypass CAPTCHA or fingerprinting;
- keeps the browser fallback optional and returns
  `FAB_BROWSER_ATTENTION_REQUIRED` when a clean profile needs manual attention.

The server is not an official Fab integration. Upstream drift or a policy
change is a release blocker until this contract is revalidated.

## Observed search contract

Candidate operation:

```text
GET /i/listings/search
```

Confirmed public route parameters:

| Parameter | Meaning |
| --- | --- |
| `q` | search text |
| `is_free=1` | at least one free or effectively-free offer |
| `sort_by=-relevance` | relevance ordering |
| `count` | page size; v1 caps this at 24 |
| `currency` | requested display currency |
| `cursor` | opaque continuation value |

Multi-value filters are serialized as repeated keys. The current UI contract
also names `channels`, `listing_types`, `categories`, `asset_formats`, `tags`,
`licenses`, `seller`, `average_rating`, `published_since`,
`is_ai_generated`, and `is_ai_forbidden`.

Observed response envelope:

```ts
{
  results: unknown[];
  cursors?: {
    next?: string | null;
    previous?: string | null;
  };
}
```

The cursor is passed through byte-for-byte and is never decoded. A search
listing is free when at least one license effective price is zero, or when its
starting effective price is zero. This does not mean every license is free.

## Detail and discovery candidates

The listing detail candidate is:

```text
GET /i/listings/{uuid}?currency=USD
```

The live UI and bundle expose public detail fields for seller, description,
categories, tags, media, formats, compatible applications, dates, AI flags,
maturity, and per-license price tiers. Phase 3 must keep its parser tolerant of
additive upstream fields but fail closed when the identity/title contract
disappears.

Stable taxonomy JSON operations were not confirmed from the clean anonymous
probe. `fab_list_filters` must therefore use a versioned fallback taxonomy and
return a warning until a current public taxonomy operation is captured.

Limited-time-free is a curated Fab surface distinct from `is_free=1`. No stable
anonymous JSON operation was confirmed. The only permitted fallback is to read
listing IDs from the public `/limited-time-free` page in the dedicated browser,
then resolve those IDs through the normal listing client. Promotion end times
must come from explicit upstream data.

## Cloudflare observations

- A command-line anonymous request returned a `403` HTML response with
  `cf-mitigated: challenge` during final verification.
- A Node request returned JSON once during exploration and returned a challenge
  on later runs.
- A clean temporary Playwright Chromium profile reached Fab, but its same-origin
  JSON request was challenged in headless mode.
- The Chrome control integration independently loaded the public free-search
  page and received `403` with title `Just a moment...` before Fab's application
  issued `/i/listings/search`.
- The challenge remained after a 20-second passive wait, and loading the
  homepage before search produced the same result.
- A repeat inspection of the current frontend bundles found the same-origin
  listing operations but no alternate public catalog API origin.
- A headed built-MCP probe on the non-graphical verification host failed closed
  with `FAB_UPSTREAM_UNAVAILABLE` within the client deadline; browser startup is
  capped to prevent a hanging MCP call.
- No bypass behavior was attempted and no user Chrome cookies, local storage,
  session storage, profile files, or authorization values were inspected.

Run the repeatable probe:

```bash
npm run probe:fab
```

Set `FAB_PROBE_HEADED=1` to open the same temporary anonymous profile visibly.
The profile is deleted after the probe.

## Fixture policy

`tests/fixtures/fab-contracts.ts` contains synthetic, sanitized shapes used for
deterministic tests. It intentionally contains no raw headers, cookies,
tracking fields, account identifiers, or complete upstream bodies.
