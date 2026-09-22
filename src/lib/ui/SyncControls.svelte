<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import { changesRepoPath, doFetch, doPull } from "$lib/workingCopy";
  import { requestPush } from "$lib/push";

  const busy = $derived(appState.syncing);
  const behind = $derived(appState.currentBehind);
  // Commits this branch has that its upstream doesn't. A branch with no
  // upstream reads 0 — the first push is what creates one, so the button stays
  // available and says so.
  const ahead = $derived(appState.currentAhead);
  const unpublished = $derived(
    !!appState.currentBranch && !appState.currentUpstream,
  );

  // Push is a split button: the wide half does the ordinary push, the caret
  // opens the rest. Force lives here rather than as a button of its own so a
  // misclick can't rewrite a remote branch.
  let menuOpen = $state(false);
  function push(force: boolean) {
    menuOpen = false;
    void requestPush(changesRepoPath(), null, force);
  }
</script>

<svelte:window onclick={() => (menuOpen = false)} />

{#if appState.repoPath}
  <div class="sync">
    <button
      type="button"
      class="sbtn"
      disabled={busy}
      title="Fetch all remotes"
      onclick={() => void doFetch()}
    >
      <span class="ico" class:spin={busy}>⟳</span>
    </button>

    <button
      type="button"
      class="sbtn"
      disabled={busy}
      title="Pull (fetch + merge)"
      onclick={() => void doPull()}
    >
      ↓ Pull{#if behind}&nbsp;{behind}{/if}
    </button>

    <div class="pushgroup">
      <button
        type="button"
        class="sbtn main"
        disabled={busy || !appState.currentBranch}
        title={unpublished
          ? `Publish ${appState.currentBranch} to the remote and track it`
          : "Push the current branch to its upstream"}
        onclick={() => push(false)}
      >
        ↑ {unpublished ? "Publish" : "Push"}{#if ahead}&nbsp;{ahead}{/if}
      </button>
      <button
        type="button"
        class="sbtn caret"
        disabled={busy || !appState.currentBranch}
        aria-label="Push options"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title="Push options"
        onclick={(e) => {
          e.stopPropagation();
          menuOpen = !menuOpen;
        }}
      >
        ▾
      </button>

      {#if menuOpen}
        <div
          class="pushmenu"
          role="menu"
          tabindex="-1"
          onclick={(e) => e.stopPropagation()}
          onkeydown={(e) => e.key === "Escape" && (menuOpen = false)}
        >
          <button type="button" role="menuitem" onclick={() => push(false)}>
            {unpublished ? "Publish" : "Push"}
          </button>
          <button
            type="button"
            role="menuitem"
            class="danger"
            disabled={unpublished}
            title={unpublished
              ? "Nothing to replace yet — this branch has never been pushed"
              : "Replace the remote branch with this one (lease-checked)"}
            onclick={() => push(true)}
          >
            Force push (with lease)…
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .sync {
    display: inline-flex;
    align-items: stretch;
    gap: 4px;
  }
  .sbtn {
    border: 1px solid var(--border);
    background: var(--input-bg);
    color: inherit;
    cursor: pointer;
    font-size: 0.8em;
    padding: 3px 8px;
    border-radius: 4px;
    white-space: nowrap;
  }
  .sbtn:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
  }
  .sbtn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  /* Split button: the two halves read as one control, so only the outer
     corners are rounded and they share the seam between them. */
  .pushgroup {
    position: relative;
    display: inline-flex;
    align-items: stretch;
  }
  .pushgroup .main {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }
  .pushgroup .caret {
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
    border-left: none;
    padding: 3px 5px;
  }
  .pushmenu {
    position: absolute;
    top: calc(100% + 3px);
    right: 0;
    z-index: 100;
    min-width: 200px;
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: 5px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
    padding: 4px;
    display: flex;
    flex-direction: column;
  }
  .pushmenu button {
    border: none;
    background: transparent;
    color: inherit;
    text-align: left;
    padding: 5px 10px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 0.8em;
    white-space: nowrap;
  }
  .pushmenu button:hover:not(:disabled) {
    background: var(--hover);
  }
  .pushmenu button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .pushmenu button.danger:hover:not(:disabled) {
    color: var(--error-fg, #f0b4b4);
  }
  /* Spin just the refresh glyph, not the whole button box — the operation now
     runs async (UI stays live), so a rotating bordered button would be visible
     the entire time and looks off. inline-block so the transform applies. */
  .ico {
    display: inline-block;
  }
  .ico.spin {
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
