import type { EditorView } from "@codemirror/view";

/**
 * Holds the EditorView currently mounted in the diff pane.
 * Used by global keybindings (n/p/Ctrl+F) to act on the visible diff.
 *
 * In side-by-side mode, this is the "b" (new content) side.
 * In unified mode, it's the single editor.
 */
let active: EditorView | null = null;
// The mounted DiffView's change navigation, shared by its ◀ ▶ buttons and n/p.
let step: ((dir: 1 | -1) => void) | null = null;

export function setActiveDiffView(
  view: EditorView | null,
  stepper: ((dir: 1 | -1) => void) | null = null,
): void {
  active = view;
  step = view ? stepper : null;
}

export function getActiveDiffView(): EditorView | null {
  return active;
}

/** Step the visible diff to its previous/next change; false when none is mounted. */
export function stepActiveDiff(dir: 1 | -1): boolean {
  if (!step) return false;
  step(dir);
  return true;
}
