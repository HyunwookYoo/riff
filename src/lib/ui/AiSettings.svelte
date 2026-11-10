<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import { setAiEffort, setAiModel } from "$lib/git";
  import { choiceFromForm, formFromChoice, type ChoiceForm } from "$lib/review/ai/modelChoice";
  import AiModelFields from "./review/AiModelFields.svelte";

  let open_ = $state(false);
  let form = $state<ChoiceForm>({ model: "", custom: "", effort: "" });

  function toggle() {
    if (!open_) form = formFromChoice({ model: appState.aiModel, effort: appState.aiEffort });
    open_ = !open_;
  }

  // Saved as soon as the form holds a valid choice; an invalid custom id keeps the last one.
  function change(f: ChoiceForm) {
    form = f;
    const c = choiceFromForm(f);
    if (!c) return;
    if (c.model !== appState.aiModel) {
      appState.aiModel = c.model;
      void setAiModel(c.model);
    }
    if (c.effort !== appState.aiEffort) {
      appState.aiEffort = c.effort;
      void setAiEffort(c.effort);
    }
  }
</script>

<div class="ai-settings">
  <button
    type="button"
    class="trigger"
    class:active={open_}
    class:configured={!!appState.aiModel || !!appState.aiEffort}
    title="AI review settings"
    onclick={toggle}
  >
    AI
  </button>
  {#if open_}
    <button type="button" class="backdrop" aria-label="Close" onclick={() => (open_ = false)}></button>
    <div class="panel" role="dialog" aria-label="AI review settings">
      <div class="heading">AI review</div>
      <AiModelFields {form} onchange={change} />
      <p class="hint">Applies to AI review and re-review. Uses your Claude Code login.</p>
    </div>
  {/if}
</div>

<style>
  .ai-settings {
    position: relative;
    display: inline-flex;
  }
  .trigger {
    padding: 2px 8px;
    border: 1px solid var(--border);
    background: var(--input-bg);
    color: inherit;
    border-radius: 3px;
    cursor: pointer;
    font-size: 0.85em;
    font-weight: 600;
  }
  .trigger.configured {
    border-color: var(--accent);
    color: var(--accent);
  }
  .trigger.active {
    background: var(--accent-soft);
  }
  .backdrop {
    position: fixed;
    inset: 0;
    background: transparent;
    border: 0;
    padding: 0;
    cursor: default;
    z-index: 40;
  }
  .panel {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 41;
    width: 300px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bar-bg);
    box-shadow: 0 6px 20px rgb(0 0 0 / 0.25);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .heading {
    font-weight: 600;
    font-size: 0.9em;
  }
  .hint {
    margin: 0;
    font-size: 0.8em;
    opacity: 0.65;
    line-height: 1.4;
  }
</style>
