# File-level Stash — Design Spec

**Date:** 2026-07-21
**Track:** C (feature gaps + discoverability) of the Fork-parity VCS UX initiative — fourth sub-project (after the discoverability pass and the tags/stash/reflog completion).

## Goal

Let a user stash **one file's** working-tree changes from the Changes list,
instead of only the whole working tree. This is the "partial/selective stash"
that the tags/stash/reflog spec explicitly deferred.

## Context

riff's stash is otherwise complete: the backend `stash_save` and the refs
sidebar's Stashes section (save with an inline message, plus Pop/Apply/Drop)
all shipped in the previous sub-project. The one gap is scope — `stash_save`
runs `git stash push [--include-untracked] [-m <msg>]` with **no pathspec**, so
it always captures the entire working tree. There is no way to set aside just
one file.

git 2.43 (the bundled version) supports `git stash push [-u] [-m <msg>] [--]
<pathspec>...`. This was **verified empirically** in an isolated repo:

```
$ git stash push -u -m "file-level test" -- tracked.txt new.txt
Saved working directory and index state On master: file-level test
$ git status --porcelain      # a third file's change is left alone
 M keep.txt
$ git stash show -u --name-only stash@{0}
new.txt
tracked.txt
```

So a pathspec (plus `-u`) captures exactly the named files — including an
untracked one — and leaves every other change in the working tree. That is the
whole mechanism this feature needs.

### Decisions already made (during brainstorming)

- **Unit: a single file.** Not changelists, not multi-select. riff's Changes
  list is single-selection, and "stash this file" is the requested workflow.
- **Name: an inline message field**, empty defaults to the file path (so the
  entry is identifiable in the stash list). Mirrors the just-shipped named-stash
  input rather than silently auto-naming.
- **Mechanism: pathspec**, `git stash push -u -m <msg> -- <path>`.

### Why file-level, not hunk-level

riff has a changelists model where a file's hunks can be split across
changelists (`filesInChangelist` returns `partial: true` for such a file).
Stashing a *subset of a file's hunks* would need `git stash --patch`
(interactive) or a synthesized patch apply — a materially bigger feature.
File-level stash captures the whole file's working-tree changes regardless of
changelist, which is the agreed scope. Hunk-level is out of scope (below).

## Architecture / Approach

One backend method gains a pathspec argument; the frontend adds a context-menu
entry and an inline input that reuse patterns already in the code. No new
backend command, no new frontend module.

| Layer | Change |
|---|---|
| `src-tauri` | `stash_save` gains a nullable `paths` argument (mirrors `stage`) |
| `src/lib/git.ts` | `stashSave` binding gains `paths` |
| `src/lib/sourceControl.ts` | `doStashSave` gains an optional `paths?` |
| `src/lib/ui/ChangesList.svelte` | "Stash this file…" context-menu item + inline message editor |

### Backend convention this follows

`stage` is the exact precedent (`cli.rs`): `fn stage(&self, path, files:
Option<&[String]>)` — `None` runs the whole-tree form (`git add -A`), `Some`
validates each path with `validate_path` then runs `git add -- <files>`.
`stash_save` will follow this shape for its new `paths` argument, so `None`
preserves today's whole-tree behavior byte-for-byte.

---

## 1. Backend — `stash_save` gains a pathspec

**Trait (`src-tauri/src/git/mod.rs`):** add a `paths: Option<&[String]>`
argument to the `stash_save` signature, after `include_untracked`.

**Impl (`src-tauri/src/git/cli.rs`):** the method already builds
`let mut args = vec!["stash", "push"];`, appends `--include-untracked` and
`-m <message>` (only when the message is non-empty), then runs and
`drop_session()`s. Insert, immediately before the `self.run(...)` call:

```rust
    if let Some(ps) = paths {
        for p in ps {
            validate_path(p)?;
        }
        args.push("--");
        args.extend(ps.iter().map(String::as_str));
    }
```

`--` before the pathspec, and `validate_path` on each entry, match how `stage`
guards its file list. `-u` (`--include-untracked`) stays driven by the existing
`include_untracked` flag; with a pathspec present, git scopes the untracked
sweep to the named path (verified above).

**Command wrapper (`src-tauri/src/lib.rs`):** the `stash_save` `#[tauri::command]`
gains `paths: Option<Vec<String>>` and passes `paths.as_deref()` through, exactly
as the `stage` wrapper threads its `Option<Vec<String>>`.

## 2. Frontend bindings

