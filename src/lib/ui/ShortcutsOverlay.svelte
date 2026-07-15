<!-- src/lib/ui/ShortcutsOverlay.svelte -->
<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import { SHORTCUTS } from "$lib/shortcuts";

  // Focus the dialog on open so it owns Esc / ? to close (mirrors the palette,
  // which owns keys via its focused input).
  let dialogEl = $state<HTMLDivElement>();
  let wasOpen = false;
  $effect(() => {
    if (appState.shortcutsOpen && !wasOpen) {
      queueMicrotask(() => dialogEl?.focus());
    }
    wasOpen = appState.shortcutsOpen;
  });

  function close() {
    appState.shortcutsOpen = false;
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape" || e.key === "?") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }
</script>

{#if appState.shortcutsOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="sc-backdrop" onclick={close} role="presentation">
    <div
      class="sc"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      tabindex="-1"
      bind:this={dialogEl}
      onkeydown={onKey}
      onclick={(e) => e.stopPropagation()}
    >
      <div class="sc-head">
        <span>Keyboard shortcuts</span>
        <button type="button" class="sc-x" aria-label="Close" onclick={close}
          >×</button
        >
      </div>
      <div class="sc-body">
        {#each SHORTCUTS as group (group.title)}
          <div class="sc-group">
            <div class="sc-group-title">{group.title}</div>
            {#each group.items as s (s.keys + s.desc)}
              <div class="sc-row">
                <span class="sc-desc">{s.desc}</span>
                <kbd class="sc-keys">{s.keys}</kbd>
              </div>
            {/each}
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .sc-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 10vh;
    z-index: 2100;
  }
  .sc {
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
  .sc-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    font-weight: 600;
  }
  .sc-x {
    border: none;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    font-size: 1.1em;
    line-height: 1;
  }
  .sc-x:hover {
    color: var(--accent);
  }
  .sc-body {
    overflow-y: auto;
    padding: 8px 14px 14px;
  }
  .sc-group {
    margin-top: 10px;
  }
  .sc-group-title {
    font-size: 0.72em;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
    margin-bottom: 4px;
  }
  .sc-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 3px 0;
    font-size: 0.9em;
  }
  .sc-keys {
    flex: 0 0 auto;
    font-family: var(--mono);
    font-size: 0.85em;
    color: var(--fg);
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 6px;
    white-space: nowrap;
  }
  .sc-desc {
    color: var(--fg);
  }
</style>
