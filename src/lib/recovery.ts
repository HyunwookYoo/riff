import { appState } from "./store.svelte";
import { classifyGitError } from "./gitError";

type BlockedOp = "checkout" | "pull" | "merge";

const REASON: Record<"local-changes-blocked" | "untracked-collision", string> = {
  "local-changes-blocked": "Your local changes would be overwritten.",
  "untracked-collision": "Untracked files would be overwritten.",
};

/// If `raw` is a "blocked by local changes" failure, open the recovery dialog
/// (returns true). Otherwise returns false so the caller surfaces the raw error.
/// `retry` re-runs the op with the chosen strategy ("stash" always; "discard"
/// only when offerDiscard).
export function offerRecovery(
  raw: string,
  op: BlockedOp,
  title: string,
  offerDiscard: boolean,
  retry: (strategy: "stash" | "discard") => Promise<void>,
): boolean {
  const f = classifyGitError(raw);
  if (f.kind !== "local-changes-blocked" && f.kind !== "untracked-collision") {
    return false;
  }
  appState.recovery = {
    op,
    title,
    reason: REASON[f.kind],
    paths: f.paths,
    offerDiscard,
    retry,
  };
  return true;
}
