# Fork-style Submodule Commit Diff — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render a submodule gitlink pointer move as the submodule's own commit log (added + removed commits, ahead/behind counts) instead of the raw `Subproject commit <sha>` text, falling back to that text whenever the log can't be computed.

**Architecture:** Backend adds a `FileDiff::Submodule` variant produced by a read-only `submodule_commits` helper that runs `git log` inside the submodule between the two gitlink SHAs (both directions). Both existing gitlink code paths (branch-compare + working-copy) try the helper first and fall back to the current `FileDiff::Text` SHA rendering on any failure. Frontend adds a `SubmoduleDiff.svelte` component and one `{:else if}` branch in `DiffView.svelte`.

**Tech Stack:** Rust (`std::process::Command`, serde), Tauri, SvelteKit + Svelte 5 runes.

**Spec:** `docs/superpowers/specs/2026-07-26-submodule-commit-diff-design.md`

## Global Constraints

- **Serde:** the variant is tagged `kind` with `rename_all = "kebab-case"` → wire tag is exactly `"submodule"`. Field names pass through unchanged (no camelCase rename), so Rust `snake_case` field names appear verbatim on the TS side (`old_sha`, `added_count`, etc.).
- **Read-only helper:** `submodule_commits` takes **no** `write_lock` and does **no** `drop_session` (consistent with `stash_list` / `reflog`). It is a free function using `git_command()` directly, like `gitlink_sha` / `ls_tree_gitlink`.
- **No regression:** when the helper returns `None`, either SHA is missing, or both commit lists are empty, the call site must build the **existing** `FileDiff::Text` SHA rendering, byte-for-byte unchanged from today.
- **Cap:** `SUBMODULE_LOG_CAP = 50` commits listed per direction; the header count is the exact full count.
- **Ref safety:** the two SHAs pass through `validate_ref` before being interpolated into a `git log` range.
- **Date formatting:** the component formats unix-seconds with `new Date(unixSec * 1000).toLocaleDateString(...)` — the codebase idiom (see `BranchContainment.svelte:54`). No shared date util exists; do not introduce one.
- **CSS variables** available: `--bg`, `--fg`, `--border`, `--muted`, `--accent`, `--hover`, `--mono`, `--input-bg`.

---

## File Structure

- `src-tauri/src/git/mod.rs` — `SubmoduleCommit` struct + `FileDiff::Submodule` variant (data model).
- `src-tauri/src/git/cli.rs` — `SUBMODULE_LOG_CAP` const, `parse_submodule_log` (+ unit tests), `submodule_commits` helper, and the two call-site branches.
- `src/lib/types.ts` — `SubmoduleCommit` interface + `submodule` union member.
- `src/lib/ui/SubmoduleDiff.svelte` — new render component (static list).
- `src/lib/ui/DiffView.svelte` — one `{:else if}` branch + import.

Task order: **Task 1** (backend data model + parser + helper, unit-tested) → **Task 2** (wire both call sites) → **Task 3** (frontend types + component + DiffView) → **Task 4** (manual E2E gate). Task 2 depends on Task 1's helper; Task 3 depends on Task 1's serde shape.

---

### Task 1: Backend data model, parser, and helper

**Files:**
- Modify: `src-tauri/src/git/mod.rs` (add struct near `Commit` at :52; add variant to `FileDiff` enum at :231-234)
- Modify: `src-tauri/src/git/cli.rs` (import at :14-18; const near :21; helper + parser near :810; tests in the `#[cfg(test)] mod tests`)

**Interfaces:**
- Produces (used by Task 2):
  - `git::SubmoduleCommit { sha: String, short_sha: String, author: String, time: i64, subject: String }`
  - `FileDiff::Submodule { name: String, old_sha: String, new_sha: String, added: Vec<SubmoduleCommit>, removed: Vec<SubmoduleCommit>, added_count: usize, removed_count: usize }`
  - `fn submodule_commits(sub_worktree: &Path, old: &str, new: &str) -> Option<(Vec<SubmoduleCommit>, usize, Vec<SubmoduleCommit>, usize)>` (free fn in `cli.rs`)
