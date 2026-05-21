import type { EditorView } from "@codemirror/view";

/**
 * Holds the EditorView currently mounted in the diff pane.
 * Used by global keybindings (n/p/Ctrl+F) to act on the visible diff.
 *
 * In side-by-side mode, this is the "b" (new content) side.
 * In unified mode, it's the single editor.
 */
let active: EditorView | null = null;

export function setActiveDiffView(view: EditorView | null): void {
  active = view;
}

export function getActiveDiffView(): EditorView | null {
  return active;
}
