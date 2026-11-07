<script lang="ts">
  import { onMount } from "svelte";
  import { emit, listen } from "@tauri-apps/api/event";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { replaceState } from "$app/navigation";
  import {
    DRAFTS_OPEN_EVENT,
    draftsWindowUrl,
    loadRecord,
    onRecordChanged,
    REVEAL_EVENT,
    saveRecord,
    SUBMIT_REPLY_EVENT,
    SUBMIT_REQUEST_EVENT,
    type RevealPayload,
    type SubmitReply,
    type SubmitRequest,
  } from "$lib/review/draftStore";
  import { applyEdits, removeItem, setEvent, submittable } from "$lib/review/draft";
  import { UNREADABLE } from "$lib/review/reviewState.svelte";
  import type { PrKey, PrRecord, ReviewEvent } from "$lib/review/types";
  import { showToast } from "../toast";
  import { itemLocation, itemPreview, originTag } from "./draftLabels";

  let { initialKey }: { initialKey: PrKey } = $props();

  // svelte-ignore state_referenced_locally
  let key = $state(initialKey);
  let record = $state<PrRecord | null>(null);
  let loadError = $state<string | null>(null);
  let saveError = $state<string | null>(null);
  let status = $state<string | null>(null);
  let sending = $state(false);
  // Typed but not yet saved: item bodies by id, and the review body.
  let edits = $state<Record<string, string>>({});
  let bodyEdit = $state<string | null>(null);

  const EVENTS: { value: ReviewEvent; label: string }[] = [
    { value: "COMMENT", label: "Comment" },
    { value: "APPROVE", label: "Approve" },
    { value: "REQUEST_CHANGES", label: "Request changes" },
  ];

  const empty = $derived(
    !record ||
      (submittable(record).length === 0 &&
        (bodyEdit ?? record.body).trim() === "" &&
        record.event === "COMMENT"),
  );

  // Load and follow the shown PR's record; an unreadable one is shown, never saved over.
  $effect(() => {
    const k = key;
    record = null;
    loadError = null;
    saveError = null;
    status = null;
    edits = {};
    bodyEdit = null;
    let live = true;
    loadRecord(k).then(
      (r) => {
        if (live) record = r;
      },
      (e) => {
        if (live) loadError = isUnreadable(e) ? UNREADABLE : `Couldn't load the draft: ${e}`;
      },
    );
    let off: (() => void) | null = null;
    void onRecordChanged(
      k,
      (r) => {
        if (live && !loadError) record = r;
      },
      (e) => {
        if (!live) return;
        record = null;
        loadError = isUnreadable(e) ? UNREADABLE : `Couldn't load the draft: ${e}`;
      },
    ).then((u) => (live ? (off = u) : u()));
    return () => {
      live = false;
      off?.();
    };
  });

  function isUnreadable(e: unknown) {
    return e instanceof Error && e.message === "unreadable-review-record";
  }

  onMount(() => {
    const offs = [
      listen<{ key: PrKey }>(DRAFTS_OPEN_EVENT, (e) => void switchTo(e.payload.key)),
      listen<SubmitReply>(SUBMIT_REPLY_EVENT, (e) => {
        if (e.payload.key !== key) return;
        sending = false;
        status = e.payload.message;
        showToast(e.payload.message);
      }),
      // Closing (the X, Alt+F4, or the main window closing it) saves what was typed first.
      getCurrentWindow().onCloseRequested(async () => {
        await flush();
      }),
    ];
    return () => offs.forEach((p) => void p.then((u) => u()));
  });

  async function switchTo(next: PrKey) {
    if (next === key) return;
    await flush();
    sending = false;
    key = next;
    replaceState(draftsWindowUrl(next), {});
  }

  async function save(next: PrRecord): Promise<boolean> {
    record = next;
    try {
      await saveRecord(next);
      saveError = null;
      return true;
    } catch (e) {
      saveError = `Draft not saved: ${e}`;
      return false;
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  function scheduleFlush() {
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), 500);
  }

  /** Saves typed edits (blank item bodies stay unsaved). */
  async function flush(): Promise<boolean> {
    clearTimeout(timer);
    const r = record;
    if (!r || loadError) return false;
    const { next, kept } = applyEdits(r, edits, bodyEdit);
    edits = kept;
    bodyEdit = null;
    return next === r ? true : save(next);
  }

  function onItemInput(id: string, text: string) {
    edits[id] = text;
    scheduleFlush();
  }

  function onItemBlur(id: string) {
    // A blank body is never saved: leaving it restores the saved one.
    if (edits[id] !== undefined && !edits[id].trim()) delete edits[id];
    void flush();
  }

  async function remove(id: string) {
    await flush();
    if (record) await save(removeItem(record, id));
    delete edits[id];
  }

  async function chooseEvent(event: ReviewEvent) {
    await flush();
    if (record) await save(setEvent(record, event));
  }

  function showInMain(itemId: string) {
    const p: RevealPayload = { key, itemId };
    void emit(REVEAL_EVENT, p);
  }

  async function requestSubmit() {
    if (!(await flush()) || !record) return;
    const req: SubmitRequest = { key, event: record.event, body: record.body };
    sending = true;
    status = "Submitting from the main window…";
    await emit(SUBMIT_REQUEST_EVENT, req);
  }