- Produces (used by Task 3): the serde JSON shape of the variant (kebab tag `"submodule"`, snake_case fields).

- [ ] **Step 1: Add the `SubmoduleCommit` struct to `mod.rs`**

Insert immediately after the `Commit` struct (which ends at `mod.rs:52`):

```rust
/// One commit in a submodule's log between two gitlink SHAs. A lean subset of
/// `Commit` (no parents/refs/body) — the submodule diff view is a static list.
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

- [ ] **Step 2: Add the `Submodule` variant to the `FileDiff` enum in `mod.rs`**

Add as the final variant, after `TooLarge { ... }` (mod.rs:231-234), inside the enum:

```rust
    /// A submodule gitlink pointer move, rendered as the submodule's own commit
    /// log between the two SHAs (both directions) rather than the raw
    /// "Subproject commit <sha>" text. Emitted only when both SHAs resolve and
    /// the submodule's object DB can produce the log; otherwise `file_diff`
    /// falls back to `Text`.
    Submodule {
        /// Gitlink path as it appears in the parent tree; the UI shows its basename.
        name: String,
        old_sha: String,
        new_sha: String,
        /// old..new, newest first, capped to SUBMODULE_LOG_CAP.
        added: Vec<SubmoduleCommit>,
        /// new..old, newest first, capped to SUBMODULE_LOG_CAP.
        removed: Vec<SubmoduleCommit>,
        /// Full count of added commits (>= added.len()).
        added_count: usize,
        /// Full count of removed commits (>= removed.len()).
        removed_count: usize,
    },
```

- [ ] **Step 3: Import `SubmoduleCommit` into `cli.rs`**

In the `use super::{ ... }` block (cli.rs:14-18), add `SubmoduleCommit,` immediately before `SubmoduleInfo,`:

```rust
use super::{
    Branch, BranchKind, ChangedFile, Commit, Containment, ContainmentDetail, ConflictVersions,
    DiffMode, FileDiff, FileStatus, GitError, GitLayer, Hunk, RepoStatus, Stash, StatusEntry,
    SubmoduleCommit, SubmoduleInfo,
};
```

- [ ] **Step 4: Add the `SUBMODULE_LOG_CAP` const to `cli.rs`**

Immediately after `const LARGE_FILE_BYTES: u64 = 1_000_000;` (cli.rs:21):

```rust
/// Max submodule commits listed per direction in a `FileDiff::Submodule`. The
/// header still reports the exact full count; excess rows collapse to "+N more".
const SUBMODULE_LOG_CAP: usize = 50;
```

- [ ] **Step 5: Write the failing parser test**

Add to the `#[cfg(test)] mod tests { ... }` block in `cli.rs` (alongside the existing `parse_*` tests):

```rust
    #[test]
    fn parse_submodule_log_two_records() {
        let input = b"abc123\x1fabc123\x1fAlice\x1f1700000000\x1fFirst commit\0\
def456\x1fdef456\x1fBob\x1f1700000100\x1fSecond commit\0";
        let out = parse_submodule_log(input);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].sha, "abc123");
        assert_eq!(out[0].author, "Alice");
        assert_eq!(out[0].time, 1_700_000_000);
        assert_eq!(out[0].subject, "First commit");
        assert_eq!(out[1].subject, "Second commit");
    }

    #[test]
    fn parse_submodule_log_empty() {
        assert!(parse_submodule_log(b"").is_empty());
    }

    #[test]
    fn parse_submodule_log_drops_short_record() {
        // Only 3 fields (missing time + subject) → dropped.
        let input = b"abc\x1fabc\x1fAlice\0";
        assert!(parse_submodule_log(input).is_empty());
    }

    #[test]
    fn parse_submodule_log_drops_bad_time() {
        let input = b"abc\x1fabc\x1fAlice\x1fnotanumber\x1fSubject\0";
        assert!(parse_submodule_log(input).is_empty());
    }
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test parse_submodule_log`
Expected: FAIL — `cannot find function parse_submodule_log in this scope`.

