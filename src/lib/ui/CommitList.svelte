<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import { openCommit, loadCommits, loadMoreCommits } from "$lib/commitHistory";
  import { changesRepoPath, loadCurrentBranch } from "$lib/sourceControl";
  import {
    checkout,
    cherryPick,
    createBranch,
    createTag,
    rebase,
    reset,
    revert,
  } from "$lib/git";
  import type { Commit } from "$lib/types";
  import { computeGraph } from "./graph";

  let busy = $state(false);
  // Run a commit-graph action, then reload the log + current-branch chip.
  // On failure keep the error and skip the reload — loadCommits() clears
  // appState.error, which would otherwise swallow the message.
  async function act(op: Promise<void>) {
    if (busy) return;
    busy = true;
    try {
      await op;
    } catch (e) {
      appState.error = String(e);
      busy = false;
      return;
    }
    busy = false;
    await loadCommits();
    void loadCurrentBranch();
  }

  // Right-click context menu on a commit.
  let menu = $state<{ x: number; y: number; sha: string } | null>(null);
  function openMenu(e: MouseEvent, commit: Commit) {
    e.preventDefault();
    menu = { x: e.clientX, y: e.clientY, sha: commit.sha };
  }

  // Inline name entry for "new branch here" / "tag here".
  let editor = $state<{ kind: "branch" | "tag"; sha: string } | null>(null);
  let editVal = $state("");
  function openEditor(kind: "branch" | "tag", sha: string) {
    menu = null;
    editor = { kind, sha };
    editVal = "";
  }
  function submitEditor(e: Event) {
    e.preventDefault();
    const ed = editor;
    const v = editVal.trim();
    editor = null;
    if (!ed || !v) return;
    const p = changesRepoPath();
    // Create at the commit without switching the working tree (works even
    // with uncommitted changes; checking out an arbitrary commit would fail
    // on a dirty tree). Switch via the sidebar if desired.
    if (ed.kind === "branch") void act(createBranch(p, v, ed.sha, false));
    else void act(createTag(p, v, ed.sha));
  }

  function doCheckout(sha: string) {
    void act(checkout(changesRepoPath(), sha));
  }
  // Double-click a branch label in the graph to check it out (with confirm).
  // A remote-tracking label (origin/x) DWIMs into a local branch of the same
  // short name — checking out "origin/x" verbatim would detach HEAD. Local
  // branches (even "feature/foo") are checked out as-is; the kind comes from
  // the repo's ref list so a slash in a local name isn't mis-stripped.
  function confirmCheckoutRef(name: string) {
    const refs = appState.branchesByRepoIdx[appState.changesRepoIdx] ?? [];
    const isRemote = refs.find((r) => r.name === name)?.kind === "remote";
    const target = isRemote ? name.replace(/^[^/]+\//, "") : name;
    if (!confirm(`Check out '${target}'? This switches your working tree.`)) {
      return;
    }
    void act(checkout(changesRepoPath(), target));
  }
  function doReset(sha: string, mode: "soft" | "mixed" | "hard") {
    if (
      mode === "hard" &&
      !confirm("Hard reset discards uncommitted working-tree changes. Continue?")
    )
      return;
    void act(reset(changesRepoPath(), sha, mode));
  }
  function doCherryPick(sha: string) {
    void act(cherryPick(changesRepoPath(), sha));
  }
  function doRevert(sha: string) {
    void act(revert(changesRepoPath(), sha));
  }
  function doRebase(sha: string) {
    if (!confirm(`Rebase the current branch onto ${sha.slice(0, 7)}?`)) return;
    void act(rebase(changesRepoPath(), sha));
  }

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

<svelte:window onclick={() => (menu = null)} />

<div class="cl-wrap">
  {#if editor}
  <form class="cl-editor" onsubmit={submitEditor}>
    <span class="cl-editor-label">
      {editor.kind === "branch" ? "New branch at" : "Tag at"}
      {editor.sha.slice(0, 7)}
    </span>
    <!-- svelte-ignore a11y_autofocus -->
    <input
      bind:value={editVal}
      placeholder={editor.kind === "branch" ? "branch name" : "tag name"}
      autofocus
      onkeydown={(e) => e.key === "Escape" && (editor = null)}
    />
  </form>
{/if}

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
        oncontextmenu={(e) => openMenu(e, commit)}
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
              {#if r.kind === "branch"}
                <span
                  class="ref branch"
                  style={row ? `--c: ${color(row.color)}` : ""}
                  role="button"
                  tabindex="0"
                  title="Double-click to checkout {r.text}"
                  onclick={(e) => e.stopPropagation()}
                  ondblclick={(e) => {
                    e.stopPropagation();
                    confirmCheckoutRef(r.text);
                  }}
                  onkeydown={(e) => {
                    if (e.key === "Enter") {
                      e.stopPropagation();
                      confirmCheckoutRef(r.text);
                    }
                  }}>{r.text}</span
                >
              {:else if r.kind === "head"}
                <span class="ref head">
                  <span class="check" aria-hidden="true">✓</span>{r.text}
                </span>
              {:else}
                <span class="ref tag">{r.text}</span>
              {/if}
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
</div>

{#if menu}
  {@const sha = menu.sha}
  <div class="ctxmenu" style="left: {menu.x}px; top: {menu.y}px" role="menu">
    <button type="button" role="menuitem" onclick={() => openEditor("branch", sha)}>
      New branch here…
    </button>
    <button type="button" role="menuitem" onclick={() => openEditor("tag", sha)}>
      Tag here…
    </button>
    <button type="button" role="menuitem" onclick={() => doCheckout(sha)}>
      Checkout (detached)
    </button>
    <div class="sep"></div>
    <button type="button" role="menuitem" onclick={() => doCherryPick(sha)}>
      Cherry-pick onto current
    </button>
    <button type="button" role="menuitem" onclick={() => doRevert(sha)}>
      Revert
    </button>
    <button type="button" role="menuitem" onclick={() => doRebase(sha)}>
      Rebase current onto this…
    </button>
    <div class="sep"></div>
    <button type="button" role="menuitem" onclick={() => doReset(sha, "mixed")}>
      Reset (mixed) here
    </button>
    <button type="button" role="menuitem" onclick={() => doReset(sha, "soft")}>
      Reset (soft) here
    </button>
    <button
      type="button"
      role="menuitem"
      class="danger"
      onclick={() => doReset(sha, "hard")}
    >
      Reset (hard) here
    </button>
  </div>
{/if}

<style>
  .cl-wrap {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .cl-editor {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
    background: var(--accent-soft);
    flex-shrink: 0;
  }
  .cl-editor-label {
    font-size: 0.72em;
    color: var(--muted);
    font-family: var(--mono);
  }
  .cl-editor input {
    width: 100%;
    box-sizing: border-box;
    padding: 4px 6px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: var(--input-bg);
    color: inherit;
    font-size: 0.82em;
    font-family: var(--mono);
  }
  .commit-list {
    overflow-y: auto;
    overflow-x: hidden;
    flex: 1;
    min-height: 0;
    background: var(--bg);
  }
  .ctxmenu {
    position: fixed;
    z-index: 100;
    min-width: 200px;
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: 5px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
    padding: 4px;
    display: flex;
    flex-direction: column;
  }
  .ctxmenu button {
    border: none;
    background: transparent;
    color: inherit;
    text-align: left;
    padding: 5px 10px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 0.85em;
  }
  .ctxmenu button:hover {
    background: var(--hover);
  }
  .ctxmenu button.danger {
    color: var(--error-fg, #f85149);
  }
  .ctxmenu .sep {
    height: 1px;
    background: var(--border);
    margin: 4px 0;
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
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
    font-weight: 700;
  }
  .ref.head .check {
    margin-right: 3px;
    font-weight: 900;
  }
  .ref.tag {
    background: var(--info-bg, var(--hover));
    color: var(--info-fg, inherit);
  }
  .ref.branch {
    background: transparent;
    color: var(--c, inherit);
    border-color: var(--c, var(--border));
    font-weight: 600;
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
