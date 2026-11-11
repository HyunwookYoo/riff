import type { Side } from "../types";
import type { ShownFinding } from "./result";
import type { Severity } from "./types";

const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export interface FindingRow {
  id: string;
  path: string;
  side: Side;
  line: number;
  severity: Severity;
  /** First non-empty line of the comment body. */
  summary: string;
  /** Not on a diff line: it would go in as a file or review-body comment. */
  offDiff: boolean;
  /** "roblox": from the Roblox parity pass. */
  tag?: "roblox";
}

/** Every shown (confirmed) finding across the PR, most severe first, then by path and line. */
export function findingIndex(inline: ShownFinding[], offDiff: ShownFinding[]): FindingRow[] {
  const row = (f: ShownFinding, off: boolean): FindingRow => ({
    id: f.id,
    path: f.path,
    side: f.side,
    line: f.line,
    severity: f.severity,
    summary: f.body.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "",
    offDiff: off,
    tag: f.tag,
  });
  return [...inline.map((f) => row(f, false)), ...offDiff.map((f) => row(f, true))].sort(
    (a, b) => RANK[a.severity] - RANK[b.severity] || a.path.localeCompare(b.path) || a.line - b.line,
  );
}

/** Per file: how many shown findings, and the most severe one. */
export function fileFindingBadges(findings: ShownFinding[]): Map<string, { count: number; severity: Severity }> {
  const m = new Map<string, { count: number; severity: Severity }>();
  for (const f of findings) {
    const cur = m.get(f.path);
    if (!cur) m.set(f.path, { count: 1, severity: f.severity });
    else m.set(f.path, { count: cur.count + 1, severity: RANK[f.severity] < RANK[cur.severity] ? f.severity : cur.severity });
  }
  return m;
}
