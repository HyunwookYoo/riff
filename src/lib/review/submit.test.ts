import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DraftItem, PrRecord } from "./types";

vi.mock("./github", () => ({
  createPendingReview: vi.fn(),
  addThread: vi.fn(),
  addReply: vi.fn(),
  submitReview: vi.fn(),
  deletePendingReview: vi.fn(),
}));
import * as gh from "./github";
import { submit, submitBlock, buildBody, removeSubmitted, pendingChoices, submitErrorMessage } from "./submit";

const H = "head1";
const item = (id: string, target: DraftItem["target"], unplaced = false): DraftItem =>
  ({ id, target, body: `b-${id}`, origin: "mine", unplaced });
const line = (id: string, startLine: number | null = null, unplaced = false) =>
  item(id, { kind: "line", path: "a.ts", side: "RIGHT", line: 5, startLine, quote: [] }, unplaced);
const rec = (items: DraftItem[], over: Partial<PrRecord> = {}): PrRecord => ({
  version: 1, key: "h/o/r#1", items, body: "", event: "COMMENT", anchorHead: H, viewedHead: H, ...over,
});
const args = (record: PrRecord, over = {}) => ({
  host: "h", prNodeId: "PR1", headSha: H, record, existingPendingId: null, existingPendingCommit: null,
  choice: null, ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(gh.createPendingReview).mockResolvedValue("rev1");
});

describe("submitBlock", () => {
  it("blocks when latest head not seen", () => {
    expect(submitBlock(rec([line("1")], { viewedHead: "old" }), H)).toBe("not-seen");
    expect(submitBlock(rec([line("1")], { viewedHead: null }), H)).toBe("not-seen");
  });
  it("blocks when anchors belong to an older head", () => {
    expect(submitBlock(rec([line("1")], { anchorHead: "old" }), H)).toBe("not-seen");
    expect(submitBlock(rec([line("1")], { anchorHead: null }), H)).toBe("not-seen");
    expect(submitBlock(rec([line("1", null, true)], { anchorHead: "old" }), H)).toBe("empty");
    expect(submitBlock(rec([item("f", { kind: "file", path: "x", location: "L" })], { anchorHead: "old" }), H)).toBeNull();
  });
  it("blocks empty COMMENT", () => {
    expect(submitBlock(rec([]), H)).toBe("empty");
    expect(submitBlock(rec([line("1", null, true)], { body: "  " }), H)).toBe("empty");
    expect(submitBlock(rec([], { event: "APPROVE" }), H)).toBeNull();
    expect(submitBlock(rec([], { body: "hi" }), H)).toBeNull();
    expect(submitBlock(rec([line("1")]), H)).toBeNull();
  });
});

describe("buildBody", () => {
  it("body items are appended to the review body", () => {
    const r = rec([item("1", { kind: "body", location: "Loc" })], { body: "top" });
    expect(buildBody(r)).toBe("top\n\n---\n**Loc**\n\nb-1");
  });
});

