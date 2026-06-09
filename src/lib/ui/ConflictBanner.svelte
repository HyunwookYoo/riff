<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import { abortOp, continueOp, conflictCount } from "$lib/sourceControl";

  const label = $derived(
    (
      {
        merge: "Merge",
        rebase: "Rebase",
        "cherry-pick": "Cherry-pick",
        revert: "Revert",
      } as Record<string, string>
    )[appState.pendingOp] ?? "",
  );
  // Unmerged (conflicted) files, when the status is loaded for this repo.
  const unresolved = $derived(conflictCount());
</script>

{#if appState.pendingOp !== "none"}
  <div class="conflict-banner">
    <span class="msg">
      ⚠ {label} in progress{#if unresolved}
        — {unresolved} unresolved file{unresolved === 1 ? "" : "s"}{/if}. Resolve
      conflicts in Working, stage them, then Continue.
    </span>
    <button
      type="button"
      class="continue"
      disabled={unresolved > 0}
      title={unresolved > 0
        ? "Resolve and stage all conflicts first"
        : "Continue the operation"}
      onclick={() => void continueOp()}
    >
      Continue
    </button>
    <button type="button" class="abort" onclick={() => void abortOp()}>
      Abort
    </button>
  </div>
{/if}

<style>
  .conflict-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 12px;
    background: var(--error-bg, #3a1d1d);
    color: var(--error-fg, #f0b4b4);
    border-bottom: 1px solid var(--border);
    font-size: 0.85em;
  }
  .conflict-banner .msg {
    flex: 1;
  }
  .conflict-banner button {
    flex: 0 0 auto;
    padding: 4px 12px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--input-bg);
    color: var(--fg);
    cursor: pointer;
    font-size: 0.95em;
  }
  .conflict-banner .continue {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .conflict-banner button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
