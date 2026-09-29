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

## The semantic model

### What each surface answers

| Surface | Question | Git |
|---|---|---|
| Files and diff | What did compare change since it forked from base? | `base...compare` (unchanged), or `base..compare` in two-dot mode |
| Commit table | Which of compare's commits are not in base yet? | list `git log compare --not base`; marks from `containment(source = compare, target = base)` |
| Behind count | What does base have that compare lacks? | the left side of `rev-list --left-right --count base...compare`, already in `Containment.behind` |

Marks: ● not in base; ◐ applied to base as an equivalent patch (`git cherry`,
i.e. rebased or cherry-picked); ✓ in base (only shown when merged commits are
listed).

The backend does not change. The frontend passes compare as `source` and base as
`target` to the existing `containment` and `commit_containment_detail` commands,
and uses the existing, currently unused `commitLogExcluding` binding for the
list.

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
does not change until a ref is picked. `Follow sandbox` / `Use same names` clears the override.
`× All repos` exits Focus and is absent in Tabs, where the tab bar does that job.

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

The status names the group's base: `not in main` / `applied as patch` /
`in main`, or `not in main's pin` / `in main's pin` for a gitlink submodule.
Merge commits carry a muted `merge` tag.

### Summary line

| State | Text |
|---|---|
| Unmerged, one group | `main ← feature/x: ● 8 not merged · ◐ 1 applied as patch · feature/x is 9 behind` |
| Unmerged, several groups | `main ← feature/x across 2 repos: ● 140 not merged · ◐ 1 applied as patch` |
| Only patches left | `✓ Every commit on feature/x is in main, 2 of them as patches (rebased or cherry-picked)` |
| Everything merged | `✓ All commits on feature/x are in main — merged by 3c9e2f1 "Merge branch 'feature/x'" · Sep 27` |
| Everything merged, no merge commit | `✓ All commits on feature/x are in main (fast-forward, no merge commit)` |
| No refs | `Pick base and compare to see which commits are merged.` |
| Same ref on both sides | `base and compare are the same.` |

With one group visible (Focus, a tab, or a single-repo workspace) the summary
uses that group's display names — `main's pin ← feature/x's pin` for a gitlink
submodule. With several visible it uses the toolbar pair and totals: the ✓ forms
appear only when every visible group qualifies, and "merged by" names the super
repo's introducing merge. Behind counts appear per group only; summing them
across repos means nothing. The right end of the line holds the
`Show merged commits` toggle and `▴`.

Group headers carry the group's counts: `● 3 ◐ 1 · feature/x is 9 behind`
(behind only when non-zero), or `✓ all in main · merged by 3c9e2f1`.

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
| A ✓ commit | `Commit 5d0e8a2 · sandbox — merged by 3c9e2f1 (Sep 27)` `[× All changes]` |

The "merged by" part is looked up lazily on selection
(`commitContainmentDetail`), replacing today's detail strip under the pane.
Clicking the selected row again, `× All changes`, or the toolbar's `Compare`
returns to all changes. The ◆ "All changes" row goes away.

### Out of scope for v1

- Naming the base-side commit a ◐ row is equivalent to. `git cherry` reports only
  the compare side, so this needs a new patch-id matching command. Follow-up.
- Keyboard navigation in the table. The file list's ↑/↓ are unchanged.
- A warning that a submodule pointer would move backward. Getting it right needs
  the merge-base pin; without it, the common case of the base advancing the
  pointer after the fork would be a false alarm.
- Persisting the table's height.

## State

`src/lib/store.svelte.ts`:

- Add `repoRanges: RepoRange[]`.
- Replace the single-repo containment state (`bcRefs`, `bcCommits`,
  `bcHasMore`, `bcLoadingCommits`, `loadingContainment`, `containment`,
  `containmentDetail`, `bcSelectedSha`) with:
  - `bcGroups: Record<number, BcGroup>`, where a group holds its load status and
    error, its commits and whether more remain, its `Containment` marks, and its
    introducing merge once looked up;
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
| `src/lib/branchContainment.ts` | Per-group loading, flipped direction, introducing merge, merged-commits toggle |
| `src/lib/store.svelte.ts`, `src/lib/types.ts` | The state above |
| `src/lib/ui/BranchModeFields.svelte` | `base` / `compare`, super pair only, no override editing |
| `src/lib/ui/ScopeBar.svelte` (new) | The scope bar |
| `src/lib/ui/BranchContainment.svelte` | Rewritten as `CommitTable.svelte` |
| `src/lib/ui/FileList.svelte` | Range line for every repo; Files header state |
| `src/lib/ui/DiffView.svelte` | Range by `repoIdx`; pane label row |
| `src/routes/+page.svelte` | Three-row Branch layout, resizer, diff header badges |
| `src/lib/ui/Breadcrumb.svelte` | `main ← feature/x (since fork)` notation instead of `main...feature/x` |
| `CHANGELOG.md` | Release notes |

No Rust changes.

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
- **Squash-merged branch** (known limitation, unchanged from today): a squash
  commit is neither an ancestor link nor patch-equivalent to the individual
  commits, so they stay ● `not in main` even though their content landed. The
  table reports ancestry truthfully; detecting squashes would need tree
  comparison and is out of scope.

## Error handling

- A range that fails to resolve becomes `error` for that repo only.
- A group whose containment or list read fails shows its error in the group;
  other groups render normally.
- A failed introducing-merge lookup drops "merged by" from the summary.
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

`npm run check` and `npm test` pass. No Rust tests are affected.

Manual verification on the nested-submodule Unreal workspace
(`C:\workspace\sandbox`):

1. A branch that changes only the super repo.
2. A branch that bumps a submodule pointer (gitlink).
3. A submodule compared on its own branches.
4. A merged branch (the "merged by" summary and the toggle).
5. A cherry-picked commit (◐).
6. Focus in Unified, and Tabs.
7. Clicking a submodule commit lists its files (the drill bug).

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
5. **CHANGELOG.**
