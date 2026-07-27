<script lang="ts">
  import type { FileDiff, SubmoduleCommit } from "$lib/types";

  // Only the submodule variant is ever passed in.
  type SubmoduleFileDiff = Extract<FileDiff, { kind: "submodule" }>;
  let { diff }: { diff: SubmoduleFileDiff } = $props();

  // Basename of the gitlink path (e.g. "Sandbox/Plugins" → "Plugins").
  const base = $derived(diff.name.split("/").filter(Boolean).at(-1) ?? diff.name);

  function fmtDate(unixSec: number): string {
    return new Date(unixSec * 1000).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }
</script>

<div class="sm-root">
  <div class="sm-header">
    <span class="sm-name">Submodule '{base}'</span>
    {#if diff.added_count > 0}<span class="sm-ahead">▲{diff.added_count}</span>{/if}
    {#if diff.removed_count > 0}<span class="sm-behind">▼{diff.removed_count}</span>{/if}
  </div>

  <div class="sm-endpoints">
    <div class="sm-endpoint">
      <span class="sm-sha">{diff.old_commit.short_sha}</span>
      <span class="sm-esub">{diff.old_commit.subject}</span>
    </div>
    <span class="sm-arrow">↓</span>
    <div class="sm-endpoint">
      <span class="sm-sha">{diff.new_commit.short_sha}</span>
      <span class="sm-esub">{diff.new_commit.subject}</span>
    </div>
  </div>

  {#if diff.added.length > 0}
    <div class="sm-group">added ({diff.added_count})</div>
    {#each diff.added as c (c.sha)}
      {@render row(c, "added")}
    {/each}
    {#if diff.added_count > diff.added.length}
      <div class="sm-more">+{diff.added_count - diff.added.length} more</div>
    {/if}
  {/if}

  {#if diff.removed.length > 0}
    <div class="sm-group">removed ({diff.removed_count})</div>
    {#each diff.removed as c (c.sha)}
      {@render row(c, "removed")}
    {/each}
    {#if diff.removed_count > diff.removed.length}
      <div class="sm-more">+{diff.removed_count - diff.removed.length} more</div>
    {/if}
  {/if}
</div>

{#snippet row(c: SubmoduleCommit, kind: "added" | "removed")}
  <div class="sm-row">
    <span class="sm-dot" class:removed={kind === "removed"}
      >{kind === "added" ? "●" : "○"}</span>
    <div class="sm-body">
      <div class="sm-meta">
        <span class="sm-sha">{c.short_sha}</span>
        <span class="sm-author">{c.author}</span>
        <span class="sm-date">{fmtDate(c.time)}</span>
      </div>
      <div class="sm-subject">{c.subject}</div>
    </div>
  </div>
{/snippet}

<style>
  .sm-root {
    padding: 12px 16px;
    overflow-y: auto;
    height: 100%;
    box-sizing: border-box;
    color: var(--fg);
  }
  .sm-header {
    display: flex;
    align-items: baseline;
    gap: 10px;
    font-weight: 600;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 8px;
  }
  .sm-ahead {
    color: var(--accent);
  }
  .sm-behind {
    color: var(--muted);
  }
  .sm-endpoints {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 12px;
    margin: -4px 0 4px;
  }
  .sm-endpoint {
    display: flex;
    gap: 8px;
    min-width: 0;
    align-items: baseline;
  }
  .sm-esub {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sm-arrow {
    color: var(--muted);
    line-height: 1;
  }
  .sm-group {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
    margin: 12px 0 4px;
  }
  .sm-row {
    display: flex;
    gap: 8px;
    padding: 4px 0;
  }
  .sm-dot {
    color: var(--accent);
    line-height: 1.4;
  }
  .sm-dot.removed {
    color: var(--muted);
  }
  .sm-body {
    min-width: 0;
    flex: 1;
  }
  .sm-meta {
    display: flex;
    gap: 10px;
    font-size: 12px;
    color: var(--muted);
  }
  .sm-sha {
    font-family: var(--mono);
    color: var(--accent);
  }
  .sm-subject {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sm-more {
    font-size: 12px;
    color: var(--muted);
    padding: 4px 0 0 16px;
  }
</style>
