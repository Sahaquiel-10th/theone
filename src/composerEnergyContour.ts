const KAPPA = 0.5522847498307936;
const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;
const coordinates = (...values: number[]) => values.map(value => Number(value.toPrecision(12)).toString()).join(' ');

/** One outline for the selected-feature header and its composer. headerWidth is
 * the content's right edge, before the extra 40px shoulder; headerHeight is the
 * input area's top in container coordinates. No seam is drawn between them. */
export function composerEnergyContour({ width, height, headerWidth, headerHeight, radius = 22 }: {
  width: number;
  height: number;
  headerWidth: number;
  headerHeight: number;
  radius?: number;
}): string {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return '';

  // Keep even a sub-pixel container's outline inside its own dimensions.
  const inset = Math.min(1, width / 4, height / 4);
  const left = inset, top = inset, right = width - inset, bottom = height - inset;
  const corner = Math.min(Math.max(0, finite(radius, 22)), (right - left) / 2, (bottom - top) / 2);
  const n = coordinates;

  function roundedRectangle() {
    return [
      `M ${n(left + corner, top)}`, `L ${n(right - corner, top)}`,
      `C ${n(right - corner + corner * KAPPA, top, right, top + corner - corner * KAPPA, right, top + corner)}`,
      `L ${n(right, bottom - corner)}`,
      `C ${n(right, bottom - corner + corner * KAPPA, right - corner + corner * KAPPA, bottom, right - corner, bottom)}`,
      `L ${n(left + corner, bottom)}`,
      `C ${n(left + corner - corner * KAPPA, bottom, left, bottom - corner + corner * KAPPA, left, bottom - corner)}`,
      `L ${n(left, top + corner)}`,
      `C ${n(left, top + corner - corner * KAPPA, left + corner - corner * KAPPA, top, left + corner, top)}`, 'Z',
    ].join(' ');
  }

  const contentRight = finite(headerWidth, 0), inputTop = finite(headerHeight, 0);
  if (contentRight <= 0 || inputTop <= top || inputTop >= bottom) return roundedRectangle();

  // Reserve the largest possible right corner first. The shoulder can never
  // cross it, including when an unusually tall header leaves a shallow input.
  const shoulderStart = Math.max(left + corner, Math.min(contentRight, right - corner));
  const available = right - corner - shoulderStart;
  if (available <= 0) return roundedRectangle();
  const span = Math.min(40, available);
  const fraction = span / 40;
  const blend = fraction * fraction * (3 - 2 * fraction);
  // A nearly full-width header raises the small remaining notch continuously
  // into the top edge rather than squeezing in a self-intersecting S curve.
  const rowTop = top + (inputTop - top) * blend;
  const rowCorner = Math.min(corner, (bottom - rowTop) / 2);
  const shoulderEnd = shoulderStart + span;
  return [
    `M ${n(left + corner, top)}`, `L ${n(shoulderStart, top)}`,
    `C ${n(shoulderStart + span * .62, top, shoulderEnd - span * .62, rowTop, shoulderEnd, rowTop)}`,
    `L ${n(right - rowCorner, rowTop)}`,
    `C ${n(right - rowCorner + rowCorner * KAPPA, rowTop, right, rowTop + rowCorner - rowCorner * KAPPA, right, rowTop + rowCorner)}`,
    `L ${n(right, bottom - rowCorner)}`,
    `C ${n(right, bottom - rowCorner + rowCorner * KAPPA, right - rowCorner + rowCorner * KAPPA, bottom, right - rowCorner, bottom)}`,
    `L ${n(left + rowCorner, bottom)}`,
    `C ${n(left + rowCorner - rowCorner * KAPPA, bottom, left, bottom - rowCorner + rowCorner * KAPPA, left, bottom - rowCorner)}`,
    `L ${n(left, top + corner)}`,
    `C ${n(left, top + corner - corner * KAPPA, left + corner - corner * KAPPA, top, left + corner, top)}`, 'Z',
  ].join(' ');
}
