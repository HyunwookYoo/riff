import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

export function notificationText(number: number, title: string, findings: number): { title: string; body: string } {
  return { title: "AI review ready", body: `#${number} ${title} — ${findings} findings` };
}

export async function notifyReady(number: number, title: string, findings: number): Promise<void> {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification(notificationText(number, title, findings));
  } catch {
    // notifications are best-effort
  }
}
