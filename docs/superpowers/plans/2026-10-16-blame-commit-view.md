# Blame Commit View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A commit opened from Blame mode shows its message once and its SHA once, opens the blamed file at the blamed line, and Blame can step back to the version of the file before any commit.

**Architecture:** Two new pieces of state drive everything:

- `appState.commitView` is set by the Blame drill-in. The ordinary Branch screen renders differently while `commitViewActive()` holds, meaning the drilled repo's range is still exactly that commit.
- `appState.blameRev` makes Blame load a parent revision.

Both ride the existing drill-in history stack (`CompareCtx`), so Back, Esc and Forward work unchanged. The backend learns two things:

- Blame keeps the porcelain fields it used to throw away (`filename`, `previous`, orig line).
- A new command reads a file at a revision.

**Tech Stack:** Tauri 2 (Rust, git CLI), SvelteKit + Svelte 5 runes, TypeScript, CodeMirror 6 (`@codemirror/merge`), Vitest, cargo test.

**Spec:** `docs/superpowers/specs/2026-10-14-blame-commit-view-design.md`

## Global Constraints

- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never add a second Co-Authored-By line.
- Commit bodies must not contain destructive-looking git literals (a reset with the hard flag, a forced push, a clean with -fdx). Paraphrase them.
- Never commit anything from `C:\workspace\sandbox` (proprietary).
- Match surrounding code: `///` doc comments in TS lib files, `//` in Svelte, comment density as in the file being edited. No new dependencies.
- Short SHAs on screen are the first **8** characters, the form Blame's gutter uses.
- UI strings are verbatim from the spec: `Commit`, `from blame of`, `before` / `after`, `Show full message ▾` / `Show less ▴`, `first commit`, `merge · N parents · diff against the first parent`, `parent <sha>`, `N files`, `↶ Blame before this`, `this commit added the file`, `Blame at <sha> — before <sha> <subject>`, `as <path>`, `Back to HEAD`, `Commits · at <sha>`, `couldn't open commit <sha>: <error>`.
- Test commands (from `C:\riff\riff`):
  - `npm test` (Vitest)
  - `npm run check` (svelte-check)
  - `cargo test --manifest-path src-tauri/Cargo.toml`

## Rulings against the spec (made while planning)

- **`EMPTY_TREE` lives in a new `src/lib/emptyTree.ts`, not in `git.ts`.**
  - Why: many tests mock `./git` wholesale (`vi.mock("./git", () => ({...}))`), so a constant exported from `git.ts` would be `undefined` in modules under test.
  - Cost if wrong: one import path.
- **`blameBefore` lives in `src/lib/blameRev.ts` next to `mapLineBack`, not in `history.ts`.**
  - Why: it keeps CodeMirror out of `history.ts` and its tests. It uses `snapshot()` from `history.ts`; `history.ts` does not import `blameRev.ts`, so there is no cycle.
- **`BlameRev` gains `target: RepoFile`, the HEAD file it belongs to.**
  - Why: `blameTarget` is set from five places (`commands.ts`, `compare.ts`, `InputBar.svelte`, `workspace.ts`, `BlameView.svelte`). Blame only treats `blameRev` as active while `blameRev.target` matches `blameTarget`, so a stale revision can never load for another file. It is also cleared where the spec says: on picking a file, on the drill, and on repo switch.
- **The commit view's pane labels are literal `before` / `after` in `DiffView`, gated by `commitViewActive()`; `paneLabels` is unchanged.**
  - Why: there is nothing to compute.
  - Consequence: the spec's `rangeText.test.ts` line becomes a `commitViewActive` test in `history.test.ts`.
- **The commit card has no collapse toggle. While the commit view is active, `commitTableCollapsed` is ignored.**
  - Why: the toggle lives in `CommitTable`'s header, so a collapsed table would otherwise hide the card with no way back.
- **`read_file_at` validates with `validate_ref` / `validate_path`, which reject empty and `-`-leading values; they do not reject `..`.**
  - Git itself refuses a tree path outside the repo. The Rust test covers a `-` path and a path missing at the revision.

## Review Focus

1. **A submodule file's commit.** The drill reads the commit in the submodule's repo path, sets that repo's override, and the commit view checks the override, not the toolbar pair. Test: Task 2's submodule drill test.
2. **A file renamed after the blamed commit.** The drill selects `filename` (the path at that commit), not the HEAD path, and `↶` blames `previous.path`. Tests: Task 1's parser test (a path with spaces) and Task 3's `blameBefore` test asserting the paths read.
3. **A root commit.** `<sha>^` does not exist. The range must use the empty tree, and `↶` must be disabled. Test: Task 2's root-commit drill test. `previous: None` comes from Task 1's parser test.
4. **Back after a drill from an older blame.** Esc must return to the older blame on the same file and line, not to HEAD. Test: Task 2's "Back restores Blame" test with a `blameRev` set before the drill.
5. **A stale `blameRev` meeting another file.** After `↶` on A, picking B, or switching repos, must blame B at HEAD. Test: Task 3's `blameRevFor` test (the active check).

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src-tauri/src/git/blame.rs` | Parse `filename`, `previous`, orig line from porcelain |
| `src-tauri/src/git/mod.rs`, `cli.rs`, `lib.rs` | `read_file_at` trait method, implementation, command |
| `src/lib/emptyTree.ts` (new) | The one `EMPTY_TREE` constant |
| `src/lib/types.ts` | `BlamePrevious`, extended `BlameCommit` / `Blame`, `CommitView`, `BlameRev`, `RevealLine`, extended `CompareCtx` |
| `src/lib/git.ts` | `readFileAt` binding |
| `src/lib/store.svelte.ts` | `commitView`, `blameRev`, `revealLine` |
| `src/lib/compare.ts` | `preserveRepoIdx` option |
| `src/lib/history.ts` | async `pushAndDrillToCommit`, `commitViewActive`, `backToHead`, snapshot/apply of new ctx fields |
| `src/lib/blameRev.ts` (new) | `mapLineBack`, `blameRevFor`, `blameBefore` |
| `src/lib/ui/relativeDate.ts` (new) | `relativeDate` shared by BlameView and CommitCard |
| `src/lib/ui/toast.ts` (new) | `showToast` shared by BlameView and the commit view's SHA button |
| `src/lib/ui/CommitCard.svelte` (new) | The commit card |
| `src/lib/ui/CommitViewFields.svelte` (new) | The toolbar's second row in the commit view |
| `src/lib/ui/InputBar.svelte`, `Breadcrumb.svelte`, `FilesScope.svelte`, `DiffView.svelte`, `src/routes/+page.svelte` | Commit-view rendering |
| `src/lib/blameCache.ts` | Cache key gains the revision |
| `src/lib/ui/BlameView.svelte` | `from` on drill, `↶`, loading at a revision, revision bar, focus line |
| `src/lib/workspace.ts` | Clear `blameRev` / `commitView` on repo switch |
| `README.md` | Sections 4 and 5 |

---

### Task 1: Backend — blame fields and `read_file_at`

**Files:**
- Modify: `src-tauri/src/git/blame.rs` (structs at lines 7-24, parser lines 55-143, tests from line 159)
- Modify: `src-tauri/src/git/mod.rs:11` (re-export), `:579` (trait)
- Modify: `src-tauri/src/git/cli.rs:2080` (impl, next to `has_commit`), tests near `:3617`
- Modify: `src-tauri/src/lib.rs:409` (command next to `has_commit`), `:613` (register)
- Create: `src/lib/emptyTree.ts`
- Modify: `src/lib/repoRange.ts:7`, `src/lib/branchContainment.ts:19`, `src/lib/commitHistory.ts:13` (import instead of private copies)
- Modify: `src/lib/types.ts:352-363`, `src/lib/git.ts` (after `readRepoFile`, line ~461)

**Interfaces:**
- Produces (Rust):
  - `BlamePrevious { sha: String /*full*/, path: String }`
  - `BlameCommit { sha, author, author_time, summary, filename: String, previous: Option<BlamePrevious> }`
  - `Blame { commits, line_commit, line_orig: Vec<usize> }`
  - `GitLayer::read_file_at(&self, path: &Path, rev: &str, file_path: &str) -> Result<String, GitError>`
  - Tauri command `read_file_at { path, rev, filePath }`
- Produces (TS):
  - `interface BlamePrevious { sha: string; path: string }`
  - `BlameCommit.filename: string`
  - `BlameCommit.previous: BlamePrevious | null`
  - `Blame.line_orig: number[]`
  - `readFileAt(path: string, rev: string, filePath: string): Promise<string>`
  - `EMPTY_TREE` from `src/lib/emptyTree.ts`

- [ ] **Step 1: Write the failing parser tests**

In `src-tauri/src/git/blame.rs`, replace the test `parse_ignores_previous_filename_committer_fields` with the following, and add two more tests after it:

```rust
    #[test]
    fn parse_keeps_previous_and_filename() {
        let input = b"abcdef0123456789abcdef0123456789abcdef01 1 1 1
author Alice
author-mail <a@x>
author-time 100
author-tz +0000
committer Bob
committer-mail <b@x>
committer-time 200
committer-tz +0000
summary moved file
previous deadbeef00000000000000000000000000000000 old dir/old name.rs
filename new.rs
\tcontent
";
        let b = parse_porcelain(input).unwrap();
        assert_eq!(b.commits.len(), 1);
        assert_eq!(b.commits[0].author, "Alice");
        assert_eq!(b.commits[0].summary, "moved file");
        assert_eq!(b.commits[0].filename, "new.rs");
        assert_eq!(
            b.commits[0].previous,
            Some(BlamePrevious {
                sha: "deadbeef00000000000000000000000000000000".into(),
                path: "old dir/old name.rs".into(),
            })
        );
    }

    #[test]
    fn parse_no_previous_means_the_commit_added_the_file() {
        let input = b"abcdef0123456789abcdef0123456789abcdef01 1 1 1
author Alice
author-mail <a@x>
author-time 100
author-tz +0000
committer Alice
committer-mail <a@x>
committer-time 100
committer-tz +0000
summary add f
filename f.rs
\tcontent
";
        let b = parse_porcelain(input).unwrap();
        assert_eq!(b.commits[0].previous, None);
        assert_eq!(b.commits[0].filename, "f.rs");
    }

    #[test]
    fn parse_keeps_each_lines_number_in_its_commit() {
        // Line 1 came from A's line 5, line 2 from B's line 1, line 3 from A's
        // line 6. A's metadata (and filename) stays from its first group.
        let input = b"aaaa111122223333444455556666777788889999 5 1 1
author Alice
author-mail <a@x>
author-time 100
author-tz +0000
committer Alice
committer-mail <a@x>
committer-time 100
committer-tz +0000
summary A
filename a.rs
\tline 1
bbbb222233334444555566667777888899990000 1 2 1
author Bob
author-mail <b@x>
author-time 200
author-tz +0000
committer Bob
committer-mail <b@x>
committer-time 200
committer-tz +0000
summary B
previous cccc222233334444555566667777888899990000 f.rs
filename f.rs
\tline 2
aaaa111122223333444455556666777788889999 6 3 1
filename a.rs
\tline 3
";
        let b = parse_porcelain(input).unwrap();
        assert_eq!(b.line_commit, vec![0, 1, 0]);
        assert_eq!(b.line_orig, vec![5, 1, 6]);
        assert_eq!(b.commits[0].filename, "a.rs");
        assert_eq!(b.commits[1].previous.as_ref().unwrap().path, "f.rs");
    }
