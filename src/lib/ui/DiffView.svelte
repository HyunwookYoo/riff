<script lang="ts">
  import { onDestroy } from "svelte";
  import { EditorView, keymap, lineNumbers } from "@codemirror/view";
  import { EditorState, type Extension } from "@codemirror/state";
  import { MergeView, unifiedMergeView, Change } from "@codemirror/merge";
  import { search, searchKeymap } from "@codemirror/search";
  import { appState } from "$lib/store.svelte";
  import { changesFileDiff, fileDiff, setUeVersionForRepo } from "$lib/git";
  import { resolveDiffRefsFor } from "$lib/workspace";
  import type { ChangedFile, FileDiff } from "$lib/types";
  import { detectLanguage, supportedLanguages } from "$lib/diff/lang";
  import { isDarkMode, shikiExtension } from "$lib/diff/shiki";
  import { fullLineChangePlugin } from "$lib/diff/fullLine";
  import { toCMChanges } from "$lib/diff/changes";
  import { setActiveDiffView } from "$lib/diff/activeView";
  import { adjustFontSize, resetFontSize } from "$lib/font";
  import Dropdown from "./Dropdown.svelte";
  import ImageDiff from "./ImageDiff.svelte";
  import SubmoduleDiff from "./SubmoduleDiff.svelte";

  let host: HTMLDivElement;
  let mergeView: MergeView | null = null;
  let unifiedView: EditorView | null = null;
  let diff = $state<FileDiff | null>(null);
  let pending = $state(false);
  let loadError = $state<string | null>(null);
  let detectedLang = $state<string | null>(null);
  let langOverride = $state<string | null>(null);
  // Monotonic guard for double-buffered loads: a newer load() bumps this so a
  // slower in-flight fetch/highlight from an older call can't mount over it
  // (rapid j/k, worktree-refresh swap, theme/mode changes).
  let loadSession = 0;

  // Signature of what the on-screen editor currently renders, so a no-op
  // refresh (the FS watcher re-runs status → openChange reassigns selectedFile
  // to a fresh object even when nothing changed) can skip the rebuild and keep
  // the live scroll position. Set on mount, cleared on teardown.
  let mounted: {
    path: string;
    old: string;
    new: string;
    mode: string;
    dark: boolean;
    lang: string | null;
  } | null = null;

  // VS Code-style responsive diff: side-by-side needs horizontal room, so when
  // the diff pane is narrower than this (e.g. the graph mode's left detail
  // column) it falls back to the unified inline view regardless of the user's
  // Split/Unified preference. The preference re-applies once the pane is
  // widened past the breakpoint. 0 = not yet measured → honor the preference.
  const NARROW_BREAKPOINT = 720;
  let containerW = $state(0);
  const effectiveViewMode = $derived(
    containerW > 0 && containerW < NARROW_BREAKPOINT
      ? "unified"
      : appState.viewMode,
  );

  const langOptions = $derived([
    {
      value: "",
      label: `Auto${detectedLang ? ` (${detectedLang})` : " (plain)"}`,
    },
    ...supportedLanguages.map((l) => ({ value: l, label: l })),
  ]);

  // Unreal asset (.uasset/.umap) preview. The engine version is resolved
  // per-repo from the persisted map; the dropdown lets the user correct it
  // live (UAssetGUI can't auto-detect), persisting the choice for that repo.
  const UE_VERSIONS = [
    "4.25", "4.26", "4.27",
    "5.0", "5.1", "5.2", "5.3", "5.4", "5.5", "5.6", "5.7",
  ];
  const DEFAULT_UE_VERSION = "5.5";
  const ueVersionOptions = UE_VERSIONS.map((v) => ({ value: v, label: v }));

  const selectedRepoPath = $derived(
    appState.repos[appState.selectedFile?.repoIdx ?? 0]?.path ??
      appState.repoPath,
  );
  const ueVersion = $derived(
    appState.ueVersionByRepo[selectedRepoPath] ?? DEFAULT_UE_VERSION,
  );
  // True once a derived (parsed-to-JSON) Unreal asset view has loaded.
  const isDerived = $derived(
    diff?.kind === "text" && !!diff.derived_label,
  );

  // SVG is diffed as text (source) but can also be rendered. `svgPreview`
  // toggles the rendered image view, reusing ImageDiff with data: URLs built
  // from the text content — no backend round-trip.
  const isSvg = $derived(
    appState.selectedFile?.path.toLowerCase().endsWith(".svg") ?? false,
  );
  let svgPreview = $state(false);
  const showSvgPreview = $derived(
    diff?.kind === "text" && isSvg && svgPreview,
  );
  const svgUrl = (s: string): string | null =>
    s ? `data:image/svg+xml;utf8,${encodeURIComponent(s)}` : null;

  function changeUeVersion(v: string) {
    const repo = selectedRepoPath;
    if (!repo) return;
    appState.ueVersionByRepo = { ...appState.ueVersionByRepo, [repo]: v };
    void setUeVersionForRepo(repo, v);
    // The reload effect observes ueVersionByRepo and re-derives.
  }

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
    const mode = effectiveViewMode;
    const theme = appState.effectiveTheme;
    const ov = langOverride;
    const cm = appState.compareMode;
    const uv = ueVersion;
    void file;
    void mode;
    void theme;
    void ov;
    void cm;
    void uv;
    void appState.bcDiffRange;
    load(false);
  });

  async function load(force: boolean) {
    const session = ++loadSession;
    const file = appState.selectedFile;
    if (!file || !appState.repoPath) {
      teardown();
      diff = null;
      loadError = null;
      pending = false;
      return;
    }

    // Multi-root (§13): the selected file's repo dictates which path and
    // which refs to feed file_diff. compare() already resolved this when
    // listing the file; mirror the rules here so the right diff opens.
    const repoIdx = file.repoIdx ?? 0;
    const repoPath = appState.repos[repoIdx]?.path ?? appState.repoPath;

    // Double-buffer: if an editor is already on screen, keep it visible and
    // fetch the new diff in the background (no "Loading diff…" flash). Only
    // surface the loading state when there's nothing to keep showing.
    const hadEditor = !!(mergeView || unifiedView);
    if (!hadEditor) {
      teardown();
      diff = null;
      pending = true;
    }
    loadError = null;

    let next: FileDiff | null = null;
    let nextErr: string | null = null;
    try {
      if (appState.appMode === "changes") {
        next = await changesFileDiff(
          repoPath,
          file.path,
          file.old_path,
          file.status,
          appState.changesSide === "staged",
          force,
          ueVersion,
        );
      } else if (appState.bcDiffRange && repoIdx === 0) {
        // Branch-mode containment drill: this file's diff is parent..commit
        // (the selected commit), not the toolbar's start..target.
        const range = appState.bcDiffRange;
        next = await fileDiff(
          repoPath,
          range.start,
          range.target,
          "two-dot",
          file.path,
          file.old_path,
          force,
          ueVersion,
        );
      } else {
        const refs = await resolveDiffRefsFor(repoIdx);
        if (!refs) {
          nextErr = "no refs to compare for this file";
        } else {
          next = await fileDiff(
            refs.path,
            refs.start,
            refs.target,
            appState.mode,
            file.path,
            file.old_path,
            force,
            ueVersion,
          );
        }
      }
    } catch (e) {
      nextErr = String(e);
    }

    // A newer load() started while we awaited — drop this stale result so it
    // can't clobber the newer one's editor.
    if (session !== loadSession) return;

    pending = false;
    loadError = nextErr;

    if (next?.kind === "text") {
      // Skip the rebuild when the on-screen editor already renders exactly
      // this — same file, same content, same view params. A no-op FS-watcher
      // refresh reassigns selectedFile (a fresh object) and re-runs the load
      // effect; without this guard mount() would tear down + rebuild the
      // editor, losing the user's scroll (and needlessly re-deriving .uasset
      // property views).
      const guardDark = isDarkMode();
      const guardLang =
        langOverride ??
        (next.derived_label ? "json" : detectLanguage(file.path));
      if (
        (mergeView || unifiedView) &&
        mounted &&
        mounted.path === file.path &&
        mounted.old === next.old_content &&
        mounted.new === next.new_content &&
        mounted.mode === effectiveViewMode &&
        mounted.dark === guardDark &&
        mounted.lang === guardLang
      ) {
        diff = next; // refresh the toolbar/badge; editor + scroll untouched
        return;
      }
      // mount() prepares highlighting first, then tears down the old editor
      // and constructs the new one — keeping the previous diff on screen until
      // the last moment. `diff` is set now so the toolbar (lang dropdown)
      // tracks the new file; the host DOM is still the old editor until swap.
      diff = next;
      await mount(file, next.old_content, next.new_content, session);
    } else {
      // Non-text (binary / too-large), error, or nothing: drop the old editor
      // and show the state message.
      teardown();
      diff = next;
    }
  }

  async function mount(
    file: ChangedFile,
    oldText: string,
    newText: string,
    session: number,
  ) {
    if (!host) return;
    // Derived Unreal asset views are JSON regardless of the .uasset extension.
    const derived = diff?.kind === "text" && !!diff.derived_label;
    detectedLang = derived ? "json" : detectLanguage(file.path);
    const effectiveLang = langOverride ?? detectedLang;
    const dark = isDarkMode();
    const [oldExt, newExt] = await Promise.all([
      shikiExtension(oldText, effectiveLang, dark),
      shikiExtension(newText, effectiveLang, dark),
    ]);
    // Superseded during async highlight prep — leave the current editor be;
    // the newer load() owns the next swap.
    if (session !== loadSession) return;
    // Tear down the previous editor only now that the replacement's
    // highlighting is ready, so the swap is synchronous and flash-free.
    teardown();

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

    // Inject the backend's diff so the editor renders it verbatim instead of
    // recomputing one — CodeMirror's default scanLimit bails on large, densely
    // changed files and floods the whole file as changed. Editors are readOnly,
    // so override is only ever called once with the full docs.
    // Real Change instances (not plain objects): the merge addon's toChunks
    // calls change.offset(). Fresh array per call — makePresentable mutates it.
    const changes =
      diff?.kind === "text"
        ? toCMChanges(diff.changes, (a, b, c, d) => new Change(a, b, c, d))
        : [];
    const diffConfig = { override: () => changes.slice() };

    if (effectiveViewMode === "side-by-side") {
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
        diffConfig,
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
              diffConfig,
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

    // Record exactly what this editor renders so a no-op refresh can skip the
    // rebuild (see the guard in load()).
    mounted = {
      path: file.path,
      old: oldText,
      new: newText,
      mode: effectiveViewMode,
      dark,
      lang: effectiveLang,
    };
  }

  function teardown() {
    setActiveDiffView(null);
    mergeView?.destroy();
    mergeView = null;
    unifiedView?.destroy();
    unifiedView = null;
    mounted = null;
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

<div class="diffview" bind:clientWidth={containerW}>
  <div class="toolbar">
    <div class="meta">
      {#if isDerived}
        <span class="derived-badge" title="Showing a parsed property view, not raw bytes">
          {diff?.kind === "text" ? diff.derived_label : ""}
        </span>
        <Dropdown
          title="Unreal Engine version (UAssetGUI can't auto-detect)"
          value={ueVersion}
          options={ueVersionOptions}
          onchange={changeUeVersion}
        />
      {/if}
      {#if diff?.kind === "text"}
        <Dropdown
          title="Override language"
          value={langOverride ?? ""}
          options={langOptions}
          onchange={(v) => (langOverride = v === "" ? null : v)}
        />
      {/if}
      {#if diff && diff.kind !== "text" && diff.kind !== "submodule"}
        <span class="sizes">
          {fmt(diff.old_size)} → {fmt(diff.new_size)}
        </span>
      {/if}
    </div>
    {#if diff?.kind === "text"}
    <div class="modes">
      {#if isSvg}
        <button
          type="button"
          class="svg-toggle"
          class:active={svgPreview}
          onclick={() => (svgPreview = !svgPreview)}
          title="Toggle rendered SVG preview"
        >
          {svgPreview ? "Source" : "Preview"}
        </button>
      {/if}
      {#if !svgPreview}
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
        class:active={effectiveViewMode === "side-by-side"}
        onclick={() => (appState.viewMode = "side-by-side")}
        title={appState.viewMode === "side-by-side" &&
        effectiveViewMode === "unified"
          ? "Inline shown — panel too narrow for side-by-side"
          : "Side-by-side"}
      >
        Split
      </button>
      <button
        type="button"
        class:active={effectiveViewMode === "unified"}
        onclick={() => (appState.viewMode = "unified")}
        title="Unified inline"
      >
        Unified
      </button>
      {/if}
    </div>
    {/if}
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
      {#if diff.note}
        <div class="binary-note">{diff.note}</div>
      {/if}
    </div>
  {:else if diff.kind === "image"}
    <ImageDiff
      oldSrc={diff.old_b64 ? `data:${diff.mime};base64,${diff.old_b64}` : null}
      newSrc={diff.new_b64 ? `data:${diff.mime};base64,${diff.new_b64}` : null}
      oldSize={diff.old_size}
      newSize={diff.new_size}
    />
  {:else if showSvgPreview && diff.kind === "text"}
    <ImageDiff
      oldSrc={svgUrl(diff.old_content)}
      newSrc={svgUrl(diff.new_content)}
      oldSize={diff.old_size}
      newSize={diff.new_size}
    />
  {:else if diff.kind === "too-large"}
    <div class="state muted">
      Large file ({fmt(diff.old_size)} → {fmt(diff.new_size)}). Collapsed for performance.
      <button type="button" class="primary" onclick={loadAnyway}>Load anyway</button>
    </div>
  {:else if diff.kind === "submodule"}
    <SubmoduleDiff {diff} />
  {/if}

  <div
    class="host"
    bind:this={host}
    class:hidden={diff?.kind !== "text" || showSvgPreview}
  ></div>
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
    align-items: center;
    opacity: 0.75;
    font-family: var(--mono);
  }
  .derived-badge {
    padding: 1px 7px;
    border-radius: 3px;
    background: var(--accent-soft);
    color: var(--accent);
    font-size: 0.8em;
    font-weight: 600;
    white-space: nowrap;
  }
  .binary-note {
    margin-top: 6px;
    font-size: 0.9em;
    opacity: 0.85;
    max-width: 48ch;
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
