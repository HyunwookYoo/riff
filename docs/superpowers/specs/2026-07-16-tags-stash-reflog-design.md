# Tags · Stash · Reflog — Design Spec

**Date:** 2026-07-16
**Track:** C (feature gaps + discoverability) of the Fork-parity VCS UX initiative — third sub-project (after the discoverability pass).

## Goal

Close the remaining ref-management gaps in three areas, completing each so the
common Fork workflows are reachable in riff:

1. **Named stash** — let a stash carry a message (currently always unnamed).
2. **Tag delete + push** — the two operations missing from riff's tag support.
3. **Reflog recovery** — a "get me back to where I was" safety net for undoing
   any past HEAD move (bad reset, botched rebase, amend regret, deleted branch,
   orphaned detached-HEAD commit).

## Context

An audit of riff's stash/tags/reflog surface (backend `src-tauri/src/git/` +
lib `src/lib/git.ts` + UI `src/lib/ui/RefsSidebar.svelte`) found the three
areas are at very different levels of completeness:

- **Stash is nearly done.** Backend `stash_save/list/apply/drop` exist;
  `RefsSidebar` has a full "Stashes" section (`＋` save + per-stash
  Pop/Apply/Drop); the command palette has stash save/pop/drop. `stash_save`
  already accepts `-m <message>` and `doStashSave(message?)` already forwards
  it — **the only gap is that no UI ever passes a message**, so every stash is
  unnamed.
- **Tags are mostly done.** `create_tag` exists (lightweight); `RefsSidebar`
  already renders a "Tags" section from `listRefs()` (`kind === "tag"`); the
  context menu already offers Checkout, Merge-into-current, and
  New-branch-from-here for a tag. **The only gaps are Delete and Push** — Delete
  is gated to `ref.kind === "local"`, and no tag-push path exists anywhere.
- **Reflog is greenfield.** No backend command, no UI. This is the largest
  piece: a new backend command plus a new modal surface.

This sub-project deliberately crosses two lines the prior discoverability pass
held (it was frontend-only, no backend, no prompt dialogs): here we add **three
new backend commands** and **inline text inputs**. That is expected — this is a
different, feature-completion sub-project, not a discoverability pass.

riff replaces git's staged/unstaged index with a JetBrains-style **changelists**
model. Nothing here touches that model; stash/tags/reflog operate at the ref/
commit level, orthogonal to changelists.

## Architecture / Approach

Three mostly-independent features. Reuse dominates new code: `reset`,
`createBranch`, and `stash_save`-with-message already exist, so only three new
backend commands are needed.

| # | Feature | New backend | Primary frontend |
|---|---------|-------------|------------------|
| 1 | Named stash | none | `RefsSidebar.svelte` (inline input on `＋`) |
| 2 | Tag delete + push | `delete_tag`, `push_tag` | `RefsSidebar.svelte` (context-menu items), `git.ts` bindings |
| 3 | Reflog recovery | `reflog` | new `ReflogOverlay.svelte`, `reflog.ts`, `store.svelte.ts`, `commands.ts`, `+page.svelte`, `shortcuts.ts`, `git.ts`, `types.ts` |

### Backend conventions to follow (verified in `cli.rs`)

Every mutating command in `GitCli` takes `let _w = self.write_lock.lock().unwrap();`,
calls `validate_ref` on each ref-name argument, runs via `self.run` (local) or
`self.run_network` (talks to a remote), and calls `self.drop_session()` after
operations that change HEAD/index/working-tree. `push` hardcodes the remote
**`origin`** (matching the existing upstream push). New commands mirror the
nearest existing sibling exactly.

---

## 1. Named stash

**Exists:** `stash_save(path, message: Option<&str>, include_untracked)` already
appends `-m <message>` when the message is non-empty (`cli.rs`); the lib binding
`stashSave(path, message, includeUntracked)` and the helper
`doStashSave(message?)` (`sourceControl.ts`) already forward a message. The
`RefsSidebar` Stashes section's `＋` button calls `doStashSave()` with **no**
argument, and the palette `stash.save` command likewise saves unnamed.

**Add (frontend only):** turn the `＋` in the Stashes section header into an
inline message entry.

- Clicking `＋` reveals a small inline text input in the Stashes section
  (local component state, e.g. `stashEditing` / `stashMsg`), focused on open.
- Submit (Enter) → `doStashSave(stashMsg.trim() || undefined)` → clears and
  closes the input. Escape cancels.
- An **empty** message still saves an unnamed stash (preserves today's
  behavior — a blank submit equals the old `＋`).
- The stash list already shows `s.message`; a git-generated name (`WIP on …`)
  continues to show for unnamed stashes, and the user's `-m` text shows for
  named ones. No list changes needed.

**Unchanged:** the palette `stash.save` command stays a one-click **unnamed**
quick-save (a palette entry cannot host an inline field). Naming is done from
the sidebar `＋`. Pop/Apply/Drop are untouched.

**Edge cases:** whitespace-only message → treated as empty (unnamed), matching
the backend's `!m.trim().is_empty()` guard.

