<!-- src/lib/ui/RebaseTodoOverlay.svelte -->
<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import { startRebasePlan } from "$lib/rebase";
  import type { RebaseAction, RebaseStep } from "$lib/types";

  type Row = { sha: string; short: string; summary: string; action: RebaseAction };

  const ACTIONS: { value: RebaseAction; label: string; hint: string }[] = [
    { value: "pick", label: "pick", hint: "Replay the commit as it is" },
    {
      value: "squash",
      label: "squash",
      hint: "Meld into the commit above, keeping both messages",
    },
    {
      value: "fixup",
      label: "fixup",
      hint: "Meld into the commit above, discarding this message",
    },
    { value: "edit", label: "edit", hint: "Stop here so you can amend it elsewhere" },
    { value: "drop", label: "drop", hint: "Leave the commit out" },
  ];

  let rows = $state<Row[]>([]);
  let dialogEl = $state<HTMLDivElement>();
  let dragIdx = $state<number | null>(null);
  let overIdx = $state<number | null>(null);

  // Rebuild the editable list whenever a new plan opens. The plan arrives
  // oldest-first — git's todo order — and stays that way: the rows read top to
  // bottom in the order the commits will be replayed.
  let planned: unknown = null;
  $effect(() => {
    const plan = appState.rebasePlan;
    if (plan === planned) return;
    planned = plan;
    rows = (plan?.commits ?? []).map((c) => ({
      sha: c.sha,
      short: c.short_sha,
      summary: c.summary,
      action: "pick" as RebaseAction,
    }));
    dragIdx = null;
    overIdx = null;
    if (plan) queueMicrotask(() => dialogEl?.focus());
  });

  // What the plan can't express, in the same terms the backend refuses it:
  // nothing to meld into, or nothing left at all.
  const problem = $derived.by(() => {
    const kept = rows.filter((r) => r.action !== "drop");
    if (kept.length === 0) return "A plan must keep at least one commit.";
    if (kept[0].action === "squash" || kept[0].action === "fixup")
      return "The first commit kept has nothing above it to meld into.";
    return null;
  });

  function close() {
    appState.rebasePlan = null;
  }

  function onKey(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  }

  /// Move the row at `from` to `to`, the one operation both the drag and the
  /// ↑/↓ buttons perform.
  function move(from: number, to: number) {
    if (to < 0 || to >= rows.length || from === to) return;
    const next = rows.slice();
    const [row] = next.splice(from, 1);
    next.splice(to, 0, row);
    rows = next;
  }

  function onDrop(idx: number) {
    if (dragIdx !== null) move(dragIdx, idx);
    dragIdx = null;
    overIdx = null;
  }

  function start() {
    if (problem) return;
    const steps: RebaseStep[] = rows.map((r) => ({ action: r.action, sha: r.sha }));
    void startRebasePlan(steps);
  }
</script>

