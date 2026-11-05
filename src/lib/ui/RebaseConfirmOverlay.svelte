<!-- src/lib/ui/RebaseConfirmOverlay.svelte -->
<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import { confirmRebase, shortTarget } from "$lib/rebase";
  import { aiRequest, startRebaseCheck, type CheckState } from "$lib/rebaseCheck";
  import RebaseCheckLine from "./RebaseCheckLine.svelte";

  let check = $state<CheckState | null>(null);
  let dialogEl = $state<HTMLDivElement>();

  // One check per open overlay; the teardown cancels it on close or re-open so
  // a stale result can never land.
  $effect(() => {
    const c = appState.rebaseConfirm;
    if (!c) {
      check = null;
      return;
    }
    queueMicrotask(() => dialogEl?.focus());
    return startRebaseCheck(c.repoPath, c.upstream, c.branch, null, (s) => (check = s));
  });

  function close() {
    appState.rebaseConfirm = null;
  }

  function onKey(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  }
</script>

{#if appState.rebaseConfirm}
  {@const c = appState.rebaseConfirm}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="rb-backdrop" onclick={close} role="presentation">
    <div
      class="rb"
      role="dialog"
      aria-modal="true"
      aria-label="Rebase"
      tabindex="-1"
      bind:this={dialogEl}
      onkeydown={onKey}
      onclick={(e) => e.stopPropagation()}
    >
      <div class="rb-head">
        <span>Rebase {c.what} onto {shortTarget(c.upstream)}</span>
        <button type="button" class="rb-x" aria-label="Close" onclick={close}>×</button>
      </div>
      <div class="rb-body">
        <p>
          {c.commits.length} commit{c.commits.length === 1 ? "" : "s"} will be rewritten.
          The pre-rebase tip stays recoverable from the reflog (Ctrl+Shift+R).
        </p>
        {#if c.switchesTo}
          <p>riff will end up on {c.switchesTo}.</p>
        {/if}
      </div>
      <RebaseCheckLine
        state={check}
        request={(conflict) =>
          aiRequest({
            repoPath: c.repoPath,
            branch: c.what,
            target: c.upstream,
            conflict,
          })}
      />
      <div class="rb-foot">
        <span class="rb-note"></span>
        <button type="button" class="rb-cancel" onclick={close}>Cancel</button>
        <button type="button" class="rb-start" onclick={() => void confirmRebase()}>
          Rebase
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .rb-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 10vh;
    z-index: 2100;
  }
  .rb {
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
  .rb-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    font-weight: 600;
  }
  .rb-x {
    border: none;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    font-size: 1.1em;
    line-height: 1;
  }
  .rb-x:hover {
    color: var(--accent);
  }
  .rb-body {
    overflow-y: auto;
    padding: 6px 14px 10px;
    font-size: 0.9em;
  }
  .rb-body p {
    margin: 6px 0;
  }
  .rb-foot {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    border-top: 1px solid var(--border);
  }
  .rb-note {
    flex: 1;
  }
  .rb-foot button {
    padding: 4px 12px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--input-bg);
    color: var(--fg);
    cursor: pointer;
    font-size: 0.85em;
  }
  .rb-foot .rb-start {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
    font-weight: 600;
  }
</style>
