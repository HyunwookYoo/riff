# Multi-select Stash — Design Spec

**Date:** 2026-07-30
**Track:** C (feature gaps + discoverability) of the Fork-parity VCS UX initiative
— direct follow-up to file-level stash (2026-07-21), which listed "Multi-file
selection stash" under *Out of scope / deferred* because "the Changes list is
single-selection today". This spec removes that limitation.

## Goal

Let a user select **several** working-tree files in the Changes list
(Ctrl/Shift+click) and stash them as one entry — without disturbing the changes
they did not select.

## Context

Everything below the UI already exists. `stash_save` takes a nullable pathspec
(`src-tauri/src/git/cli.rs:2173`), the `#[tauri::command]` wrapper threads
`Option<Vec<String>>` (`src-tauri/src/lib.rs:481`), the `stashSave` binding takes
`string[] | null` (`src/lib/git.ts:280`), and `doStashSave(message?, paths?)`
forwards it (`src/lib/sourceControl.ts:496`). `ChangesList.svelte:152` already
calls `doStashSave(m, [path])` for the single-file case.

**The only thing missing is a multi-selection in the UI.** riff has exactly one
selection concept, `appState.selectedFile` — a single `ChangedFile` that drives
the diff pane. `src-tauri` needs no change at all.

### Verified git behavior

Re-confirmed empirically on the bundled git (2.43.0.windows.1), this time with a
**mixed tracked + untracked multi-path** stash, which is the new case:

```
$ git status --porcelain          # before
 M a.txt
 M b.txt
?? new.txt
$ git stash push --include-untracked -m "riff: 3 files" -- a.txt new.txt
Saved working directory and index state On master: riff: 3 files
$ git status --porcelain          # b.txt is untouched
 M b.txt
$ git stash show --name-only stash@{0}
a.txt
new.txt
$ git stash pop -q && git status --porcelain   # exact restore
 M a.txt
 M b.txt
?? new.txt
```

A multi-entry pathspec captures exactly the named files — a modified tracked file
and an untracked file in the same stash — and leaves every other change alone.

### Decisions made during brainstorming

- **Interaction: Ctrl/Shift+click**, not row checkboxes. The row layout stays
  byte-identical to today; no new persistent visual element.
- **Actions: Stash *and* Move to changelist.** Once a multi-selection exists, a
  context menu that silently moves only one of three selected files is a
  surprise. Move is nearly free (`moveFileToChangelist` already exists) and
  keeping the menu consistent is the point. **Discard is excluded** — destructive,
  and a correct N-file confirmation has to explain the per-file
  new-file-deleted vs tracked-reverted split.
- **Mouse only.** No `Shift+↑/↓`, no `Ctrl+A`. `↑`/`↓` walk `appState.files`
  (git status order) while the list renders in changelist-group order
  (`+page.svelte:181` `moveSelection`); with 2+ changelists those orders diverge,
  so a keyboard range would visibly select non-adjacent rows. Fixing
  `moveSelection` to follow screen order would change `↑`/`↓` in Branch and Graph
  modes too — out of scope here. `Esc` clears the selection.

## Architecture / Approach

One new pure module holds the selection algebra; `ChangesList.svelte` wires DOM
events into it; the store gains one field so `Esc` (handled globally) can see it.

| Layer | Change |
|---|---|
| `src/lib/ui/changesSelect.ts` | **new** — pure selection reducer + default stash message |
| `src/lib/ui/changesSelect.test.ts` | **new** — vitest for the above |
| `src/lib/ui/ChangesList.svelte` | click handlers, `data-path`, action bar, selection-aware menu / stash form / drag |
| `src/lib/store.svelte.ts` | `changesSelectedPaths` (one field) |
| `src/lib/changelists.ts` | `moveFilesToChangelist(paths, targetId)` |
| `src/lib/sourceControl.ts` | reset the selection in `setChangesRepo` |
| `src/routes/+page.svelte` | `Esc` clears the selection |
| `src/lib/shortcuts.ts` | one cheat-sheet line (Mouse group) |
| `README.md`, `CHANGELOG.md` | docs |

