# Version Control Scope Reduction — Design Spec

**Date:** 2026-08-12
**Version:** targets v2.0.0 (breaking — features are removed, not added)
**Supersedes:** `docs/version-control-plan.md` (2026-07, "Riff — Version Control
기능 설계 문서"), which set out to grow riff into a full Git client. That
direction is abandoned here. The Tier 1 build-out described there (staging,
commit, push, stash) shipped across v1.1–v1.3; this spec removes it.

## Goal

Shrink riff's write surface to the three things it should be good at — **branch
create/checkout (incl. pull), blame, and browsing commit history** — and delete
everything else. Fork remains the tool for committing and pushing.

The motivation is maintenance cost, not taste. The write paths being removed
(auto-stash + reapply, hunk sub-patching via `git apply --cached`, the
changelist↔index round-trip, rebase-in-progress UI suppression) are exactly the
ones that have been unreliable. Removing the feature removes the bug class.

## The invariant

Everything in this spec follows from one rule, which becomes the review
criterion for all future changes:

> **riff modifies a repository in exactly five ways: create a branch, rename a
> branch, delete a branch, checkout, and fetch/pull.**
>
> **There is one exception — conflict resolution. riff cleans up the state its
> own pull created.**

Anything that does not fit that sentence does not belong in riff.

## Context — what exists today

riff v1.3.0. Rust 6,490 lines (`src-tauri/src`), frontend 20,623 lines (`src`).
78 `#[tauri::command]` entries in `src-tauri/src/lib.rs`, all backed by the
`GitLayer` trait (`src-tauri/src/git/mod.rs:272`) and its single implementation
`GitCli` (`src-tauri/src/git/cli.rs`, 3,346 lines, 42 `#[test]`).

Four `AppMode` screens (`src/lib/types.ts:115`): `compare`, `changes`, `history`,
`blame`, plus a toggleable refs sidebar. The write surface currently spans:

| Area | Operations |
|---|---|
| Changes | staging, hunk staging, changelists, commit (amend/sign-off/co-author), discard, undo-commit |
| Graph | merge, rebase, reset (soft/mixed/hard), cherry-pick, revert, tag create/delete/push, badge drag-to-merge |
| Sidebar | checkout, branch create/rename/delete, set-upstream, stash save/apply/pop/drop |
| Sync | fetch, pull (merge/rebase), push, force-push-with-lease |
| Recovery | auto-stash on checkout/pull/merge, reflog reset, op abort/continue, 3-way conflict resolver |

---

## 1. Positioning

| | AS-IS | TO-BE |
|---|---|---|
| Identity | A Git client that replaces Fork | A **read-first Git browser with a minimal branch tool** |
| Writes | commit, staging, stash, push, rebase, reset, cherry-pick, revert, tag | branch create/rename/delete, checkout, fetch/pull |
| Relationship to Fork | competition | **division of labour** — riff reads, Fork writes |

The one-line description in `README.md` changes from "소스 컨트롤(스테이징·
changelist·커밋) … fetch/pull/push … stash" to a browser-first sentence. See
§9 Phase 4.

## 2. Screens

The four-screen structure **stays**. Each screen is already defined by *what it
diffs*, and that axis survives the reduction intact.

```
Mode bar:  [Working Copy]  [History]  [Compare]  [Blame]   ⎇main ↑3↓1  ⟳Fetch  ↓Pull
┌────────┬─────────────────────────────────────────────────────────────────┐
│ refs   │  Working Copy → left: changed files (read-only)                  │
│ sidebar│                 right: HEAD ↔ working tree diff                  │
│ Ctrl+B │  History      → left: graph + commit list                        │
│        │                 right: parent..commit diff                       │
│ Local  │  Compare      → two-ref compare (unchanged)                      │
│ Remotes│  Blame        → per-line authorship + timelapse (unchanged)      │
│ Tags   │                                                                  │
│        │  Sidebar context menu: checkout · new branch · rename · delete   │
└────────┴─────────────────────────────────────────────────────────────────┘
```

