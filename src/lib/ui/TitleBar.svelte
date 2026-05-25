<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";

  const win = getCurrentWindow();
  let isMaximized = $state(false);
  let unlistenResize: (() => void) | undefined;

  onMount(async () => {
    isMaximized = await win.isMaximized();
    // Toggle the maximize/restore glyph as the user uses Win+Up/Down,
    // snap regions, or the title-bar button itself.
    unlistenResize = await win.onResized(async () => {
      isMaximized = await win.isMaximized();
    });
  });

  onDestroy(() => unlistenResize?.());

  function minimize() {
    void win.minimize();
  }
  function toggleMaximize() {
    void win.toggleMaximize();
  }
  function close() {
    void win.close();
  }
</script>

<!-- Outer bar is the drag region. Inner controls opt out by simply not
     carrying the data attribute. -->
<div class="title-bar" data-tauri-drag-region>
  <div class="title" data-tauri-drag-region>
    <img
      class="app-icon"
      src="/app-icon.png"
      alt=""
      draggable="false"
      data-tauri-drag-region
    />
    <span class="app-name" data-tauri-drag-region>Riff</span>
  </div>
  <div class="controls">
    <button
      type="button"
      class="ctrl"
      onclick={minimize}
      title="Minimize"
      aria-label="Minimize"
    >
      <svg viewBox="0 0 10 10" aria-hidden="true">
        <path d="M0 5 H10" stroke="currentColor" stroke-width="1" />
      </svg>
    </button>
    <button
      type="button"
      class="ctrl"
      onclick={toggleMaximize}
      title={isMaximized ? "Restore" : "Maximize"}
      aria-label={isMaximized ? "Restore" : "Maximize"}
    >
      {#if isMaximized}
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path
            d="M2.5 2.5 H9.5 V9.5 H2.5 Z M0.5 0.5 H7.5 V7.5 M0.5 0.5 V7.5 H2.5"
            stroke="currentColor"
            fill="none"
            stroke-width="1"
          />
        </svg>
      {:else}
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <rect
            x="0.5"
            y="0.5"
            width="9"
            height="9"
            stroke="currentColor"
            fill="none"
            stroke-width="1"
          />
        </svg>
      {/if}
    </button>
    <button
      type="button"
      class="ctrl close"
      onclick={close}
      title="Close"
      aria-label="Close"
    >
      <svg viewBox="0 0 10 10" aria-hidden="true">
        <path
          d="M0 0 L10 10 M10 0 L0 10"
          stroke="currentColor"
          stroke-width="1"
        />
      </svg>
    </button>
  </div>
</div>

<style>
  .title-bar {
    display: flex;
    align-items: stretch;
    height: 32px;
    background: var(--bar-bg);
    border-bottom: 1px solid var(--border);
    user-select: none;
    flex-shrink: 0;
  }
  .title {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 12px;
    font-size: 12px;
    color: var(--muted);
    overflow: hidden;
    min-width: 0;
  }
  .app-icon {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
    image-rendering: -webkit-optimize-contrast;
  }
  .app-name {
    font-weight: 600;
    color: var(--fg);
    letter-spacing: 0.02em;
  }
  .controls {
    display: flex;
    align-items: stretch;
  }
  .ctrl {
    width: 46px;
    border: none;
    background: transparent;
    color: var(--fg);
    cursor: pointer;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    -webkit-app-region: no-drag;
  }
  .ctrl svg {
    width: 10px;
    height: 10px;
    overflow: visible;
  }
  .ctrl:hover {
    background: var(--hover);
  }
  .ctrl.close:hover {
    background: #e81123;
    color: white;
  }
</style>
