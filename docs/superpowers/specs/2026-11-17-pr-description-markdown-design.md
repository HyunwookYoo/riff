# PR description as rendered markdown — design

## Intent

In PR review mode the Description tab shows the PR body as raw text in a `<pre>`, so headings,
lists, tables, `<details>` blocks and links read as markup. The user wants it styled the way
GitHub shows it.

## Goals / non-goals

- Goal: the Description tab (PR body and the conversation comments under it) renders markdown
  the way GitHub does.
- Non-goal: inline review thread comments, AI findings, thread checks and drafts. They stay
  plain text (`<pre>`). *(Our call: the conversation comments sit in the same tab and component
  as the body; rendering the body alone would leave raw markdown right under styled markdown.)*
- Anti-goal: anything in a PR body or comment running script or reaching Tauri `invoke`
  (the app's CSP is `null`), or a link navigating the app's own webview away.

## Approaches

- **A, chosen:** ask GitHub for `bodyHTML` in the GraphQL query riff already sends. GitHub
  renders GFM and sanitizes it, so mentions, `#123` links, task lists and `<details>` match
  github.com, on GHE too. riff sanitizes it again with DOMPurify and styles it.
- B: render `body` locally with marked + DOMPurify. Two runtime deps, and mentions, issue
  links and relative image paths differ from GitHub.

## Design

- **Data:** `DETAIL_QUERY` adds `bodyHTML` on the PR node and on the conversation `comments`
  nodes (not on review thread comments). `PrDetail.bodyHtml: string`;
  `ThreadComment.bodyHtml?: string`, set only for conversation comments. `body` stays, for
  the AI prompt and as the fallback.
- **Sanitize:** new runtime dep `dompurify`. `src/lib/review/markdown.ts` exports
  `sanitizeHtml(html: string): string`: DOMPurify's default profile, plus `style` and `form`
  forbidden. Script, event-handler attributes and `javascript:` URLs never survive.
- **Links:** a click handler on the rendered block intercepts `<a>` clicks. `http(s):` and
  `mailto:` open through `@tauri-apps/plugin-opener`'s `openUrl`; every other link does nothing.
- **Render:** `CommentItem` takes an optional `html` prop. When it is non-empty it renders
  `{@html sanitizeHtml(html)}` inside `div.markdown`; otherwise the current `<pre>` with
  `body`. `PrOverview` passes `detail.bodyHtml` / `c.bodyHtml`. "(No description.)" stays
  plain.
- **Style:** `.markdown` rules scoped to `CommentItem`: headings, paragraph and list spacing,
  inline code and `pre` in the mono font on `--bar-bg`, blockquote, table borders, `hr`,
  `img { max-width: 100% }`, task-list checkboxes, using the existing theme variables so
  light and dark both work.
- **Tests:** vitest for `sanitizeHtml` under jsdom (new dev dep, per-file
  `@vitest-environment jsdom`): `<script>`, `onerror`, `javascript:` href and `style` are
  removed; headings, tables, `<details>`, links and disabled task checkboxes are kept.

## Left to the builder

Exact CSS values. Images that need a GHE login session may show as broken. Accepted, not
worked around.
