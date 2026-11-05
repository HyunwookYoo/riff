# Rebase Conflict Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before any rebase riff starts, show whether it will conflict: ✓ / ⚠ (first conflicting commit and its files) / nothing to rebase / can't check. On ⚠, offer a copyable Korean request for an AI. Show the same result, read-only, in Branch mode.

**Architecture:** A new backend method `rebase_check` replays the commits a rebase would replay. It applies each one onto the upstream tip with `git merge-tree --write-tree`, chaining clean results through `git commit-tree`, and stops at the first conflict. A Tauri command wraps it with a progress channel and a cancel id. A frontend module `rebaseCheck.ts` provides three things: a start/cancel handle, the display strings, and the AI request text. One Svelte component, `RebaseCheckLine`, renders a result in three places:
- a new in-app confirm overlay for the plain rebase, which replaces the native dialog;
- the interactive plan editor;
- the Branch mode commit table, where the result is stored per group on `BcGroup`.

**Tech Stack:** Tauri 2 (Rust, git CLI), SvelteKit + Svelte 5 runes, Vitest, cargo test.

**Spec:** `docs/superpowers/specs/2026-11-05-rebase-conflict-preview-design.md`

## Global Constraints

- **Read-only:** never touch the working tree, the index, HEAD or any ref. Writing objects to the object store (merge-tree trees, commit-tree commits) is acceptable.
- **git version:** needs git 2.40+ (`merge-tree --write-tree --merge-base`). Below that, the outcome is `can't check (needs git 2.40+)`.
- **Never a false ✓:** an unknown outcome is `can't check (<reason>)` or `nothing to rebase`, never ✓.
- **Commits checked:** the ones `rebase_plan(upstream, branch)` lists, in that order, or the edited plan's order with `drop` skipped. `squash`, `fixup` and `edit` replay as `pick`. Stop at the first conflict.
- **No time cap:** show progress `checking k/N…`. A newer run cancels the older one, which stops at its next step.
- **Copy button:** "Copy request for AI" appears on ⚠ only.
- **Rebase on ⚠:** the plain-rebase Rebase button stays enabled on ⚠.
- **Branch mode:** shows the result only, with no rebase button. upstream = base, branch = compare.
- **Stale results:** a stale result must never land over a newer one.
- **Line endings:** files are CRLF. Edit them with the Edit tool. Never `sed -i`, and never Python's default newline mode.
- **Commits:** every commit message ends with exactly one trailer line, `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Verification commands:** `npm test`, `npm run check`, and `cargo test --manifest-path src-tauri/Cargo.toml`. All must stay green at the end of every task.

## Review Focus

Each of these risks has a test in the task that owns the code.

1. **A repo without a git identity, or with `commit.gpgSign=true`.** `commit-tree` must not fail or prompt. Run it with `--no-gpg-sign` and with `GIT_AUTHOR_*` and `GIT_COMMITTER_*` set to `riff` / `riff@localhost`. (Task 1 test `rebase_check_ignores_signing_config`.)
2. **A dirty working tree, an index or HEAD changed by the check.** All must be byte-identical afterwards. (Task 1 test `rebase_check_leaves_repo_untouched`.)
3. **Korean or space-containing file names in a conflict.** They must come back verbatim, not quoted or escaped. Parse `-z` output. (Task 1 test `rebase_check_reports_korean_paths_verbatim`.)
4. **A Branch-mode gitlink range whose side is `EMPTY_TREE`** (a submodule added or removed). No check runs, no error shows, and `rebase` stays `null`. (Task 4 test.)
5. **A group's range changing while its check runs, or the table being cleared.** The old result must not land on the new group, and the old run is cancelled. (Task 4 tests.)

---

### Task 1: Backend `rebase_check`

**Files:**
- Modify: `src-tauri/src/git/mod.rs`. Add the types next to `RebaseStep` and the trait method after `rebase_interactive`.
- Modify: `src-tauri/src/git/cli.rs`. Add the impl in `impl GitLayer for GitCli` next to `rebase_plan`, the helpers as free functions near `squash_check`'s helpers, and the tests in the existing `mod tests`.

**Interfaces:**
- Produces (Rust, exported from `git`):
```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConflictFile { pub path: String, pub kind: Option<String> }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RebaseCheck {
    Clean { commits: u32 },
    Conflict { at: u32, total: u32, commit: Commit, files: Vec<ConflictFile> },
    Nothing,
    CantCheck { reason: String },
    Cancelled,
}

