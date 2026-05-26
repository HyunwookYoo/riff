<script lang="ts">
  import type { Branch } from "$lib/types";

  // Branch input replacement: click-to-open dropdown with a search input on
  // top, the repo's refs (with kind badges) below, and a free-text fallback
  // row so commit hashes / tags that aren't in the list can still be picked.
  // Used by main and per-submodule override (§13.3 #9).

  interface Props {
    value: string;
    options: Branch[];
    placeholder?: string;
    onchange: (v: string) => void;
    title?: string;
  }

  let { value, options, placeholder, onchange, title }: Props = $props();

  let open = $state(false);
  let triggerEl = $state<HTMLButtonElement | undefined>(undefined);
  let searchEl = $state<HTMLInputElement | undefined>(undefined);
  let panelEl = $state<HTMLDivElement | undefined>(undefined);
  let query = $state("");
  let highlighted = $state(0);

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((b) => b.name.toLowerCase().includes(q));
  });

  // When the query doesn't match any listed ref but is non-empty, offer it
  // as a free-text choice — keeps commit hashes / unlisted refs reachable.
  const freeText = $derived.by<string | null>(() => {
    const q = query.trim();
    if (!q) return null;
    if (filtered.some((b) => b.name === q)) return null;
    return q;
  });

  // Combined visible rows: optional free-text first, then matching refs.
  // `highlighted` indexes into this combined list.
  interface Row {
    kind: "freetext" | "branch";
    value: string;
    label: string;
    branchKind?: Branch["kind"];
  }
  const rows = $derived.by<Row[]>(() => {
    const out: Row[] = [];
    if (freeText) {
      out.push({ kind: "freetext", value: freeText, label: freeText });
    }
    for (const b of filtered) {
      out.push({
        kind: "branch",
        value: b.name,
        label: b.name,
        branchKind: b.kind,
      });
    }
    return out;
  });

  function openPanel() {
    open = true;
    query = "";
    highlighted = 0;
    // Defer so the input exists in the DOM.
    queueMicrotask(() => searchEl?.focus());
  }

  function close() {
    open = false;
    query = "";
  }

  function pick(v: string) {
    onchange(v);
    close();
    triggerEl?.focus();
  }

  function onTriggerKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      e.preventDefault();
      openPanel();
    }
  }

  function onSearchKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      close();
      triggerEl?.focus();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === "ArrowDown") {
      if (rows.length > 0) {
        highlighted = (highlighted + 1) % rows.length;
      }
      e.preventDefault();
      return;
    }
    if (e.key === "ArrowUp") {
      if (rows.length > 0) {
        highlighted = (highlighted - 1 + rows.length) % rows.length;
      }
      e.preventDefault();
      return;
    }
    if (e.key === "Enter") {
      const r = rows[highlighted];
      if (r) pick(r.value);
      else if (freeText) pick(freeText);
      e.preventDefault();
    }
  }

  $effect(() => {
    void rows.length;
    if (highlighted >= rows.length) highlighted = 0;
  });

  function onWindowMouseDown(e: MouseEvent) {
    if (!open) return;
    const t = e.target as Node;
    if (triggerEl?.contains(t) || panelEl?.contains(t)) return;
    close();
  }
</script>

<svelte:window onmousedown={onWindowMouseDown} />

<div class="picker">
  <button
    type="button"
    class="trigger"
    bind:this={triggerEl}
    {title}
    onclick={open ? close : openPanel}
    onkeydown={onTriggerKeyDown}
    aria-haspopup="listbox"
    aria-expanded={open}
  >
    <span class="label" class:empty={!value}>
      {value || placeholder || "—"}
    </span>
    <span class="caret" class:open aria-hidden="true">▾</span>
  </button>
  {#if open}
    <div class="panel" bind:this={panelEl} role="listbox">
      <input
        type="text"
        class="search"
        placeholder="Filter or type a ref…"
        bind:this={searchEl}
        bind:value={query}
        onkeydown={onSearchKeyDown}
        spellcheck="false"
      />
      <div class="rows">
        {#if rows.length === 0}
          <div class="empty">No matching refs.</div>
        {:else}
          {#each rows as r, i (r.kind + ":" + r.value)}
            <button
              type="button"
              class="row"
              class:active={r.value === value}
              class:highlighted={i === highlighted}
              onmouseenter={() => (highlighted = i)}
              onclick={() => pick(r.value)}
            >
              <span class="row-label">{r.label}</span>
              {#if r.kind === "freetext"}
                <span class="row-kind freetext">use as ref</span>
              {:else if r.branchKind}
                <span class="row-kind" data-kind={r.branchKind}>
                  {r.branchKind}
                </span>
              {/if}
            </button>
          {/each}
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .picker {
    position: relative;
    display: inline-block;
  }
  .trigger {
    display: inline-flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    width: 180px;
    font-size: 0.9em;
    padding: 4px 8px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--input-bg);
    color: inherit;
    cursor: pointer;
    font-family: inherit;
  }
  .trigger:hover {
    background: var(--hover);
  }
  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--mono);
    text-align: left;
    flex: 1;
  }
  .label.empty {
    color: var(--muted);
    font-family: inherit;
  }
  .caret {
    font-size: 0.7em;
    opacity: 0.6;
    transition: transform 0.1s ease;
    flex-shrink: 0;
  }
  .caret.open {
    transform: rotate(180deg);
  }
  .panel {
    position: absolute;
    top: calc(100% + 2px);
    left: 0;
    min-width: 260px;
    max-width: 360px;
    background: var(--input-bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 4px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
    z-index: 1000;
    display: flex;
    flex-direction: column;
    padding: 4px;
    gap: 4px;
  }
  .search {
    width: 100%;
    padding: 4px 8px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: var(--bar-bg);
    color: inherit;
    font-size: 0.88em;
  }
  .rows {
    max-height: 320px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }
  .empty {
    padding: 8px 10px;
    color: var(--muted);
    font-size: 0.85em;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    border: none;
    background: transparent;
    color: inherit;
    padding: 4px 8px;
    text-align: left;
    cursor: pointer;
    font-size: 0.88em;
    font-family: inherit;
    border-radius: 2px;
  }
  .row:hover,
  .row.highlighted {
    background: var(--hover);
  }
  .row.active {
    background: var(--selected);
    color: var(--selected-fg);
  }
  .row-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--mono);
  }
  .row-kind {
    font-size: 0.7em;
    padding: 1px 6px;
    border-radius: 8px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    background: var(--bar-bg);
    color: var(--muted);
    border: 1px solid var(--border);
    flex-shrink: 0;
  }
  .row-kind[data-kind="local"] {
    color: var(--accent);
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .row-kind.freetext {
    color: var(--accent);
    border-color: var(--accent);
    font-style: italic;
  }
</style>
