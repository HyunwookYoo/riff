<script lang="ts">
  import { onDestroy } from "svelte";
  import {
    EditorView,
    keymap,
    lineNumbers,
    Decoration,
    WidgetType,
    type DecorationSet,
  } from "@codemirror/view";
  import {
    EditorState,
    StateField,
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
  import { changesRepoPath, loadStatus, openNextConflict } from "$lib/sourceControl";
  import { detectLanguage } from "$lib/diff/lang";
  import { isDarkMode, shikiExtension } from "$lib/diff/shiki";
  import {
    parseConflicts,
    assembleResult,
    unresolvedCount,
    sideDescriptors,
    type ConflictOp,
    type Segment,
  } from "$lib/conflictModel";

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
  let showBase = $state(false);
  let busy = $state(false);
  let loadSession = 0;

  // The Result's segment model (Tasks 1-2). Structured mode renders this
  // directly — read-only, resolve via each block's buttons; manual mode is a
  // plain editable marker doc seeded from it, the escape hatch for a parse we
  // don't trust (see safeParse) or a user who just wants to hand-edit.
  let segments = $state<Segment[]>([]);
  let manualMode = $state(false);
  // Live marker count in the manual editor, kept in sync by its update
  // listener. Structured mode ignores this — `remaining` reads the segment
  // model instead.
  let conflictsLeft = $state(0);
  const remaining = $derived(
    manualMode ? conflictsLeft : unresolvedCount(segments),
  );
  // Sentinel positions of the last-built structured doc's unresolved blocks,
  // used for Prev/Next (see conflictPositions()).
  let resultBlocks: { pos: number; idx: number }[] = [];

  // git swaps the meaning of stage-2 (ours) / stage-3 (theirs) depending on the
  // operation. Most notably, in a rebase "ours" is the branch being replayed
  // ONTO (the target), and "theirs" is your commit being replayed — the reverse
  // of a merge. Label the sides by the in-progress op so the user doesn't pick
  // the wrong one.
  const sides = $derived(
    sideDescriptors(appState.pendingOp as ConflictOp, appState.currentBranch),
  );

  // A floating Current/Incoming/Both toolbar rendered above each conflict's
  // `<<<<<<<` marker. Clicking replaces the whole region [from, to] with the
  // chosen side, dropping the markers. Positions are captured at build time and
  // stay valid until the next edit — and a click *is* an edit, which rebuilds
  // the plugin's decorations with fresh positions for the remaining regions.
  class AcceptWidget extends WidgetType {
    from: number;
    to: number;
    ours: string;
    theirs: string;
    oursLabel: string;
    theirsLabel: string;
    constructor(
      from: number,
      to: number,
      ours: string,
      theirs: string,
      oursLabel: string,
      theirsLabel: string,
    ) {
      super();
      this.from = from;
      this.to = to;
      this.ours = ours;
      this.theirs = theirs;
      this.oursLabel = oursLabel;
      this.theirsLabel = theirsLabel;
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
    toDOM(view: EditorView) {
      const wrap = document.createElement("div");
      wrap.className = "cv-accept";
      const both =
        this.ours && this.theirs
          ? `${this.ours}\n${this.theirs}`
          : this.ours + this.theirs;
      const mk = (label: string, cls: string, insert: string, title: string) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = cls;
        btn.textContent = label;
        btn.title = title;
        btn.onmousedown = (e) => e.preventDefault();
        btn.onclick = (e) => {
          e.preventDefault();
          view.dispatch({
            changes: { from: this.from, to: this.to, insert },
          });
        };
        return btn;
      };
      wrap.appendChild(
        mk("Use Current", "ours", this.ours, `Keep current — ${this.oursLabel}`),
      );
      wrap.appendChild(
        mk("Use Incoming", "theirs", this.theirs, `Keep incoming — ${this.theirsLabel}`),
      );
      wrap.appendChild(mk("Both", "both", both, "Keep both, current then incoming"));
      return wrap;
    }
  }

  // Doc text for the structured Result = resolved/text segments inline; each
  // unresolved hunk becomes one sentinel newline (an empty line) carrying a
  // replace block widget. `blocks` gives each sentinel's doc position so the
  // decorations — and Prev/Next — can find them.
  function buildResult(
    segs: Segment[],
  ): { doc: string; blocks: { pos: number; idx: number }[] } {
    let doc = "";
    const blocks: { pos: number; idx: number }[] = [];
    segs.forEach((s, idx) => {
      if (s.type === "text") {
        // Normalize CRLF for this display-only doc (CodeMirror's own \r\n?|\n
        // line splitting otherwise interacts badly with the bare-\n sentinel
        // lines below); the real resolve path (assembleResult on segments)
        // is untouched and stays byte-faithful to the source.
        doc += s.content.replace(/\r\n/g, "\n");
        return;
      }
      const h = s.hunk;
      if (h.choice === null) {
        blocks.push({ pos: doc.length, idx });
        doc += "\n";
      } else {
        const text =
          h.choice === "current"
            ? h.current
            : h.choice === "incoming"
              ? h.incoming
              : h.current + h.incoming;
        doc += text.replace(/\r\n/g, "\n");
      }
    });
    return { doc, blocks };
  }

  // An unresolved hunk in the structured Result: both sides stacked with an
  // accept toolbar, no raw marker ASCII. Replaces the sentinel line
  // buildResult() emits for it. Diff highlighting inside each side is Task 6.
  class ConflictBlockWidget extends WidgetType {
    idx: number;
    constructor(idx: number) {
      super();
      this.idx = idx;
    }
    eq(o: ConflictBlockWidget) {
      return o.idx === this.idx;
    }
    toDOM() {
      const seg = segments[this.idx];
      const h = seg.type === "conflict" ? seg.hunk : null;
      const wrap = document.createElement("div");
      wrap.className = "cv-block";
      if (!h) return wrap;
      const side = (cls: string, label: string, text: string) => {
        const box = document.createElement("div");
        box.className = `cv-side ${cls}`;
        const hd = document.createElement("div");
        hd.className = "cv-side-h";
        hd.textContent = label;
        const pre = document.createElement("pre");
        pre.className = "cv-side-body";
        pre.textContent = text.replace(/\r?\n$/, "");
        box.append(hd, pre);
        return box;
      };
      wrap.appendChild(side("current", `Current · ${sides.current.label}`, h.current));
      wrap.appendChild(side("incoming", `Incoming · ${sides.incoming.role}`, h.incoming));
      const bar = document.createElement("div");
      bar.className = "cv-block-bar";
      const btn = (txt: string, choice: "current" | "incoming" | "both") => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = txt;
        b.onclick = () => choose(this.idx, choice);
        return b;
      };
      bar.append(btn("Use Current", "current"), btn("Use Incoming", "incoming"), btn("Both", "both"));
      wrap.appendChild(bar);
      return wrap;
    }
    ignoreEvent() {
      return false;
    }
  }

  // Accept a side for one hunk, then trigger the segments $effect to rebuild
  // the Result from scratch with the new choice baked in.
  function choose(idx: number, choice: "current" | "incoming" | "both") {
    const seg = segments[idx];
    if (seg.type !== "conflict") return;
    seg.hunk.choice = choice;
    segments = [...segments];
  }

  // Highlight git's conflict regions and attach the accept toolbars. A
  // StateField, not a ViewPlugin: CodeMirror requires block decorations
  // (the AcceptWidget toolbar is `block: true`) to come from state, not a
  // viewport-driven plugin — it throws "Block decorations may not be
  // specified via plugins" otherwise. Recomputed on every doc change.
  const conflictDecos = StateField.define<DecorationSet>({
    create(state) {
      return build(state);
    },
    update(deco, tr) {
      return tr.docChanged ? build(tr.state) : deco;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

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

  function build(state: EditorState): DecorationSet {
    const doc = state.doc;
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
                doc.line(start).from,
                line.to,
                ours,
                theirs,
                sides.current.role,
                sides.incoming.role,
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

  // assembleResult renders an unresolved hunk with canonical "Current"/
  // "Base"/"Incoming" labels, which differ from git's real marker suffixes
  // (ref names / SHAs) — so comparing it byte-for-byte against vers.merged
  // would spuriously fail on every real conflict. Strip each marker line's
  // label before comparing, so safeParse's check still catches genuine
  // parse anomalies (wrong hunk boundaries, dropped content) without
  // false-triggering on ordinary conflicts. Also normalize CRLF to LF first:
  // renderMarkers's synthetic marker lines are always LF-only, so on a CRLF
  // source (common on Windows) the bare "=======" separator — never touched
  // by the label strip above — would keep its \r on one side only.
  function stripMarkerLabels(doc: string): string {
    return doc
      .replace(/\r\n/g, "\n")
      .replace(/^(<<<<<<<|\|\|\|\|\|\|\||>>>>>>>).*$/gm, "$1");
  }

  // Parse defensively: on a throw, or when the parse doesn't faithfully
  // reproduce the source (see stripMarkerLabels above), fall back to a
  // single opaque text segment — assembleResult(segments) then equals
  // `merged` exactly, a safe, lossless seed for manual mode. The user is
  // never trapped behind a bad parse.
  function safeParse(merged: string): { segments: Segment[]; manual: boolean } {
    try {
      const segs = parseConflicts(merged);
      if (stripMarkerLabels(assembleResult(segs)) === stripMarkerLabels(merged)) {
        return { segments: segs, manual: false };
      }
    } catch {
      // fall through to the safe fallback below
    }
    return { segments: [{ type: "text", content: merged }], manual: true };
  }

  // Positions to jump to via Prev/Next: unresolved block sentinels in
  // structured mode (from the last buildResult() call), or each conflict's
  // `<<<<<<<` marker line in manual mode.
  function conflictPositions(): number[] {
    if (!resultView) return [];
    if (!manualMode) return resultBlocks.map((b) => b.pos);
    const doc = resultView.state.doc;
    const out: number[] = [];
    for (let i = 1; i <= doc.lines; i++) {
      if (doc.line(i).text.startsWith("<<<<<<<")) out.push(doc.line(i).from);
    }
    return out;
  }

  // Scroll the result editor to the conflict before/after the cursor (wraps).
  function goConflict(dir: 1 | -1) {
    const view = resultView;
    if (!view) return;
    const pos = conflictPositions();
    if (pos.length === 0) return;
    const head = view.state.selection.main.head;
    const target =
      dir === 1
        ? (pos.find((p) => p > head) ?? pos[0])
        : ([...pos].reverse().find((p) => p < head) ?? pos[pos.length - 1]);
    view.dispatch({
      selection: { anchor: target },
      effects: EditorView.scrollIntoView(target, { y: "center" }),
    });
    view.focus();
  }

  // Reveal the first conflict on load so the user lands right on it.
  function scrollToFirstConflict() {
    const view = resultView;
    if (!view) return;
    const pos = conflictPositions();
    if (pos.length === 0) return;
    view.dispatch({
      selection: { anchor: pos[0] },
      effects: EditorView.scrollIntoView(pos[0], { y: "center" }),
    });
  }

  // Structured Result: real text for resolved/text segments, each unresolved
  // hunk replaced by a block widget. Read-only — resolution happens via a
  // widget's buttons (choose()), which rebuild this from scratch. No shiki:
  // the Result has never been syntax-highlighted, only the reference panes.
  function buildStructuredEditor(segs: Segment[], dark: boolean): EditorView | null {
    if (!resultHost) return null;
    const { doc, blocks } = buildResult(segs);
    resultBlocks = blocks;
    const decos = Decoration.set(
      blocks.map((b) =>
        Decoration.replace({
          block: true,
          widget: new ConflictBlockWidget(b.idx),
        }).range(b.pos),
      ),
      true,
    );
    return new EditorView({
      state: EditorState.create({
        doc,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.lineWrapping,
          EditorView.darkTheme.of(dark),
          EditorView.theme({ ".cm-scroller": { fontFamily: "var(--mono)" } }),
          lineNumbers(),
          search({ top: true }),
          keymap.of(searchKeymap),
          EditorView.decorations.of(decos),
        ],
      }),
      parent: resultHost,
    });
  }

  // Manual mode: the pre-redesign editable marker doc — lineWrapping, search,
  // the marker/side shading + AcceptWidget toolbars, and a countConflicts
  // update listener. Seeded from the segment model (or, via safeParse's
  // fallback, from the raw source when the parse can't be trusted).
  function buildManualEditor(segs: Segment[], dark: boolean): EditorView | null {
    if (!resultHost) return null;
    const doc = assembleResult(segs);
    conflictsLeft = countConflicts(doc);
    return new EditorView({
      state: EditorState.create({
        doc,
        extensions: [
          EditorView.lineWrapping,
          EditorView.darkTheme.of(dark),
          EditorView.theme({ ".cm-scroller": { fontFamily: "var(--mono)" } }),
          lineNumbers(),
          search({ top: true }),
          keymap.of(searchKeymap),
          conflictDecos,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) conflictsLeft = countConflicts(u.state.doc.toString());
          }),
        ],
      }),
      parent: resultHost,
    });
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

  // (Re)build the Result editor whenever the segment model or edit mode
  // changes — a full EditorState.create is fine, accepts are low-frequency.
  // Kept separate from load() so an accept (choose()) only rebuilds the
  // Result, not the reference panes.
  $effect(() => {
    const segs = segments;
    const manual = manualMode;
    const file = appState.selectedFile;
    const dark = isDarkMode();
    resultView?.destroy();
    resultView = null;
    if (!file || binary || !resultHost) return;
    resultView = manual
      ? buildManualEditor(segs, dark)
      : buildStructuredEditor(segs, dark);
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
    const parsed = safeParse(vers.merged);
    segments = parsed.segments;
    manualMode = parsed.manual;
    // The segments/manualMode $effect (re)builds resultView; defer so it has
    // run by the time we scroll.
    requestAnimationFrame(() => scrollToFirstConflict());
  }

  async function markResolved() {
    const file = appState.selectedFile;
    if (!file || busy) return;
    const content = manualMode
      ? (resultView?.state.doc.toString() ?? "")
      : assembleResult(segments);
    if (countConflicts(content) > 0) return; // guard: markers remain
    busy = true;
    error = null;
    try {
      await resolveConflict(changesRepoPath(), file.path, content);
      await loadStatus();
      openNextConflict(); // v1: always advance
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
      {:else if remaining > 0}
        ⚠ {remaining} conflict{remaining === 1 ? "" : "s"} remaining
      {:else}
        ✓ Nothing left to resolve — ready to mark resolved
      {/if}
    </span>
    {#if !binary && remaining > 0}
      <div class="cv-nav">
        <button
          type="button"
          title="Jump to the previous conflict"
          aria-label="Previous conflict"
          onclick={() => goConflict(-1)}
        >
          ↑ Prev
        </button>
        <button
          type="button"
          title="Jump to the next conflict"
          aria-label="Next conflict"
          onclick={() => goConflict(1)}
        >
          Next ↓
        </button>
      </div>
    {/if}
    <button
      type="button"
      disabled={busy}
      title="Use the whole Current side — {sides.current.role}"
      onclick={() => takeSide("ours")}
    >
      Take Current
    </button>
    <button
      type="button"
      disabled={busy}
      title="Use the whole Incoming side — {sides.incoming.role}"
      onclick={() => takeSide("theirs")}
    >
      Take Incoming
    </button>
    {#if !binary && hasBase}
      <button
        type="button"
        class:active={showBase}
        title="Show the common ancestor (base)"
        onclick={() => (showBase = !showBase)}
      >
        Base
      </button>
    {/if}
    {#if !binary}
      <button
        type="button"
        class:active={manualMode}
        title="Edit the file directly with conflict markers"
        onclick={() => (manualMode = !manualMode)}
      >
        Edit manually
      </button>
      <button
        type="button"
        class="resolve"
        disabled={busy || remaining > 0}
        title={remaining > 0
          ? "There are still unresolved conflicts — resolve them or use Take Current/Incoming"
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
      This is a binary file. Pick <strong>Take Current</strong> or
      <strong>Take Incoming</strong> above to resolve it.
    </div>
  {:else}
    <div class="cv-panes">
      <div class="cv-col">
        <header class="cv-h current">Current · {sides.current.label}</header>
        <div class="cv-host" bind:this={oursHost}></div>
      </div>
      <div class="cv-col" class:hidden={!showBase || !hasBase}>
        <header class="cv-h base">Base</header>
        <div class="cv-host" bind:this={baseHost}></div>
      </div>
      <div class="cv-col">
        <header class="cv-h incoming">Incoming · {sides.incoming.role}</header>
        <div class="cv-host" bind:this={theirsHost}></div>
      </div>
    </div>
    <div class="cv-result">
      <header class="cv-h result">
        Result · {manualMode ? "edit the markers to resolve" : "resolve each conflict below"}
      </header>
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
  .cv-toolbar button.active {
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
  }
  .cv-nav {
    display: inline-flex;
    gap: 2px;
  }
  .cv-nav button {
    font-family: var(--mono);
    font-size: 0.92em;
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
  .cv-col.hidden {
    display: none;
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
  .cv-h.current {
    color: #4a9d5b;
  }
  .cv-h.incoming {
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
  /* Conflict-region shading in the result editor — a colored left stripe makes
     each block easy to spot at a glance. */
  .cv-host :global(.cv-ours) {
    background: rgba(74, 157, 91, 0.18);
    box-shadow: inset 3px 0 #4a9d5b;
  }
  .cv-host :global(.cv-theirs) {
    background: rgba(90, 155, 212, 0.18);
    box-shadow: inset 3px 0 #5a9bd4;
  }
  .cv-host :global(.cv-base) {
    background: rgba(140, 140, 140, 0.14);
    box-shadow: inset 3px 0 #8c8c8c;
  }
  .cv-host :global(.cv-marker) {
    background: rgba(210, 153, 34, 0.3);
    font-weight: 700;
    box-shadow: inset 3px 0 #d29922;
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
  /* Structured-mode conflict block: the unresolved hunk's two sides stacked
     with an accept toolbar — replaces the sentinel line buildResult() emits. */
  .cv-host :global(.cv-block) {
    display: flex;
    flex-direction: column;
    margin: 6px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }
  .cv-host :global(.cv-side + .cv-side) {
    border-top: 1px solid var(--border);
  }
  .cv-host :global(.cv-side.current) {
    box-shadow: inset 3px 0 #4a9d5b;
  }
  .cv-host :global(.cv-side.incoming) {
    box-shadow: inset 3px 0 #5a9bd4;
  }
  .cv-host :global(.cv-side-h) {
    padding: 2px 8px;
    font-size: 0.72em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--muted);
    background: var(--bar-bg);
  }
  .cv-host :global(.cv-side-body) {
    margin: 0;
    padding: 4px 10px;
    font-family: var(--mono);
    font-size: 0.9em;
    white-space: pre-wrap;
    word-break: break-word;
    background: var(--input-bg);
  }
  .cv-host :global(.cv-block-bar) {
    display: flex;
    gap: 4px;
    padding: 4px 8px;
    background: var(--bar-bg);
    border-top: 1px solid var(--border);
  }
  .cv-host :global(.cv-block-bar button) {
    font-family: var(--mono);
    font-size: 0.75em;
    padding: 2px 10px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--input-bg);
    color: inherit;
    cursor: pointer;
  }
  .cv-host :global(.cv-block-bar button:hover) {
    background: var(--hover);
  }
</style>
