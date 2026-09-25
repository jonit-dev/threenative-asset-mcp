# PRD: Import uncooked UE5 static meshes (Megascans UE5-only packs)

Status: not started · Opened 2026-09-25

## Problem

Fab's Megascans UE5 packs ship uncooked editor packages. An example is Common Hazel
(`81bc7ba6-4686-4f94-9d2b-83eb1fdc4079`), whose only artifact is `MS_Hazel_UE51` for UE5.1–5.6.
`fab_import_asset` exports nothing from it: 0 of 135 packages.

- UE Viewer cannot list the UE5 packages (exit 1), so they route to the modern converter.
- The modern converter loads `UStaticMesh`, but CUE4Parse reads only cooked render data. It exits 134
  with `No StaticMesh ... output was produced. Loaded export types: UBodySetup, UObject, UMetaData,
  UNavCollision, UStaticMesh`.
- Texture2D packages fail the same way ("modern UE5 texture converter produced no PNG"). This
  suggests uncooked UE5 textures are affected too (source art held in `FEditorBulkData`).

## Goal

A UE5.1-saved uncooked Megascans tree imports as textured GLBs with the same fidelity as the
UE4.27 artifact of a sibling pack (European Hornbeam UE4.27: 58 meshes, 144/152 sections textured,
green Summer foliage).

## Phases

1. **Probe (1–2 h).** Confirm the layout on `SM_CommonHazel_Sapling_01`:
   - Is it Nanite?
   - Which source model holds the geometry (HiRes or LOD0)?
   - Is the `FEditorBulkData` payload local, and how is it compressed (FCompressedBuffer / Oodle)?
   - Does the texture failure share the same cause?

   Record the findings here.
2. **Decode.** In `ThreeNativeConverter`, read the UE5 `FMeshDescriptionBulkData` from the source model
   and emit a GLB. The UE4.27 MeshDescription decoder in `unreal-assets-to-glb` is the reference
   for the attribute layout. Do the same for the texture source (`FTextureSource`) if the probe
   shows the same cause.
3. **Verify.** Add a real-pack test gated on the Hazel download, plus rendered contact sheets
   inspected by eye. Loading is not the same as looking right.

## Out of scope

Impostor atlases (`T_Impostor_*`): UE Viewer also produces no PNG for them on UE4.27, and they are
distance billboards, not needed for mesh import.
