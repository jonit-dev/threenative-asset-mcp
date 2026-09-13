import type { AnimationReport } from "./inspect.js";
import pinnedCatalog from "./animation-catalog.json" with { type: "json" };

export type RigLibraryVariant = "in_place" | "root_motion";

export interface RigCatalogArchive {
  variant: RigLibraryVariant;
  archiveEntry: string;
}

export interface RigCatalogSource {
  id: string;
  label: string;
  kind: "sample" | "library";
  license: "CC0";
  attributionRequired: false;
  sourceUrl: string;
  revision?: string;
  bytes?: number;
  sha256?: string;
  archives?: readonly RigCatalogArchive[];
}

/**
 * Pinned, small source descriptors. No model or animation binaries live here;
 * AETHER and the UAL libraries are fetched only when the caller explicitly
 * selects a sample or supplies a local archive.
 */
export const RIG_CATALOG_SOURCES: readonly RigCatalogSource[] = [
  {
    id: "aether-02",
    label: "AETHER / 02 (default sample, rigid rig)",
    kind: "sample",
    license: "CC0",
    attributionRequired: false,
    sourceUrl:
      "https://raw.githubusercontent.com/RamonLinares/atlas-09/1b8fb9d54160215c071c5a29a49b1c36dc01f0df/public/models/aether-02.glb",
    revision: "1b8fb9d54160215c071c5a29a49b1c36dc01f0df",
    bytes: 5_992_836,
    sha256: "ed91ecddff69d3de088e475dcf529a5ab410d04b5c61ddb394ed29f482e8ce41",
  },
  {
    id: "aether-02-retopo",
    label: "AETHER / 02 unrigged retopology (auto-rig subject)",
    kind: "sample",
    license: "CC0",
    attributionRequired: false,
    sourceUrl:
      "https://raw.githubusercontent.com/RamonLinares/atlas-09/1b8fb9d54160215c071c5a29a49b1c36dc01f0df/assets/aether-02/retopo/71b9da3c-c71e-4861-b892-5ab03bf38e6d-model_url.glb",
    revision: "1b8fb9d54160215c071c5a29a49b1c36dc01f0df",
    bytes: 3_752_080,
    sha256: "3fefedfc067dafcd14e020ddfa623795ce69fbb966a8d369b29f0a9615b13641",
  },
  {
    id: "ual1",
    label: "Quaternius Universal Animation Library 1 (Standard)",
    kind: "library",
    license: "CC0",
    attributionRequired: false,
    sourceUrl: "https://quaternius.itch.io/universal-animation-library",
    archives: [
      { variant: "in_place", archiveEntry: "UAL1_Standard.glb" },
      { variant: "root_motion", archiveEntry: "UAL1_Standard_RM.glb" },
    ],
  },
  {
    id: "ual2",
    label: "Quaternius Universal Animation Library 2 (Standard)",
    kind: "library",
    license: "CC0",
    attributionRequired: false,
    sourceUrl: "https://quaternius.itch.io/universal-animation-library-2",
    archives: [
      { variant: "in_place", archiveEntry: "UAL2_Standard.glb" },
      { variant: "root_motion", archiveEntry: "UAL2_Standard_RM.glb" },
    ],
  },
] as const;

export interface RigClipDescriptor {
  id: string;
  library: string;
  name: string;
  variant: RigLibraryVariant;
  entry: string;
  entrySha256: string;
  channels: number;
  durationSeconds: number | null;
  /** The two T-pose calibration entries are hidden from normal motion selection. */
  calibration: boolean;
  donor: {
    url: string | null;
    sha256: string | null;
    bytes: number | null;
  };
}

const CALIBRATION_CLIP = /t[\s_-]?pose/i;

export interface PinnedCatalogClip {
  id: string;
  library: string;
  name: string;
  variant: RigLibraryVariant;
  calibration: boolean;
  donor: { url: string; sha256: string; bytes: number; joints: number };
}

interface PinnedCatalogShape {
  exporterVersion: string;
  clips: PinnedCatalogClip[];
}

const PINNED_CATALOG = pinnedCatalog as PinnedCatalogShape;

export const PINNED_CATALOG_VERSION = PINNED_CATALOG.exporterVersion;

export function pinnedDonorFor(
  id: string,
  variant: RigLibraryVariant,
): PinnedCatalogClip | null {
  return (
    PINNED_CATALOG.clips.find((clip) => clip.id === id && clip.variant === variant) ?? null
  );
}

export function buildAnimationCatalog(input: {
  libraryId: string;
  variant: RigLibraryVariant;
  entryPath: string;
  entrySha256: string;
  animations: readonly AnimationReport[];
  donorUrlFor?: (clipName: string, variant: RigLibraryVariant) => string | null;
}): RigClipDescriptor[] {
  return input.animations.map((animation) => {
    const id = `${input.libraryId}/${animation.name}`;
    const pinned = pinnedDonorFor(id, input.variant);
    return {
      id,
      library: input.libraryId,
      name: animation.name,
      variant: input.variant,
      entry: input.entryPath,
      entrySha256: input.entrySha256,
      channels: animation.channels,
      durationSeconds: animation.durationSeconds,
      calibration: pinned?.calibration ?? CALIBRATION_CLIP.test(animation.name),
      donor: pinned
        ? { url: pinned.donor.url, sha256: pinned.donor.sha256, bytes: pinned.donor.bytes }
        : {
            url: input.donorUrlFor?.(animation.name, input.variant) ?? null,
            sha256: null,
            bytes: null,
          },
    };
  });
}
