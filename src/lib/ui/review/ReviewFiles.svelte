<script lang="ts">
  import { reviewState, isInlineThread, sortedPaths } from "$lib/review/reviewState.svelte";
  import type { ShownFinding } from "$lib/review/ai/result";
  import type { AiChapter } from "$lib/review/ai/types";
  import type { PrKey } from "$lib/review/types";
  import InlineThread from "./InlineThread.svelte";
  import InlineFinding from "./InlineFinding.svelte";
  import ChapterList from "./ChapterList.svelte";
  import UnconfirmedList from "./UnconfirmedList.svelte";

  let {
    ai,
    onevidence,
  }: {
    /** The open PR's AI result, as shown; null without one. */
    ai: { prKey: PrKey; createdAt: string; chapters: AiChapter[]; inline: ShownFinding[]; offDiff: ShownFinding[]; unconfirmed: ShownFinding[] } | null;
    onevidence: (path: string, line: number | null) => void;
  } = $props();

  const paths = $derived(sortedPaths(reviewState.files));
  const threads = $derived(reviewState.detail?.threads ?? []);
  const outdated = $derived(threads.filter((t) => !isInlineThread(t)));

  const threadCounts = $derived.by(() => {
    const m = new Map<string, number>();
    for (const t of threads) if (isInlineThread(t)) m.set(t.path, (m.get(t.path) ?? 0) + 1);
    return m;
  });
  const draftCounts = $derived.by(() => {
    const threadPath = new Map(threads.map((t) => [t.id, t.path]));
    const m = new Map<string, number>();
    for (const i of reviewState.record?.items ?? []) {
      const t = i.target;
      const path = t.kind === "line" || t.kind === "file" ? t.path : t.kind === "reply" ? threadPath.get(t.threadId) : undefined;
      if (path !== undefined) m.set(path, (m.get(path) ?? 0) + 1);
    }
    return m;
  });

  const findingCounts = $derived.by(() => {
    const m = new Map<string, number>();
    for (const f of [...(ai?.inline ?? []), ...(ai?.offDiff ?? [])]) m.set(f.path, (m.get(f.path) ?? 0) + 1);
    return m;
  });

  const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  const dir = (p: string) => p.slice(0, p.lastIndexOf("/") + 1);
</script>

{#snippet row(p: string)}
  <button
    type="button"
    class="row"
    class:selected={reviewState.selectedPath === p}
    title={p}
    onclick={() => (reviewState.selectedPath = p)}
  >
    <span class="name"><span class="muted">{dir(p)}</span>{base(p)}</span>
    {#if threadCounts.get(p)}
      <span class="badge">{threadCounts.get(p)} thread{threadCounts.get(p) === 1 ? "" : "s"}</span>
    {/if}
    {#if draftCounts.get(p)}<span class="badge draft">draft {draftCounts.get(p)}</span>{/if}
  </button>
{/snippet}

<section class="review-files">
  {#if !ai}<div class="chapter">All files <span class="muted">{paths.length}</span></div>{/if}
  <div class="scroll">
    {#if ai}
      <ChapterList chapters={ai.chapters} {findingCounts} {row} />
      <UnconfirmedList prKey={ai.prKey} createdAt={ai.createdAt} findings={ai.unconfirmed} {onevidence} />
      {#if ai.offDiff.length > 0}
        <details class="outdated">
          <summary>Not on a diff line ({ai.offDiff.length})</summary>
          {#each ai.offDiff as f (`${ai.createdAt}:${f.id}`)}
            <div class="outdated-item">
              <InlineFinding prKey={ai.prKey} createdAt={ai.createdAt} finding={f} showPath {onevidence} />
            </div>
          {/each}
        </details>
      {/if}
    {:else}
      {#each paths as p (p)}
        {@render row(p)}
      {/each}
    {/if}
    {#if outdated.length > 0}
      <details class="outdated">
        <summary>Outdated threads ({outdated.length})</summary>
        {#each outdated as t (t.id)}
          <div class="outdated-item">
            <div class="path muted" title={t.path}>
              {t.path}{t.originalLine !== null ? `:${t.originalLine}` : ""}
            </div>
            <InlineThread threadId={t.id} {onevidence} />
          </div>
        {/each}
      </details>
    {/if}
  </div>
</section>

<style>
  .review-files {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    border-right: 1px solid var(--border);
    border-top: 1px solid var(--border);
    background: var(--sidebar-bg, var(--bar-bg));
  }
  .chapter {
    padding: 6px 8px;
    font-weight: 600;
    font-size: 0.85em;
    border-bottom: 1px solid var(--border);
  }
  .scroll {
    overflow-y: auto;
    min-height: 0;
  }
  .muted {
    color: var(--muted);
    font-weight: 400;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    text-align: left;
    padding: 4px 8px;
    border: none;
    border-radius: 0;
    background: transparent;
    cursor: pointer;
    font-size: 0.85em;
  }
  .row:hover {
    background: var(--hover);
  }
  .row.selected {
    background: var(--accent-soft);
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--mono);
  }
  .badge {
    flex: none;
    font-size: 0.85em;
    padding: 0 6px;
    border-radius: 8px;
    border: 1px solid var(--border);
    color: var(--muted);
  }
  .badge.draft {
    border-color: transparent;
    background: var(--accent-soft);
    color: var(--accent);
  }
  .outdated {
    border-top: 1px solid var(--border);
    padding: 4px 8px;
    font-size: 0.85em;
  }
  .outdated summary {
    cursor: pointer;
    font-weight: 600;
  }
  .outdated-item {
    margin-top: 6px;
  }
  .path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--mono);
  }
</style>
