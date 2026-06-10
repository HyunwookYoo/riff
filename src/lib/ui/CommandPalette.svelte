<script lang="ts">
  import { appState } from "$lib/store.svelte";
  import { buildCommands, type Command } from "$lib/commands";
  import { loadBranchesFor } from "$lib/workspace";
  import { loadStashes } from "$lib/sourceControl";

  let query = $state("");
  let highlighted = $state(0);
  let inputEl = $state<HTMLInputElement>();
  let listEl = $state<HTMLDivElement>();

  // On open: reset, refresh the dynamic command sources (branches, stashes),
  // and focus the input.
  let wasOpen = false;
  $effect(() => {
    if (appState.paletteOpen && !wasOpen) {
      query = "";
      highlighted = 0;
      void loadBranchesFor(appState.changesRepoIdx);
      void loadStashes();
      queueMicrotask(() => inputEl?.focus());
    }
    wasOpen = appState.paletteOpen;
  });

  const all = $derived(appState.paletteOpen ? buildCommands() : []);

  // Case-insensitive subsequence match; lower score = better (smaller gaps and
  // more contiguous runs). null = no match.
  function score(q: string, text: string): number | null {
    if (!q) return 0;
    const t = text.toLowerCase();
    let ti = 0;
    let s = 0;
    let last = -2;
    for (const ch of q.toLowerCase()) {
      const idx = t.indexOf(ch, ti);
      if (idx === -1) return null;
      s += idx - ti;
      if (idx !== last + 1) s += 2;
      last = idx;
      ti = idx + 1;
    }
    return s;
  }

  const filtered = $derived.by(() => {
    const q = query.trim();
    const scored = all
      .map((c) => ({ c, s: score(q, c.title) }))
      .filter((x): x is { c: Command; s: number } => x.s !== null);
    scored.sort((a, b) => a.s - b.s || a.c.title.localeCompare(b.c.title));
    return scored.map((x) => x.c);
  });

  $effect(() => {
    void filtered.length;
    if (highlighted >= filtered.length) highlighted = 0;
  });

  // Keep the highlighted row visible under arrow navigation.
  $effect(() => {
    void highlighted;
    queueMicrotask(() =>
      listEl?.querySelector(".cp-row.active")?.scrollIntoView({ block: "nearest" }),
    );
  });

  function close() {
    appState.paletteOpen = false;
  }

  async function run(c: Command | undefined) {
    if (!c) return;
    close();
    await c.run();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filtered.length) highlighted = (highlighted + 1) % filtered.length;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filtered.length)
        highlighted = (highlighted - 1 + filtered.length) % filtered.length;
    } else if (e.key === "Enter") {
      e.preventDefault();
      void run(filtered[highlighted]);
    }
  }
</script>

{#if appState.paletteOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="cp-backdrop" onclick={close} role="presentation">
    <div
      class="cp"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
    >
      <input
        class="cp-input"
        bind:this={inputEl}
        bind:value={query}
        onkeydown={onKey}
        placeholder="Type a command…"
        spellcheck="false"
        autocomplete="off"
      />
      <div class="cp-list" bind:this={listEl}>
        {#if filtered.length === 0}
          <div class="cp-empty">No matching commands.</div>
        {:else}
          {#each filtered as c, i (c.id)}
            <button
              type="button"
              class="cp-row"
              class:active={i === highlighted}
              onmouseenter={() => (highlighted = i)}
              onclick={() => void run(c)}
            >
              <span class="cp-title">{c.title}</span>
              <span class="cp-cat">{c.category}</span>
            </button>
          {/each}
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .cp-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 12vh;
    z-index: 2100;
  }
  .cp {
    width: 540px;
    max-width: calc(100vw - 32px);
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 12px 48px rgba(0, 0, 0, 0.4);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .cp-input {
    border: none;
    border-bottom: 1px solid var(--border);
    background: var(--input-bg);
    color: inherit;
    font-size: 1em;
    padding: 10px 14px;
    outline: none;
  }
  .cp-list {
    max-height: 50vh;
    overflow-y: auto;
    padding: 4px;
  }
  .cp-empty {
    padding: 14px;
    color: var(--muted);
    font-size: 0.88em;
    text-align: center;
  }
  .cp-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    width: 100%;
    border: none;
    background: transparent;
    color: inherit;
    text-align: left;
    padding: 7px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.9em;
  }
  .cp-row.active {
    background: var(--accent-soft);
  }
  .cp-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cp-cat {
    flex: 0 0 auto;
    font-size: 0.72em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1px 7px;
  }
</style>
