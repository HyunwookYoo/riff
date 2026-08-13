<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import { commitChangelist, filesInChangelist } from "$lib/changelists";
  import { loadAmendMessage } from "$lib/workingCopy";

  const branch = $derived(appState.repoStatus?.branch ?? null);
  const subjectLen = $derived(appState.commitSubject.trim().length);
  // The commit box targets the active changelist.
  const activeCl = $derived(
    appState.changelists.find((l) => l.id === appState.activeChangelistId),
  );
  // Effective file count = home files still here + foreign files with hunks
  // reassigned here (so a hunk-only changelist is still committable).
  const activeCount = $derived(
    filesInChangelist(appState.activeChangelistId).length,
  );
  const canCommit = $derived(
    subjectLen > 0 &&
      (activeCount > 0 || appState.commitAmend) &&
      !appState.committing,
  );

  function commit() {
    void commitChangelist(appState.activeChangelistId);
  }

  // Toggling Amend ON pre-fills HEAD's message; OFF clears the box (that text
  // belonged to the amend, not a new commit).
  function onToggleAmend(e: Event) {
    const on = (e.currentTarget as HTMLInputElement).checked;
    appState.commitAmend = on;
    if (on) {
      void loadAmendMessage();
    } else {
      appState.commitSubject = "";
      appState.commitBody = "";
    }
  }

  function addCoauthor() {
    appState.commitCoauthors = [...appState.commitCoauthors, ""];
  }
  function removeCoauthor(i: number) {
    appState.commitCoauthors = appState.commitCoauthors.filter(
      (_, j) => j !== i,
    );
  }

  // Ctrl/Cmd+Enter commits from anywhere in the box.
  function onKeydown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      commit();
    }
  }
</script>

<div class="commit-box" role="group" aria-label="Commit">
  <input
    class="subject"
    type="text"
    placeholder="Summary (required)"
    bind:value={appState.commitSubject}
    onkeydown={onKeydown}
  />
  <div class="subject-hint" class:over={subjectLen > 50}>{subjectLen}/50</div>

  <textarea
    class="body"
    rows="3"
    placeholder="Description"
    bind:value={appState.commitBody}
    onkeydown={onKeydown}
  ></textarea>

  {#each appState.commitCoauthors as _, i (i)}
    <div class="coauthor">
      <input
        type="text"
        placeholder="Co-author: Name &lt;email&gt;"
        bind:value={appState.commitCoauthors[i]}
        onkeydown={onKeydown}
      />
      <button
        type="button"
        class="rm"
        title="Remove co-author"
        aria-label="Remove co-author"
        onclick={() => removeCoauthor(i)}>×</button
      >
    </div>
  {/each}

  <div class="opts">
    <label title="Add a Signed-off-by trailer (-s)">
      <input type="checkbox" bind:checked={appState.commitSignoff} />
      <span>Sign-off</span>
    </label>
    <label title="Replace the last commit with this content and message (--amend)">
      <input
        type="checkbox"
        checked={appState.commitAmend}
        onchange={onToggleAmend}
      />
      <span>Amend</span>
    </label>
    <button type="button" class="add-co" onclick={addCoauthor}>
      + Co-author
    </button>
  </div>

  <button
    type="button"
    class="commit primary"
    disabled={!canCommit}
    onclick={commit}
    title="Ctrl+Enter"
  >
    {#if appState.committing}
      {appState.commitAmend ? "Amending…" : "Committing…"}
    {:else if appState.commitAmend}
      Amend last commit
    {:else}
      Commit “{activeCl?.name ?? "Default"}” ({activeCount}){branch
        ? ` to ${branch}`
        : ""}
    {/if}
  </button>
</div>

<style>
  .commit-box {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 8px 10px;
    border-top: 1px solid var(--border);
    background: var(--bar-bg);
  }
  .subject,
  .body,
  .coauthor input {
    width: 100%;
    box-sizing: border-box;
    padding: 5px 7px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--input-bg);
    color: inherit;
    font-size: 0.85em;
    font-family: inherit;
  }
  .body {
    resize: vertical;
    min-height: 2.4em;
    font-family: var(--mono);
  }
  .subject-hint {
    align-self: flex-end;
    margin-top: -3px;
    font-size: 0.7em;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .subject-hint.over {
    color: #d29922;
  }
  .coauthor {
    display: flex;
    gap: 4px;
    align-items: center;
  }
  .coauthor .rm {
    flex: 0 0 auto;
    width: 24px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--input-bg);
    color: var(--muted);
    cursor: pointer;
    font-size: 1em;
    line-height: 1;
  }
  .coauthor .rm:hover {
    color: var(--accent);
    border-color: var(--accent);
  }
  .opts {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 0.8em;
  }
  .opts label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    user-select: none;
  }
  .opts label input {
    margin: 0;
    cursor: pointer;
  }
  .opts .add-co {
    margin-left: auto;
    padding: 1px 8px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: var(--input-bg);
    color: inherit;
    cursor: pointer;
    font-size: 0.95em;
  }
  .opts .add-co:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .commit {
    padding: 6px 10px;
    border: 1px solid var(--accent);
    border-radius: 4px;
    background: var(--accent);
    color: white;
    cursor: pointer;
    font-size: 0.88em;
    font-weight: 600;
  }
  .commit:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
