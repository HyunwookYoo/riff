# Operation error recovery (blocked by local changes) — design

## Problem
`checkout` / `pull` / `merge` fail with a **raw git error** whenever the working
tree has local changes that block the operation. The entire global error UX is one
line in `InputBar.svelte`:

```svelte
{#if appState.error}<div class="error">{appState.error}</div>{/if}
```

— git's stderr verbatim, with **no dismiss, no interpretation, no recovery action**.
The backend surfaces `GitError::CommandFailed(stderr)` and every call site does
`catch (e) { appState.error = String(e) }`. Fork, by contrast, offers stash /
discard / commit-first when local changes block a switch. This is riff's sharpest
"works in Fork, fails in riff" gap.

The backend runs bare git, so these are real, reproducible refusals (working tree
left untouched — git refuses cleanly):

- **checkout, tracked dirty** — `git checkout <ref>` → "Your local changes to the
  following files would be overwritten by checkout". Partly gated today by
  `isDirty()` → `CheckoutDialog`, but a **"bring" that conflicts still falls through**
  to the raw error.
- **checkout, untracked collision** — `isDirty()` returns false for untracked-only
  trees, so checkout runs and git refuses: "The following untracked working tree
  files would be overwritten by checkout" → raw error.
- **pull, dirty** — `git pull` → "Your local changes … would be overwritten by
  merge" / "cannot pull with rebase: You have unstaged changes" → raw error.
- **merge, dirty** — `git merge <branch>` → "Your local changes … would be
  overwritten by merge" → raw error.

## Scope
**Case A only: operations blocked by local changes**, across **checkout / pull /
merge**. Recovery actions = **stash & retry** (universal), **discard & retry**
(checkout only in v1), **commit first** (navigate), **cancel**. The mechanism
(classifier + recovery dialog) is deliberately built to absorb cases B–D later
(divergent pull, no upstream, push rejected), but those are **out of scope here**.

## Architecture — reactive + backend-atomic
Run the operation; if git refuses cleanly, **classify** the stderr and, for a
recoverable class, present a **recovery dialog**. Recovery actions call **atomic
backend commands** that mirror the existing `stash_checkout` / `stash_rebase`
(stash → op → pop-on-clean / keep-stash-on-conflict). Unknown errors fall through
to the existing banner (now dismissable).

Prompting happens **only when git actually refuses** → zero false positives, and
every case is caught (untracked collision and bring-conflict included) because the
trigger is the real error, not a predicted `isDirty()` heuristic.

## Components
| Piece | Location | Role |
|---|---|---|
| Error classifier | `src/lib/gitError.ts` (new, pure) | stderr → `GitFailure`; stable-substring match; `unknown` fallback |
| Classifier tests | `src/lib/gitError.test.ts` (new, vitest) | sample stderr → asserted classification |
| `stash_pull` / `stash_merge` | `src-tauri/src/git/cli.rs` (new impls) | atomic stash → op → pop, mirroring `stash_checkout` |
| Trait signatures | `src-tauri/src/git/mod.rs` | 2 new `GitLayer` methods |
| Command wrappers | `src-tauri/src/lib.rs` | 2 `#[tauri::command]` + invoke_handler registration |
| Bindings | `src/lib/git.ts` | `stashPull` / `stashMerge` |
| Recovery dialog | `src/lib/ui/OpRecoveryDialog.svelte` (new) | reason + paths + actions; reuse `CheckoutDialog` styling |
| State | `src/lib/store.svelte.ts` | `appState.recovery` (mirrors `checkoutPrompt`) |
| Wiring | `src/lib/checkout.ts`, `src/lib/sourceControl.ts` | classify on failure → set `recovery` |
| Banner dismiss | `src/lib/ui/InputBar.svelte` | `×` to clear `appState.error` |
| Dialog mount | `src/routes/+page.svelte` | render `OpRecoveryDialog` globally (like `CheckoutDialog`) |

## Error classifier
```ts
export type BlockedOp = "checkout" | "pull" | "merge";
export type GitFailure =
  | { kind: "local-changes-blocked"; paths: string[]; raw: string }
  | { kind: "untracked-collision"; paths: string[]; raw: string }
  | { kind: "unknown"; raw: string };

export function classifyGitError(stderr: string): GitFailure;
```

Match on stable substrings (locale-English git):
- **local-changes-blocked**: `"would be overwritten by checkout"`,
  `"would be overwritten by merge"`,
  `"Please commit your changes or stash them before"`,
  `"cannot pull with rebase: You have unstaged changes"`
- **untracked-collision**: `"The following untracked working tree files would be overwritten by"`
- **paths**: the tab-indented lines following the message header, until a blank /
  non-indented line. Best-effort — on a parse miss, `paths: []` and the dialog
  still functions.

Both recoverable kinds map to the **same** recovery (stash `--include-untracked`
also stashes the colliding untracked files); the distinction only drives the
dialog's headline copy.

## Backend atomic commands
Follow `stash_rebase` exactly — deliberately **NOT** git `--autostash`, because a
conflicting reapply wedges the op (see the existing comment in `stash_rebase`):

```
stash_pull(path, rebase):
  write_lock
  stash push --include-untracked -m "riff: auto-stash before pull"
  if pull( [--rebase] ) is Err:        // real merge/rebase conflict
      drop_session; return Err          // leave stash → conflict UI + manual pop later
  let r = stash pop                      // clean op → reapply
  drop_session; return r                 // pop-conflict propagates (markers in worktree)

stash_merge(path, branch): same shape with `merge <branch>`
```

`checkout` reuses the existing `stash_checkout`. The pull leg uses `run_network`
(keeps `GIT_TERMINAL_PROMPT=0`), matching the existing `pull`.

