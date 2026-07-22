<!-- src/lib/ui/StashesOverlay.svelte -->
<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import {
    loadStashes,
    doStashApply,
    doStashDrop,
    doStashSave,
  } from "$lib/sourceControl";

  let dialogEl = $state<HTMLDivElement>();

  // Inline "save new stash" field.
  let saving = $state(false);
  let saveMsg = $state("");
  let saveInputEl = $state<HTMLInputElement | null>(null);

  let wasOpen = false;
  $effect(() => {
    if (appState.stashesOpen && !wasOpen) {
      queueMicrotask(() => dialogEl?.focus());
      void loadStashes();
    }
    if (!appState.stashesOpen) {
      saving = false;
      saveMsg = "";
    }
    wasOpen = appState.stashesOpen;
  });

  $effect(() => {
    if (saving) saveInputEl?.focus();
  });

  function close() {
    appState.stashesOpen = false;
  }

  function onKey(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    // Escape backs out of the inline save field first, then the panel.
    if (saving) {
      saving = false;
      saveMsg = "";
      return;
    }
    close();
  }

  function submitSave(e: Event) {
    e.preventDefault();
    const msg = saveMsg.trim();
    saving = false;
    saveMsg = "";
    void doStashSave(msg || undefined);
  }
</script>

{#if appState.stashesOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="sp-backdrop" onclick={close} role="presentation">
    <div
      class="sp"
      role="dialog"
      aria-modal="true"
      aria-label="Stashes"
      tabindex="-1"
      bind:this={dialogEl}
      onkeydown={onKey}
      onclick={(e) => e.stopPropagation()}
    >
      <div class="sp-head">
        <span>Stashes</span>
        <button type="button" class="sp-x" aria-label="Close" onclick={close}
          >×</button
        >
      </div>
      <div class="sp-body">
        {#if appState.stashes.length === 0}
          <div class="sp-empty">No stashes</div>
        {:else}
          {#each appState.stashes as s (s.index)}
            <div class="sp-row">
              <span class="sp-msg" title={s.message}>{s.message}</span>
              <div class="sp-actions">
                <button type="button" onclick={() => void doStashApply(s.index, true)}
                  >Pop</button
                >
                <button type="button" onclick={() => void doStashApply(s.index, false)}
                  >Apply</button
                >
                <button
                  type="button"
                  class="sp-drop"
                  onclick={() => void doStashDrop(s.index)}>Drop</button
                >
              </div>
            </div>
          {/each}
        {/if}
      </div>
      <div class="sp-foot">
        {#if saving}
          <form class="sp-save" onsubmit={submitSave}>
            <input
              bind:this={saveInputEl}
              bind:value={saveMsg}
              placeholder="Stash message (optional)"
              aria-label="Stash message"
            />
          </form>
        {:else}
          <button type="button" class="sp-new" onclick={() => (saving = true)}>
            ＋ Save new stash
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .sp-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 10vh;
    z-index: 2100;
  }
  .sp {
    width: 520px;
    max-width: calc(100vw - 32px);
    max-height: 76vh;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 12px 48px rgba(0, 0, 0, 0.4);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    outline: none;
  }
  .sp-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    font-weight: 600;
  }
  .sp-x {
    border: none;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    font-size: 1.1em;
    line-height: 1;
  }
  .sp-x:hover {
    color: var(--accent);
  }
  .sp-body {
    overflow-y: auto;
    padding: 6px 8px;
  }
  .sp-empty {
    padding: 12px;
    color: var(--muted);
    font-size: 0.88em;
  }
  .sp-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 6px;
    border-radius: 4px;
  }
  .sp-row:hover {
    background: var(--hover);
  }
  .sp-msg {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.86em;
    font-family: var(--mono);
  }
  .sp-actions {
    flex: 0 0 auto;
    display: inline-flex;
    gap: 4px;
    opacity: 0;
  }
  .sp-row:hover .sp-actions,
  .sp-actions:focus-within {
    opacity: 1;
  }
  .sp-actions button {
    border: 1px solid var(--border);
    border-radius: 3px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    padding: 1px 8px;
    font-size: 0.78em;
    line-height: 1.4;
  }
  .sp-actions button:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .sp-actions .sp-drop:hover {
    border-color: var(--error-fg, #f85149);
    color: var(--error-fg, #f85149);
  }
  .sp-foot {
    border-top: 1px solid var(--border);
    padding: 6px 8px;
  }
  .sp-new {
    width: 100%;
    padding: 5px 8px;
    border: 1px dashed var(--border);
    border-radius: 4px;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    font-size: 0.82em;
    text-align: left;
  }
  .sp-new:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .sp-save input {
    width: 100%;
    box-sizing: border-box;
    padding: 4px 8px;
    border: 1px solid var(--accent);
    border-radius: 4px;
    background: var(--input-bg);
    color: var(--fg);
    font-size: 0.82em;
  }
</style>