// GitLayer
fn rebase_check(
    &self, path: &Path, upstream: &str, branch: &str,
    steps: Option<&[RebaseStep]>,
    on_step: &mut dyn FnMut(u32, u32) -> bool,
) -> Result<RebaseCheck, GitError>;
```
- `branch` empty means HEAD, as in `rebase_plan`.
- `at` is 1-based, counting replayed (non-drop) commits. `total` and `commits` both mean the number of replayed commits.
- `on_step(done, total)` is called before each replay step, with `done` = steps finished so far. If it returns `false`, the method returns `Ok(Cancelled)` immediately.

**Algorithm (not determined by the signature):**
1. If the git version is below 2.40, return `Ok(CantCheck { reason: "needs git 2.40+" })`.
   - Read the version with `parse_git_version(stdout_of("git --version")) -> Option<(u32, u32)>`, cached in a `OnceLock`.
   - An unparseable version proceeds as if the check is supported.
2. Get the commit list with `plan = self.rebase_plan(path, upstream, branch)?`. With `steps = Some(s)`:
   - Build the list as `s` minus `drop`, in `s` order. Map each sha to its `Commit` in `plan`.
   - A sha missing from `plan` is `Err(GitError)` with the message `rebase plan is out of date`, built the way other validation errors in cli.rs are.
3. If the list is empty, return `Nothing`.
4. Start with `cur = rev-parse <upstream>^{commit}`. For each commit `c` (position `i`, 0-based):
   - Call `on_step(i, total)`; if it returns `false`, return `Cancelled`.
   - If `c.parents` is empty, return `CantCheck { reason: format!("{} has no parent", c.short_sha) }`.
   - Run `git -C path merge-tree --write-tree -z --name-only --merge-base=<c.parents[0]> <cur> <c.sha>`.
     - **Exit 0:** the first NUL-terminated field is the tree. Unless this is the last commit, set `cur` to the output of `git commit-tree --no-gpg-sign <tree> -p <cur> -m "riff rebase preview"`, with `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME` and `GIT_COMMITTER_EMAIL` set to `riff` / `riff@localhost`.
     - **Exit 1:** return `Conflict { at: i+1, total, commit: c, files: parse_merge_tree_conflicts(&stdout) }`.
     - **Any other exit:** return `Err(GitError)` carrying stderr.
5. If every commit replayed cleanly, return `Clean { commits: total }`.

**`parse_merge_tree_conflicts(out: &[u8]) -> Vec<ConflictFile>`** reads `-z` output (verified on git 2.43):
- Fields are separated by NUL: `tree`, then conflicted paths, then an empty field, then message records.
- Each message record is `<count>`, then `count` paths, then `<type>`, then `<message>`.
- Stop at a field that is not a number. Submodule conflicts append free text after the last record.
- Kind for each path, from the first record whose `type` starts with `CONFLICT (` and whose inner text is not `contents`:
  - inner text starting with `submodule` gives `"submodule"`;
  - any other inner text is used as is (`binary`, `modify/delete`, `add/add`, …).
- A path with no such record has kind `None`.
- Return the conflicted paths in listed order.

- [ ] **Step 1: Write the failing tests** in `cli.rs` `mod tests`.

  Add a fixture helper `check_fixture(name) -> PathBuf`, built on the existing `temp_repo` / `commit_file`, with `core.autocrlf=false`:
  - `base` has `f.txt` = `a\nb\nc\n` and `g.txt` = `1\n`.
  - `topic` off it has commits `t1` (g.txt → `2\n`), `t2` (f.txt line 2 → `T`) and `t3` (adds h.txt = `h\n`, so it replays cleanly in any order).
  - `base` then gets `b1` (f.txt line 2 → `B`).
  - Leave `base` checked out.

  Tests:
```rust
#[test] fn rebase_check_clean_branch() {
    // topic2 off base touching only h.txt, two commits
    // assert matches!(r, RebaseCheck::Clean { commits: 2 })
}
#[test] fn rebase_check_stops_at_first_conflict() {
    // check_fixture: r == Conflict { at: 2, total: 3, commit.summary == "t2",
    //   files == [ConflictFile { path: "f.txt", kind: None }] }
}
#[test] fn rebase_check_nothing_to_replay() {
    // check_fixture: rebase_check(repo, "base", "base", None, ..) == Nothing
    // and all steps dropped == Nothing
}
#[test] fn rebase_check_follows_edited_plan() {
    // steps: drop t2 -> Clean { commits: 2 }
    // steps: t3, t1 reordered (t2 dropped) -> Clean { commits: 2 }
    // steps: [t2(pick), t1(squash), t3(fixup)] -> Conflict { at: 1, total: 3 }
    // a step sha not in the plan -> Err
}
#[test] fn rebase_check_cancel_stops() {
    // on_step returns false when done == 1 -> Cancelled; on_step saw (0,3),(1,3)
}
#[test] fn rebase_check_names_binary_conflicts() {
    // both sides change bin.uasset bytes [0,2] vs [0,3] -> files contains
    //   ConflictFile { path: "bin.uasset", kind: Some("binary") }
}
#[test] fn rebase_check_reports_korean_paths_verbatim() {
    // conflicting file "한글 파일.txt" -> files[0].path == "한글 파일.txt"
}
#[test] fn rebase_check_ignores_signing_config() {
    // clean 2-commit case with config commit.gpgsign=true, gpg.program=does-not-exist,
    // and user.name/user.email unset (config --unset) -> Clean { commits: 2 }
}
#[test] fn rebase_check_leaves_repo_untouched() {
    // dirty f.txt edit + staged g.txt edit; record rev-parse HEAD, show-ref output,
    // `git status --porcelain=v2`, `git diff`, `git diff --cached`;
    // run conflicting and clean checks; all five identical afterwards
}
#[test] fn parse_merge_tree_conflicts_reads_kinds() {
    // literal bytes: b"tree\0sub\0f\0\01\0sub\0CONFLICT (submodule not initialized)\0msg\0\
    //   1\0sub\0CONFLICT (contents)\0msg\0Recursive merging ...\n\01\0f\0Auto-merging\0m\0"
    // -> [sub: Some("submodule"), f: None]
}
#[test] fn parse_git_version_reads_windows_suffix() {
    // "git version 2.43.0.windows.1\n" -> Some((2,43)); "git version 2.39.2" -> Some((2,39)); "x" -> None
}
```
  Fill in each body. The comments state the exact assertions. Remove each test's repo at the end, as the existing tests do.

- [ ] **Step 2: Run them to see them fail.**
  Run: `cargo test --manifest-path src-tauri/Cargo.toml rebase_check parse_merge_tree parse_git_version`
  Expected: compile error, `rebase_check` not found.

- [ ] **Step 3: Implement** the types, the trait method, the impl, `parse_merge_tree_conflicts` and `parse_git_version` as specified above.
  - `rebase_check` is read-only: no `write_lock`, no `drop_session`, as in `rebase_plan`.
  - Call git through `git_command()`, so the Windows no-window flag applies.

- [ ] **Step 4: Run all cargo tests.**
  Run: `cargo test --manifest-path src-tauri/Cargo.toml`
  Expected: all pass (143 previously, plus the new ones).

- [ ] **Step 5: Commit.**
  `git add src-tauri/src/git/mod.rs src-tauri/src/git/cli.rs`
  Message: `feat(rebase): simulate a rebase with merge-tree to find the first conflict`.

### Task 2: Tauri command and frontend `rebaseCheck.ts`

**Files:**
- Modify: `src-tauri/src/lib.rs`. Add the commands and managed state, and register them next to `rebase_plan`.
- Modify: `src/lib/types.ts`, `src/lib/git.ts`.
- Create: `src/lib/rebaseCheck.ts`, `src/lib/rebaseCheck.test.ts`.

**Interfaces:**
- Consumes: `GitLayer::rebase_check` and `RebaseCheck` / `ConflictFile` from Task 1.
- Produces (Rust):
  - `#[derive(Default)] struct RebaseChecks(Mutex<HashSet<u32>>)`, the set of cancelled ids, registered with `.manage(RebaseChecks::default())`.
  - A `#[derive(Clone, Serialize)] struct RebaseCheckProgress { done: u32, total: u32 }`.
  - `async fn rebase_check(state, checks: State<RebaseChecks>, path: String, upstream: String, branch: String, steps: Option<Vec<RebaseStep>>, id: u32, on_progress: Channel<RebaseCheckProgress>) -> Result<RebaseCheck, GitError>`.
    - Its `on_step` sends progress and returns `!checks.remove(&id)`.
    - After the call returns, it removes `id` from the set.
  - `fn cancel_rebase_check(checks: State<RebaseChecks>, id: u32)` inserts `id`.
