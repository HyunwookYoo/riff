# Stashes Panel — Design Spec

**Date:** 2026-07-22
**Track:** C (feature gaps + discoverability) of the Fork-parity VCS UX initiative — fifth sub-project.

## Goal

Give stashes a dedicated, command-palette-opened panel, so the stash list is
reachable regardless of how many branches fill the sidebar.

## Context

riff already lists stashes in the refs sidebar's Stashes section (per-stash
Pop / Apply / Drop, plus an inline-named save). The problem the user hit: that
section sits **below** the branch list, so in a repo with many branches the
stash list is pushed off-screen and is awkward to reach. The command palette is
the natural always-available entry point (it already exists and now hosts the
reflog panel).

Everything the panel needs already exists:

- `appState.stashes` — `Stash[]` (`{ index: number; message: string }`), kept
  current by `loadStashes()` (called across the source-control flows).
- `doStashApply(index, pop)` — Pop (`pop = true`) or Apply (`pop = false`).
- `doStashDrop(index)` — Drop.
- `doStashSave(message?, paths?)` — save (whole tree when `paths` is omitted).

So this is a **frontend-only** feature: a new modal that reads `appState.stashes`
and calls those helpers, plus a palette command to open it. **No new backend.**

### Decisions made during brainstorming

- **Tier: Lean.** List + per-row Pop / Apply / Drop + an inline "save new stash".
  No stash-content preview (that would need a new `git stash show` backend and is
  deferred).
- **The sidebar Stashes section stays as-is.** The panel is an additional access
  route, not a replacement; `RefsSidebar.svelte` is not touched. (Redundant entry
  points are accepted in exchange for keeping the at-a-glance sidebar count and a
  minimal, safe change.)
- **Palette cleanup:** the scattered per-stash `stash.pop.<n>` / `stash.drop.<n>`
  entries are removed (the panel replaces them); a single "View stashes" command
  replaces them.

## Architecture / Approach

One new modal component plus small edits to four existing files, all mirroring
the just-shipped reflog panel. The reflog panel (`ReflogOverlay.svelte`, opened
by a `commands.ts` entry that sets `appState.reflogOpen`, rendered in
`+page.svelte`, guarded in the modal-suppression block) is the exact template.

| File | Change |
|---|---|
| `src/lib/ui/StashesOverlay.svelte` | **create** — the modal |
| `src/lib/store.svelte.ts` | add `stashesOpen` session flag |
| `src/lib/commands.ts` | add "View stashes"; remove the per-stash pop/drop loop |
| `src/routes/+page.svelte` | render the overlay; add `stashesOpen` to the modal guard |
| `src/lib/shortcuts.ts` | one cheat-sheet line |

## 1. `StashesOverlay.svelte` (new)

Structurally a copy of `ReflogOverlay.svelte` / `ShortcutsOverlay.svelte`:

- A fixed `.backdrop` at `z-index: 2100` whose click closes; an inner
  `role="dialog"` with `aria-modal`, `tabindex="-1"`, and `bind:this`, focused on
  open via `queueMicrotask` guarded by a non-reactive `wasOpen`; `onkeydown` that
  `preventDefault` + `stopPropagation` on Escape and closes; and
  `onclick={(e) => e.stopPropagation()}` on the dialog.
- Gated on `appState.stashesOpen`; `close()` sets it false.
- **On open**, call `loadStashes()` so the list is fresh (mirrors how the reflog
  panel loads on open). The list itself renders from `appState.stashes`, which is
  reactive — so Pop/Drop update it live.
- **Rows:** for each `s of appState.stashes` (keyed by `s.index`), show
  `s.message` and three buttons:
  - **Pop** → `doStashApply(s.index, true)`
  - **Apply** → `doStashApply(s.index, false)`
  - **Drop** (danger styling) → `doStashDrop(s.index)`
  These helpers already refresh `appState.stashes` via `loadStashes()`, so the
  panel updates in place; it stays open for consecutive actions.
- **Empty state:** "No stashes".
- **Save-new row:** an inline message field (reusing the named-stash inline-input
  idiom) whose submit calls `doStashSave(msg.trim() || undefined)` — a whole-tree
  stash, named if a message was typed, unnamed (git default) if empty. Enter
  submits, Escape clears the field (not the panel).

Note the actions are fire-and-forget (`void doStash…()`); each helper routes its
own errors to `appState.error`, exactly as the sidebar buttons already call them.

## 2. Store flag

`src/lib/store.svelte.ts`: add `stashesOpen = $state(false);` next to
`reflogOpen`. Session-only.

## 3. Palette command + cleanup

`src/lib/commands.ts`, in the Stash block that currently pushes `stash.save` and
then loops per-stash `stash.pop.<index>` / `stash.drop.<index>`:

- **Add** `{ id: "stash.view", title: "View stashes", category: "Stash",
  run: () => { appState.stashesOpen = true; } }`.
- **Remove** the `for (const s of appState.stashes) { … pop … drop … }` loop —
  the panel supersedes those scattered entries.
- **Keep** `stash.save` (a quick whole-tree save from the palette).

## 4. Render + guard + cheat sheet

- `src/routes/+page.svelte`: render `<StashesOverlay />` next to
  `<ReflogOverlay />`; add `appState.stashesOpen` to the modal-suppression guard
  alongside `checkoutPrompt` / `paletteOpen` / `shortcutsOpen` / `reflogOpen`
  (the overlay owns its own Esc).
- `src/lib/shortcuts.ts`: add one line to the existing **Commit** group (where
  the reflog palette entry already lives, clustering palette-reachable actions) —
  `{ keys: "Ctrl+Shift+P", desc: "View stashes (via palette)" }` — keeping it a
  well-formed `{ keys, desc }` so `shortcuts.test.ts` stays green.

## Out of scope / deferred

- **Stash-content preview** (`git stash show -p` — file list or diff per stash).
  Needs a new backend command; deferred.
- **Stash → branch** (`git stash branch`).
- **Removing the sidebar Stashes section** — kept as-is by decision.
- **A dedicated toolbar button** to open the panel — the palette command (and the
  cheat-sheet line) are enough; a visible button is deferred.
- The other Track C sub-projects (repo lifecycle + remotes, interactive rebase,
  Full palette tier).

## Testing

Consistent with riff's posture (git operations and Svelte UI are not
unit-tested; only pure functions get vitest):

- **No new unit tests** — the panel is UI wiring over existing, already-exercised
  helpers. `src/lib/shortcuts.test.ts` must stay green; the new cheat-sheet line
  must be a valid `{ keys, desc }` entry in a non-empty group.
- **Gates (must stay green):** `npm test`, `npm run check` (0 errors; the one
  pre-existing benign `@types/node` warning is allowed). No Rust change, so
  `cargo check` is unaffected (still fine to run).
- **Manual E2E (merge gate):**
  - The palette "View stashes" command opens the panel; it lists the current
    stashes (and shows "No stashes" when empty).
  - Pop applies-and-removes (row disappears); Apply keeps the stash; Drop removes
    it — and the list updates live in the open panel.
  - The save-new field creates a whole-tree stash (named or, when empty, git's
    default), and it appears in the list.
  - The sidebar Stashes section is unchanged and still works.
  - The palette no longer shows per-stash `pop`/`drop` rows; `stash.save` still
    works.

## Success criteria

- A user can open a stash list from the command palette and Pop/Apply/Drop/save
  from it, without scrolling past the branch list.
- The sidebar stash section and whole-tree stash save are unchanged.
- The palette is de-cluttered (one "View stashes" instead of N scattered rows).
- `npm run check` and `npm test` are clean; the manual E2E checklist passes.
