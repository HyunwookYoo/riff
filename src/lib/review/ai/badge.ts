import { aiKey } from "./aiStore";
import { choiceLabel } from "./modelChoice";
import { hasReview } from "./rereview";
import type { AiJobState, AiResult, RobloxParity } from "./types";

export type AiBadgeKind = "none" | "queued" | "running" | "ready" | "stale" | "failed";

export function aiBadge(
  job: AiJobState | undefined,
  result: AiResult | null | undefined,
  headSha: string,
  nowMs: number,
): { text: string; kind: AiBadgeKind } {
  if (job?.kind === "queued") return { text: "queued", kind: "queued" };
  if (job?.kind === "running") {
    const s = Math.max(0, Math.floor((nowMs - job.startedAt) / 1000));
    return { text: `analysing ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`, kind: "running" };
  }
  // A failed re-run doesn't hide a result that is still current; PrList's
  // tooltip still shows the failure.
  if (job?.kind === "failed" && result?.headSha !== headSha) return { text: "AI failed", kind: "failed" };
  if (!result || !hasReview(result)) return { text: "", kind: "none" };
  if (result.headSha !== headSha) return { text: "PR updated · re-analyse", kind: "stale" };
  const open = result.findings.filter((f) => f.status === "confirmed" && !result.handled[f.id]).length;
  return { text: `AI ready · ⚠${open}`, kind: "ready" };
}

/** The AI badge's tooltip: why the last run failed, else what the shown review ran with. */
export function aiBadgeTitle(job: AiJobState | undefined, result: AiResult | null | undefined): string | undefined {
  if (job?.kind === "failed") return aiErrorText(job.message);
  if (job?.kind === "queued" || job?.kind === "running") return undefined;
  if (result && hasReview(result)) return `AI review ran with ${choiceLabel(result)}${robloxNote(result.roblox)}`;
  return undefined;
}

function robloxNote(p: RobloxParity | undefined): string {
  if (!p) return "";
  return "skipped" in p ? ` · Roblox parity skipped: ${p.skipped}` : ` · Roblox docs ${p.docsDate.slice(0, 10)}`;
}

/** The Re-review button's text; `busy` = a click cancels, `title` = why the last run failed. */
export function rereviewButtonState(
  job: AiJobState | undefined,
  nowMs: number,
): { text: string; busy: boolean; title?: string } {
  if (job?.kind === "queued") return { text: "re-review queued", busy: true };
  if (job?.kind === "running") {
    const s = Math.max(0, Math.floor((nowMs - job.startedAt) / 1000));
    return { text: `re-reviewing ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`, busy: true };
  }
  if (job?.kind === "failed") return { text: "re-review failed", busy: false, title: aiErrorText(job.message) };
  return { text: "Re-review", busy: false };
}

export function aiErrorText(message: string): string {
  const m = message.trim();
  if (m.startsWith("ai-malformed")) return "The AI returned an unexpected answer — try again.";
  return m.slice(0, 200);
}

/** A result is loaded at most once concurrently, and never when already known. */
export function shouldLoad(key: string, results: Record<string, unknown>, inFlight: Set<string>): boolean {
  return !(key in results) && !inFlight.has(key);
}

/**
 * Of `keys` to load (see `shouldLoad`): those with an AI result in the review store
 * (`stored`: its keys) to load, and those known to have none.
 */
export function planLoads(
  keys: string[],
  results: Record<string, unknown>,
  inFlight: Set<string>,
  stored: Set<string>,
): { load: string[]; none: string[] } {
  const out: { load: string[]; none: string[] } = { load: [], none: [] };
  for (const k of keys) {
    if (shouldLoad(k, results, inFlight)) (stored.has(aiKey(k)) ? out.load : out.none).push(k);
  }
  return out;
}
