import type { DiffMode, RepoRange } from "./types";

/// The toolbar's pair: the super repo's base and compare refs.
export interface ToolbarPair {
  base: string;
  compare: string;
}

/// Shorten a full or long hex SHA to git's 7 characters, keeping any revision
/// suffix (`^`, `~2`) so a drill-in's `<sha>^` reads `a41f2c9^`. Names pass
/// through unchanged.
export function shortRef(ref: string): string {
  const m = /^([0-9a-f]{12,40})([\^~].*)?$/i.exec(ref);
  return m ? m[1].slice(0, 7) + (m[2] ?? "") : ref;
}

/// `base ← compare`, the notation every range uses (compare merges into base).
export function pairLabel(base: string, compare: string): string {
  return `${shortRef(base)} ← ${shortRef(compare)}`;
}

/// The two sides of an ok range as every string names them: the refs
/// themselves, or for a gitlink range the pins, named after the super refs
/// that set them.
export function sideNames(
  range: Extract<RepoRange, { ok: true }>,
  pair: ToolbarPair,
): ToolbarPair {
  if (range.source === "gitlink") {
    return {
      base: `${shortRef(pair.base)}'s pin`,
      compare: `${shortRef(pair.compare)}'s pin`,
    };
  }
  return { base: shortRef(range.base), compare: shortRef(range.compare) };
}

/// The sides of a "missing" gap, base first: each ref the repo's clone lacks,
/// shortened, with the toolbar ref (shortened) that picked that side.
function missingSides(
  range: Extract<RepoRange, { ok: false }>,
  pair: ToolbarPair,
): { ref: string; picked: string }[] {
  const { base, compare } = range.missing ?? {};
  const sides = [];
  if (base) sides.push({ ref: shortRef(base), picked: shortRef(pair.base) });
  if (compare) sides.push({ ref: shortRef(compare), picked: shortRef(pair.compare) });
  return sides;
}

/// The range line of a repo's group header, shared by the commit table and
/// the file list. `superName` is the super repo's display name.
export function rangeLabel(
  range: RepoRange,
  superName: string,
  pair: ToolbarPair,
): string {
  if (range.ok) {
    const r = pairLabel(range.base, range.compare);
    switch (range.source) {
      case "toolbar":
        return r;
      case "gitlink":
        return `pinned by ${superName}: ${r}`;
      case "override":
        return `own branches: ${r}`;
      case "same-name":
        return `same names: ${r}`;
    }
  }
  const base = shortRef(pair.base);
  const compare = shortRef(pair.compare);
  switch (range.reason) {
    case "no-refs":
      return "pick both refs";
    case "unchanged":
      return `unchanged: both pin ${shortRef(range.pin ?? "")}`;
    case "added":
      return `only in ${compare} (added)`;
    case "removed":
      return `not in ${compare} (removed)`;
    case "absent":
      return `not in ${base} or ${compare}`;
    case "missing":
      return `not in this clone: ${missingSides(range, pair).map((s) => s.ref).join(" and ")}`;
    case "error":
      return `couldn't resolve: ${range.message ?? "unknown error"}`;
  }
}

/// Hover text for a gitlink range: which super ref pins which commit.
export function rangeTooltip(
  range: RepoRange,
  pair: ToolbarPair,
): string | undefined {
  if (!range.ok || range.source !== "gitlink") return undefined;
  return `${shortRef(pair.base)} pins ${shortRef(range.base)} · ${shortRef(pair.compare)} pins ${shortRef(range.compare)}`;
}

/// `name's`, or `name'` for a name ending in s.
export function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

/// What the scope bar says about the repo on screen: its two sides and where
/// they come from, or why it has none.
export type ScopeLine =
  | { kind: "sides"; base: string; compare: string; why: string }
  | { kind: "note"; text: string };

