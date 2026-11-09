# PR Review Mode — Plan 2: AI Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the user's request per PR, run the local Claude Code CLI read-only against the PR in two passes (find, verify). Show the result as reading-order chapters, inline verified findings and an "Unconfirmed" area. Let the user turn findings into draft comments.

**Architecture:**
- **Rust:** a new `ai` module spawns `claude -p` with a fixed read-only tool allowlist, a strict MCP config that contains only agentmemory, a JSON schema for structured output, and stream-json progress. It streams progress over a Tauri `Channel` and returns the structured output.
- **TypeScript:** a main-window job queue orchestrates the two passes, one job at a time. Pure modules hold the prompts, the result normalization and the finding→draft mapping. Results are cached per PR and head in the existing review store under a separate key.
- **UI:** the PR list gets an AI button and status badges. The left column shows chapters and an Unconfirmed area. Findings appear as inline widgets.

**Tech Stack:** Tauri 2 (+ `tauri-plugin-notification`), Rust, Svelte 5 runes, TypeScript, CodeMirror 6, vitest, Claude Code CLI 2.1.x (`claude -p`).

**Spec:** `docs/superpowers/specs/2026-11-07-pr-review-mode-design.md`. The sections that apply are "AI analysis", "Mapping findings to GitHub comments", "Layout", "PR list" badges and "Persistence". This plan builds on plan 1 (`docs/superpowers/plans/2026-11-07-pr-review-foundation.md`), which is implemented on branch `feat/pr-review`.

## Global Constraints

- AI runs **only on the user's request** per PR. There are no automatic runs.
- Jobs queue and run **one at a time**. A queued or running job can be cancelled.
- **Read-only toward the repo.** The AI may run only read-only git commands: `git show`, `git grep`, `git log`, `git ls-tree`, `git cat-file`, `git merge-base`, `git rev-parse`. It reads from git objects at the PR head, never from the working tree. It has no Read, Grep, Glob, Edit, Write, WebFetch or other shell tools. This is enforced by CLI flags (`--tools`, `--allowedTools`, `--disallowedTools`, `--permission-mode dontAsk`), not by prompt wording alone.
- **Loaded:** the user's global and repo `CLAUDE.md`, settings and hooks, and the agentmemory MCP server only. **Blocked:** every other MCP server, via `--strict-mcp-config` with a generated config that lists agentmemory only.
- **Every finding shown as a finding passed the verify pass and carries evidence.**
  - Refuted findings are dropped.
  - A finding without evidence is treated as refuted.
  - Unconfirmed findings appear only in the "Unconfirmed (N)" area.
- Nothing reaches GitHub from the AI. Findings become draft items only on the user's Add or Edit.
- Draft comment bodies are written in the language of the PR description, as normal prose addressed to the PR author.
- Style, naming and taste comments are not findings.
- Results are cached per PR and head SHA, so reopening a PR does not re-run. A moved head marks the result stale and offers re-analyse.
- OS notification text: `AI review ready — #<N> <title> — <K> findings`.

## Review Focus

1. **The CLI read-only guard actually holds.** `git diff --output=x`, `git show HEAD > f`, `git grep -O`, `git -c core.pager=… log`, `cat file`, `Write` and `mcp__slack__*` must all be denied, while `git show <head>:<path>` and `git grep -n foo <head>` work. Pinned by the Task 1 probe script `scripts/ai-guard-probe.mjs`, run once against the real CLI.
2. **The model returns malformed or partial JSON, or no structured output.** The job fails with a message. Nothing is cached and nothing is shown as findings. Pinned by Task 3 `normalizeFind rejects …` tests and Task 1 `parse_result_without_structured_output_is_error`.
3. **Findings point at paths or lines that don't exist in the PR, or at the wrong side.** These are placed as file-level or review-body comments, or dropped when the path is unknown. They never become an inline comment on a non-commentable line. Pinned by Task 3 `placeFinding` tests.
4. **The head moves or the user switches PR while a job runs.** The result is stored against the head it analysed and shown as stale for the new head. It never lands on another PR's state. Pinned by Task 4 `job result is stored under its own key and head` and `stale result is flagged` tests.
5. **`claude` is not installed, not logged in, or the run is cancelled.** The job ends in a clear error state, the queue moves on, and no orphaned process remains after Cancel. Pinned by Task 1 `resolve_claude` tests and Task 4 `cancel stops the running job and starts the next` test.

