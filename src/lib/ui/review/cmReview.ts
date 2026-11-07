import {
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  WidgetType,
  gutter,
  type DecorationSet,
} from "@codemirror/view";
import { RangeSetBuilder, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import type { Side } from "$lib/review/types";

/** A block widget shown after `line` (1-based). `mount` returns its unmount. */
export type InlineItem = { line: number; key: string; mount: (el: HTMLElement) => () => void };

export const setInlineItems = StateEffect.define<InlineItem[]>();

export function groupByLine(items: InlineItem[]): Map<number, InlineItem[]> {
  const m = new Map<number, InlineItem[]>();
  for (const i of items) {
    const at = m.get(i.line);
    if (at) at.push(i);
    else m.set(i.line, [i]);
  }
  return m;
}

// One DOM per toDOM call; CodeMirror may redraw a widget, so unmounts are per element.
const unmounts = new WeakMap<HTMLElement, () => void>();

class ItemWidget extends WidgetType {
  constructor(readonly item: InlineItem) {
    super();
  }
  eq(other: ItemWidget): boolean {
    return other.item.key === this.item.key;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = "cm-review-inline";
    unmounts.set(el, this.item.mount(el));
    return el;
  }
  destroy(dom: HTMLElement): void {
    unmounts.get(dom)?.();
    unmounts.delete(dom);
  }
  // The widget owns its events (textareas, buttons); the editor stays out.
  ignoreEvent(): boolean {
    return true;
  }
}

function build(doc: Text, items: InlineItem[]): DecorationSet {
  const groups = groupByLine(items);
  const b = new RangeSetBuilder<Decoration>();
  for (const line of [...groups.keys()].sort((x, y) => x - y)) {
    if (line < 1 || line > doc.lines) continue;
    const pos = doc.line(line).to;
    for (const item of groups.get(line)!) {
      b.add(pos, pos, Decoration.widget({ widget: new ItemWidget(item), block: true, side: 1 }));
    }
  }
  return b.finish();
}

const inlineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) if (e.is(setInlineItems)) return build(tr.state.doc, e.value);
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

class PlusMarker extends GutterMarker {
  toDOM(): Node {
    const s = document.createElement("span");
    s.textContent = "+";
    return s;
  }
}
const plus = new PlusMarker();

export function reviewExtension(opts: {
  side: Side;
  commentable: (line: number) => boolean;
  onLineClick: (line: number, shift: boolean) => void;
}): Extension {
  return [
    gutter({
      class: "cm-review-gutter",
      lineMarker: (view, block) => (opts.commentable(view.state.doc.lineAt(block.from).number) ? plus : null),
      initialSpacer: () => plus,
      domEventHandlers: {
        mousedown(view, block, event) {
          const n = view.state.doc.lineAt(block.from).number;
          if (!opts.commentable(n)) return false;
          opts.onLineClick(n, (event as MouseEvent).shiftKey);
          return true;
        },
      },
    }),
    inlineField,
    EditorView.theme({
      ".cm-review-gutter .cm-gutterElement": { cursor: "pointer", padding: "0 3px", color: "var(--accent)" },
      ".cm-review-gutter .cm-gutterElement:hover": { background: "var(--accent-soft)" },
    }),
  ];
}

/** Reports the editor this extension lives in (`alive` false on destroy). */
export function trackView(cb: (view: EditorView, alive: boolean) => void): Extension {
  return ViewPlugin.define((view) => {
    cb(view, true);
    return { destroy: () => cb(view, false) };
  });
}
