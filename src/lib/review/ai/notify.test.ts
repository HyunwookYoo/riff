import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => "granted"),
  sendNotification: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-notification", () => m);

import { notificationText, notifyReady } from "./notify";

beforeEach(() => {
  vi.clearAllMocks();
  m.isPermissionGranted.mockResolvedValue(true);
  m.requestPermission.mockResolvedValue("granted");
});

describe("notify", () => {
  it("notificationText formats title and body", () => {
    expect(notificationText(1888, "Fix nil", 3)).toEqual({
      title: "AI review ready",
      body: "#1888 Fix nil — 3 findings",
    });
  });

  it("notifyReady sends when permission is granted", async () => {
    await notifyReady(1, "T", 2);
    expect(m.requestPermission).not.toHaveBeenCalled();
    expect(m.sendNotification).toHaveBeenCalledWith({ title: "AI review ready", body: "#1 T — 2 findings" });
  });

  it("notifyReady requests permission when missing, skips send if denied", async () => {
    m.isPermissionGranted.mockResolvedValue(false);
    m.requestPermission.mockResolvedValue("denied");
    await notifyReady(1, "T", 2);
    expect(m.requestPermission).toHaveBeenCalled();
    expect(m.sendNotification).not.toHaveBeenCalled();
  });

  it("notifyReady swallows failures", async () => {
    m.isPermissionGranted.mockRejectedValue(new Error("boom"));
    await expect(notifyReady(1, "T", 2)).resolves.toBeUndefined();
  });
});
