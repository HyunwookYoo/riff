<script lang="ts">
  import { mount, onMount, unmount, type Component } from "svelte";
  import type { EditorView } from "@codemirror/view";
  import type { Extension } from "@codemirror/state";
  import { appState } from "$lib/store.svelte";
  import {
    reviewState,
    refreshList,
    startAutoRefresh,
    isInlineThread,
    writeRecord,
    UNREADABLE,
  } from "$lib/review/reviewState.svelte";
  import { onRecordChanged } from "$lib/review/draftStore";
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
  import { reviewExtension, setInlineItems, trackView, type InlineItem } from "./cmReview";

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

  // Line composer; `anchor` is the first clicked line a shift-click extends from.
  type ComposerAt = { path: string; side: Side; anchor: number; line: number; startLine: number | null };
  let composer = $state.raw<ComposerAt | null>(null);
  let composerText = "";
  let note = $state.raw<{ path: string; side: Side; line: number; text: string } | null>(null);

  $effect(() => {
    void reviewState.selectedKey;
    composer = null;
    note = null;
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
    note = null;
    const c = composer;
    if (shift && c && c.path === path && c.side === side) {
      const start = Math.min(c.anchor, line);
      const end = Math.max(c.anchor, line);
      if (start !== end && !isCommentable(fileHunks(path), side, end, start)) {
        note = { path, side, line, text: "A range must stay inside one diff hunk." };
        return;
      }
      composer = { ...c, line: end, startLine: start === end ? null : start };
      return;
    }
    composerText = "";
    composer = { path, side, anchor: line, line, startLine: null };
  }

  async function addLineComment(c: ComposerAt, body: string) {
    const r = reviewState.record;
    const t = c.side === "LEFT" ? viewA : viewB;
    if (!r || !t?.alive || t.path !== c.path) return;
    const doc = t.view.state.doc;
    const quote: string[] = [];
    for (let n = c.startLine ?? c.line; n <= c.line; n++) quote.push(doc.line(n).text);
    const target = { kind: "line" as const, path: c.path, side: c.side, line: c.line, startLine: c.startLine, quote };
    await writeRecord(addItem(r, target, body, "mine"));
    if (composer === c) composer = null;
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
        out.push({ line: t.line!, key: `t:${t.id}`, mount: mountWith(InlineThread, { threadId: t.id }) });
      }
    }
    for (const i of reviewState.record?.items ?? []) {
      const tg = i.target;
      if (tg.kind === "line" && tg.path === path && tg.side === side && !i.unplaced) {
        out.push({ line: tg.line, key: `d:${i.id}`, mount: mountWith(InlineDraft, { itemId: i.id }) });
      }
    }
    const c = composer;
    if (c && c.path === path && c.side === side) {
      const label = c.startLine !== null ? `Comment on lines ${c.startLine}–${c.line}` : `Comment on line ${c.line}`;
      out.push({
        line: c.line,
        key: `c:${c.startLine}:${c.line}`,
        mount: mountWith(Composer, {
          label,
          initial: composerText,
          ontext: (t: string) => (composerText = t),
          onsubmit: (body: string) => addLineComment(c, body),
          oncancel: () => {
            if (composer === c) composer = null;
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

<div class="review-view">
  <div class="left" class:with-files={!!reviewState.selectedKey && reviewState.files.length > 0}>
    <PrList />
    {#if reviewState.selectedKey && reviewState.files.length > 0}
      <ReviewFiles />
    {/if}
  </div>
  <main class="review-main">
    {#if reviewState.selectedKey}
      {#if reviewState.error}
        <div class="banner">{reviewState.error}</div>
      {/if}
      <PrOverview />
      {#if source}
        <DiffView {source} {sideExtensions} forceSideBySide />
      {:else if !reviewState.headSha && !reviewState.error}
        <div class="placeholder">Loading PR…</div>
      {:else}
        <div class="placeholder">No file selected</div>
      {/if}
    {:else}
      <div class="placeholder">Select a PR</div>
    {/if}
  </main>
</div>

<style>
  .review-view {
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: 340px 1fr;
    min-height: 0;
    min-width: 0;
  }
  .left {
    display: grid;
    grid-template-rows: minmax(0, 1fr);
    min-height: 0;
  }
  .left.with-files {
    grid-template-rows: minmax(0, 2fr) minmax(0, 3fr);
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
  .placeholder {
    margin: auto;
    color: var(--muted);
  }
</style>
