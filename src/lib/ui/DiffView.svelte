<script lang="ts">
  import { onDestroy } from "svelte";
  import {
    Decoration,
    type DecorationSet,
    EditorView,
    GutterMarker,
    ViewPlugin,
    type ViewUpdate,
    gutter,
    hoverTooltip,
    keymap,
  } from "@codemirror/view";
  import { EditorState, type Extension, type Range } from "@codemirror/state";
  import { MergeView, unifiedMergeView } from "@codemirror/merge";
  import { search, searchKeymap } from "@codemirror/search";
  import { appState } from "$lib/store.svelte";
  import { blameFile, fileDiff, worktreeFileDiff } from "$lib/git";
  import { pushAndDrillToCommit } from "$lib/history";
  import type { Blame, BlameCommit, ChangedFile, FileDiff } from "$lib/types";
  import { detectLanguage, supportedLanguages } from "$lib/diff/lang";
  import { isDarkMode, shikiExtension } from "$lib/diff/shiki";
  import { fullLineChangePlugin } from "$lib/diff/fullLine";
  import { setActiveDiffView } from "$lib/diff/activeView";
  import { adjustFontSize, resetFontSize } from "$lib/font";

  let host: HTMLDivElement;
  let mergeView: MergeView | null = null;
  let unifiedView: EditorView | null = null;
  let diff = $state<FileDiff | null>(null);
  let pending = $state(false);
  let loadError = $state<string | null>(null);
  let detectedLang = $state<string | null>(null);
  let langOverride = $state<string | null>(null);

  // Blame state — per-file. Reset on selectedFile / compare context change.
  let blameData = $state<Blame | null>(null);
  let blameLoading = $state(false);
  let blameError = $state<string | null>(null);

  // Reset override + blame whenever the selected file or compare context changes.
  $effect(() => {
    void appState.selectedFile;
    void appState.targetBranch;
    void appState.compareMode;
    void appState.mode;
    langOverride = null;
    blameData = null;
    blameLoading = false;
    blameError = null;
  });

  // Re-render whenever the selected file, view mode, theme, override, or
  // compare mode changes.
  $effect(() => {
    const file = appState.selectedFile;
    const mode = appState.viewMode;
    const theme = appState.effectiveTheme;
    const ov = langOverride;
    const cm = appState.compareMode;
    void file;
    void mode;
    void theme;
    void ov;
    void cm;
    load(false);
  });

  async function load(force: boolean) {
    teardown();
    diff = null;
    loadError = null;
    const file = appState.selectedFile;
    if (!file || !appState.repoPath) return;

    pending = true;
    try {
      if (appState.compareMode === "worktree") {
        diff = await worktreeFileDiff(
          appState.repoPath,
          file.path,
          file.old_path,
          file.status,
          force,
        );
      } else {
        diff = await fileDiff(
          appState.repoPath,
          appState.startBranch,
          appState.targetBranch,
          appState.mode,
          file.path,
          file.old_path,
          force,
        );
      }
    } catch (e) {
      loadError = String(e);
    } finally {
      pending = false;
    }

    if (diff?.kind === "text") {
      await mount(file, diff.old_content, diff.new_content);
    }
  }

  async function mount(file: ChangedFile, oldText: string, newText: string) {
    if (!host) return;
    detectedLang = detectLanguage(file.path);
    const effectiveLang = langOverride ?? detectedLang;
    const dark = isDarkMode();
    const [oldExt, newExt] = await Promise.all([
      shikiExtension(oldText, effectiveLang, dark),
      shikiExtension(newText, effectiveLang, dark),
    ]);

    const baseExts: Extension[] = [
      EditorView.editable.of(false),
      EditorView.lineWrapping,
      EditorView.darkTheme.of(dark),
      EditorView.theme({ ".cm-scroller": { fontFamily: "var(--mono)" } }),
      search({ top: true }),
      keymap.of(searchKeymap),
      fullLineChangePlugin,
      blameTooltipExt,
      blameGutterExt,
      blameLinePlugin,
    ];

    if (appState.viewMode === "side-by-side") {
      mergeView = new MergeView({
        a: {
          doc: oldText,
          extensions: [...baseExts, ...(oldExt ? [oldExt] : [])],
        },
        b: {
          doc: newText,
          extensions: [...baseExts, ...(newExt ? [newExt] : [])],
        },
        parent: host,
        collapseUnchanged: { margin: 3, minSize: 4 },
      });
      setActiveDiffView(mergeView.b);
    } else {
      unifiedView = new EditorView({
        state: EditorState.create({
          doc: newText,
          extensions: [
            ...baseExts,
            ...(newExt ? [newExt] : []),
            unifiedMergeView({
              original: oldText,
              mergeControls: false,
              collapseUnchanged: { margin: 3, minSize: 4 },
            }),
          ],
        }),
        parent: host,
      });
      setActiveDiffView(unifiedView);
    }
    host.addEventListener("mousemove", onHostMouseMove);
    host.addEventListener("mouseleave", onHostMouseLeave);
  }

  function teardown() {
    setActiveDiffView(null);
    mergeView?.destroy();
    mergeView = null;
    unifiedView?.destroy();
    unifiedView = null;
    if (host) {
      host.removeEventListener("mousemove", onHostMouseMove);
      host.removeEventListener("mouseleave", onHostMouseLeave);
      host.innerHTML = "";
    }
    currentPeerSha = null;
  }

  onDestroy(teardown);

  function loadAnyway() {
    void load(true);
  }

  async function ensureBlame() {
    if (blameData || blameLoading) return;
    const file = appState.selectedFile;
    if (!file || !appState.repoPath) return;
    const useContents = appState.compareMode === "worktree";
    // Worktree-added files aren't in HEAD — blame --contents would error.
    if (useContents && file.status === "added") {
      blameError = "Untracked file — no blame history";
      return;
    }
    if (file.status === "deleted") {
      blameError = "Deleted file — nothing to blame";
      return;
    }
    if (!useContents && !appState.targetBranch) return;
    blameLoading = true;
    blameError = null;
    try {
      const rev = useContents ? "HEAD" : appState.targetBranch;
      blameData = await blameFile(
        appState.repoPath,
        file.path,
        rev,
        useContents,
      );
    } catch (e) {
      blameError = String(e);
    } finally {
      blameLoading = false;
    }
  }

  function relativeDate(unixSec: number): string {
    const diff = Date.now() / 1000 - unixSec;
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
    if (diff < 2592000) return `${Math.floor(diff / 604800)}w ago`;
    if (diff < 31536000) return `${Math.floor(diff / 2592000)}mo ago`;
    return `${Math.floor(diff / 31536000)}y ago`;
  }

  function showToast(msg: string) {
    const t = document.createElement("div");
    t.className = "blame-toast";
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add("show"));
    setTimeout(() => {
      t.classList.remove("show");
      setTimeout(() => t.remove(), 250);
    }, 1500);
  }

  function renderBlamePopover(dom: HTMLElement, commit: BlameCommit) {
    dom.innerHTML = "";
    const isUncommitted = commit.sha === "00000000";

    const meta = document.createElement("div");
    meta.className = "blame-meta";
    meta.textContent = isUncommitted
      ? "Not Committed Yet"
      : `${commit.author} · ${relativeDate(commit.author_time)}`;
    dom.appendChild(meta);

    const subject = document.createElement("div");
    subject.className = "blame-subject";
    subject.textContent = isUncommitted
      ? "(uncommitted edits — not yet in HEAD)"
      : commit.summary || "(no subject)";
    dom.appendChild(subject);

    if (!isUncommitted) {
      const actions = document.createElement("div");
      actions.className = "blame-actions";
      const shaBtn = document.createElement("button");
      shaBtn.type = "button";
      shaBtn.className = "blame-sha";
      shaBtn.textContent = commit.sha;
      shaBtn.title = "Copy SHA";
      shaBtn.addEventListener("click", () => {
        void navigator.clipboard.writeText(commit.sha);
        showToast(`Copied ${commit.sha}`);
      });
      actions.appendChild(shaBtn);

      const viewBtn = document.createElement("button");
      viewBtn.type = "button";
      viewBtn.className = "blame-view";
      viewBtn.textContent = "View commit →";
      viewBtn.title = "Open this commit's changes";
      viewBtn.addEventListener("click", () => {
        pushAndDrillToCommit(commit.sha);
      });
      actions.appendChild(viewBtn);
      dom.appendChild(actions);
    }
  }

  function commitColor(sha: string, dark: boolean): string {
    const hue = parseInt(sha.slice(0, 6), 16) % 360;
    return dark ? `hsl(${hue}, 55%, 55%)` : `hsl(${hue}, 65%, 50%)`;
  }

  class BlameMarker extends GutterMarker {
    color: string;
    uncommitted: boolean;
    constructor(color: string, uncommitted: boolean) {
      super();
      this.color = color;
      this.uncommitted = uncommitted;
    }
    eq(other: GutterMarker): boolean {
      return (
        other instanceof BlameMarker &&
        other.color === this.color &&
        other.uncommitted === this.uncommitted
      );
    }
    toDOM(): HTMLElement {
      const el = document.createElement("div");
      el.className = this.uncommitted ? "blame-bar uncommitted" : "blame-bar";
      el.style.background = this.color;
      return el;
    }
  }

  const blameGutterExt = gutter({
    class: "cm-blame-gutter",
    lineMarker(view, line) {
      if (!appState.blameMode || !blameData) return null;
      const lineNum = view.state.doc.lineAt(line.from).number;
      const idx = blameData.line_commit[lineNum - 1];
      if (idx === undefined) return null;
      const commit = blameData.commits[idx];
      if (!commit) return null;
      if (commit.sha === "00000000") {
        return new BlameMarker("transparent", true);
      }
      return new BlameMarker(
        commitColor(commit.sha, appState.effectiveTheme === "dark"),
        false,
      );
    },
  });

  // Adds `data-blame-sha` attribute to each line when blame is loaded.
  // The peer-highlight mousemove handler queries by this attribute.
  const blameLinePlugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(update: ViewUpdate) {
        this.decorations = this.build(update.view);
      }
      build(view: EditorView): DecorationSet {
        if (!appState.blameMode || !blameData) return Decoration.none;
        const ranges: Range<Decoration>[] = [];
        const totalLines = view.state.doc.lines;
        const limit = Math.min(blameData.line_commit.length, totalLines);
        for (let i = 0; i < limit; i++) {
          const idx = blameData.line_commit[i];
          const commit = blameData.commits[idx];
          if (!commit) continue;
          const lineNum = i + 1;
          const line = view.state.doc.line(lineNum);
          ranges.push(
            Decoration.line({
              attributes: { "data-blame-sha": commit.sha },
            }).range(line.from),
          );
        }
        return Decoration.set(ranges);
      }
    },
    { decorations: (v) => v.decorations },
  );

  // Force the active editor(s) to re-evaluate gutter markers and line
  // decorations after Svelte state changes the CM extensions read from.
  function triggerEditorRedraw() {
    const ping = (v: EditorView) => v.dispatch({});
    if (mergeView) {
      ping(mergeView.a);
      ping(mergeView.b);
    } else if (unifiedView) {
      ping(unifiedView);
    }
  }

  $effect(() => {
    void appState.blameMode;
    void blameData;
    triggerEditorRedraw();
  });

  let currentPeerSha: string | null = null;

  function clearPeerHighlight() {
    if (!host || !currentPeerSha) return;
    host.querySelectorAll(".cm-line.blame-peer").forEach((el) => {
      el.classList.remove("blame-peer");
    });
    currentPeerSha = null;
  }

  function onHostMouseMove(e: MouseEvent) {
    if (!appState.blameMode || !blameData) {
      clearPeerHighlight();
      return;
    }
    const target = e.target as HTMLElement | null;
    const line = target?.closest(".cm-line[data-blame-sha]");
    if (!line) {
      clearPeerHighlight();
      return;
    }
    const sha = (line as HTMLElement).dataset.blameSha;
    if (!sha || sha === currentPeerSha) return;
    clearPeerHighlight();
    currentPeerSha = sha;
    host
      .querySelectorAll(`.cm-line[data-blame-sha="${CSS.escape(sha)}"]`)
      .forEach((el) => el.classList.add("blame-peer"));
  }

  function onHostMouseLeave() {
    clearPeerHighlight();
  }

  $effect(() => {
    if (!appState.blameMode) clearPeerHighlight();
  });

  // Active hover tooltip DOM, tracked so a late-arriving blameData fetch can
  // repaint it in place rather than wait for the user to re-hover.
  let activeTooltipDom: HTMLElement | null = null;
  let activeTooltipLine = 0;

  function paintBlamePopoverDom(dom: HTMLElement, lineNum: number) {
    dom.classList.remove("loading", "error");
    if (blameLoading || (!blameData && !blameError)) {
      dom.innerHTML = "";
      dom.textContent = "Loading blame…";
      dom.classList.add("loading");
    } else if (blameError) {
      dom.innerHTML = "";
      dom.textContent = `Blame unavailable: ${blameError}`;
      dom.classList.add("error");
    } else if (blameData) {
      const idx = blameData.line_commit[lineNum - 1];
      if (idx === undefined) {
        dom.innerHTML = "";
        dom.textContent = "No blame info for this line";
      } else {
        renderBlamePopover(dom, blameData.commits[idx]);
      }
    }
  }

  const blameTooltipExt = hoverTooltip((view, pos) => {
    if (!appState.blameMode) return null;
    if (!blameData && !blameLoading && !blameError) {
      void ensureBlame();
    }
    const line = view.state.doc.lineAt(pos);
    const lineNum = line.number;
    return {
      pos: line.from,
      end: line.to,
      above: true,
      create() {
        const dom = document.createElement("div");
        dom.className = "blame-popover";
        paintBlamePopoverDom(dom, lineNum);
        activeTooltipDom = dom;
        activeTooltipLine = lineNum;
        return {
          dom,
          destroy() {
            if (activeTooltipDom === dom) {
              activeTooltipDom = null;
              activeTooltipLine = 0;
            }
          },
        };
      },
    };
  });

  // When blame state changes while a tooltip is open (typical case: the
  // first hover triggered the fetch and the tooltip is still showing
  // "Loading…"), repaint that tooltip's DOM in place.
  $effect(() => {
    void blameData;
    void blameLoading;
    void blameError;
    if (activeTooltipDom) {
      paintBlamePopoverDom(activeTooltipDom, activeTooltipLine);
    }
  });

  function fmt(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
</script>

<div class="diffview">
  <div class="toolbar">
    <div class="meta">
      {#if diff?.kind === "text"}
        <select
          class="lang"
          title="Override language"
          value={langOverride ?? ""}
          onchange={(e) => {
            const v = (e.currentTarget as HTMLSelectElement).value;
            langOverride = v === "" ? null : v;
          }}
        >
          <option value="">
            Auto{detectedLang ? ` (${detectedLang})` : " (plain)"}
          </option>
          {#each supportedLanguages as l (l)}
            <option value={l}>{l}</option>
          {/each}
        </select>
      {/if}
      {#if diff && diff.kind !== "text"}
        <span class="sizes">
          {fmt(diff.old_size)} → {fmt(diff.new_size)}
        </span>
      {/if}
    </div>
    <div class="modes">
      <div class="font-size" title="Diff font size (Ctrl +/- / 0)">
        <button type="button" onclick={() => adjustFontSize(-1)} aria-label="Decrease font size">A−</button>
        <button
          type="button"
          class="size-reset"
          onclick={() => resetFontSize()}
          title="Reset to default"
        >
          {appState.fontSize}
        </button>
        <button type="button" onclick={() => adjustFontSize(1)} aria-label="Increase font size">A+</button>
      </div>
      <button
        type="button"
        class:active={appState.viewMode === "side-by-side"}
        onclick={() => (appState.viewMode = "side-by-side")}
      >
        Split
      </button>
      <button
        type="button"
        class:active={appState.viewMode === "unified"}
        onclick={() => (appState.viewMode = "unified")}
      >
        Unified
      </button>
      <button
        type="button"
        class:active={appState.blameMode}
        onclick={() => (appState.blameMode = !appState.blameMode)}
        title="Toggle blame (b)"
      >
        Blame
      </button>
    </div>
  </div>

  {#if pending}
    <div class="state">Loading diff…</div>
  {:else if loadError}
    <div class="state error">{loadError}</div>
  {:else if !diff}
    <div class="state muted">No file selected.</div>
  {:else if diff.kind === "binary"}
    <div class="state muted">
      Binary file ({fmt(diff.old_size)} → {fmt(diff.new_size)}). Diff not shown.
    </div>
  {:else if diff.kind === "too-large"}
    <div class="state muted">
      Large file ({fmt(diff.old_size)} → {fmt(diff.new_size)}). Collapsed for performance.
      <button type="button" class="primary" onclick={loadAnyway}>Load anyway</button>
    </div>
  {/if}

  <div class="host" bind:this={host} class:hidden={diff?.kind !== "text"}></div>
</div>

<style>
  .diffview {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
  }
  .toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 10px;
    border-bottom: 1px solid var(--border);
    background: var(--bar-bg);
    font-size: 0.8em;
  }
  .meta {
    display: flex;
    gap: 10px;
    opacity: 0.75;
    font-family: var(--mono);
  }
  .lang {
    font-size: 0.85em;
    padding: 1px 4px;
    border-radius: 3px;
    border: 1px solid var(--border);
    background: var(--input-bg);
    color: inherit;
    text-transform: lowercase;
  }
  .modes {
    display: flex;
    gap: 4px;
    align-items: center;
  }
  .modes button {
    padding: 2px 8px;
    border: 1px solid var(--border);
    background: var(--input-bg);
    color: inherit;
    border-radius: 3px;
    cursor: pointer;
    font-size: 0.85em;
  }
  .modes button.active {
    background: var(--selected);
    border-color: var(--accent);
  }
  .font-size {
    display: inline-flex;
    gap: 0;
    margin-right: 8px;
  }
  .font-size button {
    padding: 2px 8px;
    border: 1px solid var(--border);
    background: var(--input-bg);
    color: inherit;
    cursor: pointer;
    font-size: 0.85em;
    border-radius: 0;
  }
  .font-size button:first-child {
    border-top-left-radius: 3px;
    border-bottom-left-radius: 3px;
  }
  .font-size button:last-child {
    border-top-right-radius: 3px;
    border-bottom-right-radius: 3px;
  }
  .font-size button + button {
    border-left: none;
  }
  .font-size .size-reset {
    min-width: 28px;
    font-variant-numeric: tabular-nums;
    opacity: 0.75;
  }
  .host {
    flex: 1;
    overflow: auto;
    min-height: 0;
    font-family: var(--mono);
    font-size: var(--diff-font-size);
  }
  .host.hidden {
    display: none;
  }
  .state {
    padding: 16px;
    color: var(--muted);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .state.error {
    background: var(--error-bg);
    color: var(--error-fg);
    white-space: pre-wrap;
  }
  .state .primary {
    padding: 4px 10px;
    border: 1px solid var(--accent);
    background: var(--accent);
    color: white;
    border-radius: 3px;
    cursor: pointer;
  }
  :global(.cm-editor) {
    height: 100%;
  }
  :global(.cm-merge-revert) {
    display: none;
  }
  :global(.cm-collapsedLines:hover) {
    background: var(--hover) !important;
    color: var(--fg) !important;
  }

  /* Default @codemirror/merge marks changed substrings with a bottom-gradient
     that reads as an underline; swap for a filled background, GitHub-style.
     Side is identified by .cm-merge-a (deletion) / .cm-merge-b (insertion),
     applied to the editor root in both split and unified modes. */
  :global(.cm-merge-a .cm-changedText),
  :global(.cm-merge-b .cm-changedText),
  :global(.cm-deletedText) {
    text-decoration: none !important;
  }
  :global(.cm-merge-b .cm-changedText) {
    background: var(--diff-add-token) !important;
  }
  :global(.cm-merge-b .cm-changedLine),
  :global(.cm-inlineChangedLine) {
    background: var(--diff-add-line) !important;
    box-shadow: inset 3px 0 var(--diff-add-border);
  }
  :global(.cm-merge-a .cm-changedText) {
    background: var(--diff-del-token) !important;
  }
  :global(.cm-merge-a .cm-changedLine) {
    background: var(--diff-del-line) !important;
    box-shadow: inset 3px 0 var(--diff-del-border);
  }
  :global(.cm-deletedChunk) {
    background: var(--diff-del-line) !important;
    box-shadow: inset 3px 0 var(--diff-del-border);
  }
  /* Pure inserts/deletes don't need token bg on top of line bg — line bg
     alone is the signal. Token bg stays only on modified-line pairs where
     it points at the actual word-level change. */
  :global(.cm-fullLineChange .cm-changedText),
  :global(.cm-deletedChunk .cm-deletedText) {
    background: transparent !important;
  }

  /* Blame popover. CodeMirror wraps our DOM in a .cm-tooltip element; we
     neutralize its default chrome and apply our own on the inner div. */
  :global(.cm-tooltip:has(.blame-popover)) {
    background: transparent;
    border: none;
    padding: 0;
  }
  :global(.blame-popover) {
    background: var(--bar-bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 8px 10px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
    font-family: var(--mono);
    font-size: 12px;
    min-width: 220px;
    max-width: 420px;
    line-height: 1.4;
  }
  :global(.blame-popover.loading),
  :global(.blame-popover.error) {
    opacity: 0.9;
  }
  :global(.blame-popover.error) {
    color: var(--error-fg);
    background: var(--error-bg);
  }
  :global(.blame-popover .blame-meta) {
    font-weight: 600;
    margin-bottom: 4px;
  }
  :global(.blame-popover .blame-subject) {
    white-space: pre-wrap;
    word-break: break-word;
    margin-bottom: 6px;
    opacity: 0.85;
  }
  :global(.blame-popover .blame-actions) {
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
  }
  :global(.blame-popover .blame-sha) {
    border: 1px solid var(--border);
    background: var(--input-bg);
    color: inherit;
    font-family: var(--mono);
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 3px;
    cursor: pointer;
  }
  :global(.blame-popover .blame-sha:hover) {
    background: var(--hover);
  }
  :global(.blame-popover .blame-view) {
    border: none;
    background: transparent;
    color: var(--accent);
    font-size: 11px;
    padding: 2px 4px;
    cursor: pointer;
  }
  :global(.blame-popover .blame-view:hover) {
    text-decoration: underline;
  }
  :global(.blame-toast) {
    position: fixed;
    bottom: 24px;
    right: 24px;
    background: var(--accent);
    color: white;
    padding: 6px 12px;
    border-radius: 4px;
    font-size: 12px;
    z-index: 9999;
    opacity: 0;
    transform: translateY(8px);
    transition: opacity 0.2s ease, transform 0.2s ease;
    pointer-events: none;
  }
  :global(.blame-toast.show) {
    opacity: 1;
    transform: translateY(0);
  }

  /* Color bar gutter: a thin column rendered only when blame mode is ON. */
  :global(.cm-gutter.cm-blame-gutter) {
    width: 3px;
    min-width: 3px;
    padding: 0;
    background: transparent;
  }
  :global(.cm-blame-gutter .cm-gutterElement) {
    padding: 0;
    width: 3px;
    min-width: 3px;
  }
  :global(.blame-bar) {
    width: 3px;
    height: 100%;
    min-height: 1em;
  }
  :global(.blame-bar.uncommitted) {
    background: repeating-linear-gradient(
      45deg,
      var(--border),
      var(--border) 2px,
      transparent 2px,
      transparent 4px
    ) !important;
  }

  /* Peer highlight: lines from the same commit as the one under the cursor. */
  :global(.cm-line.blame-peer) {
    background-color: rgba(127, 127, 200, 0.12);
  }
</style>
