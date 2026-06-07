<script lang="ts">
  // Lucide-style inline icons (matching RepoChip's convention) to distinguish
  // ref kinds in the branches sidebar. local follows the row color (so the
  // current branch tints accent); remote / tag / folder use fixed hues.
  let { kind }: { kind: "local" | "remote" | "tag" | "folder" } = $props();
</script>

<svg
  class="i"
  class:i-remote={kind === "remote"}
  class:i-tag={kind === "tag"}
  class:i-folder={kind === "folder"}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#if kind === "local"}
    <line x1="6" x2="6" y1="3" y2="15" />
    <circle cx="18" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M18 9a9 9 0 0 1-9 9" />
  {:else if kind === "remote"}
    <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
  {:else if kind === "tag"}
    <path
      d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"
    />
    <line x1="7" y1="7" x2="7.01" y2="7" />
  {:else}
    <path
      d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"
    />
  {/if}
</svg>

<style>
  .i {
    width: 13px;
    height: 13px;
    flex-shrink: 0;
  }
  .i-remote {
    color: #5a9bd4;
  }
  .i-tag {
    color: #d29922;
  }
  .i-folder {
    color: var(--muted);
  }
</style>