```

Also add `assert!(b.line_orig.is_empty());` to `parse_empty`, and `assert_eq!(b.line_orig, vec![1]);` to `parse_single_line`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml blame::`
Expected: compile errors (`no field filename`, `BlamePrevious` not found, `no field line_orig`).

- [ ] **Step 3: Implement the parser changes**

In `blame.rs`, replace the `BlameCommit` and `Blame` structs and their doc comments (lines 7-24) with:

```rust
/// One commit referenced by the blame result. `sha` is the 8-char short form
/// the frontend displays; the drill-in reads the commit (`commit_log`) for its
/// full SHA and parents.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BlameCommit {
    pub sha: String,
    pub author: String,
    pub author_time: i64,
    pub summary: String,
    /// The file's path at this commit (differs from the blamed path when the
    /// file was renamed later).
    pub filename: String,
    /// The parent version of the file this commit changed; `None` when this
    /// commit added the file (including a root commit).
    pub previous: Option<BlamePrevious>,
}

/// Porcelain's `previous <sha> <path>`: the parent commit and the file's path
/// there. Drives "Blame before this".
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BlamePrevious {
    /// Full SHA.
    pub sha: String,
    pub path: String,
}

/// Result of `blame_file`. `commits` is deduplicated; `line_commit[i]` is the
/// index into `commits` for the (1-based) line `i+1` of the blamed file, and
/// `line_orig[i]` is that line's 1-based number in its commit's version of the
/// file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Blame {
    pub commits: Vec<BlameCommit>,
    pub line_commit: Vec<usize>,
    pub line_orig: Vec<usize>,
}
```

In `parse_porcelain`:

1. Add the state next to the existing `cur_*` variables, and the output vector:

```rust
    let mut line_orig: Vec<usize> = Vec::new();
    let mut cur_orig_line: Option<usize> = None;
    let mut cur_filename: Option<String> = None;
    let mut cur_previous: Option<BlamePrevious> = None;
```

2. In the content-line branch:
   - Take the orig line next to `final_line`:

```rust
            let orig_line = cur_orig_line.take().unwrap_or(final_line);
```

   - Build the commit with the two new fields:

```rust
                let commit = BlameCommit {
                    sha: short_sha,
                    author: cur_author.take().unwrap_or_default(),
                    author_time: cur_author_time.take().unwrap_or(0),
                    summary: cur_summary.take().unwrap_or_default(),
                    filename: cur_filename.take().unwrap_or_default(),
                    previous: cur_previous.take(),
                };
```

   - Where `line_commit` is resized and written, do the same for `line_orig`:

```rust
            if line_commit.len() <= arr_idx {
                line_commit.resize(arr_idx + 1, 0);
                line_orig.resize(arr_idx + 1, 0);
            }
            line_commit[arr_idx] = idx;
            line_orig[arr_idx] = orig_line;
```

   - In the reset block at the end of the branch, also reset `cur_filename = None; cur_previous = None;`.

3. In the header branch, replace `let _orig = parts.next();` with:

```rust
            let orig_line: Option<usize> = parts.next().and_then(|s| s.parse().ok());
```

   After `cur_final_line = Some(final_line);`, add `cur_orig_line = orig_line;`. Next to the existing resets, add `cur_filename = None; cur_previous = None;`.

4. Extend the field matching chain after `summary`:

```rust
        } else if let Some(rest) = line.strip_prefix("filename ") {
            cur_filename = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("previous ") {
            if let Some((sha, path)) = rest.split_once(' ') {
                cur_previous = Some(BlamePrevious {
                    sha: sha.to_string(),
                    path: path.to_string(),
                });
            }
        }
```

5. Return `Ok(Blame { commits, line_commit, line_orig })`.

In `src-tauri/src/git/mod.rs:11`, change the re-export to `pub use blame::{Blame, BlameCommit, BlamePrevious};`. If the compiler flags `BlamePrevious` as unused there, keep the original line instead.

- [ ] **Step 4: Run the parser tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml blame::`
Expected: all blame tests PASS.

- [ ] **Step 5: Write the failing `read_file_at` test**

In `src-tauri/src/git/cli.rs` `mod tests`, after `has_commit_tells_a_commit_here_from_one_this_clone_lacks`:

```rust
    #[test]
    fn read_file_at_reads_an_older_revision() {
        let repo = temp_repo("read-file-at");
        let cli = GitCli::new();
        commit_file(&repo, "notes.md", "one\n", "add notes");
        let first = rev_parse(&repo, "HEAD");
        commit_file(&repo, "notes.md", "two\n", "edit notes");

        assert_eq!(cli.read_file_at(&repo, &first, "notes.md").unwrap(), "one\n");
        assert_eq!(cli.read_file_at(&repo, "HEAD", "notes.md").unwrap(), "two\n");
        // The file did not exist at the seed commit.
        assert!(cli.read_file_at(&repo, "HEAD~2", "notes.md").is_err());
        // Malformed arguments never reach git.
        assert!(cli.read_file_at(&repo, "-x", "notes.md").is_err());
        assert!(cli.read_file_at(&repo, "HEAD", "-notes.md").is_err());

        let _ = fs::remove_dir_all(&repo);
    }
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml read_file_at`
Expected: compile error: no method `read_file_at`.

- [ ] **Step 7: Implement `read_file_at`**

In `src-tauri/src/git/mod.rs`, after `has_commit` in the trait:

```rust
    /// The content of `file_path` at `rev` (`git cat-file blob <rev>:<path>`),
    /// lossy UTF-8, capped like the working-copy read the blame view uses.
    /// Backs "Blame before this", which blames a parent revision.
    fn read_file_at(&self, path: &Path, rev: &str, file_path: &str) -> Result<String, GitError>;
```

In `cli.rs`, after `fn has_commit` in `impl GitLayer for GitCli`:

```rust
    fn read_file_at(&self, path: &Path, rev: &str, file_path: &str) -> Result<String, GitError> {
        let rev = validate_ref(rev)?;
        validate_path(file_path)?;
        // Same cap as `read_repo_file` (lib.rs): a stray binary or huge log
        // can't lock up the editor.
        const BLAME_READ_CAP: usize = 2_000_000;
        let bytes = self.run(path, &["cat-file", "blob", &format!("{rev}:{file_path}")])?;
        if bytes.len() > BLAME_READ_CAP {
            return Err(GitError::CommandFailed(format!(
                "file too large for blame view ({} bytes)",
                bytes.len()
            )));
        }
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }
```

In `src-tauri/src/lib.rs`, after the `has_commit` command:

```rust
#[tauri::command]
async fn read_file_at(
    state: tauri::State<'_, GitCli>,
    path: String,
    rev: String,
    file_path: String,
) -> Result<String, GitError> {
    state.read_file_at(Path::new(&path), &rev, &file_path)
}
```

Then add `read_file_at,` after `has_commit,` in the `generate_handler!` list (around line 613).

- [ ] **Step 8: Run the Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: all PASS.

- [ ] **Step 9: Frontend types, binding and `EMPTY_TREE`**

Create `src/lib/emptyTree.ts`:

```ts
/// Git's empty tree. A root commit's parent side, so `<root>^` is never asked
/// for. Its own module so tests that mock `./git` wholesale still see it.
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
```

In `src/lib/repoRange.ts`, `src/lib/branchContainment.ts` and `src/lib/commitHistory.ts`, delete the line `const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";` and add `import { EMPTY_TREE } from "./emptyTree";` next to the other imports. Leave any comment above the deleted line in place only if it still reads correctly. Otherwise drop it.

In `src/lib/types.ts`, replace `BlameCommit` and `Blame` (lines 352-363) with:

```ts
/// Porcelain's `previous <sha> <path>`: the parent commit (full SHA) and the
/// file's path there. Mirrors Rust `BlamePrevious`.
export interface BlamePrevious {
  sha: string;
  path: string;
}

export interface BlameCommit {
  sha: string;
  author: string;
  author_time: number;
  summary: string;
  /** The file's path at this commit. */
  filename: string;
  /** The parent version of the file; null when this commit added it. */
  previous: BlamePrevious | null;
}

export interface Blame {
  commits: BlameCommit[];
  /** `line_commit[i]` is the index into `commits` for (1-based) line `i+1`. */
  line_commit: number[];
  /** `line_orig[i]` is line `i+1`'s 1-based number in its commit's version. */
  line_orig: number[];
}
```

In `src/lib/git.ts`, after `readRepoFile`:

```ts
/** `filePath`'s content at `rev` — the parent revision "Blame before this" loads. */
export function readFileAt(path: string, rev: string, filePath: string): Promise<string> {
  return invoke("read_file_at", { path, rev, filePath });
}
```

- [ ] **Step 10: Verify the frontend**

Run: `npm test` and then `npm run check`
Expected:
- Vitest: all PASS. The `EMPTY_TREE` tests in `repoRange.test.ts` and `branchContainment.test.ts` still compare against the literal.
- svelte-check: 0 errors. `BlameView.svelte` still compiles, because it only reads the old fields.

