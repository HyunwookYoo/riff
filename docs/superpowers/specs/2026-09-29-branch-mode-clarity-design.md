# Branch Mode Clarity — Design Spec

**Date:** 2026-09-29
**Version:** targets v2.2.0
**Follows:** `PLAN.md` §13 (multi-root workspace) and the v2.1.2 containment
fix (`bf5e93c`), which made the containment pane follow Focus but left the
semantics below untouched.

## Why

Dogfooding Branch mode on a nested-submodule Unreal workspace surfaced three
complaints:

1. It is hard to tell whether a comparison is about the super repo or a
   submodule.
2. The file changes show up, but it is not clear which branch is which: the
   pickers are split into "start" and "target", and neither word says what role
   the branch plays.
3. The "is this commit in the target?" check is just as confusing, and its pane
   is too small to read.

Reading the code turned up concrete causes for each.

**The two panels use the one pair of pickers with opposite roles.** The file
list runs `git diff start...target` (`src-tauri/src/git/cli.rs:1051`), so start
is the base and target is the branch being reviewed — GitHub's PR model, with
the base on the left pane and the reviewed branch on the right. The containment
pane lists *start's* commits and marks whether each is in target
(`src/lib/branchContainment.ts:122`, tooltip "Your branch (start)" at
`src/lib/ui/BranchContainment.svelte:94`), so there start is the reviewed branch
and target is the merge destination — GitLab's MR model. Set the pickers so the
diff is right and the commit pane lists the base branch's history; set them so
the commit pane is right and the diff shows what the base did. The `→` between
the pickers reads as "old → new" for one panel and "merges into" for the other.
Everything else in riff — the diff, history drill-in (`sha^`..`sha`), the graph's
per-commit view, the test fixtures — already treats start as the old side.

**The containment list is start's entire history.** The few commits that matter
sit among hundreds of dimmed ✓ rows.

**Scope is never stated.**
- When Focus moves to a submodule, the toolbar pickers silently start editing
  that submodule's per-repo override. Their placeholder ("follow gitlinks") is
  the only hint.
- A gitlink-followed submodule is compared between two commits the super repo's
  refs pin, but neither the SHAs nor where they came from appear anywhere in the
  file list: its group header shows a range only when an override is set
  (`src/lib/ui/FileList.svelte:241`), although `PLAN.md` §13.3 #11 asked for it.
- In Unified view without Focus, the file list holds every repo while the commit
  pane describes only the super repo.
- The diff header shows a file path, not which repo or which two refs it is
  between.

**A drill bug.** With Focus on a submodule, clicking a commit in the containment
pane empties the file list. v2.1.2 made the pane follow Focus, but the drill path
is still main-only: `compare.ts:165` skips every non-main repo while
`bcDiffRange` is set, the Focus filter then skips main too, and
`DiffView.svelte:179` handles `bcDiffRange` only for `repoIdx === 0`. (Found by
reading the code; the regression test in the implementation will confirm it.)

**The pane is small.** It takes 48% of the height of the left column
(`src/routes/+page.svelte:808`), which is 300px wide by default and 600px at
most, with no splitter.

**The per-repo range rules are written three times and have drifted.**
`compare.ts` (`fetchRepoChanges`), `branchContainment.ts` (`resolveContext`) and
`workspace.ts` (`resolveDiffRefsFor`) each resolve "which two refs does repo N
compare". `resolveContext` returns nothing for a manual repo without an
override, while compare and the diff fall back to same-name branches.
`resolveDiffRefsFor` returns a range for a submodule whose two pins are equal,
while compare skips it. v2.1.2's bug was the same kind of disagreement.

## Decisions

Settled in a brainstorming session on 2026-09-29.

