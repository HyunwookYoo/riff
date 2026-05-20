<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import type { ChangedFile, FileStatus } from "$lib/types";

  function badge(s: FileStatus): string {
    switch (s) {
      case "added":
        return "A";
      case "modified":
        return "M";
      case "deleted":
        return "D";
      case "renamed":
        return "R";
      case "copied":
        return "C";
      case "typechanged":
        return "T";
    }
  }

  function select(f: ChangedFile) {
    appState.selectedFile = f;
  }
</script>

<aside class="file-list">
  <header>
    <span>Files</span>
    <span class="count">{appState.files.length}</span>
  </header>
  <ul>
    {#if appState.files.length === 0 && !appState.loading}
      <li class="empty">No changed files.</li>
    {/if}
    {#each appState.files as f (f.path)}
      <li>
        <button
          type="button"
          class:active={appState.selectedFile?.path === f.path}
          onclick={() => select(f)}
          title={f.old_path ? `${f.old_path} → ${f.path}` : f.path}
        >
          <span class="badge" data-status={f.status}>{badge(f.status)}</span>
          <span class="path">{f.path}</span>
        </button>
      </li>
    {/each}
  </ul>
</aside>

<style>
  .file-list {
    display: flex;
    flex-direction: column;
    height: 100%;
    border-right: 1px solid var(--border);
    background: var(--sidebar-bg);
    min-width: 0;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 10px;
    font-size: 0.8em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    opacity: 0.7;
    border-bottom: 1px solid var(--border);
  }
  .count {
    font-weight: 400;
    opacity: 0.6;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    flex: 1;
  }
  .empty {
    padding: 12px 10px;
    color: var(--muted);
    font-size: 0.85em;
  }
  button {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    border: none;
    background: transparent;
    color: inherit;
    padding: 4px 10px;
    text-align: left;
    cursor: pointer;
    font-size: 0.85em;
    font-family: var(--mono);
  }
  button:hover {
    background: var(--hover);
  }
  button.active {
    background: var(--selected);
  }
  .badge {
    flex-shrink: 0;
    width: 18px;
    height: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 3px;
    font-weight: 700;
    font-size: 0.75em;
    color: white;
  }
  .badge[data-status="added"] {
    background: #16a34a;
  }
  .badge[data-status="modified"] {
    background: #ca8a04;
  }
  .badge[data-status="deleted"] {
    background: #dc2626;
  }
  .badge[data-status="renamed"] {
    background: #2563eb;
  }
  .badge[data-status="copied"] {
    background: #0891b2;
  }
  .badge[data-status="typechanged"] {
    background: #7c3aed;
  }
  .path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
</style>
