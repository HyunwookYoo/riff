export type Side = "LEFT" | "RIGHT";
export interface GhRepo { host: string; owner: string; name: string }
export type PrKey = string; // `${host}/${owner}/${name}#${number}`
export interface Hunk { oldStart: number; oldLines: number; newStart: number; newLines: number }
export interface FileHunks { path: string; oldPath: string | null; hunks: Hunk[] }
/** `mergeBase`: merge-base(base, head), where the LEFT side and GitHub's LEFT lines are read. */
export interface PrHunks { mergeBase: string; files: FileHunks[] }
export interface PrSummary {
  key: PrKey; repo: GhRepo; repoIdx: number; remote: string; nodeId: string; number: number;
  title: string; author: string; url: string; additions: number; deletions: number;
  headSha: string; baseSha: string; baseRef: string; updatedAt: string;
  section: "requested" | "reviewed"; myLastReviewSha: string | null;
}
export interface ThreadComment { id: string; author: string; body: string; createdAt: string }
export interface ReviewThread {
  id: string; path: string; side: Side; line: number | null; startLine: number | null;
  originalLine: number | null; isResolved: boolean; isOutdated: boolean;
  subjectType: "LINE" | "FILE"; comments: ThreadComment[];
}
export interface PrDetail {
  body: string; headSha: string; baseSha: string; conversation: ThreadComment[];
  threads: ReviewThread[]; pendingReviewId: string | null;
  pendingReviewCommit: string | null;
}
export type DraftTarget =
  | { kind: "line"; path: string; side: Side; line: number; startLine: number | null; quote: string[] }
  | { kind: "file"; path: string; location: string }
  | { kind: "body"; location: string }
  | { kind: "reply"; threadId: string; preview: string };
export type DraftOrigin = "mine" | "ai" | "ai-edited" | "ai-unconfirmed";
export interface DraftItem { id: string; target: DraftTarget; body: string; origin: DraftOrigin; unplaced: boolean }
export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
export interface PrRecord {
  version: 1; key: PrKey; items: DraftItem[]; body: string; event: ReviewEvent;
  anchorHead: string | null;  // head SHA the line anchors refer to
  viewedHead: string | null;  // latest head the user has seen
}
