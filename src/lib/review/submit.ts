import type { PrRecord } from "./types";
import { submittable } from "./draft";
import { createPendingReview, addThread, addReply, submitReview, deletePendingReview } from "./github";

export type PendingChoice = "add" | "discard";
export type SubmitBlock = "not-seen" | "empty" | null;

export function submitBlock(r: PrRecord, headSha: string): SubmitBlock {
  if (r.viewedHead !== headSha) return "not-seen";
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
  existingPendingId: string | null; choice: PendingChoice | null;
}): Promise<PrRecord> {
  const { host, prNodeId, headSha, record, existingPendingId, choice } = args;
  const block = submitBlock(record, headSha);
  if (block) throw new Error(`submit-blocked:${block}`);
  if (existingPendingId && !choice) throw new Error("pending-review-exists");

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
  try {
    for (const it of items) {
      const t = it.target;
      if (t.kind === "line") {
        await addThread(host, reviewId, {
          path: t.path, body: it.body, subjectType: "LINE", side: t.side, line: t.line,
          ...(t.startLine !== null ? { startLine: t.startLine, startSide: t.side } : {}),
        });
      } else if (t.kind === "file") {
        await addThread(host, reviewId, { path: t.path, body: it.body, subjectType: "FILE" });
      }
    }
    for (const it of items) {
      if (it.target.kind === "reply") await addReply(host, reviewId, it.target.threadId, it.body);
    }
    await submitReview(host, reviewId, record.event, buildBody(record));
  } catch (e) {
    if (created) {
      try { await deletePendingReview(host, reviewId); } catch { /* best effort */ }
    }
    throw e;
  }

  const sent = new Set(items.map((i) => i.id));
  return { ...record, items: record.items.filter((i) => !sent.has(i.id)), body: "", event: "COMMENT" };
}
