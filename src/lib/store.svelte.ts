import type { Branch, ChangedFile, DiffMode } from "./types";

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
}

export const appState = new AppState();
