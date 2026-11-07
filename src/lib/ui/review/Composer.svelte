<script lang="ts">
  import { onMount } from "svelte";
  import { reviewState } from "$lib/review/reviewState.svelte";

  let {
    label,
    initial = "",
    onsubmit,
    oncancel,
    ontext,
  }: {
    label: string;
    initial?: string;
    onsubmit: (body: string) => Promise<void>;
    oncancel: () => void;
    ontext?: (text: string) => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  let text = $state(initial);
  let busy = $state(false);
  let ta: HTMLTextAreaElement;
  // No record (unreadable, R7): nothing may be added to the draft.
  const blocked = $derived(!reviewState.record);

  onMount(() => ta.focus());

  async function submit() {
    if (blocked || busy || !text.trim()) return;
    busy = true;
    try {
      await onsubmit(text);
    } finally {
      busy = false;
    }
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      oncancel();
    }
  }
</script>

<div class="composer">
  {#if label}<div class="label">{label}</div>{/if}
  <textarea
    bind:this={ta}
    bind:value={text}
    oninput={(e) => ontext?.(e.currentTarget.value)}
    {onkeydown}
    rows="4"
    placeholder="Leave a comment (Ctrl+Enter to add)"
    disabled={blocked}
  ></textarea>
  <div class="actions">
    {#if blocked}<span class="blocked">{reviewState.error ?? "The draft can't be changed."}</span>{/if}
    <button type="button" onclick={oncancel}>Cancel</button>
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