## Recovery dialog UX
A blocked op opens a modal:

- **Headline**: `"<Op> couldn't complete"` + a reason line (local changes / untracked
  files would be overwritten) + the affected-paths list.
- **Actions**:
  - **Stash & continue** (default) → atomic stash-op command. Safe, reversible.
  - **Discard local changes** (checkout only in v1) → confirm → `force_checkout`. Destructive.
  - **Commit first** → close dialog, navigate to the Changes (Working) view.
  - **Cancel** → clear `recovery`, keep the raw message in `appState.error`.
- The existing **preemptive** `CheckoutDialog` (dirty → stash / bring / discard)
  stays as the upfront fast path; a "bring" that still fails routes into this same
  recovery dialog.

```
┌─────────────────────────────────────────────┐
│  Pull couldn't complete                       │
│  Your local changes would be overwritten:     │
│    • src/foo.rs   • src/bar.rs                │
│                                               │
│  [ Stash & continue ]   ← default, reversible │
│  [ Discard changes ]    ← checkout only (v1)  │
│  [ Commit first ]       → Changes view        │
│  [ Cancel ]             → keep raw message    │
└─────────────────────────────────────────────┘
```

## State shape
Mirrors the existing `checkoutPrompt` pattern:

```ts
recovery: {
  op: BlockedOp;
  title: string;
  reason: string;
  paths: string[];
  offerDiscard: boolean;                       // v1: checkout only
  retry: (s: "stash" | "discard") => Promise<void>;
} | null
```

Set by the op wrappers; consumed by `OpRecoveryDialog`. `retry` closes over the
repo path + op so the dialog stays generic.

## Data flow
1. Op wrapper (`requestCheckout` / `doPull` / `doMergeBranch`) calls the backend op.
2. git refuses cleanly → `CommandFailed(stderr)`.
3. Wrapper `catch` → `classifyGitError(stderr)`.
4. Recoverable → set `appState.recovery` with a bound `retry`; else set
   `appState.error` (raw).
5. `OpRecoveryDialog` renders; user picks an action.
6. **Stash & continue** → `beginGitOp` → atomic command → outcomes:
   - clean success → `refreshActiveView` + `loadPendingOp`; clear recovery.
   - real op conflict → `ConflictBanner` engages (existing `pendingOp`); clear recovery.
   - stash-pop conflict → worktree markers, `pendingOp` none → resolvable in Changes;
     dialog shows a one-line note.
   - command fails → `appState.error`.
7. **Cancel** → clear recovery, restore the raw `appState.error`.

## Testing
- `gitError.test.ts` (vitest) — real stderr samples for checkout / pull / merge /
  untracked-collision → assert `kind` + `paths`; auth / network / no-upstream
  samples → assert `unknown` (no false match). **Primary regression surface, fully
  unit-testable** (sits with the existing `changes.test.ts`, `graph.test.ts`).
- Backend atomic commands — **manual checklist** (riff does not unit-test git ops):
  a tracked-dirty repo, an untracked-collision repo, and a repo that conflicts on
  pop; verify stash / pop / conflict behavior, and that a **failed op restores the
  stash** (no stranded stash).

## Implementation phases
1. `gitError.ts` + tests (pure; verifiable standalone).
2. `stash_pull` / `stash_merge` in `cli.rs` + `mod.rs` trait sigs + `lib.rs`
   commands & registration + `git.ts` bindings.
3. `appState.recovery` + `OpRecoveryDialog.svelte` + mount in `+page.svelte`.
4. Wire `checkout.ts` (`requestCheckout` catch) + `sourceControl.ts`
   (`doPull`, `doMergeBranch`).
5. Banner dismiss in `InputBar.svelte`.
6. Manual end-to-end verification per case.

## Edge cases / known limitations
- **Non-English git locale** → messages differ → classifier returns `unknown` →
  raw banner (no regression vs today).
- **Stash-pop conflict** after a clean op → conflict markers in the worktree with
  no in-progress op; resolvable via Changes / `ConflictView`. Dialog notes this.
- **Submodules** → recovery targets `changesRepoPath()` — the same repo the op ran
  against; uniform.

## Changed files
- `src/lib/gitError.ts` (new) — classifier
- `src/lib/gitError.test.ts` (new) — classifier tests
- `src/lib/ui/OpRecoveryDialog.svelte` (new) — recovery modal
- `src-tauri/src/git/cli.rs` — `stash_pull`, `stash_merge` impls
- `src-tauri/src/git/mod.rs` — 2 `GitLayer` trait signatures
- `src-tauri/src/lib.rs` — 2 `#[tauri::command]` wrappers + invoke_handler registration
- `src/lib/git.ts` — `stashPull`, `stashMerge` bindings
- `src/lib/store.svelte.ts` — `recovery` state field
- `src/lib/checkout.ts` — classify in `requestCheckout` catch; build recovery
- `src/lib/sourceControl.ts` — classify in `doPull` / `doMergeBranch`; build recovery
- `src/lib/ui/InputBar.svelte` — error banner dismiss (`×`)
- `src/routes/+page.svelte` — mount `OpRecoveryDialog`

## Out of scope (v1) — phase-2 / later
- **Discard-&-retry for pull/merge** — needs a destructive `reset --hard` + `clean`
  backend command; deferred (most real use ends at "Stash & continue").
- **Cases B–D**: divergent pull (merge / rebase / ff choice), no upstream
  (set-upstream), push rejected (pull-then-push / force). The classifier + dialog
  framework is built to absorb them — add a `kind` and an action set.
- **Network / auth (E)** messaging beyond the `unknown` fallback.
- **Backend structured error type** (typed `kind` across the wire) — frontend
  classification is sufficient for v1.
