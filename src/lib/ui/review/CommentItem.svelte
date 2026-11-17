<script lang="ts">
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { externalUrl, sanitizeHtml } from "$lib/review/markdown";
  import { relativeDate } from "../relativeDate";
  import { authorHue, commentRoles, initials } from "./commentMeta";

  let {
    author,
    createdAt,
    body,
    html = "",
    prAuthor = null,
    viewer = null,
    reply = false,
  }: {
    author: string;
    /** Null when unknown (e.g. the PR description). */
    createdAt: string | null;
    body: string;
    /** GitHub's rendered `body`; when non-empty it is shown (sanitized) instead of `body`. */
    html?: string;
    prAuthor?: string | null;
    viewer?: string | null;
    /** A reply inside a thread: drawn indented under the thread's first comment. */
    reply?: boolean;
  } = $props();

  const roles = $derived(commentRoles(author, prAuthor, viewer));
  const hue = $derived(authorHue(author));
  const when = $derived(createdAt ? new Date(createdAt) : null);
  const safeHtml = $derived(html.trim() ? sanitizeHtml(html) : "");

  // Links in rendered HTML open outside the app; the webview itself never navigates. Delegated
  // from the container, so keyboard activation of a link (a click event) is covered too.
  function openLink(e: MouseEvent) {
    const a = (e.target as Element).closest("a[href]");
    if (!a) return;
    e.preventDefault();
    const url = externalUrl((a as HTMLAnchorElement).href);
    if (url) void openUrl(url).catch(() => {});
  }
  function externalLinks(node: HTMLElement) {
    node.addEventListener("click", openLink);
    return { destroy: () => node.removeEventListener("click", openLink) };
  }
</script>

<div class="comment" class:reply style="--hue: {hue}">
  <div class="avatar" aria-hidden="true">{initials(author)}</div>
  <div class="main">
    <div class="meta">
      <b class="author">{author}</b>
      {#each roles as r (r)}<span class="role" class:you={r === "You"}>{r}</span>{/each}
      {#if when}<span class="when" title={when.toLocaleString()}>{relativeDate(when.getTime() / 1000)}</span>{/if}
    </div>
    {#if safeHtml}
      <div class="body markdown" use:externalLinks>{@html safeHtml}</div>
    {:else}
      <pre class="body">{body}</pre>
    {/if}
  </div>
</div>

<style>
  .comment {
    display: flex;
    gap: 8px;
    padding: 6px 0;
  }
  .comment + :global(.comment) {
    border-top: 1px solid var(--border);
  }
  .comment.reply {
    margin-left: 12px;
    padding-left: 10px;
    border-left: 2px solid hsl(var(--hue) 45% 55% / 0.6);
  }
  .avatar {
    flex: none;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-size: 10px;
    font-weight: 700;
    color: #fff;
    background: hsl(var(--hue) 45% 45%);
  }
  .main {
    min-width: 0;
    flex: 1;
  }
  .meta {
    display: flex;
    align-items: baseline;
    gap: 6px;
    flex-wrap: wrap;
    font-size: 0.85em;
  }
  .author {
    color: hsl(var(--hue) 50% 40%);
  }
  :global([data-theme="dark"]) .author {
    color: hsl(var(--hue) 60% 70%);
  }
  .role {
    padding: 0 6px;
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--muted);
    font-size: 0.9em;
  }
  .role.you {
    border-color: transparent;
    background: var(--accent-soft);
    color: var(--accent);
  }
  .when {
    color: var(--muted);
  }
  .body {
    margin: 2px 0 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: inherit;
  }
  /* GitHub's rendered markdown: the content comes from {@html}, so inner rules are :global. */
  .markdown {
    white-space: normal;
    line-height: 1.5;
  }
  .markdown :global(:is(p, ul, ol, pre, table, blockquote, details, h1, h2, h3, h4, h5, h6)) {
    margin: 0 0 8px;
  }
  .markdown > :global(:last-child) {
    margin-bottom: 0;
  }
  .markdown :global(:is(h1, h2, h3, h4, h5, h6)) {
    margin-top: 12px;
    font-weight: 600;
    line-height: 1.25;
  }
  .markdown > :global(:first-child) {
    margin-top: 0;
  }
  .markdown :global(:is(h1, h2)) {
    padding-bottom: 4px;
    border-bottom: 1px solid var(--border);
  }
  .markdown :global(h1) {
    font-size: 1.4em;
  }
  .markdown :global(h2) {
    font-size: 1.25em;
  }
  .markdown :global(h3) {
    font-size: 1.1em;
  }
  .markdown :global(:is(h4, h5, h6)) {
    font-size: 1em;
  }
  .markdown :global(:is(ul, ol)) {
    padding-left: 2em;
  }
  .markdown :global(li + li) {
    margin-top: 2px;
  }
  .markdown :global(li.task-list-item) {
    list-style: none;
  }
  .markdown :global(li.task-list-item input) {
    margin: 0 4px 0 -1.4em;
    vertical-align: middle;
  }
  .markdown :global(code) {
    padding: 1px 4px;
    border-radius: 4px;
    background: var(--bar-bg);
    font-family: var(--mono);
    font-size: 0.9em;
  }
  .markdown :global(pre) {
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bar-bg);
    overflow-x: auto;
    white-space: pre;
  }
  .markdown :global(pre code) {
    padding: 0;
    background: none;
  }
  .markdown :global(blockquote) {
    padding: 0 10px;
    border-left: 3px solid var(--border);
    color: var(--muted);
  }
  .markdown :global(table) {
    display: block;
    max-width: 100%;
    overflow-x: auto;
    border-collapse: collapse;
  }
  .markdown :global(:is(th, td)) {
    padding: 4px 10px;
    border: 1px solid var(--border);
  }
  .markdown :global(th) {
    font-weight: 600;
    background: var(--bar-bg);
  }
  .markdown :global(img) {
    max-width: 100%;
  }
  .markdown :global(a) {
    color: var(--accent);
  }
  .markdown :global(hr) {
    margin: 12px 0;
    border: none;
    border-top: 1px solid var(--border);
  }
  .markdown :global(summary) {
    cursor: pointer;
  }
</style>
