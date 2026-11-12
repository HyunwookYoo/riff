# Verified failure paths — implementation plan

Spec: `docs/superpowers/specs/2026-11-07-pr-review-mode-design.md`, section
"Verified failure paths". Branch `feat/ai-verify-trace` (from main 08fc850,
v2.7.0). TS only; no Rust change expected (`readFileAt` already exists).

Verify every task with `npx vitest run` and `npm run check` (one pre-existing
'node' types warning is fine). Commit messages end with
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push. Don't
run the GUI or the claude CLI. No interactive git commands. Don't touch
`src-tauri/src/ai/mod.rs`.

## Task 1 — Trace, evidence checks and refuted list (logic)

Files: `src/lib/review/ai/{prompts.ts,result.ts,types.ts,aiStore.ts,job.ts}`,
new `src/lib/review/ai/codeCheck.ts`, tests beside them.

1. `VERIFY_SCHEMA` verdicts gain required `trace: TraceStep[]` with
   `TraceStep = { path, side: "LEFT"|"RIGHT", line: integer ≥1, quote, note }`.
   `verifyPrompt`: for `confirmed`, give the failure path — 2 to 8 ordered
   steps from the trigger through calls/branches to the faulty line and the
   wrong result, quoting the code of each step exactly as it is at that side's
   revision, with a one-line note in the PR description's language; `trace`
   is `[]` for refuted/unconfirmed. Also ask that `failureScenario` in the
   find pass is written in the PR description's language.
2. Types: `AiFinding.verification?: { reason: string; trace: TraceStep[];
   problem?: string }`; `AiResult.refuted?: RefutedFinding[]` with
   `{ path, line, severity, summary, reason }` (summary = first non-empty
   body line). aiStore validates both as optional (old records stay valid).
3. `mergeVerdicts` keeps the verdict's `reason` and `trace` on the finding
   (`verification`) and returns refuted candidates separately (or a second
   function does) so `runJob` can store `refuted`.
4. `codeCheck.ts` (pure core + a loader taking `readFileAt`):
   - `collapse(s)` whitespace-collapse.
   - `stepFound(text, line, quote)`: quote (collapsed, ≥ 8 non-space chars)
     is within lines `line-3 .. line+3` (joined, collapsed).
   - `quoteInFile(text, quote)`: collapsed substring anywhere.
   - `checkFindings(findings, readers, caps)`: per finding,
     - evidence items whose path is not `roblox:`: keep those whose quote is
       in the file at head or at mergeBase (old path for renames if known);
       if none kept → status `unconfirmed`, problem "evidence not found in
       the code";
     - confirmed findings: no trace → unconfirmed, problem "no failure path";
       first failing step → unconfirmed, problem
       `step N not found in <path>:<line>`.
     Read each `(rev, path)` once (cache), at most 80 distinct files; beyond
     the cap, skip the check for that item (do not downgrade). A file that
     can't be read at that rev counts as not found.
5. `job.ts`: after `mergeVerdicts` (and after the Roblox downgrade), run
   `checkFindings` with head/mergeBase readers; store `refuted`. Roblox
   evidence keeps its own check (roblox.ts); `roblox:` trace steps are not
   allowed (a step must be repo code; treat a `roblox:` step as failing).
6. Tests: schema/prompt text; mergeVerdicts keeps reason/trace and returns
   refuted; stepFound (exact, whitespace, off by 3 ok, off by 4 fails, short
   quote fails); evidence filtering incl. rename/old side and roblox skip;
   downgrade cases; file cap; aiStore old/new records; job stores refuted and
   calls the check.

## Task 2 — UI and draft body

Files: `src/lib/ui/review/InlineFinding.svelte`, `ReviewFiles.svelte` (or a
new `RefutedList.svelte`), the draft-add path (`add()` in
InlineFinding.svelte), new pure helper `src/lib/review/ai/tracePath.ts`.

1. `tracePath.ts`:
   - `traceMarkdown(scenario: string, trace: TraceStep[]): string` →
     `\n\n<details><summary>{scenario, one line, HTML-escaped}</summary>\n\n`
     then numbered steps `1. \`path:line\` — note` each followed by a fenced
     code block of the quote (fence longer than any backtick run in it, like
     `fenced()` in prompts.ts; language from the file extension when easy,
     else none), then `</details>`. Empty string when trace is empty.
   - Tests: escaping (`<`, `&`, backticks), fences, empty trace.
2. Add (as is / edited) appends `traceMarkdown(...)` to the draft body for
   findings with a verification trace. Editing before Add shows the body
   without the block; the block is appended on Add (state this in a muted
   hint under the editor: "The failure path is added below the comment").
   The drafts window then shows/edits it as normal text.
3. Finding card: muted "Verified: <reason>" line; "Failure path" numbered
   list (`path:line — note`, quote in mono, collapsed by default if > 3
   steps). A step in a PR-changed file is a button that jumps there (reuse
   the existing navigation used by the AI findings list / `showFinding`);
   other steps are plain text. For downgraded findings show the `problem`
   line in the Unconfirmed tag tooltip or as a muted line.
4. Refuted list: collapsed `<details>` "Refuted by verification (N)" next to
   the Unconfirmed area: rows `path:line · severity · summary — reason`,
   path:line clickable when the file is in the PR.

Tests for pure helpers; GUI checks left to the user.
