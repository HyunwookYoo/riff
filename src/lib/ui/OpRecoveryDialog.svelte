<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import { enterChangesMode } from "$lib/sourceControl";
  import { confirmAction } from "$lib/dialogs";

  let busy = $state(false);

  function close() {
    if (busy) return;
    // The caller restored the raw message into appState.error on the failure
    // path, so cancelling hides nothing.
    appState.recovery = null;
  }

  async function run(strategy: "stash" | "discard") {
    const r = appState.recovery;
    if (!r || busy) return;
    if (strategy === "discard") {
      const ok = await confirmAction(
        "Discard local changes and overwrite any untracked files that are in the way, then continue? This cannot be undone.",
        { title: "Discard changes" },
      );
      if (!ok) return;
    }
    busy = true;
    try {
      await r.retry(strategy);
      appState.recovery = null;
    } catch (e) {
      // The retry's own wrapper already surfaces failures; clear the dialog and
      // make sure the message is visible.
      appState.recovery = null;
      appState.error = String(e);
    } finally {
      busy = false;
    }
  }

  function commitFirst() {
    if (busy) return;
    appState.recovery = null;
    void enterChangesMode();
  }

  function onKey(e: KeyboardEvent) {
    if (appState.recovery && e.key === "Escape") {
      e.stopImmediatePropagation();
      close();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if appState.recovery}
  {@const r = appState.recovery}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="backdrop" onclick={close} role="presentation">
    <div
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-label={r.title}
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
    >
      <h2>{r.title}</h2>
      <p>{r.reason}</p>

      {#if r.paths.length > 0}
        <ul class="paths">
          {#each r.paths as p (p)}
            <li><code>{p}</code></li>
          {/each}
        </ul>
      {/if}

      <div class="opts">
        <button
          type="button"
          class="opt"
          disabled={busy}
          onclick={() => run("stash")}
        >
          <span class="opt-title">Stash &amp; continue</span>
          <span class="opt-desc">
            Stash your changes, run the operation, then restore them. Reversible.
          </span>
        </button>
        {#if r.offerDiscard}
          <button
            type="button"
            class="opt danger"
            disabled={busy}
            onclick={() => run("discard")}
          >
            <span class="opt-title">Discard changes</span>
            <span class="opt-desc">
              Throw away local changes to tracked files and overwrite any
              untracked files in the way, then continue.
              <strong>Cannot be undone.</strong>
            </span>
          </button>
        {/if}
        <button type="button" class="opt" disabled={busy} onclick={commitFirst}>
          <span class="opt-title">Commit first</span>
          <span class="opt-desc">Go to the Working view to commit, then retry.</span>
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
  p {
    margin: 0 0 12px;
    color: var(--muted);
    font-size: 0.9em;
  }
  .paths {
    margin: 0 0 12px;
    padding-left: 18px;
    max-height: 140px;
    overflow: auto;
  }
  .paths li {
    font-size: 0.82em;
  }
  .paths code {
    font-family: var(--mono);
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
