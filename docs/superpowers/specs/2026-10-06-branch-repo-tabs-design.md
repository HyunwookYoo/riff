# Branch Mode Repo Tabs — Design Spec

**Date:** 2026-10-06
**Version:** targets the release after v2.2.0
**Follows:** `2026-09-29-branch-mode-clarity-design.md` (v2.2.0), which added
the scope bar, the full-width commit table and the base ← compare model. This
spec changes how a person gets into and out of one repo in Branch mode, and
what the scope bar says once they are there.

## Why

After v2.2.0 shipped, the user asked how to get into a submodule in Branch
mode. The answer took a paragraph: in the default Unified layout, Focus is the
small `→` button at the right end of a repo's header in the Files list
(`src/lib/ui/FileList.svelte:237-247`). Clicking the repo's name in that
header only folds its files, and so does clicking a group header in the commit
table. The other way in is the Tabs layout, a setting at the bottom of the repo
chip's popover. The README still says clicking the name enters Focus
(`README.md:67`), which has been wrong since `a8f937b` (2026-05-26).

Asked what was hard, the user picked three things:

1. **Finding the way in.** Nothing visible says a repo can be entered.
2. **Knowing where you are once inside.** The scope bar reads
   `following sandbox: master pins 5e1c0aa ← feature/x pins b93f7d2`, which
   names the two commits but not that they are this repo's base and compare.
3. **Knowing how to get back.** Three exits are spread around the screen: the
   header's `←`, `Esc`, and the scope bar's `× All repos`.

They did not pick "Focus and Tabs are two separate mechanisms", so the Tabs
layout stays as it is.

Working Copy and History already answer all three questions with one control:
a tab strip under the toolbar (`RepoTabs`, `src/routes/+page.svelte:509-513`).
Branch mode is the only mode without one.

## Decisions

Settled with the user while designing (mockups were shown for 1 and 2):

| # | Question | Decision |
|---|----------|----------|
| 1 | How to enter a repo | **A repo tab strip** under the toolbar, the same component Working Copy and History use, with an extra **All repos** tab first. Rejected: an `Open ›` button on each group header (you still have to find the group), and a repo dropdown in the toolbar (hides the list, and sitting next to the pickers it suggests they change with the repo). |
| 2 | Where the strip shows | Branch mode, **Unified layout**, two or more repos. The Tabs layout keeps its own tab bar. |
| 3 | What a tab shows | Name, kind badge (none for the super repo, as in the other modes), and one status mark from the commit table's data. |
| 4 | The scope bar | Reads like the toolbar: `base X ← compare Y` first, then where those two came from. Hidden on the super repo's tab in both layouts. No `× All repos`. |
| 5 | Other `pin` wording | Group headers (`pinned by sandbox: …`) and diff pane labels (`(master's pin)`) stay. The scope bar spells out what they mean. |
| 6 | The Files header's `→` / `←` | Stays, as a second way in. |

## Design

### The repo tab strip

Shown when `appMode === "compare"`, `workspaceLayout === "unified"` and
`repos.length > 1`. It takes the place the Tabs layout's `TabBar` occupies,
between the banners and the scope bar.

Tabs, left to right: **All repos**, then every repo in workspace order.

- **All repos** is active while nothing is focused
  (`appState.activeRepoIdx === null`). Clicking it calls `exitFocus()`.
- A repo's tab is active while that repo is focused. Clicking it calls
  `enterFocus(idx)`.
- Both are already idempotent: clicking the active tab does nothing, and no
  second compare runs.
