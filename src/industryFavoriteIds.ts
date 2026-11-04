/** Stable directory identifiers only; favorites never accept links or user records. */
export const industryFavoriteIds = ['teaching', 'product_creative', 'image_edit', 'review_reply'] as const;
export type IndustryFavoriteId = typeof industryFavoriteIds[number];
export function isIndustryFavoriteId(value: unknown): value is IndustryFavoriteId {
  return typeof value === 'string' && (industryFavoriteIds as readonly string[]).includes(value);
}
