/**
 * Reconstructs a standard glTF PBR material from what UE Viewer can recover of an Unreal material.
 *
 * Three sources, ranked. The `.mat` file is the authority: umodel resolved the material graph far
 * enough to name a Diffuse/Normal/Specular/SpecPower/Opacity/Emissive/Cube/Mask texture, and a slot
 * it names is exact. `.props.txt` carries `CollectedTextureParameters`, the material's own
 * parameter names, which recover slots the `.mat` left in `Other[n]` — the Kite Demo foliage is the
 * case that matters: its diffuse atlas is `Other[0]` in the `.mat` and `Diffuse` in the props. That
 * is the material's naming rather than umodel's resolution, so it is heuristic. Texture filename
 * suffixes are the last resort and are always heuristic. Anything left over is reported as
 * unsupported with its name; nothing is silently dropped and no debug colour is ever called a
 * texture.
 */

export type GltfSlot =
  | "baseColor"
  | "normal"
  | "emissive"
  | "metallicRoughness"
  | "occlusion";

/**
 * Named channel transforms. Unreal packs channels in ways glTF does not share, so a texture bound
 * to metallicRoughness usually has to be rebuilt rather than referenced. Each one is exercised by
 * a unit test over synthetic pixels.
 */
export type TextureTransform =
  | "none"
  /** RGB(A) diffuse whose alpha is roughness (`*_D_R`): alpha becomes glTF's green channel. */
  | "alphaToRoughness"
  /** A gloss/specular-power map in red: roughness is its inverse. */
  | "specPowerToRoughness"
  /** A roughness map already in red: moved to glTF's green channel. */
  | "redToRoughness";

export type BindingSource = "mat" | "props" | "filename";
export type BindingConfidence = "exact" | "heuristic";

export interface MaterialTextureBinding {
  readonly slot: GltfSlot;
  readonly texture: string;
  readonly source: BindingSource;
  readonly confidence: BindingConfidence;
  readonly transform: TextureTransform;
}

export interface UnsupportedTexture {
  readonly texture: string;
  readonly reason: string;
}

export interface ResolvedMaterial {
  readonly name: string;
  readonly bindings: readonly MaterialTextureBinding[];
  readonly unsupported: readonly UnsupportedTexture[];
  readonly alphaMode: "OPAQUE" | "MASK" | "BLEND";
  readonly alphaCutoff: number | undefined;
  readonly doubleSided: boolean;
  /** Parent materials followed, nearest first. Empty for a plain Material. */
  readonly parents: readonly string[];
}

export interface MatFile {
  readonly slots: ReadonlyMap<string, string>;
  readonly others: readonly string[];
}

export interface CollectedTextureParameter {
  readonly name: string;
  readonly texture: string;
}

export interface PropsFile {
  readonly twoSided: boolean;
  readonly blendMode: string | undefined;
  readonly opacityMaskClipValue: number | undefined;
  /** `CollectedTextureParameters`, present from UE 4.19 on. */
  readonly collected: readonly CollectedTextureParameter[];
  /** `TextureParameterValues` — a MaterialInstanceConstant's own overrides of its parent's inputs.
   * The only place an instance's textures appear when umodel resolved the parent's instead. */
  readonly overrides: readonly CollectedTextureParameter[];
  readonly parent: string | undefined;
}

const MAT_SLOTS = new Set([
  "Diffuse",
  "Normal",
  "Specular",
  "SpecPower",
  "Opacity",
  "Emissive",
  "Cube",
  "Mask",
]);

/** Parses umodel's `<Material>.mat`: one `Key=TextureName` per line, `Other[n]` for the rest. */
export function parseMatFile(text: string): MatFile {
  const slots = new Map<string, string>();
  const others: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!value) continue;
    if (/^Other\[\d+\]$/.test(key)) {
      others.push(value);
      continue;
    }
    if (MAT_SLOTS.has(key)) slots.set(key, value);
  }
  return { slots, others };
}

