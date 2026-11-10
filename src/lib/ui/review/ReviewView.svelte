<script lang="ts">
  import { mount, onMount, unmount, untrack, type Component } from "svelte";
  import { EditorView } from "@codemirror/view";
  import { listen } from "@tauri-apps/api/event";
  import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
  import type { Extension } from "@codemirror/state";
  import { appState } from "$lib/store.svelte";
  import {
    reviewState,
    refreshList,
    startAutoRefresh,
    isInlineThread,
    openPr,
    writeRecord,
    readTexts,
    UNREADABLE,
  } from "$lib/review/reviewState.svelte";
  import { aiState, isStale, requestAi } from "$lib/review/ai/aiState.svelte";
  import { chaptersFor, findingsToShow } from "$lib/review/ai/result";
  import { hasReview } from "$lib/review/ai/rereview";
  import { onRecordChanged, REVEAL_EVENT, type RevealPayload } from "$lib/review/draftStore";
  import { addItem } from "$lib/review/draft";
  import { isCommentable } from "$lib/review/commentable";
  import type { FileHunks, Side } from "$lib/review/types";
  import type { ChangedFile } from "$lib/types";
  import DiffView from "../DiffView.svelte";
  import PrList from "./PrList.svelte";
  import ReviewFiles from "./ReviewFiles.svelte";
  import PrOverview from "./PrOverview.svelte";
  import InlineThread from "./InlineThread.svelte";
  import InlineDraft from "./InlineDraft.svelte";
  import Composer from "./Composer.svelte";
  import ReviewBar from "./ReviewBar.svelte";
  import NewSinceView from "./NewSinceView.svelte";
  import InlineFinding from "./InlineFinding.svelte";
  import ChapterIntent from "./ChapterIntent.svelte";
  import RereviewButton from "./RereviewButton.svelte";
  import { reviewExtension, setInlineItems, trackView, type InlineItem } from "./cmReview";
  import { clickComposer, composerKey, textStash, type ComposerAt } from "./composerAt";

  onMount(() => {
    void refreshList();
    return startAutoRefresh();
  });

  function toChangedFile(fh: FileHunks, repoIdx: number): ChangedFile {
    const h = fh.hunks;
    const status =
      fh.oldPath !== null && fh.oldPath !== fh.path
        ? "renamed"
        : h.length > 0 && h.every((x) => x.oldStart === 0 && x.oldLines === 0)
          ? "added"
          : h.length > 0 && h.every((x) => x.newStart === 0 && x.newLines === 0)
            ? "deleted"
            : "modified";
    return { path: fh.path, old_path: fh.oldPath, status, repoIdx };
  }

  const summary = $derived(reviewState.prs.find((p) => p.key === reviewState.selectedKey));
  const fileHunks = (path: string | null) => reviewState.files.find((f) => f.path === path);
  // Kept apart from `source` so a list refresh (new summary objects) leaves it stable.
  const changed = $derived.by(() => {
    const fh = fileHunks(reviewState.selectedPath);
    return fh && summary ? toChangedFile(fh, summary.repoIdx) : null;
  });
  const repoPath = $derived(summary ? appState.repos[summary.repoIdx]?.path : undefined);
  const source = $derived(
    repoPath && changed && reviewState.headSha && reviewState.baseSha
      ? {
          repoPath,
          start: reviewState.baseSha,
          target: reviewState.headSha,
          file: changed,
        }
      : undefined,
  );

  // The AI review only: a record holding just a re-review has none.
  const aiResult = $derived.by(() => {
    const r = reviewState.selectedKey ? (aiState.results[reviewState.selectedKey] ?? null) : null;
    return r && hasReview(r) ? r : null;
  });
  // A stale result is re-placed against the displayed head's texts, read once per (result, head).
  const staleFor = $derived.by(() => {
    const r = aiResult;
    const head = reviewState.headSha;
    const mb = reviewState.mergeBase;
    return r && head && mb && isStale(r, head) ? `${r.key}|${r.createdAt}|${head}|${mb}` : null;
  });
  let staleTexts = $state.raw<{ sig: string; texts: Map<string, string> } | null>(null);
  $effect(() => {
    const sig = staleFor;
    if (!sig) return;
    let live = true;
    untrack(() => {
      const r = aiResult;
      const head = reviewState.headSha;
      const mb = reviewState.mergeBase;
      if (!r || !head || !mb || !repoPath || staleTexts?.sig === sig) return;
      const wanted = new Set(r.findings.map((f) => `${f.path}|${f.side}`));
      void readTexts(repoPath, wanted, reviewState.files, mb, head)
        .then((texts) => {
          if (live) staleTexts = { sig, texts };
        })
        .catch(() => {});
    });
    return () => {
      live = false;
    };
  });
  const ai = $derived.by(() => {
    const r = aiResult;
    const head = reviewState.headSha;
    if (!r || !head) return null;
    const texts = staleTexts && staleTexts.sig === staleFor ? staleTexts.texts : undefined;
    return { prKey: r.key, createdAt: r.createdAt, chapters: chaptersFor(r, reviewState.files), ...findingsToShow(r, head, reviewState.files, texts) };
  });
  const chapter = $derived(ai?.chapters.find((c) => reviewState.selectedPath !== null && c.paths.includes(reviewState.selectedPath)) ?? null);

  let composer = $state.raw<ComposerAt | null>(null);
  let note = $state.raw<{ path: string; side: Side; line: number; text: string } | null>(null);
  let newSinceOpen = $state(false);
  // Left column layout (session-only): width, PR list height, PR list folded.
  let viewEl = $state<HTMLDivElement>();
  let leftEl = $state<HTMLDivElement>();
  let leftWidth = $state(340);
  let prHeight = $state<number | null>(null);
  let prCollapsed = $state(false);

  function drag(e: PointerEvent, move: (ev: PointerEvent) => void) {
    if (e.button !== 0) return;
    e.preventDefault();
    const onUp = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", onUp);
  }
  function onLeftResize(e: PointerEvent) {
    const el = viewEl;
    if (!el) return;
    drag(e, (ev) => {
      const r = el.getBoundingClientRect();
      leftWidth = Math.round(Math.min(Math.max(ev.clientX - r.left, 220), Math.max(220, r.width - 360)));
    });
  }
  function onPrResize(e: PointerEvent) {
    const el = leftEl;
    if (!el) return;
    drag(e, (ev) => {
      const r = el.getBoundingClientRect();
      prHeight = Math.round(Math.min(Math.max(ev.clientY - r.top, 80), Math.max(80, r.height - 120)));
    });
  }

  // Main-area tab: the PR description and conversation, or the changed files.
  let tab = $state<"description" | "files">("description");
  // A "Show in main" target waiting for its file's editor.
  let reveal = $state.raw<{ path: string; side: Side; line: number } | null>(null);

  $effect(() => {
    void reviewState.selectedKey;
    composer = null;
    note = null;
    newSinceOpen = false;
    reveal = null;
    tab = "description";
    textStash.clear();
  });

  // The live editors, tagged with the file they were built for.
  type Tracked = { view: EditorView; path: string | null; alive: boolean };
  let viewA = $state.raw<Tracked | null>(null);
  let viewB = $state.raw<Tracked | null>(null);

  function clickLine(path: string | null, side: Side, line: number, shift: boolean) {
    if (!path || path !== reviewState.selectedPath) return;
    if (!reviewState.record) {
      note = { path, side, line, text: reviewState.error ?? UNREADABLE };
      return;
    }
    const prev = composer;
    const r = clickComposer(prev, { path, side, line, shift }, fileHunks(path));
    note = r.note ? { path, side, line, text: r.note } : null;
    if (r.composer === prev) return; // same target: keep the widget and its text
    const next = r.composer;
    // Extending a range keeps the typed text (under the new key); a new composer starts empty.
    if (prev) {
      const text = textStash.get(composerKey(prev));
      textStash.delete(composerKey(prev));
      if (shift && text !== undefined && next && next.path === prev.path && next.side === prev.side) {
        textStash.set(composerKey(next), text);
      }
    }
    composer = next;
  }

  // Widget callbacks name their composer by key: CodeMirror keeps a widget whose
  // key is unchanged, so its closures may predate the current `composer` object.
  const isOpen = (key: string) => !!composer && composerKey(composer) === key;

  async function addLineComment(key: string, body: string): Promise<boolean> {
    const c = composer;
    const r = reviewState.record;
    if (!c || composerKey(c) !== key || !r) return false;
    const t = c.side === "LEFT" ? viewA : viewB;
    if (!t?.alive || t.path !== c.path) return false;
    const doc = t.view.state.doc;
    const quote: string[] = [];
    for (let n = c.startLine ?? c.line; n <= c.line; n++) quote.push(doc.line(n).text);
    const target = { kind: "line" as const, path: c.path, side: c.side, line: c.line, startLine: c.startLine, quote };
    await writeRecord(addItem(r, target, body, "mine"));
    if (isOpen(key)) composer = null;
    return true;
  }

  function sideExtensions(side: "a" | "b"): Extension[] {
    const s: Side = side === "a" ? "LEFT" : "RIGHT";
    const path = reviewState.selectedPath;
    return [
      reviewExtension({
        side: s,
        commentable: (n) => isCommentable(fileHunks(path), s, n),
        onLineClick: (n, shift) => clickLine(path, s, n, shift),
      }),
      trackView((view, alive) => {
        const cur = side === "a" ? viewA : viewB;
        if (!alive) {
          if (cur?.view === view) cur.alive = false;
          return;
        }
        const t = { view, path, alive: true };
        if (side === "a") viewA = t;
        else viewB = t;
      }),
    ];
  }

  function mountWith<P extends Record<string, unknown>>(C: Component<P>, props: P) {
    return (el: HTMLElement) => {
      const c = mount(C, { target: el, props });
      return () => void unmount(c);
    };
  }

  function itemsFor(side: Side): InlineItem[] {
    const path = reviewState.selectedPath;
    const out: InlineItem[] = [];
    for (const t of reviewState.detail?.threads ?? []) {
      if (t.path === path && t.side === side && isInlineThread(t)) {
        out.push({ line: t.line!, key: `t:${t.id}`, mount: mountWith(InlineThread, { threadId: t.id, onevidence: showEvidence }) });
      }
    }
    for (const i of reviewState.record?.items ?? []) {
      const tg = i.target;
      if (tg.kind === "line" && tg.path === path && tg.side === side && !i.unplaced) {
        out.push({ line: tg.line, key: `d:${i.id}`, mount: mountWith(InlineDraft, { itemId: i.id }) });
      }
    }
    const shown = ai;
    for (const f of shown?.inline ?? []) {
      const tg = f.target;
      if (tg.kind === "line" && tg.path === path && tg.side === side) {
        out.push({
          line: tg.line,
          key: `f:${shown!.createdAt}:${f.id}:${tg.line}`,
          mount: mountWith(InlineFinding, {
            prKey: shown!.prKey,
            createdAt: shown!.createdAt,
            finding: f,
            onevidence: showEvidence,
          }),
        });
      }
    }
    const c = composer;
    if (c && c.path === path && c.side === side) {
      const label = c.startLine !== null ? `Comment on lines ${c.startLine}–${c.line}` : `Comment on line ${c.line}`;
      const key = composerKey(c);
      out.push({
        line: c.line,
        key,
        mount: mountWith(Composer, {
          label,
          stashKey: key,
          onsubmit: (body: string) => addLineComment(key, body),
          oncancel: () => {
            if (isOpen(key)) composer = null;
            note = null;
          },
        }),
      });
    }
    const n = note;
    if (n && n.path === path && n.side === side) {
      out.push({
        line: n.line,
        key: `n:${n.line}:${n.text}`,
        mount: (el) => {
          el.classList.add("cm-review-note");
          el.textContent = n.text;
          return () => {};
        },
      });
    }
    return out;
  }

  $effect(() => {
    const path = reviewState.selectedPath;
    const targets: [Tracked | null, InlineItem[]][] = [
      [viewA, itemsFor("LEFT")],
      [viewB, itemsFor("RIGHT")],
    ];
    // Outside the effect: widgets mount Svelte components, which would
    // otherwise become children of this effect and die on its next run.
    queueMicrotask(() => {
      for (const [t, items] of targets) {
        if (t?.alive && t.path === path) t.view.dispatch({ effects: setInlineItems.of(items) });
      }
    });
  });

  // The drafts window's "Show in main": open the PR if needed, select the file, scroll to the line.
  async function onReveal({ key, itemId }: RevealPayload) {
    if (reviewState.selectedKey !== key) {
      if (!reviewState.prs.some((p) => p.key === key)) return;
      await openPr(key);
      if (reviewState.selectedKey !== key) return;
    }
    void getCurrentWebviewWindow().setFocus().catch(() => {});
    const item = reviewState.record?.items.find((i) => i.id === itemId);
    if (!item) return;
    const t = item.target;
    let at: { path: string; side: Side; line: number | null } | null = null;
    if (t.kind === "line") at = { path: t.path, side: t.side, line: item.unplaced ? null : t.line };
    else if (t.kind === "file") at = { path: t.path, side: "RIGHT", line: null };
    else if (t.kind === "reply") {
      const th = reviewState.detail?.threads.find((x) => x.id === t.threadId);
      if (th) at = { path: th.path, side: th.side, line: isInlineThread(th) ? th.line : null };
    }
    if (!at || !fileHunks(at.path)) return;
    newSinceOpen = false;
    tab = "files";
    reviewState.selectedPath = at.path;
    reveal = at.line !== null ? { path: at.path, side: at.side, line: at.line } : null;
  }

  // An AI finding's evidence: select its file (in the PR) and reveal the line.
  function showEvidence(path: string, line: number | null) {
    if (!fileHunks(path)) return;
    newSinceOpen = false;
    tab = "files";
    reviewState.selectedPath = path;
    reveal = line !== null ? { path, side: "RIGHT", line } : null;
  }

  onMount(() => {
    const un = listen<RevealPayload>(REVEAL_EVENT, (e) => void onReveal(e.payload));
    return () => void un.then((u) => u());
  });

  $effect(() => {
    const r = reveal;
    if (!r) return;
    const t = r.side === "LEFT" ? viewA : viewB;
    if (!t?.alive || t.path !== r.path) return; // the file's editor isn't built yet
    reveal = null;
    const view = t.view;
    requestAnimationFrame(() => {
      const n = Math.min(r.line, view.state.doc.lines);
      view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.line(n).from, { y: "center" }) });
    });
  });

  // Another window changed this PR's draft: take it, or stop on an unreadable one.
  $effect(() => {
    const key = reviewState.selectedKey;
    if (!key) return;
    let off: (() => void) | null = null;
    let done = false;
    void onRecordChanged(
      key,
      (r) => {
        if (reviewState.selectedKey === key && reviewState.record) reviewState.record = r;
      },
      () => {
        if (reviewState.selectedKey !== key) return;
        reviewState.record = null;
        reviewState.error = UNREADABLE;
      },
    ).then((u) => (done ? u() : (off = u)));
    return () => {
      done = true;
      off?.();
    };
  });
