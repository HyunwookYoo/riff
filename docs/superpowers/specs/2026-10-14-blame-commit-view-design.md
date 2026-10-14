# Blame Commit View — Design Spec

**Date:** 2026-10-14
**Version:** targets the release after v2.3.0
**Follows:** `2026-10-06-branch-repo-tabs-design.md` (v2.3.0). This spec changes
what a person sees after following a commit out of Blame mode, and adds a way
to blame a file as it was before a commit.

## Why

The user asked what Blame mode could do better and named two things: a commit
opened from Blame shows neither its subject nor its description, and the SHA is
hard to look at.

Reproduced on the installed v2.3.0 with `studio-docs`, blaming
`knowledge/INDEX.md` and pressing `→` on commit `a0339e32`:

1. **No message.** The subject only appears, truncated, in the commit table's
   one row. The body is nowhere. Graph mode has a Commit tab that shows it
   (`src/lib/ui/CommitDetail.svelte`), but a Blame drill-in lands in Branch
   mode, which has no such panel.
2. **The SHA, seven times.** `a0339e32^ ← a0339e32` is printed in the base and
   compare pickers, the breadcrumb, the commit table's group header, the Files
   header, the diff header and both pane labels. Each copy is short; together
   they are the screen. `^` is git notation the screen never explains.
3. **Branch wording for one commit.** The drill-in is a Branch compare
   (`pushAndDrillToCommit` in `src/lib/history.ts`), so it shows "● 1 not
   merged", a status of "not in a0339e32^", "Show merged commits", the
   `direct (..)` dropdown and the Compare button.
4. **The wrong file.** The diff opens the range's first file
   (`.claude/skills/promote/SKILL.md`), not the file being blamed.
5. **A stale breadcrumb.** It read `(was: ← (since fork))` because the
   previous context had empty refs.

Asked what to include, the user picked all four of: a commit message header,
fewer SHAs, opening the blamed file, and blaming the version before a commit.

## Decisions

Settled with the user while designing (a mockup of both screens was shown):

