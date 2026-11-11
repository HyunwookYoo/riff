# AI review quality and Roblox parity — implementation plan

Spec: `docs/superpowers/specs/2026-11-07-pr-review-mode-design.md`, section
"Review quality and Roblox parity". Branch `feat/ai-review-quality` (from main
ad50953, v2.6.4).

Stack reminders: Tauri 2 + Rust (git CLI), SvelteKit SPA, Svelte 5 runes,
vitest (node env, no DOM), cargo test. Verify every task with `npx vitest run`,
`npm run check` (one pre-existing 'node' types warning is fine) and, for Rust
changes, `cd src-tauri && cargo test`. Commit messages end with
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push. Don't
run the GUI or the claude CLI.

Hard constraint: **no change to the AI read-only guard** (`guard_allows`,
`guard_decision`, `ALLOWED_TOOLS`, `DISALLOWED_TOOLS`, `child_env`, the
claude flags) — the Roblox docs reach the AI as prompt text that riff reads.

## Task 1 — Sharper find/verify (TS only)

Files: `src/lib/review/ai/{prompts.ts,result.ts,types.ts,aiStore.ts,job.ts}`,
new `src/lib/review/ai/diffTrim.ts`, tests beside them,
`src/lib/ui/review/InlineFinding.svelte`, `UnconfirmedList.svelte`.

1. `diffTrim.ts`: `trimDiff(diff: string): { diff: string; omitted: string[] }`.
   Split on `diff --git ` section starts; drop a section when its b-path (or
   a-path for deletions) has an asset extension (case-insensitive: `.uasset
   .umap .uexp .ubulk .fbx .png .tga .psd .wav .mp3 .bin`) or the section has
   a `Binary files ` line / `GIT binary patch`. `omitted` = dropped paths in
   order. Tests: mixed diff, rename, deletion, binary marker, no sections.
2. `FIND_SCHEMA` findings gain required `failureScenario: string`.
   `normalizeFind` drops a finding whose trimmed `failureScenario` is empty
   and keeps it on the candidate. `AiFinding` gains optional
   `failureScenario?: string` (old records stay valid; extend `isAiResult` in
   aiStore.ts to accept a string or absent). `Candidate` in prompts.ts gains
   it too, so the verify pass sees it.
3. `findPrompt`:
   - takes `omitted: string[]`; uses the trimmed diff; when omitted is
     non-empty adds "N asset/binary files were left out of the diff: …" (cap
     the list at 50 paths, then "and K more").
   - new rules (plain English, in the instruction part, not the untrusted
     section): the PR description's stated intent is the baseline — report
     cases where the change does not achieve it; every class/function the
     author asks reviewers to look at must be examined; report problems only
     on changed lines, but read callers, headers and surrounding code before
     claiming; every finding needs a `failureScenario` (a concrete input or
     state and the wrong result); if you cannot write one, do not report it.
4. `verifyPrompt`: tell the verifier to check that the `failureScenario` can
   actually happen; refute if it cannot.
5. `job.ts runJob`: apply `trimDiff` before `findPrompt`.
6. UI: in `InlineFinding.svelte` and `UnconfirmedList.svelte`, when the
   finding has `failureScenario`, show it under the body as a muted line
   "Failure scenario: …". It is not added to the draft body.

Tests: diffTrim; normalizeFind drops empty scenario and keeps it; prompts
contain the new rules and omitted note; aiStore accepts with/without the
field and rejects a non-string; job passes the trimmed diff.

## Task 2 — Repo review rules from `.claude/skills` (Rust + TS)

1. Rust: git trait method `tree_paths(path, rev, prefix) -> Vec<String>`:
   `git ls-tree -r --name-only <rev> -- <prefix>` via the existing non-network
   runner; validate rev like other read commands; prefix must be a
   repo-relative path without `..`. Tauri command `tree_paths`; wrapper in
   `src/lib/review/gh.ts` (or wherever `readFileAt` lives). Test with a temp
   repo.
2. TS `src/lib/review/ai/repoRules.ts`:
   - `parseSkillFrontmatter(text): { name: string; description: string } | null`
     (YAML-ish `---` block, `name:` and `description:` single-line or quoted;
     tolerate CRLF; null when missing).
   - `repoRules(d, repoPath, mergeBase): Promise<RepoRule[]>` with
     `RepoRule = { path, name, description }`: list `.claude/skills`, keep
     `*/SKILL.md` one level deep, read each at mergeBase, parse, cap at 40
     skills and 400 chars per description; any failure → `[]` for that skill
     (missing dir → `[]`).
3. `findPrompt` and `verifyPrompt` take `rules: RepoRule[]`; when non-empty
   add a section "Repository review rules (from the base branch, at
   mergeBase): read the ones that apply with `git show <mergeBase>:<path>` and
   hold the change to them" listing `- <path> — <name>: <description>`.
   Place it outside the untrusted section (same trust as CLAUDE.md).
4. `JobDeps` gains `treePaths`; `runJob` computes rules once and passes them
   to both passes. Re-review (`rereview.ts`) is unchanged.

Tests: frontmatter parser cases; repoRules with fake deps (caps, failures,
nesting); prompts include/omit the section; job wires it.

## Task 3 — Roblox docs clone and per-repo toggle (Rust)