- [ ] **Step 7: Implement `parse_submodule_log` and `submodule_commits`**

Add both free functions to `cli.rs`, near the existing gitlink helpers (`gitlink_sha` at :815, `ls_tree_gitlink` at :834):

```rust
/// Parse `git log --format=%H%x1f%h%x1f%an%x1f%at%x1f%s -z` output. Records are
/// NUL-terminated; the five fields within a record are separated by \x1f (unit
/// separator), in order: full-sha, short-sha, author, author-time (unix secs),
/// subject. Records with fewer than 5 fields or an unparseable time are dropped.
fn parse_submodule_log(bytes: &[u8]) -> Vec<SubmoduleCommit> {
    let text = String::from_utf8_lossy(bytes);
    let mut out = Vec::new();
    for record in text.split('\0') {
        if record.is_empty() {
            continue;
        }
        let mut f = record.splitn(5, '\u{1f}');
        let (Some(sha), Some(short_sha), Some(author), Some(at), Some(subject)) =
            (f.next(), f.next(), f.next(), f.next(), f.next())
        else {
            continue;
        };
        let Ok(time) = at.parse::<i64>() else {
            continue;
        };
        out.push(SubmoduleCommit {
            sha: sha.to_string(),
            short_sha: short_sha.to_string(),
            author: author.to_string(),
            time,
            subject: subject.to_string(),
        });
    }
    out
}

/// Commit log of a submodule between two of its own SHAs, both directions.
/// Returns (added, added_count, removed, removed_count): `added` is `old..new`
/// and `removed` is `new..old`, each newest-first and capped to
/// SUBMODULE_LOG_CAP, with the full counts alongside. Returns None when the
/// submodule repo can't answer — not initialized, commits not fetched, a SHA
/// not in its object DB — so the caller falls back to the SHA text. Read-only:
/// no write lock, no session drop.
fn submodule_commits(
    sub_worktree: &Path,
    old: &str,
    new: &str,
) -> Option<(Vec<SubmoduleCommit>, usize, Vec<SubmoduleCommit>, usize)> {
    validate_ref(old).ok()?;
    validate_ref(new).ok()?;
    let one = |range: &str| -> Option<(Vec<SubmoduleCommit>, usize)> {
        let out = git_command()
            .arg("-C")
            .arg(sub_worktree)
            .args(["log", "--format=%H%x1f%h%x1f%an%x1f%at%x1f%s", "-z", range])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let all = parse_submodule_log(&out.stdout);
        let count = all.len();
        let mut capped = all;
        capped.truncate(SUBMODULE_LOG_CAP);
        Some((capped, count))
    };
    let (added, added_count) = one(&format!("{old}..{new}"))?;
    let (removed, removed_count) = one(&format!("{new}..{old}"))?;
    Some((added, added_count, removed, removed_count))
}
```

- [ ] **Step 8: Run the parser tests to verify they pass**

Run: `cd src-tauri && cargo test parse_submodule_log`
Expected: PASS — all four tests green.

- [ ] **Step 9: Verify the crate compiles**