- Produces (TS, `types.ts`): `ConflictFile`, `RebaseCheck`, `RebaseCheckProgress`, mirroring Rust. `RebaseCheck` is a union on `kind`: `"clean" | "conflict" | "nothing" | "cant_check" | "cancelled"`, with the Rust field names.
- Produces (TS, `git.ts`):
  - `rebaseCheck(path, upstream, branch: string, steps: RebaseStep[] | null, id: number, onProgress: (p: RebaseCheckProgress) => void): Promise<RebaseCheck>`, which uses `Channel` the way `diffFiles` does.
  - `cancelRebaseCheck(id: number): Promise<void>`.
- Produces (TS, `rebaseCheck.ts`):
```ts
export type CheckState =
  | { kind: "checking"; done: number; total: number }
  | Exclude<RebaseCheck, { kind: "cancelled" }>;
export type ConflictCheck = Extract<RebaseCheck, { kind: "conflict" }>;
/// Starts a check; onUpdate gets {checking,0,0} at once, progress, then the
/// result. Returns cancel(): calls cancelRebaseCheck(id) and guarantees no
/// further onUpdate. A rejection becomes {kind:"cant_check", reason: first line of String(e)}.
/// A "cancelled" result is never passed on. branch null → "".
export function startRebaseCheck(path: string, upstream: string, branch: string | null,
  steps: RebaseStep[] | null, onUpdate: (s: CheckState) => void): () => void;
export function checkText(s: CheckState): string;          // full form
export function checkBadge(s: CheckState): string;         // compact form (Branch mode)
export function filesText(files: ConflictFile[]): string;  // "a.txt, bin.uasset (binary)"
export function aiRequest(o: { repoPath: string; branch: string; target: string;
  conflict: ConflictCheck;
  plan?: { action: RebaseAction; short: string; summary: string }[] }): string;
```

