# PR Review Mode — Plan 1: Foundation (no AI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working PR Review mode without AI. It lists the PRs where the user is a requested reviewer (and PRs they reviewed that are still open), fetches a PR without checkout, and shows its diff with the existing threads. The user can comment, reply and resolve, collect drafts in a separate drafts window, and submit one GitHub review pinned to the latest head. Drafts survive restarts and author pushes.

**Architecture:**
- **Rust:** the backend stays thin. New git plumbing (PR fetch into `refs/riff/pr/<N>/*`, hunk ranges, changed-since) lives in `GitCli`. A `github` module shells out to the `gh` CLI (`gh api --hostname`), so riff never handles tokens. A `store::review` module persists one opaque JSON record per PR.
- **TypeScript:** all GitHub logic (GraphQL queries, mapping, submit orchestration) and every pure algorithm (remote parsing, commentable lines, re-anchoring) live in `src/lib/review/`, unit-tested with vitest.
- **UI:** Svelte components under `src/lib/ui/review/`. `DiffView` is reused through new props, and inline widgets come from a CodeMirror extension.

**Tech Stack:** Tauri 2, Rust, Svelte 5 runes, TypeScript, CodeMirror 6 (`@codemirror/merge`), vitest, `gh` CLI ≥ 2.x, GitHub GraphQL API (GHES 3.20 verified).

**Spec:** `docs/superpowers/specs/2026-11-07-pr-review-mode-design.md`

This is plan 1 of 3. Plan 2 (AI analysis: find/verify, chapters, inline findings, Unconfirmed, queue, notifications) and plan 3 (re-review verification) build on the interfaces defined here.

## Global Constraints

- Nothing reaches GitHub without an explicit user action. Only Submit and resolve/unresolve call write APIs.
- Never touch the working tree, index, HEAD, branches, or the user's refs. The only repo writes are to `refs/riff/pr/<N>/{head,base,seen}`.
- `refs/riff/*` never appears in riff's ref views, graph, or pickers.
- Authentication only through the `gh` login for the host. No PAT entry, no OAuth. If gh is missing or logged out, show `gh auth login --hostname <host>`.
- Submit is always pinned to the PR's **latest** head (`commitOID`). It is blocked until the user has seen the latest head (`viewedHead === headSha`).
- Losing a draft is an anti-goal. A failed submit, a restart, or an author push must leave draft items intact.
- Only repos open in riff (`appState.repos`: main, submodules, manual) take part.
- PR list refresh happens on mode enter, on the manual button, and every **5 minutes** (300 000 ms) while the mode is open.
- Resolve/unresolve take effect immediately; they are not part of the review.
- Follow existing patterns: long work runs off the UI thread; stale async results never land over newer ones (sequence tokens, as in `branchContainment.ts`); spawn processes with `CREATE_NO_WINDOW` on Windows (`git_command()`).

## Review Focus

1. **A comment on a line GitHub won't accept.** riff's own diff (`similar`) can disagree with git's hunks. Commentable lines must come only from `git diff -U3` hunk headers (`pr_hunks`), and the gutter offers "+" only there. Pinned by Task 2 `pr_hunks_match_git_headers` and Task 5 `isCommentable` tests.
2. **The author force-pushes or rebases between drafting and submit.** Anchors must re-place by quoted text, choosing the nearest duplicate, and flag the rest as unplaced. Unplaced items must survive a successful submit. Pinned by Task 5 `reanchor*` tests and Task 8 `keeps unplaced items after submit`.
3. **Submit fails midway** (one thread rejected, network drop). The pending review riff created is deleted, the draft stays intact, and a retry starts clean. Pinned by Task 8 `deletes own pending review on failure`.
4. **A pending review already exists** (started on the web). The user chooses add or discard. riff never silently creates a second one or deletes the user's. Pinned by Task 8 `existing pending review` tests.
5. **Remote and auth variety.** Handle `git@host:o/r.git`, `ssh://git@host:22/o/r.git`, `https://host/o/r`, a non-GitHub remote, gh missing, or gh logged out for one host while another host works. Each yields a per-host message, never a crash. Pinned by Task 5 `parseRemote` tests and Task 3 `interpret_*` / `status_*` tests.

---

## File Structure

**Rust (`src-tauri/src/`)**
- `git/cli.rs` (modify): exclude `refs/riff/*` from every `--all`. Add `remotes`, `fetch_pr`, `pr_hunks`, `pr_changed_files`, `mark_pr_seen`, and pure parsers.
- `git/mod.rs` (modify): types `Remote`, `Hunk`, `FileHunks`, and trait methods.
- `github/mod.rs` (create): `gh` process wrapper with pure `interpret` and `gh_args`.
- `store/review.rs` (create), `store/mod.rs` (modify: `pub mod review;`): per-PR JSON records.
- `lib.rs` (modify): commands and registration.
- `capabilities/default.json` (modify): drafts window and create-window permission.

**TypeScript (`src/lib/review/`)**
- `types.ts`: shared review types (below).
- `remote.ts`: `parseRemote`.
- `commentable.ts`: `isCommentable`, `placeTarget`.
- `anchor.ts`: `reanchor`.
- `gh.ts`: thin invoke wrappers for the Rust commands (mocked in tests).
- `github.ts`: GraphQL queries, mappers, mutations.
- `draft.ts`: pure draft reducers.
- `draftStore.ts`: load/save/sync across windows.
- `submit.ts`: submit orchestration.
- `prList.ts`: list building, section merge, refresh timer.
- `reviewState.svelte.ts`: review-mode state and actions.

**UI (`src/lib/ui/review/`)**
- `ReviewView.svelte`: mode layout.
- `PrList.svelte`, `PrOverview.svelte`, `ReviewFiles.svelte`, `ReviewBar.svelte`, `NewSinceView.svelte`, `PendingReviewDialog.svelte`.
- `DraftsWindow.svelte`: drafts window root.
- `InlineThread.svelte`, `InlineDraft.svelte`, `Composer.svelte`: inline widgets.
- `cmReview.ts`: CodeMirror extension for gutter "+" and block widgets.

