<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import { applyHunks, fileHunks } from "$lib/git";
  import { changesRepoPath, loadStatus } from "$lib/sourceControl";
  import type { Hunk } from "$lib/types";

  let hunks = $state<Hunk[]>([]);
  let busy = $state(false);
  // Monotonic guard so a slower fileHunks() for an older file/side can't
  // overwrite a newer one's result.
  let session = 0;

  const verb = $derived(appState.changesSide === "staged" ? "Unstage" : "Stage");

  $effect(() => {
    // Re-list whenever the selected file or side changes.
    void appState.selectedFile;
    void appState.changesSide;
    void loadHunks();
  });

  async function loadHunks() {
    const file = appState.selectedFile;
    const s = ++session;
    if (!file || appState.appMode !== "changes") {
      hunks = [];
      return;
    }
    try {
      const h = await fileHunks(
        changesRepoPath(),
        file.path,
        appState.changesSide === "staged",
      );
      if (s === session) hunks = h;
    } catch {
      if (s === session) hunks = [];
    }
  }

  async function apply(i: number) {
    const file = appState.selectedFile;
    if (!file || busy) return;
    busy = true;
    try {
      await applyHunks(
        changesRepoPath(),
        file.path,
        appState.changesSide === "staged",
        [i],
      );
    } catch (e) {
      appState.error = String(e);
    } finally {
      busy = false;
      // Refresh lists + diff; the $effect re-lists the remaining hunks once
      // loadStatus re-selects the (new) file object.
      await loadStatus();
    }
  }
</script>

{#if hunks.length > 1}
  <div class="hunkbar">
    {#each hunks as h, i (i)}
      <div class="hunk">
        <button
          type="button"
          class="apply"
          disabled={busy}
          onclick={() => apply(i)}
          title="{verb} this hunk"
        >
          {verb}
        </button>
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
    max-height: 30%;
    overflow-y: auto;
    border-bottom: 1px solid var(--border);
    background: var(--bar-bg);
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
  .hunk:first-child {
    border-top: none;
  }
  .apply {
    flex: 0 0 auto;
    padding: 1px 8px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: var(--input-bg);
    color: inherit;
    cursor: pointer;
    font-size: 0.95em;
  }
  .apply:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
  }
  .apply:disabled {
    opacity: 0.5;
    cursor: default;
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