/** `Texture2D'Content/Path/Name.Name'` → `Name`. */
function objectName(reference: string): string | undefined {
  const quoted = /'([^']+)'/.exec(reference)?.[1] ?? reference;
  const afterDot = quoted.includes(".") ? quoted.slice(quoted.lastIndexOf(".") + 1) : quoted;
  const name = afterDot.trim();
  return name === "" || name === "None" ? undefined : name;
}

/**
 * Parses umodel's `<Material>.props.txt`. The file is a brace-nested dump, so the block containing
 * `CollectedTextureParameters` is walked by depth rather than matched with one regex: the same
 * `Texture =` key appears inside `ReferencedTextures` and `CachedExpressionData`, where it carries
 * no parameter name.
 */
export function parsePropsFile(text: string): PropsFile {
  const lines = text.split(/\r?\n/);
  let twoSided = false;
  let blendMode: string | undefined;
  let opacityMaskClipValue: number | undefined;
  let parent: string | undefined;
  const collected: CollectedTextureParameter[] = [];

  const overrides: CollectedTextureParameter[] = [];
  let inCollected = false;
  let collectedDepth = 0;
  let inOverrides = false;
  let overridesDepth = 0;
  let depth = 0;
  let pendingTexture: string | undefined;
  let pendingName: string | undefined;
  let overrideTexture: string | undefined;
  let overrideName: string | undefined;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^TwoSided\s*=\s*true$/.test(line)) twoSided = true;
    if (blendMode === undefined) {
      const blend = /^BlendMode\s*=\s*(BLEND_[A-Za-z]+)/.exec(line);
      if (blend?.[1]) blendMode = blend[1];
    }
    if (opacityMaskClipValue === undefined) {
      const clip = /^OpacityMaskClipValue\s*=\s*([0-9.]+)/.exec(line);
      if (clip?.[1]) opacityMaskClipValue = Number(clip[1]);
    }
    if (parent === undefined && /^Parent\s*=/.test(line)) {
      parent = objectName(line.slice(line.indexOf("=") + 1));
    }
    if (!inCollected && /^CollectedTextureParameters\[\d+\]/.test(line)) {
      inCollected = true;
      collectedDepth = depth;
      pendingTexture = undefined;
      pendingName = undefined;
    }
    if (inCollected) {
      const texture = /^Texture\s*=\s*(.+)$/.exec(line);
      if (texture?.[1]) pendingTexture = objectName(texture[1]);
      const name = /^Name\s*=\s*(.+)$/.exec(line);
      if (name?.[1]) pendingName = name[1].trim();
      if (pendingTexture && pendingName) {
        collected.push({ name: pendingName, texture: pendingTexture });
        pendingTexture = undefined;
        pendingName = undefined;
      }
    }
    if (!inOverrides && /^TextureParameterValues\[\d+\]/.test(line)) {
      inOverrides = true;
      overridesDepth = depth;
      overrideTexture = undefined;
      overrideName = undefined;
    }
    if (inOverrides) {
      const value = /^ParameterValue\s*=\s*(.+)$/.exec(line);
      if (value?.[1]) overrideTexture = objectName(value[1]);
      const parameterName = /^ParameterName\s*=\s*(.+)$/.exec(line);
      if (parameterName?.[1]) overrideName = parameterName[1].trim();
      if (overrideTexture && overrideName) {
        overrides.push({ name: overrideName, texture: overrideTexture });
        overrideTexture = undefined;
        overrideName = undefined;
      }
    }

    for (const character of line) {
      if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (inCollected && depth <= collectedDepth) inCollected = false;
        if (inOverrides && depth <= overridesDepth) inOverrides = false;
      }
    }
  }

  return { twoSided, blendMode, opacityMaskClipValue, collected, overrides, parent };
}

interface SlotPlan {
  readonly slot: GltfSlot;
  readonly transform: TextureTransform;
}

/** How each `.mat` key maps onto glTF's fixed PBR slots. `Cube` has no glTF counterpart. */
const MAT_SLOT_PLAN: Record<string, SlotPlan | undefined> = {
  Diffuse: { slot: "baseColor", transform: "none" },
  Normal: { slot: "normal", transform: "none" },
  Emissive: { slot: "emissive", transform: "none" },
  Specular: { slot: "metallicRoughness", transform: "specPowerToRoughness" },
  SpecPower: { slot: "metallicRoughness", transform: "specPowerToRoughness" },
};

