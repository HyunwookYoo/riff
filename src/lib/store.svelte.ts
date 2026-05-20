import type { Branch, ChangedFile, DiffMode, ViewMode } from "./types";

class AppState {
  repoPath = $state("");
  branches = $state<Branch[]>([]);
  startBranch = $state("");
  targetBranch = $state("");
  mode = $state<DiffMode>("three-dot");
  files = $state<ChangedFile[]>([]);
  selectedFile = $state<ChangedFile | null>(null);
  loading = $state(false);
  error = $state<string | null>(null);
  viewMode = $state<ViewMode>("side-by-side");
}

export const appState = new AppState();
