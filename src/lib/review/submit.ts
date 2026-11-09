import type { PrRecord } from "./types";
import { submittable } from "./draft";
import { createPendingReview, addThread, addReply, submitReview, deletePendingReview } from "./github";

export type PendingChoice = "add" | "discard";
export type SubmitBlock = "not-seen" | "empty" | null;

export function submitBlock(r: PrRecord, headSha: string): SubmitBlock {
  if (r.viewedHead !== headSha) return "not-seen";
  if (r.anchorHead !== headSha && submittable(r).some((i) => i.target.kind === "line")) return "not-seen";
  if (submittable(r).length === 0 && r.body.trim() === "" && r.event === "COMMENT") return "empty";
  return null;
}

export function buildBody(r: PrRecord): string {
  let out = r.body;
  for (const it of submittable(r)) {
    if (it.target.kind === "body") out += `\n\n---\n**${it.target.location}**\n\n${it.body}`;
  }
  return out;
}

export async function submit(args: {
  host: string; prNodeId: string; headSha: string; record: PrRecord;
  existingPendingId: string | null; existingPendingCommit: string | null; choice: PendingChoice | null;
}): Promise<PrRecord> {
  const { host, prNodeId, headSha, record, existingPendingId, existingPendingCommit, choice } = args;
  const block = submitBlock(record, headSha);
  if (block) throw new Error(`submit-blocked:${block}`);
  if (existingPendingId && !choice) throw new Error("pending-review-exists");

  if (existingPendingId && choice === "add" && existingPendingCommit !== headSha) {
    throw new Error("pending-review-stale");
  }

  let reviewId: string;
  let created = false;
  if (existingPendingId && choice === "add") {
    reviewId = existingPendingId;
  } else {
    if (existingPendingId) await deletePendingReview(host, existingPendingId);
    reviewId = await createPendingReview(host, prNodeId, headSha);
    created = true;
  }

  const items = submittable(record);
  let posted = false;
  try {
    for (const it of items) {
      const t = it.target;
      if (t.kind === "line") {
        await addThread(host, reviewId, {
          path: t.path, body: it.body, subjectType: "LINE", side: t.side, line: t.line,
          ...(t.startLine !== null ? { startLine: t.startLine, startSide: t.side } : {}),
        });
        posted = true;
      } else if (t.kind === "file") {
        await addThread(host, reviewId, { path: t.path, body: `**${t.location}**\n\n${it.body}`, subjectType: "FILE" });
        posted = true;
      }
    }
    for (const it of items) {
      if (it.target.kind === "reply") {
        await addReply(host, reviewId, it.target.threadId, it.body);
        posted = true;
      }
    }
    await submitReview(host, reviewId, record.event, buildBody(record));
  } catch (e) {
    if (created) {
      try { await deletePendingReview(host, reviewId); } catch { /* best effort */ }
    }
    if (!created && posted) {
      throw new Error("partial-add: " + (e instanceof Error ? e.message : String(e)));
    }
    throw e;
  }

  return removeSubmitted(record, items.map((i) => i.id));
}

/** The record after a submit: `sentIds` gone, body and event reset; apply it to the CURRENT record. */
export function removeSubmitted(r: PrRecord, sentIds: string[]): PrRecord {
  const sent = new Set(sentIds);
  return { ...r, items: r.items.filter((i) => !sent.has(i.id)), body: "", event: "COMMENT" };
}

/** Choices for an existing GitHub pending review; "add" only if it is pinned to `headSha`. */
export function pendingChoices(
  pendingId: string | null,
  pendingCommit: string | null,
  headSha: string,
): PendingChoice[] | null {
  if (!pendingId) return null;
  return pendingCommit === headSha ? ["add", "discard"] : ["discard"];
}

export function submitErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg === "submit-blocked:not-seen") return "New commits since you looked: review them first";
  if (msg === "submit-blocked:empty") return "Nothing to submit";
  if (msg === "pending-review-stale") {
    return "Your pending review on GitHub is pinned to an older commit; submit again and choose Discard.";
  }
  if (msg === "unreadable-review-record") return "This PR's saved draft can't be read; nothing was submitted.";
  if (msg.startsWith("partial-add: ")) {
    return "Some comments may already be in your pending review on GitHub. Your draft is unchanged; "
      + `submit again and choose Discard to start a fresh review. (${msg.slice("partial-add: ".length)})`;
  }
  return `Submit failed: ${msg}`;
}
