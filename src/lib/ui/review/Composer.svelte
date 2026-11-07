<script lang="ts">
  import { onMount } from "svelte";
  import { reviewState } from "$lib/review/reviewState.svelte";
  import { textStash } from "./composerAt";

  let {
    label,
    stashKey,
    onsubmit,
    oncancel,
  }: {
    label: string;
    /** Where the unsaved text lives while the widget may be redrawn. */
    stashKey: string;
    /** Resolves true once the comment is in the draft. */
    onsubmit: (body: string) => Promise<boolean>;
    oncancel: () => void;
  } = $props();

  // A stash entry means this is a redraw of an open composer, not a fresh open.
  // svelte-ignore state_referenced_locally
  const reopened = textStash.has(stashKey);
  // svelte-ignore state_referenced_locally
  let text = $state(textStash.get(stashKey) ?? "");
  // svelte-ignore state_referenced_locally
  if (!reopened) textStash.set(stashKey, "");
  let busy = $state(false);
  let ta: HTMLTextAreaElement;
  // No record (unreadable, R7): nothing may be added to the draft.
  const blocked = $derived(!reviewState.record);

  onMount(() => {
    if (!reopened) ta.focus();
  });

  async function submit() {
    if (blocked || busy || !text.trim()) return;
    busy = true;
    try {
      if (await onsubmit(text)) textStash.delete(stashKey);
    } finally {
      busy = false;
    }
  }

  function cancel() {
    textStash.delete(stashKey);
    oncancel();
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  }
</script>

<div class="composer">
  {#if label}<div class="label">{label}</div>{/if}
  <textarea
    bind:this={ta}
    bind:value={text}
    oninput={(e) => textStash.set(stashKey, e.currentTarget.value)}
    {onkeydown}
    rows="4"
    placeholder="Leave a comment (Ctrl+Enter to add)"
    disabled={blocked}
  ></textarea>
  <div class="actions">
    {#if blocked}<span class="blocked">{reviewState.error ?? "The draft can't be changed."}</span>{/if}
    <button type="button" onclick={cancel}>Cancel</button>
    <button
      type="button"
      class="primary"
      onclick={() => void submit()}
      disabled={blocked || busy || !text.trim()}
    >
      Add to draft
    </button>
  </div>
</div>

<style>
  .composer {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg);
  }
  .label {
    color: var(--muted);
    font-size: 0.85em;
  }
  textarea {
    width: 100%;
    box-sizing: border-box;
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
    align-items: center;
    gap: 6px;
  }
  .blocked {
    margin-right: auto;
    color: var(--error-fg);
    font-size: 0.85em;
  }
  button.primary {
    border-color: var(--accent);
    background: var(--accent);
    color: white;
  }
</style>
