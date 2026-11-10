<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { EditorView, keymap, lineNumbers } from "@codemirror/view";
  import { EditorState, type Extension } from "@codemirror/state";
  import {
    MergeView,
    unifiedMergeView,
    Change,
    getChunks,
    getOriginalDoc,
  } from "@codemirror/merge";
  import { search, searchKeymap } from "@codemirror/search";
  import { appState } from "$lib/store.svelte";
  import { commitViewActive } from "$lib/history";
  import { changesFileDiff, fileDiff, setUeVersionForRepo } from "$lib/git";
  import { resolveRepoRanges } from "$lib/repoRange";
  import { paneLabels } from "$lib/rangeText";
  import type { ChangedFile, DiffMode, FileDiff } from "$lib/types";
  import { detectLanguage, supportedLanguages } from "$lib/diff/lang";
  import { isDarkMode, shikiExtension } from "$lib/diff/shiki";
  import { fullLineChangePlugin } from "$lib/diff/fullLine";
  import { toCMChanges } from "$lib/diff/changes";
  import { setActiveDiffView } from "$lib/diff/activeView";
  import {
    currentChunkIndex,
    mapAToB,
    nextChunkIndex,
    overviewMarks,
    type DiffMarker,
    type OverviewMark,
  } from "$lib/diff/overview";
  import { adjustFontSize, resetFontSize } from "$lib/font";
  import Dropdown from "./Dropdown.svelte";
  import ImageDiff from "./ImageDiff.svelte";
  import SubmoduleDiff from "./SubmoduleDiff.svelte";

  // All optional: without them DiffView follows appState.selectedFile and the
  // app's ranges. `source` pins an explicit repo/range/file (PR Review).
  let {
    source,
    sideExtensions,
    forceSideBySide = false,
    markers,
  }: {
    source?: {
      repoPath: string;
      start: string;
      target: string;
      file: ChangedFile;
      mode?: DiffMode;
    };
    /** Extra extensions per side-by-side editor: "a" = old, "b" = new. */
    sideExtensions?: (side: "a" | "b") => Extension[];
    forceSideBySide?: boolean;
    /** Review annotations drawn on the change map (1-based lines per side). */
    markers?: DiffMarker[];
  } = $props();

  const file = $derived(source?.file ?? appState.selectedFile);
  // The owner may rebuild `source` on unrelated state changes; loads key on
  // what it names, not on the object.
  const sourceKey = $derived(
    source
      ? JSON.stringify([
          source.repoPath,
          source.start,
          source.target,
          source.mode ?? "three-dot",
          source.file.path,
          source.file.old_path,
        ])
      : null,
  );

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
    collapse: boolean;
  } | null = null;

  // "Changes only" (collapseUnchanged), held per screen kind in appState.
  const changesOnly = $derived(
    source ? appState.reviewChangesOnly : appState.changesOnly,
  );
  // The toggle remounts the editor: carry its first visible line across.
  let keepTop: { path: string; line: number } | null = null;
  function toggleChangesOnly() {
    const v = mergeView?.b ?? unifiedView;
    keepTop =
      v && file
        ? {
            path: file.path,
            line: v.state.doc.lineAt(v.lineBlockAtHeight(viewportTopY(v)).from).number,
          }
        : null;
    if (source) appState.reviewChangesOnly = !appState.reviewChangesOnly;
    else appState.changesOnly = !appState.changesOnly;
  }

  // Change map beside the scrollbar + the toolbar's "i / N changes". Marks are
  // placed by the scrolled editor's (side b / unified) rendered line blocks so
  // collapsed runs and block widgets don't skew them; recomputed on geometry
  // changes, the counter on scroll. Both coalesce into one frame.
  let marks = $state.raw<OverviewMark[]>([]);
  let chunkAt = $state.raw<{ index: number; count: number }>({ index: -1, count: 0 });
  let overviewFrame = 0;
  let needMarks = false;

  function scheduleOverview(withMarks: boolean) {
    needMarks ||= withMarks;
    if (overviewFrame) return;
    overviewFrame = requestAnimationFrame(() => {
      overviewFrame = 0;
      const m = needMarks;
      needMarks = false;
      refreshOverview(m);
    });
  }

  function refreshOverview(withMarks: boolean) {
    const b = mergeView?.b ?? unifiedView;
    if (!b) {
      marks = [];
      chunkAt = { index: -1, count: 0 };
      return;
    }
    const chunks = getChunks(b.state)?.chunks ?? [];
    if (withMarks) {
      const a = mergeView?.a ?? null;
      const docA = a ? a.state.doc : getOriginalDoc(b.state);
      // Unified has no old-side editor: old-side markers sit at their mapped
      // new-side line.
      const onB = (m: DiffMarker): DiffMarker => {
        const fromA = docA.line(Math.min(Math.max(1, m.line), docA.lines)).from;
        const posB = Math.min(mapAToB(chunks, fromA), b.state.doc.length);
        return { ...m, side: "b", line: b.state.doc.lineAt(posB).number };
      };
      const ms = (untrack(() => markers) ?? []).map((m) =>
        m.side === "a" && !a ? onB(m) : m,
      );
      marks = overviewMarks(chunks, ms, {
        doc: (side) => (side === "a" ? docA : b.state.doc),
        span: (side, pos) => {
          const v = side === "a" && a ? a : b;
          const h = v.contentHeight || 1;
          const blk = v.lineBlockAt(pos);
          return { top: blk.top / h, bottom: blk.bottom / h };
        },
      });
    }
    const top = b.lineBlockAtHeight(viewportTopY(b)).from;
    const index =
      navIndex !== null && navIndex < chunks.length
        ? navIndex
        : currentChunkIndex(chunks, top);
    chunkAt = { index, count: chunks.length };
  }

  /** The viewport top, in px from the scrolled editor's document top. */
  function viewportTopY(v: EditorView): number {
    return Math.max(0, host.getBoundingClientRect().top - v.documentTop);
  }

  const overviewListener = EditorView.updateListener.of((u) => {
    if (u.geometryChanged || u.docChanged) scheduleOverview(true);
  });

  $effect(() => {
    void markers;
    untrack(() => scheduleOverview(true));
  });

  function revealMark(m: OverviewMark) {
    dropNav();
    const v = m.side === "a" && mergeView ? mergeView.a : (mergeView?.b ?? unifiedView);
    v?.dispatch({ effects: EditorView.scrollIntoView(m.pos, { y: "center" }) });
  }

  // The chunk ◀ ▶ / n p last went to, kept until the user scrolls or the
  // editor remounts: a centred or end-clamped chunk doesn't sit at the
  // viewport top, so stepping from the viewport alone could repeat it.
  let navIndex: number | null = null;
  function dropNav() {
    if (navIndex === null) return;
    navIndex = null;
    scheduleOverview(false);
  }
  const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Enter"]);

  function stepChunk(dir: 1 | -1) {
    const v = mergeView?.b ?? unifiedView;
    if (!v) return;
    const chunks = getChunks(v.state)?.chunks ?? [];
    const end = v.state.doc.length;
    const tops = chunks.map((c) => v.lineBlockAt(Math.min(c.fromB, end)).top);
    const i = nextChunkIndex(tops, viewportTopY(v), dir, navIndex);
    if (i < 0) return;
    const pos = Math.min(chunks[i].fromB, end);
    navIndex = i;
    v.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
      userEvent: "select.byChunk",
    });
    scheduleOverview(false);
  }

  // VS Code-style responsive diff: side-by-side needs horizontal room, so when
  // the diff pane is narrower than this (e.g. the graph mode's left detail
  // column) it falls back to the unified inline view regardless of the user's
  // Split/Unified preference. The preference re-applies once the pane is
  // widened past the breakpoint. 0 = not yet measured → honor the preference.
  const NARROW_BREAKPOINT = 720;
  let containerW = $state(0);
  const effectiveViewMode = $derived(
    forceSideBySide
      ? "side-by-side"
      : containerW > 0 && containerW < NARROW_BREAKPOINT
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
    source?.repoPath ??
      appState.repos[file?.repoIdx ?? 0]?.path ??
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
    file?.path.toLowerCase().endsWith(".svg") ?? false,
  );
  let svgPreview = $state(false);
  const showSvgPreview = $derived(
    diff?.kind === "text" && isSvg && svgPreview,
  );
  const svgUrl = (s: string): string | null =>
    s ? `data:image/svg+xml;utf8,${encodeURIComponent(s)}` : null;

  // Branch mode: name what each pane shows — base / compare, or parent /
  // commit for a commit picked in the commit table.
  const labels = $derived.by(() => {
    const f = file;
    if (appState.appMode !== "compare" || !f) return null;
    if (commitViewActive()) return { left: "before", right: "after" };
    const idx = f.repoIdx ?? 0;
    const d = appState.bcDiffRange;
    const drill =
      d && d.repoIdx === idx
        ? { target: d.target, summary: appState.bcSelected?.commit.summary }
        : null;
    return paneLabels(
      appState.repoRanges[idx],
      { base: appState.startBranch, compare: appState.targetBranch },
      appState.mode,
      drill,
    );
  });

  function changeUeVersion(v: string) {
    const repo = selectedRepoPath;
    if (!repo) return;
    appState.ueVersionByRepo = { ...appState.ueVersionByRepo, [repo]: v };
    void setUeVersionForRepo(repo, v);
    // The reload effect observes ueVersionByRepo and re-derives.
  }

  // Reset override whenever the selected file or compare context changes.
  $effect(() => {
    void (sourceKey ?? file);
    void appState.targetBranch;
    void appState.compareMode;
    void appState.mode;
    langOverride = null;
  });

  // Re-render whenever the selected file, view mode, theme, override, or
  // compare mode changes.
  $effect(() => {
    void (sourceKey ?? file);
    const mode = effectiveViewMode;
    const theme = appState.effectiveTheme;
    const ov = langOverride;
    const cm = appState.compareMode;
    const uv = ueVersion;
    void mode;
    void theme;
    void ov;
    void cm;
    void uv;
    // Collapse is fixed at construction: a toggle must remount.
    void changesOnly;
    void appState.bcDiffRange;
    // The range is resolved untracked inside load(): a picker or override
    // change reloads the diff through these, a watcher refresh alone
    // (refsRefresh) does not — it would remount image and binary views.
    void appState.startBranch;
    void appState.targetBranch;
    void appState.repos;
    load(false);
  });

  async function load(force: boolean) {
    const session = ++loadSession;
    // Untracked in source mode: the load effect keys on sourceKey instead.
    const src = untrack(() => source);
    const cur = src ? untrack(() => file) : file;
    if (!cur || !(src ? src.repoPath : appState.repoPath)) {
      teardown();
      diff = null;
      loadError = null;
      pending = false;
      return;
    }

    // Multi-root (§13): the selected file's repo dictates which path and
    // which refs to feed file_diff. compare() already resolved this when
    // listing the file; mirror the rules here so the right diff opens.
    const repoIdx = cur.repoIdx ?? 0;
    const repoPath =
      src?.repoPath ?? appState.repos[repoIdx]?.path ?? appState.repoPath;

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
      if (src) {
        next = await fileDiff(
          src.repoPath,
          src.start,
          src.target,
          src.mode ?? "three-dot",
          cur.path,
          cur.old_path,
          force,
          ueVersion,
        );
      } else if (appState.appMode === "changes") {
        next = await changesFileDiff(
          repoPath,
          cur.path,
          cur.old_path,
          cur.status,
          force,
          ueVersion,
        );
      } else if (
        appState.bcDiffRange &&
        appState.bcDiffRange.repoIdx === repoIdx
      ) {
        // A commit picked in the commit table: this file's diff is
        // parent..commit inside the commit's own repo, not the toolbar range.
        const range = appState.bcDiffRange;
        next = await fileDiff(
          repoPath,
          range.start,
          range.target,
          "two-dot",
          cur.path,
          cur.old_path,
          force,
          ueVersion,
        );
      } else {
        // Untracked: the resolver reads refsRefresh and every override, which
        // must not become this effect's dependencies (see the effect).
        const range = (await untrack(() => resolveRepoRanges()))[repoIdx];
        if (!range?.ok) {
          nextErr = "no refs to compare for this file";
        } else {
          next = await fileDiff(
            range.path,
            range.base,
            range.compare,
            appState.mode,
            cur.path,
            cur.old_path,
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
        (next.derived_label ? "json" : detectLanguage(cur.path));
      if (
        (mergeView || unifiedView) &&
        mounted &&
        mounted.path === cur.path &&
        mounted.old === next.old_content &&
        mounted.new === next.new_content &&
        mounted.mode === effectiveViewMode &&
        mounted.dark === guardDark &&
        mounted.lang === guardLang &&
        mounted.collapse === changesOnly
      ) {
        diff = next; // refresh the toolbar/badge; editor + scroll untouched
        return;
      }
      // mount() prepares highlighting first, then tears down the old editor
      // and constructs the new one — keeping the previous diff on screen until
      // the last moment. `diff` is set now so the toolbar (lang dropdown)
      // tracks the new file; the host DOM is still the old editor until swap.
      diff = next;
      await mount(cur, next.old_content, next.new_content, session);
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
      overviewListener,
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
    // Off by default with `source` (PR Review): riff's diff (CRLF-normalised)
    // can differ from git's hunks, so a collapsed run could hide commentable
    // lines, threads or drafts — a wider margin there when the user opts in.
    const collapseOn = changesOnly;
    const collapse = collapseOn
      ? { collapseUnchanged: { margin: source ? 5 : 3, minSize: 4 } }
      : {};

    if (effectiveViewMode === "side-by-side") {
      mergeView = new MergeView({
        a: {
          doc: oldText,
          extensions: [
            ...baseExts,
            ...(oldExt ? [oldExt] : []),
            ...(sideExtensions?.("a") ?? []),
          ],
        },
        b: {
          doc: newText,
          extensions: [
            ...baseExts,
            ...(newExt ? [newExt] : []),
            ...(sideExtensions?.("b") ?? []),
          ],
        },
        parent: host,
        ...collapse,
        diffConfig,
      });
      setActiveDiffView(mergeView.b, stepChunk);
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
              ...collapse,
              diffConfig,
            }),
          ],
        }),
        parent: host,
      });
      setActiveDiffView(unifiedView, stepChunk);
    }
    scheduleOverview(true);

    // A Blame drill-in names the line it came from: scroll the after side to
    // it once (it is a line the commit changed, so never in a collapsed run).
    // Otherwise §14.2 Step 7: restore the scroll position saved when the user
    // last left this file's tab. Only applies when this file matches the
    // tab's remembered file — switching to a different file resets to top.
    const reveal = appState.revealLine;
    const view = mergeView?.b ?? unifiedView;
    const keep = keepTop;
    keepTop = null;
    if (commitViewActive() && reveal && reveal.path === file.path && reveal.repoIdx === (file.repoIdx ?? 0)) {
      appState.revealLine = null;
      if (view) {
        const n = Math.min(Math.max(1, reveal.line), view.state.doc.lines);
        const pos = view.state.doc.line(n).from;
        requestAnimationFrame(() => {
          view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "center" }) });
        });
      }
    } else if (keep && keep.path === file.path && view) {
      // A "Changes only" toggle: back to the line that was at the top.
      const pos = view.state.doc.line(Math.min(keep.line, view.state.doc.lines)).from;
      requestAnimationFrame(() => {
        view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "start" }) });
      });
    } else if (!source) {
      const mem = appState.tabMemory.get(file.repoIdx ?? 0);
      if (mem?.filePath === file.path && typeof mem.scrollPos === "number" && view) {
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
      collapse: collapseOn,
    };
  }

  function teardown() {
    setActiveDiffView(null);
    mergeView?.destroy();
    mergeView = null;
    unifiedView?.destroy();
    unifiedView = null;
    mounted = null;
    navIndex = null;
    if (host) host.innerHTML = "";
    scheduleOverview(true);
  }

  onDestroy(() => {
    teardown();
    cancelAnimationFrame(overviewFrame);
  });

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
      <div class="chunk-nav">
        <button
          type="button"
          onclick={() => stepChunk(-1)}
          disabled={chunkAt.count === 0}
          title="Previous change (p)"
          aria-label="Previous change"
        >◀</button>
        <button
          type="button"
          onclick={() => stepChunk(1)}
          disabled={chunkAt.count === 0}
          title="Next change (n)"
          aria-label="Next change"
        >▶</button>
        <span class="chunk-count">
          {chunkAt.count > 0 ? `${chunkAt.index + 1} / ${chunkAt.count} changes` : "—"}
        </span>
      </div>
      <button
        type="button"
        class="changes-only"
        class:active={changesOnly}
        onclick={toggleChangesOnly}
        title={source
          ? "Changes only: collapse unchanged lines. Collapsed runs can hide context, commentable lines or threads"
          : "Changes only: collapse unchanged lines"}
      >
        Changes only
      </button>
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
      {#if !forceSideBySide}
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
      {/if}
    </div>
    {/if}
  </div>

  {#if labels && diff && diff.kind !== "submodule"}
    {#if effectiveViewMode === "side-by-side" && diff.kind === "text" && !showSvgPreview}
      <div class="pane-labels split">
        <span title={labels.left}>{labels.left}</span>
        <span title={labels.right}>{labels.right}</span>
      </div>
    {:else}
      <div class="pane-labels">
        <span>{labels.left} ← {labels.right}</span>
      </div>
    {/if}
  {/if}

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

  <div class="pane" class:hidden={diff?.kind !== "text" || showSvgPreview}>
    <!-- Capture: side-by-side scrolls .host, unified the editor's own scroller. -->
    <!-- User scrolling (not ◀ ▶) ends stepping from the last-visited chunk. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="host"
      bind:this={host}
      onscrollcapture={() => scheduleOverview(false)}
      onwheel={dropNav}
      onpointerdown={dropNav}
      onkeydown={(e) => SCROLL_KEYS.has(e.key) && dropNav()}
    ></div>
    <div class="overview">
      {#each marks as m, i (i)}
        <button
          type="button"
          tabindex="-1"
          class="mark {m.kind}"
          style="top: {m.top}%; height: {m.height}%"
          title={m.label}
          aria-label={m.label}
          onclick={() => revealMark(m)}
        ></button>
      {/each}
    </div>
  </div>
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
  .modes .changes-only {
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
  .pane-labels {
    display: flex;
    padding: 2px 10px;
    border-bottom: 1px solid var(--border);
    background: var(--bar-bg);
    color: var(--muted);
    font-size: 0.78em;
    font-family: var(--mono);
  }
  .pane-labels.split {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .pane-labels span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pane {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .pane.hidden {
    display: none;
  }
  .host {
    flex: 1;
    overflow: auto;
    min-height: 0;
    min-width: 0;
    font-family: var(--mono);
    font-size: var(--diff-font-size);
  }
  .overview {
    position: relative;
    flex: none;
    width: 10px;
    border-left: 1px solid var(--border);
    background: var(--bar-bg);
  }
  .mark {
    position: absolute;
    left: 1px;
    right: 1px;
    min-height: 2px;
    padding: 0;
    border: none;
    border-radius: 1px;
    cursor: pointer;
  }
  .mark:hover {
    filter: brightness(1.25);
    outline: 1px solid var(--fg);
  }
  .mark.added {
    background: var(--diff-add-border);
  }
  .mark.deleted {
    background: var(--diff-del-border);
  }
  .mark.modified {
    background: var(--diff-mod-border);
  }
  /* Review annotations sit on top of the change bars. */
  .mark.thread,
  .mark.finding,
  .mark.draft {
    left: 0;
    right: 0;
    min-height: 3px;
    z-index: 1;
  }
  .mark.thread {
    background: var(--mark-thread);
  }
  .mark.finding {
    background: var(--mark-finding);
  }
  .mark.draft {
    background: var(--accent);
  }
  .chunk-nav {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    margin-right: 8px;
  }
  .modes .chunk-nav button {
    padding: 2px 6px;
  }
  .modes .chunk-nav button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .chunk-count {
    margin-left: 4px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
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
