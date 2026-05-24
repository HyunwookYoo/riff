<script lang="ts">
  import { onDestroy } from "svelte";
  import { EditorView, keymap } from "@codemirror/view";
  import { EditorState, type Extension } from "@codemirror/state";
  import { MergeView, unifiedMergeView } from "@codemirror/merge";
  import { search, searchKeymap } from "@codemirror/search";
  import { appState } from "$lib/store.svelte";
  import { fileDiff, worktreeFileDiff } from "$lib/git";
  import type { ChangedFile, FileDiff } from "$lib/types";
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

  // Reset override whenever the selected file changes.
  $effect(() => {
    void appState.selectedFile;
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
  :global(.cm-scroller) {
    font-family: var(--mono);
  }
  :global(.cm-merge-revert) {
    display: none;
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
