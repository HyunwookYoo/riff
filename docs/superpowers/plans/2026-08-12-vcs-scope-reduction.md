# Version Control Scope Reduction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce riff's write surface to branch create/rename/delete, checkout, and fetch/pull (plus conflict resolution), deleting staging, commit, changelists, stash, history rewriting, tags, and push across the frontend and the Rust backend.

**Architecture:** Frontend first, backend second — by the time a Rust command is deleted, "nothing calls this" is already proven. One exception, Task 6, spans both layers because Working Copy needs a `HEAD`↔worktree diff gap that the backend does not currently produce; that is a parameter *removal*, not an addition. Task 1 is a pure rename so every later task refers to final file names.

**Tech Stack:** Tauri 2 (Rust) + Svelte 5 (runes) + Vite + Vitest + CodeMirror 6.

**Spec:** `docs/superpowers/specs/2026-08-12-vcs-scope-reduction-design.md`

## Global Constraints

- **The invariant.** riff modifies a repository in exactly five ways: create a branch, rename a branch, delete a branch, checkout, and fetch/pull. The one exception is conflict resolution. If a change you are about to make does not fit that sentence, it does not belong.
- **This is a removal plan.** Most tasks have no red-green cycle — the deliverable is that behaviour is *gone* and nothing else broke. Only Task 6 introduces new logic and therefore new tests. Deleting a test that covered a deleted feature is correct, not a regression.
- **Four gates, green at every task boundary:** `npm run build`, `npx svelte-check --tsconfig ./tsconfig.json`, `npm test` (vitest), and — from `src-tauri/` — `cargo test`. Phases 1–2 do not need `cargo test` re-run unless Rust changed; Task 6 and Phases 3–4 do.
- **Do not rename** the `AppMode` string literal `"changes"`, `changesRepoIdx`, `setChangesRepo`, `changesRepoPath`, `enterChangesMode`, or the `changes_file_diff` command. Only user-facing labels and the two files in Task 1 change name. This is a recorded decision (spec §8), not an oversight.
- **Never use `--no-verify`** and never add `--force`. No new git subcommand may be introduced by this plan.
- **Commit per task**, with the task's own scope only.

## Branch setup

Do this once, before Task 1:

```bash
git checkout -b feat/vcs-scope-reduction
```

All tasks commit onto that branch. `main` stays at the spec commits.

---

## Phase 1 — Frontend

### Task 1: Rename to Working Copy

Pure rename plus label text. No behaviour changes, so a reviewer can read the diff as "did anything other than names change? no."

**Files:**
- Rename: `src/lib/sourceControl.ts` → `src/lib/workingCopy.ts`
- Rename: `src/lib/ui/ChangesList.svelte` → `src/lib/ui/WorkingCopyList.svelte`
- Modify: every importer (see Step 2)
- Modify: `src/lib/ui/InputBar.svelte:95`, `:148`, `:150`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the module path `$lib/workingCopy` and the component `$lib/ui/WorkingCopyList.svelte`. Every later task imports from these names. All exported symbol names are unchanged in this task.

- [ ] **Step 1: Rename both files with git so history follows**

```bash
git mv src/lib/sourceControl.ts src/lib/workingCopy.ts
git mv src/lib/ui/ChangesList.svelte src/lib/ui/WorkingCopyList.svelte
```

- [ ] **Step 2: List every importer**

```bash
grep -rn "sourceControl\|ChangesList" src --include=*.ts --include=*.svelte
```

Expected importers of `sourceControl`: `checkout.ts`, `commands.ts`, `reflog.ts`, `repoWatch.ts`, `routes/+page.svelte`, `ui/ChangesList.svelte` (now `WorkingCopyList.svelte`), `ui/CommandPalette.svelte`, `ui/CommitBox.svelte`, `ui/ConflictBanner.svelte`, `ui/DiffView.svelte`, `ui/InputBar.svelte`, `ui/OpRecoveryDialog.svelte`, `ui/RefsSidebar.svelte`, `ui/ReflogOverlay.svelte`, `ui/StashesOverlay.svelte`, `ui/SyncControls.svelte`, `ui/CommitList.svelte`. Importers of `ChangesList`: `routes/+page.svelte` only.

- [ ] **Step 3: Update every import path**

In each file from Step 2, change `from "$lib/sourceControl"` → `from "$lib/workingCopy"` and `from "./sourceControl"` → `from "./workingCopy"`. In `src/routes/+page.svelte`, change:

```svelte
  import ChangesList from "$lib/ui/ChangesList.svelte";
```

to

```svelte
  import WorkingCopyList from "$lib/ui/WorkingCopyList.svelte";
```

and the one usage `<ChangesList />` to `<WorkingCopyList />`.

- [ ] **Step 4: Update the user-facing labels**

In `src/lib/ui/InputBar.svelte`, the mode-toggle button label (`:95`) becomes `Working Copy`:

```svelte
      Working Copy
```

The sub-nav button's `title` (`:148`) currently reads `"Working tree — stage & commit"`; it must not promise staging or committing:

```svelte
        title="Working tree — review your uncommitted changes"
```

Leave the sub-nav button's own label (`:150`, `Working`) alone — it pairs with `Graph` in that nav, and `RefsSidebar.svelte:435` already says `Working Copy`.

- [ ] **Step 5: Verify nothing else references the old names**

Run: `grep -rn "sourceControl\|ChangesList" src`
Expected: no matches.

- [ ] **Step 6: Run the gates**

Run: `npm run build && npx svelte-check --tsconfig ./tsconfig.json && npm test`
Expected: all green, same test count as before this task.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: rename the Changes screen to Working Copy

Pure rename ahead of the scope reduction so every later task refers to
final names. sourceControl.ts becomes workingCopy.ts, ChangesList becomes
WorkingCopyList, and the mode-bar label stops promising staging."
```

---

### Task 2: Delete the commit box

**Files:**
- Delete: `src/lib/ui/CommitBox.svelte`
- Modify: `src/routes/+page.svelte` (import, and the `changes-col` block)
- Modify: `src/lib/workingCopy.ts` (`doCommit`, `stagedCount`, `loadAmendMessage`, `undoLastCommit`)
- Modify: `src/lib/commands.ts` (the Commit category)
- Modify: `src/lib/shortcuts.ts:45` (the Commit section)

**Interfaces:**
- Consumes: `$lib/workingCopy` (Task 1).
- Produces: nothing new. After this task `workingCopy.ts` no longer exports `doCommit`, `stagedCount`, `loadAmendMessage`, or `undoLastCommit`, and `commands.ts` no longer imports `undoLastCommit`.

- [ ] **Step 1: Delete the component**

```bash
git rm src/lib/ui/CommitBox.svelte
```

- [ ] **Step 2: Remove it from the page**

In `src/routes/+page.svelte`, delete the import line `import CommitBox from "$lib/ui/CommitBox.svelte";` and collapse the Changes branch of the mode block so the list fills the column:

```svelte
    {:else if appState.appMode === "changes"}
      <div class="changes-col">
        <div class="changes-scroll"><WorkingCopyList /></div>
      </div>
```

- [ ] **Step 3: Delete the commit functions**

In `src/lib/workingCopy.ts` delete `loadAmendMessage`, `undoLastCommit`, `stagedCount`, and `doCommit` (the last four exports in the file), and drop `commit as commitCmd`, `headCommitMessage`, and `reset` from the `./git` import list. Leave `invalidateGraph` imported — `refreshActiveView` still uses it.

- [ ] **Step 4: Remove the palette entries**

In `src/lib/commands.ts`, delete `undoLastCommit` from the `$lib/workingCopy` import and delete the `commit.undo` entry from the "Commit history / help" `cmds.push(...)` block. Keep `reflog.open` and `help.shortcuts`.

- [ ] **Step 5: Remove the Commit shortcut section**

In `src/lib/shortcuts.ts`, delete the section object whose `title` is `"Commit"` (around `:45`), including its `Ctrl+Enter` / "View stashes (via palette)" rows.

- [ ] **Step 6: Verify the commit surface is gone**

Run: `grep -rn "doCommit\|CommitBox\|commitSubject\|commitAmend\|undoLastCommit" src`
Expected: matches only in `src/lib/store.svelte.ts` (the fields, removed in Task 11).

- [ ] **Step 7: Run the gates**

Run: `npm run build && npx svelte-check --tsconfig ./tsconfig.json && npm test`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat!: remove the commit box

Committing moves to Fork. Drops CommitBox, doCommit, amend message
loading, undo-last-commit, and their palette and shortcut entries."
```

---

### Task 3: Delete stash