{#if appState.rebasePlan}
  {@const plan = appState.rebasePlan}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="rb-backdrop" onclick={close} role="presentation">
    <div
      class="rb"
      role="dialog"
      aria-modal="true"
      aria-label="Rebase plan"
      tabindex="-1"
      bind:this={dialogEl}
      onkeydown={onKey}
      onclick={(e) => e.stopPropagation()}
    >
      <div class="rb-head">
        <span>Rebase {plan.label}</span>
        <button type="button" class="rb-x" aria-label="Close" onclick={close}>×</button>
      </div>
      <div class="rb-sub">
        Top replays first. Drag a row (or use ↑ ↓) to reorder, and pick what each
        commit does.
      </div>
      <div class="rb-body">
        {#each rows as row, i (row.sha)}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="rb-row"
            class:dropping={overIdx === i && dragIdx !== null && dragIdx !== i}
            class:dropped={row.action === "drop"}
            draggable="true"
            ondragstart={(e) => {
              dragIdx = i;
              // Chromium starts a drag with no payload; other engines don't.
              e.dataTransfer?.setData("text/plain", row.sha);
              if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
            }}
            ondragend={() => ((dragIdx = null), (overIdx = null))}
            ondragover={(e) => {
              e.preventDefault();
              if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
              overIdx = i;
            }}
            ondrop={(e) => {
              e.preventDefault();
              onDrop(i);
            }}
          >
            <span class="rb-grip" aria-hidden="true">⠿</span>
            <select
              class="rb-action"
              bind:value={row.action}
              aria-label="Action for {row.short}"
              title={ACTIONS.find((a) => a.value === row.action)?.hint}
            >
              {#each ACTIONS as a}
                <option value={a.value}>{a.label}</option>
              {/each}
            </select>
            <span class="rb-sha">{row.short}</span>
            <span class="rb-summary">{row.summary}</span>
            <span class="rb-moves">
              <button
                type="button"
                aria-label="Move {row.short} up"
                disabled={i === 0}
                onclick={() => move(i, i - 1)}>↑</button
              >
              <button
                type="button"
                aria-label="Move {row.short} down"
                disabled={i === rows.length - 1}
                onclick={() => move(i, i + 1)}>↓</button
              >
            </span>
          </div>
        {/each}
      </div>
      <div class="rb-foot">
        <span class="rb-note">
          {#if problem}
            <span class="rb-problem">{problem}</span>
          {:else}
            Rewrites {rows.filter((r) => r.action !== "drop").length} of {rows.length}
            commit{rows.length === 1 ? "" : "s"} · the old tip stays in the reflog
            (Ctrl+Shift+R)
          {/if}
        </span>
        <button type="button" class="rb-cancel" onclick={close}>Cancel</button>
        <button type="button" class="rb-start" disabled={!!problem} onclick={start}>
          Start rebase
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .rb-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 10vh;
    z-index: 2100;
  }
  .rb {
    width: 680px;
    max-width: calc(100vw - 32px);
    max-height: 76vh;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 12px 48px rgba(0, 0, 0, 0.4);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    outline: none;
  }
  .rb-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    font-weight: 600;
  }
  .rb-x {
    border: none;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    font-size: 1.1em;
    line-height: 1;
  }
  .rb-x:hover {
    color: var(--accent);
  }
  .rb-sub {
    padding: 8px 14px;
    color: var(--muted);
    font-size: 0.82em;
    border-bottom: 1px solid var(--border);
  }
  .rb-body {
    overflow-y: auto;
    padding: 6px 8px 10px;
  }
  .rb-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 6px;
    border-top: 2px solid transparent;
    font-size: 0.88em;
    cursor: grab;
  }
  .rb-row:hover {
    background: var(--hover);
  }
  /* The row the drop would land above. */
  .rb-row.dropping {
    border-top-color: var(--accent);
  }
  .rb-row.dropped .rb-summary,
  .rb-row.dropped .rb-sha {
    opacity: 0.45;
    text-decoration: line-through;
  }
  .rb-grip {
    flex: 0 0 auto;
    color: var(--muted);
    cursor: grab;
  }
  .rb-action {
    flex: 0 0 auto;
    padding: 1px 4px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: var(--input-bg);
    color: var(--fg);
    font-family: var(--mono);
    font-size: 0.85em;
  }
  .rb-sha {
    flex: 0 0 auto;
    font-family: var(--mono);
    font-size: 0.85em;
    color: var(--accent);
  }
  .rb-summary {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rb-moves {
    flex: 0 0 auto;
    display: flex;
    gap: 2px;
    opacity: 0;
  }
  .rb-row:hover .rb-moves,
  .rb-moves:focus-within {
    opacity: 1;
  }
  .rb-moves button {
    border: 1px solid var(--border);
    border-radius: 3px;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    font-size: 0.8em;
    line-height: 1;
    padding: 1px 4px;
  }
  .rb-moves button:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .rb-foot {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    border-top: 1px solid var(--border);
  }
  .rb-note {
    flex: 1;
    color: var(--muted);
    font-size: 0.8em;
  }
  .rb-problem {
    color: var(--error-fg, #f0b4b4);
  }
  .rb-foot button {
    padding: 4px 12px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--input-bg);
    color: var(--fg);
    cursor: pointer;
    font-size: 0.85em;
  }
  .rb-foot .rb-start {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
    font-weight: 600;
  }
  .rb-foot button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
