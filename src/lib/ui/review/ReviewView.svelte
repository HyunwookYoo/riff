<script lang="ts">
  import { onMount } from "svelte";
  import { reviewState, refreshList, startAutoRefresh } from "$lib/review/reviewState.svelte";
  import PrList from "./PrList.svelte";

  onMount(() => {
    void refreshList();
    return startAutoRefresh();
  });
</script>

<div class="review-view">
  <PrList />
  <main class="review-main">
    {#if reviewState.selectedKey}
      <div class="placeholder">{reviewState.selectedKey}</div>
    {:else}
      <div class="placeholder">Select a PR</div>
    {/if}
  </main>
</div>

<style>
  .review-view {
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: 340px 1fr;
    min-height: 0;
    min-width: 0;
  }
  .review-main {
    display: flex;
    min-width: 0;
    min-height: 0;
  }
  .placeholder {
    margin: auto;
    color: var(--muted);
  }
</style>