**Files:**
- Delete: `src/lib/ui/StashesOverlay.svelte`
- Modify: `src/routes/+page.svelte` (import + `<StashesOverlay />`)
- Modify: `src/lib/ui/RefsSidebar.svelte` (Stashes section, `openStashEditor`, `submitStash`)
- Modify: `src/lib/workingCopy.ts` (`loadStashes`, `doStashSave`, `doStashApply`, `doStashDrop`, `doStashMerge`, and the stash arm of `doPull`)
- Modify: `src/lib/commands.ts` (Stash category)
- Modify: `src/lib/repoWatch.ts:26`, `src/lib/ui/CommandPalette.svelte:20`, `src/lib/checkout.ts:49`

**Interfaces:**
- Consumes: `$lib/workingCopy` (Task 1).
- Produces: `doPull(rebase: boolean)` keeps its signature here and loses only its recovery arm; Task 12 drops the parameter. `loadStashes` no longer exists — nothing may import it.

- [ ] **Step 1: Delete the overlay and its mount**

```bash
git rm src/lib/ui/StashesOverlay.svelte
```

In `src/routes/+page.svelte` delete the `import StashesOverlay …` line and the `<StashesOverlay />` element.

- [ ] **Step 2: Delete the stash functions**

In `src/lib/workingCopy.ts`, delete `loadStashes`, `doStashSave`, `doStashApply`, `doStashDrop`, and `doStashMerge`. Drop `stashApply`, `stashDrop`, `stashList`, `stashMerge`, `stashPull`, `stashSave` from the `./git` import. Delete the `void loadStashes();` call at the end of `enterChangesMode`, and `appState.stashes = [];` from `resetSourceControl`.

`doPull` currently retries through a stash; it must simply surface the failure. Replace it with:

```ts
export function doPull(rebase: boolean): Promise<void> {
  return runSync(pullCmd(changesRepoPath(), rebase), "Pulling…");
}
```

`doMergeBranch` also has a stash retry; leave the function in place for now but delete the `offerRecovery(...)` call inside its `catch`, so it just sets `appState.error`. (The whole function goes in Task 9.)

- [ ] **Step 3: Remove the sidebar's Stashes section**

In `src/lib/ui/RefsSidebar.svelte`, delete `openStashEditor` (`:211`), `submitStash` (`:216`), the whole `Stashes` section markup (the block containing the `＋` stash button at `:560` and the Pop / Apply / `×` buttons at `:583`–`:595`), the `doStashApply` / `doStashDrop` / `doStashSave` imports, and any `.st-*` CSS rules those rows used.

- [ ] **Step 4: Remove the remaining callers**

- `src/lib/commands.ts`: delete `doStashSave` from the import and the whole Stash `cmds.push(...)` block (the `stash.save` and `stash.view` entries).
- `src/lib/repoWatch.ts`: delete `loadStashes` from the import and the `void loadStashes();` call.
- `src/lib/ui/CommandPalette.svelte`: delete the `loadStashes` import and its `void loadStashes();` call in the on-open effect.
- `src/lib/checkout.ts`: delete `loadStashes` from the import and the `void loadStashes();` line inside `refreshAfterCheckout`.

- [ ] **Step 5: Verify stash is gone from the frontend**