| # | Question | Decision |
|---|----------|----------|
| 1 | How the drill-in presents | **A commit view**: the same Branch screen, shown differently while its range is the drilled commit. Rejected: a commit card above the unchanged Branch screen (the merge wording stays), and sending the drill to Graph mode (an old commit is not on the graph's first page; submodules and Back get tangled). |
| 2 | Where the message goes | A **commit card** in the commit table's place: subject, author, date, parent, file count, and the body, folded past six lines. |
| 3 | Where the SHA goes | Once, in the toolbar (`Commit a0339e32`, click to copy). The diff header drops its pair, the pane labels read `before` / `after`, and the Files header reads `Commit a0339e32 · 102 files`. |
| 4 | Which file opens | The blamed file, under its path at that commit, scrolled to the blamed line. |
| 5 | Older blame | **Blame before this** on the line popover and on each commit panel row. It re-blames the file at the commit's parent in place, with a bar naming the revision, **← Back** and **Back to HEAD**. |

## Design

### The commit view

`pushAndDrillToCommit` is called only from Blame mode (`BlameView.svelte`, the
popover's **View commit →** and the commit panel's `→`). It becomes:

```ts
pushAndDrillToCommit(
  sha: string,
  repoIdx: number | undefined,
  from: { path: string; line: number } | null,
): Promise<void>
```

1. Read the commit first: `commitLog(repoPath, sha, false, 1, 0)` returns it
   with `parents` and `body`. The card needs it, and so does the range: the
   base becomes `parents[0] ?? EMPTY_TREE`, the same rule `openCommit` uses.
   This fixes the root-commit drill, which today asks for `<sha>^` and fails
   (a v2.3.0 follow-up).
2. Push the context and switch to Branch / two-dot as today, with the full SHA
   as the target, on the main repo's pair or the repo's override as today.
3. Set `appState.commitView`:

```ts
interface CommitView {
  repoIdx: number;       // the repo the commit belongs to
  base: string;          // parents[0] ?? EMPTY_TREE
  target: string;        // full SHA
  commit: Commit;        // subject, body, author, time, parents
  from: { path: string; line: number } | null;  // the blamed file, at that commit
}
```

4. Call `compare()` so that it selects `from.path` in `repoIdx` (see "Opening
   the blamed file").

If reading the commit fails, nothing is pushed. The error goes to
`appState.error` ("couldn't open commit a0339e32: …") and Blame mode stays.

**When it shows.** `commitViewActive()` is true when `appState.commitView` is
set, `appMode` is `"compare"`, and the drilled repo's current range is exactly
`base..target`: the toolbar pair for the main repo, or the repo's override
otherwise. Anything that moves the range drops back to the ordinary Branch
screen. Nothing clears `commitView` eagerly, and `CompareCtx` carries it, so
Back and Forward restore it with the rest of the context.

**What changes while it shows:**

| Place | Ordinary Branch screen | Commit view |
|-------|------------------------|-------------|
| Toolbar, second row | base / compare pickers, `direct (..)`, Compare | `← Back` · `Commit` `a0339e32 ⧉` · repo name (for a submodule or manual repo) · `from blame of knowledge/INDEX.md`. `ws`, the theme and UE stay. |
| Breadcrumb row | `← Back · Viewing … (was: …)` | hidden (Back is in the toolbar) |
| Repo tab strip, scope bar | shown per v2.3.0 | hidden |
| Commit table | groups of commits | the commit card |
| Files header | `All changes · a0339e32^ ← a0339e32` | `Commit a0339e32 · 102 files` |
| Diff header | the range pair | nothing |
| Pane labels | `base · a0339e32^` / `compare · a0339e32` | `before` / `after` |

`⧉` copies the full SHA and shows the same toast Blame's SHA button does
(`Copied <sha>`). The short SHA shown everywhere is the commit's first eight
characters, the form Blame's gutter uses.

**The card** sits in the commit table's pane, keeps its resizer and its
collapse, and scrolls on its own:

- the subject, bold, wrapped;
- `author · 2026-10-01 14:22 (1w ago) · parent b0913cc1 · 102 files`;
  - a merge commit: `merge · 2 parents · diff against the first parent`
    replaces `parent …`;
  - a root commit: `first commit` replaces `parent …`;
- the body, `white-space: pre-wrap`, folded past six lines behind
  `Show full message ▾` / `Show less ▴`; nothing when the body is empty.

The file count is `appState.files.length` and reads `…` while files are still
streaming. The card is not selectable, so there is no picked-commit state and
no `bcSelected`.

### Opening the blamed file

The drill-in names the file and line it came from:

- **Path:** the path the file had *at that commit*, which differs from the HEAD
  path when the file was renamed later. `git blame --porcelain` gives it per
  commit as `filename <path>`; the parser starts keeping it.
- **Line:** the line's number *in that commit's version of the file*.
  Porcelain gives it per line as `<orig-line>` in each group header; the parser
  starts keeping it (`line_orig`). From the popover it is the hovered line's;
  from the commit panel it is that commit's first line's.

`compare()` already selects a remembered path while files stream in, but it
matches on the repo index of the file that was selected *before* the compare,
which the drill (and Back) clear first. As a result, a remembered path never
matches, and Back has never reopened the file it says it restores. `compare()`
gains `preserveRepoIdx?: number | null`, used instead of the old selection's
index when given. `CompareCtx` gains `selectedFileRepoIdx`, and `applyCtx`
passes it. If the file is not in the commit's list (for example, `-w` hid a
whitespace-only change), the first file opens, as today.

**Scrolling to the line.** `appState.revealLine = { repoIdx, path, line }`.
When `DiffView` mounts that file, it scrolls the after-side editor so the line
is centred, then clears `revealLine`. This takes precedence over the per-tab
scroll memory. The line is one the commit changed, so it sits in a shown chunk,
not a collapsed run.

### Blame before this

**The action.** The line popover gets `↶ Blame before this` after
`View commit →`. Each commit panel row gets a `↶` button next to its `→`, shown
on hover like `→`. Both are hidden for uncommitted lines. When the commit has
no parent version of the file, both are disabled with the tooltip "this commit
added the file". That covers a root commit and the commit that created the
file.

**The data.** Porcelain prints `previous <sha> <path>` for every commit whose
parent had the file, under the path it had there. The parser keeps it, so the
rename case comes free:

```rust
pub struct BlamePrevious { pub sha: String, pub path: String }  // full SHA
pub struct BlameCommit {
    pub sha: String, pub author: String, pub author_time: i64, pub summary: String,
    pub filename: String,                  // path at this commit
    pub previous: Option<BlamePrevious>,   // None: this commit added the file
}
pub struct Blame { pub commits: Vec<BlameCommit>, pub line_commit: Vec<usize>,
                   pub line_orig: Vec<usize> }   // 1-based, parallel to line_commit
```

**The state.** `appState.blameRev: BlameRev | null`:

```ts
interface BlameRev {
  rev: string;                               // full SHA of the parent
  path: string;                              // the file's path there
  before: { sha: string; summary: string };  // the commit we stepped past
  line: number | null;                       // where to scroll once loaded
}
```

`null` means the file at HEAD with working-copy edits, exactly as today.

**Stepping back.** `blameBefore(commit, lineInCommit)` pushes a snapshot, clears
the forward stack, and sets `blameRev`. `appMode` stays `"blame"`, and
`blameTarget` stays the HEAD file, so the picker keeps its highlight. The line
to scroll to is mapped from the commit's version to the parent's:

1. Read both versions with the new `read_file_at(path, rev, file_path)`: the
   commit's under `filename`, the parent's under `previous.path`.
2. Diff them with `@codemirror/merge`'s `diff` (already a dependency).
3. `mapLineBack(oldText, newText, changes, newLine)` in `src/lib/blameRev.ts`:
   a line after every change moves by the line delta of the changes above it.
   A line inside a change maps to that change's first old line, or for a pure
   insertion to the old line at the insertion point. The result is clamped to
   the old file.

The parent's text is the text the view loads anyway. If the map cannot be made
(the commit's version fails to read), `line` is the commit's own number,
clamped.

**Loading.** `BlameView.load` reads `blameRev`:

- At HEAD: `readRepoFile` + `blameFile(…, "HEAD", true)`, as today.
- At a revision: `read_file_at(repo, rev, path)` + `blameFile(…, rev, false)`.

The blame cache key gains the revision (`"HEAD"` for today's entry). Once the
editor mounts, it scrolls `line` to the centre and marks it with a focus
decoration until the next click in the editor.

**The bar.** While `blameRev` is set, a bar sits between the file header and
the editor:

`← Back` · `Blame at b0913cc1 — before a0339e32 <subject>` · (`as old/path.md`
when `path` differs from the HEAD path) · `Back to HEAD`

- **← Back** and `Esc` pop one frame (`popHistory`), the same stack the commit
  drill uses.
- **Back to HEAD** pops while `appMode === "blame"`, `blameRev` is set, and
  frames remain. Each popped frame goes onto the forward stack.
- Picking another file in the picker blames that file at HEAD and clears
  `blameRev`; the frames stay, so Back returns to the older view.
- The commit panel's header reads `Commits · at b0913cc1`.

**Round trips.** `CompareCtx` gains `blameTarget` and `blameRev`. `snapshot()`
and the drill capture them, and `applyCtx` restores them when
`ctx.appMode === "blame"`. A drill from an older blame works as from HEAD: the
commit view's `from` comes from the older blame's `filename` and `line_orig`.

**Unchanged at a revision:** Timelapse still plays the HEAD path's history, and
the gutter, peer highlight, sort modes and popover work as at HEAD. There are
no uncommitted lines.

### The breadcrumb

The breadcrumb renders only when `appMode === "compare"` and the commit view is
not active. In Blame mode the revision bar carries Back. Its `(was: …)` text
skips an empty pair instead of printing `← (since fork)`.

## Components

- **`src-tauri/src/git/blame.rs`**: keep `filename`, `previous` and
  `line_orig`; `BlamePrevious`. The doc comment on `BlameCommit.sha` changes:
  the drill no longer builds `<short>^`, because the full SHA comes from
  `commitLog`.
- **`src-tauri/src/git/mod.rs`, `cli.rs`, `lib.rs`**: `read_file_at(path, rev,
  file_path) -> String`, `git show <rev>:<path>` behind `validate_ref` and
  `validate_path`, with the 2 MB cap and lossy UTF-8 of `read_repo_file`.
  Registered as a command.
- **`src/lib/git.ts`**: `readFileAt`; `EMPTY_TREE` exported once, replacing the
  private copies in `repoRange.ts`, `branchContainment.ts` and
  `commitHistory.ts` (a v2.3.0 follow-up; `history.ts` would have made it four).
- **`src/lib/types.ts`**: `BlamePrevious`, `BlameCommit.filename/previous`,
  `Blame.line_orig`, `CommitView`, `BlameRev`; `CompareCtx` gains
  `selectedFileRepoIdx`, `commitView`, `blameTarget`, `blameRev` (each read
  with `?? null`, as `overrides` is).
- **`src/lib/store.svelte.ts`**: `commitView`, `blameRev`, `revealLine`.
- **`src/lib/history.ts`**: the new `pushAndDrillToCommit`; `blameBefore`;
  `backToHead`; snapshot / applyCtx carry the new fields;
  `commitViewActive()`.
- **`src/lib/blameRev.ts`** (new): `mapLineBack`.
- **`src/lib/compare.ts`**: `preserveRepoIdx`.
- **`src/lib/rangeText.ts`**: `paneLabels` returns `before` / `after` when
  asked for the commit view.
- **`src/lib/ui/CommitCard.svelte`** (new): the card.
- **`src/lib/ui/InputBar.svelte`**: the commit view's second row in place of
  `BranchModeFields`, `direct (..)` and Compare.
- **`src/lib/ui/Breadcrumb.svelte`**: the conditions above.
- **`src/lib/ui/FilesScope.svelte`**, **`DiffView.svelte`**,
  **`src/routes/+page.svelte`**: the commit view's header, pane labels, hidden
  diff range, hidden strip and scope bar, card in the commit table's pane, and
  `revealLine`.
- **`src/lib/ui/BlameView.svelte`**: pass `from` on drill; `↶` on the popover
  and rows; load at a revision; the bar; the cache key; the focus line.
- **`README.md`**: sections 4 and 5 describe the commit view and Blame before
  this. The CHANGELOG section is written at release time.

## Out of scope

- A commit view for drills from anywhere else. Blame is the only caller.
- Blaming at an arbitrary revision picked from a list. Only "before this
  commit", step by step.
- Following a rename forward. Back to HEAD returns to the HEAD path.
- Timelapse at a revision.
- Graph mode's Commit tab, which keeps its own layout.
- Ignoring whitespace or moves differently from today's `-w -M`.

## Edge cases

- **Root commit:** the drill diffs against the empty tree; the card says
  `first commit`; `↶` is disabled.
- **Merge commit:** diffed against the first parent, as Graph does; the card
  says so.
- **Submodule or manual repo:** the drill sets that repo's override as today
  and focuses it. The toolbar names the repo. The strip and scope bar are
  hidden. Back restores the overrides, as today.
- **Renamed file:** the drill opens it under its old path; `↶` blames it under
  the parent's path and the bar says `as <path>`.
- **The commit's file missing from the list** (whitespace-only under `ws`): the
  first file opens.
- **Nested:** commit view → Blame (at HEAD, as today) → drill → Back → the
  commit view, with its card and file restored.
- **A range change while in the commit view** (switching modes and editing the
  range elsewhere): the ordinary Branch screen returns; Back still pops.
- **A blame at a revision that fails** (for example, a shallow clone without
  the parent): the view shows the error as it does today; Back still works.
- **The commit read fails on drill:** nothing is pushed; the error banner
  explains.

## Testing

- **Rust, `blame.rs`:**
  - `filename`, `previous` (a path with spaces), and `line_orig` parse;
  - a commit without `previous` gives `None`;
  - repeated groups keep the first commit's metadata.
- **Rust, `cli.rs`:**
  - `read_file_at` reads a file at an older revision in a temp repo;
  - it rejects a bad ref and a `..` path;
  - it errors on a path missing at that revision.
- **`blameRev.test.ts`:** `mapLineBack` before any change, after a change
  (shifted by the delta), inside a modification, inside a pure insertion,
  next to a deletion, and clamped past the end.
- **`history.test.ts`:**
  - the drill reads the commit and uses `parents[0]`, or `EMPTY_TREE` for a
    root commit;
  - it sets `commitView` and `revealLine` and passes `preserveRepoIdx`;
  - a failed read pushes nothing;
  - `commitViewActive` is true for the drilled range and false after a range
    change;
  - `blameBefore` pushes and sets `blameRev`;
  - Back restores `blameTarget` and `blameRev`;
  - `backToHead` pops only revision frames;
  - Back reopens the file in the right repo.
- **`rangeText.test.ts`:** the commit view's pane labels.
- `npm test`, `npm run check` and `cargo test` pass.
- **By hand**, in `npm run tauri dev`, on `studio-docs` and on
  `C:\workspace\sandbox` (a submodule file):
  1. Blame a file, then `→` on a commit. The toolbar shows `Commit <sha>`, the
     card shows the subject and body, the blamed file is selected and scrolled
     to the line, and no `^` pair is on screen.
  2. **Show full message** folds and unfolds a long body. `⧉` copies the full
     SHA.
  3. `Esc` and `← Back` return to Blame on the same file.
  4. `↶` on a line blames the parent and scrolls to the line. The bar names
     both commits. Back, Esc and Back to HEAD work.
  5. `↶` is disabled on the commit that added the file.
  6. A renamed file opens under its old path in both features.
  7. A submodule file's commit opens in the commit view with the repo named.
  8. The ordinary Branch screen is unchanged.