</script>

<div class="review-view" bind:this={viewEl} style="--left-w: {leftWidth}px">
  <div
    class="left"
    bind:this={leftEl}
    class:with-files={!!reviewState.selectedKey && reviewState.files.length > 0}
    class:pr-collapsed={prCollapsed}
    style={prHeight !== null ? `--pr-h: ${prHeight}px` : undefined}
  >
    <PrList collapsed={prCollapsed} ontoggle={() => (prCollapsed = !prCollapsed)} />
    {#if reviewState.selectedKey && reviewState.files.length > 0}
      {#if !prCollapsed}
        <div class="row-resizer" role="separator" aria-orientation="horizontal" aria-label="Resize pull request list" onpointerdown={onPrResize}></div>
      {/if}
      <ReviewFiles {ai} onevidence={showEvidence} onpickfile={() => (tab = "files")} />
    {/if}
  </div>
  <div class="col-resizer" role="separator" aria-orientation="vertical" aria-label="Resize side panel" onpointerdown={onLeftResize}></div>
  <main class="review-main">
    {#if reviewState.selectedKey}
      {#if reviewState.error}
        <div class="banner">{reviewState.error}</div>
      {/if}
      {#if newSinceOpen}
        <NewSinceView onclose={() => (newSinceOpen = false)} />
      {:else}
        <div class="tabs" role="tablist" aria-label="Pull request">
          <button
            type="button"
            role="tab"
            class="tab"
            class:active={tab === "description"}
            aria-selected={tab === "description"}
            onclick={() => (tab = "description")}
          >
            Description
            {#if reviewState.detail}<span class="count">{reviewState.detail.conversation.length}</span>{/if}
          </button>
          <button
            type="button"
            role="tab"
            class="tab"
            class:active={tab === "files"}
            aria-selected={tab === "files"}
            onclick={() => (tab = "files")}
          >
            Files changed <span class="count">{reviewState.files.length}</span>
          </button>
        </div>
        {#if tab === "description"}
          <div class="description">
            {#if summary}<div class="rereview-row"><RereviewButton pr={summary} /></div>{/if}
            <PrOverview full />
          </div>
        {:else}
          {#if source && chapter && ai}
            <ChapterIntent
              {chapter}
              stale={ai.stale}
              onreanalyse={() => {
                if (summary) requestAi(summary);
              }}
            />
          {/if}
          {#if source}
            <DiffView {source} {sideExtensions} forceSideBySide />
          {:else if !reviewState.headSha && !reviewState.error}
            <div class="placeholder">Loading PR…</div>
          {:else}
            <div class="placeholder">No file selected</div>
          {/if}
        {/if}
      {/if}
      <ReviewBar onnewsince={() => (newSinceOpen = true)} />
    {:else}
      <div class="placeholder">Select a PR</div>
    {/if}
  </main>
</div>

<style>
  .review-view {
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: var(--left-w, 340px) 4px minmax(0, 1fr);
    min-height: 0;
    min-width: 0;
  }
  .left {
    display: grid;
    /* minmax(0, 1fr): long unbreakable content (paths, URLs) must not widen
       the column past 340px and spill over the diff. */
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
  .left.with-files {
    grid-template-rows: var(--pr-h, minmax(0, 2fr)) 4px minmax(0, 3fr);
  }
  .left.pr-collapsed {
    grid-template-rows: auto;
  }
  .left.with-files.pr-collapsed {
    grid-template-rows: auto minmax(0, 1fr);
  }
  .row-resizer,
  .col-resizer {
    background: var(--border);
  }
  .row-resizer {
    cursor: row-resize;
  }
  .col-resizer {
    cursor: col-resize;
  }
  .row-resizer:hover,
  .col-resizer:hover {
    background: var(--accent);
  }
  .review-main {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .banner {
    padding: 6px 10px;
    background: var(--error-bg);
    color: var(--error-fg);
    border-bottom: 1px solid var(--border);
    white-space: pre-wrap;
  }
  .tabs {
    display: flex;
    gap: 2px;
    padding: 0 8px;
    border-bottom: 1px solid var(--border);
    background: var(--bar-bg);
  }
  .tab {
    padding: 6px 12px;
    border: none;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
  }
  .tab:hover {
    color: inherit;
  }
  .tab.active {
    color: inherit;
    border-bottom-color: var(--accent);
    font-weight: 600;
  }
  .count {
    margin-left: 4px;
    padding: 0 6px;
    border-radius: 8px;
    background: var(--hover);
    font-size: 0.85em;
    font-weight: 400;
  }
  .description {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .rereview-row {
    display: flex;
    padding: 0 10px;
  }
  .rereview-row:empty {
    display: none;
  }
  .placeholder {
    margin: auto;
    color: var(--muted);
  }
</style>
