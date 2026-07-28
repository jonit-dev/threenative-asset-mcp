/**
 * Sanitized, synthetic fixtures shaped from the public Fab contracts observed
 * on 2026-07-28. They contain no cookies, request headers, account data, or
 * tracking fields.
 */
export const searchFixture = {
  results: [
    {
      uid: "8a8981c4-bb94-4184-84b7-6c70d7c75ef1",
      title: "Forest Environment",
      seller: {
        uid: "seller-forest-studio",
        name: "Forest Studio",
      },
      listingType: "3d-model",
      categories: [{ name: "Environments", slug: "environments" }],
      assetFormats: ["fbx", "unreal-engine"],
      tags: [
        { name: "Forest", slug: "forest" },
        { name: "Nature", slug: "nature" },
      ],
      thumbnail: {
        url: "https://media.fab.com/sanitized/forest-thumbnail.webp",
      },
      rating: { average: 4.8, count: 12 },
      licenses: [
        {
          slug: "personal",
          name: "Personal",
          price: { amount: 0, currency: "USD" },
        },
        {
          slug: "professional",
          name: "Professional",
          price: { amount: 49.99, currency: "USD" },
        },
      ],
      startingPrice: { amount: 0, currency: "USD" },
      isAiGenerated: false,
      isAiForbidden: false,
      isMature: false,
      firstPublishedAt: "2026-06-01T12:00:00Z",
      publishedAt: "2026-07-01T12:00:00Z",
    },
    {
      uid: "11111111-2222-4333-8444-555555555555",
      title: "Pine Tree Collection",
      seller: { name: "Example Publisher" },
      assetFormats: ["gltf"],
      startingPrice: {
        amount: 10,
        effectiveAmount: 0,
        currency: "USD",
      },
    },
  ],
  cursors: {
    next: "opaque-next-cursor-value",
    previous: null,
  },
} as const;

export const detailFixture = {
  uid: "8a8981c4-bb94-4184-84b7-6c70d7c75ef1",
  title: "Forest Environment",
  description: "A sanitized public listing description.",
  seller: { uid: "seller-forest-studio", name: "Forest Studio" },
  categories: [{ name: "Environments", slug: "environments" }],
  tags: [{ name: "Forest", slug: "forest" }],
  assetFormats: ["fbx", "unreal-engine"],
  media: [
    {
      type: "image",
      url: "https://media.fab.com/sanitized/forest-preview.webp",
    },
  ],
  licenses: [
    {
      slug: "personal",
      name: "Personal",
      offerId: "offer-personal-sanitized",
      price: { amount: 0, currency: "USD" },
    },
    {
      slug: "professional",
      name: "Professional",
      offerId: "offer-professional-sanitized",
      price: { amount: 49.99, currency: "USD" },
      discountedPrice: { amount: 39.99, currency: "USD" },
    },
  ],
  compatibleApps: [{ name: "Unreal Engine", version: "5.4" }],
  firstPublishedAt: "2026-06-01T12:00:00Z",
  publishedAt: "2026-07-01T12:00:00Z",
  isAiGenerated: false,
  isAiForbidden: false,
  isMature: false,
} as const;

export const taxonomyFixture = {
  channels: [
    { label: "Unreal Engine", slug: "unreal-engine" },
    { label: "Unity", slug: "unity" },
  ],
  listing_types: [{ label: "3D Model", slug: "3d-model" }],
  formats: [
    { label: "FBX", slug: "fbx" },
    { label: "glTF", slug: "gltf" },
  ],
  categories: [{ label: "Environments", slug: "environments" }],
  licenses: [
    { label: "Personal", slug: "personal" },
    { label: "Professional", slug: "professional" },
  ],
} as const;

export const limitedTimeFreeFixture = {
  results: [
    {
      uid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      title: "Curated Promotional Asset",
      promotionEndsAt: "2026-08-04T15:00:00Z",
    },
  ],
} as const;
