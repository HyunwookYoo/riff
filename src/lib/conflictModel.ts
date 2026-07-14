// Pure model for git conflict resolution: parse the working-tree `merged`
// document (with <<<<<<< markers) into an editable segment list, and reassemble
// the resolved file. No CodeMirror / Svelte imports — unit-tested standalone.

export type ConflictOp = "merge" | "rebase" | "cherry-pick" | "revert" | "none";
export type ConflictChoice = "current" | "incoming" | "both" | null;

export interface ConflictHunk {
  current: string; // stage-2 ("ours") content, verbatim incl. line terminators
  base: string; // stage-1 base content (diff3); "" when absent
  incoming: string; // stage-3 ("theirs") content
  choice: ConflictChoice; // null = unresolved
}

export type Segment =
  | { type: "text"; content: string } // verbatim non-conflict text
  | { type: "conflict"; hunk: ConflictHunk };

// Split into lines that KEEP their trailing "\n", so concatenation is lossless.
function rawLines(s: string): string[] {
  return s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/**
 * Parse a merged doc into ordered segments. Recognizes diff3 (|||||||) and plain
 * markers; only markers at line start count. Best-effort: a doc without a clean
 * closing marker still returns whatever was collected (callers fall back to
 * manual mode on anomalies).
 */
export function parseConflicts(merged: string): Segment[] {
  const lines = rawLines(merged);
  const segments: Segment[] = [];
  let text = "";
  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith("<<<<<<<")) {
      if (text) {
        segments.push({ type: "text", content: text });
        text = "";
      }
      i++; // consume <<<<<<<
      let current = "";
      let base = "";
      let incoming = "";
      let hasBase = false;
      while (
        i < lines.length &&
        !lines[i].startsWith("|||||||") &&
        !lines[i].startsWith("=======")
      )
        current += lines[i++];
      if (i < lines.length && lines[i].startsWith("|||||||")) {
        hasBase = true;
        i++; // consume |||||||
        while (i < lines.length && !lines[i].startsWith("======="))
          base += lines[i++];
      }
      if (i < lines.length && lines[i].startsWith("=======")) i++; // consume =======
      while (i < lines.length && !lines[i].startsWith(">>>>>>>"))
        incoming += lines[i++];
      if (i < lines.length && lines[i].startsWith(">>>>>>>")) i++; // consume >>>>>>>
      segments.push({
        type: "conflict",
        hunk: { current, base: hasBase ? base : "", incoming, choice: null },
      });
    } else {
      text += lines[i++];
    }
  }
  if (text) segments.push({ type: "text", content: text });
  return segments;
}

function renderMarkers(h: ConflictHunk): string {
  const base = h.base ? `||||||| Base\n${h.base}` : "";
  return `<<<<<<< Current\n${h.current}${base}=======\n${h.incoming}>>>>>>> Incoming\n`;
}

/**
 * Reassemble the file: text verbatim; a conflict → its chosen side ("both" =
 * current then incoming). An unresolved (null) hunk renders as canonical
 * markers, so this serves both the final resolve (callers gate on
 * unresolvedCount === 0 → no markers emitted) and the manual-edit seed.
 */
export function assembleResult(segments: Segment[]): string {
  let out = "";
  for (const s of segments) {
    if (s.type === "text") {
      out += s.content;
      continue;
    }
    const h = s.hunk;
    out +=
      h.choice === "current"
        ? h.current
        : h.choice === "incoming"
          ? h.incoming
          : h.choice === "both"
            ? h.current + h.incoming
            : renderMarkers(h);
  }
  return out;
}

export function unresolvedCount(segments: Segment[]): number {
  return segments.filter((s) => s.type === "conflict" && s.hunk.choice === null)
    .length;
}

export interface SideDescriptor {
  label: string;
  role: string;
}

/**
 * Presentation labels. Current takes the real branch name when known; Incoming
 * takes the op-aware role (real incoming ref name is out of scope in v1). The
 * role sublabel is kept for both.
 */
export function sideDescriptors(
  op: ConflictOp,
  currentBranch: string | null,
): { current: SideDescriptor; incoming: SideDescriptor } {
  const cur = currentBranch ?? null;
  switch (op) {
    case "rebase":
      return {
        current: { label: cur ?? "rebase target", role: "rebase target (onto)" },
        incoming: { label: "Incoming", role: "your commit (replayed)" },
      };
    case "cherry-pick":
      return {
        current: { label: cur ?? "current branch", role: "current branch" },
        incoming: { label: "Incoming", role: "picked commit" },
      };
    case "revert":
      return {
        current: { label: cur ?? "current branch", role: "current branch" },
        incoming: { label: "Incoming", role: "being reverted" },
      };
    default: // merge / none
      return {
        current: { label: cur ?? "current branch", role: "current branch" },
        incoming: { label: "Incoming", role: "incoming branch" },
      };
  }
}