- [ ] **Step 11: Commit**

```bash
git add src-tauri/src/git/blame.rs src-tauri/src/git/mod.rs src-tauri/src/git/cli.rs src-tauri/src/lib.rs src/lib/emptyTree.ts src/lib/repoRange.ts src/lib/branchContainment.ts src/lib/commitHistory.ts src/lib/types.ts src/lib/git.ts
git commit -F - <<'EOF'
feat(blame): keep each line's commit path, parent and line number

Blame's porcelain already names the path a commit saw, the parent version
it changed and each line's number in that commit; the parser now keeps
them. A new read_file_at command reads a file at a revision. EMPTY_TREE
moves to one module.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 2: Commit view state and navigation

**Files:**
- Modify: `src/lib/types.ts` (after `Blame`; `CompareCtx` at ~line 369)
- Modify: `src/lib/store.svelte.ts` (after `blameTarget`, line ~72)
- Modify: `src/lib/compare.ts:31-46` (options), `:76-77` (previousRepoIdx)
- Modify: `src/lib/history.ts` (whole drill and ctx flow)
- Modify: `src/lib/workspace.ts:242` (repo-switch reset)
- Test: `src/lib/history.test.ts`, `src/lib/compare.test.ts`

**Interfaces:**
- Consumes: `commitLog(path, startRef, all, limit, skip): Promise<Commit[]>` from `git.ts`; `EMPTY_TREE` from `emptyTree.ts` (Task 1).
- Produces:
  - `interface CommitView { repoIdx: number; base: string; target: string; commit: Commit; from: { path: string; line: number } | null }`
  - `interface BlameRev { target: RepoFile; rev: string; path: string; before: { sha: string; summary: string }; line: number | null }`
  - `interface RevealLine { repoIdx: number; path: string; line: number }`
  - `CompareCtx` gains optional `selectedFileRepoIdx?: number | null; commitView?: CommitView | null; blameTarget?: RepoFile | null; blameRev?: BlameRev | null`
  - `appState.commitView: CommitView | null`, `appState.blameRev: BlameRev | null`, `appState.revealLine: RevealLine | null`
  - `compare(opts)` accepts `preserveRepoIdx?: number | null`
  - `pushAndDrillToCommit(sha: string, repoIdx: number | undefined, from: { path: string; line: number } | null): Promise<void>`
  - `commitViewActive(): boolean`
  - `backToHead(): void`
  - `snapshot(): CompareCtx` (exported already; now fills the new fields)

- [ ] **Step 1: Types and store**

In `src/lib/types.ts`, after `Blame`:

```ts
/// The commit a Blame drill-in opened. The Branch screen renders as the commit
/// view while `commitViewActive()` (history.ts) holds. See
/// docs/superpowers/specs/2026-10-14-blame-commit-view-design.md.
export interface CommitView {
  /** The repo the commit belongs to. */
  repoIdx: number;
  /** `commit.parents[0]`, or the empty tree for a root commit. */
  base: string;
  /** Full SHA. */
  target: string;
  commit: Commit;
  /** The blamed file at that commit, and the blamed line's number there. */
  from: { path: string; line: number } | null;
}

/// Blame at a parent revision ("Blame before this"). Only active while
/// `target` is still the file being blamed.
export interface BlameRev {
  /** The HEAD file this revision belongs to (`appState.blameTarget`). */
  target: RepoFile;
  /** Full SHA of the parent. */
  rev: string;
  /** The file's path at `rev`. */
  path: string;
  /** The commit stepped past (Blame's 8-char SHA). */
  before: { sha: string; summary: string };
  /** Line to scroll to once loaded. */
  line: number | null;
}

/// A line DiffView scrolls to once, when it mounts that file.
export interface RevealLine {
  repoIdx: number;
  path: string;
  line: number;
}
```

In `CompareCtx`, after `overrides`:

```ts
  /// Repo of `selectedFilePath`, so Back reopens the file in the right repo.
  selectedFileRepoIdx?: number | null;
  /// The commit view on screen at this ctx (Blame drill-in).
  commitView?: CommitView | null;
  /// Blame's file and revision at this ctx, restored when it is a Blame ctx.
  blameTarget?: RepoFile | null;
  blameRev?: BlameRev | null;
```

In `src/lib/store.svelte.ts`:
- Add `BlameRev`, `CommitView` and `RevealLine` to the existing `import type { … } from "./types"` list.
- After `blameTarget = $state<RepoFile | null>(null);`, add:

```ts
  // Blame at a parent revision ("Blame before this"); null = HEAD with
  // working-copy edits. Session-only.
  blameRev = $state<BlameRev | null>(null);
  // The commit a Blame drill-in opened; the Branch screen renders as the
  // commit view while its range is still on screen (commitViewActive).
  commitView = $state<CommitView | null>(null);
  // A line DiffView scrolls to once, when it mounts that file.
  revealLine = $state<RevealLine | null>(null);
```

In `src/lib/workspace.ts`, after `appState.blameTarget = null;` (line 242):

```ts
  appState.blameRev = null;
  appState.commitView = null;
```

- [ ] **Step 2: Write the failing compare test**

In `src/lib/compare.test.ts`, inside `describe("compare", …)`, add:

```ts
  it("reselects a remembered path in the repo the caller names", async () => {
    // Drill-in and Back clear the selection before comparing, so the repo
    // can't come from the old selection.
    vi.mocked(resolveRepoRanges).mockResolvedValue(allOk);
    await compare({ preservePath: "x.cpp", preserveRepoIdx: 2 });
    expect(appState.selectedFile?.path).toBe("x.cpp");
    expect(appState.selectedFile?.repoIdx).toBe(2);
  });
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/lib/compare.test.ts`
Expected: FAIL, because `selectedFile.repoIdx` is 0 (the fallback to the first file).

- [ ] **Step 4: Implement `preserveRepoIdx`**

In `src/lib/compare.ts` `CompareOptions`, after `preservePath`:

```ts
  /**
   * The repo `preservePath` belongs to. Defaults to the selected file's repo;
   * callers that clear the selection first (drill-in, Back) pass it.
   */
  preserveRepoIdx?: number | null;
```

Replace `const previousRepoIdx = appState.selectedFile?.repoIdx ?? null;` with:

```ts
  const previousRepoIdx =
    opts.preserveRepoIdx !== undefined
      ? opts.preserveRepoIdx
      : (appState.selectedFile?.repoIdx ?? null);
```

Run: `npx vitest run src/lib/compare.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing history tests**

Replace `src/lib/history.test.ts` with:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

// history.ts drives the runes store and compare(); branchContainment.ts is kept
// real (its clearPick is what is under test) with its own imports stubbed.
// Specifiers resolve relative to this file (src/lib).
vi.mock("./store.svelte", () => ({ appState: {} }));
vi.mock("./compare", () => ({ compare: vi.fn() }));
vi.mock("./git", () => ({ commitLog: vi.fn() }));
vi.mock("./repoRange", () => ({ resolveRepoRanges: vi.fn() }));

import {
  backToHead,
  commitViewActive,
  popHistory,
  pushAndDrillToCommit,
  redoHistory,
} from "./history";
import { appState } from "./store.svelte";
import { compare } from "./compare";
import { commitLog } from "./git";
import { EMPTY_TREE } from "./emptyTree";
import type { BlameRev, Commit, CompareCtx, RepoEntry } from "./types";

const repos: RepoEntry[] = [
  { path: "/main", kind: "main", displayName: "main" },
  { path: "/main/sub", kind: "submodule", displayName: "sub", parentGitlinkPath: "sub" },
];
const commit = (sha: string, parents: string[]): Commit => ({
  sha,
  short_sha: sha.slice(0, 7),
  parents,
  author: "a",
  time: 0,
  summary: `subject of ${sha}`,
  refs: [],
  body: "",
});
const picked = commit("c1", ["c0"]);
const ctx: CompareCtx = {
  appMode: "compare",
  compareMode: "branch",
  mode: "three-dot",
  startBranch: "main",
  targetBranch: "feature",
  selectedFilePath: null,
  activeRepoIdx: null,
  overrides: {},
};
const rev = (sha: string): BlameRev => ({
  target: { repoIdx: 0, path: "a.md" },
  rev: sha,
  path: "a.md",
  before: { sha: "b0000000", summary: "b" },
  line: 3,
});

// A super-repo commit picked in the commit table.
function pick(): void {
  appState.bcSelected = { repoIdx: 0, commit: picked };
  appState.bcSelectedDetail = { in_target: false, introduced_by: null };
  appState.bcDiffRange = { repoIdx: 0, start: "c0", target: "c1" };
}

// The pick compare() runs under: it outranks Focus, so it must be gone.
let pickAtCompare: unknown;

beforeEach(() => {
  Object.assign(appState, {
    repoPath: "/main",
    appMode: "blame",
    compareMode: "branch",
    mode: "three-dot",
    startBranch: "main",
    targetBranch: "feature",
    selectedFile: null,
    activeRepoIdx: null,
    repos,
    history: [],
    forwardHistory: [],
    error: null,
    commitView: null,
    blameTarget: { repoIdx: 0, path: "a.md" },
    blameRev: null,
    revealLine: null,
  });
  pickAtCompare = "unset";
  vi.mocked(compare).mockReset();
  vi.mocked(compare).mockImplementation(async () => {
    pickAtCompare = appState.bcDiffRange;
  });
  vi.mocked(commitLog).mockReset();
  vi.mocked(commitLog).mockImplementation(async (_path, ref) => [
    commit(`${ref}-full`, ["p0-full"]),
  ]);
});

