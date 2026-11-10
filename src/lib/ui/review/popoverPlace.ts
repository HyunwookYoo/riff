const MARGIN = 4;

/**
 * Top-left of a fixed popover of `size` for an anchor's client rect: below it, or above when it
 * would run off the bottom, kept `MARGIN` px inside the viewport.
 */
export function popoverPlace(
  anchor: { left: number; top: number; bottom: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { x: number; y: number } {
  const below = anchor.bottom + MARGIN;
  const y = below + size.height + MARGIN <= viewport.height ? below : Math.max(MARGIN, anchor.top - MARGIN - size.height);
  const x = Math.max(MARGIN, Math.min(anchor.left, viewport.width - size.width - MARGIN));
  return { x, y };
}