**Exact copy:**
- **`checkText`:**
  - checking: `checking…` when `total` is 0, else `checking ${done}/${total}…`
  - clean: `✓ no conflicts (${n} commit${n === 1 ? "" : "s"})`
  - conflict: `⚠ conflict at ${short_sha} ${summary} (${at} of ${total})`
  - nothing: `nothing to rebase`
  - cant_check: `can't check (${reason})`
- **`checkBadge`:** the same as `checkText`, except clean is `✓` and conflict is `⚠ conflict at ${short_sha}`.
- **`aiRequest`:** lines joined with `\n`. The plan block is included only when `plan` is given.
```
{repoPath} 에서 {branch} 를 {target} 위로 rebase 해줘.
interactive rebase 로, 아래 계획대로 진행해 (위에서부터 순서대로):
  {action} {short} {summary}
riff 미리 보기에서 conflict 가 예상돼:
- {short_sha} "{summary}" ({total}개 중 {at}번째): {filesText(files)}
이후 커밋도 conflict 가 날 수 있어.
conflict 마다 양쪽 커밋의 의도를 확인하고 해결해. 의도가 애매하면 멈추고 물어봐.
끝나면 각 conflict 를 어떻게 해결했는지 요약해줘.
```

- [ ] **Step 1: Write the failing tests** in `src/lib/rebaseCheck.test.ts`. Mock `./git` with `rebaseCheck` and `cancelRebaseCheck` as `vi.fn()`. Tests:
  - **Progress then result:** `startRebaseCheck` emits `{checking,0,0}`, then the progress the mock reports through its `onProgress` argument, then the resolved clean result.
  - **Cancel:** after `cancel()`, a later resolve calls no `onUpdate`, and `cancelRebaseCheck` was called with the same id `rebaseCheck` got.
  - **Unique ids:** two starts use different ids.
  - **Rejection:** a rejection `"fatal: bad revision 'x'\nmore"` becomes `{kind:"cant_check", reason:"fatal: bad revision 'x'"}`.
  - **Cancelled result:** a resolved `{kind:"cancelled"}` is not emitted.
  - **`branch` null:** it is passed to `rebaseCheck` as `""`.
  - **`checkText` / `checkBadge`:** every kind, including singular `1 commit`, matches the exact copy above.
  - **`filesText`:** `[{path:"a.txt",kind:null},{path:"b.uasset",kind:"binary"}]` gives `"a.txt, b.uasset (binary)"`.
  - **`aiRequest`:** the full expected string for a plain request, and for one with a plan of 2 lines (`pick` / `drop`).

