<script lang="ts">
  import { relativeDate } from "../relativeDate";
  import { authorHue, commentRoles, initials } from "./commentMeta";

  let {
    author,
    createdAt,
    body,
    prAuthor = null,
    viewer = null,
    reply = false,
  }: {
    author: string;
    /** Null when unknown (e.g. the PR description). */
    createdAt: string | null;
    body: string;
    prAuthor?: string | null;
    viewer?: string | null;
    /** A reply inside a thread: drawn indented under the thread's first comment. */
    reply?: boolean;
  } = $props();

  const roles = $derived(commentRoles(author, prAuthor, viewer));
  const hue = $derived(authorHue(author));
  const when = $derived(createdAt ? new Date(createdAt) : null);
</script>

<div class="comment" class:reply style="--hue: {hue}">
  <div class="avatar" aria-hidden="true">{initials(author)}</div>
  <div class="main">
    <div class="meta">
      <b class="author">{author}</b>
      {#each roles as r (r)}<span class="role" class:you={r === "You"}>{r}</span>{/each}
      {#if when}<span class="when" title={when.toLocaleString()}>{relativeDate(when.getTime() / 1000)}</span>{/if}
    </div>
    <pre class="body">{body}</pre>
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
</style>
