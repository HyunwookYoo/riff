<script lang="ts">
  import { answerPending, submitFlow } from "$lib/review/submitFlow.svelte";

  let dialogEl = $state<HTMLDivElement>();

  $effect(() => {
    if (submitFlow.dialog) queueMicrotask(() => dialogEl?.focus());
  });

  function onKey(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    answerPending(null);
  }
</script>

{#if submitFlow.dialog}
  {@const canAdd = submitFlow.dialog.choices.includes("add")}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="pr-backdrop" onclick={() => answerPending(null)} role="presentation">
    <div
      class="pr"
      role="dialog"
      aria-modal="true"
      aria-label="Pending review on GitHub"
      tabindex="-1"
      bind:this={dialogEl}
      onkeydown={onKey}
      onclick={(e) => e.stopPropagation()}
    >
      <div class="pr-body">
        <p>You have a pending review on GitHub for this PR (started elsewhere).</p>
        {#if canAdd}
          <p>Add these comments to it, or discard it?</p>
        {:else}
          <p>
            It is pinned to an older commit, so these comments can't be added to it. Discard it
            (including any comments in it) and submit this review instead?
          </p>
        {/if}
      </div>
      <div class="pr-foot">
        <span class="spacer"></span>
        <button type="button" onclick={() => answerPending(null)}>Cancel</button>
        <button type="button" onclick={() => answerPending("discard")}>Discard</button>
        {#if canAdd}
          <button type="button" class="primary" onclick={() => answerPending("add")}>Add</button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .pr-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 10vh;
    z-index: 2100;
  }
  .pr {
    width: 480px;
    max-width: calc(100vw - 32px);
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 12px 48px rgba(0, 0, 0, 0.4);
    outline: none;
  }
  .pr-body {
    padding: 8px 14px;
    font-size: 0.9em;
  }
  .pr-body p {
    margin: 6px 0;
  }
  .pr-foot {
    display: flex;
    gap: 8px;
    padding: 8px 14px;
    border-top: 1px solid var(--border);
  }
  .spacer {
    flex: 1;
  }
  .pr-foot button {
    padding: 4px 12px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--input-bg);
    color: var(--fg);
    cursor: pointer;
    font-size: 0.85em;
  }
  .pr-foot .primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
    font-weight: 600;
  }
</style>