Run: `grep -rni "stash" src`
Expected: matches only in `src/lib/store.svelte.ts` (`stashes`, `stashesOpen` — removed in Task 11), `src/lib/git.ts` (bindings — Task 12), `src/lib/types.ts` (the `Stash` interface — Task 12), `src/lib/gitError.ts` (the English marker string `"Please commit your changes or stash them before"`, which is git's own wording and must stay), and `src/lib/ui/CheckoutDialog.svelte` / `OpRecoveryDialog.svelte` / `recovery.ts` (deleted in Task 7).

- [ ] **Step 6: Run the gates**

Run: `npm run build && npx svelte-check --tsconfig ./tsconfig.json && npm test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat!: remove stash

Drops the stashes overlay, the sidebar section, the palette entries, and
the save/apply/pop/drop wrappers. Pull no longer retries through a stash -
it surfaces the failure instead."
```

---

### Task 4: Delete changelists, the multi-selection, and the diff hunk layer

These die together: the multi-selection existed for bulk move and bulk stash, and `DiffView`'s hunk pill exists to assign hunks to changelists and to discard them.

**Files:**
- Delete: `src/lib/changelists.ts`, `src/lib/ui/changesSelect.ts`, `src/lib/ui/changesSelect.test.ts`
- Modify: `src/lib/ui/WorkingCopyList.svelte`
- Modify: `src/lib/ui/DiffView.svelte`
- Modify: `src/lib/workingCopy.ts` (`discardHunk`, changelist calls in `loadStatus`/`setChangesRepo`)
- Modify: `src/routes/+page.svelte:327`–`:334` (the Esc handler's multi-selection branch)

**Interfaces:**
- Consumes: `$lib/workingCopy` (Task 1).
- Produces: `WorkingCopyList.svelte` renders a flat/tree list of `appState.repoStatus.entries` with no grouping. `DiffView.svelte` no longer reads `appState.changesSide`, `appState.changelists`, `appState.hunksByFile`, or `appState.hunkAssignments`.

- [ ] **Step 1: Delete the three modules**

```bash
git rm src/lib/changelists.ts src/lib/ui/changesSelect.ts src/lib/ui/changesSelect.test.ts
```

- [ ] **Step 2: Strip the hunk layer out of DiffView**

In `src/lib/ui/DiffView.svelte` delete, in order:

- the imports `fileHunks` (from `$lib/git`), `discardHunk` (from `$lib/workingCopy`), `assignHunk` / `hunkChangelistId` (from `$lib/changelists`), and `confirmAction` if it becomes unused;
- the whole block from the `// ── Hunk → changelist assignment` comment (`:144`) through `discardHunkClick` and the menu-positioning effect that follows it (`:305`) — that is `hunkMenu`, `loadHunks`, `hunkRanges`, `hunkIdAtLine`, `hunkAtEvent`, `hunkBtn`, `scheduleHide`, `onHunkMove`, `openHunkMenu`, `onHunkContextMenu`, `assignHunkTo`, `discardHunkClick`, `menuEl`;
- the `contextmenu: onHunkContextMenu,` and `mousemove: onHunkMove,` entries in the editor event map (`:472`–`:473`);
- the `<svelte:window onclick={() => (hunkMenu = null)} />` line (`:577`);
- the `{#if hunkBtn}` block and the `{#if hunkMenu}` block (`:700`–`:745`);
- the `.hunk-actions`, `.hunk-act`, `.hunk-act:hover`, `.hunk-act.discard`, `.hunk-menu`, `.hunk-menu button`, `.hunk-menu button:hover` CSS rules.

At `:352` the `staged` argument to `changesFileDiff` is `appState.changesSide === "staged"`. Leave that expression alone in this task — Task 6 removes the parameter. Everything else that reads `changesSide` in this file goes now.

- [ ] **Step 3: Strip the list down**

In `src/lib/ui/WorkingCopyList.svelte`:

- delete the `$lib/changelists` and `./changesSelect` import blocks, and `discardPath` / `doStashSave` / `confirmAction`;
- delete `confirmDiscard` (`:110`) and the row's `↩` discard button (`:339`–`:341`);
- delete the drag-and-drop handlers and the `ghost` state, the `oncontextmenu={(ev) => openMove(ev, path)}` binding (`:323`), the `{#if moveMenu}` menu (`:528`–`:550`), and the `{#if ghost}` drag ghost (`:553`–`:556`);
- delete the `N selected` bar and its Clear button (`:399`), and every read or write of `appState.changesSelectedPaths`;
- delete the now-unused `.cl-menu`, `.cl-drag-ghost`, and changelist-header CSS.

Then replace the two `{#each appState.changelists as …}` loops (`:457`, `:535`) with a single pass over the status entries. Keep the conflicts group above it, keep the flat/tree toggle in `cl-toolbar`, and keep `↑`/`↓` keyboard navigation. The body becomes:

```svelte
  <div class="cl-scroll">
    {#if conflicts.length > 0}
      <div class="cl-group conflicts">
        <div class="cl-head">Conflicts ({conflicts.length})</div>
        {#each conflicts as e (e.path)}
          {@render row(e.path, null)}
        {/each}
      </div>
    {/if}

    {#if changed.length > 0}
      <div class="cl-group">
        {#if appState.fileViewMode === "tree"}
          {@render treeNodes(buildPathTree(changed.map((e) => e.path)), 0)}
        {:else}
          {#each changed as e (e.path)}
            {@render row(e.path, null)}
          {/each}
        {/if}
      </div>
    {/if}
  </div>
```

`conflicts` already exists at `:46` as `$derived(conflictedEntries())` — leave it. Add one derived beside it for everything else, so a conflicted file appears in exactly one group:

```ts
  const changed = $derived(
    (appState.repoStatus?.entries ?? []).filter((e) => !entryConflicted(e)),
  );
```

Add `entryConflicted` to the `$lib/workingCopy` import (`conflictedEntries` stays). The existing `row` and `treeNodes` snippets keep their shape — `treeNodes` previously took a changelist id for its collapse key; drop that parameter and key collapse state on the path alone, since there is only one group now. `buildPathTree(paths: string[])` is unchanged, and the `byPath` filter its old call site used goes away: `changed` is already the entry list, so `changed.map((e) => e.path)` needs no further filtering.

The row still calls `selectChange(entryToChangedFile(entry, "unstaged"), "unstaged")` after this task; Task 6 changes that call.

- [ ] **Step 4: Remove the changelist calls from the module**

In `src/lib/workingCopy.ts`: delete the `./changelists` import, the `loadChangelistsForRepo` / `reconcileChangelists` lines in `loadStatus` (`:193`–`:195`), and the `appState.changelists = []` / `appState.activeChangelistId = "default"` lines in `setChangesRepo`. Delete `discardHunk` and drop `discardHunks` and `fileHunks` from the `./git` import.

- [ ] **Step 5: Remove the Esc branch**

In `src/routes/+page.svelte`, delete the `changesSelectedPaths` branch of the Esc handler (`:327`–`:334`) so Esc falls straight through to the drill-in pop.

- [ ] **Step 6: Verify**

Run: `grep -rn "changelist\|Changelist\|changesSelect\|changesSelectedPaths\|hunkAssignments\|hunksByFile\|assignHunk" src`
Expected: matches only in `src/lib/store.svelte.ts` (Task 11), `src/lib/git.ts` (Task 12), `src/lib/types.ts` (Task 12).

- [ ] **Step 7: Run the gates**

Run: `npm run build && npx svelte-check --tsconfig ./tsconfig.json && npm test`
Expected: green. The vitest count drops by the `changesSelect.test.ts` cases — that is correct.

- [ ] **Step 8: Manual check**

Run `npm run tauri dev`, open a repo with several modified files. The Working Copy list shows one flat/tree list, `↑`/`↓` move between files, clicking one shows its diff, and hovering a diff hunk shows no pill and no menu.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat!: remove changelists, multi-select, and diff hunk actions

The multi-selection existed for bulk move and bulk stash, and the diff's
hover pill assigned hunks to changelists or discarded them - all three go
together. Working Copy is now a single ungrouped list."
```

---

### Task 5: Make the list read-only

Removes the last write affordances from the Working Copy screen: whole-file discard and the Delete-key shortcut.

**Files:**
- Modify: `src/lib/workingCopy.ts` (`discardPath`, `discardSelectedFile`, `stagePath`, `unstagePath`, `stageAll`, `unstageAll`, `applyAndReload`)
- Modify: `src/routes/+page.svelte` (the `discardSelectedFile` import and its key binding)

**Interfaces:**
- Consumes: `$lib/workingCopy` (Task 1).
- Produces: `workingCopy.ts` exports no function that writes to the working tree or the index. Its remaining exports are `changesRepoPath`, `setChangesRepo`, `isStaged`, `isUnstaged`, `entryConflicted`, `isPathConflicted`, `conflictCount`, `conflictedEntries`, `enterConflictResolution`, `openNextConflict`, `enterChangesMode`, `enterScm`, `loadStatus`, `entryToChangedFile`, `selectChange`, `openChange`, `loadCurrentBranch`, `refreshActiveView`, `loadPendingOp`, `doMergeBranch`, `abortOp`, `continueOp`, `doFetch`, `doPull`, `doPush`, `resetSourceControl`.

- [ ] **Step 1: Delete the write functions**

In `src/lib/workingCopy.ts` delete `applyAndReload`, `stagePath`, `unstagePath`, `discardPath`, `discardSelectedFile`, `stageAll`, and `unstageAll`. Drop `discardPaths as discardCmd`, `stage as stageCmd`, and `unstage as unstageCmd` from the `./git` import, and `confirmAction` from the `./dialogs` import if nothing else in the file uses it.

- [ ] **Step 2: Remove the Delete-key shortcut**

In `src/routes/+page.svelte` delete `discardSelectedFile` from the `$lib/workingCopy` import and the key handler branch that calls it.

- [ ] **Step 3: Verify no write path survives**

Run: `grep -rn "discardPath\|discardSelectedFile\|stagePath\|unstagePath\|stageAll\|unstageAll" src`
Expected: no matches.

- [ ] **Step 4: Run the gates**

Run: `npm run build && npx svelte-check --tsconfig ./tsconfig.json && npm test`
Expected: all green.

- [ ] **Step 5: Manual check**

In `npm run tauri dev`: select a modified file in Working Copy and press `Delete`. Nothing happens, and no confirmation dialog appears.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat!: make Working Copy fully read-only

Removes whole-file discard, the Delete-key shortcut, and the stage and
unstage wrappers. The screen now only reads."
```

---

### Task 6: One HEAD-relative list

The only task with new logic, so the only one with a red-green cycle. Working Copy shows one gap — `HEAD` ↔ working tree — which needs a status badge that neither porcelain code gives on its own, and a backend diff that drops the `staged` flag.

**Files:**
- Create: `src/lib/workingCopy.test.ts`
- Modify: `src/lib/workingCopy.ts` (`toFileStatus` → `codeToStatus` + `headRelativeStatus`, `entryToChangedFile`, `selectChange`, `openChange`, `loadStatus`)
- Modify: `src/lib/ui/WorkingCopyList.svelte`, `src/lib/ui/DiffView.svelte` (`:352`)
- Modify: `src/lib/git.ts` (`changesFileDiff`)
- Modify: `src-tauri/src/lib.rs` (the `changes_file_diff` command)
- Modify: `src-tauri/src/git/mod.rs` (the trait signature at `:321`)
- Modify: `src-tauri/src/git/cli.rs` (`changes_file_diff`, `:1362`–~`:1560`)

**Interfaces:**
- Consumes: `$lib/workingCopy` (Task 1); the stripped list and diff from Tasks 4–5.
- Produces:
  - `export function headRelativeStatus(e: StatusEntry): FileStatus`
  - `export function entryToChangedFile(entry: StatusEntry): ChangedFile` — the `side` parameter is gone.
  - `export function selectChange(file: ChangedFile): void` and `export function openChange(entry: StatusEntry): void` — likewise.
  - `changesFileDiff(path, filePath, oldPath, status, force, ueVersion)` — the `staged` argument is gone; all later tasks use this arity.

- [ ] **Step 1: Write the failing test**

Create `src/lib/workingCopy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { headRelativeStatus } from "./workingCopy";
import type { StatusEntry } from "./types";

const entry = (index_status: string, worktree_status: string): StatusEntry => ({
  path: "a.ts",
  orig_path: null,
  index_status,
  worktree_status,
});

describe("headRelativeStatus", () => {
  it("reads an untracked file as added", () => {
    expect(headRelativeStatus(entry("?", "?"))).toBe("added");
  });

  it("keeps a staged add that was edited again as added", () => {
    expect(headRelativeStatus(entry("A", "M"))).toBe("added");
  });

  it("reads a staged edit that was deleted from disk as deleted", () => {
    expect(headRelativeStatus(entry("M", "D"))).toBe("deleted");
  });

  it("falls back to the worktree code when the index is clean", () => {
    expect(headRelativeStatus(entry(".", "M"))).toBe("modified");
    expect(headRelativeStatus(entry(".", "D"))).toBe("deleted");
    expect(headRelativeStatus(entry(".", "T"))).toBe("typechanged");
  });

  it("uses the index code when the worktree is clean", () => {
    expect(headRelativeStatus(entry("M", "."))).toBe("modified");
    expect(headRelativeStatus(entry("A", "."))).toBe("added");
    expect(headRelativeStatus(entry("D", "."))).toBe("deleted");
    expect(headRelativeStatus(entry("R", "."))).toBe("renamed");
    expect(headRelativeStatus(entry("C", "."))).toBe("copied");
  });

  it("keeps a rename that was edited again as renamed", () => {
    expect(headRelativeStatus(entry("R", "M"))).toBe("renamed");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- workingCopy`
Expected: FAIL — `headRelativeStatus` is not exported from `./workingCopy`.

- [ ] **Step 3: Implement it**

In `src/lib/workingCopy.ts`, replace `toFileStatus` (`:38`) with:

```ts
/// Map one porcelain-v2 side code to a `FileStatus`. Unrecognized codes fall
/// back to modified.
function codeToStatus(code: string): FileStatus {
  switch (code) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "typechanged";
    default:
      return "modified";
  }
}

/// A file's status relative to HEAD — what Working Copy's single list shows.
/// Porcelain v2 reports two codes (X = index vs HEAD, Y = worktree vs index)
/// and neither alone answers the question: `AM` is *added* since HEAD even
/// though Y says modified, and `MD` is *deleted* even though X says modified.
/// Read them newest-state-first: gone from disk wins, then never-in-HEAD, then
/// whichever side actually changed.
export function headRelativeStatus(e: StatusEntry): FileStatus {
  const x = e.index_status;
  const y = e.worktree_status;
  if (x === "?" || y === "?") return "added";
  if (y === "D") return "deleted";
  return codeToStatus(x === "." ? y : x);
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npm test -- workingCopy`
Expected: PASS, 6 tests.

- [ ] **Step 5: Drop the side parameter from the frontend**

In `src/lib/workingCopy.ts`:

```ts
/// Build a `ChangedFile` (consumed verbatim by DiffView) from a status entry.
/// The badge and the diff both describe the HEAD↔worktree gap.
export function entryToChangedFile(entry: StatusEntry): ChangedFile {
  return {
    path: entry.path,
    old_path: entry.orig_path,
    status: headRelativeStatus(entry),
    repoIdx: appState.changesRepoIdx,
  };
}

export function selectChange(file: ChangedFile): void {
  appState.selectedFile = file;
}

export function openChange(entry: StatusEntry): void {
  selectChange(entryToChangedFile(entry));
}
```

In `loadStatus`, replace the staged/unstaged selection block (`:196`–`:213`) with a single list:

```ts
    const changed = st.entries;
    const cur = appState.selectedFile;
    const kept = cur ? changed.find((e) => e.path === cur.path) : undefined;
    if (kept) openChange(kept);
    else if (changed.length > 0) openChange(changed[0]);
    else appState.selectedFile = null;
```

Delete `isStaged` and `isUnstaged` (nothing calls them now), and `appState.changesSide = "unstaged";` from `resetSourceControl`.

Update the two remaining callers of `openChange` in `enterConflictResolution` and `openNextConflict` to the one-argument form, and every `entryToChangedFile(entry, …)` / `selectChange(file, …)` call in `WorkingCopyList.svelte`.

- [ ] **Step 6: Drop the staged argument from the binding**

In `src/lib/git.ts`, `changesFileDiff` loses the `staged` parameter and the `staged` field of the invoke payload. In `src/lib/ui/DiffView.svelte:352`, delete the `appState.changesSide === "staged",` argument from the call.

- [ ] **Step 7: Drop it from the Rust command and trait**

In `src-tauri/src/lib.rs`, delete `staged: bool,` from the `changes_file_diff` command's parameters and from the `state.changes_file_diff(...)` call. In `src-tauri/src/git/mod.rs:321`, delete `staged: bool,` from the trait signature and note in its doc comment that the gap is always `HEAD` ↔ working tree.

- [ ] **Step 8: Collapse the branches in the implementation**

In `src-tauri/src/git/cli.rs`, in `changes_file_diff` (`:1362`):

- the old-side spec (`:1385`) becomes unconditional:

```rust
        let old_spec = format!("HEAD:{old_target}");
```

- for the submodule case, `new_sha` is always the working-tree gitlink:

```rust
            let new_sha = gitlink_sha(&fs_path, "HEAD");
```

- in the uasset, image, and text branches, every `if staged { <index blob> } else { <disk read> }` keeps only the disk arm, and the `old_uexp` spec becomes `format!("HEAD:{sp}")`.
- delete the `staged: bool` parameter.

- [ ] **Step 9: Verify the parameter is gone**

Run: `grep -rn "staged" src src-tauri/src`
Expected: matches only in `src/lib/git.ts`'s `stage`/`unstage` doc comments and `src-tauri/src` staging commands (all removed in Tasks 12–14), plus `gitError.ts`'s git-wording marker.

- [ ] **Step 10: Run all four gates**

Run: `npm run build && npx svelte-check --tsconfig ./tsconfig.json && npm test`
Then, from `src-tauri/`: `cargo test`
Expected: all green.

- [ ] **Step 11: Manual check**

In `npm run tauri dev`, in a repo where a file has been staged externally (`git add somefile` from a terminal) and not edited since: it appears in Working Copy with its badge, and clicking it shows the real HEAD↔worktree diff rather than an empty one. Modify a second file without staging: it also shows its diff. A `.uasset` still renders the derived property view, and a submodule bump still renders as a commit list.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "feat!: show one HEAD-relative list in Working Copy

Without staging there is no reason to split the screen, but the unstaged
side alone is wrong: a file staged elsewhere and untouched since would
render an empty diff. changes_file_diff now always spans HEAD to the
working tree, which deletes its staged flag, and headRelativeStatus picks
the badge that neither porcelain code gives on its own."
```

---

### Task 7: Delete the checkout and recovery dialogs

**Files:**
- Delete: `src/lib/ui/CheckoutDialog.svelte`, `src/lib/ui/OpRecoveryDialog.svelte`, `src/lib/recovery.ts`
- Modify: `src/routes/+page.svelte` (imports + both elements)
- Modify: `src/lib/checkout.ts`

**Interfaces:**
- Consumes: `$lib/workingCopy` (Task 1).
- Produces: `checkout.ts` exports exactly `runCheckout(repoPath: string, target: string, ffTo?: string): Promise<void>` and `requestCheckout(repoPath: string, target: string, ffTo?: string): Promise<void>`. `CheckoutStrategy` and `isDirty` are gone; callers that passed a strategy must stop.

- [ ] **Step 1: Delete the three files**

```bash
git rm src/lib/ui/CheckoutDialog.svelte src/lib/ui/OpRecoveryDialog.svelte src/lib/recovery.ts
```

In `src/routes/+page.svelte` delete both import lines and the `<CheckoutDialog />` and `<OpRecoveryDialog />` elements (`:457`–`:458`).

- [ ] **Step 2: Rewrite checkout.ts**

`src/lib/checkout.ts` becomes, in full:

```ts
import { appState } from "./store.svelte";
import { checkout, fastForward, fetch as fetchRemotes } from "./git";
import {
  refreshActiveView,
  loadCurrentBranch,
  loadPendingOp,
} from "./workingCopy";
import { reloadBranchesFor } from "./workspace";
import { classifyGitError } from "./gitError";

/// Refresh everything a branch switch can affect: the active view (graph /
/// status + branch chip), the refs sidebar, and any pending operation banner.
async function refreshAfterCheckout(): Promise<void> {
  await refreshActiveView();
  void loadCurrentBranch();
  void loadPendingOp();
  void reloadBranchesFor(appState.changesRepoIdx);
}

/// Switch branches and refresh on success. Throws on failure so the caller can
/// surface it. When `ffTo` is set (a remote ref), this is a real "pull": the
/// remote is fetched and the just-switched local branch is fast-forwarded up to
/// it — used for remote-branch double-clicks so a behind local catches up to
/// the server. A fetch (offline) or fast-forward (diverged) failure is surfaced
/// but doesn't undo the completed switch.
export async function runCheckout(
  repoPath: string,
  target: string,
  ffTo?: string,
): Promise<void> {
  appState.error = null;
  appState.beginGitOp(ffTo ? "Pulling…" : "Checking out…");
  try {
    await checkout(repoPath, target);
    if (ffTo) {
      try {
        await fetchRemotes(repoPath);
        await fastForward(repoPath, ffTo);
      } catch (e) {
        appState.error = `Switched to ${target}, but couldn't update to ${ffTo}: ${e}`;
      }
    }
    // Preserve a fetch/ff error across the refresh — loadStatus/loadCommits
    // clear appState.error, which would otherwise swallow the message.
    const err = appState.error;
    await refreshAfterCheckout();
    if (err) appState.error = err;
  } finally {
    appState.endGitOp();
  }
}

/// Entry point for every checkout affordance. riff does not stash, discard, or
/// force — it runs the switch and reports what git said. When git refused
/// because local changes are in the way, add the one line that tells the user
/// what to do about it; anything else stands on its own.
export async function requestCheckout(
  repoPath: string,
  target: string,
  ffTo?: string,
): Promise<void> {
  try {
    await runCheckout(repoPath, target, ffTo);
  } catch (e) {
    const raw = String(e);
    const kind = classifyGitError(raw).kind;
    appState.error =
      kind === "unknown"
        ? raw
        : `${raw}\n\n변경을 정리한 뒤 다시 시도하세요. 커밋과 stash는 Fork에서 할 수 있습니다.`;
    void loadPendingOp();
  }
}
```

- [ ] **Step 3: Verify no caller passes a strategy**

Run: `grep -rn "runCheckout\|CheckoutStrategy\|isDirty\|offerRecovery\|checkoutPrompt\|appState.recovery" src`
Expected: `runCheckout` only inside `checkout.ts`; `checkoutPrompt` and `recovery` only in `src/lib/store.svelte.ts` (Task 11). If `RefsSidebar.svelte` or `CommitList.svelte` call `runCheckout` with a strategy argument, drop that argument.

- [ ] **Step 4: Run the gates**

Run: `npm run build && npx svelte-check --tsconfig ./tsconfig.json && npm test`
Expected: all green.

- [ ] **Step 5: Manual check**

In `npm run tauri dev`, edit a tracked file so it conflicts with another branch, then check that branch out from the sidebar. No dialog appears; the error banner shows git's message followed by the Korean hint, and the working tree is untouched. Then check out a branch that does *not* conflict: it switches and carries the change over.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat!: drop the checkout and recovery dialogs

Both existed to ask which auto-stash strategy to retry with. Without
auto-stash there is nothing to ask: the switch runs, and a refusal shows
git's own message plus one line of advice. classifyGitError survives as
what decides whether that line belongs."
```

---

### Task 8: Strip the Graph's write actions

**Files:**
- Modify: `src/lib/ui/CommitList.svelte`

**Interfaces:**
- Consumes: `checkout.ts` from Task 7 (`requestCheckout` with no strategy).
- Produces: `CommitList.svelte` imports nothing from `$lib/git` except read commands, and no longer imports `createTag` or `doMergeBranch`.

- [ ] **Step 1: Delete the commit context menu**

In `src/lib/ui/CommitList.svelte` delete `doReset` (`:278`), `doCherryPick` (`:289`), `doRevert` (`:292`), `doRebase` (`:295`), and the entire commit context-menu markup block containing their buttons (`:681`–~`:705`), including the reset-hard entry. Delete `reset`, `cherryPick`, `revert`, `rebase`, and `createTag` from the `$lib/git` import.

- [ ] **Step 2: Delete badge drag-to-merge**

Delete the `dragSrc` / `pending` / `ghost` drag state (`:111`, `:142`, `:152`) and every handler that implements dragging a ref badge onto another, along with the tag editor those handlers feed (`:251`, the `else void act(createTag(...))` branch) and the drag ghost markup and `.ghost` CSS. Delete the `doMergeBranch` import if present.

- [ ] **Step 3: Fix the remaining titles**

The remote-branch badge title at `:632` reads `"Remote branch — double-click to checkout {b.text} · drag onto another branch to merge/rebase"`. It becomes:

```svelte
                  title="Remote branch — double-click to check out {b.text} and fast-forward"
```

- [ ] **Step 4: Verify**

Run: `grep -n "reset\|cherryPick\|revert\|rebase\|createTag\|dragSrc\|doMergeBranch" src/lib/ui/CommitList.svelte`
Expected: no matches (`resetHistory`-style names from other modules are fine if any appear — check each hit).

- [ ] **Step 5: Run the gates**

Run: `npm run build && npx svelte-check --tsconfig ./tsconfig.json && npm test`
Expected: all green.

- [ ] **Step 6: Manual check**

In `npm run tauri dev`, open Graph. Right-clicking a commit offers no reset, cherry-pick, revert, or rebase. Dragging a branch badge does nothing. Double-clicking a remote branch still checks out and fast-forwards. The graph lanes, badges, and WIP node render as before.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat!: make the commit graph read-only

Removes the commit context menu (reset, cherry-pick, revert, rebase) and
badge drag-to-merge. Checkout stays."
```

---

### Task 9: Strip the refs sidebar

**Files:**
- Modify: `src/lib/ui/RefsSidebar.svelte`
- Modify: `src/lib/workingCopy.ts` (`doMergeBranch`)

**Interfaces:**
- Consumes: `checkout.ts` from Task 7.
- Produces: `workingCopy.ts` no longer exports `doMergeBranch`. The sidebar's ref context menu offers exactly: check out, new branch here, rename, delete.

- [ ] **Step 1: Delete the tag actions**

In `src/lib/ui/RefsSidebar.svelte` delete `doDeleteTag` (`:172`), `doPushTag` (`:182`), their context-menu buttons (`:665`, `:672`), and the `deleteTag` / `pushTag` imports. The Tags *section* stays — tags remain listed, clickable, and checkout-able.

- [ ] **Step 2: Delete merge and set-upstream**

Delete the `Merge into current` context-menu item (`:625`) and the `doMergeBranch` import; delete the set-upstream context-menu item (`:648`) and the `setUpstream` import.

- [ ] **Step 3: Delete doMergeBranch from the module**

In `src/lib/workingCopy.ts` delete `doMergeBranch` and drop `merge as mergeCmd` from the `./git` import.

- [ ] **Step 4: Verify the menu**

Run: `grep -n "role=\"menuitem\"" src/lib/ui/RefsSidebar.svelte`
Expected: four entries — checkout, new branch here, rename, delete.

- [ ] **Step 5: Run the gates**

Run: `npm run build && npx svelte-check --tsconfig ./tsconfig.json && npm test`
Expected: all green.

- [ ] **Step 6: Manual check**

In `npm run tauri dev`: right-click a local branch → four items only. Create a branch, rename it, check it out, delete it — all still work. Right-click a tag → no delete or push. The Tags section still lists tags and double-clicking one still checks it out.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat!: cut the sidebar to branch management

Tag delete and push, merge-into-current, and set-upstream go. The ref
menu is now checkout, new branch here, rename, delete. Tags stay listed
and checkout-able."
```

---

### Task 10: Remove push, teach pull to explain itself, remove the reflog reset

**Files:**
- Modify: `src/lib/ui/SyncControls.svelte`
- Modify: `src/lib/workingCopy.ts` (`doPush`, `doPull`)
- Modify: `src/lib/commands.ts` (the Sync category)
- Modify: `src/lib/ui/ReflogOverlay.svelte`, `src/lib/reflog.ts`

**Interfaces:**
- Consumes: `$lib/workingCopy` (Task 1).
- Produces: `workingCopy.ts` no longer exports `doPush`; `doPull` keeps its `rebase` parameter until Task 12; `reflog.ts` exports only `loadReflog`.

- [ ] **Step 0: Make pull state the no-upstream case**

Removing push means a branch created in riff has no remote counterpart, so `git pull` fails with a message about no tracking information. riff already knows this before it asks git — `appState.currentUpstream` is null — so it should say the useful thing instead. In `src/lib/workingCopy.ts`:

```ts
export function doPull(rebase: boolean): Promise<void> {
  // A branch created in riff has no upstream, because riff cannot push. git's
  // own message ("no tracking information for the current branch") does not say
  // what to do about it — this does.
  if (!appState.currentUpstream) {
    appState.error = appState.currentBranch
      ? `'${appState.currentBranch}' 는 아직 원격에 없습니다. Fork에서 첫 push를 하면 pull 할 수 있습니다.`
      : "detached HEAD 상태에서는 pull 할 수 없습니다. 먼저 브랜치를 checkout 하세요.";
    return Promise.resolve();
  }
  return runSync(pullCmd(changesRepoPath(), rebase), "Pulling…");
}
```

- [ ] **Step 1: Remove push from the toolbar**

In `src/lib/ui/SyncControls.svelte` delete `confirmForcePush`, the `doPush` and `confirmAction` imports, the Push split-button and its `▾` menu, and the `"push"` arm of the `menu` state type (it becomes `"pull" | null`). Keep Fetch and Pull, and keep the ahead/behind counts on both.

- [ ] **Step 2: Delete doPush**

In `src/lib/workingCopy.ts` delete `doPush` and drop `push as pushCmd` from the `./git` import.

- [ ] **Step 3: Remove the push palette entry**

In `src/lib/commands.ts` delete the `sync.push` entry and the `doPush` import. Keep `sync.fetch`, `sync.pull`, and `sync.pullRebase` for now — Task 12 removes the rebase variant.

- [ ] **Step 4: Remove the reflog reset**

In `src/lib/reflog.ts` delete `resetToReflog` and drop the `reset` import, the `invalidateGraph` import, the `loadStatus` import, and `confirmAction` if unused. The file keeps only `loadReflog`. In `src/lib/ui/ReflogOverlay.svelte` delete `onReset` (`:58`), its Reset button (`:125`), the `resetToReflog` import, and any `.rl-reset` CSS. Keep the "create branch here" action (`:62`, `:136`) — it is what makes branch deletion recoverable.

- [ ] **Step 5: Verify**

Run: `grep -rn "doPush\|resetToReflog\|forcePush\|force-with-lease" src`
Expected: no matches.

- [ ] **Step 6: Run the gates**

Run: `npm run build && npx svelte-check --tsconfig ./tsconfig.json && npm test`
Expected: all green.

- [ ] **Step 7: Manual check**

In `npm run tauri dev`: the sync toolbar shows Fetch and Pull only. Create a branch in riff and press Pull — the banner names the branch and points at Fork, and no git command runs. Check out a branch that does track a remote and press Pull — it runs. Open the reflog overlay: entries list with no Reset button, and "create branch here" still works. Delete a branch, then recreate it from its reflog entry.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat!: remove push, and let pull explain itself

Publishing moves to Fork, so the toolbar keeps only fetch and pull. A
branch created in riff has no upstream precisely because riff cannot
push, so pull now names that case instead of relaying git's message about
missing tracking information. The reflog stays as a read-only record plus
create-branch-here, which is what makes deleting a branch recoverable."
```

---

## Phase 2 — Module and state cleanup

### Task 11: Trim workingCopy.ts and the store

**Files:**
- Modify: `src/lib/workingCopy.ts`
- Modify: `src/lib/store.svelte.ts`

**Interfaces:**
- Consumes: everything from Phase 1.
- Produces: `appState` no longer has `stashes`, `stashesOpen`, `changelists`, `activeChangelistId`, `hunkAssignments`, `hunksByFile`, `changesSide`, `changesSelectedPaths`, `changesPaneFraction`, `checkoutPrompt`, `recovery`, `commitSubject`, `commitBody`, `commitAmend`, `commitSignoff`, `commitCoauthors`, or `committing`.

- [ ] **Step 1: Delete the store fields**

In `src/lib/store.svelte.ts` delete the listed fields and their doc comments, and drop `Changelist`, `Hunk`, and `Stash` from the `./types` import. Keep `repoStatus`, `loadingStatus`, `changesRepoIdx`, `currentBranch`, `currentUpstream`, `currentAhead`, `currentBehind`, `syncing`, `gitOpDepth`, `gitOpLabel`, `pendingOp`, `refsRefresh`, `sidebarOpen`, `sidebarWidth`, `reflogOpen`, `graphCheckoutAfterCreate`.

- [ ] **Step 2: Update the doc comment on repoStatus**

Its comment still describes a Phase 0 scaffold that splits into staged and unstaged. Replace it:

```ts
  // Working-tree status from `git status --porcelain=v2` for the Working Copy
  // repo. Entries render as one HEAD-relative list; `ahead`/`behind`/`upstream`
  // feed the sync toolbar and the sidebar badge. Session-only.
```

- [ ] **Step 3: Rename resetSourceControl**

`resetSourceControl` now only clears `repoStatus` and `changesRepoIdx`. Rename it to `resetWorkingCopy` and update its caller in `src/lib/workspace.ts`.

- [ ] **Step 4: Verify no dangling reads**

Run: `npx svelte-check --tsconfig ./tsconfig.json`
Expected: no errors. Any "Property does not exist on type" error points at a Phase 1 leftover — fix it here.

- [ ] **Step 5: Run the gates**

Run: `npm run build && npx svelte-check --tsconfig ./tsconfig.json && npm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: drop the write-side app state

Removes the stash, changelist, hunk, commit-box, checkout-prompt, and
recovery fields now that nothing reads them, and renames
resetSourceControl to resetWorkingCopy."
```

---

## Phase 3 — Backend

### Task 12: Delete the git.ts bindings

**Files:**
- Modify: `src/lib/git.ts`
- Modify: `src/lib/types.ts`
- Modify: `src/lib/workingCopy.ts` (`doPull`), `src/lib/commands.ts` (`sync.pullRebase`)

**Interfaces:**
- Consumes: Phase 1–2.
- Produces: `git.ts` exports no binding for any of the 30 deleted commands. `pull(path: string): Promise<void>` — the `rebase` argument is gone. `doPull(): Promise<void>` — likewise.

- [ ] **Step 1: Delete the bindings**

In `src/lib/git.ts` delete: `forceCheckout` `stashCheckout` `stashPull` `stashMerge` `setUpstream` `createTag` `deleteTag` `pushTag` `reset` `cherryPick` `revert` `rebase` `stashRebase` `push` `merge` `stashList` `stashSave` `stashApply` `stashDrop` `stage` `unstage` `discardPaths` `commit` `headCommitMessage` `commitPaths` `loadChangelists` `saveChangelists` `fileHunks` `applyHunks` `discardHunks`.

Keep `checkout` `fastForward` `createBranch` `renameBranch` `deleteBranch` `fetch` `pull` `conflictVersions` `resolveConflict` `checkoutConflictSide` `pendingOp` `opAbort` `opContinue` `reflog` and every read/settings binding.

- [ ] **Step 2: Drop pull's rebase parameter**

```ts
/**
 * Pull the current branch (fetch + merge). riff never rebases — rewriting
 * local history is outside its write surface.
 */
export function pull(path: string): Promise<void> {
  return invoke("pull", { path });
}
```

In `src/lib/workingCopy.ts`, `doPull` loses only its parameter — keep the no-upstream guard added in Task 10:

```ts
export function doPull(): Promise<void> {
  // A branch created in riff has no upstream, because riff cannot push. git's
  // own message ("no tracking information for the current branch") does not say
  // what to do about it — this does.
  if (!appState.currentUpstream) {
    appState.error = appState.currentBranch
      ? `'${appState.currentBranch}' 는 아직 원격에 없습니다. Fork에서 첫 push를 하면 pull 할 수 있습니다.`
      : "detached HEAD 상태에서는 pull 할 수 없습니다. 먼저 브랜치를 checkout 하세요.";
    return Promise.resolve();
  }
  return runSync(pullCmd(changesRepoPath()), "Pulling…");
}
```

In `src/lib/commands.ts`, delete the `sync.pullRebase` entry and change `sync.pull` to `run: () => void doPull()` with the title `Pull`. In `src/lib/ui/SyncControls.svelte`, the Pull button calls `doPull()`; if the `▾` options menu now has only one item, delete the split-button caret and the `menu` state entirely.

- [ ] **Step 3: Delete the dead types**

In `src/lib/types.ts` delete the `Stash`, `Hunk`, and `Changelist` interfaces.

- [ ] **Step 4: Verify**

Check by name, not by count — a count is easy to satisfy accidentally:

```bash
grep -nE "\"(stage|unstage|discard_paths|commit|head_commit_message|commit_paths|load_changelists|save_changelists|file_hunks|apply_hunks|discard_hunks|force_checkout|stash_checkout|stash_pull|stash_merge|set_upstream|create_tag|delete_tag|push_tag|reset|cherry_pick|revert|rebase|stash_rebase|push|merge|stash_list|stash_save|stash_apply|stash_drop)\"" src/lib/git.ts
```

Expected: no matches.

Run: `npx svelte-check --tsconfig ./tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Run the gates**

Run: `npm run build && npx svelte-check --tsconfig ./tsconfig.json && npm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat!: delete the removed command bindings

Thirty bindings go, along with the Stash, Hunk, and Changelist types.
Pull loses its rebase flag - riff never rewrites local history."
```

---

### Task 13: Delete the Tauri commands

**Files:**
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: Task 12 (nothing invokes these names any more).
- Produces: `generate_handler!` lists 48 commands.

- [ ] **Step 1: Delete the command wrappers**

In `src-tauri/src/lib.rs` delete the `#[tauri::command]` functions: `stage` `unstage` `discard_paths` `commit` `head_commit_message` `commit_paths` `load_changelists` `save_changelists` `file_hunks` `apply_hunks` `discard_hunks` `force_checkout` `stash_checkout` `stash_pull` `stash_merge` `set_upstream` `create_tag` `delete_tag` `push_tag` `reset` `cherry_pick` `revert` `rebase` `stash_rebase` `push` `merge` `stash_list` `stash_save` `stash_apply` `stash_drop`.

- [ ] **Step 2: Drop pull's rebase parameter**

```rust
#[tauri::command]
async fn pull(state: tauri::State<'_, GitCli>, path: String) -> Result<(), GitError> {
    state.pull(Path::new(&path))
}
```

- [ ] **Step 3: Update the handler list and imports**

Delete the same 30 names from `generate_handler!` (`:774`). Remove `Hunk` and `Stash` from the `use git::{…}` list at `:8`.

- [ ] **Step 4: Verify by name**

```bash
grep -nE "^\s+(stage|unstage|discard_paths|commit|head_commit_message|commit_paths|load_changelists|save_changelists|file_hunks|apply_hunks|discard_hunks|force_checkout|stash_checkout|stash_pull|stash_merge|set_upstream|create_tag|delete_tag|push_tag|reset|cherry_pick|revert|rebase|stash_rebase|push|merge|stash_list|stash_save|stash_apply|stash_drop),$" src-tauri/src/lib.rs
```

Expected: no matches (this pattern targets the `generate_handler!` entries, which are one bare name per line).

Run (from `src-tauri/`): `cargo check`
Expected: fails only on the `GitLayer` trait methods that no longer have callers — those go in Task 14. If it fails on anything else, fix it here.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat!: delete the removed Tauri commands

Thirty command wrappers and their handler entries. Pull loses its rebase
parameter. The trait methods they called go next."
```

> This is the one task that may end with `cargo check` still failing — the trait and its implementation are removed in Task 14, and splitting them keeps each diff readable. If your workflow requires every commit to build, do Tasks 13 and 14 as one commit.

---

### Task 14: Delete the GitLayer methods and their implementations

**Files:**
- Modify: `src-tauri/src/git/mod.rs`
- Modify: `src-tauri/src/git/cli.rs`

**Interfaces:**
- Consumes: Task 13.
- Produces: `GitLayer` declares 11 write methods and the read set; `Stash` and `Hunk` no longer exist.

- [ ] **Step 1: Delete the trait methods**

In `src-tauri/src/git/mod.rs` delete these declarations: `stage` (`:334`) `unstage` (`:337`) `discard_paths` (`:344`) `commit` (`:350`) `head_commit_message` (`:361`) `commit_paths` (`:365`) `load_changelists` (`:376`) `save_changelists` (`:378`) `file_hunks` (`:382`) `apply_hunks` (`:388`) `discard_hunks` (`:401`) `force_checkout` (`:422`) `stash_checkout` (`:450`) `stash_pull` (`:455`) `stash_merge` (`:458`) `set_upstream` (`:465`) `create_tag` (`:467`) `delete_tag` (`:469`) `push_tag` (`:473`) `reset` (`:477`) `cherry_pick` (`:483`) `revert` (`:485`) `rebase` (`:488`) `stash_rebase` (`:493`) `push` (`:502`) `merge` (`:510`) `stash_list` (`:520`) `stash_save` (`:525`) `stash_apply` (`:533`) `stash_drop` (`:535`).

Change `pull` (`:498`) to `fn pull(&self, path: &Path) -> Result<(), GitError>;`.

- [ ] **Step 2: Add the contract to the trait's doc comment**

Above the `GitLayer` declaration, record the invariant so the next reader learns it from the code:

```rust
/// The complete set of git operations riff can perform. Everything the app can
/// do to a repository is declared here — `GitCli::run` is private, so a method
/// that is not on this trait cannot be reached.
///
/// riff writes in exactly five ways: create a branch, rename a branch, delete a
/// branch, checkout, and fetch/pull. The one exception is conflict resolution,
/// which cleans up the state riff's own pull created. Committing, publishing,
/// stashing, and rewriting history are deliberately absent — see
/// docs/superpowers/specs/2026-08-12-vcs-scope-reduction-design.md.
```

- [ ] **Step 3: Delete the types**

In `src-tauri/src/git/mod.rs` delete the `Stash` and `Hunk` struct definitions and any `pub use` of them.

- [ ] **Step 4: Delete the implementations**

In `src-tauri/src/git/cli.rs` delete the `impl GitLayer for GitCli` bodies of every method from Step 1, plus any private helper that only they used (the hunk parser and sub-patch builder are the large ones). Update `pull` to drop its `rebase` argument and always run a merge pull.

- [ ] **Step 5: Delete the tests that covered them**

Run: `cargo test 2>&1 | head -40` from `src-tauri/` to see what no longer compiles, and delete those `#[test]` functions. Deleting a test for a deleted feature is correct. Do **not** delete tests for surviving behaviour — the porcelain-v2 parser, ref validation, and path validation tests all stay.

- [ ] **Step 6: Verify the surface**

Run (from `src-tauri/`): `cargo test && cargo clippy --all-targets -- -D warnings`
Expected: green, no warnings. Dead-code warnings point at helpers that lost their last caller — delete those too.

Run (from repo root): `grep -rniE "stash|cherry-pick|rebase|force" src-tauri/src/git/`
Expected: matches only in comments and in `pending_op`/`op_abort`/`op_continue`, which must still recognise a rebase or cherry-pick begun in another tool.

- [ ] **Step 7: Run all four gates**

Run: `npm run build && npx svelte-check --tsconfig ./tsconfig.json && npm test`
Then from `src-tauri/`: `cargo test`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat!: delete the removed GitLayer methods

Thirty trait methods, their GitCli implementations, the hunk parser and
sub-patch builder they needed, the Stash and Hunk types, and the tests
that covered them. The trait doc comment now states the write invariant,
since the trait is what enforces it."
```

---

### Task 15: Extract the write surface into git/write.rs

**Files:**
- Create: `src-tauri/src/git/write.rs`
- Modify: `src-tauri/src/git/cli.rs`, `src-tauri/src/git/mod.rs`

**Interfaces:**
- Consumes: Task 14.
- Produces: no API change — a second `impl GitCli` block in a new module. `GitCli::run`, `write_lock`, and `drop_session` must be visible to it (`pub(super)` or `pub(crate)` as needed).

- [ ] **Step 1: Create the module**

Create `src-tauri/src/git/write.rs` with this header, then move the 11 write method bodies into a `impl GitCli` block below it:

```rust
//! Every line of riff that modifies a repository.
//!
//! riff writes in exactly five ways: create a branch, rename a branch, delete a
//! branch, checkout, and fetch/pull. The one exception is conflict resolution,
//! which cleans up the state riff's own pull created. If a change would add a
//! method here that does not fit that sentence, it belongs in another tool —
//! see docs/superpowers/specs/2026-08-12-vcs-scope-reduction-design.md.

use std::path::Path;

use super::cli::GitCli;
use super::{ConflictVersions, GitError};
```

Move `create_branch`, `rename_branch`, `delete_branch`, `checkout`, `fast_forward`, `fetch`, `pull`, `resolve_conflict`, `checkout_conflict_side`, `op_abort`, and `op_continue`. `conflict_versions` **stays in `cli.rs`** — it only reads index stages.

- [ ] **Step 2: Wire up visibility**

Add `mod write;` to `src-tauri/src/git/mod.rs`. Widen `GitCli::run`, `write_lock`, and `drop_session` to `pub(super)` so `write.rs` can reach them, and keep them out of the public API.

Rust does not allow one `impl GitLayer for GitCli` to be split across files, so the shape is fixed: `write.rs` holds **inherent** methods on `GitCli` (named `checkout_impl`, `pull_impl`, and so on to avoid colliding with the trait methods), and the trait impl in `cli.rs` keeps eleven one-line delegates:

```rust
    fn checkout(&self, path: &Path, ref_name: &str) -> Result<(), GitError> {
        self.checkout_impl(path, ref_name)
    }
```

The indirection is the cost of the file boundary, and it is one line per method.

- [ ] **Step 3: Verify the boundary holds**

Run (from repo root): `grep -nE "self\.run\(" src-tauri/src/git/cli.rs`
Expected: only read commands (`rev-parse`, `log`, `diff`, `blame`, `status`, `cat-file`, `for-each-ref`, `reflog`, `submodule`, …). Any mutating subcommand left in `cli.rs` means Step 1 missed a method.

- [ ] **Step 4: Run the Rust gates**

Run (from `src-tauri/`): `cargo test && cargo clippy --all-targets -- -D warnings`
Expected: green, no warnings.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(git): put every write in one file

The scope invariant now holds as a file boundary: git/write.rs is the
complete list of ways riff can change a repository, and cli.rs is
read-only. No API change."
```

---

## Phase 4 — Documentation and release

### Task 16: Rewrite the documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/version-control-plan.md` (banner only)

**Interfaces:**
- Consumes: Phases 1–3.
- Produces: no code.

- [ ] **Step 1: Rewrite the README's opening**

Replace the one-line description:

```markdown
# Riff

Windows 데스크톱용 경량 Git 브라우저. 커밋 히스토리와 두 ref 비교를 PR처럼 읽고, 라인별 blame과 파일 타임랩스로 코드의 내력을 추적합니다. 브랜치를 만들고 옮겨 다니고 pull 하는 것까지가 riff가 저장소에 손대는 전부입니다 — 커밋과 push는 Fork에서.
```

- [ ] **Step 2: Update the workspace-mode table**

The `Changes` row becomes `Working Copy` with the purpose `작업 트리 변경을 읽기 전용으로 확인 (HEAD ↔ 작업 트리)`. The `Graph` row drops `fetch/pull/push` in favour of `fetch/pull`.

- [ ] **Step 3: Rewrite section 3**

Section "3. Changes 모드 — 소스 컨트롤" becomes "3. Working Copy 모드 — 작업 트리 확인". Delete the changelist, multi-select, stash, and bucket-commit paragraphs. Keep: the file list and status badges, the `HEAD ↔ 작업 트리` diff, the Unreal `.uasset` property view, focus-regain auto-refresh and `F5`/`Ctrl+R`, and the conflict paragraph. Add one sentence: `이 화면은 읽기 전용입니다 — 스테이징·커밋·되돌리기는 Fork에서 합니다. 예외는 충돌 해결뿐으로, riff의 pull이 만든 충돌은 riff에서 해결합니다.`

- [ ] **Step 4: Rewrite section 3b**

In "3b. Graph 모드", the 커밋별 액션 bullet becomes `커밋을 클릭하면 그 커밋의 변경 전체를 봅니다. 브랜치 배지 더블클릭으로 checkout.` Delete the drag-and-drop merge/rebase clause, the Merge bullet, and the Stash bullet. The 브랜치 사이드바 bullet drops the stash-and-reapply sentence: `checkout, 생성/이름변경/삭제. 리모트 더블클릭은 checkout + fast-forward.` The 동기화 툴바 bullet becomes `fetch / pull (ahead/behind 카운트 표시).`

- [ ] **Step 5: Update the shortcut and palette text**

In section 6, the `Ctrl+Shift+P` row's description drops stash: `커맨드 팔레트 (모드 전환 / 테마 / fetch·pull / 브랜치 checkout 등)`. Delete the `F5`/`Ctrl+R` row's "Working Tree" wording in favour of "Working Copy". Remove any `Ctrl+Enter` commit row.

- [ ] **Step 6: Add a positioning section**

After the install section, add:

```markdown
## riff와 Fork

riff는 **읽는 도구**입니다. 저장소를 바꾸는 경우는 다섯 가지뿐입니다 — 브랜치 생성, 이름 변경, 삭제, checkout, fetch/pull. 여기에 예외가 하나 있는데, riff의 pull이 충돌을 만들면 riff가 3-way 해결기로 치웁니다.

커밋, push, stash, rebase, reset은 riff에 없습니다. Fork(또는 다른 클라이언트)에서 하세요. 기능이 모자란 게 아니라 의도된 분업입니다 — riff는 코드를 읽는 일을 잘하는 데 집중합니다.
```

- [ ] **Step 7: Mark the old plan superseded**

At the very top of `docs/version-control-plan.md`, above the `#` heading:

```markdown
> **SUPERSEDED (2026-08-12)** — 이 문서는 riff를 풀 Git 클라이언트로 확장하는 방향이었고, 그 방향은 폐기되었습니다. 현재 설계는 `docs/superpowers/specs/2026-08-12-vcs-scope-reduction-design.md` 를 보세요. 이 문서는 그 시도가 있었다는 기록으로 남겨둡니다.
```

- [ ] **Step 8: Verify the README makes no false promise**

Run: `grep -niE "커밋|commit|스테이징|stage|stash|push|rebase|reset|changelist" README.md`
Expected: every remaining hit is either about *reading* commits (커밋 히스토리, 커밋 그래프, 커밋 drill-in), or is in the new "riff와 Fork" section explaining what riff does not do. No hit promises a write riff cannot perform.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "docs: rewrite the README for a read-first riff

New one-liner, a riff-and-Fork section stating the write invariant,
Changes becomes Working Copy, and the Graph and shortcut sections stop
advertising actions that no longer exist. Marks version-control-plan.md
superseded rather than deleting it."
```

---

### Task 17: Release v2.0.0

**Files:**
- Modify: `CHANGELOG.md`, `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`

**Interfaces:**
- Consumes: Tasks 1–16, merged to `main`.
- Produces: tag `v2.0.0`.

- [ ] **Step 1: Merge the branch first**

The release must be cut from `main`. Merge `feat/vcs-scope-reduction` into `main` before this task (see the finishing-a-development-branch skill), then continue here.

- [ ] **Step 2: Write the changelog entry**

Add a new **top** section to `CHANGELOG.md`, above the previous version. The release workflow extracts everything between the first `## ` line and the second as the GitHub Release body, so it must be first. Match the existing Korean, benefit-focused voice:

```markdown
## v2.0.0

riff가 하는 일을 좁혔습니다 — 커밋 히스토리와 diff를 읽고, blame으로 내력을 쫓고, 브랜치를 만들고 옮겨 다니는 것. 커밋과 push는 Fork에 맡깁니다.

### 💔 제거된 기능
- **커밋·스테이징·changelist** — Working Copy는 이제 읽기 전용입니다. 변경 파일과 `HEAD ↔ 작업 트리` diff를 보여주지만 스테이징·커밋·되돌리기는 하지 않습니다.
- **stash** — 사이드바 섹션, 패널, 파일 단위 stash가 모두 사라졌습니다. checkout이 로컬 변경 때문에 막히면 자동으로 stash 하는 대신 git의 메시지를 그대로 보여줍니다.
- **push / force-push**, **태그 생성·삭제·push**, **set-upstream**.
- **히스토리 재작성** — reset, rebase, cherry-pick, revert, 그리고 배지 드래그 머지.

### ✨ 개선
- **Working Copy가 한 목록으로** — staged/unstaged 분리가 사라지고 `HEAD` 기준 변경 하나로 보여줍니다. 다른 도구에서 스테이징한 파일도 제대로 된 diff가 나옵니다.
- **충돌 해결은 그대로** — pull이 충돌을 내면 3-way 해결기가 열리고, 다른 도구에서 시작한 rebase 충돌도 riff에서 해결할 수 있습니다.
- **reflog로 복구** — 브랜치를 실수로 지워도 reflog에서 SHA를 찾아 그 자리에 다시 만들 수 있습니다.
- 코드 약 5천 줄이 줄었습니다. 불안정했던 경로가 대부분 사라진 자리입니다.

### 📦 설치 / 업그레이드
기존 사용자는 앱 상단 배너의 **Install and restart** 로 갱신됩니다. 저장소에 남아 있는 `.git/riff-changelists.json` 은 더 이상 읽지 않지만 지우지도 않습니다.
```

- [ ] **Step 3: Bump the version in three files**

Set `"version"` to `2.0.0` in `package.json` and `src-tauri/tauri.conf.json`, and `version = "2.0.0"` under `[package]` in `src-tauri/Cargo.toml`.

- [ ] **Step 4: Sync the lockfile**

Run (from `src-tauri/`): `cargo check`
Expected: succeeds and rewrites the `riff` entry in `Cargo.lock` to 2.0.0.

- [ ] **Step 5: Run every gate one last time**

Run: `npm run build && npx svelte-check --tsconfig ./tsconfig.json && npm test`
Then from `src-tauri/`: `cargo test && cargo clippy --all-targets -- -D warnings`
Expected: all green.

- [ ] **Step 6: Commit and tag**

```bash
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock CHANGELOG.md
git commit -m "release: v2.0.0"
git push origin main
git tag -a v2.0.0 -m "v2.0.0" HEAD
git push origin v2.0.0
```

- [ ] **Step 7: Hand off the publish**

The tag push triggers `.github/workflows/release.yml`, which builds on windows-latest and creates a **draft** release. Publishing it is manual and cannot be done from here — the `gh` CLI is authenticated against github.krafton.com, not github.com, so API calls against this repo return 401. Tell the user to watch the Actions run and click Publish at `github.com/HyunwookYoo/riff/releases`.

---

## Final verification

After Task 17, confirm the spec's success criteria:

- [ ] None of the 30 removed names appear in `src/lib/git.ts` or in `generate_handler!` (the by-name greps from Tasks 12 and 13)
- [ ] `grep -nE "self\.run\(" src-tauri/src/git/cli.rs` → read subcommands only; every mutating call lives in `git/write.rs`
- [ ] All four gates green, `cargo clippy` clean
- [ ] Manual checklist from the spec, run against `C:\workspace\sandbox` (nested-submodule Unreal project) **and** a plain single-root repo:
  - Working Copy lists changes with badges, shows HEAD↔worktree diffs, offers no write affordance
  - Branch create → rename → checkout → delete → recover from reflog
  - Checkout with a conflicting dirty tree: error banner, tree untouched, no dialog
  - Pull: fast-forwards when behind; states the case when there is no upstream; opens the resolver on conflict, and both Continue and Abort work
  - A repo left mid-rebase by Fork: conflicted files list, resolver works
  - Graph: no reset/cherry-pick/revert/rebase menu, drag does nothing, remote double-click still checks out + fast-forwards
  - Blame, Timelapse, Compare, submodule diffs, Unreal previews all behave as in v1.3.0
  - Palette: no Stash, Commit, Push, or Pull (rebase) entries