describe("history navigation and the commit-table pick", () => {
  it("drops a pick from another repo before listing a drilled submodule commit", async () => {
    // Review focus (F6): the submodule drill leaves the toolbar pair alone,
    // so the super repo's pick would outrank the drill and list nothing.
    pick();
    await pushAndDrillToCommit("s1", 1, null);
    expect(compare).toHaveBeenCalledTimes(1);
    expect(pickAtCompare).toBeNull();
    expect(appState.bcSelected).toBeNull();
    expect(appState.bcSelectedDetail).toBeNull();
  });

  it("drops a pick before re-listing on Back and Forward", () => {
    Object.assign(appState, { appMode: "compare", targetBranch: "c1", history: [ctx] });
    pick();
    popHistory();
    expect(compare).toHaveBeenCalledTimes(1);
    expect(pickAtCompare).toBeNull();
    expect(appState.bcSelected).toBeNull();

    pick();
    pickAtCompare = "unset";
    redoHistory();
    expect(compare).toHaveBeenCalledTimes(2);
    expect(pickAtCompare).toBeNull();
    expect(appState.bcSelected).toBeNull();
  });
});

describe("the Blame drill-in", () => {
  it("reads the commit and opens parent..commit on the blamed file", async () => {
    await pushAndDrillToCommit("a0339e32", 0, { path: "old/a.md", line: 7 });
    expect(commitLog).toHaveBeenCalledWith("/main", "a0339e32", false, 1, 0);
    expect(appState.appMode).toBe("compare");
    expect(appState.mode).toBe("two-dot");
    expect(appState.startBranch).toBe("p0-full");
    expect(appState.targetBranch).toBe("a0339e32-full");
    expect(appState.commitView).toEqual({
      repoIdx: 0,
      base: "p0-full",
      target: "a0339e32-full",
      commit: commit("a0339e32-full", ["p0-full"]),
      from: { path: "old/a.md", line: 7 },
    });
    expect(appState.revealLine).toEqual({ repoIdx: 0, path: "old/a.md", line: 7 });
    expect(compare).toHaveBeenCalledWith({ preservePath: "old/a.md", preserveRepoIdx: 0 });
    expect(appState.history).toHaveLength(1);
    expect(appState.history[0].appMode).toBe("blame");
  });

  it("diffs a root commit against the empty tree", async () => {
    vi.mocked(commitLog).mockResolvedValue([commit("r00t-full", [])]);
    await pushAndDrillToCommit("r00t", 0, null);
    expect(appState.startBranch).toBe(EMPTY_TREE);
    expect(appState.commitView?.base).toBe(EMPTY_TREE);
    expect(appState.revealLine).toBeNull();
  });

  it("drills a submodule commit on that repo's own refs", async () => {
    await pushAndDrillToCommit("s1", 1, { path: "x.cpp", line: 2 });
    expect(commitLog).toHaveBeenCalledWith("/main/sub", "s1", false, 1, 0);
    expect(appState.repos[1].override).toEqual({
      startBranch: "p0-full",
      targetBranch: "s1-full",
    });
    expect(appState.startBranch).toBe("main");
    expect(appState.activeRepoIdx).toBe(1);
    expect(commitViewActive()).toBe(true);
  });

  it("pushes nothing when the commit can't be read", async () => {
    vi.mocked(commitLog).mockRejectedValue("bad object");
    await pushAndDrillToCommit("dead", 0, null);
    expect(appState.history).toHaveLength(0);
    expect(appState.appMode).toBe("blame");
    expect(appState.error).toBe("couldn't open commit dead: bad object");
    expect(compare).not.toHaveBeenCalled();
  });

  it("shows the commit view only while the drilled range is on screen", async () => {
    await pushAndDrillToCommit("a0339e32", 0, null);
    expect(commitViewActive()).toBe(true);
    appState.targetBranch = "feature";
    expect(commitViewActive()).toBe(false);
    appState.targetBranch = "a0339e32-full";
    appState.appMode = "blame";
    expect(commitViewActive()).toBe(false);
  });

  it("Back returns to the older blame the drill left", async () => {
    appState.blameRev = rev("p1");
    await pushAndDrillToCommit("a0339e32", 0, null);
    // The drill leaves Blame: a later Blame starts at HEAD.
    expect(appState.blameRev).toBeNull();
    appState.blameTarget = { repoIdx: 0, path: "other.md" };
    popHistory();
    expect(appState.appMode).toBe("blame");
    expect(appState.blameTarget).toEqual({ repoIdx: 0, path: "a.md" });
    expect(appState.blameRev).toEqual(rev("p1"));
    expect(appState.commitView).toBeNull();
  });

  it("Back reopens the file in the repo it was in", () => {
    Object.assign(appState, {
      appMode: "compare",
      history: [{ ...ctx, selectedFilePath: "x.cpp", selectedFileRepoIdx: 1 }],
    });
    popHistory();
    expect(compare).toHaveBeenCalledWith({ preservePath: "x.cpp", preserveRepoIdx: 1 });
  });

  it("Forward re-enters the commit view", async () => {
    await pushAndDrillToCommit("a0339e32", 0, null);
    popHistory();
    expect(appState.commitView).toBeNull();
    redoHistory();
    expect(appState.commitView?.target).toBe("a0339e32-full");
  });
});

describe("backToHead", () => {
  it("pops every older-blame frame and stops at HEAD", () => {
    const blameCtx = (r: BlameRev | null): CompareCtx => ({
      ...ctx,
      appMode: "blame",
      blameTarget: { repoIdx: 0, path: "a.md" },
      blameRev: r,
    });
    Object.assign(appState, {
      history: [{ ...ctx }, blameCtx(null), blameCtx(rev("p1"))],
      blameRev: rev("p2"),
    });
    backToHead();
    expect(appState.blameRev).toBeNull();
    expect(appState.history).toHaveLength(1);
    expect(appState.forwardHistory).toHaveLength(2);
    expect(appState.appMode).toBe("blame");
  });
});
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `npx vitest run src/lib/history.test.ts`
Expected: FAIL on imports: `backToHead` and `commitViewActive` are not exported. The drill tests fail too.

- [ ] **Step 7: Implement the history changes**

In `src/lib/history.ts`:

1. Replace the imports with:

```ts
import { appState } from "./store.svelte";
import { compare } from "./compare";
import { commitLog } from "./git";
import { EMPTY_TREE } from "./emptyTree";
import { clearPick } from "./branchContainment";
import type { Commit, CompareCtx } from "./types";
```

2. Replace the whole `pushAndDrillToCommit` function and its doc comment with:

```ts
/**
 * Push the current context and open one commit from Blame mode as the commit
 * view: a two-dot Branch compare of `parent..commit` that the Branch screen
 * renders as a commit (see `commitViewActive`). The commit is read first: the
 * commit card shows its message, and its first parent (the empty tree for a
 * root commit) is the base, so a root commit never asks for `<sha>^`.
 *
 * `repoIdx` is the blamed file's repo. A non-main repo gets the range as its
 * per-repo override (rather than mutating main's refs) — gitlink-follow
 * would otherwise try to resolve the submodule's SHA inside main's history.
 * `from` is the blamed file at that commit and the blamed line's number
 * there; the drill selects that file and DiffView scrolls to the line.
 *
 * When the commit can't be read nothing is pushed and Blame stays.
 */
export async function pushAndDrillToCommit(
  sha: string,
  repoIdx: number | undefined,
  from: { path: string; line: number } | null,
): Promise<void> {
  const idx =
    repoIdx !== undefined && repoIdx >= 0 && repoIdx < appState.repos.length
      ? repoIdx
      : 0;
  const repoPath = appState.repos[idx]?.path ?? appState.repoPath;
  let commit: Commit | undefined;
  try {
    [commit] = await commitLog(repoPath, sha, false, 1, 0);
  } catch (e) {
    appState.error = `couldn't open commit ${sha}: ${String(e)}`;
    return;
  }
  if (!commit) {
    appState.error = `couldn't open commit ${sha}: not found`;
    return;
  }
  const base = commit.parents[0] ?? EMPTY_TREE;
  const target = commit.sha;

  appState.history.push(snapshot());
  // Fresh drill invalidates any forward stack — matches browser back/forward
  // semantics (a new navigation from a back-tracked state drops the redo).
  appState.forwardHistory = [];
  appState.appMode = "compare";
  appState.compareMode = "branch";
  appState.mode = "two-dot";
  appState.selectedFile = null;
  // The drill leaves Blame; the older blame is in the frame just pushed, and
  // a later trip to Blame starts at HEAD.
  appState.blameRev = null;

  const multiRoot = appState.repos.length > 1;
  const targetRepo = appState.repos[idx];
  if (multiRoot && targetRepo && targetRepo.kind !== "main") {
    const next = [...appState.repos];
    next[idx] = { ...targetRepo, override: { startBranch: base, targetBranch: target } };
    appState.repos = next;
    appState.activeRepoIdx = idx;
  } else {
    appState.startBranch = base;
    appState.targetBranch = target;
    if (multiRoot) appState.activeRepoIdx = idx;
  }
  appState.commitView = { repoIdx: idx, base, target, commit, from };
  appState.revealLine = from ? { repoIdx: idx, path: from.path, line: from.line } : null;
  // A commit picked in the commit table outranks everything in compare(); a
  // drill (above all one into a submodule, which leaves the toolbar pair
  // alone) is a fresh view, so the pick goes first.
  clearPick();
  void compare({ preservePath: from?.path ?? null, preserveRepoIdx: idx });
}

/// The Branch screen renders as the commit view while a Blame drill-in's range
/// is still on screen: Branch mode, and the drilled repo's range exactly
/// base..target (its override for a non-main repo, else the toolbar pair).
/// Moving the range anywhere drops back to the ordinary Branch screen.
export function commitViewActive(): boolean {
  const v = appState.commitView;
  if (!v || appState.appMode !== "compare" || appState.compareMode !== "branch") {
    return false;
  }
  const repo = appState.repos[v.repoIdx];
  if (appState.repos.length > 1 && repo && repo.kind !== "main") {
    return (
      repo.override?.startBranch === v.base && repo.override?.targetBranch === v.target
    );
  }
  return appState.startBranch === v.base && appState.targetBranch === v.target;
}
```

3. Replace `snapshot()` with:

```ts
/** Snapshot the current workspace context for the history stacks. */
export function snapshot(): CompareCtx {
  return {
    appMode: appState.appMode,
    compareMode: appState.compareMode,
    mode: appState.mode,
    startBranch: appState.startBranch,
    targetBranch: appState.targetBranch,
    selectedFilePath: appState.selectedFile?.path ?? null,
    selectedFileRepoIdx: appState.selectedFile?.repoIdx ?? null,
    activeRepoIdx: appState.activeRepoIdx,
    overrides: captureOverrides(),
    commitView: appState.commitView,
    blameTarget: appState.blameTarget,
    blameRev: appState.blameRev,
  };
}
```

4. In `applyCtx`, after `restoreOverrides(ctx.overrides ?? {});`, add the following. Then change the compare call to pass the repo.

```ts
  appState.commitView = ctx.commitView ?? null;
  // A Blame ctx brings back the file and revision it showed. Fall back to the
  // current file for ctx values saved before the field existed.
  if (ctx.appMode === "blame") {
    if (ctx.blameTarget !== undefined) appState.blameTarget = ctx.blameTarget;
    appState.blameRev = ctx.blameRev ?? null;
  }