1. New module `src-tauri/src/roblox_docs.rs`, dir
   `<app_data_dir>/roblox-docs.git`:
   - `update(dir) -> Result<DocsInfo, GitError>`: if absent,
     `git clone --bare --depth 1 --single-branch --branch main
     https://github.com/Roblox/creator-docs.git <dir>`; else
     `git -C <dir> fetch --depth 1 --no-tags origin +refs/heads/main:refs/heads/main`.
     Use the same network env/guards as riff's other fetches (no prompts,
     timeouts). Then `info`.
   - `info(dir) -> Result<Option<DocsInfo>, GitError>`: None if absent;
     `DocsInfo { sha, date }` from `rev-parse main` and `log -1 --format=%cI main`.
   - `read_apis(dir, sha, names: &[String]) -> Result<Vec<ApiDoc>, GitError>`
     with `ApiDoc { name, path, text }`: validate sha (hex) and each name
     (`Enum.` prefix allowed, then `^[A-Za-z0-9_]{1,64}$`; invalid names
     skipped); `Enum.X` → `enums/X.yaml`; else first existing of
     `classes/ datatypes/ globals/ libraries/` under
     `content/en-us/reference/engine/` (one `ls-tree` to know what exists);
     max 12 names; cap text at 60 000 chars per file and 150 000 total
     (truncate with a `[truncated]` line); unknown names skipped.
   Tests with a temp bare repo built locally (no network).
2. Commands `roblox_docs_update`, `roblox_docs_info`, `roblox_docs_read`
   (spawn_blocking for network).
3. Persisted toggle: `PersistedState.roblox_parity_repos: Vec<String>`
   (serde default empty), `set_roblox_parity(repo: String, on: bool)`;
   repo key `host/owner/name`, validated (3 non-empty segments of
   `[A-Za-z0-9._-]`). Mirror into `appState.robloxParityRepos` on load like
   `ai_model` (`src/lib/git.ts`, `src/lib/store.svelte.ts`). TS helpers
   `robloxDocsUpdate/Info/Read`, `setRobloxParity`.

## Task 4 — Roblox pass in the job (TS)

Files: `src/lib/review/ai/{job.ts,prompts.ts,result.ts,types.ts,aiStore.ts,
aiState.svelte.ts}`, new `src/lib/review/ai/roblox.ts`.

1. Spec at queue time: `requestJob` gets `roblox: boolean` (from
   `appState.robloxParityRepos` includes `repoKey(pr.repo)`), stored in Spec
   and passed to `runJob` (fixed at queue time like `choice`).
2. When `roblox`: find uses `findSchema(true)` with an extra required
   `robloxApis: string[]` and a prompt line asking for the Roblox APIs whose
   behaviour the change implements or touches (empty if none).
3. After find, if `robloxApis` non-empty: `JobDeps.robloxDocs` (update, then
   read). `update` failure → use `info`; no docs at all → skip the pass and
   record `roblox: { skipped: "Roblox docs not downloaded" }`. Job state pass
   `"roblox"` (extend the `AiJobState` pass union and any label switch).
4. `robloxPrompt` (prompts.ts): same git rules, memory rules, repo rules;
   the docs as "Roblox API reference (from github.com/Roblox/creator-docs at
   <sha>)" fenced per file with its `roblox:<kind>/<Name>.yaml` id; the PR
   title/description/diff stay inside the untrusted section. Instructions:
   compare changed behaviour with the reference; before reporting a
   difference search the project's own docs at head (`git grep -n -i -e
   <api> <head> -- docs`) for a recorded intentional divergence and skip it;
   each finding needs `failureScenario` and an evidence item with path
   `roblox:<kind>/<Name>.yaml` quoting the reference. Schema = find findings
   only.
5. `roblox.ts`: `checkRobloxEvidence(candidate, docs: ApiDoc[]): boolean` —
   true when some evidence with a `roblox:` path names a supplied doc and its
   quote (whitespace-collapsed) is a substring of that doc's
   whitespace-collapsed text. Roblox candidates get `tag: "roblox"`;
   `AiFinding.tag?: "roblox"` (aiStore accepts absent or "roblox").
6. Verify: one pass for find + Roblox candidates; `verifyPrompt` includes the
   reference texts cited by Roblox candidates (same fencing). After
   `mergeVerdicts`, a Roblox finding whose evidence check failed becomes
   `unconfirmed` even if confirmed.
7. `AiResult.roblox?: { docsSha: string; docsDate: string } | { skipped: string }`
   (aiStore validates). `aiBadgeTitle` appends ` · Roblox docs YYYY-MM-DD`
   or ` · Roblox parity skipped: <reason>`.

Tests: schema variant; job runs three passes only when roblox and apis
non-empty; skip path; evidence check (match, whitespace, wrong file, missing);
downgrade to unconfirmed; badge title; store validation.

## Task 5 — UI

1. `AiRunMenu.svelte`: optional `repo?: GhRepo` prop; when given (the AI
   review ▾, not Re-review) show a checkbox "Roblox parity for owner/name"
   bound to `appState.robloxParityRepos`, saved immediately via
   `setRobloxParity` (catch and show an error line on rejection). Note text
   stays "This run only" for model/effort; the checkbox reads "(saved for
   this repo)".
2. `AiSettings.svelte`: a "Roblox docs" row: date of the local copy or "not
   downloaded", and an **Update now** button (busy state, error line).
3. `Roblox` tag (same style as the Unconfirmed tag) on `InlineFinding`, the
   AI findings list rows in `ReviewFiles.svelte` and `UnconfirmedList`.
4. Running label for pass `"roblox"` wherever find/verify labels are shown.

Verify with vitest/check; GUI checks are left to the user.