- `Esc` keeps its current order: it pops the drill-in history first (the
  breadcrumb's Back), then leaves Focus. The tab strip follows because it reads
  `activeRepoIdx`.
- Dragging to reorder is **off** in Branch mode. Reordering repos while Branch
  mode has state for them is a known bug (the commit table's groups, the pick
  and the collapsed set are keyed by index and are not remapped). Working Copy
  and History keep dragging.

Focus itself does not change. `enterFocus` still narrows `compare()` to the
focused repo, and `exitFocus` still lists every repo again.

### The tab's status mark

Each repo tab carries one mark, from `appState.repoRanges[idx]` and
`appState.bcGroups[idx]`. The commit table loads a group for every repo with a
range, whatever is focused (`loadOnce` in `src/lib/branchContainment.ts`), so
the marks on other tabs stay current while one repo is focused.

| State | Mark | Tooltip |
|-------|------|---------|
| No range resolved yet | none | — |
| The repo has no range (a `RangeGap`) | `—` | the scope bar's sentence for that gap (below) |
| No group yet, or the group is loading | `…` | `reading commits…` |
| The group failed | `!` | `couldn't read commits: <error>` |
| Ready, with ● commits (`groupCounts(g).out > 0`) | `● N` | — |
| Ready, nothing left to merge | `✓` | — |

`groupCounts` already turns a detected squash (or content match) into
`out = 0`, so a squash-merged branch shows `✓`. A group whose verdict is
`no-net-change` keeps its ● count, the same as its group header. The All repos
tab carries no mark; the commit table's summary line has the totals.

### The scope bar

The scope bar shows while a submodule or manual repo is the one on screen: the
focused repo in Unified, the active tab in Tabs. It no longer shows for the
super repo in either layout, because the toolbar already is the super repo's
pair. That matches what Tabs does today for its main tab.

It reads like the toolbar: this repo's two sides first, then where they came
from, then one button.

| Situation | Scope bar |
|-----------|-----------|
| Submodule following the super repo (`gitlink`) | `Plugins` `submodule` · `base 5e1c0aa ← compare b93f7d2` · `the commits sandbox's master and feature/x point to` · **Pick its own branches…** |
| Repo on its own branches (`repo.override` set) | `Plugins` `submodule` · `base [picker] ← compare [picker]` · `Plugins' own branches` · **Back to sandbox's commits** (a manual repo: **Back to same names**) |
| Manual repo on same-named branches (`same-name`) | `tools` `manual` · `base master ← compare feature/x` · `same branch names as sandbox` · **Pick its own branches…** |
| `unchanged` | `unchanged: sandbox's master and feature/x point to the same commit 1a2b3c4` · **Pick its own branches…** |
| `added` | `only in feature/x: sandbox's master doesn't have Plugins` · **Pick its own branches…** |
| `removed` | `removed in feature/x: only sandbox's master has Plugins` · **Pick its own branches…** |
| `absent` | `not in sandbox's master or feature/x` · **Pick its own branches…** |
| `no-refs` | `pick base and compare first` · **Pick its own branches…** (not "in the toolbar": the same sentence is the tab tooltip of a repo whose own branches miss a side) |
| `error` | `couldn't resolve: <message>` · **Pick its own branches…** |
| Range not resolved yet | `…` · **Pick its own branches…** |

What the buttons do does not change. **Pick its own branches…** is today's
`Compare own branches…`: it seeds the repo's override with what is on screen,
so nothing moves until a ref is picked. **Back to …** is today's
`Follow sandbox` / `Use same names`: it clears the override.

Refs and SHAs go through `shortRef`, as everywhere else. `sandbox` is the super
repo's display name, `master` / `feature/x` the toolbar pair, and `Plugins` the
repo on screen. A possessive of a name ending in `s` takes a bare apostrophe
(`Plugins' own branches`, `assets' commits`); any other name takes `'s`
(`sandbox's master`).

## Components

- **`src/lib/ui/RepoTabs.svelte`**: three optional props, with defaults that
  keep Working Copy and History exactly as they are.
  - `allLabel?: string` and `onall?: () => void`: when `allLabel` is set, a
    first tab with that label is active while `value` is `null`, and clicking
    it calls `onall`. `value` widens to `number | null`; `onselect` still
    receives a repo index.
  - `mark?: (idx: number) => TabMark | null`: a mark after a repo tab's kind
    badge, with its own tooltip and tone.
  - `reorderable?: boolean` (default `true`): `false` turns off drag-to-reorder
    and drops "drag to reorder" from the tab tooltip.
- **`src/lib/types.ts`**: `TabMark = { text: string; tone: "out" | "in" |
  "muted" | "error"; title?: string }`.
- **`src/lib/branchContainment.ts`**:
  `repoTabMark(range: RepoRange | undefined, group: BcGroup | undefined,
  repoName: string, superName: string, pair: ToolbarPair): TabMark | null`,
  by the table above. It sits next to `summarize` because it reads a group the
  same way; the names are for the gap tooltip.
- **`src/lib/rangeText.ts`**:
  `scopeLine(range: RepoRange, repoName: string, superName: string, pair:
  ToolbarPair)` replaces `scopeText`. It returns either
  `{ kind: "sides", base, compare, why }` for a range to compare or
  `{ kind: "note", text }` for a gap, with the strings above. For `override`
  the `why` is `<repo>' own branches` / `<repo>'s own branches`, and for
  `toolbar` (only the super repo, whose bar is hidden) it is
  `the toolbar's base and compare`. The gap text is also the tab mark's
  tooltip. A `possessive(name)` helper applies the apostrophe rule.
  `scopeText` and its tests go.
- **`src/lib/ui/ScopeBar.svelte`**: renders `scopeLine`, the renamed buttons
  and the override pickers in the new order. Hidden on the super repo's tab in
  both layouts. The `× All repos` button goes.
- **`src/routes/+page.svelte`**: renders `RepoTabs` for Branch mode under the
  conditions above, wired to `enterFocus` / `exitFocus`, with `mark` built
  from `repoTabMark`.
- **`README.md`**: the multi-root section describes the tab strip as the way
  in and out of a repo and fixes the stale "click the name to Focus" line. The
  Tabs layout bullet and the Branch mode section use the new scope bar wording.
  The CHANGELOG section is written at release time, once the version is chosen.

## Out of scope

- The Tabs layout's `TabBar` (it only picks up the new scope bar wording,
  because both layouts share `ScopeBar`).