Run: `cd src-tauri && cargo check`
Expected: compiles. `submodule_commits` may warn as unused (it's wired in Task 2) — acceptable at this task boundary; note it in the report.

- [ ] **Step 10: Commit**

```bash
git add src-tauri/src/git/mod.rs src-tauri/src/git/cli.rs
git commit -m "feat(submodule): FileDiff::Submodule variant + git-log helper"
```

---

### Task 2: Wire both gitlink call sites to emit the variant

**Files:**
- Modify: `src-tauri/src/git/cli.rs` — `file_diff` branch-compare block (:1126-1148) and `changes_file_diff` working-copy block (:1294-1321)

**Interfaces:**
- Consumes: `submodule_commits(...)` and `FileDiff::Submodule { .. }` from Task 1.
- Produces: no new interface — behavior change only.

**Design note:** Each site already resolves both gitlink SHAs. Insert a "try the commit log, else fall through to the existing SHA text" block. On `None`, missing SHA, or both lists empty, the untouched `FileDiff::Text` code below runs exactly as today.

- [ ] **Step 1: Wire the branch-compare site (`file_diff`)**

In `cli.rs`, inside the `if old_link.is_some() || new_link.is_some() {` block (opens at :1129), insert this **as the first statement in the block**, before the existing `let to_text = ...`:

```rust
                // Both SHAs present → try rendering the submodule's own commit
                // log. Falls through to the SHA text below when the log can't
                // be computed (submodule not fetched, SHA missing, empty range).
                if let (Some(old), Some(new)) = (&old_link, &new_link) {
                    if let Some((added, added_count, removed, removed_count)) =
                        submodule_commits(&path.join(file_path), old, new)
                    {
                        if !added.is_empty() || !removed.is_empty() {
                            return Ok(FileDiff::Submodule {
                                name: file_path.to_string(),
                                old_sha: old.clone(),
                                new_sha: new.clone(),
                                added,
                                removed,
                                added_count,
                                removed_count,
                            });
                        }
                    }
                }
```

Leave the existing `to_text` / `FileDiff::Text` code that follows unchanged — it is the fallback.

- [ ] **Step 2: Wire the working-copy site (`changes_file_diff`)**

In `cli.rs`, inside `if fs_path.is_dir() {` (opens at :1294), after `old_sha` and `new_sha` are computed (:1295-1301) and **before** `let to_text = ...` (:1302), insert:

```rust
            // Both SHAs present → try rendering the submodule's own commit log
            // (see file_diff). Falls through to the SHA text on any failure.
            if let (Some(old), Some(new)) = (&old_sha, &new_sha) {
                if let Some((added, added_count, removed, removed_count)) =
                    submodule_commits(&fs_path, old, new)
                {
                    if !added.is_empty() || !removed.is_empty() {
                        return Ok(FileDiff::Submodule {
                            name: file_path.to_string(),
                            old_sha: old.clone(),
                            new_sha: new.clone(),
                            added,
                            removed,
                            added_count,
                            removed_count,
                        });
                    }
                }
            }
```

Leave the existing `to_text` / `FileDiff::Text` block unchanged.

- [ ] **Step 3: Verify the crate compiles and all tests pass**

Run: `cd src-tauri && cargo check && cargo test`
Expected: compiles with no `submodule_commits` unused warning now; all tests pass (the four parser tests plus the existing suite).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/git/cli.rs
git commit -m "feat(submodule): render pointer moves as the submodule commit log"
```

---

### Task 3: Frontend types, component, and DiffView wiring

**Files:**
- Modify: `src/lib/types.ts` — add `submodule` union member (after the `too-large` member at :71-75) + `SubmoduleCommit` interface (after the `Commit` interface at :104-116)
- Create: `src/lib/ui/SubmoduleDiff.svelte`
- Modify: `src/lib/ui/DiffView.svelte` — import + one `{:else if}` branch (before the `{/if}` at :688)

**Interfaces:**
- Consumes: the `FileDiff::Submodule` serde shape from Task 1.
- Produces: no cross-task interface (leaf UI).

- [ ] **Step 1: Add the TypeScript types**

In `src/lib/types.ts`, extend the `FileDiff` union — replace the trailing `too-large` member's closing `};` so the union continues with the new member. The `too-large` block (:71-75) currently ends:

```ts
  | {
      kind: "too-large";
      old_size: number;
      new_size: number;
    };
```

Change it to:

```ts
  | {
      kind: "too-large";
      old_size: number;
      new_size: number;
    }
  | {
      kind: "submodule";
      /// Gitlink path; the view shows its basename.
      name: string;
      old_sha: string;
      new_sha: string;
      /// old..new, newest first, capped to 50.
      added: SubmoduleCommit[];
      /// new..old, newest first, capped to 50.
      removed: SubmoduleCommit[];
      /// Full counts (>= list length); drive the ▲/▼ header and "+N more".
      added_count: number;
      removed_count: number;
    };
