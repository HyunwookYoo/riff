<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import { doFetch, doPull } from "$lib/workingCopy";

  let menu = $state<"pull" | null>(null);
  const busy = $derived(appState.syncing);
  const behind = $derived(appState.currentBehind);
</script>

<svelte:window onclick={() => (menu = null)} />

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

    <div class="split">
      <button
        type="button"
        class="sbtn main"
        disabled={busy}
        title="Pull (merge)"
        onclick={() => void doPull(false)}
      >
        ↓ Pull{#if behind}&nbsp;{behind}{/if}
      </button>
      <button
        type="button"
        class="sbtn caret"
        disabled={busy}
        aria-label="Pull options"
        onclick={(e) => {
          e.stopPropagation();
          menu = menu === "pull" ? null : "pull";
        }}
      >
        ▾
      </button>
      {#if menu === "pull"}
        <div class="popover" role="menu">
          <button type="button" onclick={() => void doPull(false)}>
            Pull (merge)
          </button>
          <button type="button" onclick={() => void doPull(true)}>
            Pull (rebase)
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .sync {
    display: inline-flex;
    align-items: stretch;
    gap: 4px;
  }
  .split {
    display: inline-flex;
    position: relative;
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
  .split .main {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }
  .split .caret {
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
    border-left: none;
    padding: 3px 5px;
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
  .popover {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 3px;
    z-index: 100;
    min-width: 170px;
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: 5px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
    padding: 4px;
    display: flex;
    flex-direction: column;
  }
  .popover button {
    border: none;
    background: transparent;
    color: inherit;
    text-align: left;
    padding: 5px 10px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 0.85em;
  }
  .popover button:hover {
    background: var(--hover);
  }
</style>