---

## File Structure

- `src-tauri/src/ai/mod.rs` (create): CLI resolution, args, MCP config, stream parsing, run with cancel.
- `src-tauri/src/lib.rs` (modify): commands `ai_run`, `cancel_ai_run`; notification plugin.
- `src-tauri/Cargo.toml`, `package.json`, `src-tauri/capabilities/default.json` (modify): `tauri-plugin-notification`.
- `scripts/ai-guard-probe.mjs` (create): one-off verification of the guard against the real CLI.
- `src/lib/review/ai/types.ts`: AI types (below).
- `src/lib/review/ai/prompts.ts`: prompt builders and JSON schemas.
- `src/lib/review/ai/result.ts`: normalize find/verify output, build `AiResult`, `placeFinding`, finding → draft target.
- `src/lib/review/ai/aiStore.ts`: load/save `AiResult` under key `${prKey}@ai`.
- `src/lib/review/ai/queue.ts`: pure queue logic (enqueue, cancel, next).
- `src/lib/review/ai/aiState.svelte.ts`: rune state and job runner wiring (thin).
- `src/lib/review/ai/run.ts`: `ai_run` invoke wrapper.
- UI `src/lib/ui/review/`: `AiButton.svelte` (list row button and badge), `ChapterList.svelte`, `ChapterIntent.svelte`, `InlineFinding.svelte`, `UnconfirmedList.svelte`. Modify `PrList.svelte`, `ReviewFiles.svelte`, `ReviewView.svelte` (`itemsFor`).

### AI types (`src/lib/review/ai/types.ts`, defined in Task 3)

```ts
import type { PrKey, Side } from "../types";
export type Severity = "high" | "medium" | "low";
export interface AiEvidence { path: string; line: number | null; quote: string }
export interface AiChapter { title: string; summary: string; paths: string[] }
export interface AiFinding {
  id: string;                 // stable within a result: `f${index}`
  path: string; side: Side; line: number; startLine: number | null;
  severity: Severity; body: string; evidence: AiEvidence[];
  status: "confirmed" | "unconfirmed";
  quote: string[];            // lines startLine..line of `side` at the analysed head/merge-base, filled by riff
}
export interface AiResult {
  version: 1; key: PrKey; headSha: string; baseSha: string; mergeBase: string;
  createdAt: string; chapters: AiChapter[]; findings: AiFinding[];
  handled: Record<string, "added" | "discarded">;   // finding id → what the user did
}
export type AiJobState =
  | { kind: "queued" }
  | { kind: "running"; pass: "find" | "verify"; startedAt: number; lastActivity: string | null }
  | { kind: "done" }
  | { kind: "failed"; message: string };
```

---

### Task 1: Claude CLI runner (Rust) and guard verification

**Files:**
- Create: `src-tauri/src/ai/mod.rs`, `scripts/ai-guard-probe.mjs`
- Modify: `src-tauri/src/lib.rs` (`pub mod ai;`, commands, managed cancel state like `RebaseChecks`)

