# PR Description Markdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The PR review Description tab (PR body and conversation comments) renders GitHub's markdown HTML, sanitized and styled, with links opening in the external browser.

**Architecture:** `prDetail` also fetches GitHub's `bodyHTML` for the PR and its conversation comments. A new `sanitizeHtml` (DOMPurify) cleans it; `CommentItem` renders it with `{@html}` when given an `html` prop and routes link clicks to `openUrl`. Everything else that uses `CommentItem` keeps its `<pre>`.

**Tech Stack:** Svelte 5, TypeScript, vitest, DOMPurify 3, jsdom (tests only), `@tauri-apps/plugin-opener`.

**Spec:** `docs/superpowers/specs/2026-11-17-pr-description-markdown-design.md`

## Global Constraints

- Scope: PR body and conversation comments only. Review-thread comments, AI findings, thread checks and drafts stay `<pre>`.
- `body` stays on `PrDetail` and `ThreadComment` (AI prompt and fallback); HTML lives in new `bodyHtml` fields.
- Every HTML string reaches the DOM only through `sanitizeHtml`. Forbidden: `<script>`, `<style>`, `<form>`, `style` attributes, event-handler attributes, `javascript:` URLs.
- Link clicks inside rendered HTML never navigate the webview. `http:`, `https:`, `mailto:` go to `openUrl`; anything else is ignored.
- Styles use existing theme variables (`--border`, `--muted`, `--bar-bg`, `--accent`) so light and dark both work; code uses the app's mono font (`"JetBrains Mono", monospace` as used elsewhere, check `src/app.css` or similar).
- Match existing code style; no unrelated edits.

## Review Focus

- A PR body with `<img src=x onerror=...>` or `<a href="javascript:...">`: nothing runs, the link is inert.
- Clicking a link in the description: opens in the system browser, the app stays on the PR.
- A comment whose `bodyHTML` is empty (e.g. empty body): falls back to the plain `<pre>`, no blank gap.
- Wide tables / long code lines: scroll inside their own box, the panel doesn't scroll sideways.
- Dark theme: code blocks, tables and blockquotes stay readable.

---

### Task 1: `sanitizeHtml` and `bodyHTML` data

**Files:**
- Modify: `package.json`, `package-lock.json` (add `dompurify` dependency, `jsdom` devDependency via `npm install dompurify` and `npm install -D jsdom`)
- Create: `src/lib/review/markdown.ts`, `src/lib/review/markdown.test.ts`
- Modify: `src/lib/review/types.ts` (`ThreadComment`, `PrDetail`)
- Modify: `src/lib/review/github.ts` (`DETAIL_QUERY`, `RawComment`, `prDetail`)
- Modify tests: `src/lib/review/github.test.ts`; `PrDetail` fixtures in `src/lib/review/ai/job.test.ts`, `src/lib/review/ai/threadCheck.test.ts`, `src/lib/review/submitRun.test.ts` (add `bodyHtml: ""`)

**Interfaces:**
- Produces: `sanitizeHtml(html: string): string` in `src/lib/review/markdown.ts`.
- Produces: `PrDetail.bodyHtml: string`; `ThreadComment.bodyHtml?: string` (set only for conversation comments).

- [ ] **Step 1: Install deps.** `npm install dompurify` and `npm install -D jsdom`. DOMPurify 3 ships its own types.

- [ ] **Step 2: Write failing tests** in `markdown.test.ts` with `// @vitest-environment jsdom` as the first line:
  - `<p>a</p><script>alert(1)</script>` → contains `<p>a</p>`, no `script`.
  - `<img src="x" onerror="alert(1)">` → no `onerror`.
  - `<a href="javascript:alert(1)">x</a>` → no `javascript:`.
  - `<p style="color:red">x</p><style>p{}</style><form><input name="q"></form>` → no `style`, no `<form`.
  - kept: `<h2>`, `<table><tr><td>1</td></tr></table>`, `<details><summary>s</summary>b</details>`, `<a href="https://x.test/">l</a>` (href kept), `<input type="checkbox" disabled checked>` (task list, kept with `disabled`).
