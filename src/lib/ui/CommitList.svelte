<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import { openCommit, loadMoreCommits } from "$lib/commitHistory";
  import { computeGraph } from "./graph";

  // Lane gutter geometry. Row height is fixed so the SVG graph segments line
  // up across rows (a lane at column j exits one row's bottom edge exactly
  // where it enters the next row's top edge).
  const ROW_H = 40;
  const LANE_W = 14;
  const NODE_R = 4;
  // Lane colors, cycled by column. CSS vars so they track the theme palette,
  // with hard fallbacks for the few that may be unset.
  const COLORS = [
    "var(--accent, #4a9eff)",
    "#e0793b",
    "#46b06a",
    "#c2596d",
    "#9b6dc4",
    "#3fa7a7",
  ];
  const color = (i: number) => COLORS[((i % COLORS.length) + COLORS.length) % COLORS.length];

  const layout = $derived(computeGraph(appState.commits));
  const gutterW = $derived(Math.max(1, layout.maxLanes) * LANE_W);

  const laneX = (col: number) => col * LANE_W + LANE_W / 2;

  function relTime(unixSec: number): string {
    const now = Date.now() / 1000;
    const d = Math.max(0, now - unixSec);
    if (d < 60) return "just now";
    if (d < 3600) return `${Math.floor(d / 60)}m ago`;
    if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
    if (d < 86400 * 30) return `${Math.floor(d / 86400)}d ago`;
    if (d < 86400 * 365) return `${Math.floor(d / 86400 / 30)}mo ago`;
    return `${Math.floor(d / 86400 / 365)}y ago`;
  }

  // Strip the "HEAD -> " prefix and "tag: " marker for a compact chip label.
  function refLabel(ref: string): { text: string; kind: string } {
    if (ref.startsWith("HEAD -> ")) return { text: ref.slice(8), kind: "head" };
    if (ref === "HEAD") return { text: "HEAD", kind: "head" };
    if (ref.startsWith("tag: ")) return { text: ref.slice(5), kind: "tag" };
    return { text: ref, kind: "branch" };
  }

  function onScroll(e: Event) {
    const el = e.currentTarget as HTMLElement;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - ROW_H * 4) {
      void loadMoreCommits();
    }
  }
</script>

<div class="commit-list" onscroll={onScroll}>
  {#if appState.commits.length === 0 && appState.loadingCommits}
    <div class="empty">Loading history…</div>
  {:else if appState.commits.length === 0}
    <div class="empty">No commits.</div>
  {:else}
    {#each appState.commits as commit, i (commit.sha)}
      {@const row = layout.rows[i]}
      <button
        type="button"
        class="row"
        class:selected={commit.sha === appState.selectedCommitSha}
        style="height: {ROW_H}px;"
        onclick={() => openCommit(commit)}
        title={commit.summary}
      >
        <svg class="graph" width={gutterW} height={ROW_H} style="flex: 0 0 {gutterW}px;">
          {#each row?.segments ?? [] as seg}
            <line
              x1={laneX(seg.x1)}
              y1={seg.y1 * ROW_H}
              x2={laneX(seg.x2)}
              y2={seg.y2 * ROW_H}
              stroke={color(seg.color)}
              stroke-width="1.5"
              fill="none"
            />
          {/each}
          {#if row}
            <circle
              cx={laneX(row.col)}
              cy={ROW_H / 2}
              r={NODE_R}
              fill={color(row.color)}
              stroke="var(--bg)"
              stroke-width="1.5"
            />
          {/if}
        </svg>
        <span class="info">
          <span class="line1">
            {#each commit.refs as ref}
              {@const r = refLabel(ref)}
              <span class="ref {r.kind}">{r.text}</span>
            {/each}
            <span class="summary">{commit.summary}</span>
          </span>
          <span class="line2">
            <span class="sha">{commit.short_sha}</span>
            <span class="author">{commit.author}</span>
            <span class="time">{relTime(commit.time)}</span>
          </span>
        </span>
      </button>
    {/each}
    {#if appState.loadingCommits}
      <div class="empty small">Loading more…</div>
    {/if}
  {/if}
</div>

<style>
  .commit-list {
    overflow-y: auto;
    overflow-x: hidden;
    height: 100%;
    min-height: 0;
    background: var(--bg);
  }
  .row {
    display: flex;
    align-items: stretch;
    width: 100%;
    border: none;
    border-bottom: 1px solid var(--border);
    background: transparent;
    color: inherit;
    text-align: left;
    padding: 0;
    cursor: pointer;
    font: inherit;
  }
  .row:hover {
    background: var(--hover);
  }
  .row.selected {
    background: var(--accent-soft);
    box-shadow: inset 2px 0 0 var(--accent);
  }
  .graph {
    display: block;
  }
  .info {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 2px;
    min-width: 0;
    padding: 4px 8px 4px 2px;
    flex: 1;
  }
  .line1 {
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
  }
  .summary {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.85em;
  }
  .line2 {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.72em;
    color: var(--muted);
    font-family: var(--mono);
  }
  .sha {
    color: var(--accent);
  }
  .author {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 45%;
  }
  .time {
    margin-left: auto;
    flex: 0 0 auto;
  }
  .ref {
    flex: 0 0 auto;
    font-size: 0.85em;
    padding: 0 5px;
    border-radius: 8px;
    line-height: 1.5;
    font-family: var(--mono);
    border: 1px solid var(--border);
  }
  .ref.head {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: var(--accent);
  }
  .ref.tag {
    background: var(--info-bg, var(--hover));
    color: var(--info-fg, inherit);
  }
  .ref.branch {
    background: var(--hover);
  }
  .empty {
    padding: 16px;
    color: var(--muted);
    font-size: 0.85em;
    text-align: center;
  }
  .empty.small {
    padding: 8px;
    font-size: 0.78em;
  }
</style>
