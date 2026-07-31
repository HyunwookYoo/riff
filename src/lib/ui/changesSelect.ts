/// Pure selection algebra for the Changes list's Ctrl/Shift+click multi-select.
/// Deliberately free of Svelte, DOM and store imports: the component supplies
/// the on-screen row order and folds each click through `applyClick`, which
/// keeps the fiddly parts (range direction, anchor fallback, seeding from the
/// single selection) unit-testable.

/** Which modifier the user held: plain click, Ctrl/Cmd+click, Shift+click. */
export type ClickKind = "plain" | "toggle" | "range";

export interface SelectState {
  /** Selected paths. EMPTY means ordinary single-selection mode. */
  selected: Set<string>;
  /** Pivot for a range fill; null until a click sets one. */
  anchor: string | null;
}

/**
 * Fold one click into the multi-selection.
 *
 * `current` is the singly-selected path (the file the diff pane shows); it
 * seeds the set when the first Ctrl/Shift+click promotes single-selection into
 * a multi-selection. `order` is the on-screen row order — rows missing from it
 * (collapsed groups, conflicts) can never end up selected.
 */
export function applyClick(
  kind: ClickKind,
  state: SelectState,
  current: string | null,
  path: string,
  order: string[],
): SelectState {
  // A plain click is the way back to single selection.
  if (kind === "plain") return { selected: new Set(), anchor: path };

  if (kind === "toggle") {
    const base =
      state.selected.size > 0
        ? new Set(state.selected)
        : new Set(current ? [current] : []);
    if (base.has(path)) base.delete(path);
    else base.add(path);
    return { selected: base, anchor: path };
  }

  // range: fill from the pivot to the clicked row, in either direction. If
  // either end is off screen (its group was collapsed since the anchor was
  // set), select just the clicked row rather than guessing at a span.
  const pivot = state.anchor ?? current ?? path;
  const from = order.indexOf(pivot);
  const to = order.indexOf(path);
  if (from < 0 || to < 0) return { selected: new Set([path]), anchor: path };
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  return { selected: new Set(order.slice(lo, hi + 1)), anchor: pivot };
}

/**
 * Default stash subject when the message field is submitted empty: the path
 * itself for one file (so a single-file stash reads exactly as it did before),
 * a basename summary for several.
 */
export function defaultStashMessage(paths: string[]): string {
  if (paths.length === 1) return paths[0];
  const names = paths.slice(0, 3).map((p) => {
    const i = p.lastIndexOf("/");
    return i < 0 ? p : p.slice(i + 1);
  });
  const more = paths.length > 3 ? `, +${paths.length - 3} more` : "";
  return `${paths.length} files: ${names.join(", ")}${more}`;
}
