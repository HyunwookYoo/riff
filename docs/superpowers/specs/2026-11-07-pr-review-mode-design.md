# PR Review Mode — Design Spec

**Date:** 2026-11-07
**Version:** targets the release after v2.5.0

## Why

The user reviews pull requests where they are a requested reviewer, today on
the GitHub web UI. Two things go wrong there:

1. **They can't tell what a change really does.** The diff shows only the
   changed lines. The code around it (who calls the changed function, where a
   changed type is used, what a definition looks like) is not on screen, and
   neither is the author's intent.
2. **They can't see what the change might break.** Potential issues caused by
   the change are hard to find from the diff alone.

Hosted AI reviewers (Copilot review, CodeRabbit, Greptile, Claude Code Review)
attack these by indexing the repo on a server. riff already has the user's
local clone, and the user runs Claude Code locally. So riff can let Claude
Code read the PR's code from the local object store, with nothing uploaded to
a review service, and keep a human in charge of what gets posted.

What makes the user stop trusting an AI reviewer, in their words: unverified
review comments spammed until the review itself loses credibility. That is
the anti-goal everything below is built around.

## Users and setting

- One user (the riff author), on their own machine. No team distribution
  concerns: assume the `claude` (Claude Code) CLI is installed and logged in,
  and that its usage comes from the user's own Claude plan.
- The PRs are almost always on repos the user already has open in riff
  (including submodules such as `Sandbox/Plugins`). The user's main host is a
  GitHub Enterprise Server (`github.krafton.com`); github.com must work too.
- The PR's branch is usually **not** present locally.

## Goals

1. **PR Review mode.** A new top-level mode listing the PRs where the user is
   a requested reviewer, for the repos open in riff, and showing a PR's diff.
2. **AI review on request.** On the user's request per PR, Claude Code
   analyses the PR in the background and produces:
   - **(c) Issue findings** — potential bugs or breakage caused by the change,
     each verified and backed by evidence. *(Top priority.)*
   - **(a) Reading order** — the changed files grouped into "chapters" in the
     order they are best read (e.g. data structure change before the code that
     uses it), each with a short summary of its intent. *(Second priority.)*
   Impact on code outside the diff (callers, usages) is not a separate panel;
   it is part of how findings are found and the evidence they cite.
3. **Draft, then submit.** AI findings never go to GitHub on their own. The
   user adds a finding to their draft review as is, edits it first, or
   discards it. Their own comments and thread replies go into the same draft.
   The draft is submitted as one GitHub review.
4. **Drafts window.** The draft review can be shown in a separate OS window:
   see all collected comments at a glance, edit them, then submit from there.
5. **Existing threads.** Show existing review threads on the PR in the diff;
   the user can reply (replies go into the draft) and resolve/unresolve.
6. **Re-review verification.** After the author pushes new commits, on the
   user's request the AI checks each of the user's earlier review threads and
   says whether the new code actually addresses it, with evidence.
7. **Resume later.** The user can close riff mid-review and continue later:
   drafts and AI results survive restarts.

## Non-goals

- No automatic AI runs. Analysis starts only when the user asks for it on a
  PR (cost and noise: the user decided).
- No building, compiling or running tests. Reading and analysing code is
  enough (the user decided).
- No checkout and no worktree of the PR. riff fetches the PR's commits only.
- No AI posting to GitHub, and no AI-initiated approve/request-changes.
- No PR creation, merging, or editing PR metadata (labels, assignees).
- No PRs from repos that are not open in riff in v1.
- No chat with the PR, no per-file "reviewed" marks, no review across stacked
  PRs (seen in other tools, not asked for).
- No OAuth app / device flow. Authentication reuses the `gh` CLI login.

## Anti-goals

- **An unverified finding presented as fact.** Every finding shown as a
  finding must have passed the verification pass and carry evidence. Anything
  that fails verification is dropped; anything that cannot be confirmed or
  refuted is shown only in the separate "Unconfirmed" area.
- **The AI or the analysis changing the repo.** It must never touch the
  working tree, index, HEAD, branches or the user's refs. The only write to
  the repo is riff's own fetch into a riff-private ref namespace. (Writes to
  agentmemory are allowed; see "AI analysis".)
