# Discoverability Pass — Design Spec

**Date:** 2026-07-15
**Track:** C (feature gaps + discoverability) of the Fork-parity VCS UX initiative — first sub-project.

## Goal

Surface capabilities riff **already has** but that users cannot find, plus one
cheap safety alias. No new git capability is added; this pass is about making
existing power reachable. Scope is the **Lean** tier agreed with the user:
frontend-only, no prompt dialogs, no refactor of existing context-menu
handlers.

## Context

An inventory of riff's VCS surface found that the biggest part of the "missing
features" complaint is actually **discoverability**, not absence:

- The **command palette is fully built** (`CommandPalette.svelte`,
  `commands.ts`) but opens **only** via the `Ctrl/Cmd+Shift+P` chord — no
  button, icon, or menu anywhere reveals it.
- **Amend** is implemented end-to-end in the backend and lib
  (`commit --amend`, `loadAmendMessage()`, `appState.commitAmend`) but **no UI
  control calls it** — the commit box always commits `amend=false`.
- ~15 keyboard shortcuts exist but are **almost undocumented in-app**.

riff replaces git's staged/unstaged index with a JetBrains-style **changelists**
model (`ChangesList.svelte`, `commitChangelist`). This is deliberate identity,
**not** a gap — this pass does not reintroduce a stage/unstage list. Amend must
be adapted to the changelist commit path (see §2).

## Architecture / Approach

Four small, mostly-independent changes. No backend (`src-tauri`) changes. All
work is in `src/lib` and `src/routes/+page.svelte`.

| # | Change | Primary files |
|---|--------|---------------|
| 1 | Command-palette entry point (button + hint) | `InputBar.svelte` |
| 2 | Amend toggle in the commit box | `CommitBox.svelte`, `changelists.ts` |
| 3 | Keyboard cheat-sheet overlay | new `ShortcutsOverlay.svelte`, `+page.svelte`, `store.svelte.ts`, new `shortcuts.ts` |
| 4 | Two new palette commands (Undo last commit, Keyboard shortcuts) | `commands.ts`, `sourceControl.ts` |

---

## 1. Command-palette entry point

**Exists:** palette UI + `buildCommands()`; toggled at `+page.svelte:200-208`
via `appState.paletteOpen`.

**Add:** a visible affordance in the top `mode-bar` (`InputBar.svelte`, the
`<div class="mode-bar">` that already holds RepoChip / mode-toggle / BranchChip
/ SyncControls / `mode-hint`):

- A small **command-palette button** (label e.g. `⌘ Commands` or a search
  glyph) that sets `appState.paletteOpen = true`. Tooltip shows the chord
  (`Ctrl+Shift+P`).
- A small **`?` button** next to it that opens the shortcuts overlay
  (`appState.shortcutsOpen = true`) — the cheat sheet is otherwise as hidden as
  the palette was.
- Keep the existing `Ctrl+Shift+P` chord (already wired) and the
  `Ctrl+Shift+W to cycle` hint.

No behavior change to the palette itself. Placement/styling detail is left to
the plan; buttons reuse the existing `.bar button` styling idiom.

---

## 2. Amend toggle in the commit box

**Exists:** `appState.commitAmend` (`store.svelte.ts:277`),
`loadAmendMessage()` (`sourceControl.ts:568`, splits HEAD message into
subject/body), backend `commit(path, subject, body, amend, signoff, coauthors)`
(`git.ts:467`) with a working `--amend`. **The only gap is UI + routing the
flag through the changelist commit path.**

**The wrinkle:** the commit box commits via `commitChangelist(id)`
(`changelists.ts:243`), which hardcodes `amend=false` in both its whole-file
(`commitPaths`) and hunk-split (`stage`→`commit`) branches. `commitPaths` is
path-scoped and has no amend variant.

### Amend semantics (decided)

**Amend = fold the active changelist's content into the previous commit AND set
its message to the box.** Other changelists are untouched. If the active
changelist is empty, it is a **message-only reword** of HEAD.

