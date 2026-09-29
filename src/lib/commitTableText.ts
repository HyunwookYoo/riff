import { rangeLabel, type ToolbarPair } from "./rangeText";
import type { Commit, ContainmentDetail, RepoRange, SquashCheck } from "./types";

/// How a range's two sides are named (see rangeText.sideNames).
export type SideNames = ToolbarPair;

/// A row's mark: ● not in base, ◐ in base as a patch (also for a commit a
/// squash put in base), ✓ in base by ancestry.
export type RowMark = "out" | "patch" | "squash" | "in";

/// ● / ◐ / behind counts for a group or a total.
export interface Counts {
  out: number;
  patch: number;
  behind: number;
}

/// What a group header can add beyond its counts.
export interface GroupNotes {
  mergedBy: Commit | null | undefined;
  /// The group's squash answer when it put the ● commits in base.
  landed?: SquashCheck | null;
  /// squash_check is still running.
  checking?: boolean;
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
      /// Groups that answered, and how many more could not be read.
      repos: number;
      failed: number;
    }
  | { kind: "patches"; names: SideNames; patch: number }
  | { kind: "squash"; names: SideNames; commit: Commit }
  | { kind: "content"; names: SideNames }
  | { kind: "no-net-change"; names: SideNames }
  // mergedBy: the merge commit, null for a fast-forward, undefined when the
  // lookup failed (says nothing about how it got in).
  | { kind: "merged"; names: SideNames; mergedBy: Commit | null | undefined }
  | { kind: "all-in"; names: SideNames; repos: number; failed: number };

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
      if (s.failed > 0) parts.push(failedText(s.failed));
      return `${head} ${parts.join(" · ")}`;
    }
    case "patches":
      return `✓ Every commit on ${s.names.compare} is in ${s.names.base}, ${s.patch} of them as ${s.patch === 1 ? "a patch" : "patches"} (rebased, cherry-picked or squash-merged)`;
    case "squash":
      return `✓ All changes on ${s.names.compare} are in ${s.names.base} — squash-merged as ${s.commit.short_sha} "${s.commit.summary}" · ${shortDate(s.commit.time)}`;
    case "content":
      return `✓ All changes on ${s.names.compare} are already in ${s.names.base} (content matches; no single squash commit found)`;
    case "no-net-change":
      return `${s.names.compare} makes no net change against ${s.names.base}`;
    case "merged": {
      const all = `✓ All commits on ${s.names.compare} are in ${s.names.base}`;
      if (s.mergedBy) {
        return `${all} — merged by ${s.mergedBy.short_sha} "${s.mergedBy.summary}" · ${shortDate(s.mergedBy.time)}`;
      }
      return s.mergedBy === null ? `${all} (fast-forward, no merge commit)` : all;
    }
    case "all-in": {
      const all = `✓ All changes on ${s.names.compare} are in ${s.names.base} across ${s.repos} repo${s.repos === 1 ? "" : "s"}`;
      return s.failed > 0 ? `${all} · ${failedText(s.failed)}` : all;
    }
  }
}

function failedText(n: number): string {
  return `${n} repo${n === 1 ? "" : "s"} couldn't be read`;
}

/// The summary line while no visible repo has a group. A toolbar pair that
/// misses a side still asks for refs; otherwise `first`, the first visible
/// repo's range, says why it has none (an unmoved pin, an added submodule, …)
/// — or, having resolved, is only waiting for its group.
export function noGroupSummaryText(
  pair: ToolbarPair,
  first: RepoRange | undefined,
  superName: string,
): string {
  if (!pair.base || !pair.compare) return summaryText({ kind: "no-refs" });
  if (first && !first.ok) return rangeLabel(first, superName, pair);
  return summaryText({ kind: "loading" });
}

/// The counts on a group header.
export function groupCountsText(c: Counts, names: SideNames, n: GroupNotes): string {
  let text: string;
  if (n.landed) {
    text =
      n.landed.verdict === "squash" && n.landed.squash_commit
        ? `◐ ${c.patch} · squash-merged as ${n.landed.squash_commit.short_sha}`
        : `◐ ${c.patch} · content already in ${names.base}`;
  } else if (c.out === 0 && c.patch === 0) {
    text = n.mergedBy
      ? `✓ all in ${names.base} · merged by ${n.mergedBy.short_sha}`
      : `✓ all in ${names.base}`;
  } else {
    const parts: string[] = [];
    if (c.out > 0) parts.push(`● ${c.out}`);
    if (c.patch > 0) parts.push(`◐ ${c.patch}`);
    text = parts.join(" ");
    if (c.behind > 0) text += ` · ${names.compare} is ${c.behind} behind`;
  }
  return n.checking ? `${text} · checking for squash…` : text;
}

/// A row's status column. `landed` is the group's squash answer.
export function statusText(
  mark: RowMark,
  names: SideNames,
  landed: SquashCheck | null = null,
): string {
  switch (mark) {
    case "out":
      return `not in ${names.base}`;
    case "patch":
      return "applied as patch";
    case "squash":
      return landed?.squash_commit
        ? `squashed into ${landed.squash_commit.short_sha}`
        : `changes already in ${names.base}`;
    case "in":
      return `in ${names.base}`;
  }
}

/// The Files header's account of the picked commit. A ✓ row is only outside
/// the group's ● / ◐ sets, so how it stands against base comes from its
/// detail; null (no account) until that is looked up.
export function commitStateText(
  mark: RowMark,
  names: SideNames,
  detail: ContainmentDetail | null,
  landed: SquashCheck | null = null,
): string | null {
  switch (mark) {
    case "out":
      return `not in ${names.base}`;
    case "patch":
      return `applied to ${names.base} as a patch`;
    case "squash": {
      const s = landed?.squash_commit;
      return s
        ? `squashed into ${names.base} as ${s.short_sha} (${shortDate(s.time)})`
        : `its changes are already in ${names.base}`;
    }
    case "in": {
      const m = detail?.introduced_by;
      if (m) return `merged by ${m.short_sha} (${shortDate(m.time)})`;
      if (!detail) return null;
      return detail.in_target ? `in ${names.base}` : `not in ${names.base}`;
    }
  }
}

/// The Files header while nothing is picked; says so when a squash (or a
/// content match) already put every change in base.
export function allChangesText(
  names: SideNames,
  landed: SquashCheck | null = null,
): string {
  const line = `All changes · ${names.base} ← ${names.compare}`;
  if (!landed) return line;
  return landed.squash_commit
    ? `${line} — already in ${names.base} (squash-merged as ${landed.squash_commit.short_sha})`
    : `${line} — already in ${names.base}`;
}
