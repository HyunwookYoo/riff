# Rebase Conflict Preview — Design Spec

**Date:** 2026-11-05
**Version:** targets the release after v2.4.0

## Why

The user does not know, before a rebase starts, whether it will stop on a
conflict. In riff today the answer only comes by running it: the plain rebase
asks "N commits will be rewritten" in a native dialog, the interactive one
starts from the plan editor's Start button, and a conflict shows up afterwards
as the conflict banner.

They used Fork, which checks first, and liked it: a green check meant "safe to
rebase", a yellow warning triangle meant "this will conflict". Knowing ahead
mattered for a second reason. When they resolve conflicts by hand they make
mistakes, so for a rebase that will conflict they ask an AI (Claude Code in a
terminal) to do the rebase and resolve it. Today they ask in their own words
("rebase this") and let the AI find its way. A preview tells them which way to
go, and which commit and files the AI should be careful with.

## Goals

1. **Know before rebasing.** Wherever riff starts a rebase, show the outcome
   first: ✓ (green) no conflicts expected, or ⚠ (yellow) a conflict expected,
   naming the first commit that conflicts and its conflicting files.
2. **See it in Branch mode.** The Branch screen compares base and compare;
   show what rebasing compare onto base would do, as information only.
3. **Hand a conflicting rebase to an AI.** Next to ⚠, a "Copy request for AI"
   button puts a ready-to-paste request on the clipboard: the repo, what to
   rebase onto what, the commit expected to conflict and its files, and
   instructions to resolve carefully.

## Non-goals

- No AI inside riff: no API key, no model calls, no terminal launching. The
  request is text the user pastes where they already talk to the AI.
- No rebase button in Branch mode (the user asked for the result only).
- No resolving conflicts in the preview, and no guessing past the first
  conflict (see "Only up to the first conflict").
- No merge-conflict preview (merge is not part of this request).

## Anti-goals

- The check must never touch the working tree, the index, HEAD or any ref. A
  preview that moves or stashes anything is worse than none.
- ✓ must not be shown when riff could not tell. An unknown outcome (old git,
  an error) says so; it never reads as safe.
- The check must not make starting a rebase feel slow or block the UI; a
  long branch shows "checking…" while it runs.

## How it works (decided)

**The simulation.** Replay the commits a rebase would replay, in its order,
onto the target, using `git merge-tree --write-tree --merge-base=<commit's
parent>` (git 2.40+; this machine has 2.43) — the same three-way merge a
cherry-pick does, computed without a working tree. Each clean step yields the
tree the next one builds on. The first step that reports conflicts stops the
run, keeping that commit and its conflicted paths. `merge-tree` writes objects
to the object store but no ref; that is acceptable.

- **Which commits.** The ones `rebase_plan` already lists (`--right-only
  --cherry-pick --no-merges`, oldest first): what `git rebase` itself replays.
  Nothing to replay is its own outcome: "nothing to rebase".
- **Only up to the first conflict.** How the user resolves that commit
  changes everything after it, so later commits are not checked. The ⚠ text
  says later commits may conflict too.
- **Older git.** Below 2.40 the check reports "can't check (needs git
  2.40+)" and the rest of riff works as today.

**Outcomes.** One of: ✓ no conflicts (N commits replay cleanly); ⚠ conflict
at commit `<short sha> <subject>` (k of N), files listed; nothing to rebase;
can't check (reason). While running: "checking…".

## Where it shows

1. **Plain rebase (refs sidebar and commit list "Rebase … onto …").** The
   native confirm dialog can only show text, and ⚠ needs a copy button, so
   the confirmation becomes an in-app overlay (styled like the rebase plan
   editor): the existing wording (N commits rewritten, reflog recovery,
   "riff will end up on X") plus the preview line, and buttons Rebase,
   Cancel and, on ⚠, Copy request for AI. Rebase stays available on ⚠: the
   user may still choose to resolve it themselves. *(My call: overlay rather
   than a second dialog.)*