```

   Also update the comment above the `if (ctx.appMode === "compare")` block, replacing "Blame-side state lives in `appState.blameTarget` and survives the drill round-trip on its own." with "Blame-side state is restored above.". Change the call to:

```ts
    void compare({
      preservePath: ctx.selectedFilePath,
      preserveRepoIdx: ctx.selectedFileRepoIdx,
    });
```

5. After `redoHistory`, add:

```ts
/** Leave every "Blame before this" step at once: pop while Blame shows an
 * older revision. Each popped frame goes onto the forward stack. */
export function backToHead(): void {
  while (
    appState.appMode === "blame" &&
    appState.blameRev &&
    appState.history.length > 0
  ) {
    popHistory();
  }
}
```

- [ ] **Step 8: Update the drill's callers so the project type-checks**

In `src/lib/ui/BlameView.svelte`, the two calls become (Task 5 passes real `from` values):

```ts
        void pushAndDrillToCommit(commit.sha, appState.blameTarget?.repoIdx, null);
```

and

```svelte
                onclick={() =>
                  void pushAndDrillToCommit(c.sha, appState.blameTarget?.repoIdx, null)}
```

- [ ] **Step 9: Run the tests and the check**

Run: `npm test` and then `npm run check`
Expected: all PASS; 0 errors.

- [ ] **Step 10: Commit**

```bash
git add src/lib/types.ts src/lib/store.svelte.ts src/lib/compare.ts src/lib/compare.test.ts src/lib/history.ts src/lib/history.test.ts src/lib/workspace.ts src/lib/ui/BlameView.svelte
git commit -F - <<'EOF'
feat(blame): open a blamed commit as a commit view

The drill-in reads the commit first and diffs it against its first parent
(the empty tree for a root commit), records the commit view, and selects
the blamed file. Back now reopens a file in the repo it was in.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 3: Blame before this (logic)

**Files:**
- Create: `src/lib/blameRev.ts`
- Test: `src/lib/blameRev.test.ts`

**Interfaces:**
- Consumes:
  - `snapshot()` from `history.ts` (Task 2)
  - `readFileAt` from `git.ts` (Task 1)
  - `BlameCommit` / `BlameRev` / `RepoFile` (Tasks 1-2)
  - `diff` from `@codemirror/merge`
- Produces:
  - `interface LineChange { fromA: number; toA: number; fromB: number; toB: number }`
  - `mapLineBack(oldText: string, newText: string, changes: readonly LineChange[], newLine: number): number`
  - `blameRevFor(rev: BlameRev | null, target: RepoFile | null): BlameRev | null`
  - `blameBefore(commit: BlameCommit, lineInCommit: number): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/blameRev.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./store.svelte", () => ({ appState: {} }));
vi.mock("./git", () => ({ readFileAt: vi.fn() }));
vi.mock("./history", () => ({ snapshot: () => ({ tag: "snap" }) }));

import { blameBefore, blameRevFor, mapLineBack, type LineChange } from "./blameRev";
import { appState } from "./store.svelte";
import { readFileAt } from "./git";
import type { BlameCommit, BlameRev } from "./types";

// Changes are character offsets, old = a, new = b, as @codemirror/merge's
// `diff` returns them.
const ch = (fromA: number, toA: number, fromB: number, toB: number): LineChange => ({
  fromA,
  toA,
  fromB,
  toB,
});

describe("mapLineBack", () => {
  it("keeps a line when nothing changed", () => {
    expect(mapLineBack("a\nb\nc\n", "a\nb\nc\n", [], 2)).toBe(2);
  });

  it("keeps a line above a change and maps a modified line to itself", () => {
    // "b" -> "B" on line 2.
    const c = [ch(2, 3, 2, 3)];
    expect(mapLineBack("a\nb\nc\n", "a\nB\nc\n", c, 1)).toBe(1);
    expect(mapLineBack("a\nb\nc\n", "a\nB\nc\n", c, 2)).toBe(2);
  });

  it("maps inserted lines to the insertion point and shifts lines below", () => {
    // "b1\nb2\n" inserted at the start of old line 2.
    const c = [ch(2, 2, 2, 8)];
    const oldT = "a\nc\n";
    const newT = "a\nb1\nb2\nc\n";
    expect(mapLineBack(oldT, newT, c, 2)).toBe(2);
    expect(mapLineBack(oldT, newT, c, 3)).toBe(2);
    expect(mapLineBack(oldT, newT, c, 4)).toBe(2);
  });

  it("shifts a line below deleted lines", () => {
    // "x\ny\n" deleted from old lines 2-3.
    const c = [ch(2, 6, 2, 2)];
    expect(mapLineBack("a\nx\ny\nc\n", "a\nc\n", c, 2)).toBe(4);
  });

  it("clamps a line past either file's end", () => {
    expect(mapLineBack("a\n", "a\nb\nc\n", [ch(2, 2, 2, 6)], 99)).toBe(2);
  });
});

const target = { repoIdx: 0, path: "new.md" };
const rev: BlameRev = {
  target,
  rev: "p".repeat(40),
  path: "old.md",
  before: { sha: "c1c1c1c1", summary: "s" },
  line: 1,
};

describe("blameRevFor", () => {
  it("is the revision only while its file is the one blamed", () => {
    expect(blameRevFor(rev, target)).toBe(rev);
    expect(blameRevFor(rev, { repoIdx: 0, path: "other.md" })).toBeNull();
    expect(blameRevFor(rev, { repoIdx: 1, path: "new.md" })).toBeNull();
    expect(blameRevFor(null, target)).toBeNull();
  });
});

describe("blameBefore", () => {
  const commit: BlameCommit = {
    sha: "c1c1c1c1",
    author: "a",
    author_time: 0,
    summary: "rename and edit",
    filename: "new.md",
    previous: { sha: "p".repeat(40), path: "old.md" },
  };

  beforeEach(() => {
    Object.assign(appState, {
      repos: [{ path: "/main", kind: "main", displayName: "main" }],
      blameTarget: target,
      blameRev: null,
      history: [],
      forwardHistory: [{ tag: "stale" }],
    });
    vi.mocked(readFileAt).mockReset();
  });

  it("pushes the view and blames the parent at the mapped line", async () => {
    vi.mocked(readFileAt).mockImplementation(async (_repo, r) =>
      r === commit.sha ? "a\nb\nc\n" : "a\nc\n",
    );
    await blameBefore(commit, 3);
    expect(readFileAt).toHaveBeenCalledWith("/main", "p".repeat(40), "old.md");
    expect(readFileAt).toHaveBeenCalledWith("/main", "c1c1c1c1", "new.md");
    expect(appState.history).toEqual([{ tag: "snap" }]);
    expect(appState.forwardHistory).toEqual([]);
    expect(appState.blameRev).toEqual({
      target,
      rev: "p".repeat(40),
      path: "old.md",
      before: { sha: "c1c1c1c1", summary: "rename and edit" },
      line: 2,
    });
  });

  it("falls back to the commit's own line when a version can't be read", async () => {
    vi.mocked(readFileAt).mockRejectedValue("gone");
    await blameBefore(commit, 5);
    expect(appState.blameRev?.line).toBe(5);
  });

  it("does nothing for a commit that added the file", async () => {
    await blameBefore({ ...commit, previous: null }, 3);
    expect(appState.history).toEqual([]);
    expect(appState.blameRev).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/blameRev.test.ts`
Expected: FAIL: cannot find module `./blameRev`.

- [ ] **Step 3: Implement `src/lib/blameRev.ts`**

```ts
import { diff } from "@codemirror/merge";
import { appState } from "./store.svelte";
import { readFileAt } from "./git";
import { snapshot } from "./history";
import type { BlameCommit, BlameRev, RepoFile } from "./types";

/// A change between two texts in character offsets (old = a, new = b), the
/// shape @codemirror/merge's `diff` returns.
export interface LineChange {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
}

/// Offset of each line's start in `text` (line 1 at index 0).
function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") out.push(i + 1);
  return out;
}

/// 1-based line holding offset `pos`.
function lineAt(starts: number[], pos: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/// Where line `newLine` of `newText` sat in `oldText`. The line's start is
/// mapped through the changes (sorted by position, as `diff` returns them): a
/// start past a change shifts by what the changes before it added or removed,
/// and a start inside a change maps to where that change began in the old
/// text — so an inserted line lands on the insertion point. Clamped to both
/// files.
export function mapLineBack(
  oldText: string,
  newText: string,
  changes: readonly LineChange[],
  newLine: number,
): number {
  const newStarts = lineStarts(newText);
  const oldStarts = lineStarts(oldText);
  const line = Math.min(Math.max(1, newLine), newStarts.length);
  const p = newStarts[line - 1];
  let oldPos = p;
  for (const c of changes) {
    if (c.fromB > p) break;
    if (p < c.toB) {
      oldPos = c.fromA;
      break;
    }
    oldPos = p - c.toB + c.toA;
  }
  return lineAt(oldStarts, oldPos);
}

/// The revision Blame shows: `rev` while it still belongs to the blamed file,
/// else null (HEAD). Many places repoint `blameTarget`; this keeps a stale
/// revision from loading for another file.
export function blameRevFor(rev: BlameRev | null, target: RepoFile | null): BlameRev | null {
  if (!rev || !target) return null;
  return rev.target.repoIdx === target.repoIdx && rev.target.path === target.path
    ? rev
    : null;
}

/// "Blame before this": push the current view and re-blame the file at
/// `commit`'s parent, scrolled to where line `lineInCommit` (its number in the
/// commit's version) sat before the commit. Does nothing for a commit that
/// added the file. When either version can't be read the line falls back to
/// the commit's own number; the view clamps it.
export async function blameBefore(commit: BlameCommit, lineInCommit: number): Promise<void> {
  const prev = commit.previous;
  const target = appState.blameTarget;
  if (!prev || !target) return;
  const repoPath = appState.repos[target.repoIdx]?.path;
  if (!repoPath) return;
  let line = lineInCommit;
  try {
    const [oldText, newText] = await Promise.all([
      readFileAt(repoPath, prev.sha, prev.path),
      readFileAt(repoPath, commit.sha, commit.filename),
    ]);
    line = mapLineBack(oldText, newText, diff(oldText, newText), lineInCommit);
  } catch {
    // Keep the commit's own number.
  }
  appState.history.push(snapshot());
  appState.forwardHistory = [];
  appState.blameRev = {
    target,
    rev: prev.sha,
    path: prev.path,
    before: { sha: commit.sha, summary: commit.summary },
    line,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/blameRev.test.ts`
