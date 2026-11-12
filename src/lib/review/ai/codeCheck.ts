import type { FileHunks } from "../types";
import { ROBLOX_PREFIX } from "./roblox";
import type { AiEvidence, AiFinding, TraceStep } from "./types";

/** The two revisions a review reads: the PR's head and its merge-base. */
export type Rev = "head" | "mergeBase";

/** Distinct (rev, path) reads per review; past it, items are left unchecked rather than downgraded. */
export const MAX_FILES = 80;

/** A shorter quote (non-space chars) proves nothing: `}` or `return;` is everywhere. */
export const MIN_STEP_CHARS = 8;

/** A step quote found away from its line moves there only if this long: `Health);` is not a place. */
const MIN_MOVE_CHARS = 20;

/** How many steps a confirmed finding's failure path has (the verify prompt asks for 2 to 8). */
const MIN_STEPS = 2;
const MAX_STEPS = 8;

/** How many lines a step's line may be off by. */
const SLACK = 3;

/** Whitespace collapsed; U+FFFD dropped, as non-UTF-8 text (e.g. CP949) is decoded lossily. */
export const collapse = (s: string): string => s.replace(/�/g, "").replace(/\s+/g, " ").trim();

const nonSpace = (q: string): number => q.replace(/ /g, "").length;
const longEnough = (q: string): boolean => nonSpace(q) >= MIN_STEP_CHARS;

/**
 * `quote`, then (when every non-empty line starts with `+`, `-` or a space, as in a diff) the
 * same with that first character dropped from each line.
 */
function attempts(quote: string): string[] {
  const lines = quote.split(/\r?\n/);
  const marked = lines.filter((l) => l.trim() !== "").every((l) => /^[+\- ]/.test(l));
  return marked ? [quote, lines.map((l) => l.replace(/^[+\- ]/, "")).join("\n")] : [quote];
}

/** The 1-based line the only occurrence of collapsed `q` starts on; null for none or several. */
function onlyLine(lines: string[], q: string): number | null {
  let flat = "";
  const starts: { at: number; line: number }[] = [];
  lines.forEach((l, i) => {
    const c = collapse(l);
    if (!c) return;
    if (flat) flat += " ";
    starts.push({ at: flat.length, line: i + 1 });
    flat += c;
  });
  const at = flat.indexOf(q);
  if (at < 0 || flat.indexOf(q, at + 1) >= 0) return null;
  return starts.findLast((s) => s.at <= at)!.line;
}

/**
 * Where step `quote` (whitespace collapsed, at least `MIN_STEP_CHARS`) is in `text`: `line` when
 * it is within `SLACK` lines of it (a quote over several lines may run past the window by its own
 * extra lines), else, for a quote of at least `MIN_MOVE_CHARS`, the line it starts on when it is
 * in the file exactly once; null otherwise.
 */
export function stepLine(text: string, line: number, quote: string): number | null {
  const lines = text.split(/\r?\n/);
  for (const a of attempts(quote)) {
    const q = collapse(a);
    if (!longEnough(q)) continue;
    const extra = a.trim().split("\n").length - 1;
    const from = Math.max(0, line - 1 - SLACK);
    if (collapse(lines.slice(from, line + SLACK + extra).join("\n")).includes(q)) return line;
    const only = nonSpace(q) >= MIN_MOVE_CHARS ? onlyLine(lines, q) : null;
    if (only !== null) return only;
  }
  return null;
}

/** Too short to check, even without diff markers. */
const tooShort = (quote: string): boolean => !attempts(quote).some((a) => longEnough(collapse(a)));

/** Whether `quote` (whitespace collapsed, at least `MIN_STEP_CHARS`) is anywhere in `text`. */
export function quoteInFile(text: string, quote: string): boolean {
  const t = collapse(text);
  return attempts(quote).some((a) => {
    const q = collapse(a);
    return longEnough(q) && t.includes(q);
  });
}

const key = (rev: Rev, path: string): string => `${rev}|${path}`;
const isRoblox = (path: string): boolean => path.startsWith(ROBLOX_PREFIX);
const inPr = (path: string, files: FileHunks[]): boolean => files.some((f) => f.path === path || f.oldPath === path);
const basePath = (path: string, files: FileHunks[]): string => files.find((f) => f.path === path)?.oldPath ?? path;

/**
 * Where an evidence item may be: head, then, for a file the PR changes, the merge-base (under its
 * old name if renamed). A file the PR doesn't change is the same at both.
 */
function evidenceKeys(e: AiEvidence, files: FileHunks[]): string[] {
  const head = key("head", e.path);
  return inPr(e.path, files) ? [head, key("mergeBase", basePath(e.path, files))] : [head];
}