| Screen | Diffs | Writes |
|---|---|---|
| Working Copy | HEAD ↔ working tree | none (conflict resolver only, §6) |
| History | parent ↔ commit | none |
| Compare | ref A ↔ ref B | none |
| Blame | file line ↔ commit | none |
| refs sidebar | — | branch create / rename / delete / checkout |
| toolbar | — | fetch / pull |

**Default landing screen stays Working Copy.** Opening the app to "what did I
change" is still the right first question after the reduction.

The **Stashes section is removed** from the sidebar. The **Tags section stays**
— read-only, as a checkout and compare target.

## 3. Backend — the command surface is the contract

### Delete (30 commands)

| Group | Commands |
|---|---|
| Staging / commit | `stage` `unstage` `discard_paths` `commit` `commit_paths` `head_commit_message` |
| Hunks | `file_hunks` `apply_hunks` `discard_hunks` |
| Changelists | `load_changelists` `save_changelists` |
| Stash | `stash_list` `stash_save` `stash_apply` `stash_drop` `stash_checkout` `stash_pull` `stash_merge` `stash_rebase` |
| History rewriting | `reset` `rebase` `cherry_pick` `revert` `merge` |
| Remote writes | `push` `push_tag` `set_upstream` |
| Tags | `create_tag` `delete_tag` |
| Other | `force_checkout` |

Each deletion spans four layers: the `src/lib/git.ts` binding, the
`#[tauri::command]` wrapper in `src-tauri/src/lib.rs`, its entry in
`generate_handler!` (`src-tauri/src/lib.rs:774`), the `GitLayer` trait method
(`src-tauri/src/git/mod.rs`), and the `GitCli` implementation plus any
`#[test]` that covers it.

### Keep — the 11 write commands

`create_branch` · `rename_branch` · `delete_branch` · `checkout` ·
`fast_forward` · `fetch` · `pull` · `resolve_conflict` ·
`checkout_conflict_side` · `op_abort` · `op_continue`

Command count: **78 → 48** (11 write + 20 read + 17 settings/store).

### `pull` loses its `rebase` parameter

`pull(path, rebase: bool)` becomes `pull(path)` — merge only. `git pull
--rebase` rewrites local commits, and "riff never rewrites history" is the
cleanest form of the §1 invariant. The command palette loses `Pull (rebase)`.

### Types that go with them

`Stash` and `Hunk` become unreferenced once their commands are gone — delete
both from `src-tauri/src/git/mod.rs`, from the `use git::{…}` list at
`src-tauri/src/lib.rs:8`, and their mirrors `Stash` `Hunk` `Changelist` from
`src/lib/types.ts`. `StatusEntry` keeps **both** `index_status` and
`worktree_status`: a file staged from Fork must still render correctly in a
read-only Working Copy. `RepoStatus.ahead`/`behind`/`upstream` stay — they drive
the sidebar badge and the pull target.

### Why no runtime guard

Once a method is gone from the `GitLayer` trait there is no way to call it —
`GitCli::run` is private. The trait *is* the whitelist. Adding a runtime
subcommand allowlist or a source-grep test would be defending against code that
does not exist.

### Recommended refactor: `git/write.rs`

Move the 11 surviving write implementations out of `cli.rs` into a new
`src-tauri/src/git/write.rs` (a second `impl GitCli` block, ~250 lines). The §1
invariant then holds as a **file boundary**: every line that mutates a
repository lives in one small file. `cli.rs` is still ~2,100 lines after the
deletions, so it needs a seam regardless.

Reference points for the move: `checkout` `cli.rs:1852`, `fast_forward`
`cli.rs:1868`, `resolve_conflict` `cli.rs:1922`, `checkout_conflict_side`
`cli.rs:1937`, `rename_branch` `cli.rs:1956`.

## 4. Frontend

### Delete outright (≈1,470 lines)

