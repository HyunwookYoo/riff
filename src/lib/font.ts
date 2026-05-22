import { appState } from "./store.svelte";
import { setFontSize as persistFontSize } from "./git";

const MIN = 8;
const MAX = 32;
const DEFAULT = 13;

function clamp(n: number): number {
  return Math.max(MIN, Math.min(MAX, Math.round(n)));
}

export function applyFontSize(): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty(
    "--diff-font-size",
    `${appState.fontSize}px`,
  );
}

export async function setFontSize(size: number): Promise<void> {
  const next = clamp(size);
  if (next === appState.fontSize) return;
  appState.fontSize = next;
  applyFontSize();
  try {
    await persistFontSize(next);
  } catch {
    // Persistence is best-effort.
  }
}

export function adjustFontSize(delta: number): Promise<void> {
  return setFontSize(appState.fontSize + delta);
}

export function resetFontSize(): Promise<void> {
  return setFontSize(DEFAULT);
}