| # | Decision | Rejected alternative |
|---|---|---|
| 1 | Branch mode serves both questions at once, with one branch pair: "what does this branch change?" (PR review) and "are its commits in the base?" (merge check). | Optimizing for only one of them. |
| 2 | **GitHub model.** Left picker = `base`, right picker = `compare`, with `←` between them (compare merges into base). The toolbar order matches the diff panes. The diff keeps its meaning; the commit pane flips. | GitLab `source → target`: the toolbar order would contradict the diff panes, and the diff, drill-in and graph paths all assume start is the old side. |
| 3 | **The toolbar pickers always edit the super repo's pair.** Focus and tabs only filter what is shown; they never change what the pickers mean. A submodule's own branch pair is edited from a scope bar. | Pickers editing the focused repo's pair (today's behavior), made visible with a repo prefix. |
| 4 | **Full-width commit table on top, Files \| Diff below**, like Graph mode's list over detail. Resizable and collapsible. | Three columns (Commits \| Files \| Diff) — the diff gets too narrow; keeping the stacked left column with a splitter — still too narrow. |
| 5 | **Unmerged first.** The table lists only the commits compare has that base lacks. When there are none it says so in one line and names the merge that brought them in; a toggle lists the merged commits. | Compare's full history with merged rows dimmed. |
| 6 | UI strings stay English, like the rest of riff. | — |
| 7 | The internal fields keep their names: `startBranch` is the base and `targetBranch` is compare. A comment at their declaration pins the mapping. | Renaming them across history, graph, `CompareCtx` and tests — a large diff with no behavioral gain. |
| 8 | **Assume squash merges are in use, and detect them.** The workspace's own history says so: of the last 300 first-parent commits on `origin/master`, sbx-idl has 279 squash merges and no merge commits, while sandbox and Sandbox/Plugins merge their PRs mostly with merge commits. | Leaving squash-merged branches reported as ● not merged, as a known limitation. |

## The semantic model

### What each surface answers

| Surface | Question | Git |
|---|---|---|
| Files and diff | What did compare change since it forked from base? | `base...compare` (unchanged), or `base..compare` in two-dot mode |
| Commit table | Which of compare's commits are not in base yet? | list `git log compare --not base`; marks from `containment(source = compare, target = base)` |
| Behind count | What does base have that compare lacks? | the left side of `rev-list --left-right --count base...compare`, already in `Containment.behind` |