2. **Interactive rebase plan editor.** The preview line sits above the Start
   button, and the conflicting commit's row carries ⚠ with its files. The
   check follows the plan as edited — order, drop, squash and fixup (which
   replay like pick for conflict purposes), edit — and re-runs after each
   change, the newest run winning.
3. **Branch mode.** In the commit table's summary bar: "rebase onto
   <base>: ✓" or "⚠ conflict at <sha>", with the files in its tooltip and the
   copy button beside it. With several repos on screen, each repo group's
   header carries its own mark. It runs automatically when the table loads
   and re-runs when either side moves (the same triggers the table already
   reloads on). Works for remote-tracking compare refs too, since nothing is
   checked out.

## The AI request

Plain text in Korean (the language the user writes to the AI in — *my
call*), for example:

```
<repo path> 에서 <branch> 를 <target> 위로 rebase 해줘.
riff 미리 보기에서 conflict 가 예상돼:
- <short sha> "<subject>" (N개 중 k번째): <file1>, <file2>
이후 커밋도 conflict 가 날 수 있어.
conflict 마다 양쪽 커밋의 의도를 확인하고 해결해. 의도가 애매하면 멈추고 물어봐.
끝나면 각 conflict 를 어떻게 해결했는지 요약해줘.
```

Branch mode words it as "rebase <compare> onto <base>" with the repo's own
path (a submodule's path for a submodule group). For an interactive plan the
request also lists the edited plan (action and commit per line), since that
is what the AI must reproduce.

## Details settled (my calls, after a builder read the draft)

- **Same arguments as the rebase.** Both entry points run plain `git rebase
  [-i] --autostash <upstream> [<branch>]` (`src-tauri/src/git/write.rs`); no
  `--onto`, and the plan editor's target is fixed. The check uses those same
  `upstream` and `branch`: replay `rebase_plan(upstream, branch)` (or the
  edited steps) onto `upstream`'s tip. Branch mode uses upstream = base,
  branch = compare.
- **Squash and fixup are exact as picks.** git applies a squash or fixup
  commit's diff on top of the current result and then folds the commits
  together; the tree each step builds on is the same as picking it. So no
  hedge is needed for them, including after a reorder or a dropped
  neighbour. `edit` is a pick that pauses; also exact.
- **Every conflict kind is ⚠.** Content, add/add, modify/delete, rename,
  binary (`.uasset`) and submodule-pointer conflicts all count, each path
  listed. When `merge-tree` names the kind, show it next to the path (for
  example `binary`, `submodule`); otherwise the path alone.
- **Unusual states are "can't check" or "nothing to rebase", never ✓.**
  Nothing to replay (compare already on base, or behind it): "nothing to
  rebase". Unrelated histories, a missing ref, a shallow clone missing a
  parent, or any git error: "can't check (<reason>)". A submodule group's
  request names the submodule's own working directory (absolute path), the
  directory the AI must run git in.
- **No time cap.** The check always runs to completion, one git process per
  commit, off the UI thread, showing "checking k/N…". A newer run (refs
  moved, plan edited, mode left) supersedes it and the old one stops at its
  next step. A cap would add a fourth outcome that tells the user nothing.
- **Copy request for AI shows on ⚠ only.** For an interactive plan the
  request lists the edited plan, one line per commit: action, short SHA,
  subject.

## Constraints

- Tauri 2 + Svelte 5 runes, git CLI backend, like the rest of riff.
- Read-only toward the repo's working tree, index, HEAD and refs.
- A stale result (refs moved, plan edited, mode left) must never land over a
  newer one; follow the sequence-token pattern used elsewhere
  (`branchContainment.ts`).
- Tests: backend fixtures for clean, conflicting-at-commit-k, nothing to
  replay, and a reordered/dropped plan; frontend tests for staleness and the
  request text.

## Left to the builder

- Exact component split, store fields, and how the backend streams or
  returns the result.
- Performance tactics for long branches (each step is one git process), as
  long as the UI shows "checking…" and stays responsive.
- Exact wording and styling beyond what is written here.
