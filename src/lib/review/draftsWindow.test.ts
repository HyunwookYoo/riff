import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  emitTo: vi.fn(async () => {}),
  existing: null as null | { setFocus: ReturnType<typeof vi.fn> },
  created: [] as { label: string; opts: Record<string, unknown> }[],
}));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(), emitTo: m.emitTo, listen: vi.fn() }));
vi.mock("@tauri-apps/api/webviewWindow", () => {
  class WebviewWindow {
    static getByLabel = vi.fn(async () => m.existing);
    constructor(label: string, opts: Record<string, unknown>) {
      m.created.push({ label, opts });
    }
    once(event: string, cb: () => void) {
      if (event === "tauri://created") queueMicrotask(cb);
      return Promise.resolve(() => {});
    }
  }
  return { WebviewWindow, getCurrentWebviewWindow: () => ({ label: "main" }) };
});
vi.mock("./gh", () => ({ saveReview: vi.fn(), loadReview: vi.fn() }));

import { draftsWindowUrl, parseDraftsUrl, openDraftsWindow } from "./draftStore";

beforeEach(() => {
  vi.clearAllMocks();
  m.existing = null;
  m.created = [];
});

describe("drafts window URL", () => {
  it("drafts URL round-trips keys with # and /", () => {
    const key = "github.krafton.com/own er/re#po#42";
    const url = draftsWindowUrl(key);
    expect(url).toBe(`/?view=drafts&key=${encodeURIComponent(key)}`);
    expect(parseDraftsUrl(url.slice(1))).toBe(key);
  });

  it("parseDraftsUrl rejects other views and a missing key", () => {
    expect(parseDraftsUrl("")).toBeNull();
    expect(parseDraftsUrl("?view=main&key=a")).toBeNull();
    expect(parseDraftsUrl("?view=drafts")).toBeNull();
    expect(parseDraftsUrl("?view=drafts&key=")).toBeNull();
  });
});

describe("openDraftsWindow", () => {
  it("creates the review-drafts window when none exists", async () => {
    await openDraftsWindow("h/o/r#1");
    expect(m.created).toEqual([{
      label: "review-drafts",
      opts: {
        url: "/?view=drafts&key=h%2Fo%2Fr%231",
        title: "riff · Review draft",
        width: 640,
        height: 760,
        decorations: true,
      },
    }]);
  });

  it("points an existing window at the key and focuses it", async () => {
    m.existing = { setFocus: vi.fn(async () => {}) };
    await openDraftsWindow("h/o/r#2");
    expect(m.created).toEqual([]);
    expect(m.emitTo).toHaveBeenCalledWith("review-drafts", "review-drafts-open", { key: "h/o/r#2" });
    expect(m.existing.setFocus).toHaveBeenCalled();
  });
});
