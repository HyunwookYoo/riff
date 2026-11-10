<script lang="ts">
  import { tick } from "svelte";
  import { aiDefaults } from "$lib/review/ai/aiState.svelte";
  import { choiceFromForm, formFromChoice, type AiChoice, type ChoiceForm } from "$lib/review/ai/modelChoice";
  import AiModelFields from "./AiModelFields.svelte";
  import { popoverPlace } from "./popoverPlace";

  // The ▾ beside a run button: this run only, with a model/effort other than the defaults.
  let { what, onrun }: { what: string; onrun: (c: AiChoice) => void } = $props();

  const WIDTH = 260;
  let moreEl = $state<HTMLButtonElement>();
  let menuEl = $state<HTMLDivElement>();
  // The ▾'s rect while open. The menu is fixed, not absolute: the PR list scrolls and would clip it.
  let anchor = $state<DOMRect | null>(null);
  let height = $state(0); // measured, so the flip-up still clears the anchor once Custom adds a row
  const pos = $derived(anchor && popoverPlace(anchor, { width: WIDTH, height }, { width: window.innerWidth, height: window.innerHeight }));
  let form = $state<ChoiceForm>({ model: "", custom: "", effort: "" });
  const choice = $derived(choiceFromForm(form));

  async function toggle(e: MouseEvent) {
    e.stopPropagation();
    if (anchor) return close();
    form = formFromChoice(aiDefaults());
    anchor = (e.currentTarget as HTMLElement).getBoundingClientRect();
    await tick();
    menuEl?.querySelector("select")?.focus();
  }

  function close(refocus = true) {
    anchor = null;
    if (refocus) moreEl?.focus();
  }

  // Capture on window: runs before +page's global shortcuts, which must not also act on it.
  function onKey(e: KeyboardEvent) {
    if (!anchor || e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  }

  function run(e: MouseEvent) {
    e.stopPropagation();
    if (!choice) return;
    close(false);
    onrun(choice);
  }
</script>

<svelte:window onkeydowncapture={onKey} onresize={() => anchor && close(false)} />

<button
  type="button"
  class="more"
  bind:this={moreEl}
  title="{what} with another model or effort"
  aria-label="{what} options"
  aria-haspopup="dialog"
  aria-expanded={anchor !== null}
  onclick={toggle}>▾</button
>
{#if pos}
  <button
    type="button"
    class="backdrop"
    aria-label="Close"
    onclick={(e) => {
      e.stopPropagation();
      close();
    }}
  ></button>
  <div
    class="menu"
    role="dialog"
    aria-label="{what} options"
    bind:this={menuEl}
    bind:offsetHeight={height}
    style:left="{pos.x}px"
    style:top="{pos.y}px"
    style:width="{WIDTH}px"
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
