<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import { diffModeLabel } from "$lib/rangeText";
  import BranchPicker from "./BranchPicker.svelte";

  // The pickers always edit the super repo's pair — `startBranch` is base,
  // `targetBranch` is compare. Focus and tabs only filter what is shown; a
  // submodule's own pair is edited from the scope bar (ScopeBar.svelte).
  const superName = $derived(
    appState.repos.length > 1 ? (appState.repos[0]?.displayName ?? "") : "",
  );
</script>

{#if superName}
  <span class="super" title="These refs belong to the super repo">{superName}</span>
{/if}
<BranchPicker
  label="base"
  value={appState.startBranch}
  options={appState.branches}
  placeholder="pick a ref"
  onchange={(v) => (appState.startBranch = v)}
  title="base — where compare would merge; the diff's left side"
/>
<span class="sep" title="compare merges into base">←</span>
<BranchPicker
  label="compare"
  value={appState.targetBranch}
  options={appState.branches}
  placeholder="pick a ref"
  onchange={(v) => (appState.targetBranch = v)}
  title="compare — the branch under review; the diff's right side"
/>
<select bind:value={appState.mode} title="Diff mode">
  <option value="three-dot">{diffModeLabel("three-dot")}</option>
  <option value="two-dot">{diffModeLabel("two-dot")}</option>
</select>

<style>
  .super {
    color: var(--muted);
    font-size: 0.85em;
    font-family: var(--mono);
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
