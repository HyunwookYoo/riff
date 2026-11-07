<script lang="ts">
  import { reviewState, writeRecord } from "$lib/review/reviewState.svelte";
  import { editItem, removeItem } from "$lib/review/draft";

  let { itemId }: { itemId: string } = $props();

  const item = $derived(reviewState.record?.items.find((i) => i.id === itemId));
  let editing = $state(false);
  let text = $state("");

  function startEdit() {
    if (!item) return;
    text = item.body;
    editing = true;
  }

  async function save() {
    const r = reviewState.record;
    if (!r || !text.trim()) return;
    editing = false;
    await writeRecord(editItem(r, itemId, text));
  }

  async function remove() {
    const r = reviewState.record;
    if (!r) return;
    await writeRecord(removeItem(r, itemId));
  }
</script>

{#if item}
  <div class="draft">
    <div class="head">
      <span class="badge">Draft</span>
      {#if item.target.kind === "line" && item.target.startLine !== null}
        <span class="range">lines {item.target.startLine}–{item.target.line}</span>
      {/if}
      <span class="spacer"></span>
      {#if !editing}
        <button type="button" onclick={startEdit} disabled={!reviewState.record}>Edit</button>
        <button type="button" onclick={() => void remove()} disabled={!reviewState.record}>Delete</button>
      {/if}
    </div>
    {#if editing}
      <textarea bind:value={text} rows="4"></textarea>
      <div class="actions">
        <button type="button" onclick={() => (editing = false)}>Cancel</button>
        <button type="button" onclick={() => void save()} disabled={!text.trim() || !reviewState.record}>
          Save
        </button>
      </div>
    {:else}
      <pre class="body">{item.body}</pre>
    {/if}
  </div>
{/if}

<style>
  .draft {
    padding: 6px;
    border: 1px dashed var(--accent);
    border-radius: 4px;
    background: var(--accent-soft);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.85em;
  }
  .badge {
    font-weight: 600;
    color: var(--accent);
  }
  .range {
    color: var(--muted);
  }
  .spacer {
    flex: 1;
  }
  .body {
    margin: 4px 0 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: inherit;
  }
  textarea {
    width: 100%;
    box-sizing: border-box;
    margin-top: 4px;
    resize: vertical;
    font-family: inherit;
    font-size: inherit;
    padding: 4px 6px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: var(--input-bg);
    color: inherit;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }
</style>
