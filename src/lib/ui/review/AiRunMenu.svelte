<script lang="ts">
  import { aiDefaults } from "$lib/review/ai/aiState.svelte";
  import { choiceFromForm, formFromChoice, type AiChoice, type ChoiceForm } from "$lib/review/ai/modelChoice";
  import AiModelFields from "./AiModelFields.svelte";

  // The ▾ beside a run button: this run only, with a model/effort other than the defaults.
  let { what, onrun }: { what: string; onrun: (c: AiChoice) => void } = $props();

  const WIDTH = 260;
  const HEIGHT = 150;
  // Fixed, not absolute: the PR list scrolls and would clip it.
  let pos = $state<{ x: number; y: number } | null>(null);
  let form = $state<ChoiceForm>({ model: "", custom: "", effort: "" });
  const choice = $derived(choiceFromForm(form));

  function toggle(e: MouseEvent) {
    e.stopPropagation();
    if (pos) {
      pos = null;
      return;
    }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    form = formFromChoice(aiDefaults());
    pos = {
      x: Math.max(4, Math.min(r.left, window.innerWidth - WIDTH - 4)),
      y: r.bottom + 4 + HEIGHT > window.innerHeight ? Math.max(4, r.top - 4 - HEIGHT) : r.bottom + 4,
    };
  }

  function close(e: Event) {
    e.stopPropagation();
    pos = null;
  }

  function run(e: MouseEvent) {
    e.stopPropagation();
    if (!choice) return;
    pos = null;
    onrun(choice);
  }
</script>

<button
  type="button"
  class="more"
  title="{what} with another model or effort"
  aria-label="{what} options"
  aria-haspopup="dialog"
  aria-expanded={pos !== null}
  onclick={toggle}>▾</button
>
{#if pos}
  <button type="button" class="backdrop" aria-label="Close" onclick={close}></button>
  <div
    class="menu"
    role="dialog"
    aria-label="{what} options"
    tabindex="-1"
    style:left="{pos.x}px"
    style:top="{pos.y}px"
    style:width="{WIDTH}px"
    onkeydown={(e) => {
      if (e.key === "Escape") close(e);
    }}
  >
    <AiModelFields {form} onchange={(f) => (form = f)} />
    <div class="actions">
      <span class="note">This run only</span>
      <button type="button" class="primary" disabled={!choice} onclick={run}>Run</button>
    </div>
  </div>
{/if}

<style>
  .more {
    font-size: 0.72em;
    padding: 0 4px;
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
  .menu {
    position: fixed;
    z-index: 41;
    box-sizing: border-box;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bar-bg);
    box-shadow: 0 6px 20px rgb(0 0 0 / 0.25);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .note {
    flex: 1;
    font-size: 0.8em;
    opacity: 0.65;
  }
</style>