```

Then add the interface immediately after the `Commit` interface (which ends at `types.ts:116`):

```ts
/// One commit in a submodule's log between two gitlink SHAs. Mirrors Rust
/// `git::SubmoduleCommit` — a lean subset of `Commit` for the static list.
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

- [ ] **Step 2: Create `src/lib/ui/SubmoduleDiff.svelte`**

```svelte
<script lang="ts">
  import type { FileDiff, SubmoduleCommit } from "$lib/types";

  // Only the submodule variant is ever passed in.
  type SubmoduleFileDiff = Extract<FileDiff, { kind: "submodule" }>;
  let { diff }: { diff: SubmoduleFileDiff } = $props();

  // Basename of the gitlink path (e.g. "Sandbox/Plugins" → "Plugins").
  const base = $derived(diff.name.split("/").filter(Boolean).at(-1) ?? diff.name);

  function fmtDate(unixSec: number): string {
    return new Date(unixSec * 1000).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }
</script>

<div class="sm-root">
  <div class="sm-header">
    <span class="sm-name">Submodule ‘{base}’</span>
    {#if diff.added_count > 0}<span class="sm-ahead">▲{diff.added_count}</span>{/if}
    {#if diff.removed_count > 0}<span class="sm-behind">▼{diff.removed_count}</span>{/if}
  </div>

  {#if diff.added.length > 0}
    <div class="sm-group">added ({diff.added_count})</div>
    {#each diff.added as c (c.sha)}
      {@render row(c, "added")}
    {/each}
    {#if diff.added_count > diff.added.length}
      <div class="sm-more">+{diff.added_count - diff.added.length} more</div>
    {/if}
  {/if}

  {#if diff.removed.length > 0}
    <div class="sm-group">removed ({diff.removed_count})</div>
    {#each diff.removed as c (c.sha)}
      {@render row(c, "removed")}
    {/each}
    {#if diff.removed_count > diff.removed.length}
      <div class="sm-more">+{diff.removed_count - diff.removed.length} more</div>
    {/if}
  {/if}
</div>

{#snippet row(c: SubmoduleCommit, kind: "added" | "removed")}
  <div class="sm-row">
    <span class="sm-dot" class:removed={kind === "removed"}
      >{kind === "added" ? "●" : "○"}</span>
    <div class="sm-body">
      <div class="sm-meta">
        <span class="sm-sha">{c.short_sha}</span>
        <span class="sm-author">{c.author}</span>
        <span class="sm-date">{fmtDate(c.time)}</span>
      </div>
      <div class="sm-subject">{c.subject}</div>
    </div>
  </div>
{/snippet}

<style>
  .sm-root {
    padding: 12px 16px;
    overflow-y: auto;
    height: 100%;
    box-sizing: border-box;
    color: var(--fg);
  }
  .sm-header {
    display: flex;
    align-items: baseline;
    gap: 10px;
    font-weight: 600;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 8px;
  }
  .sm-ahead {
    color: var(--accent);
  }
  .sm-behind {
    color: var(--muted);
  }
  .sm-group {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
    margin: 12px 0 4px;
  }
  .sm-row {
    display: flex;
    gap: 8px;
    padding: 4px 0;
  }
  .sm-dot {
    color: var(--accent);
    line-height: 1.4;
  }
  .sm-dot.removed {
    color: var(--muted);
  }
  .sm-body {
    min-width: 0;
    flex: 1;
  }
  .sm-meta {
    display: flex;
    gap: 10px;
    font-size: 12px;
    color: var(--muted);
  }
  .sm-sha {
    font-family: var(--mono);
    color: var(--accent);
  }
  .sm-subject {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sm-more {
    font-size: 12px;
    color: var(--muted);
    padding: 4px 0 0 16px;
  }
</style>
```

- [ ] **Step 3: Wire `SubmoduleDiff` into `DiffView.svelte`**

