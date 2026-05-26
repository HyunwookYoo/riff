<script lang="ts">
  import { onDestroy } from "svelte";
  import { EditorView, keymap, lineNumbers } from "@codemirror/view";
  import { EditorState, type Extension } from "@codemirror/state";
  import { MergeView, unifiedMergeView } from "@codemirror/merge";
  import { search, searchKeymap } from "@codemirror/search";
  import { appState } from "$lib/store.svelte";
  import { fileDiff, worktreeFileDiff } from "$lib/git";
  import { resolveDiffRefsFor } from "$lib/workspace";
  import type { ChangedFile, FileDiff } from "$lib/types";
  import { detectLanguage, supportedLanguages } from "$lib/diff/lang";
  import { isDarkMode, shikiExtension } from "$lib/diff/shiki";
  import { fullLineChangePlugin } from "$lib/diff/fullLine";
  import { setActiveDiffView } from "$lib/diff/activeView";
  import { adjustFontSize, resetFontSize } from "$lib/font";
  import Dropdown from "./Dropdown.svelte";

  let host: HTMLDivElement;
  let mergeView: MergeView | null = null;
  let unifiedView: EditorView | null = null;
  let diff = $state<FileDiff | null>(null);
  let pending = $state(false);
  let loadError = $state<string | null>(null);
  let detectedLang = $state<string | null>(null);
  let langOverride = $state<string | null>(null);

  const langOptions = $derived([
    {
      value: "",
      label: `Auto${detectedLang ? ` (${detectedLang})` : " (plain)"}`,
    },
    ...supportedLanguages.map((l) => ({ value: l, label: l })),
  ]);

  // Reset override whenever the selected file or compare context changes.
  $effect(() => {
    void appState.selectedFile;
    void appState.targetBranch;
    void appState.compareMode;
    void appState.mode;
    langOverride = null;
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

    // Multi-root (§13): the selected file's repo dictates which path and
    // which refs to feed file_diff. compare() already resolved this when
    // listing the file; mirror the rules here so the right diff opens.
    const repoIdx = file.repoIdx ?? 0;
    const repoPath = appState.repos[repoIdx]?.path ?? appState.repoPath;

    pending = true;
    try {
      if (appState.compareMode === "worktree") {
        diff = await worktreeFileDiff(
          repoPath,
          file.path,
          file.old_path,
          file.status,
          force,
        );
      } else {
        const refs = await resolveDiffRefsFor(repoIdx);
        if (!refs) {
          loadError = "no refs to compare for this file";
          return;
        }
        diff = await fileDiff(
          refs.path,
          refs.start,
          refs.target,
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
      // readOnly (vs. just editable=false) hides the Replace fields in the
      // Ctrl+F search panel — this app is a viewer.
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.lineWrapping,
      EditorView.darkTheme.of(dark),
      EditorView.theme({ ".cm-scroller": { fontFamily: "var(--mono)" } }),
      lineNumbers(),
      search({ top: true }),
      keymap.of(searchKeymap),
      fullLineChangePlugin,
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

    // §14.2 Step 7: restore the scroll position saved when the user last
    // left this file's tab. Only applies when this file matches the tab's
    // remembered file — switching to a different file resets to top.
    const mem = appState.tabMemory.get(file.repoIdx ?? 0);
    if (mem?.filePath === file.path && typeof mem.scrollPos === "number") {
      const view = mergeView?.b ?? unifiedView;
      if (view) {
        const top = mem.scrollPos;
        requestAnimationFrame(() => {
          view.scrollDOM.scrollTop = top;
        });
      }
    }
  }

  function teardown() {
    setActiveDiffView(null);
    mergeView?.destroy();
    mergeView = null;
    unifiedView?.destroy();
    unifiedView = null;
    if (host) host.innerHTML = "";
  }

  onDestroy(teardown);

  function loadAnyway() {
    void load(true);
  }

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
        <Dropdown
          title="Override language"
          value={langOverride ?? ""}
          options={langOptions}
          onchange={(v) => (langOverride = v === "" ? null : v)}
        />
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
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
    box-shadow: inset 0 -2px 0 var(--accent);
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
</style>
