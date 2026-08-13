<!-- src/lib/ui/ReflogOverlay.svelte -->
<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import { loadReflog } from "$lib/reflog";
  import { createBranch } from "$lib/git";
  import { changesRepoPath } from "$lib/workingCopy";
  import type { ReflogEntry } from "$lib/types";

  let entries = $state<ReflogEntry[]>([]);
  let loading = $state(false);
  let dialogEl = $state<HTMLDivElement>();

  // Inline "branch here" entry, holding the sha it will branch from.
  let branchFor = $state<string | null>(null);
  let branchName = $state("");
  let branchInputEl = $state<HTMLInputElement | null>(null);

  let wasOpen = false;
  $effect(() => {
    if (appState.reflogOpen && !wasOpen) {
      queueMicrotask(() => dialogEl?.focus());
      void refresh();
    }
    if (!appState.reflogOpen) {
      branchFor = null;
      branchName = "";
    }
    wasOpen = appState.reflogOpen;
  });

  $effect(() => {
    if (branchFor) branchInputEl?.focus();
  });

  async function refresh() {
    loading = true;
    entries = await loadReflog();
    loading = false;
  }

  function close() {
    appState.reflogOpen = false;
  }

  function onKey(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    // Escape backs out of the inline branch field first, then the panel.
    if (branchFor) {
      branchFor = null;
      branchName = "";
      return;
    }
    close();
  }

  function openBranchEditor(sha: string) {
    branchName = "";
    branchFor = sha;
  }

  async function submitBranch(e: Event) {
    e.preventDefault();
    const sha = branchFor;
    const name = branchName.trim();
    branchFor = null;
    branchName = "";
    if (!sha || !name) return;
    try {
      // `checkout: false` — branching off an entry must not move HEAD.
      await createBranch(changesRepoPath(), name, sha, false);
      appState.refsRefresh++;
    } catch (err) {
      appState.error = String(err);
    }
  }

  // Compact relative time, mirroring the graph's own formatter.
  function relTime(unixSec: number): string {
    const d = Math.max(0, Math.floor(Date.now() / 1000) - unixSec);
    if (d < 60) return "just now";
    if (d < 3600) return `${Math.floor(d / 60)}m ago`;
    if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
    if (d < 604800) return `${Math.floor(d / 86400)}d ago`;
    return `${Math.floor(d / 604800)}w ago`;
  }
</script>

{#if appState.reflogOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="rl-backdrop" onclick={close} role="presentation">
    <div
      class="rl"
      role="dialog"
      aria-modal="true"
      aria-label="Reflog"
      tabindex="-1"
      bind:this={dialogEl}
      onkeydown={onKey}
      onclick={(e) => e.stopPropagation()}
    >
      <div class="rl-head">
        <span>Reflog / Undo history</span>
        <button type="button" class="rl-x" aria-label="Close" onclick={close}
          >×</button
        >
      </div>
      <div class="rl-body">
        {#if loading}
          <div class="rl-empty">Loading…</div>
        {:else if entries.length === 0}
          <div class="rl-empty">No reflog entries</div>
        {:else}
          {#each entries as entry (entry.selector)}
            <div class="rl-row">
              <div class="rl-main">
                <span class="rl-sel">{entry.selector}</span>
                <span class="rl-sha">{entry.sha.slice(0, 7)}</span>
                <span class="rl-subj">{entry.subject}</span>
                <span class="rl-time">{relTime(entry.time)}</span>
              </div>
              <button
                type="button"
                class="rl-branch"
                title="Create a branch here (does not move HEAD)"
                onclick={() => openBranchEditor(entry.sha)}
              >
                ＋ branch
              </button>
            </div>
            {#if branchFor === entry.sha}
              <form class="rl-editor" onsubmit={submitBranch}>
                <input
                  bind:this={branchInputEl}
                  bind:value={branchName}
                  placeholder="New branch name"
                />
              </form>
            {/if}
          {/each}
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .rl-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 10vh;
    z-index: 2100;
  }
  .rl {
    width: 640px;
    max-width: calc(100vw - 32px);
    max-height: 76vh;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 12px 48px rgba(0, 0, 0, 0.4);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    outline: none;
  }
  .rl-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    font-weight: 600;
  }
  .rl-x {
    border: none;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    font-size: 1.1em;
    line-height: 1;
  }
  .rl-x:hover {
    color: var(--accent);
  }
  .rl-body {
    overflow-y: auto;
    padding: 6px 8px 12px;
  }
  .rl-empty {
    padding: 12px;
    color: var(--muted);
    font-size: 0.88em;
  }
  .rl-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .rl-row:hover {
    background: var(--hover);
  }
  .rl-main {
    flex: 1;
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    padding: 4px 6px;
    font-size: 0.88em;
  }
  .rl-sel {
    flex: 0 0 auto;
    font-family: var(--mono);
    font-size: 0.85em;
    color: var(--muted);
  }
  .rl-sha {
    flex: 0 0 auto;
    font-family: var(--mono);
    font-size: 0.85em;
    color: var(--accent);
  }
  .rl-subj {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rl-time {
    flex: 0 0 auto;
    color: var(--muted);
    font-size: 0.85em;
  }
  .rl-branch {
    flex: 0 0 auto;
    margin-right: 6px;
    padding: 1px 6px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    font-size: 0.75em;
    opacity: 0;
  }
  .rl-row:hover .rl-branch {
    opacity: 1;
  }
  .rl-branch:focus-visible {
    opacity: 1;
  }
  .rl-branch:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .rl-editor {
    padding: 2px 8px 6px 14px;
  }
  .rl-editor input {
    width: 100%;
    box-sizing: border-box;
    padding: 3px 6px;
    border: 1px solid var(--accent);
    border-radius: 4px;
    background: var(--input-bg);
    color: var(--fg);
    font-size: 0.82em;
  }
</style>
