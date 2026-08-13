<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import { doFetch, doPull } from "$lib/workingCopy";

  const busy = $derived(appState.syncing);
  const behind = $derived(appState.currentBehind);
</script>

{#if appState.repoPath}
  <div class="sync">
    <button
      type="button"
      class="sbtn"
      disabled={busy}
      title="Fetch all remotes"
      onclick={() => void doFetch()}
    >
      <span class="ico" class:spin={busy}>⟳</span>
    </button>

    <button
      type="button"
      class="sbtn"
      disabled={busy}
      title="Pull (fetch + merge)"
      onclick={() => void doPull()}
    >
      ↓ Pull{#if behind}&nbsp;{behind}{/if}
    </button>
  </div>
{/if}

<style>
  .sync {
    display: inline-flex;
    align-items: stretch;
    gap: 4px;
  }
  .sbtn {
    border: 1px solid var(--border);
    background: var(--input-bg);
    color: inherit;
    cursor: pointer;
    font-size: 0.8em;
    padding: 3px 8px;
    border-radius: 4px;
    white-space: nowrap;
  }
  .sbtn:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
  }
  .sbtn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  /* Spin just the refresh glyph, not the whole button box — the operation now
     runs async (UI stays live), so a rotating bordered button would be visible
     the entire time and looks off. inline-block so the transform applies. */
  .ico {
    display: inline-block;
  }
  .ico.spin {
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
