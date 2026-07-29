export type ItchPackId =
  | "tallbeard-music-loop-bundle"
  | "quaternius-universal-animation-library-1"
  | "quaternius-universal-animation-library-2"
  | "brackeys-vfx-bundle"
  | "kaykit-platformer";

export interface ItchPack {
  id: ItchPackId;
  name: string;
  sourceId: string;
  pageUrl: string;
  kind: "music" | "animation" | "vfx" | "3d-model";
  license: "CC0";
  attributionRequired: false;
  caution?: string;
}

export const ITCH_PACKS: readonly ItchPack[] = [
  {
    id: "tallbeard-music-loop-bundle",
    name: "Tallbeard Music Loop Bundle",
    sourceId: "tallbeard",
    pageUrl: "https://tallbeard.itch.io/music-loop-bundle",
    kind: "music",
    license: "CC0",
    attributionRequired: false,
    caution: "Credit to Abstraction is optional but appreciated by the creator.",
  },
  {
    id: "quaternius-universal-animation-library-1",
    name: "Quaternius Universal Animation Library 1",
    sourceId: "quaternius",
    pageUrl: "https://quaternius.itch.io/universal-animation-library",
    kind: "animation",
    license: "CC0",
    attributionRequired: false,
  },
  {
    id: "quaternius-universal-animation-library-2",
    name: "Quaternius Universal Animation Library 2",
    sourceId: "quaternius",
    pageUrl: "https://quaternius.itch.io/universal-animation-library-2",
    kind: "animation",
    license: "CC0",
    attributionRequired: false,
  },
  {
    id: "brackeys-vfx-bundle",
    name: "Brackeys VFX Bundle",
    sourceId: "brackeys-vfx",
    pageUrl: "https://brackeysgames.itch.io/brackeys-vfx-bundle",
    kind: "vfx",
    license: "CC0",
    attributionRequired: false,
  },
  {
    id: "kaykit-platformer",
    name: "KayKit Platformer Pack",
    sourceId: "kaykit",
    pageUrl: "https://kaylousberg.itch.io/kaykit-platformer",
    kind: "3d-model",
    license: "CC0",
    attributionRequired: false,
    caution: "Do not resell the unmodified pack or claim it as your own.",
  },
] as const;
