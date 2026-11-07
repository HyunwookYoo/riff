import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DraftItem, PrDetail, PrRecord } from "./types";

vi.mock("./github", () => ({}));
import { runSubmitWith, NOT_OPEN, type SubmitDeps, type SubmitView } from "./submitRun";

const K = "h/o/r#1";
const H = "head1";
const line = (id: string, body = `b-${id}`): DraftItem => ({
  id,
  target: { kind: "line", path: "a.ts", side: "RIGHT", line: 5, startLine: null, quote: [] },
  body,
  origin: "mine",
  unplaced: false,
});
const rec = (items: DraftItem[], over: Partial<PrRecord> = {}): PrRecord => ({
  version: 1, key: K, items, body: "", event: "COMMENT", anchorHead: H, viewedHead: H, ...over,
});
const detail = (over: Partial<PrDetail> = {}): PrDetail => ({
  body: "", headSha: H, baseSha: "base", conversation: [], threads: [],
  pendingReviewId: null, pendingReviewCommit: null, ...over,
});

let view: SubmitView;
let flow: { busy: boolean; error: string | null };
const d = {
  view: vi.fn<SubmitDeps["view"]>(),
  loadRecord: vi.fn<SubmitDeps["loadRecord"]>(),
  saveRecord: vi.fn<SubmitDeps["saveRecord"]>(),
  submit: vi.fn<SubmitDeps["submit"]>(),
  askPending: vi.fn<SubmitDeps["askPending"]>(),
  adopt: vi.fn<SubmitDeps["adopt"]>(),
  reloadDetail: vi.fn<SubmitDeps["reloadDetail"]>(),
  toast: vi.fn<SubmitDeps["toast"]>(),
  prDetail: vi.fn<SubmitDeps["prDetail"]>(),
  adoptDetail: vi.fn<SubmitDeps["adoptDetail"]>(),
  lock: vi.fn<SubmitDeps["lock"]>(),
  unlock: vi.fn<SubmitDeps["unlock"]>(),
};

beforeEach(() => {
  vi.resetAllMocks();
  view = {
    open: true, selectedKey: K, pr: { host: "h", nodeId: "PR1" }, headSha: H,
    detail: detail(), hasRecord: true, headMoved: false, error: null,
  };
  flow = { busy: false, error: null };
  d.view.mockImplementation(() => view);
  d.loadRecord.mockImplementation(async () => rec([line("1")]));
  d.saveRecord.mockResolvedValue(undefined);
  d.submit.mockResolvedValue(rec([]));
  d.askPending.mockResolvedValue(null);
  // GitHub agrees with what is displayed unless a test says otherwise.
  d.prDetail.mockImplementation(async () => view.detail!);
  d.lock.mockResolvedValue(undefined);
  d.unlock.mockResolvedValue(undefined);
});

const run = () => runSubmitWith(flow, d, K, { event: "COMMENT", body: "" });