`src-tauri` is untouched.

---

## 1. Selection state — one store field

`src/lib/store.svelte.ts`, next to `changesRepoIdx` (session-only, not persisted):

```ts
// Ad-hoc multi-selection in the Changes list, for bulk stash / move. EMPTY is
// the normal single-selection mode — only Ctrl/Shift+click populates it. That
// invariant keeps `selectedFile` (which drives the diff pane) unchanged, and
// keeps Esc from swallowing a drill-in pop when no multi-selection is active.
changesSelectedPaths = $state(new Set<string>());
```

The **empty-set-means-single-mode** invariant is load-bearing. It is why adding
`Esc → clear selection` ahead of the existing `Esc → popHistory` branch does not
regress drill-in navigation: after an ordinary click the set is empty, so the
`Esc` handler falls straight through to the existing behavior.

`anchor` (the Shift+click pivot) is component-local `$state` in
`ChangesList.svelte` — nothing outside the list needs it. It is only meaningful
while a selection is live: `onRowClick` passes `anchor` to `applyClick` only when
`changesSelectedPaths` is non-empty, otherwise `null`. That one condition covers
every way a selection can end (`Esc`, `Clear`, a repo switch, a stash) without
those call sites — two of which live outside the component — having to reach in
and reset it. After any clear, the next Shift+click pivots on the file the diff
pane is showing.

## 2. Click semantics

| Input | `changesSelectedPaths` | `selectedFile` | `anchor` |
|---|---|---|---|
| Click | cleared | clicked file | clicked file |
| Ctrl/Cmd+click | seed from `selectedFile` if empty, then toggle clicked file | clicked file | clicked file |
| Shift+click | `anchor`..clicked, inclusive (on-screen contiguous rows) | clicked file | unchanged |
| `Esc` / `[Clear]` | cleared | unchanged | — |

Every click also calls the existing `pick(path)`, so the diff pane always follows
the last-clicked row (matching Explorer/VS Code).

Shift+click replaces the range rather than unioning with it; `Ctrl+Shift+click`
(additive range) is not implemented.

Because a modifier-click is invisible until it is tried, the cheat-sheet catalog
in `src/lib/shortcuts.ts` gains one line in its existing **Mouse** group —
`Ctrl / Shift + Click` → *Multi-select files (Changes)*. That file only documents
bindings; the handlers stay in the component.

## 3. On-screen order comes from the DOM

Range fills need the row order *as rendered*. That order depends on collapsed
changelists (`collapsed`), collapsed directories (`collapsedDirs`), and
flat-vs-tree mode. Recomputing it in a `$derived` alongside the render logic
means two implementations of the same ordering that will drift.

Instead, each file row carries `data-path`, and the order is read from the
document:

```ts
let rootEl = $state<HTMLElement | null>(null);   // bind:this on .cl-root

function rowOrder(): string[] {
  return rootEl
    ? [...rootEl.querySelectorAll<HTMLElement>("[data-path]")].map((el) => el.dataset.path!)
    : [];
}
```

This is correct by construction — it *is* what is on screen. The component
already reads the DOM for drag targets (`ChangesList.svelte:170` `groupUnder`
uses `document.elementFromPoint(...).closest("[data-cl]")`), so this is an
established idiom in this file, not a new one.

**Conflict rows deliberately get no `data-path`.** `git stash` fails on unmerged
paths, so conflicted files must never enter a selection; omitting the attribute
excludes them from range fills automatically, and their rows keep no click
handler beyond `pick`.

## 4. Pure reducer + unit tests

`src/lib/ui/changesSelect.ts` — no Svelte, no DOM, no store:

