import type { DraftTarget, FileHunks, Side } from "../types";
import { placeTarget } from "../commentable";
import type { AiChapter, AiEvidence, AiFinding, AiResult, Severity } from "./types";

type Candidate = Omit<AiFinding, "id" | "status" | "quote">;

const bad = (what: string) => new Error(`ai-malformed: ${what}`);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";

function evidenceOf(v: unknown): AiEvidence[] {
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
    if (!isObj(c) || !isStr(c.title) || !Array.isArray(c.paths)) throw bad("chapter shape");
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

  const candidates: Candidate[] = [];
  for (const f of raw.findings) {
    if (!isObj(f) || !isStr(f.path) || !isStr(f.body)) throw bad("finding shape");
    if ((f.side !== "LEFT" && f.side !== "RIGHT") || !Number.isInteger(f.line) || (f.line as number) < 1) throw bad("finding position");
    if (f.severity !== "high" && f.severity !== "medium" && f.severity !== "low") throw bad("finding severity");
    const evidence = evidenceOf(f.evidence);
    if (!evidence.length) continue;
    if (!known.has(f.path) && !evidence.some((e) => known.has(e.path))) continue;
    candidates.push({
      path: f.path, side: f.side as Side, line: f.line as number,
      startLine: Number.isInteger(f.startLine) ? (f.startLine as number) : null,
      severity: f.severity as Severity, body: f.body, evidence,
    });
  }
  return { chapters, candidates };
}

export function mergeVerdicts(candidates: Candidate[], raw: unknown): AiFinding[] {
  if (!isObj(raw) || !Array.isArray(raw.verdicts)) throw bad("verdicts missing");
  const byIndex = new Map<number, { verdict: string; evidence: AiEvidence[] }>();
  for (const v of raw.verdicts) {
    if (!isObj(v) || !Number.isInteger(v.index) || !isStr(v.verdict)) continue;
    byIndex.set(v.index as number, { verdict: v.verdict, evidence: evidenceOf(v.evidence) });
  }
  const out: AiFinding[] = [];
  candidates.forEach((c, i) => {
    const v = byIndex.get(i);
    if (!v || (v.verdict !== "confirmed" && v.verdict !== "unconfirmed")) return;
    out.push({ ...c, id: `f${out.length}`, status: v.verdict, evidence: [...c.evidence, ...v.evidence], quote: [] });
  });
  return out;
}

export function fillQuotes(findings: AiFinding[], texts: Map<string, string>): AiFinding[] {
  const out: AiFinding[] = [];
  for (const f of findings) {
    const text = texts.get(`${f.path}|${f.side}`);
    if (text === undefined) continue;
    const lines = text.split("\n");
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
