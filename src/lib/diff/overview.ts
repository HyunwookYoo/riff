// Pure geometry for DiffView's change map and change counter. The editor
// supplies chunk offsets and a pos → height-fraction function; nothing here
// touches the DOM.

/** A @codemirror/merge chunk's line-aligned offsets (`to` is one past the last line). */
export interface ChunkSpan {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
}

export type ChangeKind = "added" | "deleted" | "modified";
export type MarkerKind = "thread" | "finding" | "draft";

/** A PR Review annotation: 1-based `line` of that side's document. */
export interface DiffMarker {
  side: "a" | "b";
  line: number;
  kind: MarkerKind;
}

export interface OverviewMark {
  kind: ChangeKind | MarkerKind;
  /** Percent (0..100) of the scrolled height. */
  top: number;
  height: number;
  /** Where clicking scrolls: a position in `side`'s document. */
  side: "a" | "b";
  pos: number;
  label: string;
}

interface DocLike {
  readonly length: number;
  readonly lines: number;
  line(n: number): { from: number };
  lineAt(pos: number): { number: number };
}

export interface OverviewGeometry {
  doc(side: "a" | "b"): DocLike;
  /** Fractions (0..1) of the scrolled height covered by the line block at `pos`. */
  span(side: "a" | "b", pos: number): { top: number; bottom: number };
}

export function chunkKind(c: ChunkSpan): ChangeKind {
  if (c.fromA === c.toA) return "added";
  if (c.fromB === c.toB) return "deleted";
  return "modified";
}

const MARKER_LABEL: Record<MarkerKind, string> = {
  thread: "thread",
  finding: "AI finding",
  draft: "draft",
};

const lines = (n: number) => `${n} line${n === 1 ? "" : "s"}`;
const pct = (f: number) => Math.min(100, Math.max(0, f * 100));

function lineCount(doc: DocLike, from: number, to: number): number {
  if (to <= from) return 0;
  return doc.lineAt(Math.min(to - 1, doc.length)).number - doc.lineAt(from).number + 1;
}

export function overviewMarks(
  chunks: readonly ChunkSpan[],
  markers: readonly DiffMarker[],
  g: OverviewGeometry,
): OverviewMark[] {
  const docA = g.doc("a");
  const docB = g.doc("b");
  const out: OverviewMark[] = [];
  for (const c of chunks) {
    const kind = chunkKind(c);
    const from = Math.min(c.fromB, docB.length);
    const top = g.span("b", from).top;
    const bottom = c.toB > c.fromB ? g.span("b", Math.min(c.toB - 1, docB.length)).bottom : top;
    const nA = lineCount(docA, c.fromA, c.toA);
    const nB = lineCount(docB, c.fromB, c.toB);
    const label =
      kind === "added"
        ? `added ${lines(nB)}`
        : kind === "deleted"
          ? `deleted ${lines(nA)}`
          : `modified ${nA} → ${lines(nB)}`;
    out.push({ kind, top: pct(top), height: pct(bottom) - pct(top), side: "b", pos: from, label });
  }
  for (const m of markers) {
    const doc = g.doc(m.side);
    const pos = doc.line(Math.min(Math.max(1, m.line), doc.lines)).from;
    const s = g.span(m.side, pos);
    out.push({
      kind: m.kind,
      top: pct(s.top),
      height: pct(s.bottom) - pct(s.top),
      side: m.side,
      pos,
      label: `${MARKER_LABEL[m.kind]} · line ${m.line}`,
    });
  }
  return out;
}

/** A doc-A position on doc B; a position inside a chunk maps to the chunk's start. */
export function mapAToB(chunks: readonly ChunkSpan[], posA: number): number {
  let delta = 0;
  for (const c of chunks) {
    if (posA < c.fromA) break;
    if (posA < c.toA) return c.fromB;
    delta = c.toB - c.toA;
  }
  return posA + delta;
}

/**
 * Index of the chunk at or just below `topPos` (side-b position at the
 * viewport top); the last chunk once the top is past them all; -1 without any.
 */
export function currentChunkIndex(chunks: readonly ChunkSpan[], topPos: number): number {
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (Math.max(c.fromB, c.toB - 1) >= topPos) return i;
  }
  return chunks.length - 1;
}