/** Material parameter names, normalized. Unreal authors name these; we only recognize them. */
function planForParameterName(name: string): SlotPlan | undefined {
  const key = name.toLowerCase().replace(/[^a-z]/g, "");
  if (["diffuse", "basecolor", "albedo", "color", "basecolour"].includes(key)) {
    return { slot: "baseColor", transform: "none" };
  }
  if (["normal", "normalmap", "bump", "nrm", "nor", "norm", "mainnormal", "normaltexture"].includes(key)) {
    return { slot: "normal", transform: "none" };
  }
  if (["emissive", "emission"].includes(key)) {
    return { slot: "emissive", transform: "none" };
  }
  if (["spec", "specular", "specpower", "gloss", "glossiness"].includes(key)) {
    return { slot: "metallicRoughness", transform: "specPowerToRoughness" };
  }
  if (["rough", "roughness"].includes(key)) {
    return { slot: "metallicRoughness", transform: "redToRoughness" };
  }
  if (["ao", "occlusion", "ambientocclusion"].includes(key)) {
    return { slot: "occlusion", transform: "none" };
  }
  return undefined;
}

/** Texture filename suffixes, the weakest signal and the only one that reads no material data. */
function planForFileName(texture: string): SlotPlan | undefined {
  const name = texture.toLowerCase();
  if (/_d(?:\d+)?(?:_[a-z]+)*_r$/.test(name)) {
    return { slot: "baseColor", transform: "none" };
  }
  if (/(_n|_nrm|_normal)(_tex)?$/.test(name)) return { slot: "normal", transform: "none" };
  if (/(_d|_diff|_diffuse|_basecolor|_albedo)(_tex)?$/.test(name)) {
    return { slot: "baseColor", transform: "none" };
  }
  if (/(_e|_emissive)(_tex)?$/.test(name)) return { slot: "emissive", transform: "none" };
  if (/(_ao|_occlusion)(_tex)?$/.test(name)) return { slot: "occlusion", transform: "none" };
  if (/(_r|_rough|_roughness)(_tex)?$/.test(name)) {
    return { slot: "metallicRoughness", transform: "redToRoughness" };
  }
  if (/(_s|_spec|_specular)(_tex)?$/.test(name)) {
    return { slot: "metallicRoughness", transform: "specPowerToRoughness" };
  }
  return undefined;
}

/** `*_D_R` textures carry roughness in alpha; the same image serves both slots. */
export function packsRoughnessInAlpha(texture: string): boolean {
  return /_d(?:\d+)?(?:_[a-z0-9]+)*_r$/i.test(texture);
}

export interface ResolveMaterialRequest {
  readonly name: string;
  /** Returns the `.mat` text for a material name, or undefined when it was not exported. */
  readonly readMat: (materialName: string) => string | undefined;
  /** Returns the `.props.txt` text for a material name, or undefined. */
  readonly readProps: (materialName: string) => string | undefined;
  /** Names of the textures actually written next to the material. */
  readonly availableTextures: ReadonlySet<string>;
}

const MAX_PARENT_DEPTH = 8;

/**
 * Resolves one material, following `Parent` chains with a visited set so a self-referential or
 * mutually-referential instance terminates instead of recursing forever.
 */
