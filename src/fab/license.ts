/**
 * Which Fab entitlements this server is willing to convert into game assets.
 *
 * Fab Standard — the Personal and Professional licences — and CC-BY are the only ones that permit
 * what an import does: taking the asset out of Unreal and shipping it inside another engine's
 * runtime. The legacy Unreal-Engine-only entitlements do not, and a listing whose licence cannot
 * be read is not evidence that it may be used. The check therefore fails closed: unknown is a
 * refusal, not a warning.
 */

export type LicenseVerdict = "allowed" | "rejected" | "unverified";

export interface LicenseDecision {
  readonly verdict: LicenseVerdict;
  /** Every slug the listing published, normalized. */
  readonly slugs: readonly string[];
  /** The slugs that permitted the import, when the verdict is `allowed`. */
  readonly allowed: readonly string[];
  readonly reason: string;
}

/** Fab Standard is the Personal + Professional pair; CC-BY is accepted on the same footing. */
const ALLOWED = new Map<string, string>([
  ["personal", "Fab Standard (Personal)"],
  ["professional", "Fab Standard (Professional)"],
  ["ccby", "CC-BY"],
  ["ccby40", "CC-BY 4.0"],
  ["ccbysa", "CC-BY-SA"],
]);

/** Named so the refusal can say which entitlement blocked it rather than "not allowed". */
const KNOWN_REJECTED: readonly { readonly test: RegExp; readonly label: string }[] = [
  { test: /ueonly|unrealengineonly|uenoncommercial/, label: "Unreal-Engine-only" },
  { test: /legacy/, label: "legacy marketplace" },
  { test: /ccbync|noncommercial|ccbynd|noderiv/, label: "non-commercial or no-derivatives Creative Commons" },
];

export function normalizeLicenseSlug(slug: string): string {
  return slug.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function classifyLicenses(slugs: readonly string[]): LicenseDecision {
  const normalized = slugs.map(normalizeLicenseSlug).filter((slug) => slug.length > 0);
  if (normalized.length === 0) {
    return {
      verdict: "unverified",
      slugs: [],
      allowed: [],
      reason:
        "Fab published no licence for this listing, so the entitlement could not be verified. This importer fails closed rather than assume a permissive licence.",
    };
  }
  const allowed = normalized.filter((slug) => ALLOWED.has(slug));
  if (allowed.length > 0) {
    return {
      verdict: "allowed",
      slugs: normalized,
      allowed,
      reason: `Entitled under ${allowed.map((slug) => ALLOWED.get(slug)).join(" and ")}.`,
    };
  }
  const named = normalized.flatMap((slug) => {
    const match = KNOWN_REJECTED.find((entry) => entry.test.test(slug));
    return match ? [`${slug} (${match.label})`] : [];
  });
  return {
    verdict: "rejected",
    slugs: normalized,
    allowed: [],
    reason:
      named.length > 0
        ? `This listing is offered only under ${named.join(", ")}, which does not permit converting the asset for another engine's runtime.`
        : `This listing publishes only unrecognized licences (${normalized.join(", ")}). Only Fab Standard (Personal or Professional) and CC-BY are accepted.`,
  };
}
