<script lang="ts">
  import { reviewState, writeRecord } from "$lib/review/reviewState.svelte";
  import { addItem } from "$lib/review/draft";
  import { draftLocked } from "$lib/review/submitFlow.svelte";
  import { setHandled } from "$lib/review/ai/aiState.svelte";
  import { findingReaction, recordReaction } from "$lib/review/ai/memory";
  import type { ShownFinding } from "$lib/review/ai/result";
  import type { PrKey } from "$lib/review/types";
  import { textStash } from "./composerAt";

  let {
    prKey,
    createdAt,
    finding,
    showPath = false,
    onevidence,
  }: {
    prKey: PrKey;
    /** The result the finding belongs to (finding ids are positional within it). */
    createdAt: string;
    finding: ShownFinding;
    /** In a list (not at its diff line): say where it is. */
    showPath?: boolean;
    /** Select `path` and reveal `line` (null: just the file). */
    onevidence: (path: string, line: number | null) => void;
  } = $props();

  const f = $derived(finding);
  const unconfirmed = $derived(f.status === "unconfirmed");
  const editKey = $derived(`ai:${createdAt}:${f.id}`);
  // An open edit survives the widget being redrawn.
  // svelte-ignore state_referenced_locally
  let editing = $state(textStash.has(editKey));
  // svelte-ignore state_referenced_locally
  let text = $state(textStash.get(editKey) ?? "");
  let evidenceOpen = $state(false);
  let busy = $state(false);
  // No record, or a submit is sending it: the draft can't change.
  const blocked = $derived(!reviewState.record || draftLocked() || reviewState.selectedKey !== prKey);
  const inPr = (path: string) => reviewState.files.some((x) => x.path === path);

  function startEdit() {
    text = f.body;
    textStash.set(editKey, text);
    editing = true;
  }

  function stopEdit() {
    textStash.delete(editKey);
    editing = false;
  }

  const handle = (how: "added" | "discarded") =>
    setHandled(prKey, createdAt, f.id, how).catch((e) => {
      reviewState.error = `AI result not saved: ${e}`;
    });

  // Built before awaiting: an added finding hides, which can unmount this widget.
  function reaction(how: "added" | "edited" | "discarded") {
    const repo = reviewState.prs.find((p) => p.key === prKey)?.repo;
    return repo ? findingReaction(f, how, repo) : null;
  }

  async function add(body: string, edited: boolean) {
    const r = reviewState.record;
    if (!r || blocked || busy || !body.trim()) return;
    busy = true;
    const memo = reaction(edited ? "edited" : "added");
    try {
      const origin = unconfirmed ? "ai-unconfirmed" : edited ? "ai-edited" : "ai";
      // Both in this tick: the finding hides with the draft appearing, so it can't be added twice
      // and the mark can't land on a result that arrives while the draft saves.
      const w = writeRecord(addItem(r, f.target, body, origin));
      const h = handle("added");
      textStash.delete(editKey);
      await w;
      await h;
      if (memo) recordReaction(memo);
    } finally {
      busy = false;
    }
  }

  async function discard() {
    if (blocked || busy) return;
    busy = true;
    const memo = reaction("discarded");
    try {
      textStash.delete(editKey);
      await handle("discarded");
      if (memo) recordReaction(memo);
    } finally {
      busy = false;
    }
  }

  const where = (path: string, line: number | null) => (line !== null ? `${path}:${line}` : path);
</script>

<div class="finding" class:unconfirmed>
  <div class="head">
    <span class="sev {f.severity}">{f.severity}</span>
    {#if unconfirmed}<span class="tag">Unconfirmed</span>{/if}
    {#if showPath}<span class="loc" title={f.path}>{where(f.path, f.line)}</span>{/if}
    <span class="spacer"></span>
    {#if !editing}
      <button type="button" onclick={() => void add(f.body, false)} disabled={blocked || busy}>Add to draft</button>
      <button type="button" onclick={startEdit} disabled={blocked || busy}>Edit</button>
      <button type="button" onclick={() => void discard()} disabled={blocked || busy}>Discard</button>
    {/if}
    <button type="button" onclick={() => (evidenceOpen = !evidenceOpen)}>
      {evidenceOpen ? "Hide evidence" : "Show evidence"}
    </button>
  </div>
  {#if editing}
    <textarea bind:value={text} rows="4" oninput={(e) => textStash.set(editKey, e.currentTarget.value)}></textarea>
    <div class="actions">
      <button type="button" onclick={stopEdit}>Cancel</button>
      <button type="button" class="primary" onclick={() => void add(text, true)} disabled={blocked || busy || !text.trim()}>
        Add to draft
      </button>
    </div>
  {:else}
    <pre class="body">{f.body}</pre>
  {/if}
  <!-- Context for the reviewer only: never part of the draft body. -->
  {#if f.failureScenario}<p class="scenario">Failure scenario: {f.failureScenario}</p>{/if}
  {#if evidenceOpen}
    <ul class="evidence">
      {#each f.evidence as e, i (i)}
        <li>
          {#if inPr(e.path)}
            <button type="button" class="link" onclick={() => onevidence(e.path, e.line)}>
              {where(e.path, e.line)}
            </button>
          {:else}
            <span class="loc">{where(e.path, e.line)}</span>
          {/if}
          <pre class="quote">{e.quote}</pre>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .finding {
    padding: 6px;
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: 4px;
    background: var(--bg);
  }
  .finding.unconfirmed {
    border-left-color: var(--muted);
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    font-size: 0.85em;
  }
  .sev,
  .tag {
    font-weight: 600;
    padding: 0 6px;
    border-radius: 8px;
    border: 1px solid currentColor;
  }
  .sev.high {
    color: var(--error-fg);
  }
  .sev.medium {
    color: var(--warn-fg, #d29922);
  }
  .sev.low,
  .tag {
    color: var(--muted);
  }
  .loc {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--mono);
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
  .scenario {
    margin: 4px 0 0;
    white-space: pre-wrap;
    word-break: break-word;
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
  }
  button.primary {
    border-color: var(--accent);
    background: var(--accent);
    color: white;
  }
  .evidence {
    margin: 4px 0 0;
    padding-left: 16px;
    font-size: 0.85em;
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
