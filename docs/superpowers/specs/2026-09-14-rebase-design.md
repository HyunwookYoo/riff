# Rebase — Design Spec

**Date:** 2026-09-14
**Version:** targets v2.1.0 (additive)
**Amends:** `docs/superpowers/specs/2026-08-12-vcs-scope-reduction-design.md`,
which removed rebase along with the rest of the write surface. That spec's
invariant is widened here by exactly one operation; everything else it removed
stays removed.

## Why this comes back

The scope reduction was right about the failure mode — the removed write paths
were the unreliable ones — but rebase was collateral. Dogfooding v2.0.x turned
up the same gap repeatedly: the place you *notice* that a branch belongs on top
of another is the branch sidebar or the commit graph, both of which riff already
renders well, and the fix meant leaving for another tool to do one command.

Rebase also differs from the rest of what was cut in a way that matters here.
Commit and staging need riff to own a new piece of state — a message editor, an
index model. Rebase needs none: git's sequencer
owns the state, riff's existing conflict machinery already understands it
(`pending_op` has always reported `"rebase"`, and `op_continue` / `op_abort`
have always handled it, because another tool's half-finished rebase could
already be sitting in the repo when riff opened it), and the result is visible
in the graph riff is built to show.

## The amended invariant

> **riff modifies a repository in exactly six ways: create a branch, rename a
> branch, delete a branch, checkout, fetch/pull, and rebase.**
>
> **There is one exception — conflict resolution. riff cleans up the state its
> own pull or rebase created.**

Rebase carries `--autostash`, so it does set local changes aside and put them
back. That is not the stash feature v2.0.0 removed: it is git's, taken and
restored inside the single command, with no entry left behind and no UI of its
own. What v2.0.0 actually removed was riff's *own* stash-and-reapply
orchestration around checkout, pull and merge — code riff had to get right
across every failure path. Handing that to `git rebase` is the opposite move.

Still absent, and not up for reconsideration under this spec: commit, staging,
discard, stash, reset, cherry-pick, revert, tag writes, and merge as a command
of its own. (Push came back two days later, for reasons this spec created — see
`2026-09-16-push-design.md`.)

Pull stays merge-only. `pull --rebase` is a history rewrite hiding inside a
button that reads as "get the latest" — the rewrite riff does is the one the
user explicitly asked for by name.

## Interaction — two entry points, one rule

**The thing you point at is the destination.** That single rule covers both
gestures in both places:

| Surface | Drag and drop | Right-click |
|---|---|---|
| Branch sidebar (`RefsSidebar.svelte`) | drop local branch A on ref B → replay A onto B | menu on B → replay the current branch onto B |
| Commit graph (`CommitList.svelte`) | drop branch badge A on a commit row → replay A onto that commit | menu on a commit → replay the current branch onto it |

A drag names both ends, so it can move any local branch. A right-click names
only the destination, so it moves the current branch. Only local branches are
draggable: rebasing moves the branch it replays, and riff cannot move a
remote-tracking ref or a tag. Any ref can be a destination.

Each menu offers the operation twice — run it, or open the plan editor:

- `Rebase <branch> onto <target>` — a confirm dialog stating how many commits
  will be rewritten, then `git rebase`.
- `Rebase <branch> onto <target>… (plan)` — the plan editor, which is itself the
  confirmation: nothing runs until the user starts it there.

## The plan editor (`RebaseTodoOverlay.svelte`)

A direct editor for git's own todo list, top row first. Rows reorder by drag or
by ↑/↓ buttons (the buttons are not decoration — a drag is unusable from the
keyboard, and reordering is the point of the screen). Per row: `pick`, `squash`,
`fixup`, `edit`, `drop`.

**`reword` is deliberately absent.** It opens git's commit-message editor, and a
message editor is exactly the kind of state this spec refuses to bring back.
`squash` therefore keeps git's default combined message. The same reasoning
applies to `edit`: riff does not amend, it just stops there and hands the user
the conflict banner, which is useful precisely because the amending happens in
another tool.

The listed commits come from `rebase_plan`, which runs git's own selection —
`git log --reverse --topo-order --no-merges --cherry-pick --right-only
<upstream>...<branch>`. Verified against `git rebase -i`'s generated todo on git
2.43.0.windows.1, including the case where a commit's patch is already applied
upstream (both drop it). Showing a plan git then deviates from would be worse
than showing no plan at all.

## Mechanism — how the todo reaches git

`git rebase -i` insists on an editor for its todo, and a GUI app has no terminal
to open one in. riff points `GIT_SEQUENCE_EDITOR` at **its own executable**:

```
GIT_SEQUENCE_EDITOR="\"C:/…/riff.exe\" --rebase-todo \"C:/…/riff-rebase-<pid>.todo\""
```

