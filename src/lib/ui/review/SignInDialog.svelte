<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { ghLogin } from "$lib/review/gh";
  import { refreshList } from "$lib/review/reviewState.svelte";

  let { host, onclose }: { host: string; onclose: () => void } = $props();

  let device = $state<{ code: string; url: string } | null>(null);
  let error = $state<string | null>(null);
  let run: { cancel: () => void } | null = null;
  let dialogEl = $state<HTMLDivElement>();

  function start() {
    device = null;
    error = null;
    const r = ghLogin(host, (c) => {
      if (run === r) device = c;
    });
    run = r;
    r.done.then(
      () => {
        if (run !== r) return;
        run = null;
        onclose();
        void refreshList();
      },
      (e) => {
        if (run !== r) return;
        run = null;
        error = String(e);
      },
    );
  }

  function close() {
    run?.cancel();
    run = null;
    onclose();
  }

  function copyAndOpen() {
    if (!device) return;
    void navigator.clipboard.writeText(device.code).catch(() => {});
    void openUrl(device.url).catch(() => {});
  }

  onMount(() => {
    start();
    queueMicrotask(() => dialogEl?.focus());
  });
  onDestroy(() => run?.cancel());

  function onKey(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="si-backdrop" onclick={close} role="presentation">
  <div
    class="si"
    role="dialog"
    aria-modal="true"
    aria-label="Sign in to {host}"
    tabindex="-1"
    bind:this={dialogEl}
    onkeydown={onKey}
    onclick={(e) => e.stopPropagation()}
  >
    <div class="si-body">
      <p class="si-title">Sign in to {host}</p>
      {#if error}
        <p>Sign-in failed:</p>
        <pre class="si-error">{error}</pre>
      {:else if device}
        <p>Enter this code in the browser:</p>
        <div class="si-code">{device.code}</div>
        <p class="si-url">{device.url}</p>
      {:else}
        <p class="si-wait">Waiting for gh…</p>
      {/if}
    </div>
    <div class="si-foot">
      <span class="spacer"></span>
      {#if error}
        <button type="button" onclick={close}>Close</button>
        <button type="button" class="primary" onclick={start}>Retry</button>
      {:else}
        <button type="button" onclick={close}>Cancel</button>
        {#if device}
          <button type="button" class="primary" onclick={copyAndOpen}>Copy code &amp; open browser</button>
        {/if}
      {/if}
    </div>
  </div>
</div>

<style>
  .si-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 10vh;
    z-index: 2100;
  }
  .si {
    width: 480px;
    max-width: calc(100vw - 32px);
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 12px 48px rgba(0, 0, 0, 0.4);
    outline: none;
  }
  .si-body {
    padding: 8px 14px;
    font-size: 0.9em;
  }
  .si-body p {
    margin: 6px 0;
  }
  .si-title {
    font-weight: 600;
  }
  .si-wait,
  .si-url {
    color: var(--muted);
  }
  .si-url {
    font-family: var(--mono);
    user-select: all;
    word-break: break-all;
  }
  .si-code {
    margin: 10px 0;
    font-family: var(--mono);
    font-size: 2em;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-align: center;
    user-select: all;
  }
  .si-error {
    margin: 6px 0;
    font-family: var(--mono);
    font-size: 0.9em;
    white-space: pre-wrap;
    word-break: break-word;
    user-select: text;
  }
  .si-foot {
    display: flex;
    gap: 8px;
    padding: 8px 14px;
    border-top: 1px solid var(--border);
  }
  .spacer {
    flex: 1;
  }
  .si-foot button {
    padding: 4px 12px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--input-bg);
    color: var(--fg);
    cursor: pointer;
    font-size: 0.85em;
  }
  .si-foot .primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
    font-weight: 600;
  }
</style>
