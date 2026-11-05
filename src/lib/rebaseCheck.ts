import { cancelRebaseCheck, rebaseCheck } from "./git";
import type {
  ConflictFile,
  RebaseAction,
  RebaseCheck,
  RebaseStep,
} from "./types";

export type CheckState =
  | { kind: "checking"; done: number; total: number }
  | Exclude<RebaseCheck, { kind: "cancelled" }>;
export type ConflictCheck = Extract<RebaseCheck, { kind: "conflict" }>;

let nextId = 1;

/// Starts a check; onUpdate gets {checking,0,0} at once, progress, then the
/// result. Returns cancel(): tells the backend to stop and guarantees no
/// further onUpdate. A rejection becomes cant_check; a "cancelled" result is
/// never passed on, so an unknown outcome is never shown as clean.
export function startRebaseCheck(
  path: string,
  upstream: string,
  branch: string | null,
  steps: RebaseStep[] | null,
  onUpdate: (s: CheckState) => void,
): () => void {
  const id = nextId++;
  let live = true;
  const emit = (s: CheckState) => {
    if (live) onUpdate(s);
  };
  emit({ kind: "checking", done: 0, total: 0 });
  rebaseCheck(path, upstream, branch ?? "", steps, id, (p) =>
    emit({ kind: "checking", done: p.done, total: p.total }),
  ).then(
    (r) => {
      if (r.kind !== "cancelled") emit(r);
    },
    (e) => emit({ kind: "cant_check", reason: String(e).split("\n")[0] }),
  );
  return () => {
    if (!live) return;
    live = false;
    void cancelRebaseCheck(id).catch(() => {});
  };
}

export function checkText(s: CheckState): string {
  switch (s.kind) {
    case "checking":
      return s.total === 0 ? "checking…" : `checking ${s.done}/${s.total}…`;
    case "clean":
      return `✓ no conflicts (${s.commits} commit${s.commits === 1 ? "" : "s"})`;
    case "conflict":
      return `⚠ conflict at ${s.commit.short_sha} ${s.commit.summary} (${s.at} of ${s.total})`;
    case "nothing":
      return "nothing to rebase";
    case "cant_check":
      return `can't check (${s.reason})`;
  }
}

export function checkBadge(s: CheckState): string {
  switch (s.kind) {
    case "clean":
      return "✓";
    case "conflict":
      return `⚠ conflict at ${s.commit.short_sha}`;
    default:
      return checkText(s);
  }
}

export function filesText(files: ConflictFile[]): string {
  return files
    .map((f) => (f.kind === "binary" ? `${f.path} (binary)` : f.path))
    .join(", ");
}

export function aiRequest(o: {
  repoPath: string;
  branch: string;
  target: string;
  conflict: ConflictCheck;
  plan?: { action: RebaseAction; short: string; summary: string }[];
}): string {
  const c = o.conflict;
  const lines = [`${o.repoPath} 에서 ${o.branch} 를 ${o.target} 위로 rebase 해줘.`];
  if (o.plan) {
    lines.push("interactive rebase 로, 아래 계획대로 진행해 (위에서부터 순서대로):");
    for (const p of o.plan) lines.push(`  ${p.action} ${p.short} ${p.summary}`);
  }
  lines.push(
    "riff 미리 보기에서 conflict 가 예상돼:",
    `- ${c.commit.short_sha} "${c.commit.summary}" (${c.total}개 중 ${c.at}번째): ${filesText(c.files)}`,
    "이후 커밋도 conflict 가 날 수 있어.",
    "conflict 마다 양쪽 커밋의 의도를 확인하고 해결해. 의도가 애매하면 멈추고 물어봐.",
    "끝나면 각 conflict 를 어떻게 해결했는지 요약해줘.",
  );
  return lines.join("\n");
}
