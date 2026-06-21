<script lang="ts">
  import { appState } from "$lib/store.svelte";
</script>

{#if appState.gitOpLabel}
  <div class="op-banner" role="status" aria-live="polite">
    <span class="spin">⟳</span>
    <span
      >{appState.gitOpLabel} Please wait — don't make other changes until it
      finishes.</span
    >
  </div>
{/if}

<style>
  .op-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 12px;
    background: var(--accent);
    color: #fff;
    border-bottom: 1px solid var(--border);
    font-size: 0.85em;
  }
  .spin {
    display: inline-block;
    animation: op-spin 0.8s linear infinite;
  }
  @keyframes op-spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