/** RIGHT at head, LEFT at the merge-base (under its old name if renamed) or, for a file the PR doesn't change, head. */
function stepKey(s: TraceStep, files: FileHunks[]): string {
  return s.side === "LEFT" && inPr(s.path, files) ? key("mergeBase", basePath(s.path, files)) : key("head", s.path);
}

const traceOf = (f: AiFinding): TraceStep[] => f.verification?.trace ?? [];

/** By key, the file text, null when absent at that rev; a key absent was not read (cap, or unreadable). */
type Texts = Map<string, string | null>;

/** Kept unless every place it may be was read and none has the quote. */
function evidenceHolds(e: AiEvidence, files: FileHunks[], texts: Texts): boolean {
  const ts = evidenceKeys(e, files).map((k) => texts.get(k));
  return ts.some((t) => t === undefined || (t !== null && quoteInFile(t, e.quote)));
}

/** The line the step's quote is on; "unchecked" when its file was not read; null when not found. */
function stepAt(s: TraceStep, files: FileHunks[], texts: Texts): number | "unchecked" | null {
  if (isRoblox(s.path)) return null; // a step must be repo code
  const t = texts.get(stepKey(s, files));
  if (t === undefined) return "unchecked";
  return t === null ? null : stepLine(t, s.line, s.quote);
}

function check(f: AiFinding, files: FileHunks[], texts: Texts): AiFinding {
  const evidence = f.evidence.filter((e) => isRoblox(e.path) || evidenceHolds(e, files, texts));
  const confirmed = f.status === "confirmed";
  const old = traceOf(f);
  const at = old.map((s) => stepAt(s, files, texts));
  const failed = at.indexOf(null);
  // A step found away from its line points at where the quote is.
  const trace = old.map((s, i) => (typeof at[i] === "number" && at[i] !== s.line ? { ...s, line: at[i], movedFrom: s.line } : s));
  const moved = trace.some((s, i) => s !== old[i]);
  const problem = !evidence.length
    ? f.evidence.every((e) => tooShort(e.quote)) ? "evidence quotes too short" : "evidence not found in the code"
    : confirmed && old.length < MIN_STEPS ? "no failure path"
      : confirmed && old.length > MAX_STEPS ? `failure path longer than ${MAX_STEPS} steps`
        : failed >= 0 ? `step ${failed + 1} not found in ${old[failed].path}:${old[failed].line}`
          : null;
  const v = f.verification ?? { reason: "", trace: [] };
  if (problem) {
    return { ...f, evidence, status: "unconfirmed", verification: { ...v, trace, problem: v.problem ?? problem } };
  }
  const unchecked = confirmed && at.includes("unchecked");
  if (!unchecked && !moved) return evidence.length === f.evidence.length ? f : { ...f, evidence };
  return { ...f, evidence, verification: { ...v, trace, ...(unchecked ? { unchecked } : {}) } };
}

/** read_file_at's error for a blob over its size cap (git/cli.rs): the file is there but unread. */
const unreadable = (e: unknown): boolean => String(e).includes("file too large");

/**
 * `findings` with their repo evidence and failure paths checked against the code: evidence not
 * found is dropped; a finding left with none, a confirmed one without a 2 to 8 step trace, or one
 * with a step not found becomes unconfirmed with the first `problem`. A step found away from its
 * line gets the line it is on (`movedFrom`: the line given). A confirmed finding with a step riff couldn't read (cap, file too
 * large) stays confirmed, marked `unchecked`. `read` rejects for a file absent at `rev`, which
 * counts as not found. Roblox evidence is checked in roblox.ts.
 */
export async function checkFindings(
  findings: AiFinding[], files: FileHunks[], read: (rev: Rev, path: string) => Promise<string>, maxFiles = MAX_FILES,
): Promise<AiFinding[]> {
  // Steps first: an unread step leaves its finding unchecked, an unread evidence item is only kept.
  const wanted = new Set<string>();
  for (const f of findings) for (const s of traceOf(f)) if (!isRoblox(s.path)) wanted.add(stepKey(s, files));
  for (const f of findings) {
    for (const e of f.evidence) if (!isRoblox(e.path)) for (const k of evidenceKeys(e, files)) wanted.add(k);
  }
  const texts: Texts = new Map();
  await Promise.all([...wanted].slice(0, maxFiles).map(async (k) => {
    const sep = k.indexOf("|");
    try {
      texts.set(k, await read(k.slice(0, sep) as Rev, k.slice(sep + 1)));
    } catch (e) {
      if (!unreadable(e)) texts.set(k, null);
    }
  }));
  return findings.map((f) => check(f, files, texts));
}