</script>

<div class="drafts">
  <header>
    <span class="title">Review draft</span>
    <span class="key" title={key}>{key}</span>
  </header>

  {#if loadError}
    <div class="error">{loadError}</div>
  {/if}
  {#if saveError}
    <div class="error">{saveError}</div>
  {/if}

  <ul class="items">
    {#if record}
      {#each record.items as item (item.id)}
        {@const preview = itemPreview(item)}
        <li>
          <div class="head">
            <span class="loc">{itemLocation(item)}</span>
            <span class="tag" class:grey={item.origin === "ai-unconfirmed"}>{originTag(item)}</span>
            {#if item.unplaced}
              <span class="tag bad">could not place: fix or drop</span>
            {/if}
            <span class="spacer"></span>
            <button type="button" onclick={() => showInMain(item.id)}>Show in main</button>
            <button type="button" onclick={() => void remove(item.id)}>Delete</button>
          </div>
          {#if preview !== null}
            <div class="preview">{preview}</div>
          {/if}
          <textarea
            rows="3"
            value={edits[item.id] ?? item.body}
            oninput={(e) => onItemInput(item.id, e.currentTarget.value)}
            onblur={() => onItemBlur(item.id)}
          ></textarea>
        </li>
      {:else}
        <li class="none">No draft comments.</li>
      {/each}
    {:else if !loadError}
      <li class="none">Loading…</li>
    {/if}
  </ul>

  <footer>
    <textarea
      rows="4"
      placeholder="Review summary (optional)"
      disabled={!record}
      value={bodyEdit ?? record?.body ?? ""}
      oninput={(e) => {
        bodyEdit = e.currentTarget.value;
        scheduleFlush();
      }}
      onblur={() => void flush()}
    ></textarea>
    <div class="row">
      {#each EVENTS as ev (ev.value)}
        <label>
          <input
            type="radio"
            name="review-event"
            value={ev.value}
            checked={record?.event === ev.value}
            disabled={!record}
            onchange={() => void chooseEvent(ev.value)}
          />
          {ev.label}
        </label>
      {/each}
      <span class="spacer"></span>
      <button
        type="button"
        class="primary"
        disabled={!record || sending || empty}
        onclick={() => void requestSubmit()}
      >
        {sending ? "Submitting…" : "Submit to GitHub"}
      </button>
    </div>
    {#if status}
      <div class="status">{status}</div>
    {/if}
  </footer>
</div>

<style>
  .drafts {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--bar-bg);
  }
  .title {
    font-weight: 600;
  }
  .key {
    color: var(--muted);
    font-size: 0.85em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .error {
    padding: 6px 12px;
    background: var(--error-bg);
    color: var(--error-fg);
    border-bottom: 1px solid var(--border);
  }
  .items {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    list-style: none;
    margin: 0;
    padding: 6px 12px;
  }
  .items li {
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
  }
  .items li.none {
    color: var(--muted);
    border: none;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.85em;
  }
  .loc {
    font-family: var(--mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tag {
    padding: 0 6px;
    border-radius: 8px;
    background: var(--accent-soft);
    color: var(--accent);
    white-space: nowrap;
  }
  .tag.grey {
    background: transparent;
    color: var(--muted);
    border: 1px solid var(--border);
  }
  .tag.bad {
    background: var(--error-bg);
    color: var(--error-fg);
  }
  .spacer {
    flex: 1;
  }
  .preview {
    margin-top: 4px;
    font-family: var(--mono);
    font-size: 0.8em;
    color: var(--muted);
    white-space: pre;
    overflow: hidden;
    text-overflow: ellipsis;
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
  footer {
    padding: 8px 12px;
    border-top: 1px solid var(--border);
    background: var(--bar-bg);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 6px;
    font-size: 0.9em;
  }
  .status {
    margin-top: 6px;
    font-size: 0.85em;
    white-space: pre-wrap;
  }
  button {
    padding: 3px 10px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--input-bg);
    color: var(--fg);
    font-size: 0.85em;
  }
  button:not(:disabled) {
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
  }
  .primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
    font-weight: 600;
  }
</style>
