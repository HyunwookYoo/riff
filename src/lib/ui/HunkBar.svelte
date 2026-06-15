<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import { fileHunks } from "$lib/git";
  import { changesRepoPath } from "$lib/sourceControl";
  import { assignHunk, hunkChangelistId } from "$lib/changelists";
  import type { Hunk } from "$lib/types";

  let hunks = $state<Hunk[]>([]);
  // Monotonic guard so a slower fileHunks() for an older file can't overwrite a
  // newer one's result.
  let session = 0;

  $effect(() => {
    // Re-list whenever the selected file or the status (a re-diff) changes.
    void appState.selectedFile;
    void appState.changesSide;
    void appState.repoStatus;
    void loadHunks();
  });

  async function loadHunks() {
    const file = appState.selectedFile;
    const s = ++session;
    // Only the unstaged side of the Changes screen — that's the working-tree
    // change a changelist commits.
    if (
      !file ||
      appState.appMode !== "changes" ||
      appState.changesSide !== "unstaged"
    ) {
      hunks = [];
      return;
    }
    try {
      const h = await fileHunks(changesRepoPath(), file.path, false);
      if (s !== session) return;
      hunks = h;
      // Cache (with ids) so the changelist list can show per-list hunk counts
      // and the commit can resolve ids → indices.
      appState.hunksByFile = { ...appState.hunksByFile, [file.path]: h };
    } catch {
      if (s === session) hunks = [];
    }
  }
</script>

{#if hunks.length > 1 && appState.selectedFile}
  {@const file = appState.selectedFile.path}
  <div class="hunkbar">
    <div class="hb-head">Assign hunks to a changelist</div>
    {#each hunks as h, i (h.id + ":" + i)}
      {@const cl = hunkChangelistId(file, h.id)}
      <div class="hunk" class:moved={cl !== appState.activeChangelistId}>
        <select
          class="hb-list"
          value={cl}
          onchange={(e) => assignHunk(file, h.id, e.currentTarget.value)}
          title="Changelist for this hunk"
        >
          {#each appState.changelists as l (l.id)}
            <option value={l.id}>{l.name}</option>
          {/each}
        </select>
        <span class="stat">
          <span class="add">+{h.added}</span>
          <span class="del">−{h.removed}</span>
        </span>
        <span class="hdr" title={h.header}>{h.header}</span>
      </div>
    {/each}
  </div>
{/if}

<style>
  .hunkbar {
    display: flex;
    flex-direction: column;
    max-height: 32%;
    overflow-y: auto;
    border-bottom: 1px solid var(--border);
    background: var(--bar-bg);
    flex-shrink: 0;
  }
  .hb-head {
    position: sticky;
    top: 0;
    padding: 3px 10px;
    font-size: 0.7em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
    background: var(--bar-bg);
    border-bottom: 1px solid var(--border);
  }
  .hunk {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 10px;
    font-size: 0.8em;
    font-family: var(--mono);
    border-top: 1px solid var(--border);
  }
  .hunk:first-of-type {
    border-top: none;
  }
  .hunk.moved {
    background: var(--accent-soft);
  }
  .hb-list {
    flex: 0 0 auto;
    max-width: 42%;
    padding: 1px 4px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: var(--input-bg);
    color: inherit;
    cursor: pointer;
    font-size: 0.95em;
    font-family: inherit;
  }
  .hb-list:hover {
    border-color: var(--accent);
  }
  .stat {
    flex: 0 0 auto;
    font-variant-numeric: tabular-nums;
  }
  .stat .add {
    color: var(--diff-add-border, #2ea043);
  }
  .stat .del {
    color: var(--diff-del-border, #f85149);
  }
  .hdr {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    opacity: 0.8;
  }
</style>