/// The scope bar's line for `range`, the range of the repo named `repoName`.
/// A gap's sentence is also that repo's tab tooltip.
export function scopeLine(
  range: RepoRange,
  repoName: string,
  superName: string,
  pair: ToolbarPair,
): ScopeLine {
  const base = shortRef(pair.base);
  const compare = shortRef(pair.compare);
  const sup = possessive(superName);
  if (range.ok) {
    const sides = { base: shortRef(range.base), compare: shortRef(range.compare) };
    switch (range.source) {
      case "gitlink":
        return { kind: "sides", ...sides, why: `the commits ${sup} ${base} and ${compare} point to` };
      case "same-name":
        return { kind: "sides", ...sides, why: `same branch names as ${superName}` };
      case "override":
        return { kind: "sides", ...sides, why: `${possessive(repoName)} own branches` };
      case "toolbar":
        return { kind: "sides", ...sides, why: "the toolbar's base and compare" };
    }
  }
  switch (range.reason) {
    case "no-refs":
      return { kind: "note", text: "pick base and compare first" };
    case "unchanged":
      return {
        kind: "note",
        text: `unchanged: ${sup} ${base} and ${compare} point to the same commit ${shortRef(range.pin ?? "")}`,
      };
    case "added":
      return { kind: "note", text: `only in ${compare}: ${sup} ${base} doesn't have ${repoName}` };
    case "removed":
      return { kind: "note", text: `removed in ${compare}: only ${sup} ${base} has ${repoName}` };
    case "absent":
      return { kind: "note", text: `not in ${sup} ${base} or ${compare}` };
    case "missing": {
      const source = range.missing?.source;
      const sides = missingSides(range, pair);
      if (source === "same-name") {
        const refs = sides.map((s) => s.ref).join(" or ");
        return { kind: "note", text: `${repoName} has no ${refs} — pick its own branches` };
      }
      // A pin is a bare SHA: name it after the super ref that set it.
      const names = sides.map((s) =>
        source === "gitlink" ? `${s.ref} (${possessive(s.picked)} pin)` : s.ref,
      );
      const [verb, advice] =
        names.length === 1
          ? ["isn't", "fetch it, or it may"]
          : ["aren't", "fetch them, or they may"];
      return {
        kind: "note",
        text: `${names.join(" and ")} ${verb} in this clone of ${repoName} — ${advice} only exist in another worktree`,
      };
    }
    case "error":
      return { kind: "note", text: `couldn't resolve: ${range.message ?? "unknown error"}` };
  }
}

/// The diff-mode select's option text.
export function diffModeLabel(mode: DiffMode): string {
  return mode === "three-dot" ? "since fork (...)" : "direct (..)";
}

/// A diff mode's short name, for inline notation such as the breadcrumb.
export function diffModeName(mode: DiffMode): string {
  return mode === "three-dot" ? "since fork" : "direct";
}

/// The right side of the diff header: the commit picked in the commit table,
/// else the file's repo range, else nothing.
export function diffRangeText(
  range: RepoRange | undefined,
  drillTarget: string | null,
): string | null {
  if (drillTarget) return `commit ${shortRef(drillTarget)}`;
  if (range?.ok) return pairLabel(range.base, range.compare);
  return null;
}

export interface PaneLabels {
  left: string;
  right: string;
}

/// Labels over the diff's two panes. `drill` is the commit picked in the commit
/// table, when it belongs to the shown file's repo.
export function paneLabels(
  range: RepoRange | undefined,
  pair: ToolbarPair,
  mode: DiffMode,
  drill: { target: string; summary?: string } | null,
): PaneLabels | null {
  if (drill) {
    const sha = shortRef(drill.target);
    return {
      left: `${sha}^ (parent)`,
      right: drill.summary ? `${sha} · ${drill.summary}` : sha,
    };
  }
  if (!range?.ok) return null;
  if (range.source === "gitlink") {
    return {
      left: `base · ${shortRef(range.base)} (${shortRef(pair.base)}'s pin)`,
      right: `compare · ${shortRef(range.compare)} (${shortRef(pair.compare)}'s pin)`,
    };
  }
  const base = shortRef(range.base);
  return {
    left: mode === "three-dot" ? `base · ${base} (merge-base)` : `base · ${base}`,
    right: `compare · ${shortRef(range.compare)}`,
  };
}