**Interfaces:**
- Produces (Rust):
  - `fn resolve_claude(path_var: Option<&OsStr>, home: Option<&Path>, exists: &dyn Fn(&Path) -> bool) -> Option<PathBuf>`. It checks absolute PATH entries for `claude.exe`, then `<home>/.local/bin/claude.exe`.
  - `fn agentmemory_mcp_config(claude_json: &serde_json::Value) -> serde_json::Value`. It returns `{"mcpServers":{"agentmemory":<entry>}}` when `mcpServers.agentmemory` exists, else `{"mcpServers":{}}`.
  - `fn claude_args(schema_json: &str, mcp_config_path: &Path, model: Option<&str>) -> Vec<String>`. It returns exactly:
    - `-p --output-format stream-json --verbose --no-session-persistence`
    - `--json-schema <schema_json>`
    - `--tools Bash`
    - `--allowedTools` with `Bash(git show:*) Bash(git grep:*) Bash(git log:*) Bash(git ls-tree:*) Bash(git cat-file:*) Bash(git merge-base:*) Bash(git rev-parse:*) mcp__agentmemory__memory_recall mcp__agentmemory__memory_smart_search mcp__agentmemory__memory_save`
    - `--disallowedTools` with `Bash(*--output*) Bash(*--open-files-in-pager*) Bash(* -O*) Bash(*>*) Bash(*|*) Bash(*;*) Bash(*&*) Bash(*$(*) Bash(*\`*)`
    - `--permission-mode dontAsk --strict-mcp-config --mcp-config <path>`
    - `--model <m>` only when `model` is Some.
  - `enum AiEvent { Activity { text: String }, Result { output: serde_json::Value, cost_usd: Option<f64> } }` and `fn parse_stream_line(line: &str) -> Option<AiEvent>`:
    - `type:"assistant"` messages with `tool_use` content give `Activity` (`"<tool>: <first 80 chars of input.command or name>"`).
    - `type:"result"` with `subtype:"success"` and `structured_output` gives `Result`.
    - `type:"result"` without `structured_output`, or with any other subtype, gives `Result { output: Value::Null, .. }`, which the caller turns into an error.
  - `fn run(cwd: &Path, prompt: &str, schema_json: &str, model: Option<&str>, on_event: &mut dyn FnMut(AiEvent), cancelled: &dyn Fn() -> bool) -> Result<serde_json::Value, AiError>`.
    - It writes the MCP config to a temp file (`std::env::temp_dir()/riff-ai-mcp-<pid>-<n>.json`) built from `~/.claude.json`, and deletes it afterwards.
    - The prompt goes on stdin. The process gets CREATE_NO_WINDOW. stdout and stderr are read on threads (same pattern as `github::login`).
    - Cancel kills the child.
    - Errors: `AiError::NotInstalled`, `Cancelled`, `Failed(String)` (last 3 stderr lines, or "no structured output").
  - Tauri commands `ai_run(path: String, prompt: String, schema: String, model: Option<String>, id: u32, on_event: Channel<AiEvent>) -> Result<Value, AiError>` (async, via `tauri::async_runtime::spawn_blocking`) and `cancel_ai_run(id: u32)`.
- TS: `src/lib/review/ai/run.ts` exports `aiRun(path, prompt, schema: object, onActivity: (t: string) => void): { done: Promise<unknown>; cancel: () => void }`, following `ghLogin` in `gh.ts`.

- [ ] **Step 1: Write the failing tests** in `ai/mod.rs`:
  - `resolve_claude_prefers_absolute_path_then_local_bin`
  - `agentmemory_config_keeps_only_agentmemory` (input has `agentmemory` and `slack`; output has only `agentmemory`)
  - `agentmemory_config_empty_when_missing`
  - `claude_args_exact` (asserts the full vector for a fixed schema and path, without `--model`, and with `--model sonnet`)
  - `parse_tool_use_line_is_activity`
  - `parse_success_result_returns_structured_output`
  - `parse_result_without_structured_output_is_error` (`Result { output: Null }`)
  - `parse_noise_is_none`

  Use real stream-json lines captured in Step 3 as fixtures; write the tests after capturing if needed, but before the parser.
- [ ] **Step 2: Run** `cd src-tauri && cargo test ai::`. Expected: FAIL (module missing).
- [ ] **Step 3: Capture real sample lines (one cheap run).** Run `echo "Reply with {\"ok\":true}" | claude -p --output-format stream-json --verbose --json-schema '{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]}' --model haiku --no-session-persistence --tools "" > sample.jsonl`. Copy one `assistant` line and the `result` line into the tests as fixtures, trimmed. If the CLI spells a field differently (for example `structured_output`), adapt the parser and note it in the report.
- [ ] **Step 4: Implement** everything above.
- [ ] **Step 5: Run** `cargo test`. Expected: all pass.
- [ ] **Step 6: Write `scripts/ai-guard-probe.mjs`.** It runs `claude` with exactly `claude_args` (mirror the vector), cwd = this repo, `--model haiku`, once per probe prompt. Each prompt says: "Run exactly this shell command and report its exit status and first output line: `<cmd>`". It then checks the repo for side effects.
  - Probe commands:
    - `git diff --output=PROBE_OUT HEAD~1 HEAD`
    - `git show HEAD > PROBE_OUT`
    - `git grep -O foo HEAD`
    - `git -c core.pager=cat log -1`
    - `cat package.json`
    - `git show HEAD:package.json`
    - `git grep -n riff HEAD -- package.json`
  - Also one prompt asking it to use the Write tool to create `PROBE_OUT`.
  - The script asserts that `PROBE_OUT` never exists, that `git status --porcelain` is unchanged, and that the last two git reads succeed (the stream shows a successful tool result). Exit non-zero on any violation.
