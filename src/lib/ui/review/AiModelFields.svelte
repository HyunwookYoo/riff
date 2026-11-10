<script lang="ts">
  import { EFFORTS, MODEL_ALIASES, isValidModel, type ChoiceForm } from "$lib/review/ai/modelChoice";

  // Controlled: every edit goes out through `onchange`; the owner decides what to keep.
  let { form, onchange }: { form: ChoiceForm; onchange: (f: ChoiceForm) => void } = $props();

  const customBad = $derived(form.model === "custom" && !isValidModel(form.custom.trim()));
</script>

<label class="field">
  <span class="name">Model</span>
  <select value={form.model} onchange={(e) => onchange({ ...form, model: e.currentTarget.value })}>
    <option value="">Default (Claude Code setting)</option>
    {#each MODEL_ALIASES as m (m)}
      <option value={m}>{m}</option>
    {/each}
    <option value="custom">Custom…</option>
  </select>
</label>
{#if form.model === "custom"}
  <input
    class="custom"
    class:bad={customBad}
    placeholder="Model id, e.g. claude-opus-5-5"
    spellcheck="false"
    title={customBad ? "Letters, digits and . _ : [ ] - only, up to 64 characters" : undefined}
    value={form.custom}
    oninput={(e) => onchange({ ...form, custom: e.currentTarget.value })}
  />
{/if}
<label class="field">
  <span class="name">Effort</span>
  <select value={form.effort} onchange={(e) => onchange({ ...form, effort: e.currentTarget.value })}>
    <option value="">Default</option>
    {#each EFFORTS as e (e)}
      <option value={e}>{e}</option>
    {/each}
  </select>
</label>

<style>
  .field {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.85em;
  }
  .name {
    width: 48px;
    opacity: 0.75;
  }
  .field select {
    flex: 1;
    min-width: 0;
  }
  .custom {
    margin-left: 56px;
    font-family: var(--mono);
    font-size: 0.85em;
  }
  .custom.bad {
    border-color: var(--error-fg);
  }
</style>