Marks: ● not in base; ◐ in base by content rather than by ancestry — an
equivalent patch (`git cherry`: rebased or cherry-picked) or a squash merge (see
[Squash detection](#squash-detection)); ✓ in base by ancestry (only shown when
merged commits are listed).

For containment itself the backend does not change. The frontend passes compare
as `source` and base as `target` to the existing `containment` and
`commit_containment_detail` commands, and uses the existing, currently unused
`commitLogExcluding` binding for the list. Squash detection adds one command.

The diff-mode select gets meaningful labels: `since fork (...)` for three-dot and
`direct (..)` for two-dot.

**Display names.** Every string below names a range's two sides the same way.
For `toolbar`, `override` and `same-name` ranges the names are the refs
themselves (`main`, `feature/x`). For a `gitlink` range they are the pins, named
after the super refs that set them: `main's pin` and `feature/x's pin`, with the
short SHA where there is room (`main's pin (5e1c0aa)`).

### One range resolver

A new `src/lib/repoRange.ts` owns the rule "which two refs does repo N compare,
and why", and replaces all three copies.

```ts
type RangeSource = "toolbar" | "gitlink" | "override" | "same-name";
type RangeGap = "no-refs" | "unchanged" | "added" | "removed" | "absent" | "error";

type RepoRange =
  | {
      ok: true;
      path: string;
      base: string;
      compare: string;
      source: RangeSource;
    }
  | { ok: false; reason: RangeGap; pin?: string; message?: string };
```

For `gitlink`, `base` and `compare` are the pinned SHAs; the super repo's refs
that pinned them are `appState.startBranch` and `appState.targetBranch`, which
the display reads directly.

| Repo | Rule |
|---|---|
| main | The toolbar pair. Either side empty: `no-refs`. |
| submodule with an override | The override. Either side empty: `no-refs`. |
| submodule without an override | The commits the super repo's base and compare pin (`submoduleShaAt`). Missing at base only: `added`. Missing at compare only: `removed`. Missing at both: `absent`. Equal: `unchanged`, with `pin`. |
| manual with an override | The override. Either side empty: `no-refs`. |
| manual without an override | The toolbar pair by name (`same-name`). |

A thrown `submoduleShaAt` becomes `error` with its message.

`resolveRepoRanges()` resolves every repo once and stores the result in
`appState.repoRanges` (indexed by repo). It re-resolves only when its inputs
change — the toolbar pair, the repo list and its overrides, and `refsRefresh` —
and concurrent callers share one in-flight resolution. `compare()` awaits it
before scanning; the commit table, `DiffView`, the group headers, the scope bar
and the diff header all read the stored result, so no two surfaces can describe
different ranges.

## Scope display

### Toolbar

- In a multi-repo workspace the super repo's name appears, muted, before the
  pickers (`sandbox  [base main ▾] ← [compare feature/x ▾]`).
- The pickers are labeled `base` and `compare` and always read and write
  `appState.startBranch` / `appState.targetBranch`.
- Override editing, the `Reset` button and the "follow gitlinks" /
  "default: …" placeholders leave the toolbar; they move to the scope bar.

### Group headers

The commit table and the file list use the same header text. The commit table
fits it on one line; the file list keeps its two-line header, and its range line
now appears for every repo instead of only for overrides.

| Range | Header text |
|---|---|
| `toolbar` | `main ← feature/x` |
| `gitlink` | `pinned by sandbox: 5e1c0aa ← b93f7d2`, tooltip `main pins 5e1c0aa · feature/x pins b93f7d2` |
| `override` | `own branches: develop ← feature/y` |
| `same-name` | `same names: main ← feature/x` |
| `unchanged` | `unchanged: both pin 1a2b3c4` |
| `added` | `only in feature/x (added)` |
| `removed` | `not in feature/x (removed)` |
| `absent` | `not in main or feature/x` |
| `no-refs` | `pick both refs` |
| `error` | `couldn't resolve: <message>` |

Groups whose range is not ok are dimmed and start collapsed.

### Scope bar

A thin bar under the toolbar, shown while Focus is active (Unified) or while a
non-main tab is active (Tabs).

| Focused repo | Scope bar |
|---|---|
| super | `sandbox [SUPER]` · `× All repos` |
| submodule following gitlinks | `Sandbox/Plugins [SUBMODULE] following sandbox: main pins 5e1c0aa ← feature/x pins b93f7d2` · `Compare own branches…` · `× All repos` |
| submodule or manual on its own branches | `… own branches: [base develop ▾] ← [compare feature/y ▾]` · `Follow sandbox` (submodule) or `Use same names` (manual) · `× All repos` |
| manual on same names | `shared-lib [MANUAL] same branch names as sandbox: main ← feature/x` · `Compare own branches…` · `× All repos` |
| range not ok | the reason text from the table above · `Compare own branches…` · `× All repos` |

`Compare own branches…` creates the override seeded with the range currently
shown (for a gitlink, the two pinned SHAs; for `unchanged`, the one pin on both
sides; for `added`, `removed` or `absent`, whichever side exists), so the screen
does not change until a ref is picked. `Follow sandbox` / `Use same names`
clears the override. `× All repos` exits Focus and is absent in Tabs, where the
tab bar does that job.

### Diff header and pane labels

The header above the diff shows the status badge; in a multi-repo workspace the
repo's kind badge and name (`[SUBMODULE] Sandbox/Plugins ›`); the path; and, on
the right, the range (`main ← feature/x`, `5e1c0aa ← b93f7d2`, or
`commit a41f2c9`).

A label row sits above the panes — two cells side by side, one line in unified
view (`<left> ← <right>`):

| Showing | Left | Right |
|---|---|---|
| Aggregate, three-dot | `base · main (merge-base)` | `compare · feature/x` |
| Aggregate, two-dot | `base · main` | `compare · feature/x` |
| Gitlink submodule | `base · 5e1c0aa (main's pin)` | `compare · b93f7d2 (feature/x's pin)` |
| One commit | `a41f2c9^ (parent)` | `a41f2c9 · <summary>` |

A single-repo workspace shows no repo badge, as today.

## The commit table

### Layout

Branch mode's body becomes three rows: the commit table, a horizontal resizer,
and the existing Files \| Diff pair (the file column keeps sharing
`--picker-width`). The table's height is session-only, like
`graphPanelHeight`. `▴` collapses the table to its summary line; `▾ show commits`
expands it again.

### Columns

mark · SHA · summary · author · date · status.

The status names the group's base: `not in main` / `in main`, or
`not in main's pin` / `in main's pin` for a gitlink submodule. A ◐ row says how
it got in: `applied as patch` (from `git cherry`), `squashed into 7f3a2c1`, or
`changes already in main` (from squash detection). Merge commits carry a muted
`merge` tag.

### Summary line

| State | Text |
|---|---|
| Unmerged, one group | `main ← feature/x: ● 8 not merged · ◐ 1 applied as patch · feature/x is 9 behind` |
| Unmerged, several groups | `main ← feature/x across 2 repos: ● 140 not merged · ◐ 1 applied as patch` |
| Only patches left | `✓ Every commit on feature/x is in main, 2 of them as patches (rebased, cherry-picked or squash-merged)` |
| Squash-merged | `✓ All changes on feature/x are in main — squash-merged as 7f3a2c1 "Add MCP import (#1677)" · Sep 23` |
| Content already in base | `✓ All changes on feature/x are already in main (content matches; no single squash commit found)` |
| No net change | `feature/x makes no net change against main` |
| Everything merged | `✓ All commits on feature/x are in main — merged by 3c9e2f1 "Merge branch 'feature/x'" · Sep 27` |
| Everything merged, no merge commit | `✓ All commits on feature/x are in main (fast-forward, no merge commit)` |
| No refs | `Pick base and compare to see which commits are merged.` |
| Same ref on both sides | `base and compare are the same.` |

With one group visible (Focus, a tab, or a single-repo workspace) the summary
uses that group's display names — `main's pin ← feature/x's pin` for a gitlink
submodule. With several visible it uses the toolbar pair and totals. Once every
visible group is in base — by ancestry, patch or squash — it reads
`✓ All changes on feature/x are in main across 2 repos`, and how each group got
there ("merged by", "squash-merged as") stays in the group headers. Behind counts
appear per group only; summing them across repos means nothing. The right end of
the line holds the `Show merged commits` toggle and `▴`.

Group headers carry the group's counts: `● 3 ◐ 1 · feature/x is 9 behind`
(behind only when non-zero), `✓ all in main · merged by 3c9e2f1`,
`◐ 3 · squash-merged as 7f3a2c1`, or `◐ 3 · content already in main`. While
squash detection runs, the header adds `checking for squash…`.

The "Only patches left" line covers single-commit squash merges too: a squash of
one commit has that commit's patch, so `git cherry` already reports it as ◐.

### What each group lists

- **Default:** `commitLogExcluding(path, compare, base)`, 100 at a time — the
  ● and ◐ commits. A `Load 100 more (37 left)` row ends the group while more
  remain; the count is the group's `Containment.ahead` minus the rows loaded.
  This replaces infinite scroll, which is ambiguous with several groups in one
  scroll area.
- **Only patches left** (no ●, some ◐): the default list already shows the ◐
  rows; there is no introducing merge to look up, because compare's tip is not
  in base.
- **Everything merged** (`Containment.ahead` is zero — no ● and no ◐):
  `commitContainmentDetail(path, compare, base)` on compare's tip gives the
  introducing merge M, or none for a fast-forward.
- **`Show merged commits` on:** with M known, `commitLogExcluding(path, compare,
  M.parents[0])` — exactly the commits M brought in — under a
  `brought in by 3c9e2f1` sub-header, marked ✓. Without M, or while only part of
  compare is merged, compare's history 100 at a time (`commitLog`), marked from
  the group's containment.

### Selecting a commit

Clicking a row selects that commit:

- `bcSelected = { repoIdx, sha }` and
  `bcDiffRange = { repoIdx, start: parents[0] ?? EMPTY_TREE, target: sha }`.
- `compare()` scans only that repo, two-dot. `DiffView` uses the range only when
  the selected file's `repoIdx` matches. This fixes the drill bug.
- The Files header states what is shown:

| Shown | Files header |
|---|---|
| Everything | `All changes · main ← feature/x` |
| A ● commit | `Commit a41f2c9 · sandbox — not in main` `[× All changes]` |
| A ◐ commit | `Commit 19c3e77 · sandbox — applied to main as a patch` `[× All changes]` |
| A squashed commit | `Commit 5ab17e0 · sbx-idl — squashed into main as 7f3a2c1 (Sep 23)` `[× All changes]` |
| A commit whose content matched | `Commit 5ab17e0 · sbx-idl — its changes are already in main` `[× All changes]` |
| A ✓ commit | `Commit 5d0e8a2 · sandbox — merged by 3c9e2f1 (Sep 27)` `[× All changes]` |

When squash detection found the group's changes in base, the "Everything" row
reads `All changes · main ← feature/x — already in main (squash-merged as
7f3a2c1)`. After a squash the three-dot diff still lists every change, because
the merge-base did not move; this suffix is what says they have landed.

The "merged by" part is looked up lazily on selection
(`commitContainmentDetail`), replacing today's detail strip under the pane.
Clicking the selected row again, `× All changes`, or the toolbar's `Compare`
returns to all changes. The ◆ "All changes" row goes away.

### Out of scope for v1

- Naming the base-side commit a `git cherry` ◐ row is equivalent to. `git cherry`
  reports only the compare side; pairing needs per-commit patch-id matching.
  Follow-up.
- Squash detection commit by commit, for a branch that kept going after its
  squash merge (see [Limits](#limits)). Follow-up.
- Keyboard navigation in the table. The file list's ↑/↓ are unchanged.
- A warning that a submodule pointer would move backward. Getting it right needs
  the merge-base pin; without it, the common case of the base advancing the
  pointer after the fork would be a false alarm.
- Persisting the table's height.

## Squash detection

A squash merge folds a branch's commits into one new commit S on the base. The
branch's commits are then neither ancestors of the base nor patch-equivalent to
any single base commit — S carries their sum — so containment alone reports
every one of them as ● forever, and the three-dot diff keeps listing all their
changes. Two signals that fail in different situations recover the answer:

1. **Patch-id match.** The patch-id of the branch's net change
   (`git diff <merge-base> <compare>`) against the patch-ids of the base commits
   since the fork. A match names S. S's own patch is fixed in history, so this
   still works after the base later edits the same lines. It misses when the base
   changed lines within the hunks' context between the fork and the squash,
   because context lines are part of the patch-id.
2. **Content check.** `git merge-tree --write-tree <base> <compare>` yields the
   base's own tree exactly when merging compare would change nothing — its
   changes are already there. This catches the context case the patch-id misses,
   but it cannot name a commit, and it conflicts once the base has edited the
   same lines after the squash. It needs git ≥ 2.38; on older git this signal is
   skipped, and the README says so next to the existing git 2.30 note.

Each claim above was checked against git 2.43 on throwaway repositories (plain
squash; squash then a later edit of the same line; a context-line edit before
the squash; both; a branch that kept going; an unmerged branch; a single-commit
squash). The Rust tests encode the same cases.

### The command

`squash_check(path, source, target) -> SquashCheck`, declared on `GitLayer`
(`src-tauri/src/git/mod.rs`), implemented in `cli.rs`, registered in `lib.rs`.
`source` is compare and `target` is base, as for `containment`.

```rust
pub enum SquashVerdict { None, NoNetChange, Squash, Content }

pub struct SquashCheck {
    pub verdict: SquashVerdict,
    /// The base commit whose patch equals the branch's net change (`Squash` only).
    pub squash_commit: Option<Commit>,
}
```

It stops at the first step that decides:

1. No merge-base (unrelated histories): `None`.
2. The net diff `merge-base..source` is empty (`git diff --quiet`):
   `NoNetChange`. This comes before step 3 so a branch that merged the base back
   in after its squash reads as "no net change" rather than "simply ahead".
   (Corrected while planning; the first draft had the two steps the other way
   round.)
3. `merge-base` equals `target`: the base has nothing since the fork, so it
   cannot hold a squash — `None`. The common "branch is simply ahead" case.
4. No non-merge base commit since the fork touches the branch's changed paths:
   `None`. When the branch touches too many paths for one command line, the path
   filter is dropped and the newest 300 base commits since the fork are used.
5. Patch-id the net diff and those candidates with `git patch-id --stable`, both
   sides diffed with the same options — `--binary` so binary changes hash by
   content, renames and textconv off so both sides describe a change the same
   way. A match: `Squash`, with the oldest matching commit.
6. Otherwise the content check: a clean `merge-tree` whose tree equals
   `target^{tree}` gives `Content`; a different tree or a conflict gives `None`.

### When it runs

The table renders from containment first. Only then, and only for groups that
still have ● rows (◐ from `git cherry` needs no explanation), the frontend calls
`squash_check` in the background; the group header shows `checking for squash…`
meanwhile. A `Squash` or `Content` verdict turns every ● row of the group into ◐
with the matching status, and the summary line, the group header and the Files
header switch to their squash forms. A `NoNetChange` verdict switches the
summary to its "no net change" line. The check reruns whenever the group
reloads, and the `bcSession` guard drops verdicts that arrive late.

### Limits

- **A branch that kept going after its squash merge.** Its net change is S plus
  the new commits, so neither signal matches and every commit stays ●. Checking
  commit by commit is a follow-up.
- **Edits on both sides of the squash.** If the base changed lines within the
  hunks' context before the squash *and* edited the same lines after it, both
  signals fail and the rows stay ●.
- **"Already in main" is a statement about content.** A branch whose identical
  change reached the base some other way reads the same — which is still true.

## State

`src/lib/store.svelte.ts`:

- Add `repoRanges: RepoRange[]`.
- Replace the single-repo containment state (`bcRefs`, `bcCommits`,
  `bcHasMore`, `bcLoadingCommits`, `loadingContainment`, `containment`,
  `containmentDetail`, `bcSelectedSha`) with:
  - `bcGroups: Record<number, BcGroup>`, where a group holds its load status and
    error, its commits and whether more remain, its `Containment` marks, its
    introducing merge once looked up, and its squash verdict (`checking` until
    `squash_check` answers);
  - `bcSelected: { repoIdx: number; sha: string } | null`, plus the selected
    commit's lazily loaded detail;
  - `bcShowMerged: boolean`;
  - `commitTableHeight: number` and `commitTableCollapsed: boolean`.
- `bcDiffRange` gains `repoIdx`.

Every group is loaded for each repo whose range is ok, whatever Focus or the
active tab is; Focus and tabs filter what is shown, so moving Focus reloads
nothing. In practice the groups are the super repo plus the few submodules whose
pointer moved. Each group loads independently (the git calls go through
`run`, which takes no lock), and the existing `bcSession` guard drops results
that arrive after the inputs changed.

## Files

| File | Change |
|---|---|
| `src/lib/repoRange.ts` (new) | The resolver, its types, `resolveRepoRanges()` |
| `src/lib/workspace.ts` | `resolveDiffRefsFor` moves into the resolver; the override setters stay |
| `src/lib/compare.ts` | Reads ranges; honors `bcDiffRange.repoIdx` |
| `src/lib/branchContainment.ts` | Per-group loading, flipped direction, introducing merge, merged-commits toggle, background squash check |
| `src/lib/store.svelte.ts`, `src/lib/types.ts` | The state above; `SquashCheck` |
| `src/lib/git.ts` | `squashCheck` binding |
| `src-tauri/src/git/mod.rs`, `src-tauri/src/git/cli.rs`, `src-tauri/src/lib.rs` | `squash_check` on `GitLayer`, its implementation and tests, the command registration |
| `README.md` | git ≥ 2.38 for the squash content check |
| `src/lib/ui/BranchModeFields.svelte` | `base` / `compare`, super pair only, no override editing |
| `src/lib/ui/ScopeBar.svelte` (new) | The scope bar |
| `src/lib/ui/BranchContainment.svelte` | Rewritten as `CommitTable.svelte` |
| `src/lib/ui/FileList.svelte` | Range line for every repo; Files header state |
| `src/lib/ui/DiffView.svelte` | Range by `repoIdx`; pane label row |
| `src/routes/+page.svelte` | Three-row Branch layout, resizer, diff header badges |
| `src/lib/ui/Breadcrumb.svelte` | `main ← feature/x (since fork)` notation instead of `main...feature/x` |
| `CHANGELOG.md` | Release notes |

The only Rust change is `squash_check`.

## Edge cases

- **Base or compare empty:** the table shows its hint; the file list is empty.
- **Same ref on both sides:** the table says so; the file list is empty.
- **Compare is a SHA** (drill-in, a commit picked elsewhere): works as a ref;
  labels show the short SHA. A drill-in (`sha^`..`sha`) lists that one commit.
- **Submodule pin equal, added, removed, or absent:** range not ok, group dimmed
  and collapsed with the reason. Added and removed submodules' file diffs stay
  skipped (§13.10).
- **Manual repo without the same-name branch:** that group shows the git error
  (`feature/x not found in shared-lib`); others are unaffected.
- **Override with one side cleared:** `no-refs`, shown as `pick both refs`.
- **Long divergence** (thousands of commits): lists page per group; the marks
  arrays are as large as today's.
- **Merge commit selected:** first-parent diff, as today. **Root commit:** the
  empty tree, as today.
- **Repo moves** (fetch, checkout, rebase, push, another tool): `refsRefresh`
  re-resolves ranges and reloads groups, as the pane does today.
- **Squash-merged branch:** reported through [Squash detection](#squash-detection);
  its [Limits](#limits) list the cases that still read as ●.
- **Git older than 2.38:** squash detection runs without its content check, so
  only patch-id matches are found.

## Error handling

- A range that fails to resolve becomes `error` for that repo only.
- A group whose containment or list read fails shows its error in the group;
  other groups render normally.
- A failed introducing-merge lookup drops "merged by" from the summary.
- A failed `squash_check` leaves the group's rows as containment reported them
  and clears `checking for squash…`.
- A failed file diff uses `DiffView`'s existing error display.

## Testing

Unit tests (vitest), mocking `./git` and `./store.svelte` the way
`workspace.test.ts` does:

- `repoRange.test.ts` — each source (`toolbar`, `gitlink`, `override`,
  `same-name`) and each gap (`no-refs`, `unchanged`, `added`, `removed`,
  `absent`, `error`); override precedence over gitlink; and the two drifts as
  regressions: a manual repo without an override resolves to `same-name`, and
  equal pins resolve to `unchanged`.
- `branchContainment.test.ts` — `containment` and `commitLogExcluding` are
  called with compare as the source and base as the target; an all-merged group
  looks up the introducing merge on compare's tip; the toggle lists from
  `M.parents[0]` when M is known and falls back to `commitLog` when not; a
  failing group does not affect the others; results from a stale session are
  dropped.
- A compare test for the drill: with `bcDiffRange.repoIdx` on a submodule, only
  that repo is scanned, with the commit's range.
- Squash in `branchContainment.test.ts` — the check runs only for groups with ●
  rows; `Squash` and `Content` turn ● rows into ◐ with their statuses;
  `NoNetChange` switches the summary; a failed check leaves the rows alone.

Rust tests in `cli.rs`, on real throwaway repositories built with the existing
`temp_repo` / `git_in` helpers, one per case: plain squash (`Squash`, naming S);
squash then a later edit of the same line (`Squash`, from the patch-id);
a context-line edit before the squash (`Content`, from merge-tree); the base
merged back into the branch after its squash (`NoNetChange`); a branch that kept
going (`None`, pinning the limit); an unmerged branch (`None`); a base with
nothing since the fork (`None` at step 3); and a branch touching more paths than
fit on one command line (`Squash`, found without the path filter).

`npm run check`, `npm test` and `cargo test` pass.

Manual verification on the nested-submodule Unreal workspace
(`C:\workspace\sandbox`):

1. A branch that changes only the super repo.
2. A branch that bumps a submodule pointer (gitlink).
3. A submodule compared on its own branches.
4. A merged branch (the "merged by" summary and the toggle).
5. A cherry-picked commit (◐).
6. Focus in Unified, and Tabs.
7. Clicking a submodule commit lists its files (the drill bug).
8. A squash-merged sbx-idl branch, compared on its own branches and through a
   super branch that pinned its pre-squash commit.

## Implementation order

Each step builds and tests on its own.

1. **Resolver and drill fix.** `repoRange.ts`, all consumers switched to it,
   `bcDiffRange.repoIdx`. No visible change beyond the fixes.
2. **Semantics and labels.** `base` / `compare`, the flipped commit direction,
   the summary sentences, the diff pane labels, the diff-mode labels, the
   breadcrumb.
3. **Scope display.** The toolbar invariant, the scope bar, range lines in group
   headers, the diff header.
4. **Commit table layout.** The top table and resizer, per-repo groups, the
   merged summary and toggle, the Files header states.
5. **Squash detection.** `squash_check` and its Rust tests, the binding, the
   background check and the squash forms of the table, headers and summary, the
   README note.
6. **CHANGELOG.**
