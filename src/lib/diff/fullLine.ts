import {
  Decoration,
  ViewPlugin,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { getChunks } from "@codemirror/merge";

const fullLineChange = Decoration.line({ class: "cm-fullLineChange" });

function compute(view: EditorView): DecorationSet {
  const data = getChunks(view.state);
  if (!data) return Decoration.none;
  // Unified mode reports side as null; the editor's doc is the new (B) doc.
  const isA = data.side === "a";
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  for (const chunk of data.chunks) {
    const chunkFrom = isA ? chunk.fromA : chunk.fromB;
    const chunkTo = isA ? chunk.toA : chunk.toB;
    if (chunkFrom === chunkTo || chunkFrom >= doc.length) continue;

    // Precompute change ranges in absolute doc coordinates for this side.
    const changeRanges: { from: number; to: number }[] = [];
    for (const ch of chunk.changes) {
      const cf = chunkFrom + (isA ? ch.fromA : ch.fromB);
      const ct = chunkFrom + (isA ? ch.toA : ch.toB);
      if (ct > cf) changeRanges.push({ from: cf, to: ct });
    }

    let line = doc.lineAt(chunkFrom);
    while (true) {
      const lineLen = line.to - line.from;
      if (lineLen === 0) {
        // Treat empty lines as full-line changes too (no word-level signal possible).
        builder.add(line.from, line.from, fullLineChange);
      } else {
        // Sum changedText coverage on this line.
        let covered = 0;
        for (const r of changeRanges) {
          const f = Math.max(r.from, line.from);
          const t = Math.min(r.to, line.to);
          if (t > f) covered += t - f;
        }
        // ≥95% coverage → effectively a full-line change.
        if (covered * 20 >= lineLen * 19) {
          builder.add(line.from, line.from, fullLineChange);
        }
      }
      if (line.to + 1 >= chunkTo || line.to >= doc.length) break;
      line = doc.lineAt(line.to + 1);
    }
  }
  return builder.finish();
}

export const fullLineChangePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = compute(view);
    }
    update(u: ViewUpdate) {
      const cur = getChunks(u.state)?.chunks;
      const prev = getChunks(u.startState)?.chunks;
      if (cur !== prev) this.decorations = compute(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);
