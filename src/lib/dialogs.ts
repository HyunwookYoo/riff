import { ask } from "@tauri-apps/plugin-dialog";

/// Confirmation dialog via the Tauri dialog plugin. Returns true if confirmed.
///
/// Use this instead of `window.confirm()`: the browser dialog does not render
/// in the WebView2 shell (the call returns immediately, silently cancelling the
/// action), which is why destructive confirms appeared to "do nothing".
/// Defaults to a "warning" dialog, suiting the destructive ops it guards.
export async function confirmAction(
  message: string,
  opts: { title?: string; kind?: "info" | "warning" | "error" } = {},
): Promise<boolean> {
  return ask(message, {
    title: opts.title ?? "Confirm",
    kind: opts.kind ?? "warning",
  });
}
