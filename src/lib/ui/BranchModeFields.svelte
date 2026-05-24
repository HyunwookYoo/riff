<script lang="ts">
  import { appState } from "$lib/store.svelte";
</script>

<input
  type="text"
  class="ref"
  list="branch-list"
  placeholder="start (branch / commit / tag)"
  bind:value={appState.startBranch}
/>
<span class="sep">→</span>
<input
  type="text"
  class="ref"
  list="branch-list"
  placeholder="target"
  bind:value={appState.targetBranch}
/>
<datalist id="branch-list">
  {#each appState.branches as b (b.name + b.kind)}
    <option value={b.name}>{b.kind}</option>
  {/each}
</datalist>

<select bind:value={appState.mode} title="Diff mode">
  <option value="three-dot">3-dot (...)</option>
  <option value="two-dot">2-dot (..)</option>
</select>

<style>
  .ref {
    width: 180px;
    font-size: 0.9em;
    padding: 4px 8px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--input-bg);
    color: inherit;
  }
  .sep {
    opacity: 0.6;
  }
  select {
    font-size: 0.9em;
    padding: 4px 8px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--input-bg);
    color: inherit;
  }
</style>
