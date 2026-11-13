import { repoKey } from "./ai/roblox";
import type { PrSummary } from "./types";

/**
 * The PR list's filter. `author`: a login, or `ME` for the viewer's own PRs. `repo`: a
 * `repoKey` (lowercased `host/owner/name`). An author or repo no longer listed keeps
 * filtering; the options below keep it selectable at 0 so it can be cleared.
 */
export type PrFilter = { show: "all" | "mine"; author: string | null; repo: string | null };

export const ME = "@me";

export const DEFAULT_FILTER: Readonly<PrFilter> = { show: "all", author: null, repo: null };

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Digits with an optional leading `#`: a PR number prefix rather than title text. */
export const isNumberQuery = (q: string): boolean => /^#?\d+$/.test(q.trim());

/** Number query: number prefix. Otherwise a case-insensitive title substring. Blank: everything. */
export function matchQuery(p: Pick<PrSummary, "number" | "title">, q: string): boolean {
  const t = q.trim();
  if (!t) return true;
  if (isNumberQuery(t)) return String(p.number).startsWith(t.replace(/^#/, ""));
  return new RegExp(escapeRe(t), "iu").test(p.title);
}

const byUpdatedDesc = (a: PrSummary, b: PrSummary): number =>
  a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;

export interface FilterResult {
  /** In display order: All by updatedAt desc; For me requested, then reviewed. */
  list: PrSummary[];
  /** For me only (null for All): `list` split, each by updatedAt desc. */
  sections: { requested: PrSummary[]; reviewed: PrSummary[] } | null;
  /** The All / For me counts under author, repo and query (not show). */
  counts: { all: number; mine: number };
  /** Every listed PR, unfiltered. */
  total: number;
}

export function applyFilter(prs: PrSummary[], f: PrFilter, q: string): FilterResult {
  const base = prs
    .filter(
      (p) =>
        (f.author === null || p.author === (f.author === ME ? p.viewer : f.author)) &&
        (f.repo === null || repoKey(p.repo) === f.repo) &&
        matchQuery(p, q),
    )
    .sort(byUpdatedDesc);
  const counts = { all: base.length, mine: base.filter((p) => p.mine !== null).length };
  if (f.show === "all") return { list: base, sections: null, counts, total: prs.length };
  const requested = base.filter((p) => p.mine === "requested");
  const reviewed = base.filter((p) => p.mine === "reviewed");
  return { list: [...requested, ...reviewed], sections: { requested, reviewed }, counts, total: prs.length };
}

/** Whether anything hides PRs: drives "N of M" and Clear filters. */
export const filterActive = (f: PrFilter, q: string): boolean =>
  f.show !== "all" || f.author !== null || f.repo !== null || q.trim() !== "";

/** Authors other than the viewer, by count desc then name; `selected` kept at 0 when unlisted. */
export function authorOptions(
  prs: PrSummary[],
  selected: string | null,
): { meCount: number; authors: { login: string; count: number }[] } {
  let meCount = 0;
  const counts = new Map<string, number>();
  for (const p of prs) {
    if (p.author === p.viewer) meCount++;
    else counts.set(p.author, (counts.get(p.author) ?? 0) + 1);
  }
  const authors = [...counts]
    .map(([login, count]) => ({ login, count }))
    .sort((a, b) => b.count - a.count || a.login.localeCompare(b.login));
  if (selected !== null && selected !== ME && !counts.has(selected)) authors.push({ login: selected, count: 0 });
  return { meCount, authors };
}

/** Listed repos by label (`owner/name`); `selected` kept at 0 when unlisted. The filter shows from two. */
export function repoOptions(
  prs: PrSummary[],
  selected: string | null,
): { repos: { key: string; label: string; count: number }[]; showRepoFilter: boolean } {
  const byKey = new Map<string, { key: string; label: string; count: number }>();
  for (const p of prs) {
    const key = repoKey(p.repo);
    const o = byKey.get(key) ?? { key, label: `${p.repo.owner}/${p.repo.name}`, count: 0 };
    o.count++;
    byKey.set(key, o);
  }
  if (selected !== null && !byKey.has(selected)) {
    byKey.set(selected, { key: selected, label: selected.slice(selected.indexOf("/") + 1), count: 0 });
  }
  const repos = [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
  return { repos, showRepoFilter: repos.length >= 2 };
}

/** `title` split at the text query's matches (none for a number query), for the UI to mark. */
export function highlight(title: string, q: string): { text: string; hit: boolean }[] {
  const t = q.trim();
  if (!t || isNumberQuery(t)) return [{ text: title, hit: false }];
  const out: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const m of title.matchAll(new RegExp(escapeRe(t), "giu"))) {
    if (m.index > at) out.push({ text: title.slice(at, m.index), hit: false });
    out.push({ text: m[0], hit: true });
    at = m.index + m[0].length;
  }
  if (at < title.length) out.push({ text: title.slice(at), hit: false });
  return out.length ? out : [{ text: title, hit: false }];
}

const nonEmpty = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** The stored filter (PersistedState.pr_list_filter), each invalid or missing field at its default. */
export function normalizeFilter(raw: unknown): PrFilter {
  const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return { show: r.show === "mine" ? "mine" : "all", author: nonEmpty(r.author), repo: nonEmpty(r.repo) };
}