**`src/lib/git.ts`:** `stashSave` gains a `paths: string[] | null` argument,
matching the `stage(path, files: string[] | null)` binding, and forwards it in
the `invoke` payload.

**`src/lib/sourceControl.ts`:** `doStashSave` gains an optional
`paths?: string[]` argument and forwards `paths ?? null` to `stashSave`. The two
existing callers (the sidebar `＋` and the palette `stash.save`) pass nothing new
and are unaffected — they continue to stash the whole tree. The helper's existing
refresh (`refreshActiveView()` + `loadStashes()`) already covers the file-level
case; no new refresh wiring is needed.

## 3. UI — Changes list

**`src/lib/ui/ChangesList.svelte`.** The per-file context menu (`moveMenu`,
opened by `openMove`) currently holds only the "Move to changelist" items. Add,
below those items, a separator and a **"Stash this file…"** entry.

Selecting it opens an **inline message editor**, reusing the component's existing
inline-editor idiom (`creating`/`createName` for new-changelist and
`editingId`/`editName` for rename both use an autofocus `<input>` in a small
form, Enter to submit, Escape to cancel):

- Add `stashingPath: string | null` and `stashMsg: string` session state.
- Selecting "Stash this file…" sets `stashingPath = <path>` and clears `stashMsg`.
- The editor renders as a compact bar at the **top of the Changes panel**
  (reusing the `.cl-create` form styling), labeled with the file being stashed
  (e.g. `Stash src/lib/reflog.ts:` followed by the input).
- **Submit (Enter):** `const m = stashMsg.trim() || <path>;` then
  `await doStashSave(m, [<path>]);` then clear `stashingPath`/`stashMsg`. An empty
  message therefore stores the file path as the stash subject, so the entry is
  identifiable in the sidebar's Stashes list.
- **Cancel (Escape):** clear `stashingPath`/`stashMsg`, stash nothing.

**Untracked files:** `doStashSave` already passes `include_untracked = true`
(as the sidebar `＋` does), and the pathspec scopes the untracked sweep to the
selected file, so right-clicking an untracked file stashes exactly that file.

### Edge cases / notes

- After a successful stash the file's changes leave the working tree; the
  existing `refreshActiveView()` re-lists the Changes view and the file drops
  off, and `loadStashes()` shows the new entry in the sidebar. Other files'
  changes remain (verified).
- A file split across changelists is stashed **whole** — the pathspec captures
  all of that file's working-tree changes regardless of hunk/changelist
  assignment. This is the agreed file-level scope, not a bug.
- A failed stash surfaces via the existing `doStashSave` error handling
  (`appState.error`), same as the whole-tree path.

---

## Out of scope / deferred

- **Hunk-level / partial-within-file stash** (a subset of a file's hunks) — needs
  `git stash --patch` (interactive) or a synthesized patch; materially larger.
- **Changelist-level stash** ("stash this whole changelist") — the chosen scope
  is file-only; a changelist unit is a separate, later decision.
- **Multi-file selection stash** — the Changes list is single-selection today.
- The other Track C sub-projects (repo lifecycle + remotes, interactive rebase,
  Full palette tier).

## Testing

Consistent with riff's established posture (git operations and Svelte UI are not
unit-tested; only pure functions get vitest):

- **No new unit tests.** `stash_save` is a subprocess wrapper whose only new
  logic is conditional pathspec-arg assembly (the same untested shape as
  `stage`); the risk is the git behavior, which the manual E2E covers.
- **Gates (must stay green):** `npm test`, `npm run check` (0 errors; the one
  pre-existing benign `@types/node` warning is allowed), and `cargo check`
  (from `src-tauri/`).
- **Manual E2E (merge gate):**
  - Right-click a modified file → **Stash this file…** → type a message → the
    stash appears in the sidebar with that message; the file's change leaves the
    working tree; **other files' changes remain**.
  - Submit the inline field **empty** → the stash is stored with the file path
    as its subject.
  - Right-click an **untracked** file → Stash this file → exactly that file is
    stashed.
  - The sidebar `＋` and the palette "Stash: save changes" still stash the whole
    tree (no regression).

## Success criteria

- A single file's changes can be stashed from the Changes list, named or
  file-path-defaulted, without disturbing other files' changes.
- Untracked files can be stashed this way.
- Whole-tree stash (sidebar `＋`, palette) is unchanged.
- `npm run check`, `npm test`, and `cargo check` are clean; the manual E2E
  checklist passes.
