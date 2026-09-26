# PRD: Import uncooked UE5 static meshes (Megascans UE5-only packs)

Status: **done** · Opened 2026-09-25 · Probed 2026-09-25 · Shipped 2026-09-25 in asset-mcp 0.9.4

## Problem

Fab's Megascans UE5 packs ship uncooked editor packages. Before this change, `fab_import_asset`
exported **0 of 135** packages from Common Hazel (`81bc7ba6-…`, UE5.1-only) and **4 of 240** from
European Hornbeam's UE5.1 artifact.

- **Meshes:** CUE4Parse reads only cooked render data. An uncooked `UStaticMesh` has none: its
  geometry is the editor source model.
- **Texture colour:** editor source PNGs were written as stored. `TSF_BGRA8` sources are stored with
  red and blue swapped, and sRGB-sampled `TSF_RGBA16` sources are linear light.
- **Level textures:** a level's material textures were extracted without the `FCompressedBuffer`
  fallback. Every large UE5.1+ texture was missing from level copies, which came out untextured.
- **Report noise:** foliage types, material functions and parameter collections, which UE Viewer
  cannot list in UE5, were reported as failed packages.

## What shipped

- `ThreeNativeConverter` decodes an uncooked `UStaticMesh` (no `RenderData`) from its package
  trailer:
  - It ranks the Oodle `FCompressedBuffer` payloads by header raw size and decompresses the largest
    that parses as `FMeshDescription`, which is LOD0. Smaller payloads (other LODs, impostor cards)
    are never decompressed.
  - It writes POSITION, NORMAL and TEXCOORD_0 with the cooked glTF writer's conventions: position
    `(X, Z, Y) × 0.01`, triangle order kept, material named after the slot's material interface.
  - It leaves out vertex colours (Megascans stores wind masks there) and tangents (glTF clients
    generate MikkTSpace), matching the UE Viewer route's attribute set.
  - A parse that does not consume the whole payload is refused, never guessed.
  - The format spec is [`ue5-mesh-description-reference.py`](ue5-mesh-description-reference.py).
- `NormalizeSourcePng` at every editor-source-PNG write site swaps red and blue for `TSF_BGRA8`,
  and encodes linear→sRGB for `TSF_RGBA16` with `SRGB = true`. Skia decodes 16-bit PNGs only to
  half floats (`RgbaF16`); the unorm16 target fails with `InvalidConversion`.
- The material-texture site gained the missing `ExtractCompressedPayloadPng` fallback, and it now
  skips a texture whose PNG another material already wrote. Without the skip, Hazel's 58 materials
  re-decoded the same 8K sources over and over. The full-pack conversion then ran past the
  importer's 30-minute converter timeout, failing at 1,819 s. With it, the conversion takes 336 s.
- A logic-only Blueprint prefab (Megascans' `BP_GlobalFoliageActor_UE5`) that converts to nothing
  is reported as skipped. Modern levels and prefabs that produced no scene source are no longer
  reconstructed a second time, which used to add a misleading ENOENT failure.
- `readPackageCooking` names `FoliageType_InstancedStaticMesh`, `MaterialFunction` and
  `MaterialParameterCollection` by whole name-table entry. The importer reports those packages as
  skipped instead of failed, and only when nothing importable was detected.
- Converter `threenative.49`, `IMPORTER_VERSION` 46.

## Verification (evidence, not inference)

| Claim | Evidence |
|---|---|
| Payload format | Reference parser consumes 15 payloads byte-exact across 2 packs and 2 engine saves (4.7 KB–535 MB) |
| Geometry | Hornbeam UE5 Sapling_02: 10,741 + 28,745 = **39,486** triangles, the exact count the independent UE4.27 decoder produces for the same scan. Height is identical; X/Z differ by the two pipelines' axis conventions |
| C# = Python | Converter GLB for Hazel Sapling_01 matches the Python decode: 8,687 / 6,664 triangles, identical bounds |
| BGRA8 swap | Against UE Viewer's export of the same Megascans textures: RMSE 0.066 → **0.016** (leaf), 0.116 → **0.018** (bark) |
| RGBA16 sRGB | Converter output (0.233, 0.264, 0.080) = ImageMagick's independent linear→sRGB (0.234, 0.264, 0.081) |
| Level textures | Hazel Asset Zoo level export: 26 → 37 PNGs, all 9 albedo/mask/normal maps present |
| Skip classification | Unit test red→green. The hint is set on all 4 real non-importable packages and not on a mesh, texture or MI |
| End to end, Hazel UE5.1 | `fab_import_asset`: 0 → **63** exported, 120/123 sections textured (the 3 are the pack's UI icon material, which has no textures). Failures 135 → 32: 30 impostor or PivotPainter data textures, plus the 2 `BP_GlobalFoliageActor_UE5` entries that now skip (unit-tested red→green) |
| End to end, Hornbeam UE5.1 | 4 → **112** exported, 296/300 textured (again only the UI icon material). Failures 236 → 81: 79 impostor or PivotPainter data textures, plus the same 2 Blueprint entries that now skip |

Tests:
- `tests/unreal-ue5-editor-mesh.test.ts` runs only when the Hazel download and a converter at the
  current version exist. It checks the triangle count and the colour physics: bark R > B, and leaf
  green above 0.2 after sRGB encoding.
- `unreal-import.integration.test.ts` covers the skip classification.

## Follow-ups (not blocking)

- On UE4 packages, the modern converter's `ExtractLargestPng` can pick the 256² editor thumbnail
  instead of source art. UE4 textures normally route through UE Viewer, so this bites only on the
  fallback path.
- Hazel's leaves render darker than Hornbeam's even after the colour fix. The atlases now match in
  magnitude, so the difference is material-level: Megascans foliage brightness and translucency
  parameters have no glTF counterpart.
- Impostor atlases (`T_Impostor_*`) and PivotPainter float textures produce no PNG, as on UE4. They
  are distance billboards and wind data, not base-colour art.
