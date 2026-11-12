import type { DraftTarget, FileHunks, Side } from "../types";
import { reanchor } from "../anchor";
import { placeTarget } from "../commentable";
import type { AiChapter, AiEvidence, AiFinding, AiResult, RefutedFinding, Severity, TraceStep } from "./types";

type Candidate = Omit<AiFinding, "id" | "status" | "quote">;

const bad = (what: string) => new Error(`ai-malformed: ${what}`);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";

export function evidenceOf(v: unknown): AiEvidence[] {
  if (!Array.isArray(v)) return [];
  const out: AiEvidence[] = [];
  for (const e of v) {
    if (!isObj(e) || !isStr(e.path) || !isStr(e.quote)) continue;
    out.push({ path: e.path, line: typeof e.line === "number" ? e.line : null, quote: e.quote });
  }
  return out;
}

export function normalizeFind(raw: unknown, files: FileHunks[]): { chapters: AiChapter[]; candidates: Candidate[] } {
  if (!isObj(raw)) throw bad("not an object");
  if (!Array.isArray(raw.chapters)) throw bad("chapters missing");
  if (!Array.isArray(raw.findings)) throw bad("findings missing");
  const known = new Set(files.map((f) => f.path));
  const seen = new Set<string>();
  const chapters: AiChapter[] = [];
  for (const c of raw.chapters) {
    if (!isObj(c) || !isStr(c.title) || !Array.isArray(c.paths)) continue;
    const paths: string[] = [];
    for (const p of c.paths) {
      if (!isStr(p) || !known.has(p) || seen.has(p)) continue;
      seen.add(p);
      paths.push(p);
    }
    if (paths.length) chapters.push({ title: c.title, summary: isStr(c.summary) ? c.summary : "", paths });
  }
  const rest = files.map((f) => f.path).filter((p) => !seen.has(p));
  if (rest.length) chapters.push({ title: "Other", summary: "", paths: rest });
  return { chapters, candidates: candidatesOf(raw.findings, files) };
}

/** The Roblox pass's answer: its candidates, tagged "roblox". */
export function normalizeRoblox(raw: unknown, files: FileHunks[]): Candidate[] {
  if (!isObj(raw) || !Array.isArray(raw.findings)) throw bad("findings missing");
  return candidatesOf(raw.findings, files).map((c) => ({ ...c, tag: "roblox" }));
}

/** Well-formed findings with a failure scenario and evidence, on or citing a PR file. */
function candidatesOf(findings: unknown[], files: FileHunks[]): Candidate[] {
  const known = new Set(files.map((f) => f.path));
  const candidates: Candidate[] = [];
  for (const f of findings) {
    if (!isObj(f) || !isStr(f.path) || !isStr(f.body)) continue;
    if ((f.side !== "LEFT" && f.side !== "RIGHT") || !Number.isInteger(f.line) || (f.line as number) < 1) continue;
    if (f.severity !== "high" && f.severity !== "medium" && f.severity !== "low") continue;
    const failureScenario = isStr(f.failureScenario) ? f.failureScenario.trim() : "";
    if (!failureScenario) continue;
    const evidence = evidenceOf(f.evidence);
    if (!evidence.length) continue;
    if (!known.has(f.path) && !evidence.some((e) => known.has(e.path))) continue;
    candidates.push({
      path: f.path, side: f.side as Side, line: f.line as number,
      startLine: Number.isInteger(f.startLine) ? (f.startLine as number) : null,
      severity: f.severity as Severity, body: f.body, evidence, failureScenario,
    });
  }
  return candidates;
}

const isStep = (s: unknown): s is TraceStep => isObj(s) && isStr(s.path) && (s.side === "LEFT" || s.side === "RIGHT")
  && Number.isInteger(s.line) && (s.line as number) >= 1 && isStr(s.quote) && isStr(s.note);

/** A trace with a malformed step is no trace: riff couldn't check the step left out. */
function traceOf(v: unknown): TraceStep[] {
  if (!Array.isArray(v) || !v.every(isStep)) return [];
  return v.map(({ path, side, line, quote, note }) => ({ path, side, line, quote, note }));
}

/**
 * Verify's verdicts applied: confirmed and unconfirmed candidates become findings carrying the
 * verifier's reason (and, when confirmed, its failure path, checked later by codeCheck.ts);
 * refuted ones are listed apart. A candidate with no verdict is dropped.
 */