**Modified UI:** `src/lib/types.ts` (`AppMode`), `src/lib/ui/InputBar.svelte`, `src/routes/+page.svelte`, `src/lib/compare.ts` (`cycleAppMode`), `src/lib/commands.ts`, `src/lib/history.ts` (if it enumerates modes), `src/lib/ui/DiffView.svelte`.

### Shared TypeScript types (`src/lib/review/types.ts`, defined in Task 5, used everywhere)

```ts
export type Side = "LEFT" | "RIGHT";
export interface GhRepo { host: string; owner: string; name: string }
export type PrKey = string; // `${host}/${owner}/${name}#${number}`
export interface Hunk { oldStart: number; oldLines: number; newStart: number; newLines: number }
export interface FileHunks { path: string; oldPath: string | null; hunks: Hunk[] }
export interface PrSummary {
  key: PrKey; repo: GhRepo; repoIdx: number; remote: string; nodeId: string; number: number;
  title: string; author: string; url: string; additions: number; deletions: number;
  headSha: string; baseSha: string; baseRef: string; updatedAt: string;
  section: "requested" | "reviewed"; myLastReviewSha: string | null;
}
export interface ThreadComment { id: string; author: string; body: string; createdAt: string }
export interface ReviewThread {
  id: string; path: string; side: Side; line: number | null; startLine: number | null;
  originalLine: number | null; isResolved: boolean; isOutdated: boolean;
  subjectType: "LINE" | "FILE"; comments: ThreadComment[];
}
export interface PrDetail {
  body: string; headSha: string; baseSha: string; conversation: ThreadComment[];
  threads: ReviewThread[]; pendingReviewId: string | null;
}
export type DraftTarget =
  | { kind: "line"; path: string; side: Side; line: number; startLine: number | null; quote: string[] }
  | { kind: "file"; path: string; location: string }
  | { kind: "body"; location: string }
  | { kind: "reply"; threadId: string; preview: string };