describe("runSubmitWith", () => {
  it("refuses while busy", async () => {
    flow.busy = true;
    expect(await run()).toMatch(/already running/);
    expect(d.loadRecord).not.toHaveBeenCalled();
    expect(d.submit).not.toHaveBeenCalled();
  });

  it("refuses when the PR isn't open in review mode", async () => {
    view.open = false;
    expect(await run()).toBe(NOT_OPEN);
    view = { ...view, open: true, selectedKey: "other" };
    expect(await run()).toBe(NOT_OPEN);
    expect(d.submit).not.toHaveBeenCalled();
  });

  it("refuses when headMoved is set", async () => {
    view.headMoved = true;
    expect(await run()).toMatch(/New commits since you looked/);
    expect(d.loadRecord).not.toHaveBeenCalled();
    expect(d.submit).not.toHaveBeenCalled();
  });

  it("refuses when the PR head moved since it was opened", async () => {
    const fresh = detail({ headSha: "head2" });
    d.prDetail.mockResolvedValueOnce(fresh);
    const msg = await run();
    expect(msg).toMatch(/New commits were pushed/);
    expect(d.prDetail).toHaveBeenCalledWith("h", "PR1");
    expect(d.adoptDetail).toHaveBeenCalledWith(K, fresh, H);
    expect(d.loadRecord).not.toHaveBeenCalled();
    expect(d.askPending).not.toHaveBeenCalled();
    expect(d.submit).not.toHaveBeenCalled();
    expect(flow.error).toBe(msg);
    expect(d.unlock).toHaveBeenCalledWith(K);
    expect(flow.busy).toBe(false);
  });

  it("uses fresh pending review state", async () => {
    // Opened with no pending review; one was started on the web since.
    view.detail = detail();
    d.prDetail.mockResolvedValueOnce(detail({ pendingReviewId: "P2", pendingReviewCommit: H }));
    d.askPending.mockResolvedValueOnce("add");
    expect(await run()).toBe("Review submitted");
    expect(d.askPending).toHaveBeenCalledWith(["add", "discard"]);
    expect(d.submit.mock.calls[0][0]).toMatchObject({
      existingPendingId: "P2",
      existingPendingCommit: H,
      choice: "add",
    });
  });

  it("locks the draft before reading the snapshot and unlocks after the merge", async () => {
    expect(await run()).toBe("Review submitted");
    expect(d.lock).toHaveBeenCalledWith(K);
    const order = (f: { mock: { invocationCallOrder: number[] } }) => f.mock.invocationCallOrder;
    expect(order(d.lock)[0]).toBeLessThan(order(d.loadRecord)[0]);
    expect(order(d.lock)[0]).toBeLessThan(order(d.prDetail)[0]);
    expect(order(d.unlock)[0]).toBeGreaterThan(order(d.saveRecord)[0]);
    expect(order(d.unlock)[0]).toBeGreaterThan(order(d.adopt)[0]);
    expect(d.unlock).toHaveBeenCalledTimes(1);
  });

  it("unlocks on cancel and on failure", async () => {
    view.detail = detail({ pendingReviewId: "P", pendingReviewCommit: "older" });
    expect(await run()).toMatch(/cancelled/);
    expect(d.unlock).toHaveBeenCalledTimes(1);
    view.detail = detail();
    d.submit.mockRejectedValueOnce(new Error("boom"));
    await run();
    expect(d.unlock).toHaveBeenCalledTimes(2);
    expect(flow.busy).toBe(false);
  });

  it("removes the snapshot's submitted ids from the re-loaded current record (edits made meanwhile survive)", async () => {
    d.loadRecord
      .mockResolvedValueOnce(rec([line("1"), line("2")]))
      .mockResolvedValueOnce(rec([line("1"), line("2", "edited"), line("3")], { body: "typed", event: "APPROVE" }));
    expect(await runSubmitWith(flow, d, K, { event: "APPROVE", body: "sum" })).toBe("Review submitted");
    const args = d.submit.mock.calls[0][0];
    expect(args.headSha).toBe(H); // the displayed head
    expect(args.record.event).toBe("APPROVE");
    expect(args.record.body).toBe("sum");
    expect(args.choice).toBeNull();
    const saved = d.saveRecord.mock.calls[0][0];
    expect(saved.items.map((i) => i.id)).toEqual(["3"]);
    expect(saved.body).toBe("");
    expect(saved.event).toBe("COMMENT");
    expect(d.adopt).toHaveBeenCalledWith(K, saved);
    expect(d.reloadDetail).toHaveBeenCalled();
    expect(d.toast).toHaveBeenCalledWith("Review submitted");
    expect(flow.busy).toBe(false);
  });

  it("passes the pending review and the dialog's choice to submit", async () => {
    view.detail = detail({ pendingReviewId: "P", pendingReviewCommit: H });
    d.askPending.mockResolvedValueOnce("add");
    await run();
    expect(d.askPending).toHaveBeenCalledWith(["add", "discard"]);
    expect(d.submit.mock.calls[0][0]).toMatchObject({ existingPendingId: "P", existingPendingCommit: H, choice: "add" });
  });

  it("dialog cancel posts nothing", async () => {
    view.detail = detail({ pendingReviewId: "P", pendingReviewCommit: "older" });
    expect(await run()).toMatch(/cancelled/);
    expect(d.askPending).toHaveBeenCalledWith(["discard"]);
    expect(d.submit).not.toHaveBeenCalled();
    expect(d.saveRecord).not.toHaveBeenCalled();
    expect(flow.busy).toBe(false);
  });

  it("PR or head changed after the dialog posts nothing", async () => {
    const changes: Partial<SubmitView>[] = [
      { selectedKey: "other" },
      { headSha: "head2" },
      { headMoved: true },
      { open: false },
    ];
    for (const change of changes) {
      view.detail = detail({ pendingReviewId: "P", pendingReviewCommit: H });
      d.askPending.mockImplementationOnce(async () => {
        view = { ...view, ...change };
        return "discard";
      });
      expect(await run()).toMatch(/nothing was submitted/);
      view = { ...view, open: true, selectedKey: K, headSha: H, headMoved: false };
    }
    expect(d.submit).not.toHaveBeenCalled();
    expect(d.saveRecord).not.toHaveBeenCalled();
  });

  it("error leaves the stored draft untouched", async () => {
    d.submit.mockRejectedValueOnce(new Error("partial-add: boom"));
    const msg = await run();
    expect(msg).toMatch(/may already be in your pending review on GitHub/);
    expect(flow.error).toBe(msg);
    expect(d.toast).toHaveBeenCalledWith(msg);
    expect(d.saveRecord).not.toHaveBeenCalled();
    expect(d.adopt).not.toHaveBeenCalled();
    expect(flow.busy).toBe(false);
  });

  it("a blocked snapshot posts nothing", async () => {
    d.loadRecord.mockResolvedValueOnce(rec([line("1")], { viewedHead: "old" }));
    expect(await run()).toMatch(/New commits since you looked/);
    expect(d.submit).not.toHaveBeenCalled();
  });

  it("post-submit save failure reports the explicit message", async () => {
    d.saveRecord.mockRejectedValueOnce(new Error("disk full"));
    const msg = await run();
    expect(msg).toMatch(/^Review submitted, but the draft could not be updated/);
    expect(msg).toContain("disk full");
    expect(flow.error).toBe(msg);
    expect(d.adopt).not.toHaveBeenCalled();
    expect(flow.busy).toBe(false);
  });
});
