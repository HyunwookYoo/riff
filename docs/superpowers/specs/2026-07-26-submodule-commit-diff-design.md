# Fork-style submodule change view — Design

**Date:** 2026-07-26
**Track:** C (Fork-parity VCS UX)
**Status:** Approved, ready for planning

## Problem

When a submodule's gitlink pointer moves, riff shows the raw pointer change as a
two-line text diff:

```
Subproject commit 12e13c2202a6acf404c9e24a51f60f4b9961c86a
Subproject commit d0cc0b0418364527a109892a829aa9bb0266811e
```

This is what `git show` prints, but it tells the reader nothing about *which*
commits moved. Fork instead runs `git log` inside the submodule between the two
SHAs and lists the actual commits (author · short-sha · date · subject) with
ahead/behind counts (`1↓ 7↑`). That is far more useful, so riff should do the
same.

## Goal

When a file diff is a submodule pointer move, render the submodule's commit log
between the old and new gitlink SHAs — a **lean, static commit list** with
ahead/behind counts — instead of the raw SHA text. Fall back to today's SHA text
whenever the log cannot be computed, so no case regresses.

## Scope decisions (locked)

- **Fidelity:** lean commit **list** only — no branch-topology graph drawing.
- **Direction:** list **both** added (`old..new`) and removed (`new..old`)
  commits, in two groups.
- **Interactivity:** **static** rows — display only, no click/expand/navigation.

## Non-goals

- No topology graph (the colored lines/dots Fork draws).
- No click-through to the submodule repo or to a per-commit diff.
- No change to how added / removed submodules (one side missing) render — they
  keep the existing SHA-text behavior.
- No new palette command or sidebar entry — this is purely a diff-pane rendering
  change for content the user already opens.

## Architecture

When the existing gitlink detection fires and **both** old and new gitlink SHAs
resolve, the backend runs `git log` **inside the submodule's own repository**
between those SHAs (both directions) and returns a new structured
`FileDiff::Submodule` variant. The frontend renders it with a dedicated
`SubmoduleDiff.svelte` component in the diff pane.

If the log cannot be computed — submodule not initialized, commits not fetched,
a SHA not in the submodule's object DB, one side missing, or both ranges empty —
the backend falls back to the **existing** `FileDiff::Text` SHA rendering. That
code path is unchanged, so un-fetched submodules behave exactly as they do today.

### Rejected alternatives

- **(B) Enrich `FileDiff::Text` content** with a formatted commit list. No
  frontend change, but it renders through CodeMirror as a fake text diff — no
  ▲/▼ header, no per-field styling (sha color, author), no group dividers.
  Loses the Fork-like feel.
- **(C) Separate frontend-triggered command.** The frontend detects a submodule
  text diff by string-sniffing `"Subproject commit"` and calls a new
  `submodule_log(...)` command. Extra round-trip and brittle detection.

The structured-variant approach is the cleanest and reuses riff's commit-row
styling.

## Data model

### Rust (`src-tauri/src/git/mod.rs`)

New `FileDiff` variant (serde tag `kind`, `rename_all = "kebab-case"` → wire tag
`"submodule"`):

```rust
Submodule {
    /// Gitlink path, as it appears in the parent tree (e.g. "Plugins" or
    /// "Sandbox/Plugins"). The frontend shows its basename in the header.
    name: String,
    old_sha: String,
    new_sha: String,
    /// Commits reachable from new but not old (old..new), newest first,
    /// capped to LIST_CAP.
    added: Vec<SubmoduleCommit>,
    /// Commits reachable from old but not new (new..old), newest first,
    /// capped to LIST_CAP.
    removed: Vec<SubmoduleCommit>,
    /// Full count of added commits (>= added.len()); drives the ▲N header
    /// and the "+N more" line when the list is capped.
    added_count: usize,
    /// Full count of removed commits (>= removed.len()); drives the ▼N header.
    removed_count: usize,
}
```