```ts
export type ClickKind = "plain" | "toggle" | "range";
export interface SelectState {
  selected: Set<string>;
  anchor: string | null;
}

/**
 * Fold one click into the multi-selection.
 * `current` is the single-selected path, used to seed the set when the first
 * Ctrl/Shift+click promotes single-selection into a multi-selection.
 * `order` is the on-screen row order, used for range fills.
 */
export function applyClick(
  kind: ClickKind,
  state: SelectState,
  current: string | null,
  path: string,
  order: string[],
): SelectState;

/** Default stash subject: the path for one file, a summary for several. */
export function defaultStashMessage(paths: string[]): string;
```

Rules:

- **plain** → `{ selected: new Set(), anchor: path }` (back to single mode).
- **toggle** → base is `state.selected` when non-empty, else `{current}` when
  `current` is set, else empty; toggle `path` in it; `anchor = path`.
  Ctrl+clicking the only selected file therefore empties the set and returns to
  single mode.
- **range** → pivot is `state.anchor ?? current ?? path`. If the pivot or `path`
  is absent from `order` (e.g. the pivot's group was collapsed after the anchor
  was set), fall back to `{ selected: new Set([path]), anchor: path }`. Otherwise
  slice `order` between the two indices inclusive — in either direction — and
  keep the resolved pivot as the anchor.

