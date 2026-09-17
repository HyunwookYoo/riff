import { appState } from "./store.svelte";
import { push } from "./git";
import { loadCurrentBranch, refreshActiveView } from "./workingCopy";
import { confirmAction } from "./dialogs";
import { classifyGitError } from "./gitError";

/// What to tell the user about a push git turned down. The raw message names
/// the refs and the reason; these lines name the way out, which git's own
/// "fetch first" hint does not (riff has no `git pull --rebase` button, and a
/// rebased branch must not be merged back into shape).
function pushHint(raw: string): string {
  switch (classifyGitError(raw).kind) {
    case "push-rejected-non-ff":
      return "원격에 로컬에 없는 커밋이 있습니다. 먼저 Pull 하세요. 리베이스해서 히스토리를 다시 쓴 브랜치라면 Force push (with lease)를 쓰세요.";
    case "push-rejected-stale":
      return "원격이 riff가 마지막으로 본 위치에서 움직였습니다 — 누군가 그 사이 push 했을 수 있습니다. Fetch 해서 무엇이 달라졌는지 확인한 뒤 다시 시도하세요.";
    case "push-rejected-not-included":
      return "Fetch로 받아 둔 원격 커밋이 이 브랜치에 들어있지 않습니다. 그 커밋들을 확인하고, 필요하면 그 위로 다시 rebase 한 뒤 force push 하세요.";
    default:
      return "";
  }
}

/// Publish `branch` (null = the current branch) to its upstream, creating and
/// tracking one on a first push. `force` leases: git refuses if the remote
/// moved since riff last saw it.
export async function requestPush(
  repoPath: string,
  branch: string | null,
  force: boolean,
): Promise<void> {
  const target = branch ?? appState.currentBranch;
  if (!target) {
    appState.error =
      "detached HEAD 상태에서는 push 할 수 없습니다. 먼저 브랜치를 checkout 하세요.";
    return;
  }
  if (force) {
    const ok = await confirmAction(
      `Force push ${target}?\n\n` +
        `This replaces what the remote has for ${target} — the commits it ` +
        `currently holds stop being reachable there.\n\n` +
        `riff only force-pushes with a lease: if the remote moved since riff ` +
        `last fetched, git refuses instead of overwriting it.`,
      { title: "Force push" },
    );
    if (!ok) return;
  }
  appState.error = null;
  appState.syncing = true;
  appState.beginGitOp(force ? "Force pushing…" : "Pushing…");
  try {
    await push(repoPath, target, force);
    await refreshActiveView();
    void loadCurrentBranch();
  } catch (e) {
    const raw = String(e);
    const hint = pushHint(raw);
    // refreshActiveView clears appState.error (loadStatus/loadCommits do), so
    // the message is set after it — same ordering as the other ops.
    await refreshActiveView();
    appState.error = hint ? `${raw}\n\n${hint}` : raw;
  } finally {
    appState.syncing = false;
    appState.endGitOp();
  }
}