export type DraftOrigin = "mine" | "ai" | "ai-edited" | "ai-unconfirmed";
export interface DraftItem { id: string; target: DraftTarget; body: string; origin: DraftOrigin; unplaced: boolean }
export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
export interface PrRecord {
  version: 1; key: PrKey; items: DraftItem[]; body: string; event: ReviewEvent;
  anchorHead: string | null;  // head SHA the line anchors refer to
  viewedHead: string | null;  // latest head the user has seen
}
```

`DraftOrigin` and the `file`/`body` kinds exist now so that plan 2 can add AI findings without changing the types. In plan 1, users create `line` and `reply` items only.

---

### Task 1: Hide `refs/riff/*` from every `--all`

**Files:**
- Modify: `src-tauri/src/git/cli.rs:1096`, `:2234`, `:2286`, `:2347`
- Test: `src-tauri/src/git/cli.rs` (`mod tests`)

**Interfaces:**
- Produces: `const ALL_REFS: [&str; 2] = ["--exclude=refs/riff/*", "--all"];` in `cli.rs`.

- [ ] **Step 1: Write the failing test** `commit_log_all_ignores_riff_refs`. Use `temp_repo`, then `commit_file` on a detached commit: `git checkout -q --detach`, commit `x`, `git update-ref refs/riff/pr/1/head HEAD`, `git checkout -q -`. Assert that `cli.commit_log(&repo, "", true, 50, 0)` contains no commit with summary `"x"`.
- [ ] **Step 2: Run** `cd src-tauri && cargo test commit_log_all_ignores_riff_refs`. Expected: FAIL (the commit `x` is listed).
- [ ] **Step 3: Replace each `push("--all")` with `extend(ALL_REFS)`.** At `:2347`, where `source` is a single `&str`, build the rev-list args as a `Vec<&str>` that is `ALL_REFS` when `source` is empty. `--exclude` must come before `--all`.
- [ ] **Step 4: Run** `cargo test`. Expected: all pass.
- [ ] **Step 5: Commit** `fix(graph): keep riff-private PR refs out of --all walks`.

---

### Task 2: Git PR plumbing (fetch, hunks, changed-since, seen)

**Files:**
- Modify: `src-tauri/src/git/mod.rs` (types and trait methods next to `has_commit`), `src-tauri/src/git/cli.rs`, `src-tauri/src/lib.rs`
- Test: `src-tauri/src/git/cli.rs` (`mod tests`)

**Interfaces:**
- Produces (Rust, serde `rename_all = "camelCase"` on the three structs so TypeScript gets `oldStart` and so on):
  - `struct Remote { name: String, url: String }`
  - `struct Hunk { old_start: u32, old_lines: u32, new_start: u32, new_lines: u32 }`
  - `struct FileHunks { path: String, old_path: Option<String>, hunks: Vec<Hunk> }`
  - `fn remote_urls(&self, path) -> Result<Vec<Remote>, GitError>`: parses `git remote -v`, fetch lines only. (The name `remotes` is already taken by a private helper in `write.rs:388`.)
  - `fn fetch_pr(&self, path, remote: &str, number: u32, base_ref: &str, base_sha: &str) -> Result<String, GitError>`: returns the head SHA.
  - `fn pr_hunks(&self, path, base: &str, head: &str) -> Result<Vec<FileHunks>, GitError>`
  - `fn pr_changed_files(&self, path, base: &str, old_head: &str, new_head: &str) -> Result<Vec<String>, GitError>`
  - `fn mark_pr_seen(&self, path, number: u32, sha: &str) -> Result<(), GitError>`
  - Pure: `fn parse_hunks(patch: &str) -> Vec<FileHunks>` and `fn normalize_patch(patch: &str) -> String`
- Tauri commands (snake_case args): `git_remotes(path)`, `fetch_pr(path, remote, number, base_ref, base_sha)`, `pr_hunks(path, base, head)`, `pr_changed_files(path, base, old_head, new_head)`, `mark_pr_seen(path, number, sha)`.

- [ ] **Step 1: Write the failing tests.**
  - `parse_hunks_reads_headers_renames_and_deletes`: a patch literal with one modified file (two hunks `@@ -3,7 +3,8 @@` and `@@ -40 +41,2 @@`), one rename (`rename from a.txt` / `rename to b.txt` plus a hunk), and one deletion (`+++ /dev/null`). Assert:
    - `[FileHunks{path:"m.rs", hunks:[{3,7,3,8},{40,1,41,2}]}, FileHunks{path:"b.txt", old_path:Some("a.txt"), ..}, FileHunks{path:"gone.txt", ..}]`;
    - an omitted count means 1.
  - `normalize_patch_ignores_line_numbers_and_index`: two patches that differ only in `@@` numbers and the `index` line normalize equal; a changed `+` line does not.
  - `pr_hunks_match_git_headers`: a fixture repo with base and topic commits. Compare `pr_hunks(base, topic)` with the hunk headers parsed from a direct `git diff -U3 base...topic` run in the test.
  - `fetch_pr_fetches_pull_ref_without_touching_branches`: reuse the bare-remote fixture pattern at `cli.rs:3283`. In the bare repo, `update-ref refs/pull/7/head <topic sha>`. Then call `fetch_pr(&clone, "origin", 7, "main", <main sha>)` and assert:
    - it returns the topic sha;
    - `refs/riff/pr/7/head` and `refs/riff/pr/7/base` exist;
    - `git branch --list` is unchanged;
    - `HEAD` is unchanged;
    - `list_refs` does not include them.
  - `fetch_pr_rejects_bad_input`: number `0`, and a base_ref of `"--upload-pack=x"`, both return `Err(InvalidRef)`.
  - `pr_changed_files_ignores_rebase_noise`: the PR edits `a.txt`. A second head is the same change rebased onto a base that also changed `b.txt`, plus an extra edit to `c.txt`. Assert the result is `["c.txt"]`.
  - `mark_pr_seen_writes_seen_ref`: `refs/riff/pr/3/seen` resolves to the given sha.
- [ ] **Step 2: Run** `cargo test pr_ fetch_pr parse_hunks normalize_patch mark_pr_seen`. Expected: FAIL (functions not defined).
- [ ] **Step 3: Implement.**
  - `fetch_pr`:
    - Validate `number >= 1` and `base_ref` with `validate_ref`.
    - Run `run_network(["fetch","--no-tags",remote,"+refs/pull/N/head:refs/riff/pr/N/head","+refs/heads/<base_ref>:refs/riff/pr/N/base"])`.
    - If `!has_commit(base_sha)`, then `run_network(["fetch","--no-tags",remote,base_sha])`. If that also fails, return `CommandFailed("PR base <sha> not available")`.
    - Return `rev-parse refs/riff/pr/N/head`.
  - `pr_hunks`: `git -c core.quotePath=false diff --no-color --no-ext-diff -M -U3 --src-prefix=a/ --dst-prefix=b/ <base>...<head>`, then `parse_hunks`.
  - `pr_changed_files`:
    - Compute `mb_old = merge-base base old_head` and `mb_new = merge-base base new_head`.
    - For each path in the union of `diff --name-only mb_old old_head` and `diff --name-only mb_new new_head`, compare the `normalize_patch` result of the two per-file patches. Return the paths that differ, sorted.
  - `mark_pr_seen`: `update-ref refs/riff/pr/N/seen <sha>` under `write_lock`. The ref keeps the seen head alive after a force-push.
- [ ] **Step 4: Run** `cargo test`. Expected: all pass.
- [ ] **Step 5: Register the commands in `lib.rs`** (`generate_handler!`). Add TypeScript wrappers in `src/lib/review/gh.ts`:
  - `gitRemotes(path): Promise<{name:string;url:string}[]>`
  - `fetchPr(path, remote, number, baseRef, baseSha): Promise<string>`
  - `prHunks(path, base, head): Promise<FileHunks[]>`
  - `prChangedFiles(path, base, oldHead, newHead): Promise<string[]>`
  - `markPrSeen(path, number, sha): Promise<void>`

  Each passes camelCase keys to `invoke`, as `git.ts` does.
- [ ] **Step 6: Commit** `feat(review): fetch PR heads into refs/riff and read their hunks`.

---

### Task 3: `gh` wrapper

**Files:**
- Create: `src-tauri/src/github/mod.rs`
- Modify: `src-tauri/src/lib.rs` (`pub mod github;`, commands), `src/lib/review/gh.ts`
- Test: `src-tauri/src/github/mod.rs` (`mod tests`)

**Interfaces:**
- Produces:
  - `enum GhStatus { Ready, NotInstalled, NotLoggedIn }`, serialized as lowercase strings `"ready" | "notinstalled" | "notloggedin"`.
  - `enum GhError { NotInstalled, Api(String), Io(String), Parse(String) }`, serialized as its `Display` string, like `GitError`.
  - `fn gh_args(host: &str, method: &str, endpoint: &str, has_body: bool) -> Vec<String>`, which yields `["api","--hostname",host,"-X",method,endpoint]` plus `["--input","-"]` when there is a body.
  - `fn interpret(ok: bool, stdout: &[u8], stderr: &[u8]) -> Result<serde_json::Value, GhError>`
  - `fn status(host: &str) -> GhStatus`
  - `fn api(host, method, endpoint, body: Option<&Value>) -> Result<Value, GhError>`
  - Tauri commands: `gh_status(host) -> GhStatus` and `gh_api(host, method, endpoint, body: Option<Value>) -> Result<Value, GhError>`. Both are `async`.
- TypeScript (`gh.ts`):
  - `ghStatus(host): Promise<"ready"|"notinstalled"|"notloggedin">`
  - `ghApi(host, method, endpoint, body?): Promise<any>`
  - `ghGraphql<T>(host, query, variables): Promise<T>`, which calls `ghApi(host,"POST","graphql",{query,variables})` and returns `.data`.

- [ ] **Step 1: Write the failing tests.**
  - `gh_args_adds_input_only_with_body`.
  - `interpret_ok_returns_json`.
  - `interpret_graphql_errors_become_api_error`: stdout `{"data":null,"errors":[{"message":"Could not resolve"}]}` with ok=true gives `Api("Could not resolve")`. Several messages are joined with `"; "`.
  - `interpret_failure_prefers_json_message_then_stderr`: stdout `{"message":"Validation Failed","errors":[{"message":"line must be part of the diff"}]}` with ok=false gives `Api("Validation Failed: line must be part of the diff")`. Empty stdout with stderr `"HTTP 401"` gives `Api("HTTP 401")`.
  - `interpret_empty_success_is_null`: a 204-style empty stdout gives `Value::Null`.
- [ ] **Step 2: Run** `cargo test github::`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Add `gh_command()`, a copy of `git_command()` for `"gh"` with `CREATE_NO_WINDOW`, and set `GH_PROMPT_DISABLED=1`.
  - `status`: run `gh auth token --hostname <host>`. Spawn error `NotFound` gives `NotInstalled`, a non-zero exit gives `NotLoggedIn`, and zero gives `Ready`. Discard stdout; never log or return the token.
  - `api`: write the JSON body to stdin when present, then return `interpret`.
- [ ] **Step 4: Run** `cargo test`. Expected: pass.
- [ ] **Step 5: Commit** `feat(review): call GitHub through the gh CLI`.

---

### Task 4: Per-PR persistence

**Files:**
- Create: `src-tauri/src/store/review.rs`
- Modify: `src-tauri/src/store/mod.rs` (`pub mod review;`), `src-tauri/src/lib.rs`, `src/lib/review/gh.ts`

**Interfaces:**
- Produces:
  - `fn key_to_file(key: &str) -> String`: injective. Keep `[A-Za-z0-9._-]`, write every other byte as `~XX` (uppercase hex), and append `.json`.
  - `fn load_in(dir: &Path, key) -> Result<Option<Value>, StoreError>`
  - `fn save_in(dir: &Path, key, value: &Value) -> Result<(), StoreError>`: write `*.tmp`, then rename.
  - `fn delete_in(dir, key) -> Result<(), StoreError>`
  - `fn list_in(dir) -> Result<Vec<String>, StoreError>`: decodes file names back to keys.
  - Commands: `load_review(key)`, `save_review(key, value)`, `delete_review(key)`, `list_reviews()`. Their dir is `<app_config_dir>/review/`.
- TypeScript (`gh.ts`): `loadReview(key): Promise<unknown|null>`, `saveReview(key, value): Promise<void>`, `deleteReview(key): Promise<void>`, `listReviews(): Promise<string[]>`.

- [ ] **Step 1: Write the failing tests.**
  - `key_to_file_is_injective`: `"h/o/r#1"` and `"h_o_r#1"` give different files, and both round-trip through `list_in`.
  - `save_then_load_round_trips`.
  - `load_missing_is_none`.
  - `save_overwrites_atomically`: after two saves, no `.tmp` file is left.
  - `delete_missing_is_ok`.

  Use a temp dir under `std::env::temp_dir()`.
- [ ] **Step 2: Run** `cargo test store::review`. Expected: FAIL.
- [ ] **Step 3: Implement** as specified.
- [ ] **Step 4: Run** `cargo test`. Expected: pass.
- [ ] **Step 5: Commit** `feat(review): persist per-PR review records`.

---

### Task 5: Pure review logic (remote, commentable lines, re-anchoring)

**Files:**
- Create: `src/lib/review/types.ts` (content as in File Structure), `src/lib/review/remote.ts`, `src/lib/review/commentable.ts`, `src/lib/review/anchor.ts`
- Test: `src/lib/review/remote.test.ts`, `commentable.test.ts`, `anchor.test.ts`

**Interfaces:**
- Produces:
  - `parseRemote(url: string): GhRepo | null`
  - `isCommentable(fh: FileHunks | undefined, side: Side, line: number, startLine?: number | null): boolean`
  - `placeTarget(path: string, side: Side, line: number, startLine: number | null, files: FileHunks[]): "line" | "file" | "body"`
  - `reanchor(t: Extract<DraftTarget,{kind:"line"}>, sideText: string, fh: FileHunks | undefined): { line: number; startLine: number | null } | null`

- [ ] **Step 1: Write the failing tests.**
  - `parseRemote`:
    - `git@github.krafton.com:sbx/sandbox.git` gives `{host:"github.krafton.com",owner:"sbx",name:"sandbox"}`;
    - `ssh://git@github.com:22/a/b.git` gives `{host:"github.com",owner:"a",name:"b"}`;
    - `https://github.com/a/b` and `https://user@github.com/a/b.git/` give `{github.com,a,b}`;
    - `C:/repos/x`, `file:///x` and `https://host/only-one-segment` give `null`.
  - `isCommentable` with hunks `[{oldStart:3,oldLines:7,newStart:3,newLines:8}]`:
    - RIGHT 3 and RIGHT 10 are true; RIGHT 11 and RIGHT 2 are false;
    - LEFT 9 is true, LEFT 10 is false;
    - a range `startLine 2, line 5` is false (start outside);
    - a range spanning two hunks is false;
    - an undefined `fh` is false.
  - `placeTarget`: a commentable line gives `"line"`; a non-commentable line in a PR file gives `"file"`; a path not in `files` gives `"body"`.
  - `reanchor`:
    - `reanchor_moves_with_inserted_lines`: the quote `["  foo();"]` was at line 5 and the new text has two lines inserted above, so the result is `{line:7,startLine:null}`.
    - `reanchor_prefers_nearest_duplicate`: the quote appears at lines 3 and 40 and the old line was 38, so the result is 40.
    - `reanchor_multi_line_quote`: a two-line quote gives `startLine` and `line` both shifted.
    - `reanchor_ignores_trailing_whitespace`.
    - `reanchor_missing_quote_is_null`.
    - `reanchor_not_commentable_is_null`: the quote is found but outside the hunks.
- [ ] **Step 2: Run** `npx vitest run src/lib/review`. Expected: FAIL (modules not found).
- [ ] **Step 3: Implement.**
  - Hunk membership is `start <= n < start + count` on the chosen side, using `newStart/newLines` for RIGHT and `oldStart/oldLines` for LEFT.
  - A range must lie inside one hunk.
  - `reanchor` compares lines with `trimEnd()`. Among all matches, pick the one with the smallest `|candidateStart - (t.startLine ?? t.line)|`.
- [ ] **Step 4: Run** `npx vitest run src/lib/review`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(review): parse remotes, commentable lines and re-anchoring`.

---

### Task 6: GitHub queries and mappers

**Files:**
- Create: `src/lib/review/github.ts`
- Test: `src/lib/review/github.test.ts` (mock `./gh`)

**Interfaces:**
- Consumes: `ghGraphql` (Task 3); types (Task 5).
- Produces:
  - `viewerLogin(host): Promise<string>`, cached per host for the session.
  - `searchPrs(host, repos: {repo: GhRepo; repoIdx: number; remote: string}[], login: string): Promise<PrSummary[]>`. It runs two searches (each result carries the matching entry's `repoIdx` and `remote`):
    - `is:pr is:open review-requested:@me archived:false repo:o/r …` with `section:"requested"`;
    - `is:pr is:open reviewed-by:@me archived:false repo:o/r …` with `section:"reviewed"`.

    Both use `first: 50`. A PR that is in both sections is kept only as `requested`. `repoIdx` is the first open repo matching `nameWithOwner` (case-insensitive). `myLastReviewSha` comes from `reviews(last:1, author:$login){nodes{commit{oid}}}`.
  - `prDetail(host, nodeId): Promise<PrDetail>`. It fetches `body`, `headRefOid`, `baseRefOid`, `comments(first:100)`, and `reviewThreads(first:100)`. Each thread brings `id isResolved isOutdated path line startLine originalLine diffSide startDiffSide subjectType comments(first:100){nodes{id author{login} body createdAt}}`. The detail also includes `reviews(states:[PENDING], first:1){nodes{id}}`. A `null` author maps to `"ghost"`.
  - Mutations, each returning what it names:
    - `createPendingReview(host, prNodeId, commitOid): Promise<string>` (`addPullRequestReview` without `event`; returns the review id);
    - `addThread(host, reviewId, t: {path; body; side?; line?; startLine?; startSide?; subjectType: "LINE"|"FILE"}): Promise<void>` (`addPullRequestReviewThread`);
    - `addReply(host, reviewId, threadId, body): Promise<void>` (`addPullRequestReviewThreadReply`);
    - `submitReview(host, reviewId, event: ReviewEvent, body): Promise<void>` (`submitPullRequestReview`);
    - `deletePendingReview(host, reviewId): Promise<void>` (`deletePullRequestReview`);
    - `setThreadResolved(host, threadId, resolved: boolean): Promise<void>` (`resolveReviewThread` / `unresolveReviewThread`).

- [ ] **Step 1: Write the failing tests** with captured JSON fixtures inline:
  - `searchPrs maps fields and dedupes reviewed against requested`.
  - `searchPrs builds one repo: qualifier per open repo` (inspect the `q` variable passed to `ghGraphql`).
  - `prDetail maps threads, ghost authors and pending review id`.
  - `addThread sends FILE subject without line fields`.
  - `addThread sends startLine/startSide only for ranges`.
- [ ] **Step 2: Run** `npx vitest run src/lib/review/github.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Queries are template strings in `github.ts`, and GraphQL variables carry every user value (never string-interpolate a body into a query).
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(review): GitHub GraphQL queries and review mutations`.

---

### Task 7: Draft model and cross-window store

**Files:**
- Create: `src/lib/review/draft.ts`, `src/lib/review/draftStore.ts`
- Test: `src/lib/review/draft.test.ts`, `src/lib/review/draftStore.test.ts` (mock `./gh` and `@tauri-apps/api/event`)

**Interfaces:**
- Produces (`draft.ts`, pure):
  - `emptyRecord(key: PrKey): PrRecord`, with `event:"COMMENT"`, `anchorHead:null` and `viewedHead:null`.
  - `addItem(r, target: DraftTarget, body: string, origin: DraftOrigin): PrRecord`. The new item's id comes from `crypto.randomUUID()`.
  - `editItem(r, id, body): PrRecord`. Editing an `"ai"` item turns its origin into `"ai-edited"`.
  - `removeItem(r, id): PrRecord`
  - `setBody(r, body)` and `setEvent(r, event)`
  - `reanchorAll(r, newHead: string, texts: Map<string /*path|side*/, string>, files: FileHunks[]): PrRecord`. It applies `reanchor` to every `line` item. An item that can't be placed gets `unplaced:true` and keeps its old position. It sets `anchorHead = newHead`.
  - `submittable(r): DraftItem[]`: items with `!unplaced`.
  - `parseRecord(v: unknown, key): PrRecord`. It returns `emptyRecord` for `null` or a `version` other than `1`.
- Produces (`draftStore.ts`):
  - `loadRecord(key): Promise<PrRecord>`
  - `saveRecord(r: PrRecord): Promise<void>`. It persists through `saveReview`, then emits `review-draft-changed` with `{ key, origin: <this window's label> }`.
  - `onRecordChanged(key, cb: (r: PrRecord) => void): Promise<() => void>`. It listens for the event, skips events from its own window, reloads, and calls `cb`.
  - `REVEAL_EVENT = "review-reveal"`, with payload `{ key: PrKey; itemId: string }`.

- [ ] **Step 1: Write the failing tests.**
  - `editing an ai item marks it ai-edited`.
  - `reanchorAll flags unplaced items and keeps them`.
  - `reanchorAll leaves reply items untouched`.
  - `submittable excludes unplaced`.
  - `parseRecord rejects unknown versions`.
  - `saveRecord emits review-draft-changed with own label`.
  - `onRecordChanged ignores own-window events`.
- [ ] **Step 2: Run** `npx vitest run src/lib/review/draft`. Expected: FAIL.
- [ ] **Step 3: Implement.** Get the window label from `getCurrentWebviewWindow().label`.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(review): draft model shared across windows`.

---

### Task 8: Submit orchestration

**Files:**
- Create: `src/lib/review/submit.ts`
- Test: `src/lib/review/submit.test.ts` (mock `./github`)

**Interfaces:**
- Consumes: Task 6 mutations; Task 7 `submittable`.
- Produces:
  - `type PendingChoice = "add" | "discard"`
  - `type SubmitBlock = "not-seen" | "empty" | null`
  - `submitBlock(r: PrRecord, headSha: string): SubmitBlock`. It returns `"not-seen"` when `r.viewedHead !== headSha`. It returns `"empty"` when there are no submittable items, the body is blank, and the event is `COMMENT`. Otherwise `null`.
  - `buildBody(r: PrRecord): string`. It joins the review body with every submittable `body` item, each as `\n\n---\n**{location}**\n\n{body}`.
  - `submit(args: { host: string; prNodeId: string; headSha: string; record: PrRecord; existingPendingId: string | null; choice: PendingChoice | null }): Promise<PrRecord>`. It returns the record after a successful submit: submitted items removed, unplaced items kept, body reset to `""`, event reset to `"COMMENT"`.

    It throws `Error("pending-review-exists")` when `existingPendingId` is set and `choice` is null.
- Flow:
  1. If `submitBlock` is not null, throw.
  2. Handle an existing pending review: on `"discard"`, delete it; on `"add"`, reuse its id.
  3. Otherwise call `createPendingReview(host, prNodeId, headSha)`.
  4. Call `addThread` for `line` and `file` items, then `addReply` for `reply` items.
  5. Call `submitReview` with `event` and `buildBody`.
  6. On any error after step 3 created a review, call `deletePendingReview(createdId)` (best effort), then rethrow. The record must be returned unchanged by the caller.

- [ ] **Step 1: Write the failing tests.**
  - `blocks when latest head not seen`.
  - `blocks empty COMMENT`.
  - `submits threads, replies and body in order pinned to headSha`: assert the call order, and that `createPendingReview` received `headSha`.
  - `file items go as FILE threads`.
  - `body items are appended to the review body`.
  - `keeps unplaced items after submit`.
  - `deletes own pending review on failure`: `addThread` rejects on the 2nd call, and `deletePendingReview` is called with the created id.
  - `existing pending review requires a choice`.
  - `existing pending review with add reuses it and never deletes it on failure`.
  - `existing pending review with discard deletes it first`.
- [ ] **Step 2: Run** `npx vitest run src/lib/review/submit.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** as specified.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(review): submit drafts as one review pinned to the latest head`.

---

### Task 9: Review state (list, open, head moves, refresh)

**Files:**
- Create: `src/lib/review/prList.ts`, `src/lib/review/reviewState.svelte.ts`
- Test: `src/lib/review/prList.test.ts` (pure parts; mock `./gh` and `./github`)

**Interfaces:**
- Consumes: Tasks 2–8.
- Produces (`prList.ts`):
  - `type HostState = { host: string; status: "ready"|"notinstalled"|"notloggedin"|"error"; message: string | null }`
  - `collectRepos(repos: {path: string}[], remotesOf: (path) => Promise<{name;url}[]>): Promise<Map<string /*host*/, {repo: GhRepo; repoIdx: number; remote: string}[]>>`. It prefers the remote named `origin`, otherwise the first one that parses. Repos with no GitHub-like remote are skipped.
  - `loadPrList(repos): Promise<{ prs: PrSummary[]; hosts: HostState[] }>`. It handles each host independently, so one failing host still returns the others.
  - `loginHint(host): string`, which is `` `gh auth login --hostname ${host}` ``.
  - `REFRESH_MS = 300_000`
- Produces (`reviewState.svelte.ts`):
  - `class ReviewState`, fields as `$state`:
    - `prs: PrSummary[]`, `hosts: HostState[]`, `loadingList: boolean`;
    - `selectedKey: PrKey | null`, `detail: PrDetail | null`, `files: FileHunks[]`;
    - `record: PrRecord | null`, `selectedPath: string | null`;
    - `headMoved: { from: string; to: string } | null`;
    - `newSinceFiles: string[]`, `error: string | null`.

    Exported singleton `reviewState`.
  - `refreshList(): Promise<void>`, sequence-token guarded.
  - `openPr(key): Promise<void>`. Steps:
    1. `fetchPr`.
    2. `prDetail`.
    3. `prHunks(baseSha, headSha)`.
    4. `loadRecord`.
    5. If `record.viewedHead` is null, set it to `headSha`, call `markPrSeen`, and save.
    6. If `record.anchorHead` is set and differs from `headSha`:
       - set `headMoved`;
       - `newSinceFiles = prChangedFiles(baseSha, viewedHead, headSha)`;
       - `reanchorAll`, reading the texts per (path, side) through the existing `readFileAt(path, rev, file)` from `git.ts`; RIGHT uses `headSha` and LEFT uses `baseSha`;
       - save.
    7. If `anchorHead` is null, set it to `headSha`.
  - `markNewSinceSeen(): Promise<void>`: set `viewedHead = headSha`, call `markPrSeen`, save, and clear `headMoved`.
  - `startAutoRefresh(): () => void`. It sets an interval of `REFRESH_MS` and returns a stop function.
  - `cleanupRecords(): Promise<void>`. After a list refresh, it deletes stored records whose key is in neither section **and** that have no items.
- **Badges** (computed in `PrList.svelte` from `listReviews()` plus the records): `"draft N"`. In the reviewed section, also `"new commits"` when `myLastReviewSha !== headSha`.

- [ ] **Step 1: Write the failing tests.**
  - `collectRepos groups by host and prefers origin`.
  - `collectRepos skips non-GitHub remotes`.
  - `loadPrList keeps other hosts when one host is logged out` (`ghStatus` returns `"notloggedin"` for one host, and that host's `message` contains `loginHint`).
  - `loginHint text`.
- [ ] **Step 2: Run** `npx vitest run src/lib/review/prList.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both files. In `openPr`, a newer `openPr` call supersedes an older one (sequence token).
- [ ] **Step 4: Run** `npx vitest run`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(review): review-mode state, PR list and head-move handling`.

---

### Task 10: Mode wiring and PR list UI

**Files:**
- Modify: `src/lib/types.ts:117` (`AppMode` adds `"review"`), `src/lib/ui/InputBar.svelte:88-115`, `src/routes/+page.svelte` (layout branch near `:608`), `src/lib/compare.ts:264` (`cycleAppMode`), `src/lib/commands.ts:28-52`, `src/lib/history.ts:153-193` (only if it enumerates modes)
- Create: `src/lib/ui/review/ReviewView.svelte`, `src/lib/ui/review/PrList.svelte`
- Test: `src/lib/compare.test.ts` (or wherever `cycleAppMode` is tested)

**Interfaces:**
- Consumes: `reviewState`, `refreshList`, `startAutoRefresh`, `openPr`, `loginHint`.
- Produces: `enterReviewMode(): void` in `compare.ts`.

- [ ] **Step 1: Write the failing test.** `cycleAppMode goes blame → review → changes` (*my call: the review mode joins the Ctrl+Shift+W cycle after Blame*).
- [ ] **Step 2: Run** `npx vitest run src/lib/compare.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the mode wiring.**
  - Add a "PR Review" button after Blame in `.mode-toggle`.
  - Add the `{:else if appState.appMode === "review"} <ReviewView />` branch.
  - Add the command palette entry `go.review` ("Go to PR Review").
  - Add the cycle step.
  - Every mode-gated watcher that lists modes with `===` checks keeps working unchanged. Verify `RefsSidebar.svelte:26,441`, `branchContainment.ts:405,481`, `DiffView.svelte:109,198` and `workspace.ts:284` do not misbehave for `"review"`.
- [ ] **Step 4: Build the components.**
  - `ReviewView`: on mount, call `refreshList()` and `startAutoRefresh()`; stop the refresh on destroy. The left column holds `PrList`, and the main area shows the placeholder "Select a PR".
  - `PrList`:
    - two sections with counts, plus a refresh button with "updated N min ago";
    - each row shows `#N title`, `author · repo · +a −d`, and the badges;
    - per-host error rows show `status` and `loginHint(host)` as copyable text.
- [ ] **Step 5: Run** `npm run check` and `npx vitest run`. Expected: 0 errors; tests pass.
- [ ] **Step 6: Manual check.** Run `npm run tauri dev` with `C:\workspace\sandbox` open and switch to PR Review. Expect:
  - PRs requesting your review on github.krafton.com are listed;
  - a submodule repo's PRs appear under that repo;
  - logging gh out for a host (`gh auth logout --hostname <host>` on a test host only) shows the hint.
- [ ] **Step 7: Commit** `feat(review): PR Review mode with the review-request list`.

---

### Task 11: Diff, threads and composing comments

**Files:**
- Modify: `src/lib/ui/DiffView.svelte`
- Create: `src/lib/ui/review/cmReview.ts`, `ReviewFiles.svelte`, `PrOverview.svelte`, `InlineThread.svelte`, `InlineDraft.svelte`, `Composer.svelte`
- Test: `src/lib/ui/review/cmReview.test.ts` (pure helper only)

**Interfaces:**
- Consumes: `reviewState` (Task 9), `isCommentable` (Task 5), draft reducers and store (Task 7), `setThreadResolved` (Task 6).
- Produces:
  - New optional `DiffView` props:
    - `source?: { repoPath: string; start: string; target: string; file: ChangedFile; mode?: DiffMode }`. When set, the file is loaded with `fileDiff(repoPath, start, target, source.mode ?? "three-dot", …)` instead of from `appState.selectedFile` and the ranges. Every internal read of `appState.selectedFile` goes through `const file = $derived(source?.file ?? appState.selectedFile)`.
    - `sideExtensions?: (side: "a" | "b") => Extension[]`
    - `forceSideBySide?: boolean`. In review mode it is always side-by-side (*my call: LEFT-side lines need their own editor to anchor widgets*).
  - `cmReview.ts`:
    - `type InlineItem = { line: number; key: string; mount: (el: HTMLElement) => () => void }`
    - `reviewExtension(opts: { side: Side; commentable: (line: number) => boolean; onLineClick: (line: number, shift: boolean) => void }): Extension`, together with `setInlineItems: StateEffectType<InlineItem[]>`
    - pure `groupByLine(items: InlineItem[]): Map<number, InlineItem[]>`
  - Widgets are block widgets placed after their line. `mount` returns an unmount function; Svelte components mount through `mount()`/`unmount()` from `svelte`.

- [ ] **Step 1: Write the failing test.** `groupByLine keeps insertion order per line`.
- [ ] **Step 2: Run** the test. Expected: FAIL.
- [ ] **Step 3: Implement `cmReview.ts`.**
  - A gutter shows "+" only where `commentable(line)` is true. Clicking it calls `onLineClick`.
  - A `StateField<DecorationSet>` rebuilds its decorations from `setInlineItems`.
- [ ] **Step 4: Change `DiffView`** to take the props. Existing modes behave identically. Verify with `npm run check` and a manual pass over Changes, Branch and Graph.
- [ ] **Step 5: Build the components.**
  - `ReviewFiles`: the left-column list under the selected PR.
    - It shows a single default chapter, "All files", in path order. Plan 2 replaces this with AI chapters.
    - Then come the files, with per-file thread and draft counts.
    - Then a collapsed "Outdated threads (N)" holding the threads with `isOutdated` or `line == null`.
    - Selecting a file sets `reviewState.selectedPath` (*my call: one file at a time with j/k for next/prev file, reusing DiffView, rather than stacking editors*).
  - `PrOverview`: the PR body (markdown as preformatted text) and the conversation comments. It sits above the diff and is collapsible.
  - Main area: `DiffView` with `source = {repoPath, start: baseSha, target: headSha, file}` and `sideExtensions` wiring `reviewExtension`:
    - side `"a"` is LEFT and side `"b"` is RIGHT;
    - `commentable` is `isCommentable(files[path], side, n)`;
    - the inline items are this file's threads (`InlineThread`), draft items (`InlineDraft`), and an open `Composer`.
  - Composer behaviour:
    - Click "+" on a line to open it; shift-click a second line on the same side to make a range (rejected with an inline note unless `isCommentable(…, startLine)`).
    - "Add to draft" calls `addItem` with `{kind:"line", …, quote: lines startLine..line from the editor doc}` and `origin:"mine"`, then `saveRecord`.
  - `InlineThread`: shows the comments; "Reply" opens a Composer whose `addItem` uses `{kind:"reply", threadId, preview: last comment's first 80 chars}`. Resolve/Unresolve calls `setThreadResolved` and reloads `detail`.
  - `InlineDraft`: shows the draft body with edit and delete.
- [ ] **Step 6: Run** `npm run check` and `npx vitest run`. Expected: pass.
- [ ] **Step 7: Manual check** on a real sandbox PR:
  - "+" appears only on hunk lines;
  - existing threads show at their lines;
  - outdated threads are in the collapsed area;
  - a reply and a line comment show as drafts and survive an app restart.
- [ ] **Step 8: Commit** `feat(review): PR diff with threads, replies and line comments`.

---

### Task 12: Drafts window, bottom bar, "New since you looked", submit

**Files:**
- Create: `src/lib/ui/review/ReviewBar.svelte`, `DraftsWindow.svelte`, `NewSinceView.svelte`, `PendingReviewDialog.svelte`
- Modify: `src/routes/+page.svelte` (root switch), `src-tauri/capabilities/default.json`
- Test: `src/lib/review/draftsWindow.test.ts` (URL helper)

**Interfaces:**
- Consumes: Tasks 6–9.
- Produces:
  - `draftsWindowUrl(key: PrKey): string` gives `/?view=drafts&key=<encodeURIComponent(key)>`, and `parseDraftsUrl(search: string): PrKey | null` reverses it. Both live in `src/lib/review/draftStore.ts`.
  - `openDraftsWindow(key): Promise<void>`. If a window labelled `review-drafts` exists, it navigates it to the key and focuses it. Otherwise it creates `new WebviewWindow("review-drafts", { url, title: "riff · Review draft", width: 640, height: 760, decorations: true })` (*my call: native decorations for the secondary window*).

- [ ] **Step 1: Write the failing test.** `drafts URL round-trips keys with # and /`.
- [ ] **Step 2: Run** the test. Expected: FAIL.
- [ ] **Step 3: Implement the URL helpers and window opener.** Add `"review-drafts"` to `capabilities/default.json` `windows`, and add the permissions `core:webview:allow-create-webview-window` and `core:window:allow-set-focus`.
- [ ] **Step 4: Root switch in `+page.svelte`.** When `parseDraftsUrl(location.search)` returns a key, render only `<DraftsWindow key={…} />` and skip the main window's repo loading, watchers and updater checks.
- [ ] **Step 5: Build `DraftsWindow`.** It loads the record and subscribes with `onRecordChanged`. Each item shows:
  - its location: `path:line`, `path:start-line`, `path (file)`, "review body", or "reply to …";
  - an origin tag: mine / AI draft / AI draft, edited / Unconfirmed (grey) / reply;
  - a red "could not place: fix or drop" tag when `unplaced`;
  - a one-line code quote (`quote[0]`) or the reply preview;
  - an editable body;
  - actions: show in main (emits `REVEAL_EVENT`), delete.

  The bottom has the review body, a Comment/Approve/Request changes radio, and "Submit to GitHub". Submit runs the same flow as `ReviewBar`: emit a `review-submit-request` event that the main window handles, so a single place owns submit (*my call*).
- [ ] **Step 6: Build `ReviewBar`** for the main window bottom.
  - It shows "My draft: N comments" (clicking it calls `openDraftsWindow`), the event selector, and Submit.
  - When `submitBlock` is `"not-seen"`, Submit is disabled and a banner says "New commits since you looked: review them first" with a button that opens `NewSinceView`.
  - The main window listens for `REVEAL_EVENT` (select the file, scroll to the item's line) and for `review-submit-request`.
- [ ] **Step 7: Build `NewSinceView`.** It lists `newSinceFiles`. Selecting one shows `DiffView` with `source = {start: record.viewedHead, target: headSha, mode: "two-dot", …}`. If the author rebased, upstream edits to the same file show here too; that is accepted. Closing the view calls `markNewSinceSeen()`.
- [ ] **Step 8: Submit handling** in the main window.
  - If `detail.pendingReviewId` is set, show `PendingReviewDialog`: "You have a pending review on GitHub for this PR (started elsewhere). Add these comments to it, or discard it?" with buttons Add / Discard / Cancel.
  - Call `submit()`. On success: `saveRecord(result)`, reload `detail`, and show a toast "Review submitted". On error: a toast with the message, leaving the record untouched.
- [ ] **Step 9: Run** `npm run check` and `npx vitest run`. Expected: pass.
- [ ] **Step 10: Manual end-to-end** on a throwaway PR on github.krafton.com (create one in a personal test repo; do **not** use a teammate's PR):
  1. Add a line comment, a range comment and a reply, then open the drafts window: all three are listed and edits in either window show up in the other.
  2. "Show in main" scrolls the main diff to the line.
  3. Push a commit that shifts lines to the PR branch, then reopen the PR. Expect:
     - the banner appears and Submit is blocked;
     - drafts moved to their new lines;
     - a comment on a deleted line is flagged unplaced.
  4. Open "New since you looked": the banner clears.
  5. Submit as Comment. On GitHub, the review is pinned to the latest head, has the threads and the reply, and the unplaced item is still in riff's draft.
  6. Start a pending review on the web, then submit from riff: the dialog appears, and both choices behave as described.
- [ ] **Step 11: Commit** `feat(review): drafts window, new-since gate and review submit`.