| File | Lines | Why |
|---|---|---|
| `src/lib/ui/CommitBox.svelte` | 233 | commit editor |
| `src/lib/ui/StashesOverlay.svelte` | 253 | stash panel |
| `src/lib/ui/CheckoutDialog.svelte` | 221 | "stash / bring / discard?" strategy picker |
| `src/lib/ui/OpRecoveryDialog.svelte` | 217 | same question on the op-failure path |
| `src/lib/changelists.ts` | 326 | changelist model + index round-trip (`changelists.ts:266`) |
| `src/lib/ui/changesSelect.ts` + `.test.ts` | 69 + 152 | multi-selection, which existed for bulk stash/move |

`CheckoutDialog` and `OpRecoveryDialog` both exist to ask which auto-stash
strategy to retry with. With auto-stash gone there is nothing to ask: checkout
runs, and if git refuses, its stderr goes to the error banner unchanged.

### Rewrite / shrink (≈2,130 lines removed)

| File | Lines | Removing |
|---|---|---|
| `ChangesList.svelte` → `WorkingCopyList.svelte` | 971 → ~350 | staged/unstaged split, changelist groups, drag-and-drop, multi-select, context menu |
| `sourceControl.ts` → `workingCopy.ts` | 662 → ~250 | commit, stash, staging, discard, undo-commit. Keeps status load, conflict helpers, fetch/pull |
| `RefsSidebar.svelte` | 1040 → ~700 | Stashes section, tag actions, merge, set-upstream |
| `CommitList.svelte` | 1024 → ~750 | commit context menu (`:278`–`:295`), badge drag-to-merge |
| `git.ts` | 662 → ~430 | 30 bindings |
| `SyncControls.svelte` | 189 → ~120 | push button, force-push |
| `commands.ts` | 145 → ~90 | Stash and Commit categories, push, pull-rebase |
| `ReflogOverlay.svelte` | 290 → ~250 | the reset action (`:58`) |
| `reflog.ts` | 51 → ~35 | `resetToReflog` (`:28`) |
| `checkout.ts` | 128 → ~40 | dirty pre-check + strategy selection; keeps `runCheckout` + `refreshAfterCheckout` |

`store.svelte.ts` drops the write-side state: `stashes` `stashesOpen`
`changelists` `hunkAssignments` `hunksByFile` `commitSubject` `commitBody`
`commitAmend` `commitSignoff` `commitCoauthors` `committing` `recovery`, and the
Changes multi-selection.

### Untouched

`DiffView` · `ConflictView` · `BlameView` · `Timelapse` · `ImageDiff` ·
`SubmoduleDiff` · `FileList`/`TreeNode`/`PathTreeNode` · `BranchPicker` ·
`BranchContainment` · `RepoChip`/`RepoTabs`/`TabBar` · `CommandPalette` ·
`ShortcutsOverlay` · `UnrealSettings` · `graph.ts` · `compare.ts` ·
`workspace.ts` · `history.ts` · `commitHistory.ts` · `diff/*`.

Every asset that makes riff worth using survives untouched.

**Estimated total: ~4.8k lines removed (frontend ~3.6k, Rust ~1.2k), about 18%
of the codebase.** Estimates, not measurements — the plan should not treat them
as acceptance criteria.

## 5. reflog stays, read-only

`reflog` belongs to "browsing commit history", and it closes the loop on the one
destructive operation that survives:

