<script lang="ts">
  import { reviewState } from "$lib/review/reviewState.svelte";
  import type { TraceStep } from "$lib/review/ai/types";
  import type { Side } from "$lib/review/types";

  let {
    trace,
    title,
    onevidence,
  }: {
    trace: TraceStep[];
    /** What the steps are, e.g. "Failure path"; the step count follows it. */
    title: string;
    /** Select `path` and reveal `line` on `side`; without it the steps are not links. */
    onevidence?: (path: string, line: number | null, side?: Side) => void;
  } = $props();

  const inPr = (path: string) => reviewState.files.some((x) => x.path === path);
  const where = (path: string, line: number) => `${path}:${line}`;
</script>

{#if trace.length > 0}
  <details class="trace" open={trace.length <= 3}>
    <summary>{title} ({trace.length} step{trace.length === 1 ? "" : "s"})</summary>
    <ol>
      {#each trace as s, i (i)}
        <li>
          {#if onevidence && inPr(s.path)}
            <button type="button" class="link" onclick={() => onevidence(s.path, s.line, s.side)}>{where(s.path, s.line)}</button>
          {:else}
            <span class="loc">{where(s.path, s.line)}</span>
          {/if}
          — {s.note}
          {#if s.movedFrom !== undefined}<span class="moved">(line corrected from {s.movedFrom})</span>{/if}
          <pre class="quote">{s.quote}</pre>
        </li>
      {/each}
    </ol>
  </details>
{/if}

<style>
  .trace {
    margin-top: 4px;
  }
  .trace summary {
    cursor: pointer;
    font-size: 0.85em;
    color: var(--muted);
  }
  ol {
    margin: 4px 0 0;
    padding-left: 16px;
    font-size: 0.85em;
  }
  .moved {
    color: var(--muted);
  }
  .loc {
    font-family: var(--mono);
    color: var(--muted);
  }
  .link {
    padding: 0;
    border: none;
    background: none;
    color: var(--accent);
    cursor: pointer;
    font-family: var(--mono);
  }
  .quote {
    margin: 2px 0 4px;
    padding: 2px 4px;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--mono);
    background: var(--input-bg);
    border-radius: 3px;
  }
</style>