- [ ] **Step 2: Run** `npx vitest run src/lib/rebaseCheck.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement** the Rust commands and state, the TS types, the `git.ts` wrappers and `rebaseCheck.ts`. The id counter is module-local and starts at 1.

- [ ] **Step 4: Run** `npm test`, `npm run check` and `cargo test --manifest-path src-tauri/Cargo.toml`. Expected: all green, 0 check errors.

- [ ] **Step 5: Commit.**
  `git add src-tauri/src/lib.rs src/lib/types.ts src/lib/git.ts src/lib/rebaseCheck.ts src/lib/rebaseCheck.test.ts`
  Message: `feat(rebase): expose the conflict check with progress and cancel`.

### Task 3: `RebaseCheckLine`, plain-rebase confirm overlay, plan editor

**Files:**
- Create: `src/lib/ui/RebaseCheckLine.svelte`, `src/lib/ui/RebaseConfirmOverlay.svelte`.
- Modify: `src/lib/rebase.ts` (`requestRebase`, plus a new `confirmRebase`), `src/lib/types.ts` (`RebaseConfirm`), `src/lib/store.svelte.ts` (`rebaseConfirm`), `src/lib/ui/RebaseTodoOverlay.svelte`, `src/routes/+page.svelte` (mount next to `<RebaseTodoOverlay />`).

**Interfaces:**
- Consumes: `startRebaseCheck`, `checkText`, `checkBadge`, `filesText`, `aiRequest`, `CheckState` (Task 2).
- Produces:
  - **`RebaseCheckLine.svelte`** with props `{ state: CheckState | null; request: (c: ConflictCheck) => string; compact?: boolean; prefix?: string }`.
    - It renders nothing when `state` is null.
    - **Compact:** one inline span, `prefix + checkBadge(state)`. On conflict, its `title` is the files one per line plus `Later commits may conflict too.`
    - **Full:** `checkText(state)`. On conflict, each file is listed (`path` plus ` (kind)`) and a muted line reads `Later commits may conflict too.`
    - **Copy button:** on conflict only, a button `Copy request for AI` writes `request(state)` with `navigator.clipboard.writeText` and shows `Copied` for 1.5 s.
    - **Colours:** ✓ uses `var(--ok-fg, #3fb950)`. ⚠ uses `var(--warn-fg, #d29922)`; define `--warn-fg` nowhere new, the fallback is enough. `can't check` is muted.
  - **`types.ts`:** `export interface RebaseConfirm extends RebasePlan { what: string; switchesTo: string | null }`.
  - **`store.svelte.ts`:** `rebaseConfirm = $state<RebaseConfirm | null>(null)`.
  - **`rebase.ts`:**
    - `requestRebase` keeps its plan query and its "nothing to replay" error. In place of `confirmAction` it sets `appState.rebaseConfirm`, with `switchesTo` = `branch` when `branch && branch !== appState.currentBranch`, else null.
    - New `export async function confirmRebase(): Promise<void>` closes the overlay and runs `runRebase(() => rebase(repoPath, upstream, branch))`.
    - Remove the `confirmAction` import if it becomes unused.

**`RebaseConfirmOverlay.svelte`:**
- **Styling:** the same backdrop, dialog, head and foot classes and the same Esc handling as `RebaseTodoOverlay` (copy its style block; the two overlays never stack).
- **Head:** `Rebase {what} onto {shortTarget(upstream)}`. Export `shortTarget` from `rebase.ts`.
- **Body text:**
  - `N commit(s) will be rewritten. The pre-rebase tip stays recoverable from the reflog (Ctrl+Shift+R).`
  - `riff will end up on {switchesTo}.` when set.
  - `<RebaseCheckLine>` in full form.
- **Foot:** Cancel and Rebase. Rebase is enabled in every check state.
- **Check:** a `$effect` keyed on `appState.rebaseConfirm` starts `startRebaseCheck(repoPath, upstream, branch, null, s => state = s)` and returns the cancel function as its teardown.
- **Request:** `aiRequest({ repoPath, branch: what, target: upstream, conflict })`.

**`RebaseTodoOverlay.svelte`:**
- **Re-check:** add `let check = $state<CheckState | null>(null)` and a `$effect`.
  - It reads `appState.rebasePlan`, `problem` and the key `rows.map(r => r.action + ":" + r.sha).join(",")`.
  - With a plan and no `problem`, it starts `startRebaseCheck(plan.repoPath, plan.upstream, plan.branch, steps, s => check = s)`, where `steps` = rows as `RebaseStep[]`. Otherwise it sets `check = null`.
  - Its teardown cancels the run, so the newest run wins and closing the overlay stops it.
- **Line:** render `<RebaseCheckLine state={check} …>` in full form between `.rb-body` and `.rb-foot`.
- **Row mark:** the row whose `sha` equals `check.commit.sha` (conflict only) gets `<span class="rb-warn" title={filesText(check.files)}>⚠</span>` after `.rb-sha`.
- **Request:** `aiRequest({ repoPath, branch: plan.branch ?? appState.currentBranch ?? "HEAD", target: plan.upstream, conflict, plan: rows.map(r => ({ action: r.action, short: r.short, summary: r.summary })) })`.

- [ ] **Step 1:** Implement the pieces above. There are no Svelte component tests in this repo; the logic they call is tested in Task 2.
- [ ] **Step 2: Run** `npm test` and `npm run check`. Expected: all pass, 0 errors and 0 warnings in the touched files.
- [ ] **Step 3: Manual check** with `npm run tauri dev`, on a scratch repo with a conflicting branch and a clean one.
  - **Clean branch:** refs sidebar "Rebase … onto …" opens the overlay, shows ✓, and Rebase works.
  - **Conflicting branch:** shows ⚠ with the file. Copy puts the Korean text on the clipboard. Cancel closes it. Rebase is still possible.
  - **Plan editor:** shows the line. Dropping the conflicting commit flips it to ✓, and the ⚠ row mark follows the commit. Squash on the first row hides the line.
  - Record the result in the commit body or report. If a GUI run isn't possible, say so in the report; do not claim it was checked.
- [ ] **Step 4: Commit.**
  `git add src/lib/ui/RebaseCheckLine.svelte src/lib/ui/RebaseConfirmOverlay.svelte src/lib/rebase.ts src/lib/types.ts src/lib/store.svelte.ts src/lib/ui/RebaseTodoOverlay.svelte src/routes/+page.svelte`
  Message: `feat(rebase): preview conflicts before a plain or interactive rebase`.

### Task 4: Branch mode

**Files:**
- Modify: `src/lib/types.ts` (`BcGroup.rebase`), `src/lib/branchContainment.ts`, `src/lib/branchContainment.test.ts`, `src/lib/ui/CommitTable.svelte`, `README.md` (one bullet in the "커밋 표 (상단)" section).

**Interfaces:**
- Consumes: `startRebaseCheck`, `CheckState`, `aiRequest`, `RebaseCheckLine` (Tasks 2 and 3), and `EMPTY_TREE` from `./emptyTree`.
- Produces:
  - `BcGroup.rebase: CheckState | null`, where `emptyGroup` sets `null`.
  - `export function cancelRebaseChecks(): void` from `branchContainment.ts`.

**Behaviour in `branchContainment.ts`:**
- **Run map:** a module `const rebaseRuns = new Map<number, { cancel: () => void }>()`.
- **`checkRebase(idx: number): void`** (not exported):
  1. Cancel and delete any run for `idx`.
  2. Take `g = appState.bcGroups[idx]`. If it is missing, or `g.base` or `g.compare` is `EMPTY_TREE`, patch `rebase: null` and return.
  3. Otherwise create `run = {cancel}` from `startRebaseCheck(g.path, g.base, g.compare, null, onUpdate)` and store it.
  4. `onUpdate` patches `{ rebase: s }` only while `rebaseRuns.get(idx) === run` and the group at `idx` still has the same `path`, `base` and `compare`.
- **Where it is called:** in `loadGroup`, right after the `patchGroup({... status: "ready" ...})`, with `checkRebase(idx)` (not awaited, before `settlePick`). Groups that `refreshGroup` skips (tips unmoved) keep their result and are not re-checked, except a group left without an answer: when tips are unmoved, `!rebaseRuns.has(idx)`, and `g.rebase` is `null` or `checking`, call `checkRebase(idx)`. This matters because CommitTable unmounts while a commit view is open in Branch mode; its `onDestroy` cancels the runs, and the refresh on remount must restart them.
- **Clearing:** `clearBranchContainment()` calls `cancelRebaseChecks()`, which cancels and clears every run.

**`CommitTable.svelte`:**
- **Cleanup:** `onDestroy(cancelRebaseChecks)`.
- **One group shown** (`visible.length === 1`): render `<RebaseCheckLine compact state={g.rebase} prefix={`rebase onto ${names.base}: `} request={…}>` in `.ct-summary` after the summary text.
- **Several groups shown:** render the same component inside each `.ct-group` header after `.g-counts`, for groups with a range that resolved.
- **Request:** `aiRequest({ repoPath: g.path, branch: g.compare, target: g.base, conflict })`.

- [ ] **Step 1: Write the failing tests** in `branchContainment.test.ts`.
  - Mock `./rebaseCheck`'s `startRebaseCheck` as `vi.fn()` returning a cancel spy, and capture `onUpdate`. Add it to the reset list.
  - Tests:
    - **Loaded group:** after a load, `startRebaseCheck` is called with `(path, base, compare, null, fn)`. Calling the captured `onUpdate({kind:"clean",commits:2})` sets `bcGroups[0].rebase`.
    - **Range changes:** the old run's cancel spy was called, and its `onUpdate` no longer patches the new group.
    - **EMPTY_TREE side:** a gitlink range with `base = EMPTY_TREE` does not call `startRebaseCheck`, and `rebase` stays `null`.
    - **Unmoved tips:** a refresh with unmoved tips does not start a second check while one is running or answered.
    - **Restart:** after `cancelRebaseChecks()`, a refresh with unmoved tips starts the check again.
    - **`clearBranchContainment()`:** cancels the running check.
- [ ] **Step 2: Run** `npx vitest run src/lib/branchContainment.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the behaviour above, plus the README bullet. The bullet reads: `rebase onto <base>: ✓ / ⚠ — compare 를 base 위로 rebase 했을 때 첫 conflict 커밋과 파일을 미리 보여줌 (읽기 전용). ⚠ 에서는 AI 요청문 복사 가능.`
- [ ] **Step 4: Run** `npm test`, `npm run check` and `cargo test --manifest-path src-tauri/Cargo.toml`. Expected: all green.
- [ ] **Step 5: Manual check** with `npm run tauri dev`, in Branch mode with a single repo and with Unified multi-repo. The badge appears and the tooltip lists the files. Switching the compare branch re-checks. If not run, say so.
- [ ] **Step 6: Commit.**
  `git add src/lib/types.ts src/lib/branchContainment.ts src/lib/branchContainment.test.ts src/lib/ui/CommitTable.svelte README.md`
  Message: `feat(branch): show the rebase conflict preview in the commit table`.