> Deleted a branch by mistake → find the SHA in the reflog → **create a branch
> there** (surviving write #1) → recovered.

Remove only `resetToReflog` (`reflog.ts:28`, which runs `reset --hard`). Keep
the listing and the "create branch at this SHA" action (`ReflogOverlay.svelte:62`).
This is also what makes it safe to keep branch deletion.

## 6. Conflicts — the one write exception

`pending_op` detection → conflicted file list in Working Copy → 3-way resolver →
`op_continue` / `op_abort`. This path is kept as-is.

Two consequences worth recording:

- **The resolver is operation-agnostic.** It reads index stages 1/2/3
  (`conflict_versions`, `cli.rs:1896`), so it works the same for a merge, a
  rebase, or a cherry-pick. A repository left mid-rebase by Fork opens correctly
  in riff. Do not add a guard against that — it works, and blocking it would only
  make riff less useful.
- **Deleting `stage` does not break conflict resolution.** `resolve_conflict`
  (`cli.rs:1932`) and `checkout_conflict_side` (`cli.rs:1951`) run `git add`
  internally.

So Working Copy's rule is: *read-only in the normal state; the resolver opens
only when the repository is in a conflicted state.*

## 7. Seams to Fork

Where riff can't help, it must point somewhere rather than dead-end.

| Situation | riff's response |
|---|---|
| Pull, no upstream | "이 브랜치는 아직 원격에 없습니다 — Fork에서 첫 push를 하세요" |
| Pull conflicts | 3-way resolver (§6) |
| Checkout refused by git | git's stderr verbatim, plus "변경을 정리한 뒤 다시 시도하세요" |
| User wants to commit | **nothing** |

The last row is deliberate. A persistent "commit in Fork" hint in Working Copy
becomes nagging on every visit. The identity is declared **once**, in the README
and the v2.0.0 changelog.

Note that dropping `set_upstream` costs nothing in practice: checking out a
remote branch makes git create a tracking branch automatically, so pull has a
target. A branch *created* in riff has no upstream, which is exactly the case
the first row covers.

## 8. Naming policy — rename only what is rewritten

The user-facing label becomes **Working Copy**. Files being rewritten anyway get
renamed with it: `sourceControl.ts` → `workingCopy.ts`, `ChangesList.svelte` →
`WorkingCopyList.svelte`.

**Deliberately not renamed:** the `AppMode` string literal `"changes"`
(`types.ts:115`), `changesRepoIdx`, `setChangesRepo`, `changesRepoPath`,
`enterChangesMode`, and the `changes_file_diff` command. Renaming them would
touch a dozen files that this change otherwise leaves alone, for no behavioral
gain. This is a recorded decision, not an oversight.

## 9. Implementation phases

Frontend first. That way, by the time the backend commands are deleted, "nothing
calls this" is already proven. The reverse order leaves the tree uncompilable for
a long stretch.

**Phase 1 — cut entry points, remove UI**
1. `commands.ts`: drop Stash/Commit categories, push, pull-rebase.
2. Delete `CommitBox` `StashesOverlay` `CheckoutDialog` `OpRecoveryDialog`; clean
   up their references in `+page.svelte` (mode block ≈`:460`–`:545`).
3. `ChangesList` → `WorkingCopyList`, read-only; delete `changelists.ts` and
   `changesSelect.*`.
4. `RefsSidebar`: remove Stashes section, tag actions, merge, set-upstream.
5. `CommitList`: remove the commit context menu and badge drag-to-merge.
6. `SyncControls`: remove push. `ReflogOverlay`: remove the reset action.
- *Verify:* `npm run build`, `svelte-check`, `vitest` green; all four screens
  render and navigate by hand.

**Phase 2 — `sourceControl.ts` → `workingCopy.ts`**
Reduce to status loading, conflict helpers, and fetch/pull. Strip the write-side
fields from `store.svelte.ts`.
- *Verify:* `vitest` green.

**Phase 3 — backend deletion**
1. Delete the 30 `git.ts` bindings.
2. Delete the 30 `#[tauri::command]` wrappers and their `generate_handler!`
   entries.
3. Delete the `GitLayer` methods, the `GitCli` implementations, and the tests
   that covered them.
4. Move the surviving 11 write methods to `git/write.rs`.
- *Verify:* `cargo test` green, `cargo clippy` clean, and
  `grep -rn "stash\|commit\|push\|rebase\|cherry" src-tauri/src/git/` returns
  only comments, doc text, and read-path uses (`commit_log`, `commit_containment_detail`).

**Phase 4 — documentation and release**
1. Rewrite `README.md`: one-line description, workspace-mode table, Changes →
   Working Copy section, Graph section without the action list, shortcut table.
2. Add a `> **SUPERSEDED** by docs/superpowers/specs/2026-08-12-…` banner to the
   top of `docs/version-control-plan.md`. Do not delete it — it is the record of
   why the expansion was tried.
3. `CHANGELOG.md` v2.0.0: identity statement, removal list, rationale. It must be
   the top `## ` section — the release workflow extracts the text between the
   first and second `## ` lines as the GitHub Release body.
4. Bump the version in `package.json`, `src-tauri/tauri.conf.json`,
   `src-tauri/Cargo.toml`; `cargo check` to sync `Cargo.lock`; commit; tag
   `v2.0.0`; push the tag. Publishing the resulting draft release is manual.

Each phase is independently releasable, and all four gates (`cargo test`,
`vitest`, `npm run build`, `svelte-check`) must be green at every phase boundary.

## 10. Data and settings

`.git/riff-changelists.json` is **left in place** in existing repositories. It
stops being read; deleting it would destroy user data for no benefit and would
foreclose reverting.

No `PersistedState` field is removed — `compare_mode` already only has the
`"branch"` value, and the workspace/layout/UE settings are all orthogonal to this
change.

## 11. Out of scope

- Any new feature. This spec only removes.
- An "Open in Fork" button or external-tool integration (§7 decides against
  hinting at all).
- Renaming internal `changes*` identifiers (§8).
- Splitting `cli.rs` any further than the `write.rs` extraction in §3.
- Reworking the multi-root/submodule workspace, the Unreal asset pipeline, or the
  diff engine.

## Manual test checklist

Run against the dogfood repository `C:\workspace\sandbox` (nested-submodule
Unreal project) plus a plain single-root repo.

- **Working Copy:** modify a tracked file, add an untracked file → both listed
  with status badges; clicking shows HEAD↔worktree diff; a `.uasset` shows the
  derived property view. **No** stage/unstage/discard/stash/commit affordance
  exists in the row, its context menu, or the palette.
- **Branch:** create a branch from the sidebar; rename it; check it out; delete
  it; find its SHA in the reflog and recreate it there.
- **Checkout with a dirty tree:** checkout a branch that does not conflict →
  succeeds, changes carried over. Checkout one that does → error banner with
  git's message, working tree unchanged, **no** strategy dialog.
- **Pull:** on a behind-only branch → fast-forwards. On a branch with no upstream
  → the §7 message. On a divergent branch with a conflicting change → conflict
  banner, resolver opens on the conflicted file, `Continue`/`Abort` both work.
- **Rebase started in Fork:** leave a repo mid-rebase with conflicts, open it in
  riff → conflicted files are listed and the resolver works.
- **History:** graph renders with lanes, badges, and the WIP node; commit
  right-click offers **no** reset/cherry-pick/revert/rebase; dragging a badge
  does nothing; double-clicking a remote branch still checks out + fast-forwards.
- **Blame + Timelapse:** unchanged, including drill-in and `Esc` back.
- **Compare:** unchanged, including three-dot/two-dot and submodule diffs.
- **Palette (`Ctrl+Shift+P`):** no Stash or Commit entries, no Push, no
  Pull (rebase); checkout entries and navigation still present.

## Success criteria

- The only repository-modifying operations reachable from the UI are branch
  create/rename/delete, checkout, fetch, pull, and conflict resolution.
- `src-tauri/src/lib.rs` exposes 48 commands; the 30 listed in §3 are gone from
  all four layers.
- The four screens, blame, timelapse, submodule handling, multi-root workspace,
  and Unreal asset previews behave exactly as in v1.3.0.
- `cargo test`, `vitest`, `npm run build`, and `svelte-check` are green; `cargo
  clippy` reports no warnings.
- README and CHANGELOG state the new identity; `version-control-plan.md` is
  marked superseded rather than deleted.