This is implemented **without backend changes** by reusing the proven
`unstage → stage → commit` sequence (already used by the hunk-split branch),
passing `amend=true`:

```
// in commitChangelist, when amend is on:
await unstage(repo, null);            // index := HEAD
if (whole.length) await stage(repo, whole);
for (const f of partial) { …applyHunks(repo, f.path, false, idx)… }
await commit(repo, subject, body, /*amend*/ true, signoff, coauthors);
```

Because the index is reset to HEAD and then only the changelist's content is
staged, `commit --amend` produces `HEAD^ + (HEAD tree + changelist content)` —
i.e. the previous commit with this changelist's changes added and the message
replaced. Correct and consistent with how non-amend path-scoped commits leave
other changelists alone.

### UI

- Add an **"Amend last commit"** checkbox to `CommitBox.svelte`'s `.opts` row
  (next to "Sign-off"), bound to `appState.commitAmend`.
- Toggling **ON** calls `loadAmendMessage()` to pre-fill the box with HEAD's
  message (overwrites current box text — deliberate, matches Fork). Toggling
  **OFF** clears subject/body (they belonged to the amend, not a new commit).
- The commit button label becomes **"Amend …"** when the toggle is on.
- `canCommit` gate changes from `subjectLen>0 && activeCount>0` to
  `subjectLen>0 && (activeCount>0 || appState.commitAmend)` so a message-only
  reword is possible.
- `commitChangelist` must (a) read `appState.commitAmend` directly — **no
  signature change** (it already reads `commitSubject`/`commitBody`/
  `commitSignoff` from `appState` the same way), (b) not early-return on
  `files.length===0` when amending, (c) take the amend branch above, and
  (d) reset `appState.commitAmend=false` on success alongside the existing
  subject/body/coauthors clear.

### Edge cases / notes

- **Unborn branch (no HEAD):** `loadAmendMessage()` already no-ops on failure;
  amending with no HEAD is not offered meaningfully. Low priority — if the
  toggle is on with no commits, the commit will fail and surface in the error
  banner (acceptable v1; a subtle disable is optional polish).
- **Amending a pushed commit:** no warning in v1 (Fork warns). Deferred polish;
  the ahead/behind data exists in `repoStatus` if we add it later.
- Toggling ON clobbers typed text; toggling ON/OFF/ON loses the original draft.
  Accepted minor for v1 (amend toggling is a deliberate action).

---

## 3. Keyboard cheat-sheet overlay

**Exists:** ~15 shortcuts handled in `+page.svelte:onKeyDown` /`onMouseDown`,
but only 3 have any in-app hint.

**Add:**

- `src/lib/shortcuts.ts` — a **pure static data module** exporting the shortcut
  list grouped by category, single source of truth for the overlay:
  ```ts
  export interface Shortcut { keys: string; desc: string }
  export interface ShortcutGroup { title: string; items: Shortcut[] }
  export const SHORTCUTS: ShortcutGroup[] = [ … ];
  ```
- `src/lib/ui/ShortcutsOverlay.svelte` — a modal (same backdrop/dialog idiom as
  `CommandPalette.svelte`) that renders `SHORTCUTS` grouped, closes on `Esc`,
  backdrop click, or `?`. Gated on `appState.shortcutsOpen`.
- `store.svelte.ts` — add `shortcutsOpen = $state(false)`.
- `+page.svelte`:
  - Render `<ShortcutsOverlay />` (next to `<CommandPalette />`).
  - In `onKeyDown`, after the form-control yield (so `?` typed in an input is
    untouched), handle `e.key === "?"` → `appState.shortcutsOpen = true`.
  - Include `appState.shortcutsOpen` in the modal-suppression guard alongside
    `checkoutPrompt`/`paletteOpen` (so global shortcuts are inert while the
    cheat sheet is open; it owns its own `Esc`).

### Shortcut inventory to document (grouped)