- **Anything reaching GitHub without an explicit user action.** Only Submit
  (and resolve/unresolve, which are immediate by nature) talk to GitHub's
  write APIs.
- **Losing a draft.** A crash, restart, a failed submit or a new push by the
  author must not lose draft comments.
- **Style noise.** Naming, formatting and taste comments are not findings.

## How it works (decided)

### Getting the PR's code without checkout

- Fetch the PR head with `git fetch <remote> pull/<N>/head:refs/riff/pr/<N>`
  (GitHub and GHES expose `refs/pull/<N>/head` on the base repo, fork PRs
  included). Also make sure the PR's base commit (`base.sha` from the API) is
  present, fetching the base branch if not. Nothing is checked out.
- The diff is `base...head` (three-dot, against the merge base), the same
  shape as Branch mode's compare.
- The AI reads code **from git objects at the PR head**, not from the working
  tree: `git diff`, `git show <head>:<path>`, `git grep -n <pattern> <head>`,
  `git log`. This keeps the reading accurate even when the working tree is on
  another branch or dirty. *(My call; refines the earlier "read the working
  tree" idea, which could drift from the PR.)*
- Which remote: the remote whose URL matches the PR's base repository.

### Authentication and GitHub access

- The host comes from the repo's remote URL. The token comes from the `gh`
  CLI's login for that host (`gh auth token --hostname <host>` or by calling
  `gh api --hostname <host>` directly). If `gh` is missing or not logged in
  for that host, the mode says so and shows the command to run
  (`gh auth login --hostname <host>`). *(My call: no PAT entry or OAuth in
  v1.)*
- GHES REST is at `https://<host>/api/v3`, GraphQL at
  `https://<host>/api/graphql`.

### PR list

- Two sections per repo open in riff:
  - **Review requested** — `is:pr is:open review-requested:@me repo:<o>/<r>`.
  - **Reviewed by me, still open** — `is:pr is:open reviewed-by:@me
    repo:<o>/<r>`, minus the ones already in the first section. GitHub drops
    the review request once the user submits a review, so without this section
    a PR would vanish before re-review verification could be used. *(My
    call.)*
- Each row: number, title, author, repo, +/− size, and status badges:
  AI state (none / queued / analysing with elapsed time / ready with finding
  count / PR updated — re-analyse), "draft N" when a draft exists, and "new
  commits since my review" for the second section.
- Refresh when the mode is entered, on a manual refresh button, and every
  5 minutes while the mode is open. *(My call on the interval.)*

### Layout (option A, chosen by the user)

- **Left column:** the PR list; under the selected PR, its chapters in reading
  order (each with its finding count), then a collapsed **Unconfirmed (N)**
  area, then a collapsed **Outdated threads (N)** area.
- **Main area:** the selected chapter: its intent summary at the top, then the
  diffs of its files. Verified AI findings appear inline right under the line
  they point to, each with **Add to draft / Edit / Discard** and **Show
  evidence** (jumps to the cited code). Existing review threads also appear
  inline at their lines with Reply and Resolve/Unresolve. The user can select
  one or more lines and write their own comment.
- **PR overview** (description and general conversation comments, the ones
  not attached to a line) sits above chapter 1. *(My call.)*
- **Bottom bar:** "My draft: N comments", the review event selector and
  Submit; clicking the count opens the drafts window.
- Before AI analysis has been requested, the PR shows its files in a single
  default chapter (path order) with no findings; everything else works.

Mockups from the session live in `.superpowers/brainstorm/*/content/`
(`layout.html` option A, `drafts-window.html`, `pr-list.html`). The
`pr-list.html` mockup predates the "on request only" decision: ignore its
automatic-analysis wording; its badges still apply.

### Drafts window

- A separate OS window (Tauri multi-window) for the current PR's draft,
  kept live in sync with the main window both ways.
