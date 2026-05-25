import type {
  Branch,
  ChangedFile,
  CompareCtx,
  CompareMode,
  DiffMode,
  ThemeChoice,
  ViewMode,
} from "./types";

class AppState {
  repoPath = $state("");
  branches = $state<Branch[]>([]);
  startBranch = $state("");
  targetBranch = $state("");
  mode = $state<DiffMode>("three-dot");
  compareMode = $state<CompareMode>("branch");
  files = $state<ChangedFile[]>([]);
  selectedFile = $state<ChangedFile | null>(null);
  loadingRepo = $state(false);
  loadingFiles = $state(false);
  error = $state<string | null>(null);
  viewMode = $state<ViewMode>("side-by-side");
  recentRepos = $state<string[]>([]);
  theme = $state<ThemeChoice>("system");
  effectiveTheme = $state<"light" | "dark">("light");
  fontSize = $state<number>(13);
  fileViewMode = $state<"flat" | "tree">("flat");
  ignoreWhitespace = $state(false);
  availableUpdate = $state<{ version: string; notes: string | null } | null>(
    null,
  );
  updateInstalling = $state(false);
  // Blame mode is session-only — first run starts OFF, no PersistedState.
  blameMode = $state(false);
  // Drill-in history stack. Each entry is the compare context the user can
  // return to. Session-only.
  history = $state<CompareCtx[]>([]);
}

export const appState = new AppState();