Expected: PASS.

The "pushes the view" test runs the real `diff`. Whichever way `diff` aligns the inserted `b\n`, old line 2 (`c`) is where new line 3 maps. If this test fails, debug `mapLineBack` against the actual `diff` output. Do not change the expected value.

- [ ] **Step 5: Full suite and check**

Run: `npm test` and then `npm run check`
Expected: all PASS; 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/blameRev.ts src/lib/blameRev.test.ts
git commit -F - <<'EOF'
feat(blame): step back to the file before a commit

blameBefore pushes the view and points Blame at the commit's parent,
under the path the file had there, scrolled to where the line sat before
the commit (mapped through a diff of the two versions).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 4: Commit view UI

**Files:**
- Create: `src/lib/ui/relativeDate.ts`, `src/lib/ui/toast.ts`, `src/lib/ui/CommitCard.svelte`, `src/lib/ui/CommitViewFields.svelte`
- Modify: `src/lib/ui/InputBar.svelte:164-166` (fields), `:217-233` (Compare button)
- Modify: `src/lib/ui/Breadcrumb.svelte`
- Modify: `src/lib/ui/FilesScope.svelte` (template start, line ~52)
- Modify: `src/lib/ui/DiffView.svelte:106-121` (labels), `:373-385` (scroll restore)
- Modify: `src/routes/+page.svelte:97-107` (headerRange), `:518-534` (strip, scope bar), `:686-700` (commit pane)
- Modify: `src/lib/ui/BlameView.svelte` (use the shared `relativeDate` / `showToast`)

**Interfaces:**
- Consumes:
  - `appState.commitView`, `appState.revealLine`, `commitViewActive()` and `popHistory()` (Task 2)
- Produces:
  - `relativeDate(unixSec: number): string`
  - `showToast(msg: string): void`
  - components `CommitCard` and `CommitViewFields` (no props)

No component test setup exists, so this task is verified by `npm run check` and by hand (Step 9).

- [ ] **Step 1: Shared helpers**

Create `src/lib/ui/relativeDate.ts`, moving BlameView's function verbatim:

```ts
/// "3d ago"-style age of a unix-seconds timestamp.
export function relativeDate(unixSec: number): string {
  const diff = Date.now() / 1000 - unixSec;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 2592000) return `${Math.floor(diff / 604800)}w ago`;
  if (diff < 31536000) return `${Math.floor(diff / 2592000)}mo ago`;
  return `${Math.floor(diff / 31536000)}y ago`;
}
```

Create `src/lib/ui/toast.ts`, moving BlameView's `showToast` verbatim:

```ts
/// A short-lived toast at the bottom right. Styled by the global
/// `.blame-toast` rules in BlameView.svelte (always bundled: +page imports it).
export function showToast(msg: string): void {
  const t = document.createElement("div");
  t.className = "blame-toast";
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 250);
  }, 1500);
}
```

In `BlameView.svelte`:
- Delete the local `relativeDate` and `showToast` functions.
- Add `import { relativeDate } from "./relativeDate";` and `import { showToast } from "./toast";`.

- [ ] **Step 2: `CommitCard.svelte`**

```svelte
<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import { relativeDate } from "./relativeDate";

  // The commit view's card, in the commit table's pane: the commit a Blame
  // drill-in opened. A body past BODY_FOLD_LINES folds.
  const BODY_FOLD_LINES = 6;
  let expanded = $state(false);

  const commit = $derived(appState.commitView?.commit ?? null);
  const folds = $derived(
    !!commit?.body && commit.body.split("\n").length > BODY_FOLD_LINES,
  );
  const fileCount = $derived(
    appState.loadingFiles ? "…" : String(appState.files.length),
  );

  // Another commit starts folded.
  $effect(() => {
    void commit?.sha;
    expanded = false;
  });

  function fullDate(unixSec: number): string {
    return new Date(unixSec * 1000).toLocaleString();
  }
</script>

{#if commit}
  <section class="commit-card">
    <p class="cc-subject">{commit.summary || "(no subject)"}</p>
    <div class="cc-meta">
      <b>{commit.author}</b>
      <span>{fullDate(commit.time)} ({relativeDate(commit.time)})</span>
      {#if commit.parents.length === 0}
        <span>first commit</span>
      {:else if commit.parents.length > 1}
        <span>merge · {commit.parents.length} parents · diff against the first parent</span>
      {:else}
        <span>parent <code>{commit.parents[0].slice(0, 8)}</code></span>
      {/if}
      <span>{fileCount} files</span>
    </div>
    {#if commit.body}
      <pre class="cc-body" class:folded={folds && !expanded}>{commit.body}</pre>
      {#if folds}
        <button type="button" class="cc-more" onclick={() => (expanded = !expanded)}>
          {expanded ? "Show less ▴" : "Show full message ▾"}
        </button>
      {/if}
    {/if}
  </section>
{/if}

<style>
  .commit-card {
    height: 100%;
    overflow-y: auto;
    padding: 10px 14px;
    user-select: text;
  }
  .cc-subject {
    margin: 0 0 6px;
    font-weight: 600;
    line-height: 1.35;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .cc-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    font-size: 0.82em;
    color: var(--muted);
    margin-bottom: 8px;
  }
  .cc-meta b {
    color: var(--fg);
  }
  code {
    font-family: var(--mono);
  }
  .cc-body {
    margin: 0;
    font-family: inherit;
    font-size: 0.86em;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .cc-body.folded {
    max-height: calc(6 * 1.5em);
    overflow: hidden;
    -webkit-mask-image: linear-gradient(#000 60%, transparent);
    mask-image: linear-gradient(#000 60%, transparent);
  }
  .cc-more {
    margin-top: 4px;
    border: none;
    background: transparent;
    color: var(--accent);
    font: inherit;
    font-size: 0.82em;
    padding: 0;
    cursor: pointer;
  }
  .cc-more:hover {
    text-decoration: underline;
  }
</style>
```

- [ ] **Step 3: `CommitViewFields.svelte`**

```svelte
<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import { popHistory } from "$lib/history";
  import { showToast } from "./toast";

  // The toolbar's second row in the commit view, in place of the base /
  // compare pickers: the one place the commit's SHA is shown.
  const view = $derived(appState.commitView);
  const repo = $derived.by(() => {
    if (!view || appState.repos.length < 2) return null;
    const r = appState.repos[view.repoIdx];
    return r && r.kind !== "main" ? r : null;
  });

  function copySha() {
    if (!view) return;
    void navigator.clipboard.writeText(view.target);
    showToast(`Copied ${view.target}`);
  }
</script>

{#if view}
  <button type="button" class="back" onclick={popHistory} title="Back (Esc)">← Back</button>
  <span class="label">Commit</span>
  <button type="button" class="sha" onclick={copySha} title="Copy SHA">
    {view.target.slice(0, 8)} ⧉
  </button>
  {#if repo}
    <span class="repo" title={repo.path}>{repo.displayName}</span>
  {/if}
  {#if view.from}
    <span class="from">from blame of <code>{view.from.path}</code></span>
  {/if}
{/if}

<style>
  .back,
  .sha {
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--input-bg);
    color: inherit;
    cursor: pointer;
    padding: 3px 10px;
    font-size: 0.9em;
  }
  .back:hover,
  .sha:hover {
    background: var(--hover);
  }
  .sha {
    font-family: var(--mono);
  }
  .label,
  .from {
    color: var(--muted);
    font-size: 0.9em;
  }
  .repo {
    font-family: var(--mono);
    font-size: 0.9em;
  }
  .from {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  code {
    font-family: var(--mono);
    color: var(--fg);
  }
</style>
```

- [ ] **Step 4: InputBar and Breadcrumb**

In `InputBar.svelte`:
- Add `import CommitViewFields from "./CommitViewFields.svelte";` next to the other component imports.
- Add `import { commitViewActive } from "$lib/history";` next to the store import.
- Replace:

```svelte
  {#if appState.appMode === "compare"}
    <BranchModeFields />
  {/if}
```

  with:

```svelte
  {#if appState.appMode === "compare"}
    {#if commitViewActive()}
      <CommitViewFields />
    {:else}
      <BranchModeFields />
    {/if}
  {/if}
```

- Change the Compare button's guard from `{#if appState.appMode === "compare"}` (the one wrapping `<button class="primary"`) to `{#if appState.appMode === "compare" && !commitViewActive()}`.

In `Breadcrumb.svelte`:
- Change the import to `import { commitViewActive, popHistory } from "$lib/history";`.
- Replace `previousLabel` with:

```ts
  function previousLabel(): string | null {
    const prev = appState.history[appState.history.length - 1];
    // A frame with no pair (e.g. Blame before any compare) has nothing to name.
    return prev && prev.startBranch && prev.targetBranch
      ? ctxLabel(prev.startBranch, prev.targetBranch, prev.mode)
      : null;
  }
```

- Change `{#if appState.history.length > 0}` to:

```svelte
{#if appState.history.length > 0 && appState.appMode === "compare" && !commitViewActive()}
```

- [ ] **Step 5: FilesScope**

In `FilesScope.svelte`:
- Add `import { commitViewActive } from "$lib/history";`.
- Wrap the template's opening `{#if visibleOk.length > 0}` so the commit view comes first:

