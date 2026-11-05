<!-- src/lib/ui/RebaseCheckLine.svelte -->
<script lang="ts">
  import {
    checkBadge,
    checkText,
    type CheckState,
    type ConflictCheck,
  } from "$lib/rebaseCheck";

  // The prop is `state` for callers; locally it is `st` so `$state` is not
  // read as a store subscription.
  let {
    state: st,
    request,
    compact = false,
    prefix = "",
  }: {
    state: CheckState | null;
    request: (c: ConflictCheck) => string;
    compact?: boolean;
    prefix?: string;
  } = $props();

  const LATER = "Later commits may conflict too.";

  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  function fileLabel(f: { path: string; kind: string | null }): string {
    return f.kind ? `${f.path} (${f.kind})` : f.path;
  }

  async function copy(c: ConflictCheck) {
    try {
      await navigator.clipboard.writeText(request(c));
    } catch {
      return;
    }
    copied = true;
    clearTimeout(timer);
    timer = setTimeout(() => (copied = false), 1500);
  }
</script>

{#if st}
  {#if compact}
    <span
      class="cl cl-{st.kind}"
      title={st.kind === "conflict"
        ? st.files.map(fileLabel).join("\n") + "\n" + LATER
        : undefined}>{prefix}{checkBadge(st)}</span
    >
  {:else}
    <div class="cl-full">
      <span class="cl cl-{st.kind}">{checkText(st)}</span>
      {#if st.kind === "conflict"}
        <ul class="cl-files">
          {#each st.files as f (f.path)}
            <li>{fileLabel(f)}</li>
          {/each}
        </ul>
        <div class="cl-later">{LATER}</div>
        <button type="button" class="cl-copy" onclick={() => copy(st)}>
          {copied ? "Copied" : "Copy request for AI"}
        </button>
      {/if}
    </div>
  {/if}
{/if}

<style>
  .cl-full {
    padding: 8px 14px;
    border-top: 1px solid var(--border);
    font-size: 0.85em;
  }
  .cl-clean {
    color: var(--ok-fg, #3fb950);
  }
  .cl-conflict {
    color: var(--warn-fg, #d29922);
  }
  .cl-cant_check,
  .cl-checking,
  .cl-nothing {
    color: var(--muted);
  }
  .cl-files {
    margin: 4px 0 0;
    padding-left: 20px;
    font-family: var(--mono);
    font-size: 0.9em;
  }
  .cl-later {
    margin-top: 2px;
    color: var(--muted);
    font-size: 0.9em;
  }
  .cl-copy {
    margin-top: 6px;
    padding: 2px 10px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--input-bg);
    color: var(--fg);
    cursor: pointer;
    font-size: 0.9em;
  }
</style>
