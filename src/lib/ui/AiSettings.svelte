<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import { setAiEffort, setAiModel } from "$lib/git";
  import { choiceFromForm, choiceLabel, formFromChoice, type ChoiceForm } from "$lib/review/ai/modelChoice";
  import AiModelFields from "./review/AiModelFields.svelte";
  import { popoverPlace } from "./review/popoverPlace";

  let open_ = $state(false);
  let trigger = $state<HTMLButtonElement>();
  // Fixed and clamped to the window: the toolbar wraps, so the trigger can sit anywhere.
  const pos = $derived(open_ && trigger ? popoverPlace(trigger.getBoundingClientRect(), { width: 300, height: 0 }, { width: window.innerWidth, height: window.innerHeight }) : null);
  let form = $state<ChoiceForm>({ model: "", custom: "", effort: "" });

  function toggle() {
    if (!open_) form = formFromChoice({ model: appState.aiModel, effort: appState.aiEffort });
    open_ = !open_;
  }

  // The form shows what was picked, even an empty or invalid custom id; only a valid choice is
  // saved, on a select change or when the custom id is left (blur/Enter), not per keystroke.
  const unsaved = $derived(choiceFromForm(form) === null);

  function change(f: ChoiceForm, commit: boolean) {
    form = f;
    const c = commit ? choiceFromForm(f) : null;
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

<svelte:window onresize={() => (open_ = false)} />

<div class="ai-settings">
  <button
    type="button"
    class="trigger"
    class:active={open_}
    class:configured={!!appState.aiModel || !!appState.aiEffort}
    title="AI review settings"
    aria-haspopup="dialog"
    aria-expanded={open_}
    bind:this={trigger}
    onclick={toggle}
  >
    AI
  </button>
  {#if open_}
    <button type="button" class="backdrop" aria-label="Close" onclick={() => (open_ = false)}></button>
    <div class="panel" role="dialog" style:left="{pos?.x ?? 0}px" style:top="{pos?.y ?? 0}px" aria-label="AI review settings">
      <div class="heading">AI review</div>
      <AiModelFields {form} onchange={change} />
      {#if unsaved}
        <p class="unsaved">Enter a valid model id to save it; runs use {choiceLabel({ model: appState.aiModel, effort: appState.aiEffort })} until then.</p>
      {/if}
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
    position: fixed;
    max-width: calc(100vw - 8px);
    box-sizing: border-box;
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
  .unsaved {
    margin: 0;
    font-size: 0.8em;
    color: var(--error-fg);
  }
  .hint {
    margin: 0;
    font-size: 0.8em;
    opacity: 0.65;
    line-height: 1.4;
  }
</style>
