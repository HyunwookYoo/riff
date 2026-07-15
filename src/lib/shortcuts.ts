/// Static catalog of the app's keyboard shortcuts, grouped for the in-app
/// cheat-sheet overlay (ShortcutsOverlay.svelte). This only DOCUMENTS the
/// bindings; the handlers themselves live in +page.svelte. Keep in sync when a
/// shortcut is added or changed there.
export interface Shortcut {
  keys: string;
  desc: string;
}
export interface ShortcutGroup {
  title: string;
  items: Shortcut[];
}

export const SHORTCUTS: ShortcutGroup[] = [
  {
    title: "General",
    items: [
      { keys: "Ctrl+Shift+P", desc: "Command palette" },
      { keys: "?", desc: "Keyboard shortcuts" },
      { keys: "Ctrl+Shift+W", desc: "Cycle mode (Changes → Branch → Blame)" },
      { keys: "Ctrl+B", desc: "Toggle refs sidebar" },
      { keys: "F5 / Ctrl+R", desc: "Refresh changes" },
      { keys: "Esc", desc: "Back / exit focus" },
    ],
  },
  {
    title: "Tabs",
    items: [
      { keys: "Ctrl+Tab / Ctrl+Shift+Tab", desc: "Next / previous tab" },
      { keys: "Ctrl+1…9", desc: "Jump to tab" },
    ],
  },
  {
    title: "Diff & files",
    items: [
      { keys: "Ctrl+F", desc: "Search in diff" },
      { keys: "Ctrl+G", desc: "Go to line" },
      { keys: "↑ / ↓", desc: "Previous / next file" },
      { keys: "n / p", desc: "Next / previous change" },
      { keys: "Ctrl +/-/0", desc: "Diff font size" },
      { keys: "Delete", desc: "Discard selected file (Working view)" },
    ],
  },
  {
    title: "Commit",
    items: [{ keys: "Ctrl+Enter", desc: "Commit" }],
  },
  {
    title: "Mouse",
    items: [{ keys: "Back / Forward", desc: "Drill back / forward" }],
  },
];