- [ ] **Step 7: Run** `node scripts/ai-guard-probe.mjs`. Expected: `guard OK` (about 9 haiku runs). If a write gets through, tighten `--disallowedTools` / `--allowedTools` until it passes, update `claude_args_exact`, and record the final lists in the report.
- [ ] **Step 8: Commit** `feat(ai): run Claude Code read-only with a strict tool and MCP allowlist`.

---

### Task 2: Notification plugin

**Files:**
- Modify: `src-tauri/Cargo.toml` (`tauri-plugin-notification = "2"`), `src-tauri/src/lib.rs` (`.plugin(tauri_plugin_notification::init())`), `package.json` (`@tauri-apps/plugin-notification`), `src-tauri/capabilities/default.json` (`notification:default`)
- Create: `src/lib/review/ai/notify.ts`
- Test: `src/lib/review/ai/notify.test.ts`

**Interfaces:**
- Produces:
  - `notificationText(number: number, title: string, findings: number): { title: string; body: string }`. It returns `{ title: "AI review ready", body: \`#${number} ${title} — ${findings} findings\` }`.
  - `notifyReady(...)`. It requests permission once (`isPermissionGranted` / `requestPermission`) and calls `sendNotification`; failures are swallowed.

- [ ] **Step 1: Write the failing test.** `notificationText(1888, "Fix nil", 3)` gives `{title:"AI review ready", body:"#1888 Fix nil — 3 findings"}`.
- [ ] **Step 2: Run** `npx vitest run src/lib/review/ai/notify.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, then run `npm install` and `cargo build`.
- [ ] **Step 4: Run** tests, `npm run check` and `cargo build`. Expected: pass.
- [ ] **Step 5: Commit** `feat(ai): OS notification when an AI review is ready`.

---

### Task 3: Prompts, schemas and result normalization (pure)

**Files:**
- Create: `src/lib/review/ai/types.ts` (as above), `src/lib/review/ai/prompts.ts`, `src/lib/review/ai/result.ts`
- Test: `src/lib/review/ai/prompts.test.ts`, `src/lib/review/ai/result.test.ts`

**Interfaces:**
- Consumes: `FileHunks`, `PrDetail`, `PrSummary`, `Side` (plan 1 `types.ts`); `placeTarget(path, side, line, startLine, files)` and `isCommentable` (`commentable.ts`).
- Produces:
  - `FIND_SCHEMA: object`, a JSON Schema with these properties, all required:
    - `chapters: [{title: string, summary: string, paths: string[]}]`
    - `findings: [{path, side ∈ LEFT|RIGHT, line: integer ≥ 1, startLine: integer|null, severity ∈ high|medium|low, body: string, evidence: [{path, line: integer|null, quote: string}]}]`
  - `VERIFY_SCHEMA: object` with `verdicts: [{index: integer, verdict ∈ confirmed|refuted|unconfirmed, reason: string, evidence: [...same...]}]`.
  - `findPrompt(a: { repoPath: string; pr: PrSummary; detail: PrDetail; commits: string[]; mergeBase: string; head: string; diff: string }): string`. The prompt contains:
    - the PR title, body and commit subjects;
    - `mergeBase` and `head` SHAs, and the unified diff (the caller passes `git diff <mergeBase> <head>` text, truncated to 200 000 chars with a `[diff truncated]` marker);
    - these rules, verbatim from the spec:
      - read code only with `git show <head>:<path>`, `git grep -n <pattern> <head>`, `git log`, `git ls-tree`, `git cat-file`;
      - never modify anything;
      - chapters: ordered groups of changed files with a 1–2 sentence intent summary, every changed file in exactly one chapter;
      - findings: potential bugs or breakage caused by the change, each with evidence (locations read and quoted lines); no style, naming or taste comments;
      - each finding body is a draft comment to the PR author, in the language of the PR description, as normal prose;
      - LEFT = old side (lines at mergeBase), RIGHT = new side (lines at head).
  - `verifyPrompt(a: { repoPath; head; mergeBase; candidates: { index: number; path; side; line; startLine; severity; body; evidence }[] }): string`. It tells the model to try to refute each candidate by reading the cited code and anything else it needs; answers are `confirmed`, `refuted` or `unconfirmed` with evidence; a candidate without evidence is refuted.
  - `normalizeFind(raw: unknown, files: FileHunks[]): { chapters: AiChapter[]; candidates: Omit<AiFinding, "id" | "status" | "quote">[] }`. It throws `Error("ai-malformed: …")` when the shape doesn't match.
    - Chapters: unknown paths are dropped; a path listed twice keeps its first chapter; changed files missing from every chapter are appended as a final chapter `{title:"Other", summary:"", paths}`; empty chapters are dropped.
    - Candidates: entries with no evidence are dropped; entries whose `path` is not in the PR, and whose evidence is also not in the PR, are dropped.
  - `mergeVerdicts(candidates, raw: unknown): AiFinding[]`. Confirmed findings get `status:"confirmed"`, unconfirmed get `"unconfirmed"`, refuted ones and those with no verdict are dropped. A verdict's evidence is appended to the finding's evidence. Ids are `f0, f1, …` in candidate order. `quote` is `[]`, filled later.
  - `fillQuotes(findings, texts: Map<"path|side", string>): AiFinding[]`. It sets `quote` to the lines `startLine..line` (1-based) of that side's text; a finding whose path/side text is missing or whose line is out of range is dropped.
  - `placeFinding(f: AiFinding, files: FileHunks[]): DraftTarget`:
    - commentable → `{kind:"line", path, side, line, startLine, quote}`;
    - file in the PR → `{kind:"file", path, location: \`${path}:${line}\`}`;
    - otherwise → `{kind:"body", location: \`${path}:${line}\`}`.
  - `chapterOf(result: AiResult, path: string): AiChapter | null`.

- [ ] **Step 1: Write the failing tests:**
  - `findPrompt includes shas, diff and the read-only rules`
  - `findPrompt truncates a huge diff with a marker`
  - `normalizeFind rejects a non-object` / `rejects missing chapters`
  - `normalizeFind drops unknown paths and duplicates, appends Other`
  - `normalizeFind drops candidates without evidence`
  - `mergeVerdicts keeps confirmed and unconfirmed, drops refuted and missing`
  - `fillQuotes takes the range lines and drops out-of-range`
  - `placeFinding returns line / file / body` (three cases)
  - `chapterOf finds the chapter for a path`
- [ ] **Step 2: Run** `npx vitest run src/lib/review/ai`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(ai): prompts, schemas and result normalization`.

---

### Task 4: Job queue, cache and orchestration

**Files:**
- Create: `src/lib/review/ai/queue.ts`, `src/lib/review/ai/aiStore.ts`, `src/lib/review/ai/job.ts`, `src/lib/review/ai/aiState.svelte.ts`
- Modify: `src-tauri/src/git/cli.rs` + `lib.rs` + `src/lib/review/gh.ts` (add `pr_diff_text(path, merge_base, head) -> String` = `git -c core.quotePath=false diff --no-color --no-ext-diff -M <mb> <head>`, and `pr_commit_subjects(path, merge_base, head) -> Vec<String>` = `git log --format=%s <mb>..<head>`; Rust tests with the existing fixtures)
- Test: `src/lib/review/ai/queue.test.ts`, `src/lib/review/ai/job.test.ts`, `src/lib/review/ai/aiStore.test.ts`

**Interfaces:**
- Consumes: Task 1 `aiRun`; Task 3 functions; plan 1 `prHunks`, `fetchPr`, `prDetail`, `readFileAt`, `loadReview` / `saveReview` (`gh.ts`).
- Produces:
  - `aiKey(prKey) => \`${prKey}@ai\``; `loadAiResult(prKey): Promise<AiResult | null>` (invalid → null; never throws on shape); `saveAiResult(r: AiResult): Promise<void>`.
  - `queue.ts` (pure):
    - `type Queue = { running: PrKey | null; waiting: PrKey[] }`
    - `enqueue(q, key)` is a no-op if the key is already running or waiting.
    - `cancel(q, key) → { q; killRunning: boolean }`
    - `finish(q) → { q; next: PrKey | null }`
  - `job.ts`: `runJob(deps: JobDeps, pr: PrSummary, repoPath: string, onState: (s: AiJobState) => void): Promise<AiResult>`. `JobDeps` injects `fetchPr`, `prDetail`, `prHunks`, `prDiffText`, `prCommitSubjects`, `readFileAt`, `aiRun` and `now`. Steps:
    1. fetch;
    2. `detail.headSha` → head, `detail.baseSha` → base;
    3. hunks/mergeBase;
    4. diff and commits;
    5. find pass;
    6. `normalizeFind`;
    7. verify pass (skipped when there are no candidates);
    8. `mergeVerdicts`;
    9. read texts at head (RIGHT) and mergeBase (LEFT) for finding paths;
    10. `fillQuotes`;
    11. return `AiResult` with `handled: {}`, `createdAt: new Date(now()).toISOString()`.
  - `aiState.svelte.ts`:
    - `aiState` with `jobs: Record<PrKey, AiJobState>` and `results: Record<PrKey, AiResult | null>` (loaded lazily);
    - `requestAi(pr)`, `cancelAi(key)`, `loadResultFor(key)`;
    - `isStale(result, headSha)` → `result.headSha !== headSha`.
  - The runner saves each result under its own `pr.key` with the head it analysed, sends `notifyReady`, then starts the next job.

- [ ] **Step 1: Write the failing tests:**
  - queue: `enqueue twice is a no-op`, `cancel waiting removes it`, `cancel running kills and finish starts next`.
  - job (all deps mocked): `job runs find then verify and returns confirmed+unconfirmed`, `job skips verify when no candidates`, `job uses detail head and base, not the summary's`, `job result is stored under its own key and head`, `malformed find output fails the job and stores nothing`.
  - aiStore: `invalid stored result loads as null`.
  - aiState helper: `stale result is flagged` (`isStale`).
  - Rust: `pr_diff_text_matches_git_diff` and `pr_commit_subjects_lists_range`.
- [ ] **Step 2: Run** `npx vitest run src/lib/review/ai` and `cargo test pr_diff_text pr_commit_subjects`. Expected: FAIL.
- [ ] **Step 3: Implement.** The runner in `aiState.svelte.ts` holds the active `aiRun` cancel handle. On `cancelAi` of the running key it calls cancel, marks the job `failed: "Cancelled"`, and calls `finish`.
- [ ] **Step 4: Add the test** `cancel stops the running job and starts the next`, using `queue` + a mocked `runJob` in a plain `.ts` helper (`startNext(deps)`) that the rune file wraps.
- [ ] **Step 5: Run** all tests, `npm run check` and `cargo test`. Expected: pass.
- [ ] **Step 6: Commit** `feat(ai): one-at-a-time AI review queue with cached results`.

---

### Task 5: PR list — AI button and badges

**Files:**
- Create: `src/lib/ui/review/AiButton.svelte`
- Modify: `src/lib/ui/review/PrList.svelte`, `src/lib/review/ai/aiState.svelte.ts` (badge helper)
- Test: `src/lib/review/ai/badge.test.ts`

**Interfaces:**
- Produces: `aiBadge(job: AiJobState | undefined, result: AiResult | null | undefined, headSha: string, nowMs: number): { text: string; kind: "none" | "queued" | "running" | "ready" | "stale" | "failed" }`:
  - no job and no result → `{text:"", kind:"none"}`;
  - queued → `"queued"`;
  - running → `"analysing m:ss"`;
  - failed → `"AI failed"`;
  - a result for this head → `"AI ready · ⚠<K>"` (K = confirmed count not handled);
  - a result for another head → `"PR updated · re-analyse"` (stale).

- [ ] **Step 1: Write the failing tests:** one per branch of `aiBadge`, including `m:ss` formatting for 101 s → `analysing 1:41`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Each PR row gets an "AI review" button: shown as "Re-analyse" when a result exists, "Cancel" while queued or running.
  - The badge sits next to it. Clicking the button doesn't select the row.
  - A failed badge shows the message as a tooltip.
  - Results are loaded lazily for listed PRs (`loadResultFor`).
- [ ] **Step 4: Run** tests and `npm run check`. Expected: pass.
- [ ] **Step 5: Commit** `feat(ai): request, cancel and track AI reviews from the PR list`.

---

### Task 6: Chapters, intent, inline findings, Unconfirmed

**Files:**
- Create: `src/lib/ui/review/ChapterList.svelte`, `ChapterIntent.svelte`, `InlineFinding.svelte`, `UnconfirmedList.svelte`
- Modify: `src/lib/ui/review/ReviewFiles.svelte` (chapters instead of the single "All files" when a result exists), `src/lib/ui/review/ReviewView.svelte` (`itemsFor` adds findings; `ChapterIntent` above the diff), `src/lib/review/ai/result.ts` (`findingsToShow`)
- Test: `src/lib/review/ai/show.test.ts`

**Interfaces:**
- Produces: `findingsToShow(result: AiResult | null, headSha: string, files: FileHunks[], texts?: Map<string,string>): { inline: AiFinding[]; offDiff: AiFinding[]; unconfirmed: AiFinding[]; stale: boolean }`:
  - It excludes handled findings.
  - `inline` holds confirmed findings whose `placeFinding` is `line`. `offDiff` holds confirmed findings placed as `file` or `body`. `unconfirmed` holds the unconfirmed findings.
  - When stale (`result.headSha !== headSha`), line findings are re-placed with `reanchor` (plan 1 `anchor.ts`) against `texts`; ones that can't be placed move to `offDiff`.
- UI behaviour:
  - **ReviewFiles:** with a result, the left column shows chapters in order, each with its title, file rows and a finding count. Without one, it shows "All files" as before. Below come the collapsed `Unconfirmed (N)` (UnconfirmedList), a collapsed `Not on a diff line (N)` for `offDiff`, then the existing `Outdated threads`.
  - **ChapterIntent:** above the diff for the selected file, a banner with the chapter title and summary. A stale result adds "from an older commit · Re-analyse".
  - **InlineFinding:** a severity tag (`high` red, `medium` amber, `low` grey) and the body. Actions:
    - **Add to draft:** `addItem(record, placeFinding(f), f.body, "ai")`, then `handled[f.id]="added"` saved.
    - **Edit:** a textarea, then add with the edited body and origin `"ai-edited"`.
    - **Discard:** `handled[f.id]="discarded"`.
    - **Show evidence:** expands to `path:line` + quote; clicking an entry whose path is in the PR selects that file and reveals that line (reuse the reveal mechanism in `ReviewView`).
    - All actions are disabled while the plan-1 submit lock is active or `reviewState.record` is null.
  - **UnconfirmedList and offDiff entries:** the same actions; Add uses origin `"ai-unconfirmed"` for unconfirmed findings.
  - Uses the existing `textStash` for an Edit in progress (key `ai:<findingId>`).

- [ ] **Step 1: Write the failing tests:**
  - `findingsToShow splits inline / offDiff / unconfirmed`
  - `handled findings are hidden`
  - `stale result re-places by quote and moves unplaceable to offDiff`
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** the helper and components.
- [ ] **Step 4: Run** tests and `npm run check`. Expected: pass.
- [ ] **Step 5: Manual check (user):** run AI review on a real PR, then:
  - chapters appear in the left column;
  - the intent banner shows above the diff;
  - findings appear inline;
  - Add puts the finding in the drafts window with the tag `AI draft`;
  - Unconfirmed shows a grey tag;
  - Show evidence jumps to the cited line.
- [ ] **Step 6: Commit** `feat(ai): chapters, inline findings and the Unconfirmed area`.
