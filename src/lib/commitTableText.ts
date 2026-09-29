import type { ToolbarPair } from "./rangeText";
import type { Commit, ContainmentDetail } from "./types";

/// How a range's two sides are named (see rangeText.sideNames).
export type SideNames = ToolbarPair;

/// A row's mark: ● not in base, ◐ in base as a patch, ✓ in base by ancestry.
export type RowMark = "out" | "patch" | "in";

/// ● / ◐ / behind counts for a group or a total.
export interface Counts {
  out: number;
  patch: number;
  behind: number;
}

/// What a group header can add beyond its counts.
export interface GroupNotes {
  mergedBy: Commit | null | undefined;
}

/// The summary line's state, decided by branchContainment.summarize().
export type Summary =
  | { kind: "no-refs" }
  | { kind: "same" }
  | { kind: "loading" }
  | { kind: "error" }
  | {
      kind: "unmerged";
      names: SideNames;
      out: number;
      patch: number;
      behind: number | null;
      repos: number;
    }
  | { kind: "patches"; names: SideNames; patch: number }
  | { kind: "merged"; names: SideNames; mergedBy: Commit | null }
  | { kind: "all-in"; names: SideNames; repos: number };

/// The table's short date, in the user's locale.
export function shortDate(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function summaryText(s: Summary): string {
  switch (s.kind) {
    case "no-refs":
      return "Pick base and compare to see which commits are merged.";
    case "same":
      return "base and compare are the same.";
    case "loading":
      return "Checking commits…";
    case "error":
      return "Couldn't read commits.";
    case "unmerged": {
      const range = `${s.names.base} ← ${s.names.compare}`;
      const head = s.repos > 1 ? `${range} across ${s.repos} repos:` : `${range}:`;
      const parts = [`● ${s.out} not merged`];
      if (s.patch > 0) parts.push(`◐ ${s.patch} applied as patch`);
      if (s.behind) parts.push(`${s.names.compare} is ${s.behind} behind`);
      return `${head} ${parts.join(" · ")}`;
    }
    case "patches":
      return `✓ Every commit on ${s.names.compare} is in ${s.names.base}, ${s.patch} of them as ${s.patch === 1 ? "a patch" : "patches"} (rebased, cherry-picked or squash-merged)`;
    case "merged":
      return s.mergedBy
        ? `✓ All commits on ${s.names.compare} are in ${s.names.base} — merged by ${s.mergedBy.short_sha} "${s.mergedBy.summary}" · ${shortDate(s.mergedBy.time)}`
        : `✓ All commits on ${s.names.compare} are in ${s.names.base} (fast-forward, no merge commit)`;
    case "all-in":
      return `✓ All changes on ${s.names.compare} are in ${s.names.base} across ${s.repos} repos`;
  }
}

/// The counts on a group header.
export function groupCountsText(c: Counts, names: SideNames, n: GroupNotes): string {
  if (c.out === 0 && c.patch === 0) {
    return n.mergedBy
      ? `✓ all in ${names.base} · merged by ${n.mergedBy.short_sha}`
      : `✓ all in ${names.base}`;
  }
  const parts: string[] = [];
  if (c.out > 0) parts.push(`● ${c.out}`);
  if (c.patch > 0) parts.push(`◐ ${c.patch}`);
  let text = parts.join(" ");
  if (c.behind > 0) text += ` · ${names.compare} is ${c.behind} behind`;
  return text;
}

/// A row's status column.
export function statusText(mark: RowMark, names: SideNames): string {
  switch (mark) {
    case "out":
      return `not in ${names.base}`;
    case "patch":
      return "applied as patch";
    case "in":
      return `in ${names.base}`;
  }
}

/// The Files header's account of the picked commit.
export function commitStateText(
  mark: RowMark,
  names: SideNames,
  detail: ContainmentDetail | null,
): string {
  switch (mark) {
    case "out":
      return `not in ${names.base}`;
    case "patch":
      return `applied to ${names.base} as a patch`;
    case "in": {
      const m = detail?.introduced_by;
      return m
        ? `merged by ${m.short_sha} (${shortDate(m.time)})`
        : `in ${names.base}`;
    }
  }
}

/// The Files header while nothing is picked.
export function allChangesText(names: SideNames): string {
  return `All changes · ${names.base} ← ${names.compare}`;
}