git appends the todo path, so the helper receives `--rebase-todo <plan> <todo>`
and copies one over the other. `main.rs` handles that argv before Tauri starts,
so the run never opens a window. Both paths are quoted and written with forward
slashes — git hands the editor command to a shell, where a backslash is an
escape character.

Rejected alternatives:

- `GIT_SEQUENCE_EDITOR="cp <plan>"` — the usual trick, but it depends on git's
  bundled `cp` being on that shell's PATH.
- Two-phase dump (run `rebase -i` once with an editor that copies the todo out
  and fails, to read git's exact todo, then run it again for real) — an extra
  rebase invocation that has to leave no state behind on the failure path.
- Reimplementing the sequencer over `cherry-pick` — that is rebuilding what git
  already does, including every resume path.

`GIT_EDITOR` is `true` throughout, so no invocation can block on an editor.

## Safety

- **Local changes are stashed and put back, by git.** `--autostash` is passed
  explicitly rather than left to `rebase.autoStash`, so the behaviour is the
  same on every machine. A dirty tree therefore does not block a rebase —
  which is the point: the branch you want to move is usually the one you are
  working in. This is the one stash riff causes, and it is git's, taken and
  restored inside the one command; riff still has no stash feature, and never
  leaves an entry behind for the user to find.

  The exception that needs reporting: when the restore conflicts with what the
  rebase just wrote, git **exits 0** — the rebase did succeed — leaves conflict
  markers in the working tree and keeps the changes in the stash. Nothing else
  in the UI would say a word, so `autostash_conflicted` matches git's own
  sentence ("Applying autostash resulted in conflicts") on every command that
  can end a rebase — the initial call *and* `--continue` / `--skip` /
  `--abort`, since a stopped rebase ends in one of those — and the frontend
  shows what to do with the stash.

  `classifyGitError` still recognises rebase's dirty-tree refusals (`cannot
  rebase: You have unstaged changes` / `Your index contains uncommitted
  changes`); with `--autostash` riff's own invocation no longer hits them, but
  the strings stay classified rather than falling through as unknown.
- **The old tip stays recoverable.** Both confirmations say so and name the
  reflog panel (`Ctrl+Shift+R`), which already creates a branch at any entry.
- **A conflict is not reported as a failure.** `runRebase` re-reads
  `pending_op`; when a rebase is in progress the conflict banner owns the
  screen — Resolve / Continue / **Skip** / Abort. `Skip` (`git <op> --skip`) is
  new, and is offered for every sequencer op, not just rebase; a merge has no
  such step.
- **Nothing but a SHA reaches the todo file.** `build_todo` validates each step
  (7–40 hex characters) and refuses two plans git would accept but riff cannot
  honour: a leading `squash`/`fixup` (nothing to meld into) and a plan that
  drops everything (that is a reset to upstream, which riff does not do).

## Files

| File | Change |
|---|---|
| `src-tauri/src/git/mod.rs` | `RebaseStep` / `RebaseAction`; `rebase_plan`, `rebase`, `rebase_interactive`, `op_skip` on `GitLayer`; amended invariant doc |
| `src-tauri/src/git/write.rs` | `rebase_impl`, `rebase_interactive_impl`, `op_skip_impl`, `run_rebase`; pure `build_todo` / `sequence_editor_command` / `validate_sha` |
| `src-tauri/src/git/cli.rs` | `rebase_plan` (read-only) + trait wiring |
| `src-tauri/src/lib.rs` | four commands |
| `src-tauri/src/main.rs` | `--rebase-todo` mode |
| `src/lib/rebase.ts` | confirm → run → refresh, conflict hand-off, plan loading |
| `src/lib/ui/RebaseTodoOverlay.svelte` | the plan editor |
| `src/lib/ui/RefsSidebar.svelte`, `src/lib/ui/CommitList.svelte` | drag sources, drop targets, menu items |
| `src/lib/ui/ConflictBanner.svelte`, `src/lib/workingCopy.ts` | Skip; the autostash-conflict note |
| `src/lib/gitError.ts` | rebase's dirty-tree refusals |

## Verification

- Rust unit tests for the pure helpers: todo rendering, both refusals, SHA
  validation, editor-command quoting (paths with spaces), and the
  autostash-conflict sentence.
- Rust integration tests against real repos: a dirty tree rebases and the
  uncommitted edit comes back; a restore that conflicts is reported while
  `pending_op` reads `"none"`.
- `gitError.test.ts` for rebase's two refusal shapes.
- Manual, against scratch repos on git 2.43.0.windows.1: the built binary as
  sequence editor (reorder + squash; fixup + drop), a conflicted replay leaving
  `pending_op == "rebase"`, and `--abort` returning to the original tip.