---

## 2. Tag delete + push

**Exists:** tags are listed (`RefsSidebar` "Tags" section); the shared context
menu already gives a tag Checkout (detached), Merge-into-current, and
New-branch-from-here. `create_tag` makes lightweight tags.

**Add two backend commands** (mirroring existing siblings):

- **`delete_tag(path, name)`** — mirror `delete_branch`:
  `write_lock` → `validate_ref(name)` → `git tag -d <name>`. Local only (no
  `run_network`), no `drop_session` (refs change but not HEAD/index/tree — same
  as `delete_branch`, which also omits it).
- **`push_tag(path, name)`** — mirror `push`'s origin convention:
  `write_lock` → `validate_ref(name)` → `run_network(path, &["push", "origin",
  &format!("refs/tags/{name}")])`. The explicit `refs/tags/<name>` refspec
  disambiguates from a same-named branch. Remote is `origin` (v1; matches the
  existing `push`).

Wire both through `mod.rs` (`GitLayer` trait sigs, placed after the nearest
sibling), `cli.rs` (impls), `lib.rs` (`#[tauri::command]` wrappers +
`generate_handler!` registration), and `git.ts` bindings
(`deleteTag`, `pushTag`).

**Add UI (RefsSidebar context menu):** a `{#if ref.kind === "tag"}` block in the
`{#if menu}` context menu with two items:

- **Push** → `doPushTag(ref.name)`: `runSync`/try-catch around
  `pushTag(repoPath, ref.name)`, surfacing errors to `appState.error` (mirror
  the existing network-op handlers). A network op — show progress text.
- **Delete** (`class="danger"`) → `doDeleteTag(ref)`:
  `confirmAction("Delete tag '<name>'?", { title: "Delete tag" })` → on confirm
  `deleteTag(repoPath, ref.name)` → refresh refs. Mirror the local `doDelete`
  handler's structure (busy guard + error surfacing), minus the
  not-fully-merged force path (irrelevant to tags).

Both handlers are `RefsSidebar`-local, next to `doDelete`. After either op,
call the sidebar's `load()` (re-lists refs + status) in a `finally` — exactly
as `doDelete` does — so the Tags section reflects the change.

**Edge cases:** deleting a tag that only exists locally is fine (local `git tag
-d`). Pushing a tag with no `origin` remote fails at git and surfaces in the
error banner (acceptable v1). Deleting a tag does **not** delete it on the
remote (v1 — a remote-tag delete is deferred).

---

## 3. Reflog recovery panel

**Exists:** nothing (no backend, no UI). `reset(path, target, mode)` and
`createBranch(path, name, startPoint, checkout)` already exist and are reused.

### Backend — new `reflog` command (read-only)

- **`reflog(path) -> Vec<ReflogEntry>`**: read HEAD's reflog in a machine-
  readable format and parse it, mirroring how `stash_list` reads
  `--format=…%x1f…` and calls a `parse_*` helper.
  - Invocation: walk the HEAD reflog with a unit-separator format and a recent
    cap, e.g. `git reflog show --format=%H%x1f%h%x1f%gD%x1f%gs%x1f%cI -n 200`
    (fields: full SHA, short SHA, selector `HEAD@{n}` via `%gD`, reflog subject
    `%gs` such as `commit: …` / `reset: moving to …`, committer ISO date
    `%cI`). Read-only → no `write_lock`, no `drop_session` (same as
    `stash_list`). The implementer verifies the exact `git reflog show`
    format/`-n` incantation against the bundled git during Task work.
  - `parse_reflog(&str) -> Vec<ReflogEntry>`: split each non-empty line on
    `\x1f` into the five fields; mirror `parse_stash_list`.
- **`ReflogEntry`** struct (serde `Serialize`, following the **same field-
  casing convention as the existing `Stash` struct**): `sha`, `short_sha`,
  `selector`, `subject`, `time`. Add a matching TS `ReflogEntry` interface to
  `src/lib/types.ts`.
- Wire through `mod.rs` / `cli.rs` / `lib.rs` / `git.ts` (`reflog(path):
  Promise<ReflogEntry[]>`) like the other commands.

### Frontend — modal overlay (reuse the discoverability-pass idiom)

The discoverability pass shipped `ShortcutsOverlay.svelte` and the palette
`CommandPalette.svelte`; the reflog panel reuses that exact modal/backdrop/
focus/Esc idiom.

- **`store.svelte.ts`**: add `reflogOpen = $state(false)` (next to
  `shortcutsOpen`). Reflog entries are loaded on open (not persisted in the
  store beyond what the overlay needs).
- **`src/lib/reflog.ts`** (new): small helpers the overlay calls:
  - `loadReflog(): Promise<ReflogEntry[]>` — `reflog(changesRepoPath())` with
    try/catch → `appState.error` on failure, returns `[]`.
  - `resetToReflog(sha): Promise<void>` —
    `confirmAction("Reset to this point? Uncommitted changes will be lost.",
    { title: "Reset to reflog entry", kind: "warning" })` → on confirm
    `reset(changesRepoPath(), sha, "hard")` → `invalidateGraph()` +
    `loadStatus()`; errors → `appState.error`. Closes the overlay on success.
  - Branch-at-entry reuses `createBranch(changesRepoPath(), name, sha, false)`
    directly (no new helper needed).
