# PR list filters — implementation plan

Branch `feat/pr-list-filters` (from main f825f77, v2.8.0). Mockup approved by
the user: `.superpowers/brainstorm/pr-filter-mockup.html` (gitignored; read it
for the exact layout, labels and behaviour).

User decisions (2026-11-13):
- The PR list shows **all open PRs** of the open repos by default (today it
  shows only PRs where I'm a requested reviewer or have reviewed).
- Filter bar under the toolbar: search box ("Search title or #number"), a
  segmented **All / For me** switch with counts, an **Author** select
  (Anyone · Me (n) · authors by PR count), and a **Repo** select (All repos ·
  owner/name (n)…) shown only when more than one GitHub repo is listed
  (submodules and manually added repos each count — `appState.repos` already
  includes them). Clicking an author name in a row filters by that author.
  Filters combine (AND). A summary line shows "N of M PRs" with **Clear
  filters** when any filter is set, "M open PRs" otherwise. Empty result:
  "No pull requests match." + Clear filters.
- All: one list, most recently updated first; rows get a `review requested`
  (accent) or `reviewed` (green) pill. For me: today's two sections
  ("Review requested", "Reviewed by me").
- Search: case-insensitive title substring, or PR number prefix when the
  query is digits with optional leading `#`; matched title part highlighted.
  Esc in the box clears it.
- **Remember** show / author / repo across restarts (persisted); the search
  text is not remembered.
- Fetch cap for All: per repo the 200 most recently updated open PRs.

Verify every task with `npx vitest run`, `npm run check` (one pre-existing
'node' types warning is fine) and, for Rust changes, `cd src-tauri && cargo
test`. Commit messages end with `Co-Authored-By: Claude Opus 5.5
<noreply@anthropic.com>`. Never push. Don't run the GUI. No interactive git
commands. Never post anything to GitHub in tests.

## Task 1 — Data and filter logic

1. `src/lib/review/github.ts`:
   - New `openPrs(host, repo: SearchRepo, login)`: GraphQL
     `repository(owner,name){ pullRequests(states: OPEN, first: 100, after,
     orderBy: {field: UPDATED_AT, direction: DESC}) { pageInfo { hasNextPage
     endCursor } nodes { …same fields as SEARCH_QUERY's PullRequest… } } }`,
     at most 2 pages (200). Reuse the node→PrSummary mapping (extract it).
   - `searchPrs` keeps the two `@me` searches (they include team review
     requests) but only to mark PRs. New result shape: every listed PR has
     `mine: "requested" | "reviewed" | null` (replaces `section`; requested
     wins over reviewed). A mine PR missing from the open list (beyond the
     cap) is still included.
   - Per host, run the open-PR queries for its repos in parallel with the two
     searches. Keep errors per host as today.
2. `PrSummary`: replace `section` with `mine`, and add `viewer: string` (the
   host's login, for Author "Me"). Update every use (`PrList.svelte`
   `newCommits` uses `section === "reviewed"` → `mine === "reviewed"`;
   tests/fixtures).
3. New `src/lib/review/prFilter.ts` (pure, tested):
   - `type PrFilter = { show: "all" | "mine"; author: string | null; repo: string | null }`
     (`author` = login, `"@me"` sentinel for Me; `repo` = `repoKey`-style
     lowercased `host/owner/name` — reuse `repoKey` from
     `src/lib/review/ai/roblox.ts`).
   - `matchQuery(p, q)`: digits with optional `#` → number prefix; else
     case-insensitive title substring; empty → true.
   - `applyFilter(prs, f, q)` → `{ list, counts: { all, mine }, total }`:
     counts reflect author/repo/query but not show; list sorted by
     `updatedAt` desc for All; For me returns `{ requested, reviewed }`
     sections in that order (each by updatedAt desc).
   - `authorOptions(prs)`: authors other than the viewer with counts, by
     count desc then name; `meCount`.
   - `repoOptions(prs)`: repos with counts; `showRepoFilter` when ≥ 2.
   - `highlight(title, q)` → segments `{ text, hit }[]` for the UI (no HTML).
   - `normalizeFilter(raw)`: from persisted JSON, unknown/invalid → defaults.
     An author or repo that no longer appears in the list keeps filtering
     (the UI shows it as an option "name (0)") — don't silently drop it.
4. Persisted filter (Rust store, follow `ai_model` / `set_ai_model`):
   `PersistedState.pr_list_filter: Option<PrListFilter>` with
   `{ show: String, author: Option<String>, repo: Option<String> }` (serde
   default None), setter `set_pr_list_filter` validating show ∈ {all, mine}
   and lengths (author ≤ 100 chars of `[A-Za-z0-9-_@.\[\]]`, repo a 3-segment
   key like `set_roblox_parity` validates). Mirror into `appState` on load
   like `aiModel`; TS wrapper in `src/lib/git.ts`.
5. Tests: mapping and mine-merging in github.ts with a fake `ghGraphql`
   (follow existing tests if any; otherwise inject the query function),
   pagination stops at 2 pages, prFilter cases (each filter, combos,
   counts, number vs text query, highlight, normalize), store validation
   (cargo).

## Task 2 — UI

`src/lib/ui/review/PrList.svelte` (+ a small `PrFilterBar.svelte` if it
keeps PrList readable):
- Filter bar per the mockup: search input with ⌕ icon and ✕ clear (Esc
  clears), segmented All/For me with counts, Author select (accent border when
  set), Repo select only when `showRepoFilter`, summary line + Clear filters.
- Rows: pills for `mine` in All view; author name is a button that sets the
  author filter (stopPropagation so it doesn't open the PR); highlighted
  title segments via `highlight`.
- For me: the two sections as today. Empty states: keep the existing
  host/no-repos states; add "No pull requests match." with Clear filters when
  filters hide everything.
- The fold toolbar count stays the total; the filter bar hides when the list
  is collapsed.
- Filter changes save immediately (show/author/repo) via the setter; failures
  are ignored after logging (the filter still applies for the session).
- Keyboard: the search box is reachable by Tab; global shortcuts in
  `+page.svelte` must not fire while typing in it (check how other inputs are
  excluded).
- The selected PR stays selected even when filtered out of view.

GUI checks are left to the user.