export function mergeVerdicts(candidates: Candidate[], raw: unknown): { findings: AiFinding[]; refuted: RefutedFinding[] } {
  if (!isObj(raw) || !Array.isArray(raw.verdicts)) throw bad("verdicts missing");
  const byIndex = new Map<number, { verdict: string; reason: string; evidence: AiEvidence[]; trace: TraceStep[] }>();
  for (const v of raw.verdicts) {
    if (!isObj(v) || !Number.isInteger(v.index) || !isStr(v.verdict)) continue;
    byIndex.set(v.index as number, {
      verdict: v.verdict, reason: isStr(v.reason) ? v.reason : "", evidence: evidenceOf(v.evidence), trace: traceOf(v.trace),
    });
  }
  const findings: AiFinding[] = [];
  const refuted: RefutedFinding[] = [];
  candidates.forEach((c, i) => {
    const v = byIndex.get(i);
    if (v?.verdict === "refuted") {
      const summary = c.body.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
      refuted.push({ path: c.path, side: c.side, line: c.line, severity: c.severity, summary, reason: v.reason });
    }
    if (!v || (v.verdict !== "confirmed" && v.verdict !== "unconfirmed")) return;
    findings.push({
      ...c, id: `f${findings.length}`, status: v.verdict, evidence: [...c.evidence, ...v.evidence], quote: [],
      verification: { reason: v.reason, trace: v.verdict === "confirmed" ? v.trace : [] },
    });
  });
  return { findings, refuted };
}

export function fillQuotes(findings: AiFinding[], texts: Map<string, string>): AiFinding[] {
  const out: AiFinding[] = [];
  for (const f of findings) {
    const text = texts.get(`${f.path}|${f.side}`);
    if (text === undefined) continue;
    const lines = text.replace(/\r?\n$/, "").split(/\r?\n/);
    const from = f.startLine ?? f.line;
    if (from < 1 || from > f.line || f.line > lines.length) continue;
    out.push({ ...f, quote: lines.slice(from - 1, f.line) });
  }
  return out;
}

export function placeFinding(f: AiFinding, files: FileHunks[]): DraftTarget {
  const location = `${f.path}:${f.line}`;
  const kind = placeTarget(f.path, f.side, f.line, f.startLine, files);
  if (kind === "line") return { kind, path: f.path, side: f.side, line: f.line, startLine: f.startLine, quote: f.quote };
  if (kind === "file") return { kind, path: f.path, location };
  return { kind, location };
}

export function chapterOf(result: AiResult, path: string): AiChapter | null {
  return result.chapters.find((c) => c.paths.includes(path)) ?? null;
}

/** A finding as shown now: `target` is where Add puts it (re-placed when the result is stale). */
export interface ShownFinding extends AiFinding { target: DraftTarget }

/** Off the current diff lines: a file comment if the file is in the PR, else the review body. */
function offLine(f: AiFinding, files: FileHunks[]): DraftTarget {
  const location = `${f.path}:${f.line}`;
  return files.some((x) => x.path === f.path) ? { kind: "file", path: f.path, location } : { kind: "body", location };
}

/**
 * Unhandled findings split for display. A stale result (analysed at another head)
 * is re-placed by quote against `texts` (`${path}|${side}` → that side's text now).
 */
export function findingsToShow(
  result: AiResult | null, headSha: string, files: FileHunks[], texts?: Map<string, string>,
): { inline: ShownFinding[]; offDiff: ShownFinding[]; unconfirmed: ShownFinding[]; stale: boolean } {
  const out = { inline: [] as ShownFinding[], offDiff: [] as ShownFinding[], unconfirmed: [] as ShownFinding[], stale: false };
  if (!result) return out;
  out.stale = result.headSha !== headSha;
  for (const f of result.findings) {
    if (result.handled[f.id]) continue;
    let target: DraftTarget;
    if (!out.stale) target = placeFinding(f, files);
    else {
      const text = texts?.get(`${f.path}|${f.side}`);
      const lt = { kind: "line" as const, path: f.path, side: f.side, line: f.line, startLine: f.startLine, quote: f.quote };
      const placed = text === undefined ? null : reanchor(lt, text, files.find((x) => x.path === f.path));
      target = placed ? { ...lt, ...placed } : offLine(f, files);
    }
    const shown = { ...f, target };
    if (f.status === "unconfirmed") out.unconfirmed.push(shown);
    else (target.kind === "line" ? out.inline : out.offDiff).push(shown);
  }
  return out;
}

/**
 * `result` with finding `id` marked `how`; null when there is nothing to do: no result, a
 * different result than the one the finding came from (ids are positional), or already marked.
 */
export function applyHandled(
  result: AiResult | null, expectedCreatedAt: string, id: string, how: "added" | "discarded",
): AiResult | null {
  if (!result || result.createdAt !== expectedCreatedAt || result.handled[id] === how) return null;
  return { ...result, handled: { ...result.handled, [id]: how } };
}

/** The result's chapters over the current files: gone paths dropped, new ones under "Other". */
export function chaptersFor(result: AiResult, files: FileHunks[]): AiChapter[] {
  const now = new Set(files.map((f) => f.path));
  const chapters = result.chapters
    .map((c) => ({ ...c, paths: c.paths.filter((p) => now.has(p)) }))
    .filter((c) => c.paths.length);
  const seen = new Set(chapters.flatMap((c) => c.paths));
  const rest = files.map((f) => f.path).filter((p) => !seen.has(p));
  if (!rest.length) return chapters;
  const other = chapters.find((c) => c.title === "Other");
  if (other) other.paths.push(...rest);
  else chapters.push({ title: "Other", summary: "", paths: rest });
  return chapters;
}
