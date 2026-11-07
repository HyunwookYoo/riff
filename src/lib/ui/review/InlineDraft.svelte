<script lang="ts">
  import { reviewState, writeRecord } from "$lib/review/reviewState.svelte";
  import { editItem, removeItem } from "$lib/review/draft";
  import { draftLocked } from "$lib/review/submitFlow.svelte";
  import { textStash } from "./composerAt";

  let { itemId }: { itemId: string } = $props();

  const item = $derived(reviewState.record?.items.find((i) => i.id === itemId));
  // No record, or a submit is sending it: the draft can't change.
  const readOnly = $derived(!reviewState.record || draftLocked());
  // svelte-ignore state_referenced_locally
  const editKey = `edit:${itemId}`;
  // An open edit survives the widget being redrawn.
  let editing = $state(textStash.has(editKey));
  let text = $state(textStash.get(editKey) ?? "");

  function startEdit() {
    if (!item) return;
    text = item.body;
    textStash.set(editKey, text);
    editing = true;
  }

  function stopEdit() {
    textStash.delete(editKey);
    editing = false;
  }

  async function save() {
    const r = reviewState.record;
    if (!r || readOnly || !text.trim()) return;
    stopEdit();
    await writeRecord(editItem(r, itemId, text));
  }

  async function remove() {
    const r = reviewState.record;
    if (!r || readOnly) return;
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
        <button type="button" onclick={startEdit} disabled={readOnly}>Edit</button>
        <button type="button" onclick={() => void remove()} disabled={readOnly}>Delete</button>
      {/if}
    </div>
    {#if editing}
      <textarea bind:value={text} rows="4" oninput={(e) => textStash.set(editKey, e.currentTarget.value)}></textarea>
      <div class="actions">
        <button type="button" onclick={stopEdit}>Cancel</button>
        <button type="button" onclick={() => void save()} disabled={!text.trim() || readOnly}>
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
