<script lang="ts">
  import { onDestroy } from "svelte";
  import {
    EditorView,
    keymap,
    lineNumbers,
    Decoration,
    ViewPlugin,
    WidgetType,
    type DecorationSet,
  } from "@codemirror/view";
  import {
    EditorState,
    type Extension,
    type Range,
  } from "@codemirror/state";
  import { search, searchKeymap } from "@codemirror/search";
  import { appState } from "$lib/store.svelte";
  import {
    conflictVersions,
    resolveConflict,
    checkoutConflictSide,
  } from "$lib/git";
  import { changesRepoPath, loadStatus } from "$lib/sourceControl";
  import { detectLanguage } from "$lib/diff/lang";
  import { isDarkMode, shikiExtension } from "$lib/diff/shiki";

  let oursHost = $state<HTMLDivElement>();
  let baseHost = $state<HTMLDivElement>();
  let theirsHost = $state<HTMLDivElement>();
  let resultHost = $state<HTMLDivElement>();

  let oursView: EditorView | null = null;
  let baseView: EditorView | null = null;
  let theirsView: EditorView | null = null;
  let resultView: EditorView | null = null;

  let loading = $state(false);
  let error = $state<string | null>(null);
  let binary = $state(false);
  let hasBase = $state(true);
  let conflictsLeft = $state(0);
  let busy = $state(false);
  let loadSession = 0;

  // A floating Ours/Theirs/Both toolbar rendered above each conflict's
  // `<<<<<<<` marker. Clicking replaces the whole region [from, to] with the
  // chosen side, dropping the markers. Positions are captured at build time and
  // stay valid until the next edit — and a click *is* an edit, which rebuilds
  // the plugin's decorations with fresh positions for the remaining regions.
  class AcceptWidget extends WidgetType {
    view: EditorView;
    from: number;
    to: number;
    ours: string;
    theirs: string;
    constructor(
      view: EditorView,
      from: number,
      to: number,
      ours: string,
      theirs: string,
    ) {
      super();
      this.view = view;
      this.from = from;
      this.to = to;
      this.ours = ours;
      this.theirs = theirs;
    }
    eq(o: AcceptWidget) {
      return (
        o.from === this.from &&
        o.to === this.to &&
        o.ours === this.ours &&
        o.theirs === this.theirs
      );
    }
    ignoreEvent() {
      return true;
    }
    toDOM() {
      const wrap = document.createElement("div");
      wrap.className = "cv-accept";
      const both =
        this.ours && this.theirs
          ? `${this.ours}\n${this.theirs}`
          : this.ours + this.theirs;
      const mk = (label: string, cls: string, insert: string) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = cls;
        btn.textContent = label;
        btn.onmousedown = (e) => e.preventDefault();
        btn.onclick = (e) => {
          e.preventDefault();
          this.view.dispatch({
            changes: { from: this.from, to: this.to, insert },
          });
        };
        return btn;
      };
      wrap.appendChild(mk("Ours", "ours", this.ours));
      wrap.appendChild(mk("Theirs", "theirs", this.theirs));
      wrap.appendChild(mk("Both", "both", both));
      return wrap;
    }
  }

  // Highlight git's conflict regions and attach the accept toolbars.
  // Recomputed on every doc change.
  const conflictDecos = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: { docChanged: boolean; view: EditorView }) {
        if (u.docChanged) this.decorations = build(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  );

  const oursLine = Decoration.line({ class: "cv-ours" });
  const theirsLine = Decoration.line({ class: "cv-theirs" });
  const baseLine = Decoration.line({ class: "cv-base" });
  const markerLine = Decoration.line({ class: "cv-marker" });

  function lineText(doc: EditorView["state"]["doc"], a: number, b: number): string {
    if (b < a) return "";
    const parts: string[] = [];
    for (let i = a; i <= b; i++) parts.push(doc.line(i).text);
    return parts.join("\n");
  }

  function build(view: EditorView): DecorationSet {
    const doc = view.state.doc;
    const ranges: Range<Decoration>[] = [];
    // Line shading. side: 0 = outside, 1 = ours, 2 = base (diff3), 3 = theirs.
    // Region tracking (start/base/sep line numbers) drives the accept widgets.
    let side = 0;
    let start = -1;
    let baseL = -1;
    let sep = -1;
    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i);
      const t = line.text;
      if (t.startsWith("<<<<<<<")) {
        ranges.push(markerLine.range(line.from));
        side = 1;
        start = i;
        baseL = -1;
        sep = -1;
      } else if (t.startsWith("|||||||")) {
        ranges.push(markerLine.range(line.from));
        side = 2;
        baseL = i;
      } else if (t.startsWith("=======")) {
        ranges.push(markerLine.range(line.from));
        side = 3;
        sep = i;
      } else if (t.startsWith(">>>>>>>")) {
        ranges.push(markerLine.range(line.from));
        side = 0;
        if (start > 0 && sep > 0) {
          const oursEnd = (baseL > 0 ? baseL : sep) - 1;
          const ours = lineText(doc, start + 1, oursEnd);
          const theirs = lineText(doc, sep + 1, i - 1);
          ranges.push(
            Decoration.widget({
              widget: new AcceptWidget(
                view,
                doc.line(start).from,
                line.to,
                ours,
                theirs,
              ),
              block: true,
              side: -1,
            }).range(doc.line(start).from),
          );
        }
        start = -1;
      } else if (side === 1) {
        ranges.push(oursLine.range(line.from));
      } else if (side === 2) {
        ranges.push(baseLine.range(line.from));
      } else if (side === 3) {
        ranges.push(theirsLine.range(line.from));
      }
    }
    return Decoration.set(ranges, true);
  }

  function countConflicts(doc: string): number {
    return (doc.match(/^<<<<<<</gm) ?? []).length;
  }

  function teardown() {
    oursView?.destroy();
    baseView?.destroy();
    theirsView?.destroy();
    resultView?.destroy();
    oursView = baseView = theirsView = resultView = null;
  }

  onDestroy(teardown);

  // Reload whenever the selected (conflicted) file or theme changes.
  $effect(() => {
    const file = appState.selectedFile;
    const theme = appState.effectiveTheme;
    void theme;
    void load(file?.path ?? null);
  });

  async function load(path: string | null) {
    const session = ++loadSession;
    error = null;
    if (!path) {
      teardown();
      return;
    }
    loading = true;
    const repo = changesRepoPath();
    let vers;
    try {
      vers = await conflictVersions(repo, path);
    } catch (e) {
      if (session !== loadSession) return;
      error = String(e);
      loading = false;
      teardown();
      return;
    }
    if (session !== loadSession) return;
    loading = false;
    binary = vers.binary;
    hasBase = vers.base.length > 0;
    conflictsLeft = countConflicts(vers.merged);
    if (binary) {
      teardown();
      return;
    }

    const lang = detectLanguage(path);
    const dark = isDarkMode();
    const [oursExt, baseExt, theirsExt] = await Promise.all([
      shikiExtension(vers.ours, lang, dark),
      shikiExtension(vers.base, lang, dark),
      shikiExtension(vers.theirs, lang, dark),
    ]);
    if (session !== loadSession) return;
    teardown();

    const refExts = (ext: Extension | null): Extension[] => [
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.lineWrapping,
      EditorView.darkTheme.of(dark),
      EditorView.theme({ ".cm-scroller": { fontFamily: "var(--mono)" } }),
      lineNumbers(),
      search({ top: true }),
      keymap.of(searchKeymap),
      ...(ext ? [ext] : []),
    ];

    if (oursHost)
      oursView = new EditorView({
        state: EditorState.create({ doc: vers.ours, extensions: refExts(oursExt) }),
        parent: oursHost,
      });
    if (baseHost)
      baseView = new EditorView({
        state: EditorState.create({ doc: vers.base, extensions: refExts(baseExt) }),
        parent: baseHost,
      });
    if (theirsHost)
      theirsView = new EditorView({
        state: EditorState.create({ doc: vers.theirs, extensions: refExts(theirsExt) }),
        parent: theirsHost,
      });
    if (resultHost)
      resultView = new EditorView({
        state: EditorState.create({
          doc: vers.merged,
          extensions: [
            EditorView.lineWrapping,
            EditorView.darkTheme.of(dark),
            EditorView.theme({ ".cm-scroller": { fontFamily: "var(--mono)" } }),
            lineNumbers(),
            search({ top: true }),
            keymap.of(searchKeymap),
            conflictDecos,
            EditorView.updateListener.of((u) => {
              if (u.docChanged)
                conflictsLeft = countConflicts(u.state.doc.toString());
            }),
          ],
        }),
        parent: resultHost,
      });
  }

  async function markResolved() {
    const file = appState.selectedFile;
    if (!file || !resultView || busy) return;
    busy = true;
    error = null;
    try {
      await resolveConflict(changesRepoPath(), file.path, resultView.state.doc.toString());
      await loadStatus();
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }

  async function takeSide(side: "ours" | "theirs") {
    const file = appState.selectedFile;
    if (!file || busy) return;
    busy = true;
    error = null;
    try {
      await checkoutConflictSide(changesRepoPath(), file.path, side);
      await loadStatus();
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
</script>

<div class="conflictview">
  <div class="cv-toolbar">
    <span class="cv-status">
      {#if binary}
        Binary conflict — choose a side
      {:else if conflictsLeft > 0}
        ⚠ {conflictsLeft} conflict{conflictsLeft === 1 ? "" : "s"} remaining
      {:else}
        ✓ No markers left — ready to mark resolved
      {/if}
    </span>
    <button type="button" disabled={busy} onclick={() => takeSide("ours")}>
      Take ours
    </button>
    <button type="button" disabled={busy} onclick={() => takeSide("theirs")}>
      Take theirs
    </button>
    {#if !binary}
      <button
        type="button"
        class="resolve"
        disabled={busy}
        title={conflictsLeft > 0
          ? "There are still conflict markers — resolve them or use Take ours/theirs"
          : "Stage the resolved file"}
        onclick={markResolved}
      >
        Mark resolved
      </button>
    {/if}
  </div>

  {#if error}
    <div class="cv-error">{error}</div>
  {/if}

  {#if loading}
    <div class="cv-placeholder">Loading conflict…</div>
  {:else if binary}
    <div class="cv-placeholder">
      This is a binary file. Pick <strong>Take ours</strong> or
      <strong>Take theirs</strong> above to resolve it.
    </div>
  {:else}
    <div class="cv-panes">
      <div class="cv-col">
        <header class="cv-h ours">Ours · current</header>
        <div class="cv-host" bind:this={oursHost}></div>
      </div>
      <div class="cv-col" class:empty={!hasBase}>
        <header class="cv-h base">Base{hasBase ? "" : " · none"}</header>
        <div class="cv-host" bind:this={baseHost}></div>
      </div>
      <div class="cv-col">
        <header class="cv-h theirs">Theirs · incoming</header>
        <div class="cv-host" bind:this={theirsHost}></div>
      </div>
    </div>
    <div class="cv-result">
      <header class="cv-h result">Result · edit the markers to resolve</header>
      <div class="cv-host" bind:this={resultHost}></div>
    </div>
  {/if}
</div>

<style>
  .conflictview {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
  }
  .cv-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 10px;
    border-bottom: 1px solid var(--border);
    background: var(--bar-bg);
    font-size: 0.85em;
  }
  .cv-status {
    flex: 1;
    color: var(--muted);
  }
  .cv-toolbar button {
    padding: 4px 10px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--input-bg);
    color: inherit;
    cursor: pointer;
  }
  .cv-toolbar button:hover:not(:disabled) {
    background: var(--hover);
  }
  .cv-toolbar button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .cv-toolbar .resolve {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .cv-error {
    padding: 6px 10px;
    background: var(--error-bg);
    color: var(--error-fg);
    font-size: 0.82em;
    white-space: pre-wrap;
  }
  .cv-placeholder {
    padding: 24px;
    color: var(--muted);
    text-align: center;
  }
  .cv-panes {
    display: flex;
    flex: 1 1 50%;
    min-height: 0;
    border-bottom: 2px solid var(--border);
  }
  .cv-col {
    display: flex;
    flex-direction: column;
    flex: 1 1 0;
    min-width: 0;
    border-right: 1px solid var(--border);
  }
  .cv-col:last-child {
    border-right: none;
  }
  .cv-col.empty {
    opacity: 0.55;
  }
  .cv-result {
    display: flex;
    flex-direction: column;
    flex: 1 1 50%;
    min-height: 0;
  }
  .cv-h {
    padding: 3px 8px;
    font-size: 0.76em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    background: var(--bar-bg);
    border-bottom: 1px solid var(--border);
    color: var(--muted);
  }
  .cv-h.ours {
    color: #4a9d5b;
  }
  .cv-h.theirs {
    color: #5a9bd4;
  }
  .cv-h.result {
    color: var(--accent);
  }
  .cv-host {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  .cv-host :global(.cm-editor) {
    height: 100%;
  }
  /* Conflict-region shading in the result editor. */
  .cv-host :global(.cv-ours) {
    background: rgba(74, 157, 91, 0.14);
  }
  .cv-host :global(.cv-theirs) {
    background: rgba(90, 155, 212, 0.14);
  }
  .cv-host :global(.cv-base) {
    background: rgba(140, 140, 140, 0.12);
  }
  .cv-host :global(.cv-marker) {
    background: rgba(210, 153, 34, 0.22);
    font-weight: 700;
  }
  /* Per-conflict accept toolbar, rendered above each `<<<<<<<` marker. */
  .cv-host :global(.cv-accept) {
    display: flex;
    gap: 4px;
    padding: 2px 4px 2px 8px;
  }
  .cv-host :global(.cv-accept button) {
    font-family: var(--mono);
    font-size: 0.72em;
    padding: 1px 8px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--input-bg);
    color: inherit;
    cursor: pointer;
    line-height: 1.5;
  }
  .cv-host :global(.cv-accept button:hover) {
    background: var(--hover);
  }
  .cv-host :global(.cv-accept .ours:hover) {
    border-color: #4a9d5b;
    color: #4a9d5b;
  }
  .cv-host :global(.cv-accept .theirs:hover) {
    border-color: #5a9bd4;
    color: #5a9bd4;
  }
</style>