export function resolveMaterial(request: ResolveMaterialRequest): ResolvedMaterial {
  const bindings = new Map<GltfSlot, MaterialTextureBinding>();
  const claimed = new Set<string>();
  const seenMaterials = new Set<string>();
  const parents: string[] = [];

  let alphaMode: ResolvedMaterial["alphaMode"] = "OPAQUE";
  let alphaCutoff: number | undefined;
  let doubleSided = false;
  let sawAlphaSource = false;

  const bind = (
    plan: SlotPlan,
    texture: string,
    source: BindingSource,
    confidence: BindingConfidence,
  ): void => {
    claimed.add(texture);
    if (bindings.has(plan.slot)) return;
    if (!request.availableTextures.has(texture)) return;
    bindings.set(plan.slot, {
      slot: plan.slot,
      texture,
      source,
      confidence,
      transform: plan.transform,
    });
  };

  let current: string | undefined = request.name;
  for (let depth = 0; current && depth < MAX_PARENT_DEPTH; depth += 1) {
    if (seenMaterials.has(current)) break;
    seenMaterials.add(current);
    if (depth > 0) parents.push(current);

    const matText = request.readMat(current);
    const propsText = request.readProps(current);
    const mat = matText ? parseMatFile(matText) : undefined;
    const props = propsText ? parsePropsFile(propsText) : undefined;

    if (mat) {
      for (const [key, texture] of mat.slots) {
        if (key === "Opacity" || key === "Mask") {
          claimed.add(texture);
          sawAlphaSource = true;
          continue;
        }
        if (key === "Cube") {
          claimed.add(texture);
          continue;
        }
        const plan = MAT_SLOT_PLAN[key];
        if (plan) bind(plan, texture, "mat", "exact");
      }
    }

    if (props) {
      doubleSided = doubleSided || props.twoSided;
      if (alphaMode === "OPAQUE" && props.blendMode === "BLEND_Masked") {
        alphaMode = "MASK";
        alphaCutoff = props.opacityMaskClipValue ?? 0.333;
      } else if (alphaMode === "OPAQUE" && props.blendMode === "BLEND_Translucent") {
        alphaMode = "BLEND";
      }
      for (const parameter of props.collected) {
        const plan = planForParameterName(parameter.name);
        if (plan) bind(plan, parameter.texture, "props", "heuristic");
      }
      // An instance's own overrides fill slots umodel did not resolve. They never displace a
      // `.mat` slot: umodel walked the real graph to produce that one, and a parameter name is
      // only a name.
      for (const parameter of props.overrides) {
        const plan = planForParameterName(parameter.name);
        if (plan) bind(plan, parameter.texture, "props", "heuristic");
      }
    }

    if (mat) {
      for (const texture of mat.others) {
        if (claimed.has(texture)) continue;
        const plan = planForFileName(texture);
        if (plan) bind(plan, texture, "filename", "heuristic");
      }
    }

    current = props?.parent;
  }

  // A `*_D_R` base colour also carries roughness in its alpha channel.
  const baseColor = bindings.get("baseColor");
  if (baseColor && !bindings.has("metallicRoughness") && packsRoughnessInAlpha(baseColor.texture)) {
    bindings.set("metallicRoughness", {
      slot: "metallicRoughness",
      texture: baseColor.texture,
      source: baseColor.source,
      confidence: "heuristic",
      transform: "alphaToRoughness",
    });
  }

  // Masked foliage takes its cutout from the base colour's own alpha channel.
  if (alphaMode === "OPAQUE" && sawAlphaSource && baseColor) {
    alphaMode = "MASK";
    alphaCutoff = 0.333;
  }

  const unsupported: UnsupportedTexture[] = [];
  const referenced = new Set<string>();
  for (const material of seenMaterials) {
    const matText = request.readMat(material);
    if (!matText) continue;
    const mat = parseMatFile(matText);
    for (const texture of mat.slots.values()) referenced.add(texture);
    for (const texture of mat.others) referenced.add(texture);
    const propsText = request.readProps(material);
    if (propsText) {
      for (const parameter of parsePropsFile(propsText).overrides) referenced.add(parameter.texture);
    }
  }
  const bound = new Set([...bindings.values()].map((binding) => binding.texture));
  for (const texture of referenced) {
    if (bound.has(texture)) continue;
    unsupported.push({
      texture,
      reason: claimed.has(texture)
        ? "recognized but has no glTF PBR counterpart"
        : "no exact, parameter-name, or filename mapping",
    });
  }

  return {
    name: request.name,
    bindings: [...bindings.values()],
    unsupported,
    alphaMode,
    alphaCutoff,
    doubleSided,
    parents,
  };
}
