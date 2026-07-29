# 001: Quaternius remote ZIP range extraction

## Question

Given a Quaternius animation ZIP exposed through itch.io, can the MCP list archive entries and extract one file without downloading the complete bundle? Can it then export only one animation from Quaternius's aggregate GLB?

## Approach

Resolve itch.io's no-account signed file URL, then expose it to Python's `zipfile` through a seekable HTTP Range reader. Measure every response byte and compare it with the archive size. Never print or persist the signed URL.

For animation-level extraction, parse the ranged GLB with `@gltf-transform/core`, retain one named animation and its accessors, remove unrelated clips/mesh/material/texture payloads, and validate the output GLB.

## Result

Live Quaternius Universal Animation Library 1 Standard:

- Full ZIP: 15,904,933 bytes.
- ZIP listing: 1,537 bytes in the minimal Python range reader.
- Standard GLB compressed entry: 2,731,956 bytes.
- Total transfer to list and extract the GLB: 2,733,623 bytes (17.19% of ZIP).
- Aggregate GLB: 7,618,436 uncompressed bytes and 43 named clips.
- Exported `Jog_Fwd_Loop`: 124,616 bytes, one animation, no meshes/materials/textures.
- glTF validation: passed.

The production zip.js path later transferred 67,052 bytes to list the live ZIP and 2,799,070 bytes to extract/cache the GLB. It exported `Jog_Fwd_Loop` as a 124,640-byte valid GLB and reused the cached aggregate with zero additional network bytes.

## Verdict

**Viable and implemented.** Bundle providers backed by range-capable ZIPs can expose individual files without downloading unrelated content. Quaternius animation libraries need one extra transformation because animations are clips inside aggregate GLB/FBX files, not individual ZIP members. The production MCP now provides remote entry listing/extraction plus named GLB animation listing/export.