`defaultStashMessage`: one path → that path (today's behavior, unchanged);
several → `"3 files: git.ts, store.ts, foo.ts"` using basenames, capped at three
with `", +N more"`.

`changesSelect.test.ts` covers: plain click clearing a multi-selection; toggle
seeding from `current`; toggle adding; toggle removing; toggle emptying the set;
forward range; backward range; range with no anchor falling back to `current`;
range with neither anchor nor `current`; range whose anchor left `order`; a range
that skips rows absent from `order` (the conflicts case); and both
`defaultStashMessage` branches including the `+N more` cap.

This matches riff's testing posture — pure functions get vitest, Svelte
components and git subprocess wrappers do not.

## 5. Staleness handled by derivation, not effects

After a successful stash the stashed files leave the working tree, and
`doStashSave`'s existing `refreshActiveView()` re-lists the Changes view. Rather
than pruning the set in an `$effect` (a second source of truth that can run
late), every read goes through a derived, pruned view:

```ts
const sel = $derived(
  new Set([...appState.changesSelectedPaths].filter((p) => byPath.has(p))),
);
```

`byPath` is the existing path→`StatusEntry` map (`ChangesList.svelte:26`), so a
path that is no longer changed simply cannot reach a git call.

That derived view is the safety net, not the whole story. The **store field must
be pruned too**, at the one point where reality changes — in `loadStatus`, right
after `appState.repoStatus = st` (and therefore after its stale-session guard):

```ts
const selectable = new Set(
  st.entries.filter((e) => !entryConflicted(e)).map((e) => e.path),
);
appState.changesSelectedPaths = new Set(
  [...appState.changesSelectedPaths].filter((p) => selectable.has(p)),
);
```

Without it the raw field keeps stale paths forever, and the global `Esc` handler
reads that raw field: stash the whole tree from the sidebar while two files are
multi-selected, and `Esc` would clear a selection nothing on screen shows —
swallowing the keypress instead of exiting Focus. The pruned `sel` hides the
symptom everywhere except there, which is exactly what made it worth fixing at
the source. Reassign a new `Set`; mutating in place does not trip Svelte 5
reactivity. Dropping conflicted entries in the same pass is what makes the
"a stash can never reach an unmerged path" guarantee below actually true.

Two explicit resets back this up: after submitting a stash, and in
`setChangesRepo` (`src/lib/sourceControl.ts:66`, alongside the `selectedFile` /
changelist resets already there).

## 6. Selection action bar

Rendered at the top of `.cl-root`, the same slot the inline stash form uses, and
only while `sel.size > 0`:

```
┌──────────────────────────────────┐
│ 3 selected   [Stash…]  [Clear]   │
└──────────────────────────────────┘
```

It appears at size 1 as well, not only at 2+: the set is non-empty **only** in
explicit multi-select mode, so the bar doubles as the mode indicator. A bar that
vanished at exactly one selected row while that row stayed highlighted would be
worse.

`[Stash…]` opens the stash form for `[...sel]`; `[Clear]` empties the selection.

Selected rows get `class:multi`, styled `background: var(--accent-soft)` plus an
`inset 2px 0 0 var(--accent)` left rail so the last-clicked row (which is both
`.active` and `.multi`) is still distinguishable from its siblings.

## 7. Context menu becomes selection-aware

`moveMenu` widens from `{ x, y, path }` to `{ x, y, paths: string[] }`.

`openMove(e, path)`, three cases:

- `path` **is** in `sel` → the menu targets the whole selection.
- `path` is **not** in `sel`, **and a selection is live** → clear the selection,
  `pick(path)`, and target just that file (Explorer behavior: right-clicking
  outside a selection re-selects).
- **no selection at all** → the menu targets the clicked row and touches nothing
  else.

The third case is what keeps the ordinary right-click a pure peek. `pick` moves
the diff pane, and the menu's only dismiss path (`onclick` on the window) cannot
undo it — so re-selecting unconditionally would mean right-clicking a file and
pressing Escape leaves the diff pane somewhere the user never chose. That is a
change to single-file behavior, which this feature does not get to make.

Labels follow the count: the head reads `Move to changelist` for one file and
`Move 3 files to` for several; the stash item reads `Stash this file…` or
`Stash 3 files…`. A changelist entry is disabled only when **every** targeted
file already lives in it.

`moveTo` calls the new `moveFilesToChangelist(paths, targetId)` in
`src/lib/changelists.ts`. The existing `moveFileToChangelist` calls `persist()`
(a backend write) per file, so looping it N times would issue N writes; the new
function does one `map` over the changelists and one `persist()`, and the
single-file function delegates to it. The selection **survives** a move — the
common next step is to stash what was just regrouped.

## 8. Drag interaction

`onFilePointerDown` (`ChangesList.svelte:174`) starts a potential
drag-to-changelist on any left-button press. Two changes:

- Bail out when a selection modifier is held —
  `if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;` — the
  user is selecting, not dragging.
- Dragging a **selected** row drags the whole selection: `dragPath: string | null`
  becomes `dragPaths: string[] | null`, the drop calls
  `moveFilesToChangelist(dragPaths, target)`, and the ghost label reads
  `3 files` for a multi-drag (basename as today for one). Dragging an
  **unselected** row drags only that row and leaves the selection untouched —
  unlike a right-click (§7), a drag has no menu in which the mismatch could
  mislead, and silently discarding a selection mid-drag would be worse.

Leaving drag single-file while the context menu moves N would be the same
inconsistency §7 exists to avoid.

## 9. Stash form for N files

`stashingPath: string | null` becomes `stashTargets: string[] | null`. **With one
target, every string and behavior is identical to today.** Only the multi case
branches:

- Label: `Stash 3 files:` instead of `Stash <path>:`.
- Placeholder and Escape-to-cancel are unchanged.
- Empty submit falls back to `defaultStashMessage(paths)` (§4).
- Submit calls `doStashSave(m, paths)` — already variadic — then clears
  `stashTargets`, `stashMsg`, and the selection.

## 10. Escape

In `src/routes/+page.svelte`, first branch inside the existing
`if (e.key === "Escape" && !e.defaultPrevented)` block (`+page.svelte:325`):

```js
if (appState.appMode === "changes" && appState.changesSelectedPaths.size > 0) {
  appState.changesSelectedPaths = new Set();
  e.preventDefault();
  return;
}
```

The handler already yields to form controls (`+page.svelte:278`), so Escape
inside the stash message input still cancels that input via its own `onkeydown`
and never reaches here.

## Edge cases / notes

- **A file split across changelists is stashed whole.** The `k/n` hunk badge
  reflects changelist assignment; the pathspec captures all of that file's
  working-tree changes. Same agreed limitation as file-level stash.
- **Selections may span changelists.** Harmless: a stash is one entry regardless,
  and a multi-file move into one target list is well-defined.
- **Single-repo by construction.** The Changes screen operates on one repo
  (`changesRepoIdx`), so a selection can never mix paths from a submodule and its
  parent.
- **Conflicted files are unselectable** (§3) — they carry no `data-path`, so a
  click can never put one in the selection. A file that *becomes* conflicted
  while already selected (select files → merge or rebase from Graph → back to
  Changes) is dropped by §5's `loadStatus` prune. Between the two, a stash can
  never reach an unmerged path.
- **`↑`/`↓` do not collapse a live multi-selection.** `moveSelection` is
  deliberately untouched, so the arrows move `selectedFile` — and therefore the
  `.active` row — without clearing the highlighted set; the `.active` row can
  walk outside it. That follows from the mouse-only scope. Explorer would
  collapse the selection instead.
- **Failed stash / move** surfaces through the existing `appState.error` banner;
  no new error path.
- Shift+click cannot select page text: `.cl-pick` already sets
  `user-select: none` (`ChangesList.svelte:760`).

## Out of scope / deferred

- **Keyboard multi-select** (`Shift+↑/↓`, `Ctrl+A`) — blocked on making
  `moveSelection` follow screen order, which would change `↑`/`↓` in Branch and
  Graph modes.
- **Multi-file discard** — destructive; needs its own confirmation design.
- **Hunk-level stash** — still needs `git stash --patch` or a synthesized patch.
- **Changelist-level stash** ("stash this whole changelist" from the group
  header) — reachable now via select-all-in-group, but no dedicated button.
- **Row checkboxes** — considered and rejected during brainstorming.
- **Multi-select anywhere else** (Branch-mode `FileList`, commit detail) — those
  are review-only views with no file actions.

## Testing

- **Unit (`npm test`):** `changesSelect.test.ts` per §4. The reducer holds all
  the non-obvious logic (range direction, anchor fallback, seed-from-single), so
  this is where correctness is pinned.
- **Gates (must stay green):** `npm test`, `npm run check` (0 errors; the one
  pre-existing benign `@types/node` warning is allowed). `cargo check` is
  unaffected — `src-tauri` is untouched — but should still pass.
- **Manual E2E (merge gate)**, dogfooded on `C:\workspace\sandbox`:
  - Ctrl+click three modified files → bar reads `3 selected` → **Stash…** →
    Enter → exactly those three leave the working tree, **every other change
    stays**, and one new stash entry appears in the sidebar. **Pop** restores all
    three.
  - Submit the message field empty → the stash subject is
    `3 files: <a>, <b>, <c>`.
  - Include an **untracked** file in the selection → it is stashed too.
  - Shift+click a range in **tree** view with a directory collapsed → only
    visible rows are selected. Repeat in **flat** view.
  - Shift+click a range that spans two changelists → the conflicts group (if
    present) is skipped.
  - Right-click a selected row → `Move 3 files to` → all three move together;
    right-click an **unselected** row → selection clears and only that file is
    targeted.
  - Drag a selected row onto another changelist → all selected files move; ghost
    reads `3 files`.
  - `Esc` clears the selection; `Esc` again performs the pre-existing drill-in
    pop / focus exit.
  - **Regressions:** plain click, single-file right-click → Move / Stash this
    file…, single-file drag, sidebar `＋` whole-tree stash, and palette
    "Stash: save changes" all behave exactly as before.

## Success criteria

- Several working-tree files can be selected with Ctrl/Shift+click and stashed as
  one entry, named or summary-defaulted, leaving unselected changes untouched.
- The context menu and drag-to-changelist act on the whole selection.
- Single-selection behavior — click, diff pane, `↑`/`↓`, single-file stash and
  move, whole-tree stash — is unchanged.
- `npm test` and `npm run check` are clean; the manual E2E checklist passes.
