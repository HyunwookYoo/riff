import { appState } from "./store.svelte";
import { setTheme as persistTheme } from "./git";
import type { ThemeChoice } from "./types";

let systemMql: MediaQueryList | null = null;
let systemListener: ((e: MediaQueryListEvent) => void) | null = null;

function resolveEffective(): "light" | "dark" {
  if (appState.theme !== "system") return appState.theme;
  if (typeof window === "undefined") return "light";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/** Apply current theme choice to <html data-theme> and update appState.effectiveTheme. */
export function applyTheme(): void {
  const eff = resolveEffective();
  appState.effectiveTheme = eff;
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = eff;
  }
}

/**
 * (Re)subscribe to the OS dark-mode media query.
 * Only attaches a listener while theme === "system".
 */
export function subscribeSystemTheme(): void {
  if (systemMql && systemListener) {
    systemMql.removeEventListener("change", systemListener);
  }
  systemMql = null;
  systemListener = null;

  if (typeof window === "undefined") return;
  if (appState.theme !== "system") return;

  systemMql = window.matchMedia("(prefers-color-scheme: dark)");
  systemListener = () => applyTheme();
  systemMql.addEventListener("change", systemListener);
}

export async function chooseTheme(choice: ThemeChoice): Promise<void> {
  appState.theme = choice;
  applyTheme();
  subscribeSystemTheme();
  try {
    await persistTheme(choice);
  } catch {
    // Persistence is best-effort; UI already reflects the change.
  }
}