- [ ] **Step 3: Run** `npx vitest run src/lib/review/markdown.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 4: Implement `sanitizeHtml`.** `DOMPurify.sanitize(html, { FORBID_TAGS: ["style", "form"], FORBID_ATTR: ["style"] })`. DOMPurify's default profile already strips scripts, handlers and `javascript:` URLs. Note: forbidding `form` must not drop the task-list checkbox, which GitHub emits outside any form.
- [ ] **Step 5: Run** the same test. Expected: PASS.

- [ ] **Step 6: Extend the `prDetail` test** in `github.test.ts`:
  - The mock node gets `bodyHTML: "<p>desc</p>"`, and the conversation comment gets `bodyHTML: "<p>hi</p>"`.
  - The expected result has `bodyHtml: "<p>desc</p>"` and the conversation comment `bodyHtml: "<p>hi</p>"`.
  - Thread comments stay without `bodyHtml`, as today's `toEqual` already asserts.
- [ ] **Step 7: Run** `npx vitest run src/lib/review/github.test.ts`. Expected: FAIL.
- [ ] **Step 8: Implement.**
  - Add `bodyHTML` to the PR node and to `comments(first: 100)` (the conversation one only) in `DETAIL_QUERY`.
  - Map the conversation comments so their `bodyHtml` is set from `bodyHTML`. Thread comments keep the current `mapComment`.
  - Return `bodyHtml: n.bodyHTML`.
  - Update the types and the three `PrDetail` fixtures.
- [ ] **Step 9: Run** `npm test` and `npm run check`. Expected: all pass, 0 errors.
- [ ] **Step 10: Commit** `feat(review): fetch GitHub-rendered PR description and comments, add sanitizer`.

### Task 2: Render markdown in the Description tab

**Files:**
- Modify: `src/lib/ui/review/CommentItem.svelte`
- Modify: `src/lib/ui/review/PrOverview.svelte`

**Interfaces:**
- Consumes: `sanitizeHtml`, `PrDetail.bodyHtml`, `ThreadComment.bodyHtml` from Task 1.
- Produces: `CommentItem` optional prop `html?: string`.

- [ ] **Step 1: `CommentItem`.**
  - Add the optional `html?: string` prop.
  - When `html?.trim()`, render `<div class="body markdown" onclick={openLink}>{@html sanitizeHtml(html)}</div>`. Compute `sanitizeHtml` in a `$derived`. Otherwise render the existing `<pre class="body">{body}</pre>`.
  - `openLink(e: MouseEvent)`:
    - Find the closest `a[href]` from `e.target`. If there is none, return.
    - Otherwise `e.preventDefault()`. If the URL protocol, read from `anchor.href` with `new URL`, is `http:`, `https:` or `mailto:`, call `void openUrl(url).catch(() => {})`.
  - Svelte a11y may warn about a click handler on a div. Silence it with the same pattern the repo uses elsewhere (`grep -rn "svelte-ignore" src`), or attach the listener in an action. Pick whichever matches existing code.
- [ ] **Step 2: Markdown styles.** Write them under `.markdown` using `:global()` for the inner elements, since the content comes from `{@html}`:
  - `p, ul, ol, pre, table, blockquote, details` get a 0 top margin and a small bottom margin. The last child gets no bottom margin.
  - `h1`–`h6` are bold. `h1` and `h2` get a bottom border in `var(--border)`. Sizes step down from about 1.4em.
  - `code` uses the mono font, a `var(--bar-bg)` background, small padding and a radius.
  - `pre` gets padding and `overflow-x: auto`. `pre code` has no background.
  - `blockquote` gets a left border in `var(--border)` and `var(--muted)` text.
  - `table` has collapsed borders and its own horizontal scroll (`display: block; overflow-x: auto`). `td` and `th` get a `var(--border)` border and padding.
  - `img` gets `max-width: 100%`. `a` uses `var(--accent)`. `hr` uses `var(--border)`.
  - Task-list items (`li.task-list-item`, GitHub's class) have no bullet.
  - `.markdown` wraps long words: `overflow-wrap: anywhere`.
- [ ] **Step 3: `PrOverview`.**
  - The description `CommentItem` gets `html={detail.bodyHtml}` when `detail.body.trim()` is non-empty. Otherwise it gets no html and keeps the plain "(No description.)".
  - Each conversation `CommentItem` gets `html={c.bodyHtml}`.
  - Leave the no-summary fallback `<pre class="body">` branch as is. It only shows while the PR list entry is missing.
- [ ] **Step 4: Run** `npm test` and `npm run check`. Expected: all pass, 0 errors, no new warnings.
- [ ] **Step 5: Commit** `feat(review): render the PR description and conversation as markdown`.
- [ ] **Step 6: GUI check (user).** Open a PR with headings, a table, a code block, a task list, `<details>` and a link.
  - The tab renders like GitHub, in both light and dark themes.
  - A link opens in the browser.
  - Review-thread comments are unchanged.
