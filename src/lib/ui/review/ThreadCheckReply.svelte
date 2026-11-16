<script lang="ts">
  import { reviewState } from "$lib/review/reviewState.svelte";
  import { draftLocked } from "$lib/review/submitFlow.svelte";
  import { replyAppendix } from "$lib/review/ai/tracePath";
  import type { ThreadCheck } from "$lib/review/ai/types";
  import type { DraftOrigin } from "$lib/review/types";
  import { textStash } from "./composerAt";

  // A thread check's reply draft: Add it as is, or Edit it first. Mount it keyed by the check's
  // `createdAt`, so an open edit never carries over to a newer check.
  let {
    check,
    stale,
    added,
    onadd,
  }: {
    check: ThreadCheck;
    /** The check is out of date (other commit, or new replies): its reply can't be added. */
    stale: boolean;
    /** The draft already has an AI reply to this thread. */
    added: boolean;
    /** Add `body` to the draft as a reply to the thread. */
    onadd: (body: string, origin: DraftOrigin) => Promise<unknown>;
  } = $props();

  // svelte-ignore state_referenced_locally
  const editKey = `check:${check.createdAt}:${check.threadId}`;
  // An open edit survives the widget being redrawn.
  let editing = $state(textStash.has(editKey));
  let text = $state(textStash.get(editKey) ?? "");
  const blocked = $derived(stale || added || !reviewState.record || draftLocked());
  const why = $derived(stale ? "Check again to reply" : undefined);

  function startEdit() {
    text = check.reply;
    textStash.set(editKey, text);
    editing = true;
  }

  function stopEdit() {
    textStash.delete(editKey);
    editing = false;
  }

  // The checked code is appended on Add, never shown in the editor: what the user edits is the reply alone.
  async function add(body: string, edited: boolean) {
    if (blocked || !body.trim()) return;
    stopEdit();
    await onadd(body + replyAppendix(check), edited ? "ai-edited" : "ai");
  }
</script>

{#if editing}
  <textarea bind:value={text} rows="4" oninput={(e) => textStash.set(editKey, e.currentTarget.value)}></textarea>
  <p class="muted">The checked code is added below the reply</p>
  <div class="actions">
    <button type="button" onclick={stopEdit}>Cancel</button>
    <button type="button" class="primary" title={why} onclick={() => void add(text, true)} disabled={blocked || !text.trim()}>
      Add reply
    </button>
  </div>
{:else}
  <pre class="body">{check.reply}</pre>
  <div class="actions">
    {#if added}
      <button type="button" disabled>Added</button>
    {:else}
      <button type="button" title={why} onclick={() => void add(check.reply, false)} disabled={blocked}>Add reply</button>
      <button type="button" title={why} onclick={startEdit} disabled={blocked}>Edit</button>
    {/if}
  </div>
{/if}

<style>
  .body {
    margin: 4px 0 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: inherit;
  }
  .muted {
    margin: 4px 0 0;
    font-size: 0.85em;
    color: var(--muted);
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
    margin-top: 4px;
  }
  button.primary {
    border-color: var(--accent);
    background: var(--accent);
    color: white;
  }
</style>
