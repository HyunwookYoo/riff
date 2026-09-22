# Push — Design Spec

**Date:** 2026-09-16
**Version:** targets v2.1.0 (additive, alongside the rebase spec)
**Amends:** `docs/superpowers/specs/2026-08-12-vcs-scope-reduction-design.md`,
which removed push, and follows
`docs/superpowers/specs/2026-09-14-rebase-design.md`, which is why push is
needed back.

## Why this comes back

Rebase landing in riff is what made push's absence a hole rather than a
boundary. A rebased branch is *behind a lie*: the remote still holds the old
commits, and the only way to reconcile that is to publish the new ones. Leaving
at that exact point to run one command in another client is the workflow break
the rebase spec was written to remove.

Push also fails the "riff would need to own new state" test in the same way
rebase did — which is to say, it doesn't. Credentials belong to the user's
credential helper (`run_network` already disables git's terminal prompt so a GUI
launch can never hang on one), the refs belong to git, and the result is visible
in the graph riff already draws.

Commit still stays out. Publishing what git already recorded is not the same as
creating it: a commit needs a message editor, an index model, and a staging
screen — the exact state v2.0.0 removed.

## The amended invariant

> **riff modifies a repository in exactly seven ways: create a branch, rename a
> branch, delete a branch, checkout, fetch/pull, rebase, and push.**
>
> **There is one exception — conflict resolution. riff cleans up the state its
> own pull or rebase created.**

## Interaction

| Surface | What |
|---|---|
| Sync toolbar (`SyncControls.svelte`) | A split button: `↑ Push N` for the current branch (N = commits ahead of upstream, reading `↑ Publish` when it has no upstream yet), plus a `▾` half opening `Push` / `Force push (with lease)…`. The wide half is always the ordinary push, so force takes a deliberate second click; the force item is disabled while the branch has no upstream, since there is nothing to replace. |
| Branch sidebar right-click, local branches (`RefsSidebar.svelte`) | `Push`, `Force push (with lease)…` — including branches that are not checked out |

Pushing a branch you are not on is the reason every push uses an explicit
refspec (`<branch>:<remote-branch>`) instead of relying on `push.default`. The
same refspec is what lets a branch whose local name differs from its remote name
go back to the right place.

**First publish.** No upstream means `push -u <remote> <branch>:<branch>`. The
remote is `origin` when it exists, otherwise the only remote there is; several
remotes and no `origin` is refused with their names rather than guessed — riff
would be choosing where someone's work goes. Pull's "this branch isn't on the
remote yet" message now points at the Push button instead of at Fork.

## Force is always leased

`--force-with-lease --force-if-includes`, and nothing else. A bare `--force` is
not reachable from any riff surface, and `push_args_force_is_always_leased`
asserts that it never appears in the argv.

- `--force-with-lease` refuses unless the remote is still where riff last saw
  it, so a force push can never discard a commit riff has never seen.
- `--force-if-includes` additionally refuses unless the local branch was built
  on top of what the last fetch brought back — closing the hole where a fetch
  updates the tracking ref, the lease then passes, and someone else's work goes
  anyway.

This needs git ≥ 2.30, noted in the README.

Force pushes ask for confirmation; ordinary pushes do not. An ordinary push only
adds commits — it is refused outright if it would do anything else.

## Rejections get different advice

git's own hint for a rejected push is "use 'git pull' before pushing again",
which is wrong for a branch that was deliberately rebased. `classifyGitError`
therefore reads the reason off git's `! [rejected]` line (verified on git
2.43.0.windows.1) and `pushHint` answers each one:

| git says | Means | riff says |
|---|---|---|
| `(fetch first)` / `(non-fast-forward)` | the remote has commits this branch doesn't | Pull first — or force, if the branch was rebased on purpose |
| `(stale info)` | the lease failed: the remote moved since riff last fetched | Fetch and look at what changed before retrying |
| `(remote ref updated since checkout)` | `--force-if-includes` failed: fetched, but never integrated | check those commits and rebase onto them first |

## Files

| File | Change |
|---|---|
| `src-tauri/src/git/mod.rs` | `push` on `GitLayer`; amended invariant doc |
| `src-tauri/src/git/write.rs` | `push_impl`, `remotes`, `upstream_of`; pure `push_args` / `split_upstream` / `default_remote` |
| `src-tauri/src/git/cli.rs` | trait wiring + integration tests |
| `src-tauri/src/lib.rs` | the `push` command |
| `src/lib/push.ts` | confirm (force only) → run → refresh, per-rejection hints |
| `src/lib/git.ts`, `src/lib/gitError.ts` | binding; the three rejection kinds |
| `src/lib/ui/SyncControls.svelte`, `src/lib/ui/RefsSidebar.svelte` | the two entry points |
| `src/lib/workingCopy.ts` | Pull's no-upstream message now points at Push |

## Verification

- Rust unit tests: argv shape for tracking / first-publish / leased-force, that
  `--force` never appears, upstream splitting against the real remote list
  (a branch named `feature/x` under a remote named `origin/mirror`), and the
  refusal to guess between several remotes.
- Rust integration tests against a bare local remote: a first push publishes and
  records the upstream; an amended (rewritten) commit is refused as non-ff and
  then accepted with the lease; a lease refuses once a second clone has pushed,
  leaving that clone's commit as the remote tip.
- `gitError.test.ts` for the three rejection shapes.
