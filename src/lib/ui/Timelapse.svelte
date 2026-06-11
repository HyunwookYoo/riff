<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import {
    Decoration,
    type DecorationSet,
    EditorView,
    lineNumbers,
  } from "@codemirror/view";
  import {
    Compartment,
    EditorState,
    StateEffect,
    StateField,
    type Extension,
    type Range,
  } from "@codemirror/state";
  import { appState } from "$lib/store.svelte";
  import { fileRevisions, timelapseFrame } from "$lib/git";
  import { isDarkMode, shikiExtension } from "$lib/diff/shiki";
  import { detectLanguage } from "$lib/diff/lang";
  import { repoPathFor } from "$lib/workspace";
  import type { Commit, DiffChange, FileDiff, RepoFile } from "$lib/types";

  let host = $state<HTMLDivElement>();
  let view: EditorView | null = null;

  // Minimap (VS-style): the whole file scaled into a strip, with add/del
  // highlights and a draggable viewport box.
  let mini = $state<HTMLCanvasElement>();
  let miniViewTop = $state(0);
  let miniViewH = $state(0);
  let currentChanges: DiffChange[] = []; // last frame's changes, for redraws
  const MINI_COLS = 110; // assumed columns mapped across the minimap width

  // Syntax highlighting (shiki) is heavy to recompute, so it's applied only
  // when a frame "settles" (playback paused / scrub stopped): the doc swap
  // clears stale colors, and this compartment is reconfigured ~130ms later.
  const syntax = new Compartment();
  let currentContent = "";
  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  // The target captured when the overlay opened. Reading the store directly
  // would let a background blame-file switch yank the timeline mid-playback.
  let target = $state<RepoFile | null>(null);
  let repoPath = $state<string | null>(null);

  let revisions = $state<Commit[]>([]); // oldest → newest (playback order)
  let index = $state(0);
  let playing = $state(false);
  let speed = $state(2); // frames per second
  let loadError = $state<string | null>(null);
  let loadingTimeline = $state(false);
  // Per-frame note when a revision isn't text (binary / too large).
  let frameNote = $state<string | null>(null);

  // Fetched frames keyed by revision index. A frame is the diff viewer's
  // FileDiff; only `text` is playable.
  const frames = new Map<number, FileDiff>();

  const current = $derived(revisions[index] ?? null);

  // ---- CodeMirror: one editor, doc swapped per frame; changed lines are
  // highlighted via a StateField fed by a per-frame effect. No syntax
  // highlighting — keeping frame swaps to a single cheap transaction is what
  // makes scrubbing/playback smooth.
  const setFrame = StateEffect.define<DiffChange[]>();
  const frameField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(deco, tr) {
      for (const e of tr.effects) {
        if (e.is(setFrame)) return buildDecos(tr.state.doc, e.value);
      }
      return deco.map(tr.changes);
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  // line number → "add" (inserted/changed) wins over "del" (deletion point).
  function changedLineMap(
    doc: EditorState["doc"],
    changes: DiffChange[],
  ): Map<number, "add" | "del"> {
    const lineClass = new Map<number, "add" | "del">();
    for (const c of changes) {
      const inserted = c.to_b > c.from_b;
      const from = Math.min(c.from_b, doc.length);
      const to = Math.min(Math.max(c.to_b, c.from_b), doc.length);
      const startLn = doc.lineAt(from).number;
      const endLn = doc.lineAt(to).number;
      for (let ln = startLn; ln <= endLn; ln++) {
        if (inserted || !lineClass.has(ln)) {
          lineClass.set(ln, inserted ? "add" : "del");
        }
      }
    }
    return lineClass;
  }

  function buildDecos(
    doc: EditorState["doc"],
    changes: DiffChange[],
  ): DecorationSet {
    const lineClass = changedLineMap(doc, changes);
    const ranges: Range<Decoration>[] = [...lineClass.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([ln, cls]) =>
        Decoration.line({
          class: cls === "add" ? "tl-changed" : "tl-deleted",
        }).range(doc.line(ln).from),
      );
    return Decoration.set(ranges);
  }

  // Draw the whole file scaled into the minimap: faint blocks per line
  // (indent + length, so it reads like code), with add/del bands + glyphs.
  function drawMinimap() {
    const canvas = mini;
    if (!canvas || !view) return;
    const doc = view.state.doc;
    const total = doc.lines;
    const rect = canvas.getBoundingClientRect();
    const cssW = rect.width;
    const cssH = rect.height;
    if (cssW === 0 || cssH === 0 || total === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const lineH = cssH / total;
    const colW = cssW / MINI_COLS;
    const dark = isDarkMode();
    const faint = dark ? "rgba(210,210,225,0.28)" : "rgba(45,45,60,0.30)";
    const cls = changedLineMap(doc, currentChanges);

    // Pass 1: a soft full-width band plus a solid left edge bar (like an
    // editor change-bar) so edits stay obvious even on dense files.
    const STRIPE_W = 3;
    for (const [ln, c] of cls) {
      const y = (ln - 1) * lineH;
      const h = Math.max(lineH, 2);
      ctx.fillStyle =
        c === "add" ? "rgba(63,185,80,0.38)" : "rgba(248,81,73,0.38)";
      ctx.fillRect(0, y, cssW, h);
      ctx.fillStyle = c === "add" ? "rgb(63,185,80)" : "rgb(248,81,73)";
      ctx.fillRect(0, y, STRIPE_W, h);
    }
    // Pass 2: per-line content blocks (indent → length), colored if changed.
    for (let i = 1; i <= total; i++) {
      const text = doc.line(i).text;
      const len = text.replace(/\s+$/, "").length;
      if (len === 0) continue;
      let indent = 0;
      while (indent < text.length && (text[indent] === " " || text[indent] === "\t")) {
        indent++;
      }
      const x = Math.min(indent * colW, cssW);
      const w = Math.min((len - indent) * colW, cssW - x);
      const c = cls.get(i);
      ctx.fillStyle =
        c === "add"
          ? "rgba(63,185,80,0.95)"
          : c === "del"
            ? "rgba(248,81,73,0.95)"
            : faint;
      ctx.fillRect(x, (i - 1) * lineH, Math.max(w, 0.8), Math.max(lineH * 0.7, 0.6));
    }
  }

  function updateViewportBox() {
    const canvas = mini;
    const sc = view?.scrollDOM;
    if (!canvas || !sc) return;
    const cssH = canvas.getBoundingClientRect().height;
    const sh = sc.scrollHeight;
    if (sh <= 0) return;
    miniViewTop = (sc.scrollTop / sh) * cssH;
    miniViewH = Math.max(10, (sc.clientHeight / sh) * cssH);
  }

  // Defer to a frame so layout (and the just-swapped doc) is settled.
  function scheduleMinimap() {
    requestAnimationFrame(() => {
      drawMinimap();
      updateViewportBox();
    });
  }

  function onEditorScroll() {
    updateViewportBox();
  }

  // Apply shiki once the frame settles (no new frame within the debounce).
  function scheduleSyntax() {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => void applySyntax(), 130);
  }
  async function applySyntax() {
    if (!view || !target) return;
    const content = currentContent;
    const ext = await shikiExtension(
      content,
      detectLanguage(target.path),
      isDarkMode(),
    );
    // A newer frame swapped in while we tokenized → its own settle will win.
    if (!view || currentContent !== content) return;
    view.dispatch({ effects: syntax.reconfigure(ext ?? []) });
  }

  function miniScrollTo(clientY: number) {
    const canvas = mini;
    if (!canvas || !view) return;
    const rect = canvas.getBoundingClientRect();
    const total = view.state.doc.lines;
    const ln = Math.max(
      1,
      Math.min(total, Math.floor(((clientY - rect.top) / rect.height) * total) + 1),
    );
    const pos = view.state.doc.line(ln).from;
    view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "center" }) });
  }
  function onMiniDown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    miniScrollTo(e.clientY);
    const move = (ev: PointerEvent) => miniScrollTo(ev.clientY);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function mountEditor() {
    if (!host || view) return;
    const exts: Extension[] = [
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.lineWrapping,
      // Match the app theme so the line-number gutter isn't stuck on light.
      EditorView.darkTheme.of(isDarkMode()),
      EditorView.theme({ ".cm-scroller": { fontFamily: "var(--mono)" } }),
      lineNumbers(),
      frameField,
      syntax.of([]),
    ];
    view = new EditorView({
      state: EditorState.create({ doc: "", extensions: exts }),
      parent: host,
    });
    view.scrollDOM.addEventListener("scroll", onEditorScroll);
  }

  function showFrame(diff: FileDiff) {
    if (!view) return;
    if (diff.kind !== "text") {
      frameNote =
        diff.kind === "binary"
          ? "Binary at this revision — nothing to show."
          : diff.kind === "too-large"
            ? "File too large at this revision."
            : "No text at this revision.";
      currentChanges = [];
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: "" },
        effects: setFrame.of([]),
      });
      return;
    }
    frameNote = null;
    currentChanges = diff.changes;
    currentContent = diff.new_content;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: diff.new_content },
      // Clear stale colors immediately; settle re-applies for the new content.
      effects: [setFrame.of(diff.changes), syntax.reconfigure([])],
    });
    scheduleMinimap();
    scheduleSyntax();
    // Anchor the view at the first change so the eye lands where it moved.
    const first = diff.changes[0];
    if (first) {
      const pos = Math.min(first.from_b, view.state.doc.length);
      view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    }
  }

  async function fetchFrame(i: number): Promise<FileDiff | null> {
    if (frames.has(i)) return frames.get(i)!;
    const rev = revisions[i];
    if (!rev || !repoPath || !target) return null;
    try {
      const diff = await timelapseFrame(
        repoPath,
        rev.sha,
        revisions[i - 1]?.sha ?? null,
        target.path,
      );
      frames.set(i, diff);
      return diff;
    } catch (e) {
      loadError = String(e);
      return null;
    }
  }

  // Load the frame at `index` and prefetch the next couple so playback stays
  // ahead of the timer.
  async function loadAt(i: number) {
    const diff = await fetchFrame(i);
    if (diff && i === index) showFrame(diff);
    void fetchFrame(i + 1);
    void fetchFrame(i + 2);
  }

  // ---- lifecycle ----

  async function open() {
    const t = appState.timelapseTarget;
    if (!t) return;
    target = t;
    repoPath = repoPathFor(t);
    revisions = [];
    frames.clear();
    index = 0;
    playing = false;
    loadError = null;
    frameNote = null;
    if (!repoPath) {
      loadError = "repo no longer in workspace";
      return;
    }
    loadingTimeline = true;
    try {
      const log = await fileRevisions(repoPath, t.path);
      revisions = log.slice().reverse(); // oldest → newest
    } catch (e) {
      loadError = String(e);
      loadingTimeline = false;
      return;
    }
    loadingTimeline = false;
    if (revisions.length === 0) {
      loadError = "no history for this file";
      return;
    }
    index = revisions.length - 1; // start on the newest (current) state
    await tick();
    mountEditor();
    await loadAt(index);
  }

  function close() {
    playing = false;
    appState.timelapseOpen = false;
  }

  function teardown() {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = null;
    view?.scrollDOM.removeEventListener("scroll", onEditorScroll);
    view?.destroy();
    view = null;
  }
  onDestroy(teardown);

  // React to (re)opening: the overlay is mounted once and toggled via the store.
  $effect(() => {
    if (appState.timelapseOpen) {
      void open();
    } else {
      teardown();
    }
  });

  // Whenever the index moves, paint that frame (from cache or fetch).
  $effect(() => {
    const i = index;
    if (!view) return;
    const cached = frames.get(i);
    if (cached) {
      showFrame(cached);
      void fetchFrame(i + 1);
    } else {
      void loadAt(i);
    }
  });

  // Playback timer. Re-armed when speed changes; stops at the newest frame.
  $effect(() => {
    if (!playing) return;
    const ms = Math.max(60, Math.round(1000 / speed));
    const id = setInterval(() => {
      if (index >= revisions.length - 1) {
        playing = false;
        return;
      }
      index += 1;
    }, ms);
    return () => clearInterval(id);
  });

  function togglePlay() {
    if (index >= revisions.length - 1) index = 0; // replay from start
    playing = !playing;
  }
  function step(delta: number) {
    playing = false;
    index = Math.min(revisions.length - 1, Math.max(0, index + delta));
  }

  function onKey(e: KeyboardEvent) {
    if (!appState.timelapseOpen) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === " ") {
      e.preventDefault();
      togglePlay();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      step(1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      step(-1);
    }
  }

  function relDate(unixSec: number): string {
    const diff = Date.now() / 1000 - unixSec;
    if (diff < 3600) return `${Math.max(1, Math.floor(diff / 60))}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
    if (diff < 31536000) return `${Math.floor(diff / 2592000)}mo ago`;
    return `${Math.floor(diff / 31536000)}y ago`;
  }
</script>

<svelte:window onkeydown={onKey} onresize={scheduleMinimap} />

{#if appState.timelapseOpen}
  <div class="tl-backdrop">
    <button type="button" class="tl-scrim" aria-label="Close timelapse" onclick={close}></button>
    <div class="tl-modal" role="dialog" aria-label="File timelapse" tabindex="-1">
      <header class="tl-head">
        <span class="tl-title" title={target?.path ?? ""}>
          🎞 {target?.path ?? ""}
        </span>
        <button type="button" class="tl-close" title="Close (Esc)" onclick={close}>✕</button>
      </header>

      {#if loadError}
        <div class="tl-msg error">{loadError}</div>
      {:else if loadingTimeline}
        <div class="tl-msg">Loading history…</div>
      {:else}
        <div class="tl-body">
          <div class="tl-host" bind:this={host} class:hidden={frameNote !== null}></div>
          {#if !frameNote}
            <div class="tl-mini-wrap">
              <canvas class="tl-mini" bind:this={mini} onpointerdown={onMiniDown}></canvas>
              <div
                class="tl-mini-view"
                style="top: {miniViewTop}px; height: {miniViewH}px"
              ></div>
            </div>
          {/if}
          {#if frameNote}
            <div class="tl-msg overlay">{frameNote}</div>
          {/if}
        </div>

        <div class="tl-meta">
          {#if current}
            <span class="tl-sha">{current.short_sha}</span>
            <span class="tl-author">{current.author}</span>
            <span class="tl-date">{relDate(current.time)}</span>
            <span class="tl-summary" title={current.summary}>{current.summary}</span>
          {/if}
        </div>

        <div class="tl-controls">
          <button type="button" title="Step back (←)" onclick={() => step(-1)} disabled={index === 0}>⏮</button>
          <button type="button" class="play" title="Play / Pause (Space)" onclick={togglePlay}>
            {playing ? "⏸" : "▶"}
          </button>
          <button
            type="button"
            title="Step forward (→)"
            onclick={() => step(1)}
            disabled={index >= revisions.length - 1}>⏭</button
          >
          <input
            class="tl-slider"
            type="range"
            min="0"
            max={Math.max(0, revisions.length - 1)}
            bind:value={index}
            oninput={() => (playing = false)}
          />
          <span class="tl-counter">{index + 1} / {revisions.length}</span>
          <label class="tl-speed" title="Playback speed">
            <select bind:value={speed}>
              <option value={1}>1×</option>
              <option value={2}>2×</option>
              <option value={4}>4×</option>
              <option value={8}>8×</option>
            </select>
          </label>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .tl-backdrop {
    position: fixed;
    inset: 0;
    z-index: 1200;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 4vh 4vw;
  }
  .tl-scrim {
    position: absolute;
    inset: 0;
    border: none;
    background: transparent;
    cursor: default;
    padding: 0;
  }
  .tl-modal {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    max-width: 1100px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 12px 48px rgba(0, 0, 0, 0.4);
  }
  .tl-head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--bar-bg);
  }
  .tl-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--mono);
    font-size: 0.9em;
  }
  .tl-close {
    border: none;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    font-size: 1em;
    padding: 2px 6px;
  }
  .tl-close:hover {
    color: var(--fg);
  }
  .tl-body {
    flex: 1;
    position: relative;
    display: flex;
    min-height: 0;
    overflow: hidden;
  }
  .tl-host {
    flex: 1;
    min-width: 0;
    height: 100%;
    overflow: auto;
    font-family: var(--mono);
    font-size: var(--diff-font-size);
  }
  .tl-mini-wrap {
    position: relative;
    flex: 0 0 88px;
    width: 88px;
    height: 100%;
    border-left: 1px solid var(--border);
    background: var(--bar-bg);
  }
  .tl-mini {
    display: block;
    width: 100%;
    height: 100%;
    cursor: pointer;
  }
  .tl-mini-view {
    position: absolute;
    left: 0;
    right: 0;
    background: var(--accent-soft, rgba(74, 158, 255, 0.18));
    border: 1px solid var(--accent);
    border-left: none;
    border-right: none;
    pointer-events: none;
  }
  .tl-host.hidden {
    display: none;
  }
  .tl-msg {
    padding: 16px;
    color: var(--muted);
    font-size: 0.9em;
  }
  .tl-msg.error {
    color: var(--error-fg);
  }
  .tl-msg.overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .tl-meta {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 6px 12px;
    border-top: 1px solid var(--border);
    background: var(--bar-bg);
    font-size: 0.8em;
    min-width: 0;
  }
  .tl-sha {
    font-family: var(--mono);
    opacity: 0.7;
    flex-shrink: 0;
  }
  .tl-author {
    font-weight: 600;
    flex-shrink: 0;
  }
  .tl-date {
    opacity: 0.6;
    flex-shrink: 0;
  }
  .tl-summary {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    opacity: 0.85;
    min-width: 0;
  }
  .tl-controls {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-top: 1px solid var(--border);
    background: var(--bar-bg);
  }
  .tl-controls button {
    border: 1px solid var(--border);
    background: var(--input-bg);
    color: inherit;
    cursor: pointer;
    border-radius: 4px;
    padding: 3px 9px;
    font-size: 0.9em;
  }
  .tl-controls button:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
  }
  .tl-controls button:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .tl-controls .play {
    min-width: 34px;
  }
  .tl-slider {
    flex: 1;
    min-width: 0;
    accent-color: var(--accent);
  }
  .tl-counter {
    font-variant-numeric: tabular-nums;
    font-size: 0.8em;
    opacity: 0.7;
    flex-shrink: 0;
  }
  .tl-speed select {
    background: var(--input-bg);
    color: inherit;
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 2px 4px;
    font-size: 0.8em;
  }

  /* Changed-line highlights (injected globally — CodeMirror lifts line DOM). */
  :global(.cm-line.tl-changed) {
    background-color: rgba(63, 185, 80, 0.16);
    box-shadow: inset 2px 0 rgba(63, 185, 80, 0.8);
  }
  :global(.cm-line.tl-deleted) {
    box-shadow: inset 2px 0 rgba(248, 81, 73, 0.8);
  }
</style>