- Each item shows: location (`file:line` or range), a tag (AI draft / AI
  draft, edited / Unconfirmed / my comment / reply), one line of the code it
  points to (or the parent thread's last message for a reply), and the body,
  editable in place. Actions: edit, show in main window (scrolls the main
  diff to it), delete.
- Bottom: review body text, event (Comment / Approve / Request changes), and
  Submit to GitHub.
- Unconfirmed findings that were added to the draft keep a grey "Unconfirmed"
  tag here as a last reminder before submitting.

### AI analysis

Run the `claude` CLI headless (`claude -p`, streaming JSON output) with the
repo as working directory, **read-only toward the repo**: only the read-only
git commands above. No edit, write or arbitrary shell tools.

How much of the user's own Claude Code setup the run gets (the user decided:
keep their context):

- **Loaded:** the user's global and the repo's `CLAUDE.md`, the user's
  settings and hooks (so agentmemory's session capture runs), and the
  agentmemory MCP server, so the run can recall past decisions and save
  observations as the user's sessions normally do.
- **Blocked:** every other MCP server (Slack, Atlassian, paseo and any added
  later), via an explicit MCP config that lists agentmemory only.
  *(My call: an allowlist, so a new server is blocked by default.)*
- **Forced:** a non-interactive permission mode with an explicit tool
  allowlist (read-only git commands plus agentmemory's tools), regardless of
  the user's default mode such as auto.
- Consequence the user accepted: review runs leave records in agentmemory,
  outside the repo. The repo itself stays untouched.

Two passes:

1. **Find.** Given the PR title, body, commit messages, the diff, and the
   base/head SHAs, produce:
   - chapters: ordered groups of changed files, each with a one- or
     two-sentence intent summary. Every changed file belongs to exactly one
     chapter; files the model leaves out go into a final "Other" chapter
     added by riff.
   - candidate findings: file, line or line range, side (old/new), severity
     (high / medium / low), a draft comment body written to the PR author,
     and evidence (the locations it read and quoted lines).
2. **Verify.** A separate run receives each candidate and tries to refute it
   by reading the cited code and anything else it needs. Outcome per
   candidate: **confirmed** (shown inline), **refuted** (dropped, not shown),
   or **unconfirmed** (shown in the Unconfirmed area with its evidence).
   A finding without evidence is treated as refuted.

Both passes run as one background job per PR. Jobs queue and run one at a
time *(my call: a large UE repo should not run several at once)*; a queued or
running job can be cancelled. When a job finishes, the list badge updates
and an OS notification says "AI review ready — #N <title> — K findings".

Results are cached per PR and head SHA: reopening the PR does not re-run.
If the PR head moves, the result is marked stale and the user may re-analyse.

Draft comment bodies are written in the language of the PR description.
*(My call.)*

### Mapping findings to GitHub comments

GitHub only accepts inline review comments on lines that appear in the PR's
diff. When a confirmed finding points outside the diff:

- if its file is part of the PR: it becomes a file-level comment
  (`subject_type: file`) that quotes the location;
- otherwise: it is appended to the review body with its location.

This conversion is automatic and visible in the draft item's tag.

### Re-review verification

- Available on a PR where the user has earlier review threads and the head
  has moved since the user's last submitted review.
- On request, a background job (same queue, same read-only rules) receives,
  for each of the user's unresolved threads: the original comment, its
  location, the replies, and what changed in the PR between the commit of the
  user's last review and the current head. It returns per thread **addressed
  / not addressed / unclear**, with evidence.
- "What changed in the PR" is a PR-only comparison, not a plain
  `oldHead..newHead` diff: compare `base...oldHead` with `base...newHead`,
  limited to the files the threads point at. A rebase or a base-branch merge
  by the author would otherwise flood the input with unrelated upstream
  changes. The old review commit is fetched by SHA if it is not local (the
  earlier review may have been made on the web). *(My call, after the builder
  read.)*
- The verdict shows on each thread, inline and in the Outdated threads area.
  From there the user can draft a reply or resolve the thread. Nothing is
  posted or resolved automatically.

### Submitting

- Submit uses GraphQL so new threads and replies go into one review: create
  a pending review on the PR pinned to the **current** head SHA
  (`commitOID`; see "When the author pushes" below), add new threads (line, side, start line for ranges, or
  file-level), add replies to existing threads
  (`addPullRequestReviewThreadReply` with the pending review id), then submit
  with the chosen event and body.
- GitHub allows one pending review per user per PR. If one already exists
  (for example started on the web), tell the user and let them choose to add
  to it or discard it before continuing. *(My call.)*
- On failure, the draft stays intact and the error is shown; nothing is
  half-cleared. On success, the draft is cleared and the threads reload.
- Resolve / unresolve call GitHub immediately (they are not part of a
  review). *(My call.)*

### When the author pushes during a review

The review is always submitted against the PR's **latest** head, so an
Approve means "I approve what is there now" and branch protection does not
treat it as stale. *(The user decided, over pinning to the commit they first
saw.)*

- riff notices a new head on list refresh or when the PR is opened, fetches
  it, and the main window switches to the new head's diff.
- Draft items and cached AI findings are **re-placed** onto the new head by
  matching the code they quote (the line content plus a little surrounding
  context). Items that can no longer be placed are flagged in the drafts
  window ("could not place — fix or drop") and are excluded from submission
  until the user re-anchors or deletes them. *(My call on the matching
  method; exact tolerance left to the builder.)*
- The AI result is marked stale (re-analyse button), but its re-placed
  findings stay visible with a "from an older commit" tag.
- A **"New since you looked"** view shows what changed in the PR between the
  head the user last viewed and the new head, using the same PR-only
  comparison as re-review (`base...oldHead` vs `base...newHead`), so a
  rebase by the author does not flood it.
- Submit is blocked until the user has opened that view for the latest head.
  This keeps the user from approving or commenting on commits they have not
  seen. *(My call: applies to every event, not only Approve.)*

### Persistence

Per PR (keyed by host, owner/repo, number), on disk in riff's app data:
the draft (items, review body, chosen event), the AI result per head SHA,
re-review verdicts, and the head SHA each was made against. Survives
restarts. Drafts of merged or closed PRs can be cleaned up when the PR leaves
both list sections.

## Constraints

- Tauri 2 + Svelte 5 runes + git CLI backend, like the rest of riff. Long work
  off the UI thread with progress streamed over a Tauri `Channel` and a cancel
  id, following `rebase_check` / `cancel_rebase_check` (`src-tauri/src/lib.rs`).
- Mode wiring follows the existing pattern: `AppMode` in `src/lib/types.ts`,
  the mode toggle in `InputBar.svelte`, layout branches in
  `src/routes/+page.svelte`, `cycleAppMode`, command palette entries, and the
  back/forward snapshot in `history.ts`.
- Reuse the diff rendering in `src/lib/ui/DiffView.svelte` (CodeMirror merge
  view) and `src/lib/diff/`; `fullLine.ts` is the template for inline
  decorations. `DiffView` reads `appState.selectedFile` directly, so it needs
  props or an adapter to serve this mode.
- Stale async results must never land over newer ones (the sequence-token
  pattern in `branchContainment.ts`).
- The AI subprocess must be read-only (see Anti-goals). This is a hard rule,
  enforced through the CLI's tool allowlist and permission settings, not by
  prompt wording alone. The AI reads only through read-only git commands
  (no Read/Grep/Glob on the working tree), matching "read from git objects
  at the PR head". *(Builder's call, accepted.)*
- riff's PR fetches stay out of `refs/remotes`, and `refs/riff/*` is hidden
  from riff's ref views (sidebar, graph, pickers).
- Verified against the user's GHES (3.20.6): file-level review comments and
  the GraphQL review mutations are available.
- Tests: backend tests for PR fetch into the private ref namespace, finding
  → comment mapping (in diff / file-level / body), draft persistence and
  re-placement after a push; frontend tests for list state badges, draft
  sync between windows, staleness, and Submit staying blocked until the
  "New since you looked" view has been opened for the latest head.

## Left to the builder

- Whether GitHub calls go through `gh api` (consistent with riff's
  "shell out to the CLI" style) or a Rust HTTP client with the `gh` token.
- The exact Claude CLI flags, prompts, and JSON schema for both passes and
  for re-review, within the read-only rule. How verification is batched
  (one run for all candidates or several) is the builder's call.
- Component split, store shape, file format for persistence, how the two
  windows sync.
- Notification mechanism (e.g. Tauri's notification plugin).
- Exact wording and styling beyond what is written here.
