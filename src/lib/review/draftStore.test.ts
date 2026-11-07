import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  emit: vi.fn(async () => {}),
  handler: null as ((e: { payload: any }) => void) | null,
  saveReview: vi.fn(async () => {}),
  loadReview: vi.fn(async () => null as unknown),
}));
const listen = vi.hoisted(() => vi.fn());
const { emit, saveReview, loadReview } = m;
listen.mockImplementation(async (_n: string, h: any) => { m.handler = h; return () => {}; });
vi.mock("@tauri-apps/api/event", () => ({ emit: m.emit, listen }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ label: "main" }) }));
vi.mock("./gh", () => ({ saveReview: m.saveReview, loadReview: m.loadReview }));

import { saveRecord, onRecordChanged } from "./draftStore";
import { emptyRecord } from "./draft";

const K = "h/o/r#1";
beforeEach(() => { vi.clearAllMocks(); listen.mockImplementation(async (_n: string, h: any) => { m.handler = h; return () => {}; }); m.handler = null; });

describe("draftStore", () => {
  it("saveRecord emits review-draft-changed with own label", async () => {
    await saveRecord(emptyRecord(K));
    expect(saveReview).toHaveBeenCalledWith(K, emptyRecord(K));
    expect(emit).toHaveBeenCalledWith("review-draft-changed", { key: K, origin: "main" });
  });

  it("onRecordChanged ignores own-window events", async () => {
    const cb = vi.fn();
    await onRecordChanged(K, cb);
    await m.handler!({ payload: { key: K, origin: "main" } });
    expect(loadReview).not.toHaveBeenCalled();
    await m.handler!({ payload: { key: "other", origin: "drafts" } });
    expect(cb).not.toHaveBeenCalled();
    await m.handler!({ payload: { key: K, origin: "drafts" } });
    expect(cb).toHaveBeenCalledWith(emptyRecord(K));
  });
});