- `Ctrl+Tab` / `Ctrl+1…9`, which stay Tabs-layout only.
- The commit table's and the diff panes' `pin` wording.
- Fixing reordering in Branch mode. This spec only keeps the strip from
  triggering it.
- Merging the Unified and Tabs layouts.

## Edge cases

- **One repo:** no strip, as in the other modes.
- **Many repos or long names:** the strip scrolls sideways and a tab ellipsizes
  past 240px, both from `RepoTabs` as it is.
- **Switching Tabs → Unified:** Focus is released today, so All repos is
  active.
- **A commit picked in the table:** the Files list shows that commit; the strip
  still shows the repo on screen (All repos or the focused repo).
- **Drill-in back / forward:** restores `activeRepoIdx` from its snapshot, and
  the strip follows.
- **A pair change while focused:** a tab whose range changed shows `…` until
  its group reloads (a group whose range did not move is kept as it is); the
  focused repo stays focused.

## Testing

- `repoTabMark`, in `branchContainment.test.ts`: no range, each gap (`—` with
  the `scopeLine` note as tooltip), no group, loading, error, ready with ●,
  ready with nothing left, and a squash-landed group showing `✓`.
- `scopeLine`, in `rangeText.test.ts`: `gitlink`, `same-name`, `override`,
  `toolbar`, and every gap, replacing the `scopeText` tests; `possessive` with
  a name that ends in `s` and one that does not.
- `npm test` and `npm run check` pass.
- The repo has no Svelte component test setup, so the wiring is checked by hand
  in `npm run tauri dev` on `C:\workspace\sandbox`:
  1. The strip shows in Branch mode only in Unified with two or more repos; not
     in Tabs, not with one repo.
  2. A repo tab enters it (Files and commit table narrow, the tab is
     highlighted); All repos and `Esc` come back.
  3. Marks show `…` while loading, then `● N` / `✓` / `—`. The `—` tooltip
     explains the gap.
  4. Dragging a tab does nothing in Branch mode, and still reorders in Working
     Copy and History.
  5. The scope bar reads as in the table for a gitlink submodule, after
     **Pick its own branches…**, after **Back to sandbox's commits**, and on the
     super tab (hidden). It has no `× All repos`.
  6. The Tabs layout looks and behaves as before apart from the scope bar
     wording.