```svelte
{#if commitViewActive() && appState.commitView}
  <div class="files-scope">
    <span class="what">
      <b>Commit {appState.commitView.target.slice(0, 8)}</b> · {appState.loadingFiles
        ? "…"
        : appState.files.length} files
    </span>
  </div>
{:else if visibleOk.length > 0}
```

  Keep the rest of the template, and its closing `{/if}`, unchanged.

- [ ] **Step 6: DiffView labels and the reveal line**

In `DiffView.svelte`:
- Add `import { commitViewActive } from "$lib/history";`.
- In the `labels` derived, after `if (appState.appMode !== "compare" || !f) return null;`, add:

```ts
    if (commitViewActive()) return { left: "before", right: "after" };
```

- Replace the `§14.2 Step 7` scroll-restore block in `mount` (from the comment through its closing `}`) with:

```ts
    // A Blame drill-in names the line it came from: scroll the after side to
    // it once (it is a line the commit changed, so never in a collapsed run).
    // Otherwise §14.2 Step 7: restore the scroll position saved when the user
    // last left this file's tab. Only applies when this file matches the
    // tab's remembered file — switching to a different file resets to top.
    const reveal = appState.revealLine;
    const view = mergeView?.b ?? unifiedView;
    if (reveal && reveal.path === file.path && reveal.repoIdx === (file.repoIdx ?? 0)) {
      appState.revealLine = null;
      if (view) {
        const n = Math.min(Math.max(1, reveal.line), view.state.doc.lines);
        const pos = view.state.doc.line(n).from;
        requestAnimationFrame(() => {
          view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "center" }) });
        });
      }
    } else {
      const mem = appState.tabMemory.get(file.repoIdx ?? 0);
      if (mem?.filePath === file.path && typeof mem.scrollPos === "number" && view) {
        const top = mem.scrollPos;
        requestAnimationFrame(() => {
          view.scrollDOM.scrollTop = top;
        });
      }
    }
```

  If `view` collides with an existing identifier in that function's scope, name it `revealView`.

- [ ] **Step 7: +page**

In `src/routes/+page.svelte`:

- Add `import CommitCard from "$lib/ui/CommitCard.svelte";` next to the `CommitDetail` import.
- Add `import { commitViewActive } from "$lib/history";`. If `$lib/history` is already imported, extend that import instead.
- In `headerRange`, after `if (appState.appMode !== "compare" || !f) return null;`, add:

```ts
    // The commit view names its commit once, in the toolbar.
    if (commitViewActive()) return null;
```

- Branch's `RepoTabs` guard becomes:

```svelte
  {#if appState.appMode === "compare" && appState.workspaceLayout === "unified" && appState.repos.length > 1 && !commitViewActive()}
```

- The `ScopeBar` guard becomes `{#if appState.appMode === "compare" && !commitViewActive()}`.
- The commit pane: replace

```svelte
      <div
        class="branch-col"
        class:collapsed={appState.commitTableCollapsed}
```

  with

```svelte
      <div
        class="branch-col"
        class:collapsed={appState.commitTableCollapsed && !commitViewActive()}
```

  Then replace `<div class="ct-pane"><CommitTable /></div>` and the `{#if !appState.commitTableCollapsed}` just below it with:

```svelte
        <div class="ct-pane">
          {#if commitViewActive()}
            <CommitCard />
          {:else}
            <CommitTable />
          {/if}
        </div>
        {#if !appState.commitTableCollapsed || commitViewActive()}
```

  Keep the resizer markup inside that `{#if}` unchanged.

- [ ] **Step 8: Check**

Run: `npm run check` and then `npm test`
Expected: 0 errors; all PASS.

- [ ] **Step 9: Verify by hand**

Run `npm run tauri dev` in an external terminal. Then:

1. Open `studio-docs`, choose Blame, open `knowledge/INDEX.md`, and press `→` on any commit.
2. Check:
   - The second toolbar row reads `← Back · Commit <8 chars> ⧉ · from blame of …` (the path is empty until Task 5, which passes `from`).
   - There is no breadcrumb row and no Compare button.
   - The card shows the subject, meta and body.
   - The Files header reads `Commit <sha> · N files`.
   - The diff header has no pair, and the pane labels read `before` / `after`.
3. Esc returns to Blame.
4. Switch to Branch with ordinary refs: the screen looks as it did before.

- [ ] **Step 10: Commit**

