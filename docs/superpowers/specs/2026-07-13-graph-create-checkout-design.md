# Graph "check out after creating" a branch — design

## Problem
Creating a branch from the commit graph (right-click a commit → "new branch here",
`CommitList.svelte`) never switches to it: it calls `createBranch(sha, checkout=false)`
= `git branch <name> <sha>`. This was deliberate — `git checkout -b <name> <arbitrary
commit>` on a dirty tree fails with a raw error, so the graph avoided auto-switching
("Switch via the sidebar if desired"). Users want the option to create-and-switch in
one step.

## Design
Add a sticky **"Check out after creating"** checkbox to the graph's inline
branch-create editor (branch kind only; tag creation unaffected).

- **Unchecked** (initial default) → today's behavior: create at the commit, no switch.
- **Checked** → `createBranch(sha, checkout=false)` then `requestCheckout(newBranch)`.

`requestCheckout` is the recovery-aware checkout path (from the op-error-recovery work):
clean tree → instant switch; dirty tree → the stash / bring / discard dialog. So
switching to an arbitrary commit no longer risks the raw-error failure that made the
graph avoid auto-switch — the feature builds on that recovery flow instead of
reintroducing its problem.

Sticky = remembered within the session via `appState.graphCheckoutAfterCreate`
(session-only, default `false`). The sidebar's create is unchanged (it already
switches on create).

## Changed files
- `src/lib/store.svelte.ts` — `graphCheckoutAfterCreate` session state field
- `src/lib/ui/CommitList.svelte` — checkbox in the create editor; `submitEditor` routes
  the switch through `requestCheckout` when checked; updated rationale comment + scoped
  checkbox CSS (so it doesn't inherit the `.cl-editor input` text-field styling)

## Out of scope
- Cross-restart persistence of the checkbox preference.
- Mirroring the checkbox in the sidebar (it already checks out on create).
- Changing tag creation.