Add the import alongside the other `ui` imports at the top of `DiffView.svelte` (near `import ImageDiff from "./ImageDiff.svelte";`):

```ts
  import SubmoduleDiff from "./SubmoduleDiff.svelte";
```

Then, in the diff-body `{#if}` chain, insert this branch immediately before the closing `{/if}` at `DiffView.svelte:688` (right after the `too-large` block ends at :687):

```svelte
  {:else if diff.kind === "submodule"}
    <SubmoduleDiff {diff} />
```

(The `.host` CodeMirror div at :690 is already hidden when `diff?.kind !== "text"`, and the top mode/language toolbar is already gated on `kind === "text"`, so no other guard is needed.)

- [ ] **Step 4: Run the frontend gates**

Run: `npm run check`
Expected: 0 errors (1 pre-existing warning is acceptable). The `Extract<FileDiff, { kind: "submodule" }>` prop type must resolve and the `{#each}`/`{#snippet}` must type-check.

Run: `npm test`
Expected: existing suite passes (currently 51/51) — no frontend unit tests are added for this leaf component.

- [ ] **Step 5: Commit**

```bash
git add src/lib/types.ts src/lib/ui/SubmoduleDiff.svelte src/lib/ui/DiffView.svelte
git commit -m "feat(submodule): commit-log diff view in the diff pane"
```

---

### Task 4: Manual E2E (human gate)

**Files:** none (verification only).

This task is a human verification gate — it is not automatable here (no submodule fixture in the riff repo's test harness; the real submodule lives in the `C:\workspace\sandbox` dogfood repo).

- [ ] **Step 1: Build/run riff against the sandbox repo**

Run riff (`npm run tauri dev` if not already running) and open `C:\workspace\sandbox` (the nested-submodule UE project with the real `Plugins` submodule).

- [ ] **Step 2: Verify the commit-log view (branch-compare + working-copy)**

- Open a commit in history whose diff moves the `Plugins` gitlink → the diff pane shows `Submodule 'Plugins'` with `▲N`/`▼M` and the added (and any removed) commit rows, each with short-sha · author · date · subject.
- In the Changes screen, make/observe a working-copy submodule bump → same commit-log rendering.
- Confirm the ahead/behind counts match `git -C <sub> log --oneline <old>..<new>` run manually.

- [ ] **Step 3: Verify the fallback**

- On a submodule whose target commits are **not** fetched locally (or an added/removed submodule), confirm the diff pane still shows the old `Subproject commit <old>` / `<new>` text — no error, no blank pane.

- [ ] **Step 4: Report result**

Confirm working (or file findings). On confirmation, proceed to `superpowers:finishing-a-development-branch`.

---

## Self-Review

**Spec coverage:**
- Lean commit list, both directions, static rows → Task 3 component. ✅
- `FileDiff::Submodule` structured variant → Task 1. ✅
- Read-only `git log` helper both directions, cap 50, exact counts → Task 1 (`submodule_commits`, `SUBMODULE_LOG_CAP`). ✅
- Wire both branch-compare + working-copy sites → Task 2. ✅
- Fallback to SHA text on failure / missing SHA / empty range → Task 2 (fall-through) + Task 1 (`None` signal). ✅
- Parser unit tests (2 records, empty, short, bad time) → Task 1 Step 5. ✅
- Manual E2E incl. fallback path → Task 4. ✅

**Placeholder scan:** No TBD/TODO; every code step shows complete code and exact commands. ✅

**Type consistency:** `SubmoduleCommit` fields (`sha`, `short_sha`, `author`, `time`, `subject`) identical across `mod.rs` (Task 1 Step 1) and `types.ts` (Task 3 Step 1). Variant fields (`name`, `old_sha`, `new_sha`, `added`, `removed`, `added_count`, `removed_count`) identical across Rust variant (Task 1 Step 2), both call sites (Task 2), and TS union (Task 3). Helper return tuple order `(added, added_count, removed, removed_count)` matches its destructuring at both call sites. ✅
