import type { PrSummary, ReviewThread } from "../types";
import { NO_ANSWER, type AiResult, type ThreadVerdict, type Verdict } from "./types";

/** The head moved since my last submitted review, and threads I started are still open. */
export function rereviewAvailable(pr: PrSummary, threads: ReviewThread[], login: string): boolean {
  return pr.myLastReviewSha !== null && pr.myLastReviewSha !== pr.headSha
    && threads.some((t) => !t.isResolved && t.comments[0]?.author === login);
}

const VERDICT_LABELS: Record<Verdict, { text: string; tone: "ok" | "warn" | "muted" }> = {
  addressed: { text: "✓ Addressed", tone: "ok" },
  not_addressed: { text: "✗ Not addressed", tone: "warn" },
  unclear: { text: "? Unclear", tone: "muted" },
};

/** `stale`: the verdict was made for a head other than the one displayed. */
export function verdictLabel(v: ThreadVerdict | undefined, stale: boolean): { text: string; tone: "ok" | "warn" | "muted" } | null {
  if (!v) return null;
  const l = VERDICT_LABELS[v.verdict];
  const text = `${l.text}${v.reason === NO_ANSWER ? " (no answer)" : ""}${stale ? " (other commit)" : ""}`;
  return { ...l, text };
}

/** False for a record holding only thread state (created by a re-review or a thread check before any AI review ran). */
export function hasReview(r: AiResult): boolean {
  return r.headSha !== "";
}