describe("submit", () => {
  it("submits threads, replies and body in order pinned to headSha", async () => {
    const calls: string[] = [];
    vi.mocked(gh.addThread).mockImplementation(async () => { calls.push("thread"); });
    vi.mocked(gh.addReply).mockImplementation(async () => { calls.push("reply"); });
    vi.mocked(gh.submitReview).mockImplementation(async () => { calls.push("submit"); });
    const r = rec([
      item("r", { kind: "reply", threadId: "T1", preview: "" }),
      line("1"), line("2", 3),
    ], { body: "top", event: "APPROVE" });
    const before = JSON.stringify(r);
    const out = await submit(args(r));
    expect(gh.createPendingReview).toHaveBeenCalledWith("h", "PR1", H);
    expect(calls).toEqual(["thread", "thread", "reply", "submit"]);
    expect(gh.addThread).toHaveBeenNthCalledWith(1, "h", "rev1",
      { path: "a.ts", body: "b-1", subjectType: "LINE", side: "RIGHT", line: 5 });
    expect(gh.addThread).toHaveBeenNthCalledWith(2, "h", "rev1",
      { path: "a.ts", body: "b-2", subjectType: "LINE", side: "RIGHT", line: 5, startLine: 3, startSide: "RIGHT" });
    expect(gh.addReply).toHaveBeenCalledWith("h", "rev1", "T1", "b-r");
    expect(gh.submitReview).toHaveBeenCalledWith("h", "rev1", "APPROVE", "top");
    expect(JSON.stringify(r)).toBe(before);
    expect(out.items).toEqual([]);
    expect(out.body).toBe("");
    expect(out.event).toBe("COMMENT");
  });

  it("file items go as FILE threads", async () => {
    await submit(args(rec([item("f", { kind: "file", path: "x.ts", location: "L" })])));
    expect(gh.addThread).toHaveBeenCalledWith("h", "rev1", { path: "x.ts", body: "b-f", subjectType: "FILE" });
  });

  it("keeps unplaced items after submit", async () => {
    const out = await submit(args(rec([line("1"), line("2", null, true)])));
    expect(out.items.map((i) => i.id)).toEqual(["2"]);
    expect(gh.addThread).toHaveBeenCalledTimes(1);
  });

  it("throws when blocked", async () => {
    await expect(submit(args(rec([line("1")], { viewedHead: "old" })))).rejects.toThrow();
    expect(gh.createPendingReview).not.toHaveBeenCalled();
  });

  it("deletes own pending review on failure", async () => {
    vi.mocked(gh.addThread).mockResolvedValueOnce().mockRejectedValueOnce(new Error("boom"));
    await expect(submit(args(rec([line("1"), line("2")])))).rejects.toThrow("boom");
    expect(gh.deletePendingReview).toHaveBeenCalledWith("h", "rev1");
    expect(gh.submitReview).not.toHaveBeenCalled();
  });

  it("existing pending review requires a choice", async () => {
    await expect(submit(args(rec([line("1")]), { existingPendingId: "old" })))
      .rejects.toThrow("pending-review-exists");
    expect(gh.createPendingReview).not.toHaveBeenCalled();
  });

  it("existing pending review with add reuses it and never deletes it on failure", async () => {
    vi.mocked(gh.addThread).mockRejectedValueOnce(new Error("boom"));
    await expect(submit(args(rec([line("1")]), { existingPendingId: "old", existingPendingCommit: H, choice: "add" })))
      .rejects.toThrow("boom");
    expect(gh.createPendingReview).not.toHaveBeenCalled();
    expect(gh.deletePendingReview).not.toHaveBeenCalled();
    expect(gh.addThread).toHaveBeenCalledWith("h", "old", expect.anything());
  });

  it("existing pending review with discard deletes it first", async () => {
    const calls: string[] = [];
    vi.mocked(gh.deletePendingReview).mockImplementation(async () => { calls.push("delete"); });
    vi.mocked(gh.createPendingReview).mockImplementation(async () => { calls.push("create"); return "rev1"; });
    await submit(args(rec([line("1")]), { existingPendingId: "old", choice: "discard" }));
    expect(calls).toEqual(["delete", "create"]);
    expect(gh.deletePendingReview).toHaveBeenCalledWith("h", "old");
  });

  it("add refuses a pending review pinned to another commit", async () => {
    await expect(submit(args(rec([line("1")]), { existingPendingId: "old", existingPendingCommit: "older", choice: "add" })))
      .rejects.toThrow("pending-review-stale");
    expect(gh.addThread).not.toHaveBeenCalled();
    expect(gh.deletePendingReview).not.toHaveBeenCalled();
  });

  it("add failure after a posted thread reports partial-add", async () => {
    vi.mocked(gh.addThread).mockResolvedValueOnce().mockRejectedValueOnce(new Error("boom"));
    await expect(submit(args(rec([line("1"), line("2")]), { existingPendingId: "old", existingPendingCommit: H, choice: "add" })))
      .rejects.toThrow("partial-add: boom");
    expect(gh.deletePendingReview).not.toHaveBeenCalled();
  });

  it("add failure before any posted thread rethrows original", async () => {
    vi.mocked(gh.addThread).mockRejectedValueOnce(new Error("boom"));
    await expect(submit(args(rec([line("1")]), { existingPendingId: "old", existingPendingCommit: H, choice: "add" })))
      .rejects.toThrow(/^boom$/);
  });

  it("add with body-only items rethrows the original error when submitReview fails", async () => {
    vi.mocked(gh.submitReview).mockRejectedValueOnce(new Error("boom"));
    const r = rec([item("b", { kind: "body", location: "L" })]);
    await expect(submit(args(r, { existingPendingId: "old", existingPendingCommit: H, choice: "add" })))
      .rejects.toThrow(/^boom$/);
  });
});

describe("removeSubmitted", () => {
  it("drops exactly the sent ids from the current record and resets body and event", () => {
    // Current record = a later state than the submit snapshot: "3" was added and "2" edited meanwhile.
    const cur = rec([line("1"), { ...line("2"), body: "edited" }, line("3"), line("u", null, true)], {
      body: "summary", event: "APPROVE",
    });
    const out = removeSubmitted(cur, ["1", "2"]);
    expect(out.items.map((i) => i.id)).toEqual(["3", "u"]);
    expect(out.body).toBe("");
    expect(out.event).toBe("COMMENT");
    expect(out.viewedHead).toBe(H);
    expect(out.anchorHead).toBe(H);
  });

  it("ignores sent ids the current record no longer has", () => {
    expect(removeSubmitted(rec([line("1")]), ["gone"]).items.map((i) => i.id)).toEqual(["1"]);
  });
});

describe("pendingChoices", () => {
  it("is null without a pending review", () => {
    expect(pendingChoices(null, null, H)).toBeNull();
  });
  it("offers add and discard when the pending review is on the head", () => {
    expect(pendingChoices("p", H, H)).toEqual(["add", "discard"]);
  });
  it("offers only discard when the pending review is pinned to another commit", () => {
    expect(pendingChoices("p", "older", H)).toEqual(["discard"]);
    expect(pendingChoices("p", null, H)).toEqual(["discard"]);
  });
});

describe("submitErrorMessage", () => {
  it("explains a partial add and suggests Discard", () => {
    const msg = submitErrorMessage(new Error("partial-add: boom"));
    expect(msg).toContain("may already be in your pending review on GitHub");
    expect(msg).toContain("Discard");
    expect(msg).toContain("boom");
  });
  it("names the known failures", () => {
    expect(submitErrorMessage(new Error("submit-blocked:not-seen"))).toContain("New commits since you looked");
    expect(submitErrorMessage(new Error("submit-blocked:empty"))).toBe("Nothing to submit");
    expect(submitErrorMessage(new Error("pending-review-stale"))).toContain("older commit");
    expect(submitErrorMessage(new Error("unreadable-review-record"))).toContain("can't be read");
  });
  it("passes other errors through", () => {
    expect(submitErrorMessage("gh: 502")).toBe("Submit failed: gh: 502");
  });
});
