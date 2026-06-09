<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import { runCheckout, type CheckoutStrategy } from "$lib/checkout";

  let busy = $state(false);
  let err = $state<string | null>(null);

  // Clear transient state when a new prompt opens (target changes) or it closes.
  let lastTarget = $state<string | null>(null);
  $effect(() => {
    const t = appState.checkoutPrompt?.target ?? null;
    if (t !== lastTarget) {
      lastTarget = t;
      err = null;
      busy = false;
    }
  });

  function close() {
    if (busy) return;
    appState.checkoutPrompt = null;
  }

  async function choose(strategy: CheckoutStrategy) {
    const p = appState.checkoutPrompt;
    if (!p || busy) return;
    busy = true;
    err = null;
    try {
      await runCheckout(p.repoPath, p.target, strategy);
      appState.checkoutPrompt = null;
    } catch (e) {
      // Keep the dialog open so the user can pick another strategy (e.g.
      // "Bring" failed on a conflict → try Stash instead).
      err = String(e);
      busy = false;
    }
  }

  function onKey(e: KeyboardEvent) {
    if (appState.checkoutPrompt && e.key === "Escape") {
      // Stop the page's global Esc handler from also firing (e.g. popping the
      // drill-in history) on the same keypress — regardless of listener order.
      e.stopImmediatePropagation();
      close();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if appState.checkoutPrompt}
  {@const target = appState.checkoutPrompt.target}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="backdrop" onclick={close} role="presentation">
    <div
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-label="Switch branch with local changes"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
    >
      <h2>Switch to <code>{target}</code></h2>
      <p>You have uncommitted changes. How should they be handled?</p>

      {#if err}
        <div class="err">{err}</div>
      {/if}

      <div class="opts">
        <button
          type="button"
          class="opt"
          disabled={busy}
          onclick={() => choose("stash")}
        >
          <span class="opt-title">Stash &amp; reapply</span>
          <span class="opt-desc"
            >Stash your changes, switch, then restore them onto
            <code>{target}</code>.</span
          >
        </button>
        <button
          type="button"
          class="opt"
          disabled={busy}
          onclick={() => choose("bring")}
        >
          <span class="opt-title">Bring changes</span>
          <span class="opt-desc"
            >Carry the changes over. Fails if they conflict with
            <code>{target}</code>.</span
          >
        </button>
        <button
          type="button"
          class="opt danger"
          disabled={busy}
          onclick={() => choose("discard")}
        >
          <span class="opt-title">Discard changes</span>
          <span class="opt-desc"
            >Throw away local changes to tracked files, then switch.
            <strong>Cannot be undone.</strong></span
          >
        </button>
      </div>

      <div class="actions">
        <button type="button" class="cancel" disabled={busy} onclick={close}>
          Cancel
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2000;
  }
  .dialog {
    width: 440px;
    max-width: calc(100vw - 32px);
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.35);
    padding: 16px 18px;
  }
  h2 {
    margin: 0 0 4px;
    font-size: 1.05em;
    font-weight: 600;
  }
  h2 code,
  .opt-desc code {
    font-family: var(--mono);
    font-size: 0.92em;
    padding: 0 3px;
    background: var(--input-bg);
    border-radius: 3px;
  }
  p {
    margin: 0 0 12px;
    color: var(--muted);
    font-size: 0.9em;
  }
  .err {
    margin-bottom: 12px;
    padding: 6px 10px;
    background: var(--error-bg);
    color: var(--error-fg);
    border-radius: 4px;
    font-size: 0.82em;
    white-space: pre-wrap;
  }
  .opts {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .opt {
    display: flex;
    flex-direction: column;
    gap: 2px;
    text-align: left;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--input-bg);
    color: inherit;
    cursor: pointer;
  }
  .opt:hover:not(:disabled) {
    background: var(--hover);
    border-color: var(--accent);
  }
  .opt:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .opt-title {
    font-weight: 600;
    font-size: 0.92em;
  }
  .opt-desc {
    font-size: 0.8em;
    color: var(--muted);
  }
  .opt.danger:hover:not(:disabled) {
    border-color: var(--error-fg, #d33);
  }
  .opt.danger .opt-title {
    color: var(--error-fg, #d33);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 14px;
  }
  .cancel {
    padding: 5px 14px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--input-bg);
    color: inherit;
    cursor: pointer;
  }
  .cancel:hover:not(:disabled) {
    background: var(--hover);
  }
</style>