New struct:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubmoduleCommit {
    pub sha: String,
    pub short_sha: String,
    pub author: String,
    /// Author time, unix seconds.
    pub time: i64,
    /// Subject line (first line of the commit message).
    pub subject: String,
}
```

A lean struct rather than reusing `Commit` — a static list needs none of
`Commit`'s `parents`/`refs`/`body`/graph fields, and this is cheaper to produce
from a single `git log --format`.

`LIST_CAP = 50` (a module const next to the helper).

### TypeScript (`src/lib/types.ts`)

Add to the `FileDiff` union:

```ts
| {
    kind: "submodule";
    name: string;
    old_sha: string;
    new_sha: string;
    added: SubmoduleCommit[];
    removed: SubmoduleCommit[];
    added_count: number;
    removed_count: number;
  }
```

And:

```ts
export interface SubmoduleCommit {
  sha: string;
  short_sha: string;
  author: string;
  /// Author time, unix seconds.
  time: number;
  /// Subject line (first line of the message).
  subject: string;
}
```

## Data flow

Two existing code paths already detect a gitlink and resolve both SHAs:

- **Branch-compare** — `cli.rs` `file_diff` (~line 1126). Both SHAs come from
  `ls_tree_gitlink(path, ref, target)` as `old_link` / `new_link`. Submodule
  worktree = `path.join(file_path)`.
- **Working-copy** — `cli.rs` `changes_file_diff` (~line 1294). SHAs come from
  `gitlink_sha(...)` as `old_sha` / `new_sha`. Submodule worktree = `fs_path`
  (already computed as `path.join(file_path)`).

At **each** path, after the two SHAs are resolved and **before** building the
`FileDiff::Text` SHA fallback:

1. If **both** SHAs are `Some`, call the helper (below) with the submodule
   worktree path and the two SHAs.
2. If it returns `Some((added, added_count, removed, removed_count))` **and** at
   least one of `added`/`removed` is non-empty → return `FileDiff::Submodule {
   name: <gitlink path>, old_sha, new_sha, added, removed, added_count,
   removed_count }`.
3. Otherwise (helper returned `None`, either SHA missing, or both lists empty) →
   build the existing `FileDiff::Text` SHA rendering exactly as today.

`name` is the gitlink path shown for this diff: `file_path` (the new-side path).

### Helper

```rust
/// Commit log of a submodule between two of its own commit SHAs, both
/// directions. Returns (added, added_count, removed, removed_count) where
/// `added` is `old..new` and `removed` is `new..old`, each newest-first and
/// capped to LIST_CAP, with the *full* counts alongside. Returns None when the
/// submodule repo can't answer — not initialized, commits not fetched, a SHA
/// not in its object DB — so the caller falls back to the SHA text.
fn submodule_commits(
    sub_worktree: &Path,
    old: &str,
    new: &str,
) -> Option<(Vec<SubmoduleCommit>, usize, Vec<SubmoduleCommit>, usize)>
```

Implementation:

- One direction:
  `git -C <sub_worktree> log --format=%H%x1f%h%x1f%an%x1f%at%x1f%s -z <RANGE>`
  where `<RANGE>` is `old..new` (added) then `new..old` (removed). `-z`
  terminates each commit record with NUL; `%x1f` (unit separator) delimits the
  five fields within a record.
- If either `git log` invocation exits non-zero → return `None` (this is the
  "not fetched / bad SHA" signal). A zero-exit with empty stdout is a legitimate
  empty range, not a failure.
- Parse each stream with `parse_submodule_log` (below), which yields the full
  `Vec<SubmoduleCommit>`. Take `count = vec.len()`, then truncate to `LIST_CAP`.
- The two SHAs are validated with `validate_ref` before interpolation (they are
  hex from git, but this matches the codebase's ref-handling discipline).

This helper is **read-only**: no `write_lock`, no `drop_session` (consistent
with `stash_list` / `reflog`).

### Parser

```rust
/// Parse `git log --format=%H%x1f%h%x1f%an%x1f%at%x1f%s -z` output.
/// Records are NUL-terminated; fields within a record are separated by \x1f
/// (unit separator) in order: full-sha, short-sha, author, author-time,
/// subject. Records with fewer than 5 fields or an unparseable time are
/// dropped.
fn parse_submodule_log(bytes: &[u8]) -> Vec<SubmoduleCommit>
```

- Split on NUL; skip empty trailing record.
- Split each record on `\x1f` into exactly the 5 fields; drop malformed records.
- `time` parses from the `%at` field via `i64::from_str`; drop the record if it
  fails.

## Frontend rendering

### `src/lib/ui/SubmoduleDiff.svelte` (new)

Props: `diff` (the `kind: "submodule"` object).

Layout:

- **Header:** `'<basename(name)>'` followed by `▲<added_count> ▼<removed_count>`.
  (Omit an arrow when its count is 0.)
- **Added group:** heading `added (<added_count>)`, then a row per
  `added` entry. When `added_count > added.length`, a trailing muted line
  `+<added_count − added.length> more`.
- **Removed group:** same shape, using `removed` / `removed_count`. Rendered
  only when `removed_count > 0`.
- **Row:** `● <short_sha>  ·  <author>  ·  <date>` on the first line, subject on
  the second (or same line, truncated with ellipsis). `●` for added, `○` for
  removed (visual distinction only). Static — no hover/click behavior.
- **Date:** reuse riff's existing relative/short date formatter used by the
  commit list (unix seconds → display). The plan identifies the exact util.

The component holds no state and takes no actions — it is a pure render of the
variant.

### `src/lib/ui/DiffView.svelte`

Add a branch to the diff-body `{#if}` chain:

```svelte
{:else if diff.kind === "submodule"}
  <SubmoduleDiff {diff} />
```

The top mode/language toolbar is already gated on `diff?.kind === "text"`, so it
hides automatically for the submodule kind — no extra guard needed. The file-path
header still renders as for any diff.

## Error handling & edge cases

| Case | Behavior |
|---|---|
| Submodule not initialized / not fetched | `git log` fails → `None` → SHA-text fallback |
| A SHA not in submodule object DB | `git log` fails → `None` → SHA-text fallback |
| Added submodule (no old SHA) | one side missing → SHA-text fallback |
| Removed submodule (no new SHA) | one side missing → SHA-text fallback |
| SHAs differ, both ranges empty | both lists empty → SHA-text fallback (defensive) |
| Range exceeds 50 commits | list capped at 50; header count exact; `+N more` line |

No new error is surfaced to the user in any fallback case — the diff pane simply
shows the previous SHA text.

## Testing

- **Rust unit test — `parse_submodule_log`:**
  - Two well-formed records → two `SubmoduleCommit`s with correct fields.
  - Empty input → empty vec.
  - Record with `<5` fields → dropped.
  - Record with non-numeric `%at` → dropped.
- **Manual E2E** on the sandbox dogfood repo (`C:\workspace\sandbox`, which has
  the real `Plugins` submodule): open a commit / working-copy change that moves
  the gitlink and confirm the commit list renders with correct counts; confirm a
  submodule whose commits aren't fetched still shows the SHA text. This mirrors
  how the prior Track C sub-projects were verified.

No Svelte-component unit test — the repo has no component test harness; the
component is a pure render and is covered by manual E2E.

## Files touched

- `src-tauri/src/git/mod.rs` — `SubmoduleCommit` struct, `FileDiff::Submodule`
  variant.
- `src-tauri/src/git/cli.rs` — `LIST_CAP` const, `submodule_commits` helper,
  `parse_submodule_log` + its tests, and the two call-site branches in
  `file_diff` / `changes_file_diff`.
- `src/lib/types.ts` — `SubmoduleCommit` interface + `submodule` union member.
- `src/lib/ui/SubmoduleDiff.svelte` — new component.
- `src/lib/ui/DiffView.svelte` — one `{:else if}` branch + import.
