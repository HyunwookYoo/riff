import { fenced } from "./prompts";
import type { AiFinding, ThreadCheck, TraceStep } from "./types";

/** Code block languages GitHub knows, by file extension; others get a plain block. */
const LANG: Record<string, string> = {
  ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", svelte: "svelte", rs: "rust", py: "python", go: "go",
  java: "java", kt: "kotlin", cs: "csharp", lua: "lua", luau: "lua", json: "json", yaml: "yaml", yml: "yaml",
  toml: "toml", sh: "sh", c: "c", h: "cpp", hpp: "cpp", cc: "cpp", cpp: "cpp", cxx: "cpp", inl: "cpp",
};

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** U+2060 WORD JOINER: invisible, and GitHub no longer sees a mention or reference across it. */
const WJ = "⁠";

/**
 * `s` safe as GitHub text: HTML escaped, and @mentions, #123 and GH-123 references broken with
 * a word joiner (GitHub decodes `&#64;` back into a mention, so escaping can't do it).
 */
export function inert(s: string): string {
  return escapeHtml(s).replace(/@(?=\w)/g, `@${WJ}`).replace(/#(?=\d)/g, `#${WJ}`).replace(/\b(GH-)(?=\d)/gi, `$1${WJ}`);
}

/**
 * `inert` on the prose of markdown `s`, its code spans (a backtick run up to the next run of the
 * same length) left as written: GitHub shows them literally, entities and mentions included. An
 * unpaired run is prose.
 */
export function inertProse(s: string): string {
  let out = "";
  let prose = 0;
  for (let i = 0; i < s.length;) {
    const run = /^`+/.exec(s.slice(i));
    if (!run) { i++; continue; }
    const n = run[0].length;
    const close = new RegExp(`(?<!\`)\`{${n}}(?!\`)`, "g");
    close.lastIndex = i + n;
    const end = close.exec(s);
    if (!end) { i += n; continue; }
    out += inert(s.slice(prose, i)) + s.slice(i, end.index + n);
    i = prose = end.index + n;
  }
  return out + inert(s.slice(prose));
}

/** An inline code span of `s`: a backtick run longer than any in it, padded when it starts or ends with one. */
export function codeSpan(s: string): string {
  const longest = Math.max(0, ...(s.match(/`+/g) ?? []).map((r) => r.length));
  const tick = "`".repeat(longest + 1);
  const pad = s.startsWith("`") || s.endsWith("`") ? " " : "";
  return `${tick}${pad}${s}${pad}${tick}`;
}

function lang(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? (LANG[name.slice(dot + 1).toLowerCase()] ?? "") : "";
}

/** `s` with each non-empty line indented by `n` spaces. */
const indent = (s: string, n: number): string => s.split("\n").map((l) => (l === "" ? l : " ".repeat(n) + l)).join("\n");

/** One list item: `head`, then `path`'s `quote` fenced and indented under the marker so it stays inside the item. */
function quotedItem(marker: string, head: string, path: string, quote: string): string {
  const lines = fenced(quote.replace(/\n+$/, "")).split("\n");
  lines[0] += lang(path);
  return `${marker}${head}\n${indent(lines.join("\n"), marker.length)}`;
}

function stepItem(s: TraceStep, i: number): string {
  return quotedItem(`${i + 1}. `, `${codeSpan(`${s.path}:${s.line}`)} — ${inertProse(oneLine(s.note))}`, s.path, s.quote);
}

/**
 * The failure path as GitHub markdown, appended to a draft comment: a collapsed `<details>` whose
 * summary is the scenario (one line), the steps numbered with their quotes fenced; the scenario
 * is made `inert` (it is in HTML, where markdown isn't), the notes `inertProse`.
 * Empty for an empty trace.
 */
export function traceMarkdown(scenario: string, trace: TraceStep[]): string {
  if (trace.length === 0) return "";
  const summary = inert(oneLine(scenario)) || "Failure path";
  return `\n\n<details><summary>${summary}</summary>\n\n${trace.map(stepItem).join("\n")}\n\n</details>`;
}

/** What Add appends to `f`'s comment: its failure path when riff's check confirmed all of it, else nothing. */
export function draftTrace(f: AiFinding): string {
  if (f.status !== "confirmed" || !f.verification || f.verification.unchecked) return "";
  return traceMarkdown(f.failureScenario ?? "", f.verification.trace);
}

/**
 * What Add appends to a thread check's reply: the checked code, as a collapsed `<details>` whose
 * summary is the point (made `inert`), listing the evidence with its quotes fenced and, when riff
 * checked all of it, the trace as a "Path" sub-list of `traceMarkdown`'s steps. Empty for an
 * unclear check (it has no reply).
 */
export function replyAppendix(c: ThreadCheck): string {
  if (c.verdict === "unclear") return "";
  const summary = inert(oneLine(c.point)) || "Checked in the code";
  const items = c.evidence.map((e) => quotedItem("- ", codeSpan(e.line !== null ? `${e.path}:${e.line}` : e.path), e.path, e.quote));
  if (c.trace.length > 0 && !c.unchecked) items.push(`- Path\n${indent(c.trace.map(stepItem).join("\n"), 2)}`);
  return `\n\n<details><summary>${summary}</summary>\n\n${items.join("\n")}\n\n</details>`;
}
