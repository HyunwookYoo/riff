<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import fuzzysort from "fuzzysort";
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
    lineNumbers,
  } from "@codemirror/view";
  import { EditorState, type Extension, type Range } from "@codemirror/state";
  import { search, searchKeymap } from "@codemirror/search";
  import { appState } from "$lib/store.svelte";
  import { blameFile, listRepoFiles, readRepoFile } from "$lib/git";
  import { pushAndDrillToCommit } from "$lib/history";
  import type { Blame, BlameCommit } from "$lib/types";
  import { detectLanguage } from "$lib/diff/lang";
  import { isDarkMode, shikiExtension } from "$lib/diff/shiki";
  import { setActiveDiffView } from "$lib/diff/activeView";
  import { adjustFontSize, resetFontSize } from "$lib/font";
  import {
    ancestorDirs,
    buildPathTree,
    type TreePathNode,
  } from "./pathTree";
  import PathTreeNode from "./PathTreeNode.svelte";
  import Dropdown from "./Dropdown.svelte";

  let host: HTMLDivElement;
  let searchInput: HTMLInputElement;
  let view: EditorView | null = null;

  let query = $state("");
  let highlightedIndex = $state(0);
  let fileText = $state<string | null>(null);
  let loadError = $state<string | null>(null);
  let blameData = $state<Blame | null>(null);
  let blameLoading = $state(false);
  let blameError = $state<string | null>(null);
  let selectedCommitSha = $state<string | null>(null);
  type SortMode = "time-desc" | "first-line" | "line-count";
  let sortMode = $state<SortMode>("time-desc");
  let repoFilesError = $state<string | null>(null);

  /** Cap on fuzzy result rows. */
  const MAX_FUZZY_ROWS = 200;

  /** Built tree (no root node); rebuilt only when repoFiles identity changes. */
  const repoTree = $derived(buildPathTree(appState.repoFiles));

  type FuzzyRow = { path: string; html: string };
  const fuzzyResults = $derived.by<FuzzyRow[]>(() => {
    const q = query.trim();
    if (!q) return [];
    // Pull more than we'll show — the basename filter below may drop a
    // chunk of folder-only hits, and we still want to fill MAX_FUZZY_ROWS.
    const raw = fuzzysort.go(q, appState.repoFiles, {
      limit: MAX_FUZZY_ROWS * 4,
    });
    // Keep only matches that touch the file's basename. Without this, a
    // query like "src/lib" matches every file under src/lib (chars all in
    // the directory portion) and dumps the whole folder into the panel —
    // not what the user wants.
    const onlyBasenameHits = raw.filter((r) => {
      const basenameStart = r.target.lastIndexOf("/") + 1;
      return r.indexes.some((i) => i >= basenameStart);
    });
    return onlyBasenameHits
      .slice(0, MAX_FUZZY_ROWS)
      .map((r) => ({ path: r.target, html: r.highlight("<mark>", "</mark>") }));
  });

  /** Set of expanded directory paths. Initial expansion = top-level dirs +
   * ancestors of the currently selected file. User toggles via clicks. */
  let expandedDirs = $state<Set<string>>(new Set());
  /** Tracks whether we've seeded `expandedDirs` for the current repo's tree.
   * Re-seeded when repo files change shape (different repo, or list reload). */
  let treeSeedKey = $state("");

  $effect(() => {
    const key = `${appState.repoPath}|${appState.repoFiles.length}`;
    if (key === treeSeedKey) return;
    treeSeedKey = key;
    const next = new Set<string>();
    for (const node of repoTree) {
      if (node.kind === "dir") next.add(node.path);
    }
    if (appState.blameFilePath) {
      for (const a of ancestorDirs(appState.blameFilePath)) next.add(a);
    }
    expandedDirs = next;
  });

  // Auto-expand ancestors when the picked file changes (e.g. via fuzzy search)
  // so switching back to the tree view lands you on the highlighted entry.
  $effect(() => {
    const path = appState.blameFilePath;
    if (!path) return;
    const ancestors = ancestorDirs(path);
    if (ancestors.length === 0) return;
    let changed = false;
    const next = new Set(expandedDirs);
    for (const a of ancestors) {
      if (!next.has(a)) {
        next.add(a);
        changed = true;
      }
    }
    if (changed) expandedDirs = next;
  });

  function toggleDir(path: string) {
    const next = new Set(expandedDirs);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    expandedDirs = next;
  }

  /** When the user is searching we render a *filtered* tree containing only
   * the matching paths (and their ancestors). All dirs are auto-expanded so
   * matches are visible immediately. */
  const searchTree = $derived.by<TreePathNode[]>(() => {
    if (query.trim() === "") return [];
    return buildPathTree(fuzzyResults.map((r) => r.path));
  });

  const searchExpandedDirs = $derived.by<Set<string>>(() => {
    const dirs = new Set<string>();
    const walk = (nodes: TreePathNode[]) => {
      for (const n of nodes) {
        if (n.kind === "dir") {
          dirs.add(n.path);
          walk(n.children);
        }
      }
    };
    walk(searchTree);
    return dirs;
  });

  /** File path the keyboard cursor is on within fuzzy results. Independent of
   * the actively-blamed file — Enter is what commits the selection. */
  const highlightedPath = $derived<string | null>(
    fuzzyResults[highlightedIndex]?.path ?? null,
  );

  /** Commits enriched with line counts and first-line, then sorted per mode. */
  type CommitRow = BlameCommit & { lineCount: number; firstLine: number };
  const commitsView = $derived.by<CommitRow[]>(() => {
    if (!blameData) return [];
    const counts = new Array(blameData.commits.length).fill(0);
    const firstLine = new Array(blameData.commits.length).fill(
      Number.POSITIVE_INFINITY,
    );
    for (let i = 0; i < blameData.line_commit.length; i++) {
      const idx = blameData.line_commit[i];
      counts[idx]++;
      if (firstLine[idx] === Number.POSITIVE_INFINITY) firstLine[idx] = i + 1;
    }
    const rows: CommitRow[] = blameData.commits.map((c, i) => ({
      ...c,
      lineCount: counts[i],
      firstLine: firstLine[i],
    }));
    switch (sortMode) {
      case "time-desc":
        rows.sort((a, b) => b.author_time - a.author_time);
        break;
      case "first-line":
        rows.sort((a, b) => a.firstLine - b.firstLine);
        break;
      case "line-count":
        rows.sort((a, b) => b.lineCount - a.lineCount);
        break;
    }
    return rows;
  });

  // ---- effects ----

  // Load repo file list once per open repo. Cleared on repo switch by InputBar.
  $effect(() => {
    const repo = appState.repoPath;
    if (!repo || appState.repoFiles.length > 0) return;
    void (async () => {
      try {
        const files = await listRepoFiles(repo);
        if (appState.repoPath === repo) {
          appState.repoFiles = files;
          repoFilesError = null;
        }
      } catch (e) {
        repoFilesError = String(e);
      }
    })();
  });

  // Focus the search input on mount.
  $effect(() => {
    searchInput?.focus();
  });

  // Reset fuzzy-result highlight cursor when the result set changes shape.
  $effect(() => {
    void fuzzyResults.length;
    highlightedIndex = 0;
  });

  // Keep the highlighted row visible as the user arrows through results.
  $effect(() => {
    const path = highlightedPath;
    if (!path) return;
    // Defer to next frame so the tree DOM has rendered the new highlight.
    requestAnimationFrame(() => {
      const el = document.querySelector(
        `.picker .results [data-path="${CSS.escape(path)}"]`,
      );
      el?.scrollIntoView({ block: "nearest" });
    });
  });

  // (Re)load file content + blame whenever the picked file or repo changes.
  // Also re-runs on theme change so the editor remounts with the right shiki.
  $effect(() => {
    const path = appState.blameFilePath;
    const repo = appState.repoPath;
    void appState.effectiveTheme;
    if (!repo || !path) {
      teardownEditor();
      fileText = null;
      blameData = null;
      blameLoading = false;
      return;
    }
    void load(repo, path);
  });

  async function load(repo: string, path: string) {
    teardownEditor();
    fileText = null;
    loadError = null;
    blameData = null;
    blameError = null;
    selectedCommitSha = null;
    blameLoading = true;

    let text: string;
    let blame: Blame;
    try {
      [text, blame] = await Promise.all([
        readRepoFile(repo, path),
        blameFile(repo, path, "HEAD", true),
      ]);
    } catch (e) {
      if (appState.blameFilePath !== path) return;
      loadError = String(e);
      blameLoading = false;
      return;
    }

    // Race: user picked a different file while we were loading.
    if (appState.blameFilePath !== path) return;
    fileText = text;
    blameData = blame;
    blameLoading = false;
    await tick();
    await mountEditor(path, text);
  }

  async function mountEditor(path: string, text: string) {
    if (!host) return;
    const dark = isDarkMode();
    const syntax = await shikiExtension(text, detectLanguage(path), dark);
    const exts: Extension[] = [
      // readOnly (not just editable=false) hides the Replace fields in the
      // Ctrl+F search panel — this app is a viewer, replace is dead weight.
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.lineWrapping,
      EditorView.darkTheme.of(dark),
      EditorView.theme({ ".cm-scroller": { fontFamily: "var(--mono)" } }),
      lineNumbers(),
      search({ top: true }),
      keymap.of(searchKeymap),
      blameGutterExt,
      blameLinePlugin,
      blameTooltipExt,
    ];
    if (syntax) exts.push(syntax);
    view = new EditorView({
      state: EditorState.create({ doc: text, extensions: exts }),
      parent: host,
    });
    setActiveDiffView(view);
    host.addEventListener("mousemove", onHostMouseMove);
    host.addEventListener("mouseleave", onHostMouseLeave);
    host.addEventListener("click", onHostClick);
  }

  function teardownEditor() {
    setActiveDiffView(null);
    if (host) {
      host.removeEventListener("mousemove", onHostMouseMove);
      host.removeEventListener("mouseleave", onHostMouseLeave);
      host.removeEventListener("click", onHostClick);
    }
    view?.destroy();
    view = null;
    currentPeerSha = null;
    if (host) host.innerHTML = "";
  }

  onDestroy(teardownEditor);

  // ---- selection handlers ----

  function selectFile(path: string) {
    if (appState.blameFilePath === path) return;
    appState.blameFilePath = path;
  }

  function selectCommit(sha: string, firstLine: number) {
    if (selectedCommitSha === sha) {
      selectedCommitSha = null;
      return;
    }
    selectedCommitSha = sha;
    if (!view) return;
    const totalLines = view.state.doc.lines;
    if (firstLine >= 1 && firstLine <= totalLines) {
      const line = view.state.doc.line(firstLine);
      view.dispatch({
        effects: EditorView.scrollIntoView(line.from, { y: "center" }),
      });
    }
  }

  function onSearchKeyDown(e: KeyboardEvent) {
    // Arrow/Enter only navigate the fuzzy result list. When the query is
    // empty the picker shows a tree; mouse-only there.
    if (e.key === "ArrowDown") {
      if (fuzzyResults.length > 0) {
        highlightedIndex = (highlightedIndex + 1) % fuzzyResults.length;
      }
      e.preventDefault();
      return;
    }
    if (e.key === "ArrowUp") {
      if (fuzzyResults.length > 0) {
        highlightedIndex =
          (highlightedIndex - 1 + fuzzyResults.length) % fuzzyResults.length;
      }
      e.preventDefault();
      return;
    }
    if (e.key === "Enter") {
      const row = fuzzyResults[highlightedIndex];
      if (row) selectFile(row.path);
      e.preventDefault();
      return;
    }
    if (e.key === "Escape") {
      if (query !== "") {
        query = "";
        e.preventDefault();
        e.stopPropagation();
      }
      // Empty -> let +page.svelte's Esc handler take over (history pop, etc).
      return;
    }
  }

  // ---- helpers ----

  function commitColor(sha: string): string {
    const hue = parseInt(sha.slice(0, 6), 16) % 360;
    const dark = appState.effectiveTheme === "dark";
    return dark ? `hsl(${hue}, 55%, 55%)` : `hsl(${hue}, 65%, 50%)`;
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

  // ---- CodeMirror extensions (closures over component-local state) ----

  /** Short author display for the inline gutter — first whitespace-separated
   * token, truncated with ellipsis at `max` chars. Keeps the gutter narrow. */
  function shortAuthor(name: string, max = 9): string {
    const first = (name.split(/\s+/)[0] || name).trim();
    if (!first) return "";
    return first.length > max ? first.slice(0, max - 1) + "…" : first;
  }

  /** Compact relative time for the inline gutter (e.g. "3d", "2w", "5mo"). */
  function shortRelativeDate(unixSec: number): string {
    const diff = Date.now() / 1000 - unixSec;
    if (diff < 60) return "now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
    if (diff < 2592000) return `${Math.floor(diff / 604800)}w`;
    if (diff < 31536000) return `${Math.floor(diff / 2592000)}mo`;
    return `${Math.floor(diff / 31536000)}y`;
  }

  /** Per-line inline gutter marker: colored stripe + short SHA + author + time. */
  class BlameInfoMarker extends GutterMarker {
    sha: string;
    author: string;
    time: string;
    color: string;
    uncommitted: boolean;
    sticky: boolean;
    constructor(opts: {
      sha: string;
      author: string;
      time: string;
      color: string;
      uncommitted: boolean;
      sticky: boolean;
    }) {
      super();
      this.sha = opts.sha;
      this.author = opts.author;
      this.time = opts.time;
      this.color = opts.color;
      this.uncommitted = opts.uncommitted;
      this.sticky = opts.sticky;
    }
    eq(other: GutterMarker): boolean {
      return (
        other instanceof BlameInfoMarker &&
        other.sha === this.sha &&
        other.author === this.author &&
        other.time === this.time &&
        other.color === this.color &&
        other.uncommitted === this.uncommitted &&
        other.sticky === this.sticky
      );
    }
    toDOM(): HTMLElement {
      const el = document.createElement("div");
      el.className = "blame-info";
      if (this.uncommitted) el.classList.add("uncommitted");
      if (this.sticky) el.classList.add("sticky");
      el.style.setProperty("--blame-stripe", this.color);

      const shaEl = document.createElement("span");
      shaEl.className = "blame-info-sha";
      shaEl.textContent = this.uncommitted ? "—" : this.sha;
      el.appendChild(shaEl);

      const authorEl = document.createElement("span");
      authorEl.className = "blame-info-author";
      authorEl.textContent = this.uncommitted ? "uncommitted" : this.author;
      el.appendChild(authorEl);

      const timeEl = document.createElement("span");
      timeEl.className = "blame-info-time";
      timeEl.textContent = this.time;
      el.appendChild(timeEl);

      return el;
    }
  }

  const blameGutterExt = gutter({
    class: "cm-blame-info-gutter",
    lineMarker(view, line) {
      if (!blameData) return null;
      const lineNum = view.state.doc.lineAt(line.from).number;
      const idx = blameData.line_commit[lineNum - 1];
      if (idx === undefined) return null;
      const commit = blameData.commits[idx];
      if (!commit) return null;
      const uncommitted = commit.sha === "00000000";
      const sticky =
        selectedCommitSha !== null && commit.sha === selectedCommitSha;
      return new BlameInfoMarker({
        sha: commit.sha,
        author: uncommitted ? "" : shortAuthor(commit.author),
        time: uncommitted ? "" : shortRelativeDate(commit.author_time),
        color: uncommitted ? "transparent" : commitColor(commit.sha),
        uncommitted,
        sticky,
      });
    },
  });

  // Tags each editor line with `data-blame-sha=<sha>` plus a `blame-selected`
  // class when the commit-panel selection matches. The data attribute powers
  // the mousemove peer highlight; the class powers the sticky highlight.
  const blameLinePlugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(_u: ViewUpdate) {
        this.decorations = this.build(_u.view);
      }
      build(view: EditorView): DecorationSet {
        if (!blameData) return Decoration.none;
        const ranges: Range<Decoration>[] = [];
        const totalLines = view.state.doc.lines;
        const limit = Math.min(blameData.line_commit.length, totalLines);
        for (let i = 0; i < limit; i++) {
          const idx = blameData.line_commit[i];
          const commit = blameData.commits[idx];
          if (!commit) continue;
          const cls =
            selectedCommitSha !== null && commit.sha === selectedCommitSha
              ? "blame-selected"
              : null;
          const lineNum = i + 1;
          const line = view.state.doc.line(lineNum);
          ranges.push(
            Decoration.line({
              attributes: cls
                ? { "data-blame-sha": commit.sha, class: cls }
                : { "data-blame-sha": commit.sha },
            }).range(line.from),
          );
        }
        return Decoration.set(ranges);
      }
    },
    { decorations: (v) => v.decorations },
  );

  // Force the editor to re-evaluate gutter + line decorations when state the
  // extensions close over changes (sticky highlight, sort, etc).
  function pingEditor() {
    view?.dispatch({});
  }
  $effect(() => {
    void selectedCommitSha;
    void blameData;
    pingEditor();
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
    if (!blameData) {
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

  // Click on a code line → select that commit in the sidepanel. We don't
  // toggle on repeat-click here because clicking text shouldn't read as
  // "deselect" — that's a sidepanel-only affordance.
  function onHostClick(e: MouseEvent) {
    if (!blameData) return;
    const target = e.target as HTMLElement | null;
    const line = target?.closest(".cm-line[data-blame-sha]");
    if (!line) return;
    const sha = (line as HTMLElement).dataset.blameSha;
    if (!sha || sha === "00000000") return;
    if (selectedCommitSha !== sha) selectedCommitSha = sha;
  }

  // Whenever the selected commit changes (from either side), make sure the
  // matching sidepanel row is visible. No-op if it's already on screen.
  $effect(() => {
    const sha = selectedCommitSha;
    if (!sha) return;
    requestAnimationFrame(() => {
      const el = document.querySelector(
        `.commit-list [data-sha="${CSS.escape(sha)}"]`,
      );
      el?.scrollIntoView({ block: "nearest" });
    });
  });

  // Live-painted tooltip DOM, so the contents stay accurate if blame data
  // arrives after the hover (loading state at first paint).
  let activeTooltipDom: HTMLElement | null = null;
  let activeTooltipLine = 0;

  function renderPopover(dom: HTMLElement, commit: BlameCommit) {
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

  function paintTooltipDom(dom: HTMLElement, lineNum: number) {
    dom.classList.remove("loading", "error");
    if (blameLoading || (!blameData && !blameError)) {
      dom.innerHTML = "";
      dom.textContent = "Loading blame…";
      dom.classList.add("loading");
      return;
    }
    if (blameError) {
      dom.innerHTML = "";
      dom.textContent = `Blame unavailable: ${blameError}`;
      dom.classList.add("error");
      return;
    }
    if (blameData) {
      const idx = blameData.line_commit[lineNum - 1];
      if (idx === undefined) {
        dom.innerHTML = "";
        dom.textContent = "No blame info for this line";
      } else {
        renderPopover(dom, blameData.commits[idx]);
      }
    }
  }

  const blameTooltipExt = hoverTooltip((view, pos) => {
    const line = view.state.doc.lineAt(pos);
    const lineNum = line.number;
    return {
      pos: line.from,
      end: line.to,
      above: true,
      create() {
        const dom = document.createElement("div");
        dom.className = "blame-popover";
        paintTooltipDom(dom, lineNum);
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

  $effect(() => {
    void blameData;
    void blameLoading;
    void blameError;
    if (activeTooltipDom) paintTooltipDom(activeTooltipDom, activeTooltipLine);
  });
</script>

<div class="blame-view">
  <aside class="picker">
    <header class="picker-header">
      <input
        type="search"
        bind:this={searchInput}
        bind:value={query}
        onkeydown={onSearchKeyDown}
        placeholder="Search files…"
        spellcheck="false"
      />
      <span class="count">{appState.repoFiles.length}</span>
    </header>
    <div class="results">
      {#if repoFilesError}
        <div class="empty error">{repoFilesError}</div>
      {:else if appState.repoFiles.length === 0}
        <div class="empty">No repo open, or scanning files…</div>
      {:else if query.trim() === ""}
        {#each repoTree as node (node.kind === "dir" ? "d:" + node.path : "f:" + node.path)}
          <PathTreeNode
            {node}
            expanded={expandedDirs}
            selectedPath={appState.blameFilePath}
            onSelectFile={selectFile}
            onToggleDir={toggleDir}
          />
        {/each}
      {:else if fuzzyResults.length === 0}
        <div class="empty">No matches.</div>
      {:else}
        {#each searchTree as node (node.kind === "dir" ? "d:" + node.path : "f:" + node.path)}
          <PathTreeNode
            {node}
            expanded={searchExpandedDirs}
            selectedPath={appState.blameFilePath}
            {highlightedPath}
            onSelectFile={selectFile}
            onToggleDir={() => {}}
          />
        {/each}
      {/if}
    </div>
  </aside>

  <main class="editor-pane">
    <header class="toolbar">
      <span class="path" title={appState.blameFilePath ?? ""}>
        {appState.blameFilePath ?? "No file selected"}
      </span>
      <div class="actions">
        <div class="font-size" title="Editor font size (Ctrl +/- / 0)">
          <button type="button" onclick={() => adjustFontSize(-1)}>A−</button>
          <button type="button" class="size-reset" onclick={() => resetFontSize()}>
            {appState.fontSize}
          </button>
          <button type="button" onclick={() => adjustFontSize(1)}>A+</button>
        </div>
        <Dropdown
          title="Commit sidepanel sort order"
          value={sortMode}
          options={[
            { value: "time-desc", label: "Recent first" },
            { value: "first-line", label: "By first line" },
            { value: "line-count", label: "Most lines" },
          ]}
          onchange={(v) => (sortMode = v as SortMode)}
        />
      </div>
    </header>
    {#if !appState.blameFilePath}
      <div class="placeholder">
        Pick a file on the left to view its blame.
      </div>
    {:else if loadError}
      <div class="placeholder error">{loadError}</div>
    {:else if blameLoading && !fileText}
      <div class="placeholder">Loading…</div>
    {/if}
    <div class="host" bind:this={host} class:hidden={!fileText}></div>
  </main>

  <aside class="commit-panel">
    <header class="panel-header">
      <span>Commits</span>
      <span class="count">{commitsView.length}</span>
    </header>
    <div class="commit-list">
      {#if !blameData && !blameLoading}
        <div class="empty">—</div>
      {:else if blameLoading}
        <div class="empty">Loading…</div>
      {:else}
        {#each commitsView as c (c.sha)}
          <div
            class="commit-row"
            class:active={selectedCommitSha === c.sha}
            class:uncommitted={c.sha === "00000000"}
            data-sha={c.sha}
          >
            <button
              type="button"
              class="row-main"
              onclick={() => selectCommit(c.sha, c.firstLine)}
              title="{c.summary}\n{c.author} · {relativeDate(c.author_time)}"
            >
              <span
                class="dot"
                style="background:{c.sha === '00000000'
                  ? 'transparent'
                  : commitColor(c.sha)}"
                class:uncommitted={c.sha === "00000000"}
              ></span>
              <div class="info">
                <div class="line1">
                  <span class="sha">{c.sha}</span>
                  <span class="author">
                    {c.sha === "00000000" ? "Not Committed Yet" : c.author}
                  </span>
                </div>
                <div class="summary">{c.summary || "(no subject)"}</div>
                <div class="meta">
                  {c.sha === "00000000"
                    ? "uncommitted"
                    : relativeDate(c.author_time)} · {c.lineCount} line{c.lineCount ===
                  1
                    ? ""
                    : "s"}
                </div>
              </div>
            </button>
            {#if c.sha !== "00000000"}
              <button
                type="button"
                class="drill"
                title="View this commit's changes"
                onclick={() => pushAndDrillToCommit(c.sha)}
              >
                →
              </button>
            {/if}
          </div>
        {/each}
      {/if}
    </div>
  </aside>
</div>

<style>
  .blame-view {
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: 300px 1fr 300px;
    min-height: 0;
    min-width: 0;
  }
  .picker {
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--border);
    background: var(--sidebar-bg);
    min-width: 0;
    min-height: 0;
  }
  .picker-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--border);
  }
  .picker-header input {
    flex: 1;
    min-width: 0;
    padding: 4px 8px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: var(--input-bg);
    color: inherit;
    font-family: inherit;
    font-size: 0.85em;
  }
  .picker-header .count {
    font-size: 0.75em;
    opacity: 0.6;
    font-variant-numeric: tabular-nums;
  }
  .results {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }
  .empty {
    padding: 12px 10px;
    color: var(--muted);
    font-size: 0.85em;
  }
  .empty.error {
    color: var(--error-fg);
  }
  .editor-pane {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--bar-bg);
    font-size: 0.85em;
    font-family: var(--mono);
  }
  .toolbar .path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    opacity: 0.8;
  }
  .actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .font-size {
    display: inline-flex;
  }
  .font-size button {
    padding: 2px 8px;
    border: 1px solid var(--border);
    background: var(--input-bg);
    color: inherit;
    cursor: pointer;
    font-size: 0.85em;
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
  .placeholder {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--muted);
    font-size: 0.9em;
    padding: 16px;
    text-align: center;
  }
  .placeholder.error {
    color: var(--error-fg);
    white-space: pre-wrap;
  }
  .commit-panel {
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--border);
    background: var(--sidebar-bg);
    min-width: 0;
    min-height: 0;
  }
  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    border-bottom: 1px solid var(--border);
    font-size: 0.8em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    opacity: 0.7;
  }
  .panel-header .count {
    font-weight: 400;
    opacity: 0.6;
    font-variant-numeric: tabular-nums;
  }
  .commit-list {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }
  .commit-row {
    display: flex;
    align-items: stretch;
    border-bottom: 1px solid var(--border);
  }
  .commit-row.active {
    background: var(--selected);
    color: var(--selected-fg);
  }
  .commit-row.active .drill {
    color: var(--selected-fg);
  }
  .commit-row:not(.active):hover {
    background: var(--hover);
  }
  .row-main {
    flex: 1;
    display: flex;
    gap: 8px;
    align-items: flex-start;
    background: transparent;
    border: none;
    color: inherit;
    text-align: left;
    padding: 8px 10px;
    cursor: pointer;
    min-width: 0;
  }
  .dot {
    flex-shrink: 0;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-top: 5px;
  }
  .dot.uncommitted {
    background: repeating-linear-gradient(
      45deg,
      var(--border),
      var(--border) 2px,
      transparent 2px,
      transparent 4px
    ) !important;
  }
  .info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .line1 {
    display: flex;
    gap: 8px;
    font-family: var(--mono);
    font-size: 0.78em;
  }
  .sha {
    opacity: 0.7;
  }
  .author {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .summary {
    font-size: 0.82em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    font-size: 0.72em;
    opacity: 0.6;
  }
  .drill {
    border: none;
    background: transparent;
    color: var(--accent);
    padding: 0 10px;
    cursor: pointer;
    font-size: 1.1em;
    opacity: 0;
    transition: opacity 0.1s;
  }
  .commit-row:hover .drill,
  .commit-row.active .drill {
    opacity: 1;
  }
  .drill:hover {
    background: var(--hover);
  }

  /* Editor decorations and floating UI are injected globally because
     CodeMirror lifts the tooltip/gutter DOM out of this component's scope. */
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
  /* Per-line inline blame gutter: colored stripe + short SHA + author + time.
     Width is fixed so the editor below it aligns. */
  :global(.cm-gutter.cm-blame-info-gutter) {
    background: var(--bar-bg);
    border-right: 1px solid var(--border);
    padding: 0;
    font-family: var(--mono);
    font-size: 0.78em;
  }
  :global(.cm-blame-info-gutter .cm-gutterElement) {
    padding: 0;
    min-width: 24ch;
    max-width: 24ch;
  }
  :global(.blame-info) {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 100%;
    border-left: 3px solid var(--blame-stripe, transparent);
    padding: 0 8px 0 6px;
    color: var(--fg);
    opacity: 0.78;
    white-space: nowrap;
  }
  :global(.blame-info.uncommitted) {
    border-left-color: transparent;
    background: repeating-linear-gradient(
      45deg,
      transparent,
      transparent 4px,
      rgba(127, 127, 127, 0.08) 4px,
      rgba(127, 127, 127, 0.08) 6px
    );
  }
  :global(.blame-info.sticky) {
    opacity: 1;
    font-weight: 600;
    border-left-width: 5px;
    background: rgba(127, 127, 200, 0.12);
  }
  :global(.blame-info-sha) {
    opacity: 0.65;
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }
  :global(.blame-info-author) {
    flex-shrink: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  :global(.blame-info-time) {
    margin-left: auto;
    opacity: 0.6;
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }
  :global(.cm-line.blame-peer) {
    background-color: rgba(127, 127, 200, 0.12);
  }
  :global(.cm-line.blame-selected) {
    background-color: rgba(127, 127, 200, 0.22);
  }
</style>
