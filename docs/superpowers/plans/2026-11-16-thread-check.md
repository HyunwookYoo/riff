# Thread check — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Re-review with **Check threads**: one AI run that checks the
open point of every thread waiting on the viewer against the code, gives a
checked verdict, and offers a reply draft.

**Architecture:** A new `threadCheck.ts` takes over the re-review job (same
queue, cancel, model menu, PR-only patches). Its verdicts go through
`codeCheck.ts` (generalized) and are stored per thread in `AiResult`. The
thread widget shows them and adds reply drafts with a riff-built appendix of
the checked code.

**Tech Stack:** TypeScript, Svelte 5 runes, vitest (node env, no DOM). No
Rust change.

**Spec:** `docs/superpowers/specs/2026-11-07-pr-review-mode-design.md`,
section "Thread check" (read it first; also "Verified failure paths" and
"Re-review verification").

Branch `feat/thread-check`, created with
`git switch --no-track -c feat/thread-check origin/main` (main 617f927,
v2.8.1). The spec edit is uncommitted on main's working tree; commit it as
the first commit on the branch.

## Global Constraints

- No change to the AI read-only guard (`src-tauri/src/ai/mod.rs`) or any Rust file.
- Nothing is posted or resolved automatically; reply drafts only on Add / Edit.
- Max 30 threads per run, most recently active first (last comment's `createdAt`).
- Verdicts: `holds` / `does_not_hold` / `unclear`; labels `✓ Holds` / `✗ Doesn't hold` / `? Unclear`.
- `raisedBy`: `viewer` / `author` / `other`; when the viewer is the PR author, `author`.
- Trace optional; if given, 2-8 steps, every step must pass, else verdict `unclear`.
- The AI's `reply` carries no line numbers and no quoted code; riff appends the checked code.
- Verify each task with `npx vitest run` and `npm run check` (one pre-existing 'node' types warning is fine).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never push. Don't run the GUI or the claude CLI. No interactive git. Never post to GitHub in tests.

## Review Focus

1. Viewer is the PR author and has a past "review" from replying (v2.8.1
   finding): set 2 (silent fixes) must not apply on the viewer's own PR, or
   their self-notes get checked as concerns. Test in Task 1.
2. The viewer replies after a check: the thread leaves the set, the stored
   check stays and shows "(new replies)", and Add is disabled. Tests in
   Task 2 (merge) and Task 3 (label).
3. The old review commit can't be fetched: set-1 threads must still be
   checked; only the oldHead patches are left out. Test in Task 1.
4. A stored record with only the old `rereview` field (and records with
   `headSha: ""`) keeps loading and showing. Test in Task 2.
5. AI answer with duplicate / unknown thread ids, a missing thread, or a
   `reply` on an `unclear` verdict. Tests in Task 1.

---

### Task 1: Thread selection, prompt, schema and the run

**Files:**
- Create: `src/lib/review/ai/threadCheck.ts`, `src/lib/review/ai/threadCheck.test.ts`
- Modify: `src/lib/review/ai/types.ts`, `src/lib/review/ai/prompts.ts` (export `traceStep`)
- Delete from `src/lib/review/ai/rereview.ts` (and its tests): `REREVIEW_SCHEMA`, `myOpenThreads`, `rereviewAvailable`, `rereviewPrompt`, `normalizeVerdicts`, `runRereview`, `withRereview`. Keep `verdictLabel` and `hasReview`. Move the `location` and `patchBudget` helpers into `threadCheck.ts`.

**Interfaces:**
- Produces (types.ts):
  ```ts
  export type PointVerdict = "holds" | "does_not_hold" | "unclear";
  export type RaisedBy = "viewer" | "author" | "other";
  /** One thread's check. `head`: the PR head it was made at; `lastCommentId`: the thread's last comment then. */
  export interface ThreadCheck {
    threadId: string; point: string; raisedBy: RaisedBy; verdict: PointVerdict;
    reason: string; evidence: AiEvidence[]; trace: TraceStep[]; reply: string;
    problem?: string; unchecked?: boolean;
    head: string; lastCommentId: string; createdAt: string;
  }
  /** The last run: how many threads it checked and how many the cap left out. */
  export interface ThreadCheckRun { head: string; createdAt: string; checked: number; leftOut: number }
  // AiResult gains: threadChecks?: Record<string, ThreadCheck>; threadCheckRun?: ThreadCheckRun;
  // AiJobState running pass union: "rereview" stays the internal name (my call: no rename churn).
  ```
- Produces (threadCheck.ts):
  - `MAX_THREADS = 30`
  - `checkableThreads(threads: ReviewThread[], pr: PrSummary, headSha: string, login: string): { picked: { thread: ReviewThread; silentFix: boolean }[]; leftOut: number }`
  - `threadCheckAvailable(pr: PrSummary, threads: ReviewThread[], login: string): boolean` (uses `pr.headSha`)
  - `THREAD_CHECK_SCHEMA`
  - `threadCheckPrompt(a: { repo: GhRepo; head: string; oldHead: string | null; prAuthor: string; viewer: string; picked: {thread; silentFix}[]; compares: FileCompare[] }): string`
  - `normalizeChecks(raw: unknown, picked: {thread; silentFix}[], viewer: string, prAuthor: string, head: string, now: string): ThreadCheck[]`
  - `runThreadCheck(d: JobDeps, pr: PrSummary, repoPath: string, login: string, onState: (s: AiJobState) => void, choice?: AiChoice): Promise<{ checks: ThreadCheck[]; run: ThreadCheckRun }>`

- [ ] **Step 1: Commit the spec edit on the new branch** (`docs: thread check design`).

- [ ] **Step 2: Write failing tests for `checkableThreads`** in `threadCheck.test.ts` (reuse the `thread()` / `summary()` fixtures from `rereview.test.ts`; login `me`, PR author `dev`):
  - `["dev"]` on my PR (author `me`) → picked, `silentFix: false`.
  - `["me","dev"]` on someone's PR → picked (I commented, last is theirs).
  - `["dev","x"]` on someone's PR, I never commented → not picked.
  - `["dev","me"]` → not picked (my turn is over).
  - `["me"]`, `myLastReviewSha: "R1"`, head `"H2"` → picked, `silentFix: true`; same with head `"R1"` → not picked; same with `myLastReviewSha: null` → not picked.
  - `["me"]` on **my own PR** with `myLastReviewSha: "R1"`, head `"H2"` → not picked (Review Focus 1).
  - resolved threads never picked.
  - 32 eligible threads with distinct last-comment `createdAt` → 30 picked, newest first, `leftOut: 2`.
  - `threadCheckAvailable` true iff `picked.length > 0` at `pr.headSha`.

- [ ] **Step 3: Run** `npx vitest run src/lib/review/ai/threadCheck.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 4: Implement the types and `checkableThreads` / `threadCheckAvailable`.** Set 1: unresolved, last comment author ≠ login, and (login commented in it or `pr.author === login`). Set 2: unresolved, first author = login, `pr.author !== login`, `myLastReviewSha !== null && !== headSha`. A thread in both is set 1 with `silentFix: true` (it gets the oldHead patch too). Sort by last comment `createdAt` desc, then slice.

- [ ] **Step 5: Write failing tests for schema, prompt and `normalizeChecks`:**
  - Schema: each check requires `threadId, point, raisedBy (enum), verdict (enum), reason, evidence, trace (items = prompts' traceStep), reply`.
  - Prompt contains: each thread id, every comment with author and the role tag (`PR author` / `you` for the viewer), the patch at head for every thread's file, the oldHead patch only when some picked thread is `silentFix` (and states which threads are silent fixes), the untrusted markers around thread text, and these rules: judge the point on the code at head only, never on who said it; check claims from both sides the same way; give a trace (2-8 steps) when the point is about whether something can happen or reach a line; the reply has no line numbers and no quoted code; reply empty when unclear; prose in the thread's language, polite full sentences, no terse style (copy the existing re-review wording for that).
  - Shared size budget across patches still applies (port the existing re-review test).
  - `normalizeChecks`: unknown id dropped; duplicate id → first kept; missing thread → `unclear`, reason `NO_ANSWER`, `point: ""`, `raisedBy` from the thread's last comment author (viewer/author/other rule), `reply: ""`; `unclear` with a non-empty reply → reply `""`; invalid `raisedBy`/`verdict` → treated as missing; when viewer = PR author, `raisedBy: "viewer"` becomes `"author"`; each check gets `head`, `lastCommentId` (its thread's last comment id) and `createdAt = now`; output in `picked` order.

- [ ] **Step 6: Implement them**, moving `location`/`patchBudget` from rereview.ts. Prompt structure follows `rereviewPrompt` (git rules, memory rules, instructions outside the untrusted section).

- [ ] **Step 7: Write failing tests for `runThreadCheck`** with fake `JobDeps` (port the `runRereview` tests):
  - Throws `"No threads waiting on you to check on this PR."` when nothing is picked.
  - Fetch mismatch throws as today.
  - `fetchCommit` is called only when some thread is `silentFix`; when it rejects, the run continues, the prompt has no oldHead patches and says the last-review commit was unavailable (Review Focus 3).
  - `prFileCompare` gets `(base, oldHead ?? head, head, paths)`.
  - Returns `run = { head, createdAt, checked: picked.length, leftOut }`.
  - Calls `checkThreads` (Task 2) — for this task, return the normalized checks unchanged; Task 2 adds the check and its test.

- [ ] **Step 8: Implement `runThreadCheck`**, then delete the replaced re-review functions and their tests; fix imports (`job.ts`, `aiState.svelte.ts`, `RereviewButton.svelte`) only enough to compile — Task 2/3 rewire them. Run `npx vitest run` and `npm run check`: PASS.

- [ ] **Step 9: Commit** (`feat(ai): thread check run and prompt`).

### Task 2: Code check, storage, job wiring and memory

**Files:**
- Modify: `src/lib/review/ai/codeCheck.ts` (+ test), `threadCheck.ts` (+ test), `aiStore.ts` (+ test), `aiState.svelte.ts`, `job.ts` (+ test), `memory.ts` (+ test), `badge.ts` (+ test), `rereview.ts` (`hasReview`)

**Interfaces:**
- Consumes: Task 1 types and `runThreadCheck`.
- Produces:
  - `checkThreads(checks: ThreadCheck[], files: FileHunks[], read: (rev: Rev, path: string) => Promise<string>, maxFiles?: number): Promise<ThreadCheck[]>` in codeCheck.ts
  - `withThreadChecks(prev: AiResult | null, key: PrKey, checks: ThreadCheck[], run: ThreadCheckRun): AiResult` in threadCheck.ts
  - `threadCheckReactions(checks: ThreadCheck[], threads: ReviewThread[], repo: GhRepo, login: string): Reaction[]` in memory.ts
  - `threadCheckButtonState(job, nowMs)` in badge.ts (replaces `rereviewButtonState`)
  - `requestThreadCheckAi(pr, login, choice?)`, `cancelThreadCheckAi(key)` in aiState.svelte.ts (replace the re-review ones)

- [ ] **Step 1: Write failing tests for `checkThreads`:**
  - `holds` with evidence found at head → unchanged.
  - Evidence quote found only at mergeBase of a changed file → kept.
  - All evidence missing → `unclear`, `problem: "evidence not found in the code"`, `reply: ""`.
  - No evidence at all on `holds`/`does_not_hold` → `unclear`, `problem: "no evidence"`.
  - Trace of 1 step or 9 steps → `unclear` with the findings' messages; trace `[]` → fine.
  - Step not found → `unclear`, `problem: "step 2 not found in a.ts:12"`; step moved → `line`/`movedFrom` set.
  - LEFT step read at merge-base.
  - Unread step (cap) → verdict kept, `unchecked: true`.
  - `unclear` input → returned unchanged, no reads.
- [ ] **Step 2: Implement** by extracting the evidence/trace part of `check()` into a shared core used by both `checkFindings` and `checkThreads` (`needsTrace` true for confirmed findings, false for thread checks); the file reading/caching loop is shared too. Existing `checkFindings` tests must stay green unchanged.
- [ ] **Step 3: Wire `checkThreads` into `runThreadCheck`** (readers like job.ts line ~157: head / mergeBase via `readFileAt`; `files` and `mergeBase` from `prHunks`). Test: a check whose evidence is missing comes back `unclear`.
- [ ] **Step 4: Write failing tests for storage:**
  - `withThreadChecks(null, …)` → minimal record (`headSha: ""`, like `withRereview` did) with `threadChecks` and `threadCheckRun`; `hasReview` false.
  - Merging keeps `prev`'s review fields, `rereview`, and earlier checks of threads not in this run; overwrites checked ones (Review Focus 2).
  - aiStore: accepts records without the new fields, with valid ones, and with only `rereview` (Review Focus 4); rejects a check with a bad verdict/raisedBy, a non-array trace, or a non-string reply.
  - `saveResult` in aiState keeps `threadChecks`/`threadCheckRun` (and `rereview`) when a new review is saved.
- [ ] **Step 5: Implement** storage, aiStore validation (`isThreadCheck`, `isThreadCheckRun`), `saveThreadChecks` in aiState (replacing `saveRereview`; same queueWrite pattern).
- [ ] **Step 6: Write failing tests for memory and job:**
  - `threadCheckReactions`, only threads with `comments[0].author === login`: raisedBy viewer — holds → `not_addressed`, does_not_hold → `addressed`; raisedBy author — holds → `addressed`, does_not_hold → `not_addressed`; `unclear` → `unclear`; raisedBy other → none; reason `NO_ANSWER` → none.
  - job: the `rereview` job kind runs `runThreadCheck`, saves via `saveThreadChecks`, records `threadCheckReactions`; cancel still works (port the existing re-review job tests).
  - `threadCheckButtonState`: `"Check threads"`, `"thread check queued"`, `"checking threads m:ss"`, `"thread check failed"` with `aiErrorText` title.
- [ ] **Step 7: Implement**; remove `verdictReactions` and `rereviewButtonState` if nothing uses them any more. Run `npx vitest run` and `npm run check`: PASS.
- [ ] **Step 8: Commit** (`feat(ai): check thread verdicts against the code and store them per thread`).

### Task 3: UI and reply drafts

**Files:**
- Create: `src/lib/ui/review/ThreadCheckButton.svelte` (replaces `RereviewButton.svelte`, delete it), `src/lib/ui/review/TraceList.svelte` (the failure-path list extracted from `InlineFinding.svelte`, used by both)
- Modify: `src/lib/review/ai/tracePath.ts` (+ test), `src/lib/review/ai/threadCheck.ts` (+ test), `src/lib/ui/review/InlineThread.svelte`, `InlineFinding.svelte`, `ReviewView.svelte`

**Interfaces:**
- Consumes: Task 2's `requestThreadCheckAi`, `cancelThreadCheckAi`, `threadCheckButtonState`, `threadCheckAvailable`, `AiResult.threadChecks/threadCheckRun`.
- Produces:
  - `replyAppendix(c: ThreadCheck): string` in tracePath.ts
  - `checkLabel(c: ThreadCheck, headSha: string | null, thread: ReviewThread): { text: string; tone: "ok" | "warn" | "muted"; stale: "head" | "replies" | null }` in threadCheck.ts

- [ ] **Step 1: Write failing tests for `replyAppendix`:**
  - `unclear` → `""`.
  - Otherwise `\n\n<details><summary>{inert(point one line) || "Checked in the code"}</summary>\n\n…\n\n</details>`, containing each evidence item as a list item `` `path:line` `` (path only when `line` is null) with its quote fenced and indented under it, then, when `trace` is non-empty and not `unchecked`, a "Path" sub-list rendered like `traceMarkdown` steps (reuse `stepItem`).
  - `unchecked` → evidence only, no trace.
  - Escaping: `<`, `&`, `@user`, `#12` in point/notes made inert; backticks in quotes don't break fences.
- [ ] **Step 2: Write failing tests for `checkLabel`:** holds → `✓ Holds` ok; does_not_hold → `✗ Doesn't hold` warn; unclear → `? Unclear` muted, `(no answer)` suffix for `NO_ANSWER`; `head ≠ headSha` → suffix ` (other commit)`, `stale: "head"`; thread's last comment id ≠ `lastCommentId` → suffix ` (new replies)`, `stale: "replies"` (replies win when both).
- [ ] **Step 3: Implement both.** Run tests: PASS.
- [ ] **Step 4: UI:**
  - `ThreadCheckButton.svelte`: like RereviewButton (login, `threadCheckAvailable`, button + `AiRunMenu what="Check threads"`), title "Check the open points of threads waiting on you against the code". Below it, when `threadCheckRun.leftOut > 0` for the current head, a muted line "N threads not checked (limit 30)". Mount it where RereviewButton was in `ReviewView.svelte`.
  - `InlineThread.svelte`: when `threadChecks[threadId]` exists, show it instead of the old verdict (otherwise the old re-review verdict as today). Collapsed: label + point (muted). Expanded: `reason`; `problem` as a muted line; "not fully checked" when `unchecked`; evidence list (as the old verdict did); `TraceList` for the trace; and, when `reply` is non-empty, the reply text with **Add reply** and **Edit**. Edit opens a textarea with the reply and the muted hint "The checked code is added below the reply". Add writes `addItem(record, { kind: "reply", threadId, preview: last comment body sliced to 80 }, body + replyAppendix(c), edited ? "ai-edited" : "ai")`.
  - Add/Edit disabled with title "Check again to reply" when `stale` is set; shows "Added" (disabled) when the record already has a `reply` item for this thread with origin `ai` or `ai-edited`.
  - Works in the Outdated threads area too (it renders `InlineThread`).
- [ ] **Step 5: Run** `npx vitest run` and `npm run check`: PASS.
- [ ] **Step 6: Commit** (`feat(review): show thread checks and add their replies as drafts`).

GUI checks are left to the user.