```bash
git add src/lib/ui/relativeDate.ts src/lib/ui/toast.ts src/lib/ui/CommitCard.svelte src/lib/ui/CommitViewFields.svelte src/lib/ui/InputBar.svelte src/lib/ui/Breadcrumb.svelte src/lib/ui/FilesScope.svelte src/lib/ui/DiffView.svelte src/routes/+page.svelte src/lib/ui/BlameView.svelte
git commit -F - <<'EOF'
feat(blame): show a drilled commit's message and name its SHA once

While a Blame drill-in's range is on screen the Branch screen becomes the
commit view: Back, the commit's SHA and where it came from in the toolbar,
a card with the subject and body in the commit table's place, before and
after over the diff, and no merge wording. DiffView scrolls to the line a
drill names.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 5: Blame UI — drill target, Blame before this, revision bar

**Files:**
- Modify: `src/lib/blameCache.ts`
- Modify: `src/lib/ui/BlameView.svelte` (imports; `load` ~line 460; the load `$effect` ~line 442; `selectFile` ~561; `blameLinePlugin` ~779; `onHostClick` ~846; `renderPopover` ~871; `paintTooltipDom` ~938; editor header ~1100-1163; commit rows ~1177-1226; styles)
- Modify: `README.md` (sections 4 and 5, lines ~245-290)

**Interfaces:**
- Consumes:
  - `pushAndDrillToCommit(sha, repoIdx, from)`, `popHistory()`, `backToHead()` (Task 2)
  - `blameBefore(commit, line)`, `blameRevFor(rev, target)` (Task 3)
  - `readFileAt` (Task 1)
  - `Blame.line_orig`, `BlameCommit.filename/previous` (Task 1)
- Produces: `getBlameCache(repoIdx, path, rev)` and `setBlameCache(repoIdx, path, rev, entry)`, where `rev` is `"HEAD"` for today's entry.

- [ ] **Step 1: Cache key**

In `src/lib/blameCache.ts`:
- Update the doc comment to say "keyed by (repoIdx, path, revision)".
- Change `makeKey` to `function makeKey(repoIdx: number, path: string, rev: string): string { return \`${repoIdx}:${rev}:${path}\`; }`.
- Add a `rev: string` parameter after `path` to `getBlameCache` and `setBlameCache`, passing it to `makeKey`.

- [ ] **Step 2: Load at a revision**

In `BlameView.svelte`:

- Imports become:

```ts
  import {
    blameFile,
    listRepoFiles,
    readFileAt,
    readRepoFile,
    setBlamePickerWidth,
  } from "$lib/git";
  import { getBlameCache, setBlameCache } from "$lib/blameCache";
  import { backToHead, popHistory, pushAndDrillToCommit } from "$lib/history";
  import { blameBefore, blameRevFor } from "$lib/blameRev";
  import { repoPathFor } from "$lib/workspace";
  import type { Blame, BlameCommit, BlameRev, RepoFile } from "$lib/types";
```

- After `let selectedCommitSha = $state<string | null>(null);`, add:

```ts
  // The revision on screen (null = HEAD), and the line "Blame before this"
  // scrolled to, marked until the next click in the editor.
  const activeRev = $derived(blameRevFor(appState.blameRev, appState.blameTarget));
  let focusLine = $state<number | null>(null);
```

- The load `$effect` reads the revision. Replace `void load(target);` with:

```ts
    void load(target, activeRev);
```

- Replace `load` with:

```ts
  async function load(target: RepoFile, rev: BlameRev | null) {
    teardownEditor();
    fileText = null;
    loadError = null;
    blameData = null;
    blameError = null;
    selectedCommitSha = null;
    focusLine = null;

    // At a revision the file may sit under its older path.
    const revKey = rev?.rev ?? "HEAD";
    const filePath = rev?.path ?? target.path;
    const current = () =>
      sameTarget(appState.blameTarget, target) &&
      blameRevFor(appState.blameRev, appState.blameTarget) === rev;

    // LRU cache: drill-in round-trips and short blame-mode tab navigation
    // shouldn't pay the file read + blameFile cost twice for the same file.
    const cached = getBlameCache(target.repoIdx, filePath, revKey);
    if (cached) {
      fileText = cached.fileText;
      blameData = cached.blame;
      blameLoading = false;
      await tick();
      await mountEditor(filePath, cached.fileText);
      revealRevLine(rev);
      return;
    }

    blameLoading = true;

    const repoPath = repoPathFor(target);
    if (!repoPath) {
      loadError = "repo no longer in workspace";
      blameLoading = false;
      return;
    }

    // HEAD blames the working copy (uncommitted lines included); an older
    // revision blames that commit's content.
    const textP = rev
      ? readFileAt(repoPath, rev.rev, rev.path)
      : readRepoFile(repoPath, target.path);
    const blameP = rev
      ? blameFile(repoPath, rev.path, rev.rev, false)
      : blameFile(repoPath, target.path, "HEAD", true);
    let text: string;
    let blame: Blame;
    try {
      [text, blame] = await Promise.all([textP, blameP]);
    } catch (e) {
      if (!current()) return;
      loadError = String(e);
      blameLoading = false;
      return;
    }

    // Race: user picked a different file or revision while we were loading.
    if (!current()) return;
    fileText = text;
    blameData = blame;
    blameLoading = false;
    setBlameCache(target.repoIdx, filePath, revKey, { fileText: text, blame });
    await tick();
    await mountEditor(filePath, text);
    revealRevLine(rev);
  }

  // After "Blame before this": centre the line the stepped-past commit
  // changed, as it read before, and mark it.
  function revealRevLine(rev: BlameRev | null) {
    if (!rev?.line || !view) return;
    const n = Math.min(Math.max(1, rev.line), view.state.doc.lines);
    focusLine = n;
    view.dispatch({
      effects: EditorView.scrollIntoView(view.state.doc.line(n).from, { y: "center" }),
    });
  }
```

- `selectFile` picks the file at HEAD:

```ts
  function selectFile(target: RepoFile) {
    if (sameTarget(appState.blameTarget, target) && !activeRev) return;
    appState.blameRev = null;
    appState.blameTarget = target;
  }
```

- [ ] **Step 3: Focus line decoration**

- In `blameLinePlugin.build`, replace the `cls` computation and the `ranges.push(...)` call with:

```ts
          const lineNum = i + 1;
          const cls = [
            selectedCommitSha !== null && commit.sha === selectedCommitSha
              ? "blame-selected"
              : null,
            lineNum === focusLine ? "blame-focus" : null,
          ]
            .filter(Boolean)
            .join(" ");
          const line = view.state.doc.line(lineNum);
          ranges.push(
            Decoration.line({
              attributes: cls
                ? { "data-blame-sha": commit.sha, class: cls }
                : { "data-blame-sha": commit.sha },
            }).range(line.from),
          );
```

  Remove the old `const lineNum = i + 1;` line further down so it is not declared twice.

- In the `pingEditor` `$effect`, add `void focusLine;`.
- In `onHostClick`, as its first line, add `focusLine = null;`.
- In the `<style>` block, next to the existing `blame-selected` rule, add:

```css
  :global(.cm-line.blame-focus) {
    box-shadow: inset 3px 0 0 var(--accent);
    background: color-mix(in srgb, var(--accent) 14%, transparent);
  }
```

- [ ] **Step 4: Popover — drill target and ↶**

- Add a helper next to `selectCommit`:

```ts
  /// Line `lineNum`'s number in its commit's version of the file.
  function origLine(lineNum: number): number {
    return blameData?.line_orig[lineNum - 1] ?? lineNum;
  }
```

- Change `renderPopover(dom: HTMLElement, commit: BlameCommit)` to `renderPopover(dom: HTMLElement, commit: BlameCommit, lineNum: number)`. In `paintTooltipDom`, call it as `renderPopover(dom, blameData.commits[idx], lineNum);`.
- In `renderPopover`, change the View button's click handler to:

```ts
      viewBtn.addEventListener("click", () => {
        // §13.8: drill into the commit in the same repo the blame was run on,
        // opening this file (under its path then) at this line.
        void pushAndDrillToCommit(commit.sha, appState.blameTarget?.repoIdx, {
          path: commit.filename,
          line: origLine(lineNum),
        });
      });
      actions.appendChild(viewBtn);

      const beforeBtn = document.createElement("button");
      beforeBtn.type = "button";
      beforeBtn.className = "blame-before";
      beforeBtn.textContent = "↶ Blame before this";
      if (commit.previous) {
        beforeBtn.title = "Blame this file as it was before this commit";
        beforeBtn.addEventListener("click", () => {
          void blameBefore(commit, origLine(lineNum));
        });
      } else {
        beforeBtn.disabled = true;
        beforeBtn.title = "this commit added the file";
      }
      actions.appendChild(beforeBtn);
```

  The existing `actions.appendChild(viewBtn);` is replaced by the one above. Do not append the button twice.

- Styles, next to `.blame-popover .blame-view`:

```css
  :global(.blame-popover .blame-before) {
    border: none;
    background: transparent;
    color: var(--accent);
    font-size: 11px;
    padding: 2px 4px;
    cursor: pointer;
  }
  :global(.blame-popover .blame-before:hover:not(:disabled)) {
    text-decoration: underline;
  }
  :global(.blame-popover .blame-before:disabled) {
    color: var(--muted);
    cursor: default;
  }
```

- [ ] **Step 5: Commit rows — drill target and ↶**

Replace the row's `{#if c.sha !== "00000000"} … {/if}` block (the `→` button) with:

```svelte
            {#if c.sha !== "00000000"}
              <button
                type="button"
                class="drill"
                disabled={!c.previous}
                title={c.previous
                  ? "Blame this file as it was before this commit"
                  : "this commit added the file"}
                onclick={() => void blameBefore(c, origLine(c.firstLine))}
              >
                ↶
              </button>
              <button
                type="button"
                class="drill"
                title="View this commit's changes"
                onclick={() =>
                  void pushAndDrillToCommit(c.sha, appState.blameTarget?.repoIdx, {
                    path: c.filename,
                    line: origLine(c.firstLine),
                  })}
              >
                →
              </button>
            {/if}
```

Add next to `.drill:hover`:

```css
  .drill:disabled {
    color: var(--muted);
    cursor: default;
  }
```

Change the commit panel header's `<span>Commits</span>` to:

```svelte
      <span>Commits{#if activeRev} · at {activeRev.rev.slice(0, 8)}{/if}</span>
```

- [ ] **Step 6: The revision bar**

Right after the editor pane's `</header>` (before `{#if !appState.blameTarget}`), add:

```svelte
    {#if activeRev}
      <div class="rev-bar">
        <button type="button" onclick={popHistory} title="Back (Esc)">← Back</button>
        <span class="rev-what">
          Blame at <code>{activeRev.rev.slice(0, 8)}</code> — before
          <code>{activeRev.before.sha}</code>
          <span class="rev-subject">{activeRev.before.summary}</span>
          {#if activeRev.path !== activeRev.target.path}
            <span class="rev-as">as <code>{activeRev.path}</code></span>
          {/if}
        </span>
        <button type="button" onclick={backToHead}>Back to HEAD</button>
      </div>
    {/if}
```

Styles:

```css
  .rev-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 10px;
    border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--accent) 8%, var(--bar-bg));
    font-size: 0.82em;
    min-width: 0;
  }
  .rev-bar button {
    flex-shrink: 0;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--input-bg);
    color: inherit;
    cursor: pointer;
    padding: 1px 8px;
    font: inherit;
  }
  .rev-bar button:hover {
    background: var(--hover);
  }
  .rev-what {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rev-what code {
    font-family: var(--mono);
  }
  .rev-subject,
  .rev-as {
    color: var(--muted);
  }
```

- [ ] **Step 7: README**

In `README.md` section 4:
- Under "라인 호버 시 팝오버", add the following after the `View commit →` bullet:

```markdown
    - `↶ Blame before this` 클릭 → 그 커밋의 **부모 시점**으로 같은 파일을 다시 blame (그 커밋이 바꾸기 전 줄로 스크롤). 파일 이름이 바뀐 커밋도 옛 경로로 따라갑니다. 파일을 만든 커밋은 비활성.
```

- Under "커밋 패널 (우측)", replace the `→ 버튼` bullet with:

```markdown
- **`↶` / `→` 버튼** (호버 시 노출) → 그 커밋 이전 시점으로 blame / 그 커밋으로 drill-in.
- 이전 시점 blame 중에는 에디터 위 띠에 `Blame at <sha> — before <sha> <제목>` 과 **← Back** · **Back to HEAD** 가 표시되고, 커밋 패널 제목이 `Commits · at <sha>` 로 바뀝니다. `Esc` 도 한 단계씩 되돌아갑니다.
```

Replace section 5's first paragraph and bullets up to "히스토리는 **세션 한정**" with:

```markdown
Blame 팝오버 또는 커밋 패널에서 **View commit →** / **`→`** 를 클릭하면 메인 화면이 그 커밋의 **커밋 보기**로 일시 전환됩니다 (첫 부모 대비 diff, 첫 커밋은 빈 트리 대비).

- 툴바 두 번째 줄: **← Back** · `Commit <sha> ⧉` (클릭 시 전체 SHA 복사) · submodule이면 repo 이름 · `from blame of <파일>`.
- 커밋 표 자리에 **커밋 카드**: 제목, 작성자·날짜·부모·파일 수, 본문 (6줄 넘으면 `Show full message ▾` 로 접힘). merge 커밋은 `merge · N parents · diff against the first parent`.
- Files 헤더는 `Commit <sha> · N files`, diff 라벨은 `before` / `after`.
- blame하던 파일이 그 커밋 시점 경로로 선택되고, 보던 줄로 스크롤됩니다.
- 커밋 보기 안에서 다른 범위로 옮기면 평소 Branch 화면으로 돌아갑니다.
- **무한 깊이**: drill-in 안에서 또 blame을 켜서 또 drill 가능 (history stack 누적).
- **돌아가기**: **`Esc`** 키 또는 툴바의 **← Back**. 직전에 보던 파일까지 그 repo에서 복원됩니다.
```

Keep the existing "히스토리는 **세션 한정**" bullet.

- [ ] **Step 8: Check and tests**

Run: `npm run check`, then `npm test`, then `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: 0 errors; all PASS.

- [ ] **Step 9: Verify by hand**

Run `npm run tauri dev` in an external terminal.

1. **Drill:** On `studio-docs`, blame `knowledge/INDEX.md` and hover line 6. Press `View commit →`. The commit view opens with `INDEX.md` selected and the after side scrolled to the line. The toolbar's `from blame of knowledge/INDEX.md` now names the path.
2. **Message:** `Show full message ▾` folds and unfolds a long body. `⧉` copies the full SHA.
3. **Back:** `Esc` returns to Blame on the same file.
4. **Blame before this:** `↶ Blame before this` on a line loads the parent:
   - the bar names both commits;
   - the line is centred and marked;
   - `Commits · at <sha>` shows;
   - `↶` again steps further back;
   - `Back to HEAD` returns to HEAD;
   - `Esc` steps back one at a time.
5. **Added file:** On a commit that added the file, `↶` is disabled with the tooltip "this commit added the file".
6. **Renamed file:** Pick another file while at a revision: it blames at HEAD. Then Back returns to the older view.
7. **Submodule:** On `C:\workspace\sandbox`, blame a file inside the Plugins submodule and drill. The commit view names `Plugins`; the strip and scope bar are hidden.
8. **Regression:** A drill from an older blame, then `Esc`, returns to that older blame.

- [ ] **Step 10: Commit**

```bash
git add src/lib/blameCache.ts src/lib/ui/BlameView.svelte README.md
git commit -F - <<'EOF'
feat(blame): blame before a commit, and drill to the blamed line

The line popover and each commit row get Blame before this, which
re-blames the file at the commit's parent under its path there, with a
bar to step back or return to HEAD. Drilling in now opens the blamed
file at the blamed line. The blame cache keys on the revision.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```