- **General:** `Ctrl+Shift+P` Command palette · `?` Keyboard shortcuts ·
  `Ctrl+Shift+W` Cycle mode (Changes → Compare → Blame) · `Ctrl+B` Toggle refs
  sidebar · `F5` / `Ctrl+R` Refresh · `Esc` Back / exit focus
- **Tabs (compare + tabs layout):** `Ctrl+Tab` / `Ctrl+Shift+Tab` Next/prev tab
  · `Ctrl+1…9` Jump to tab
- **Diff / file:** `Ctrl+F` Search in diff · `Ctrl+G` Go to line · `↑` / `↓`
  Previous/next file · `n` / `p` Next/previous change · `Ctrl` `+` / `-` / `0`
  Font size · `Delete` Discard selected file (Working view)
- **Commit box:** `Ctrl+Enter` Commit
- **Mouse:** Back / Forward buttons (X1/X2) drill back / forward

(Exact copy finalized in the plan; the list above is the binding content.)

---

## 4. Two new palette commands

Add to `buildCommands()` (`commands.ts`), keeping existing context menus
untouched:

- **"Undo last commit"** (category e.g. `Commit`) — a soft reset that keeps all
  changes in the working tree. Backed by a new helper in `sourceControl.ts`:
  ```ts
  export async function undoLastCommit(): Promise<void> {
    if (!confirm("Undo the last commit? Its changes stay in your working tree."))
      return;
    try {
      await reset(changesRepoPath(), "HEAD~1", "soft");
      invalidateGraph();
    } catch (e) { appState.error = String(e); }
    finally { await loadStatus(); }
  }
  ```
  Uses native `confirm()` (matches the existing hard-reset confirm in
  `CommitList.svelte:279`). `reset(path, "HEAD~1", "soft")` — `target` is a rev
  string, so `HEAD~1` is valid.
- **"Keyboard shortcuts"** (category e.g. `Help`) — sets
  `appState.shortcutsOpen = true`.

**Explicitly out of Lean scope (stays in the graph right-click):** cherry-pick,
revert, reset-to-a-specific-commit, rebase-onto, tag-here — these need a
**target commit**, which a global palette has no natural way to supply. Moving
them into the palette is a Full-tier concern and is deferred.

---

## Out of scope / deferred

- **Full palette tier:** per-branch "Merge into current", current-branch
  Rename / Set upstream / New branch, Delete branch, Tag HEAD — need prompt
  dialogs + shared branch-action extraction from `RefsSidebar`. Deferred.
- Contextual commit ops in the palette (see §4).
- Amend-of-pushed warning; disabling amend on an unborn branch.
- The other Track C sub-projects (repo lifecycle + remotes, interactive rebase,
  tags/stash/reflog polish).

## Testing

This pass is overwhelmingly UI wiring; consistent with the Track B posture:

- **Pure/unit (vitest):** `shortcuts.ts` is static data — a trivial shape/
  non-empty test is the only genuinely unit-testable unit. Optionally a test
  for the amend subject/body split if that logic is extracted; it currently
  lives in `loadAmendMessage` (git-touching) so it is covered by manual E2E
  instead.
- **`npm run check`** (svelte-check) must stay at 0 errors (1 pre-existing
  benign `@types/node` warning allowed).
- **Manual E2E (merge gate):** palette opens from the new button; `?` and the
  `?` button open the overlay and it lists the shortcuts; Amend toggle
  pre-fills HEAD's message, amends content + message, and reword-only works with
  an empty changelist; "Undo last commit" soft-resets and leaves changes in the
  working tree.

## Success criteria

- A user who never learned the `Ctrl+Shift+P` chord can open the palette and
  the shortcuts overlay from visible buttons.
- Amend is reachable from the commit box and correctly amends HEAD (content +
  message, or message-only).
- `Undo last commit` and `Keyboard shortcuts` appear in the palette.
- `npm run check` clean; manual E2E checklist passes.
