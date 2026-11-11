import type { ApiDoc } from "../../types";
import type { GhRepo } from "../types";
import type { AiEvidence, AiFinding } from "./types";

/**
 * The Roblox parity setting's key for `repo`: `host/owner/name`, lowercased because GitHub
 * names are case-insensitive and the stored list is compared exactly.
 */
export const repoKey = (repo: GhRepo): string => `${repo.host}/${repo.owner}/${repo.name}`.toLowerCase();

/** Evidence paths that cite a Roblox reference file: `roblox:<kind>/<Name>.yaml`. */
export const ROBLOX_PREFIX = "roblox:";

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * Whether some `roblox:` evidence of `c` names a file of `docs` and quotes it (whitespace
 * collapsed on both sides). riff gave the AI those files, so a quote not in them is made up.
 */
export function checkRobloxEvidence(c: { evidence: AiEvidence[] }, docs: ApiDoc[]): boolean {
  return c.evidence.some((e) => {
    if (!e.path.startsWith(ROBLOX_PREFIX)) return false;
    const doc = docs.find((d) => ROBLOX_PREFIX + d.path === e.path);
    const quote = collapse(e.quote);
    return !!doc && quote !== "" && collapse(doc.text).includes(quote);
  });
}

/** The find answer's `robloxApis`: trimmed, distinct, non-empty names; [] when absent. */
export function robloxApisOf(raw: unknown): string[] {
  const list = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).robloxApis : undefined;
  if (!Array.isArray(list)) return [];
  const names = list.filter((n): n is string => typeof n === "string").map((n) => n.trim()).filter((n) => n !== "");
  return [...new Set(names)];
}

/** The files of `docs` that the evidence of `cands` cites. */
export function citedDocs(cands: { evidence: AiEvidence[] }[], docs: ApiDoc[]): ApiDoc[] {
  const cited = new Set(cands.flatMap((c) => c.evidence.map((e) => e.path)));
  return docs.filter((d) => cited.has(ROBLOX_PREFIX + d.path));
}

/** After verify: a Roblox finding with no checked quote from `docs` is shown only as unconfirmed. */
export function downgradeUnchecked(findings: AiFinding[], docs: ApiDoc[]): AiFinding[] {
  return findings.map((f) =>
    f.tag === "roblox" && f.status === "confirmed" && !checkRobloxEvidence(f, docs) ? { ...f, status: "unconfirmed" as const } : f);
}

/** The parity list after `setRobloxParity(key, on)` succeeded; mirrors the store (drop, then append when on). */
export function withParity(list: string[], key: string, on: boolean): string[] {
  const rest = list.filter((r) => r !== key);
  return on ? [...rest, key] : rest;
}

/** The AI settings' Roblox docs row: the local copy's date, or "not downloaded". */
export const docsDateLabel = (info: { date: string } | null): string => (info ? info.date.slice(0, 10) : "not downloaded");
