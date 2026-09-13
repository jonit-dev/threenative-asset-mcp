import type { AnimationReport } from "./inspect.js";

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

export function buildAnimationCatalog(input: {
  libraryId: string;
  variant: RigLibraryVariant;
  entryPath: string;
  entrySha256: string;
  animations: readonly AnimationReport[];
  donorUrlFor?: (clipName: string, variant: RigLibraryVariant) => string | null;
}): RigClipDescriptor[] {
  return input.animations.map((animation) => ({
    id: `${input.libraryId}/${animation.name}`,
    library: input.libraryId,
    name: animation.name,
    variant: input.variant,
    entry: input.entryPath,
    entrySha256: input.entrySha256,
    channels: animation.channels,
    durationSeconds: animation.durationSeconds,
    calibration: CALIBRATION_CLIP.test(animation.name),
    donor: {
      url: input.donorUrlFor?.(animation.name, input.variant) ?? null,
      sha256: null,
      bytes: null,
    },
  }));
}