- **`src/lib/ui/ReflogOverlay.svelte`** (new): modal gated on
  `appState.reflogOpen`.
  - On open (`$effect` when `reflogOpen` becomes true), call `loadReflog()` into
    local state; focus the dialog.
  - Render entries as rows: `selector` · `shortSha` (mono) · `subject` ·
    relative time (reuse the app's existing commit-time formatting).
  - **Primary action** — clicking a row → `resetToReflog(entry.sha)`.
  - **Secondary action** — a per-row "＋ branch" affordance opens an inline
    name input (same inline-input idiom as §1/§2) → `createBranch(repo, name,
    entry.sha, false)` then refresh refs. Non-destructive escape hatch.
  - Close on Esc, backdrop click, or the close button; `onKey` uses
    `stopPropagation` so global shortcuts stay inert while open (same as
    `ShortcutsOverlay`).
- **`commands.ts`**: add `{ id: "reflog.open", title: "Reflog / Undo history",
  category: "Commit", run: () => { appState.reflogOpen = true; } }` (sits with
  the existing `commit.undo` "Undo last commit").
- **`+page.svelte`**: render `<ReflogOverlay />` (next to `<CommandPalette />` /
  `<ShortcutsOverlay />`); add `appState.reflogOpen` to the modal-suppression
  guard alongside `checkoutPrompt` / `paletteOpen` / `shortcutsOpen` (the
  overlay owns its own Esc).
- **`shortcuts.ts`**: add one cheat-sheet line under a suitable group (e.g.
  "Reflog / Undo history — via Command palette") so the new capability is
  documented alongside the others.

### Semantics & edge cases

- The reflog SHA is the commit HEAD pointed to **at that entry**; resetting
  `--hard` to it restores HEAD to that point. This is the standard reflog mental
  model and the direct "undo anything".
- `reset --hard` discards uncommitted changes — hence the mandatory
  `confirmAction`. The "＋ branch" secondary is the non-destructive alternative
  (park the current state on a branch, or create a branch at the lost commit,
  without moving HEAD).
- HEAD reflog only (v1). Per-ref reflogs and reflogs for already-deleted
  branches are out of scope; the HEAD reflog covers the recovery scenarios that
  motivate the feature (reset/rebase/amend/detached-HEAD).
- The 200-entry cap is a display bound; note it if the reflog is longer (rather
  than silently truncating). An unborn branch / empty reflog shows an empty
  state.

---

## Out of scope / deferred

- **Annotated tags** (with a message/`-a`/`-m`): `create_tag` stays lightweight.
- **Remote-tag delete** (`git push origin :refs/tags/<name>`), `push --tags`
  (all tags), and pushing tags to a non-`origin` remote.
- **Stash contents preview** (`git stash show -p`) and **partial/selective
  stash** (stashing a single changelist or file set).
- **Non-HEAD reflogs**, reflog **search/filter**, and per-action icons in the
  reflog list.
- The other Track C sub-projects (repo lifecycle + remotes, interactive rebase,
  Full palette tier).

## Testing

Consistent with riff's established posture (git operations and Svelte UI are not
unit-tested; only pure functions get vitest at `src/lib/**/*.test.ts`):

- **Pure/unit (vitest):** the only genuinely unit-testable new logic is reflog
  parsing. It lives in Rust (`parse_reflog`, mirroring `parse_stash_list`), so
  it is covered by manual E2E rather than a JS test — unless a pure JS
  parse/format helper is extracted, in which case it gets a vitest. No
  speculative UI tests.
- **Gates (must stay green):** `npm test`, `npm run check` (0 errors; the one
  pre-existing benign `@types/node` warning is allowed), and `cargo check`
  clean.
- **Manual E2E (merge gate):**
  - Named stash: `＋` → type a message → the stash appears with that message; a
    blank submit still stashes (unnamed).
  - Tag delete: context-menu Delete on a tag → confirm → tag disappears from the
    Tags section. Tag push: Push on a tag → it publishes to `origin` (verify on
    the remote); a bogus/no-remote case surfaces an error, not a crash.
  - Reflog: the panel opens from the palette and lists entries; clicking an
    entry resets `--hard` and HEAD lands there (graph + status refresh); "＋
    branch" creates a branch at an entry without moving HEAD.

## Success criteria

- A stash can be saved with a name from the sidebar; unnamed still works.
- A tag can be deleted (with confirm) and pushed to `origin` from its context
  menu; existing tag actions are unchanged.
- The reflog panel is reachable from the command palette, lists recent HEAD
  moves, and can restore HEAD to any of them (`reset --hard`, confirmed) or
  branch off one non-destructively.
- `npm run check`, `npm test`, and `cargo check` are clean; the manual E2E
  checklist passes.
